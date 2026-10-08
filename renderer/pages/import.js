"use strict";

const IMPORT_FIELD_LABELS = {
  name: "Name",
  orgName: "Organization",
  email: "Email address",
  addressLine1: "Address",
  addressLine2: "Address 2",
  city: "City",
  state: "State",
  zip: "ZIP",
  household: "Address (moved, or joined someone at the same address)",
};

// Remembers which newsletters were ticked last time for each kind of source
// -- just a convenience, so it's fine if storage isn't available.
function rememberedPublications(kind) {
  try {
    return JSON.parse(localStorage.getItem(`import.publications.${kind}`) || "null");
  } catch {
    return null;
  }
}
function rememberPublications(kind, ids) {
  try {
    localStorage.setItem(`import.publications.${kind}`, JSON.stringify(ids));
  } catch {
    // not available; nothing to remember
  }
}

window.Pages.import = {
  navAs: "contacts",
  async render(container) {
    const gf = await window.api.getGfSettings();
    const signupReady = !!(gf.siteUrl && gf.formId);
    const initialMode = window.__importMode === "org" ? "org" : "person";
    window.__importMode = null;
    let source = null; // { kind: "file", filePath } or { kind: "signup", includeImported }
    let preview = null;
    let mapping = {};
    let planRequest = 0;
    let planTimer = null;
    let lastPlan = null;

    container.innerHTML = `
      <h1>Import</h1>
      <p class="subtitle">Bring in a CSV or Excel file, or the signups from the website's signup form. People already on the mailing list are updated
        instead of added twice, and anyone who might be a duplicate is flagged on the Duplicates page. <a href="#" id="back-link">Back to the mailing list</a></p>
      <div class="import-sources">
        <div class="panel">
          <h2 style="margin-top:0">A spreadsheet</h2>
          <button class="btn" id="pick-file-btn" type="button">Choose file…</button>
          <p class="hint">CSV or Excel. The first row should be the column headings.</p>
        </div>
        <div class="panel">
          <h2 style="margin-top:0">The signup form</h2>
          ${
            signupReady
              ? `<button class="btn" id="signup-btn" type="button">Get new signups</button>
                 <label class="check-label" style="margin-top:8px"><input type="checkbox" id="include-imported" /> Include signups already imported</label>
                 <p class="hint">From "${escapeHtml(gf.formTitle || `form ${gf.formId}`)}" on ${escapeHtml(gf.siteUrl)}.
                   ${gf.lastImportedEntryId ? "Only signups since the last import, unless you tick the box." : "Nothing imported from it yet."}</p>`
              : `<p class="hint">Connect the Gravity Forms signup form in <a href="#" id="gf-settings-link">Settings</a> first.</p>`
          }
        </div>
      </div>
      <p id="source-name" class="hint"></p>
      <div id="mapping-area"></div>
    `;

    qs("#back-link", container).addEventListener("click", (e) => {
      e.preventDefault();
      navigate("contacts");
    });
    qs("#gf-settings-link", container)?.addEventListener("click", (e) => {
      e.preventDefault();
      navigate("settings");
    });

    async function loadSource(next, label) {
      try {
        preview = await window.api.previewImport(next);
      } catch (err) {
        toast(`Couldn't read ${next.kind === "signup" ? "the signups" : "that file"}: ${err.message}`, true);
        return;
      }
      source = next;
      qs("#source-name", container).textContent = label;
      mapping = { ...preview.mapping };
      renderMapping();
    }

    qs("#pick-file-btn", container).addEventListener("click", async () => {
      const picked = await window.api.pickImportFile();
      if (picked) await loadSource({ kind: "file", filePath: picked }, `Importing ${picked}`);
    });
    qs("#signup-btn", container)?.addEventListener("click", async () => {
      const btn = qs("#signup-btn", container);
      btn.disabled = true;
      btn.textContent = "Getting signups…";
      await loadSource({ kind: "signup", includeImported: qs("#include-imported", container).checked }, "Importing from the signup form");
      btn.disabled = false;
      btn.textContent = "Get new signups";
    });

    const mode = () => qs("#import-mode", container)?.value || initialMode;
    const tickedPublications = () => qsa(".import-pub:checked", container).map((b) => b.value);
    const pubName = (id) => preview.publications.find((p) => p.id === id)?.name || "";

    function options() {
      return {
        mode: mode(),
        publicationIds: tickedPublications(),
        sourceBatch: qs("#batch-name", container).value.trim() || preview.defaultBatchName,
        defaultCopies: qs("#default-copies", container).value.trim() || "1",
        deliveryDefault: qs("#delivery-default", container).value,
        replaceDelivery: mode() === "person" && qs("#replace-delivery", container).checked,
      };
    }

    function mappedTargets() {
      return new Set(Object.values(mapping).filter(Boolean));
    }

    // In organization mode a person's name in the row is who the batch is
    // addressed to, so the name options say so.
    function targetLabel(t) {
      if (mode() !== "org") return t.label;
      return { name: "Attention (full name)", firstName: "Attention: first name", middleName: "Attention: middle name", lastName: "Attention: last name" }[t.value] || t.label;
    }

    function targetOptions(selectedValue) {
      const groups = [];
      for (const t of preview.targets) {
        const group = t.group || "";
        if (!groups.length || groups[groups.length - 1].name !== group) groups.push({ name: group, items: [] });
        groups[groups.length - 1].items.push(t);
      }
      const option = (t) => `<option value="${t.value}" ${selectedValue === t.value ? "selected" : ""}>${escapeHtml(targetLabel(t))}</option>`;
      return groups.map((g) => (g.name ? `<optgroup label="${escapeHtml(g.name)}">${g.items.map(option).join("")}</optgroup>` : g.items.map(option).join(""))).join("");
    }

    function renderMapping() {
      const area = qs("#mapping-area", container);
      if (source.kind === "signup" && !preview.totalRows) {
        area.innerHTML = `<div class="panel"><p class="empty">No new signups since the last import.</p></div>`;
        return;
      }
      if (!preview.headers.length) {
        area.innerHTML = `<div class="panel"><p class="empty">This file doesn't have any columns to import. The first row should be the column headings.</p></div>`;
        return;
      }
      const remembered = rememberedPublications(source.kind) || [];
      area.innerHTML = `
        <div class="panel">
          <div class="row" style="align-items:flex-start;gap:28px">
            <div class="field">
              <label for="import-mode">Each row is</label>
              <select id="import-mode">
                <option value="person">A person</option>
                <option value="org">An organization (a church getting batches)</option>
              </select>
              <p class="hint" id="mode-hint"></p>
            </div>
            <div class="field">
              <label>This list is for</label>
              <div class="pub-checks">
                ${preview.publications
                  .map((p) => `<label class="check-label"><input type="checkbox" class="import-pub" value="${p.id}" ${remembered.includes(p.id) ? "checked" : ""} /> ${escapeHtml(p.name)}</label>`)
                  .join("")}
              </div>
              <p class="hint">Everyone in the file gets the ticked newsletters (unless their organization already gets one for them). Leave them all unticked to just update names and addresses.</p>
            </div>
          </div>
        </div>

        <div class="panel">
          <h2 style="margin-top:0">Match up the columns <span class="hint">(${source.kind === "signup" ? plural(preview.totalRows, "signup") : `${plural(preview.totalRows, "row")} in the file`})</span></h2>
          <table class="mapping-table">
            <thead><tr><th>Column in the file</th><th>Import as</th><th>Examples</th></tr></thead>
            <tbody>
              ${preview.headers
                .map(
                  (h) => `
                <tr>
                  <td>${escapeHtml(h)}</td>
                  <td><select data-header="${escapeHtml(h)}" class="map-select">${targetOptions(mapping[h])}</select></td>
                  <td class="hint">${(preview.samples[h] || []).map(escapeHtml).join(" · ") || "(blank)"}</td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
          <p class="hint">Mail and Email columns can hold anything yes/no-ish — Yes/No, X or blank, TRUE/FALSE, 1/0.</p>
        </div>

        <div class="panel">
          <h2 style="margin-top:0" id="delivery-heading">For anyone new to a ticked newsletter</h2>
          <div class="row" style="align-items:flex-start">
            <div class="field" style="flex:1;min-width:260px">
              <label for="delivery-default">How they get it</label>
              <select id="delivery-default">
                ${preview.deliveryDefaults.map((d) => `<option value="${d.value}">${escapeHtml(d.label)}</option>`).join("")}
              </select>
              <p class="hint" id="delivery-hint"></p>
              <label class="check-label" id="replace-delivery-label"><input type="checkbox" id="replace-delivery" /> Use this for everyone in the file, replacing how they get it now</label>
            </div>
            <div class="field">
              <label for="default-copies">Copies</label>
              <input type="text" id="default-copies" value="1" inputmode="numeric" style="width:90px" />
              <p class="hint" id="copies-hint"></p>
            </div>
            <div class="field" style="flex:1;min-width:220px">
              <label for="batch-name">Source</label>
              <input type="text" id="batch-name" value="${escapeHtml(preview.defaultBatchName)}" />
              <p class="hint">Shown in the Source column, so you can find everyone from this file later.</p>
            </div>
          </div>
          <p class="hint" style="margin-top:0" id="keeps-hint"></p>
        </div>

        <div class="panel">
          <h2 style="margin-top:0">What will happen</h2>
          <div id="plan-area"><p class="hint">Working it out…</p></div>
          <div class="row" style="margin-top:12px">
            <button class="btn" id="commit-import-btn" type="button" disabled>Import</button>
            <button class="btn secondary" id="cancel-import-btn" type="button">Cancel</button>
          </div>
        </div>
      `;

      qs("#import-mode", area).value = initialMode;
      const refreshTargets = () => qsa(".map-select", area).forEach((sel) => (sel.innerHTML = targetOptions(mapping[sel.dataset.header])));
      qs("#import-mode", area).addEventListener("change", () => {
        refreshTargets();
        renderOptionHints();
        schedulePlan();
      });
      qsa(".map-select", area).forEach((sel) =>
        sel.addEventListener("change", () => {
          mapping[sel.dataset.header] = sel.value;
          renderOptionHints();
          schedulePlan();
        })
      );
      qsa(".import-pub", area).forEach((box) =>
        box.addEventListener("change", () => {
          rememberPublications(source.kind, tickedPublications());
          schedulePlan();
        })
      );
      for (const id of ["#delivery-default", "#default-copies", "#batch-name"]) qs(id, area).addEventListener("input", schedulePlan);
      qs("#replace-delivery", area).addEventListener("change", () => {
        renderOptionHints();
        schedulePlan();
      });
      qs("#cancel-import-btn", area).addEventListener("click", () => navigate("contacts"));
      qs("#commit-import-btn", area).addEventListener("click", commit);
      renderOptionHints();
      schedulePlan();
    }

    function renderOptionHints() {
      const targets = mappedTargets();
      const mail = targets.has("sendByMail") || targets.has("delivery");
      const email = targets.has("sendByEmail") || targets.has("delivery");
      qs("#mode-hint", container).textContent =
        mode() === "org"
          ? "Each row's Organization is matched to one already on the list, or added. Its address is where batches go."
          : "A row with an organization but no person's name is taken as the organization itself.";
      qs("#delivery-default", container).disabled = mail && email;
      const replaceBox = qs("#replace-delivery", container);
      replaceBox.disabled = mode() === "org" || (mail && email);
      if (replaceBox.disabled) replaceBox.checked = false;
      qs("#replace-delivery-label", container).style.display = mode() === "org" ? "none" : "";
      const replacing = replaceBox.checked;
      qs("#delivery-heading", container).textContent = replacing ? "For everyone in the file" : "For anyone new to a ticked newsletter";
      qs("#keeps-hint", container).textContent = replacing
        ? "Everyone in the file gets the ticked newsletters this way, instead of how they get them now — except where the file has a Mail or Email column for it. " +
          "Anyone whose organization gets the newsletter as a batch is left as they are, and so is anyone without the address it takes. A blank cell never erases an address."
        : "Anyone who already gets a newsletter keeps how they get it unless the file has a column for it. A blank cell never erases what's already there.";
      qs("#delivery-hint", container).textContent =
        mode() === "org"
          ? "An organization gets a batch by mail if it has an address, otherwise by email."
          : targets.has("delivery")
          ? "The file's Mail / Email / Both column decides this, except where it's blank."
          : mail && email
          ? "The file's Mail and Email columns decide this."
          : mail
          ? "The file's Mail column decides mail; this decides email."
          : email
          ? "The file's Email column decides email; this decides mail."
          : "";
      qs("#copies-hint", container).textContent = targets.has("copies") ? "Used where the file's cell is blank." : "";
    }

    function schedulePlan() {
      clearTimeout(planTimer);
      planTimer = setTimeout(runPlan, 150);
    }

    function missingIdentity() {
      const targets = mappedTargets();
      if (mode() === "org") return !targets.has("orgName");
      return !["name", "firstName", "lastName", "orgName"].some((t) => targets.has(t));
    }

    async function runPlan() {
      const area = qs("#plan-area", container);
      const button = qs("#commit-import-btn", container);
      if (!area) return;
      if (missingIdentity()) {
        lastPlan = null;
        button.disabled = true;
        area.innerHTML = `<p class="hint" style="color:var(--warn)">${
          mode() === "org" ? "Choose which column holds the organization's name to import." : "Choose which column holds the name — Name, First/Last name, or Organization — to import."
        }</p>`;
        return;
      }
      const copiesText = qs("#default-copies", container).value.trim();
      if (copiesText && !/^\d+$/.test(copiesText)) {
        lastPlan = null;
        button.disabled = true;
        area.innerHTML = `<p class="hint" style="color:var(--warn)">Copies has to be a whole number, like 1 or 15.</p>`;
        return;
      }
      const request = ++planRequest;
      let plan;
      try {
        plan = await window.api.planImport(source, mapping, options());
      } catch (err) {
        if (request === planRequest) area.innerHTML = `<p class="hint" style="color:var(--danger)">${escapeHtml(err.message)}</p>`;
        return;
      }
      if (request !== planRequest || !document.body.contains(area)) return;
      lastPlan = plan;
      const { stats, matches } = plan;
      const total = stats.added + stats.updated + stats.orgsAdded + stats.orgsUpdated;
      button.disabled = total === 0;
      button.textContent = total ? "Import" : "Nothing to import";
      const starting = Object.entries(stats.starting || {})
        .map(([id, n]) => `${plural(n, "person", "people")} will start getting ${escapeHtml(pubName(id))}`)
        .join("; ");
      area.innerHTML = `
        <div class="stat-row">
          ${mode() === "person" ? `<div class="stat-card"><div class="num">${stats.added.toLocaleString()}</div><div class="label">New people</div></div>` : ""}
          ${mode() === "person" ? `<div class="stat-card"><div class="num">${stats.updated.toLocaleString()}</div><div class="label">People updated</div></div>` : ""}
          ${mode() === "person" ? `<div class="stat-card"><div class="num">${stats.unchanged.toLocaleString()}</div><div class="label">Already up to date</div></div>` : ""}
          ${stats.orgsAdded || mode() === "org" ? `<div class="stat-card"><div class="num">${stats.orgsAdded.toLocaleString()}</div><div class="label">New organizations</div></div>` : ""}
          ${stats.orgsUpdated || mode() === "org" ? `<div class="stat-card"><div class="num">${stats.orgsUpdated.toLocaleString()}</div><div class="label">Organizations updated</div></div>` : ""}
          ${stats.skipped ? `<div class="stat-card"><div class="num">${stats.skipped.toLocaleString()}</div><div class="label">Rows skipped</div></div>` : ""}
        </div>
        ${starting ? `<p class="hint">${starting}.</p>` : ""}
        ${
          stats.householdJoins
            ? `<p class="hint">${plural(stats.householdJoins, "person", "people")} ${stats.householdJoins === 1 ? "lives" : "live"} at an address someone else on the list already has, and will share that household: one bundle for the address.</p>`
            : ""
        }
        ${
          plan.possibleDuplicates
            ? `<p class="hint" style="color:var(--warn)">${plural(plan.possibleDuplicates, "new person", "new people")} might already be on the list under another name or email. They'll be added, and listed on the Duplicates page to merge or keep.</p>`
            : ""
        }
        ${
          stats.unreadableCopies
            ? `<p class="hint" style="color:var(--warn)">${plural(stats.unreadableCopies, "row")} had something other than a number in a copies column. Those keep their current number (or ${escapeHtml(options().defaultCopies)}, if they're new).</p>`
            : ""
        }
        ${
          stats.unreadableDelivery
            ? `<p class="hint" style="color:var(--warn)">${plural(stats.unreadableDelivery, "row")} had something in a Mail / Email / Both column that isn't Mail, Email, Both or None. Those are treated as if the cell were blank.</p>`
            : ""
        }
        ${
          stats.replaceCovered
            ? `<p class="hint">${plural(stats.replaceCovered, "person", "people")} ${stats.replaceCovered === 1 ? "is" : "are"} left as they are for a newsletter their organization gets as a batch.</p>`
            : ""
        }
        ${
          stats.replaceNoAddress
            ? `<p class="hint" style="color:var(--warn)">${plural(stats.replaceNoAddress, "person", "people")} ${stats.replaceNoAddress === 1 ? "doesn't" : "don't"} have the address it takes to get it that way, so ${
                stats.replaceNoAddress === 1 ? "is" : "are"
              } left as they are: ${plan.noAddressNames.map(escapeHtml).join(", ")}${stats.replaceNoAddress > plan.noAddressNames.length ? ", …" : ""}.</p>`
            : ""
        }
        ${
          stats.ambiguous
            ? `<p class="hint" style="color:var(--warn)">${plural(stats.ambiguous, "row")} could be more than one person already on the list (two John Stoltzfuses at the same address, say), so ${
                stats.ambiguous === 1 ? "it isn't" : "they aren't"
              } imported: ${plan.ambiguousNames.map(escapeHtml).join(", ")}${stats.ambiguous > plan.ambiguousNames.length ? ", …" : ""}.
              Add a middle initial in the file, or update ${stats.ambiguous === 1 ? "that person" : "them"} on the mailing list by hand.</p>`
            : ""
        }
        ${!options().publicationIds.length && mode() === "person" && !Object.keys(stats.starting || {}).length ? `<p class="hint">No newsletters ticked: this only adds people and updates names and addresses.</p>` : ""}
        <p class="hint">A row updates someone already on the list when the name matches and so does the email address or the street address; organizations match by name.
          Repeats within the file are merged too. People at the same street address, Address 2 and ZIP share one household.</p>
        ${
          matches.length
            ? `<button class="btn secondary" id="toggle-matches" type="button">Show the ${plural(stats.updated, "update")}</button>
               <div id="matches-area" style="display:none">${matchesTable(matches, stats.updated)}</div>`
            : ""
        }
      `;
      qs("#toggle-matches", area)?.addEventListener("click", (e) => {
        const box = qs("#matches-area", area);
        const open = box.style.display === "none";
        box.style.display = open ? "" : "none";
        e.target.textContent = open ? "Hide the updates" : `Show the ${plural(stats.updated, "update")}`;
      });
    }

    function matchesTable(matches, total) {
      const side = (s) =>
        `${escapeHtml(s.name || "(no name)")}${s.orgName ? `<br/><span class="hint">${escapeHtml(s.orgName)}</span>` : ""}` +
        `${s.email ? `<br/><span class="hint">${escapeHtml(s.email)}</span>` : ""}${s.address ? `<br/><span class="hint">${escapeHtml(s.address)}</span>` : ""}` +
        `${s.gets.length ? `<br/><span class="hint">Gets ${s.gets.map(escapeHtml).join(", ")}</span>` : ""}`;
      const label = (f) => (f.startsWith("pub:") ? f.slice(4) : IMPORT_FIELD_LABELS[f] || f);
      return `
        <table style="margin-top:12px">
          <thead><tr><th>On the list now</th><th>After the import</th><th>Changes</th></tr></thead>
          <tbody>
            ${matches.map((m) => `<tr><td>${side(m.existing)}</td><td>${side(m.incoming)}</td><td>${m.changedFields.map((f) => escapeHtml(label(f))).join(", ")}</td></tr>`).join("")}
          </tbody>
        </table>
        ${total > matches.length ? `<p class="hint">Showing the first ${matches.length.toLocaleString()} of ${total.toLocaleString()}.</p>` : ""}
      `;
    }

    async function commit() {
      if (!lastPlan) return;
      const btn = qs("#commit-import-btn", container);
      btn.disabled = true;
      btn.textContent = "Importing…";
      try {
        const stats = await window.api.commitImport(source, mapping, options());
        toast(
          mode() === "org"
            ? `Imported: ${plural(stats.orgsAdded, "new organization")}, ${stats.orgsUpdated.toLocaleString()} updated.`
            : `Imported: ${plural(stats.added, "new person", "new people")}, ${stats.updated.toLocaleString()} updated.`
        );
        window.__contactsView = { tab: mode() === "org" ? "orgs" : "people" };
        // Straight to the Duplicates page when the import brought some in.
        navigate(lastPlan.possibleDuplicates ? "duplicates" : "contacts");
      } catch (err) {
        toast(`Import failed: ${err.message}`, true);
        runPlan();
      }
    }
  },
};
