"use strict";

const DUPLICATE_REASONS = {
  email: "Same email address",
  address: "Same address and a similar name",
  name: "Same name — one has an email address, the other a mailing address",
  orgAddress: "Same address",
  orgName: "One name contains the other",
};

function placeSummary(place) {
  if (!place) return "";
  return [place.addressLine1, place.addressLine2, place.city, [place.state, place.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

window.Pages.duplicates = {
  async render(container) {
    const review = await window.api.listReview();
    const R = window.ContactRules;
    const pubs = review.publications;
    const mailedList = (place) =>
      pubs.filter((p) => R.sub(place, p.id).mail).map((p) => `${escapeHtml(p.name)} (${plural(R.copiesFor(place, p.id), "copy", "copies")})`).join(", ");
    const emailedList = (record) => pubs.filter((p) => R.sub(record, p.id).email).map((p) => escapeHtml(p.name)).join(", ");

    container.innerHTML = `
      <h1>Duplicates</h1>
      <p class="subtitle">People who might be on the mailing list twice, addresses that might be one household, and organizations that might be one church.
        Matching email addresses and street addresses count most, since names often don't line up (Bob on one list, Robert on another). Nothing changes until you choose.</p>
      <h2>Possibly the same person <span class="hint" id="dup-count"></span></h2>
      <div id="dup-area"></div>
      <h2>Same address, separate households <span class="hint" id="shared-count"></span></h2>
      <div id="shared-area"></div>
      <h2>Possibly the same organization <span class="hint" id="org-count"></span></h2>
      <div id="org-area"></div>
    `;
    qs("#dup-count", container).textContent = `(${review.duplicates.length.toLocaleString()})`;
    qs("#shared-count", container).textContent = `(${review.sharedAddresses.length.toLocaleString()})`;
    qs("#org-count", container).textContent = `(${review.orgDuplicates.length.toLocaleString()})`;

    // A side-by-side comparison of records that might be one: each row is a
    // field, each column a record; the radio picked in a row is the value
    // kept. Unticking "Same one" leaves a record out of the merge.
    let groupSeq = 0;
    function comparisonCard({ records, reasons, fields, hint, mergeLabel, onMerge, onDismiss, describe }) {
      const gi = groupSeq++;
      const card = document.createElement("div");
      card.className = "panel dup-card";
      // Each field starts with the oldest record's value, unless it's blank
      // and a newer one has it.
      const firstWith = (f) => Math.max(0, records.findIndex((r) => f.has(r)));
      card.innerHTML = `
        <p class="dup-reasons">${reasons.map(escapeHtml).join(" · ")}</p>
        <table class="dup-table">
          <thead>
            <tr><th></th>${records
              .map(
                (r, ri) => `<th><label class="check-label"><input type="checkbox" data-include="${ri}" checked /> Same one</label>
                  <span class="hint">${escapeHtml(describe(r))}</span></th>`
              )
              .join("")}</tr>
          </thead>
          <tbody>
            ${fields
              .map(
                (f) => `<tr><th>${f.label}</th>${records
                  .map((r, ri) => {
                    const shown = f.show(r);
                    if (!shown) return `<td class="dup-empty"><span class="hint">—</span></td>`;
                    if (!f.pick) return `<td>${shown}</td>`;
                    return `<td><label class="dup-choice"><input type="radio" name="g${gi}-${f.key}" value="${ri}" ${firstWith(f) === ri ? "checked" : ""} /> <span>${shown}</span></label></td>`;
                  })
                  .join("")}</tr>`
              )
              .join("")}
          </tbody>
        </table>
        <p class="hint">${hint}</p>
        <div class="row">
          <button class="btn" data-merge type="button">${mergeLabel}</button>
          <button class="btn secondary" data-dismiss type="button">Not the same</button>
        </div>
      `;
      const included = () => qsa("[data-include]", card).filter((b) => b.checked).map((b) => Number(b.dataset.include));
      const picked = (key) => {
        const keep = included();
        const radio = qs(`input[name="g${gi}-${key}"]:checked`, card);
        const ri = radio ? Number(radio.value) : null;
        return records[ri !== null && keep.includes(ri) ? ri : keep[0]];
      };
      qsa("[data-include]", card).forEach((box) =>
        box.addEventListener("change", () => {
          const ri = Number(box.dataset.include);
          qsa("tbody tr", card).forEach((tr) => tr.children[ri + 1]?.classList.toggle("dup-excluded", !box.checked));
          qs("[data-merge]", card).disabled = included().length < 2;
        })
      );
      qs("[data-merge]", card).addEventListener("click", async () => {
        const keep = included();
        if (keep.length < 2) return;
        try {
          const done = await onMerge(keep.map((ri) => records[ri]), picked);
          if (!done) return;
          // Records left out of the merge aren't suggested with it again.
          const left = records.filter((r, ri) => !keep.includes(ri)).map((r) => r.id);
          if (left.length) await window.api.dismissReview(onDismiss.kind, [records[keep[0]].id, ...left]);
        } catch (err) {
          toast(`Merge failed: ${err.message}`, true);
        }
        navigate("duplicates");
      });
      qs("[data-dismiss]", card).addEventListener("click", async () => {
        await window.api.dismissReview(onDismiss.kind, records.map((r) => r.id));
        toast(onDismiss.message);
        navigate("duplicates");
      });
      return card;
    }

    const reasonsOf = (group) => [...new Set(group.pairs.flatMap((p) => p.reasons))].map((r) => DUPLICATE_REASONS[r] || r);
    const added = (r) => `${r.sourceBatch || ""}${r.createdAt ? ` · added ${new Date(r.createdAt).toLocaleDateString()}` : ""}`;

    // ---- people ----

    const PERSON_FIELDS = [
      { key: "name", label: "Name", pick: true, has: (c) => !!c.name, show: (c) => escapeHtml(c.name) },
      { key: "email", label: "Email address", pick: true, has: (c) => !!c.email, show: (c) => escapeHtml(c.email) },
      { key: "org", label: "Organization", pick: true, has: (c) => !!c.org, show: (c) => escapeHtml(c.org?.name || "") },
      {
        key: "household",
        label: "Address",
        pick: true,
        has: (c) => !!c.household,
        show: (c) => {
          const h = c.household;
          if (!h) return "";
          const others = h.members.filter((m) => m.id !== c.id);
          const mailed = mailedList(h);
          return `${escapeHtml(placeSummary(h))}<br/><span class="hint">${mailed ? `By mail: ${mailed}` : "Nothing by mail"}${
            others.length ? ` · also ${others.map((m) => escapeHtml(m.name || "(no name)")).join(", ")}` : ""
          }</span>`;
        },
      },
      { key: "emailed", label: "By email", show: (c) => emailedList(c) },
    ];

    const dupArea = qs("#dup-area", container);
    for (const group of review.duplicates) {
      dupArea.appendChild(
        comparisonCard({
          records: group.contacts,
          reasons: reasonsOf(group),
          fields: PERSON_FIELDS,
          describe: added,
          hint: "Pick the value to keep in each row, then merge. The merged person keeps every newsletter any of them got by email. Mailings already sent to any of them will show the one that's kept.",
          mergeLabel: "Merge into one",
          onDismiss: { kind: "duplicate", message: "Marked as different people — they won't be suggested again." },
          onMerge: async (keep, picked) => {
            const names = keep.map((c) => c.name || "(no name)");
            if (!(await confirmAction(`Merge ${names.join(", ")} into one person? This can't be undone.`, "Merge"))) return false;
            const values = { name: picked("name").name, email: picked("email").email, orgId: picked("org").orgId || null };
            await window.api.mergeContacts({ keepId: keep[0].id, removeIds: keep.slice(1).map((c) => c.id), values, householdId: picked("household").householdId || null });
            toast(`Merged into ${values.name || "one person"}.`);
            return true;
          },
        })
      );
    }
    if (!review.duplicates.length) dupArea.innerHTML = `<p class="hint">Nothing to look at — no one seems to be on the list twice.</p>`;

    // ---- shared addresses ----

    const sharedArea = qs("#shared-area", container);
    for (const group of review.sharedAddresses) {
      const card = document.createElement("div");
      card.className = "panel dup-card";
      const people = group.households.flatMap((h) => h.members);
      card.innerHTML = `
        <table class="dup-table">
          <thead><tr><th>Address</th><th>Who lives there</th><th>By mail</th></tr></thead>
          <tbody>
            ${group.households
              .map(
                (h) => `<tr>
                  <td>${escapeHtml(placeSummary(h))}</td>
                  <td>${h.members.map((m) => escapeHtml(m.name || "(no name)")).join("<br/>")}</td>
                  <td>${mailedList(h) || '<span class="hint">Nothing</span>'}</td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <p class="hint">As one household, the address gets one bundle of each newsletter: by mail if any of them had it, with the largest number of copies.</p>
        <div class="row">
          <button class="btn" data-combine type="button">Make one household</button>
          <button class="btn secondary" data-keep type="button">Keep separate</button>
        </div>
      `;
      qs("[data-combine]", card).addEventListener("click", async () => {
        try {
          await window.api.combineHouseholds({ householdIds: group.households.map((h) => h.id) });
          toast(`${plural(people.length, "person", "people")} now share one address.`);
        } catch (err) {
          toast(err.message, true);
        }
        navigate("duplicates");
      });
      qs("[data-keep]", card).addEventListener("click", async () => {
        await window.api.dismissReview("household", group.households.map((h) => h.id));
        toast("Kept separate — they won't be suggested again.");
        navigate("duplicates");
      });
      sharedArea.appendChild(card);
    }
    if (!review.sharedAddresses.length) sharedArea.innerHTML = `<p class="hint">Nothing to look at — every address is one household.</p>`;

    // ---- organizations ----

    const ORG_FIELDS = [
      { key: "name", label: "Name", pick: true, has: (o) => !!o.name, show: (o) => escapeHtml(o.name) },
      { key: "attn", label: "Attention", pick: true, has: (o) => !!o.attn, show: (o) => escapeHtml(o.attn) },
      { key: "email", label: "Email address", pick: true, has: (o) => !!o.email, show: (o) => escapeHtml(o.email) },
      { key: "address", label: "Address", pick: true, has: (o) => !!o.addressLine1, show: (o) => escapeHtml(placeSummary(o)) },
      {
        key: "batches",
        label: "Gets",
        show: (o) => [mailedList(o) && `By mail: ${mailedList(o)}`, emailedList(o) && `By email: ${emailedList(o)}`].filter(Boolean).join("<br/>"),
      },
      { key: "members", label: "Members", show: (o) => (o.memberCount ? plural(o.memberCount, "person", "people") : "") },
    ];

    const orgArea = qs("#org-area", container);
    for (const group of review.orgDuplicates) {
      orgArea.appendChild(
        comparisonCard({
          records: group.orgs,
          reasons: reasonsOf(group),
          fields: ORG_FIELDS,
          describe: added,
          hint: "Pick the values to keep, then merge. The merged organization gets every newsletter any of them got, with the most copies any had, and all their members.",
          mergeLabel: "Merge into one",
          onDismiss: { kind: "duplicate", message: "Marked as different organizations — they won't be suggested again." },
          onMerge: async (keep, picked) => {
            if (!(await confirmAction(`Merge ${keep.map((o) => o.name).join(", ")} into one organization? This can't be undone.`, "Merge"))) return false;
            const values = { name: picked("name").name, attn: picked("attn").attn, email: picked("email").email };
            await window.api.mergeOrgs({ keepId: keep[0].id, removeIds: keep.slice(1).map((o) => o.id), values, addressFrom: picked("address").id });
            toast(`Merged into ${values.name}.`);
            return true;
          },
        })
      );
    }
    if (!review.orgDuplicates.length) orgArea.innerHTML = `<p class="hint">Nothing to look at — no two organizations look alike.</p>`;
  },
};
