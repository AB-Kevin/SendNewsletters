"use strict";

// The Mailing List: everyone the newsletters go to, as two editable
// spreadsheets -- People and Organizations. Edits save as soon as a cell is
// left (there's no Save button), and Ctrl+Z undoes them.
//
// Each newsletter has its own columns. On the People tab, Email is each
// person's own; Mail and Copies belong to their household (everyone at the
// same address), drawn once across the household's rows, so the address gets
// one bundle. On the Organizations tab, Mail and Copies are a church's batch
// for its members. A person whose organization gets a newsletter as a batch
// is "covered" for it: those cells are hatched, and they don't need their
// own copy -- though they can have one.

const ADDRESS_COLUMNS = [
  { key: "addressLine1", label: "Address", width: 200 },
  { key: "addressLine2", label: "Address 2", width: 120 },
  { key: "city", label: "City", width: 130 },
  { key: "state", label: "State", width: 64 },
  { key: "zip", label: "ZIP", width: 92 },
];
const SOURCE_COLUMN = { key: "sourceBatch", label: "Source", width: 170, readOnly: true, title: "Which import it came from", readOnlyMessage: "Source shows which import it came from — it can't be changed." };
const UNDO_LIMIT = 200;

window.Pages.contacts = {
  fill: true,
  async render(container) {
    const R = window.ContactRules;
    let contacts = [];
    let byId = new Map();
    let households = new Map();
    let orgs = new Map();
    let publications = [];
    async function loadList() {
      const list = await window.api.getList();
      contacts = list.contacts;
      byId = new Map(contacts.map((c) => [c.id, c]));
      households = new Map(list.households.map((h) => [h.id, h]));
      orgs = new Map(list.orgs.map((o) => [o.id, o]));
      publications = list.publications;
    }
    await loadList();

    // Tab, search, filter and sort survive leaving the page and coming back.
    // Another page can open this one already filtered by setting
    // window.__contactsView first.
    const saved = window.__contactsView || {};
    let tab = saved.tab === "orgs" ? "orgs" : "people";
    const state = {
      people: { search: "", show: "all", sort: { key: null, dir: 1 }, ...(saved.people || {}) },
      orgs: { search: "", show: "all", sort: { key: null, dir: 1 }, ...(saved.orgs || {}) },
    };
    if (saved.showFilter) state[tab].show = saved.showFilter;
    if (saved.searchTerm) state[tab].search = saved.searchTerm;
    // Organizations whose members are listed under them on the Organizations tab.
    const expanded = new Set(saved.expanded || []);
    const remember = () => (window.__contactsView = { tab, people: state.people, orgs: state.orgs, expanded: [...expanded] });

    const undoStack = [];
    const pinned = []; // rows added this visit, kept at the top while they're filled in
    let pendingSaves = 0;
    let reviewCount = 0;

    container.innerHTML = `
      <div class="sheet-page">
        <h1>Mailing List</h1>
        <div class="tabs">
          <button class="tab" data-tab="people" type="button">People</button>
          <button class="tab" data-tab="orgs" type="button">Organizations</button>
          <span class="toolbar-gap"></span>
          <button class="btn secondary" id="pubs-btn" type="button">Newsletters…</button>
        </div>
        <div class="panel pubs-panel" id="pubs-panel" style="display:none"></div>
        <div class="sheet-summary" id="sheet-summary"></div>
        <div class="sheet-toolbar">
          <input type="text" id="sheet-search" />
          <select id="sheet-show"></select>
          <span class="hint" id="view-count"></span>
          <button class="btn secondary" id="members-btn" type="button" style="display:none"></button>
          <span class="toolbar-gap"></span>
          <span class="hint" id="save-status"></span>
          <button class="btn" id="add-row-btn" type="button"></button>
          <button class="btn secondary" id="import-btn" type="button">Import…</button>
          <button class="btn secondary" id="export-btn" type="button">Export…</button>
        </div>
        <div class="selection-bar" id="selection-bar" style="display:none"></div>
        <div class="sheet-host" id="sheet-host"></div>
        <p class="hint sheet-help" id="sheet-help"></p>
      </div>
    `;

    const householdOf = (contact) => households.get(contact?.householdId) || null;
    const orgOf = (contact) => orgs.get(contact?.orgId) || null;
    const membersOfHousehold = (householdId) => contacts.filter((c) => c.householdId === householdId);
    const pubName = (id) => publications.find((p) => p.id === id)?.name || "";

    // On the Organizations tab, a member listed under their organization is
    // a row of its own, with an id that can't be mistaken for the
    // organization's.
    const MEMBER = "member:";
    const memberRowId = (contactId) => MEMBER + contactId;
    const memberOf = (rowId) => (tab === "orgs" && String(rowId).startsWith(MEMBER) ? byId.get(rowId.slice(MEMBER.length)) || null : null);
    const membersOfOrg = (orgId) => contacts.filter((c) => c.orgId === orgId);

    // ---- who gets what ----

    const ownEmail = (c, pubId) => !!R.sub(c, pubId).email;
    const householdMail = (c, pubId) => !!R.sub(householdOf(c), pubId).mail;
    const covered = (c, pubId) => R.coveredBy(orgOf(c), pubId);
    const getsAny = (c, pubId) => ownEmail(c, pubId) || householdMail(c, pubId) || covered(c, pubId);

    function personProblems(c) {
      return { ...R.problems(c, publications, { mail: false }), ...R.problems(householdOf(c), publications, { email: false }) };
    }

    // ---- columns ----

    // A filter on one newsletter shows only that newsletter's columns.
    function visiblePublications() {
      const m = /^pub:([^:]+):/.exec(state[tab].show);
      return m ? publications.filter((p) => p.id === m[1]) : publications;
    }

    function publicationColumns(forOrgs) {
      return visiblePublications().flatMap((p) => [
        { key: `email:${p.id}`, label: "Email", header: p.name, width: 58, type: "flag", title: `${forOrgs ? "Gets" : "Gets their own"} ${p.name} by email` },
        { key: `mail:${p.id}`, label: "Mail", header: p.name, width: 58, type: "flag", group: !forOrgs, title: forOrgs ? `Gets ${p.name} as a batch by mail` : `This address gets ${p.name} by mail` },
        { key: `copies:${p.id}`, label: "Copies", header: p.name, width: 70, type: "count", group: !forOrgs, title: `How many copies of ${p.name} go there` },
      ]);
    }

    function columnsFor() {
      if (tab === "orgs") {
        return [
          { key: "name", label: "Organization", width: 220, sticky: true },
          { key: "attn", label: "Attention", width: 170, title: "Who batches are addressed to — a church rep, say" },
          { key: "members", label: "Members", width: 84, type: "count", readOnly: true, readOnlyMessage: "Members are the people on the People tab with this organization." },
          ...publicationColumns(true),
          { key: "email", label: "Email address", width: 220 },
          ...ADDRESS_COLUMNS,
          SOURCE_COLUMN,
        ];
      }
      return [
        { key: "name", label: "Name", width: 170, sticky: true },
        { key: "orgName", label: "Organization", width: 190, sticky: true, type: "choice", title: "The church or organization they belong to" },
        ...publicationColumns(false),
        { key: "email", label: "Email address", width: 220 },
        ...ADDRESS_COLUMNS.map((c) => ({ ...c, group: true })),
        SOURCE_COLUMN,
      ];
    }

    // ---- what each cell holds ----

    function personCell(id, col) {
      const c = byId.get(id);
      if (!c) return {};
      const h = householdOf(c);
      const [field, pubId] = col.key.split(":");
      if (pubId) {
        if (field === "email") return { value: ownEmail(c, pubId), covered: covered(c, pubId) ? `Gets ${pubName(pubId)} through ${orgOf(c).name}'s batch` : "" };
        const members = h ? membersOfHousehold(h.id) : [c];
        const allCovered = members.every((m) => covered(m, pubId));
        const coveredNote = allCovered ? `${members.length > 1 ? "Everyone here gets" : "Gets"} ${pubName(pubId)} through their organization's batch` : "";
        if (field === "mail") return { value: householdMail(c, pubId), covered: coveredNote };
        const problem = personProblems(c)[`copies:${pubId}`];
        return { value: R.sub(h, pubId).copies ?? "", problem, covered: coveredNote };
      }
      if (col.key === "orgName") return { value: c._pendingOrgName ?? orgOf(c)?.name ?? "" };
      if (col.key === "name" || col.key === "sourceBatch") return { value: c[col.key] };
      if (col.key === "email") return { value: c.email, problem: personProblems(c).email };
      return { value: h?.[col.key] || "", problem: col.key === "addressLine1" ? personProblems(c).addressLine1 : "" };
    }

    function orgCell(id, col) {
      const o = orgs.get(id);
      if (!o) return {};
      const [field, pubId] = col.key.split(":");
      const problems = R.problems(o, publications);
      if (pubId) {
        if (field === "copies") return { value: R.sub(o, pubId).copies ?? "", problem: problems[col.key] };
        return { value: !!R.sub(o, pubId)[field] };
      }
      if (col.key === "members") {
        const count = membersOfOrg(id).length;
        return { value: count, toggle: count ? (expanded.has(id) ? "open" : "closed") : undefined };
      }
      return { value: o[col.key] || "", problem: problems[col.key] };
    }

    // A member's row under their organization holds what the People tab
    // shows for them: their own Email for each newsletter, and their
    // household's Mail, Copies and address (tinted when others live there).
    const HOUSEHOLD_KEYS = /^(mail|copies):|^(addressLine1|addressLine2|city|state|zip)$/;
    function memberCell(c, col) {
      if (col.key === "attn") return { value: "", readOnly: true, readOnlyMessage: "Attention is who the organization's batches are addressed to — members don't have one." };
      if (col.key === "members") return { value: "", readOnly: true, readOnlyMessage: "This row is one of the organization's members." };
      const info = personCell(c.id, col);
      const h = householdOf(c);
      if (h && HOUSEHOLD_KEYS.test(col.key) && membersOfHousehold(h.id).length > 1) info.shared = true;
      return info;
    }

    // ---- which rows are shown, in what order ----

    function showOptions() {
      const pubGroups = (forOrgs) =>
        publications
          .map(
            (p) => `<optgroup label="${escapeHtml(p.name)}">
              <option value="pub:${p.id}:any">Getting ${escapeHtml(p.name)}</option>
              <option value="pub:${p.id}:email">— by email</option>
              <option value="pub:${p.id}:mail">— by mail${forOrgs ? " (batch)" : ""}</option>
              ${forOrgs ? "" : `<option value="pub:${p.id}:org">— through their organization</option>`}
            </optgroup>`
          )
          .join("");
      if (tab === "orgs") {
        return `<option value="all">Every organization</option>${pubGroups(true)}
          <optgroup label="Other"><option value="none">Getting nothing</option><option value="problems">Needs attention</option></optgroup>`;
      }
      return `<option value="all">Everyone</option>${pubGroups(false)}
        <optgroup label="Other">
          <option value="none">Getting nothing</option>
          <option value="households">Households of 2 or more</option>
          <option value="double">Own copy of something their organization also gets</option>
          <option value="problems">Needs attention</option>
        </optgroup>`;
    }

    function personMatchesShow(c, groupSize) {
      const show = state.people.show;
      const m = /^pub:([^:]+):(\w+)$/.exec(show);
      if (m) {
        const [, pubId, how] = m;
        if (how === "email") return ownEmail(c, pubId);
        if (how === "mail") return householdMail(c, pubId);
        if (how === "org") return covered(c, pubId);
        return getsAny(c, pubId);
      }
      if (show === "none") return !publications.some((p) => getsAny(c, p.id));
      if (show === "households") return groupSize > 1;
      if (show === "double") return publications.some((p) => covered(c, p.id) && (ownEmail(c, p.id) || householdMail(c, p.id)));
      if (show === "problems") return Object.keys(personProblems(c)).length > 0;
      return true;
    }

    function orgMatchesShow(o) {
      const show = state.orgs.show;
      const m = /^pub:([^:]+):(\w+)$/.exec(show);
      if (m) {
        const s = R.sub(o, m[1]);
        return m[2] === "email" ? !!s.email : m[2] === "mail" ? !!s.mail : !!(s.email || s.mail);
      }
      if (show === "none") return !publications.some((p) => R.sub(o, p.id).email || R.sub(o, p.id).mail);
      if (show === "problems") return Object.keys(R.problems(o, publications)).length > 0;
      return true;
    }

    // Every word has to appear somewhere in the row, in any order, so
    // "smith lancaster" finds John Smith in Lancaster.
    const wordsOf = () => state[tab].search.toLowerCase().split(/\s+/).filter(Boolean);
    const matchesWords = (parts, words) => {
      const hay = parts.map((v) => v || "").join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    };

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    function compare(col, dir, a, b) {
      if (col.type === "flag") return (Number(!!b) - Number(!!a)) * dir;
      if (col.type === "count") return ((Number(a) || 0) - (Number(b) || 0)) * dir;
      if (!a || !b) return a ? -1 : b ? 1 : 0; // blanks last either way
      return collator.compare(String(a), String(b)) * dir;
    }

    function computeView() {
      const words = wordsOf();
      const { sort } = state[tab];
      const sortCol = sort.key ? columnsFor().find((c) => c.key === sort.key) : null;
      const pinnedSet = new Set(pinned);
      const rows = [];
      const searchParts = (c) => {
        const h = householdOf(c) || {};
        return [c.name, c.email, orgOf(c)?.name, c.sourceBatch, ...R.ADDRESS_FIELDS.map((f) => h[f])];
      };
      if (tab === "orgs") {
        // An organization is shown if it matches, or if one of its members
        // matches the search -- listed under it, so searching a name finds
        // their church. An expanded organization lists all its members.
        const membersBy = new Map();
        for (const c of contacts) if (orgs.has(c.orgId)) (membersBy.get(c.orgId) || membersBy.set(c.orgId, []).get(c.orgId)).push(c);
        const personHit = (c) => words.length > 0 && matchesWords(searchParts(c), words);
        const orgParts = (o) => [o.name, o.attn, o.email, ...R.ADDRESS_FIELDS.map((f) => o[f]), o.sourceBatch];
        let list = [...orgs.values()].filter((o) => orgMatchesShow(o) && (matchesWords(orgParts(o), words) || (membersBy.get(o.id) || []).some(personHit)));
        if (sortCol) list.sort((a, b) => compare(sortCol, sort.dir, orgCell(a.id, sortCol).value, orgCell(b.id, sortCol).value));
        list = [...list.filter((o) => pinnedSet.has(o.id)), ...list.filter((o) => !pinnedSet.has(o.id))];
        const single = (id, className) => rows.push({ id, groupStart: rows.length, groupSize: 1, indexInGroup: 0, className });
        for (const o of list) {
          const members = membersBy.get(o.id) || [];
          const listed = (expanded.has(o.id) ? members : members.filter(personHit)).sort((a, b) => collator.compare(a.name || "", b.name || ""));
          single(o.id, listed.length ? "org-open" : "");
          listed.forEach((c, i) => single(memberRowId(c.id), i === listed.length - 1 ? "member-row member-last" : "member-row"));
        }
        return rows;
      }
      // A household is shown whole if anyone in it matches, so who else
      // lives there is always in view.
      const groups = [];
      const groupOf = new Map();
      for (const c of contacts) {
        const h = householdOf(c);
        if (h && groupOf.has(h.id)) groupOf.get(h.id).push(c);
        else {
          const group = [c];
          groups.push(group);
          if (h) groupOf.set(h.id, group);
        }
      }
      let shown = groups.filter((g) => g.some((c) => personMatchesShow(c, g.length) && matchesWords(searchParts(c), words)));
      if (sortCol) {
        const value = (c) => personCell(c.id, sortCol).value;
        for (const g of shown) if (!sortCol.group) g.sort((a, b) => compare(sortCol, sort.dir, value(a), value(b)));
        shown.sort((a, b) => compare(sortCol, sort.dir, value(a[0]), value(b[0])));
      }
      const isPinned = (g) => g.some((c) => pinnedSet.has(c.id));
      shown = [...shown.filter(isPinned), ...shown.filter((g) => !isPinned(g))];
      for (const g of shown) {
        const groupStart = rows.length;
        g.forEach((c, indexInGroup) => rows.push({ id: c.id, groupStart, groupSize: g.length, indexInGroup }));
      }
      return rows;
    }

    // ---- summary ----

    function renderSummary() {
      const el = qs("#sheet-summary", container);
      const pubLines = publications.map((p) => {
        const mailOrgs = [...orgs.values()].filter((o) => R.getsMail(o, p.id));
        const orgCopies = mailOrgs.reduce((total, o) => total + R.copiesFor(o, p.id), 0);
        if (tab === "orgs") {
          const emailOrgs = [...orgs.values()].filter((o) => R.getsEmail(o, p.id)).length;
          return `<strong>${escapeHtml(p.name)}</strong>: ${plural(mailOrgs.length, "batch", "batches")} by mail (${plural(orgCopies, "copy", "copies")}) · ${emailOrgs.toLocaleString()} by email`;
        }
        const email = contacts.filter((c) => R.getsEmail(c, p.id)).length;
        const mailing = [...households.values()].filter((h) => R.getsMail(h, p.id));
        const copies = mailing.reduce((total, h) => total + R.copiesFor(h, p.id), 0);
        const through = contacts.filter((c) => covered(c, p.id) && !ownEmail(c, p.id) && !householdMail(c, p.id)).length;
        return (
          `<strong>${escapeHtml(p.name)}</strong>: ${email.toLocaleString()} by email · ${plural(mailing.length, "address", "addresses")} by mail (${plural(copies, "copy", "copies")})` +
          (mailOrgs.length ? ` · ${plural(mailOrgs.length, "organization batch", "organization batches")} (${plural(orgCopies, "copy", "copies")})` : "") +
          (through ? ` · ${through.toLocaleString()} through their organization` : "")
        );
      });
      let general;
      if (tab === "orgs") {
        const problems = [...orgs.values()].filter((o) => Object.keys(R.problems(o, publications)).length).length;
        general = [plural(orgs.size, "organization"), problems ? `<a href="#" data-show="problems">${plural(problems, "needs", "need")} attention</a>` : ""];
      } else {
        const memberCount = new Map();
        for (const c of contacts) if (households.has(c.householdId)) memberCount.set(c.householdId, (memberCount.get(c.householdId) || 0) + 1);
        const shared = [...memberCount.values()].filter((n) => n > 1).length;
        const none = contacts.filter((c) => !publications.some((p) => getsAny(c, p.id))).length;
        const problems = contacts.filter((c) => Object.keys(personProblems(c)).length).length;
        general = [
          plural(contacts.length, "person", "people"),
          shared ? `<a href="#" data-show="households">${plural(shared, "household")} of 2 or more</a>` : "",
          none ? `<a href="#" data-show="none">${none.toLocaleString()} getting nothing</a>` : "",
          problems ? `<a href="#" data-show="problems">${plural(problems, "needs", "need")} attention</a>` : "",
        ];
      }
      if (reviewCount) general.push(`<a href="#" data-duplicates>${plural(reviewCount, "possible duplicate")} to look at</a>`);
      el.innerHTML = `<div>${general.filter(Boolean).join(" · ") || "No one on the list yet."}</div>${pubLines.map((l) => `<div class="pub-line">${l}</div>`).join("")}`;
      const filtered = state[tab].search || state[tab].show !== "all";
      qs("#view-count", container).textContent = filtered && sheet ? `${sheet.view.filter((row) => !memberOf(row.id)).length.toLocaleString()} shown` : "";
      renderMembersButton();
    }

    // Lists every organization's members under it, or none.
    const orgsWithMembers = () => [...new Set(contacts.map((c) => c.orgId))].filter((id) => orgs.has(id));
    function renderMembersButton() {
      const btn = qs("#members-btn", container);
      const withMembers = orgsWithMembers();
      btn.style.display = tab === "orgs" && withMembers.length ? "" : "none";
      btn.textContent = withMembers.every((id) => expanded.has(id)) ? "Hide members" : "Show all members";
    }

    function expansionChanged() {
      remember();
      sheet.setView(computeView());
      renderSummary();
    }

    // Duplicates waiting on the Duplicates page, checked again a moment
    // after edits stop.
    let reviewTimer = null;
    function refreshReviewCount() {
      clearTimeout(reviewTimer);
      reviewTimer = setTimeout(async () => {
        const counts = await window.api.reviewCounts().catch(() => null);
        if (!counts || !document.body.contains(sheet.element)) return;
        reviewCount = counts.duplicates + counts.sharedAddresses + counts.orgDuplicates;
        renderSummary();
        window.refreshNavBadges?.();
      }, 400);
    }

    // ---- saving changes ----
    // A change is { kind: "contact" | "household" | "org", id, path, value }
    // where path is a field ("name"), "orgName" for a person's organization
    // (by name), or "subs.<newsletter>.<email|mail|copies>".

    const recordOf = (kind, id) => (kind === "household" ? households.get(id) : kind === "org" ? orgs.get(id) : byId.get(id));

    function readPath(record, path) {
      if (path === "orgName") return record._pendingOrgName ?? orgOf(record)?.name ?? "";
      if (path.startsWith("subs.")) {
        const [, pubId, field] = path.split(".");
        return record.subs?.[pubId]?.[field];
      }
      return record[path];
    }

    function writePath(record, path, value) {
      if (path === "orgName") {
        // Linked straight away when the organization is already known;
        // a new one appears once the save comes back.
        const match = value ? [...orgs.values()].find((o) => R.orgKey(o.name) === R.orgKey(value)) : null;
        if (!value || match) {
          record.orgId = match ? match.id : null;
          delete record._pendingOrgName;
        } else record._pendingOrgName = value;
        return;
      }
      if (path.startsWith("subs.")) {
        const [, pubId, field] = path.split(".");
        record.subs = { ...(record.subs || {}), [pubId]: { ...(record.subs?.[pubId] || {}), [field]: value } };
        return;
      }
      record[path] = value;
    }

    function same(a, b) {
      if (typeof b === "boolean") return !!a === b;
      if (typeof b === "number") return a !== undefined && a !== "" && Number(a) === b;
      return String(a ?? "") === String(b ?? "");
    }

    function toPatch(step, which) {
      const patch = {};
      for (const [path, value] of Object.entries(step[which])) {
        if (path.startsWith("subs.")) {
          const [, pubId, field] = path.split(".");
          patch.subs = patch.subs || {};
          patch.subs[pubId] = { ...(patch.subs[pubId] || {}), [field]: value ?? (field === "copies" ? undefined : false) };
        } else patch[path] = value ?? "";
      }
      return { kind: step.kind, id: step.id, patch };
    }

    function rowsAffectedBy(steps) {
      const ids = new Set();
      for (const step of steps) {
        if (tab === "orgs") {
          // Members are listed under their organization; a batch changes
          // which of them are covered, and a household's Mail shows on the
          // row of everyone who lives there.
          if (step.kind === "org") {
            ids.add(step.id);
            membersOfOrg(step.id).forEach((c) => ids.add(memberRowId(c.id)));
          } else if (step.kind === "contact") ids.add(memberRowId(step.id));
          else if (step.kind === "household") membersOfHousehold(step.id).forEach((c) => ids.add(memberRowId(c.id)));
        } else if (step.kind === "contact") ids.add(step.id);
        else if (step.kind === "household") membersOfHousehold(step.id).forEach((c) => ids.add(c.id));
      }
      // An organization's batch changes who's covered, all over the People tab.
      if (tab === "people" && steps.some((s) => s.kind === "org")) return null;
      return [...ids];
    }

    function redraw(steps) {
      const ids = rowsAffectedBy(steps);
      if (ids === null) sheet.refreshAll();
      else sheet.refreshRows(ids);
    }

    function setSaveStatus() {
      qs("#save-status", container).textContent = pendingSaves ? "Saving…" : "All changes saved";
    }

    async function save(patches) {
      pendingSaves++;
      setSaveStatus();
      try {
        // What's stored can differ slightly from what was typed (trimmed
        // spaces, say); show the stored version.
        const stored = await window.api.updateList(patches);
        for (const row of stored.contacts) {
          const c = byId.get(row.id);
          if (c) {
            delete c._pendingOrgName;
            Object.assign(c, row);
          }
        }
        for (const row of stored.households) if (households.has(row.id)) Object.assign(households.get(row.id), row);
        for (const row of stored.orgs) {
          if (orgs.has(row.id)) Object.assign(orgs.get(row.id), row);
          else orgs.set(row.id, row);
        }
        if (document.body.contains(sheet.element)) {
          redraw([...stored.contacts.map((r) => ({ kind: "contact", id: r.id })), ...stored.households.map((r) => ({ kind: "household", id: r.id })), ...stored.orgs.map((r) => ({ kind: "org", id: r.id }))]);
        }
      } catch (err) {
        toast(`Couldn't save that change: ${err.message}`, true);
        await loadList().catch(() => {});
        if (document.body.contains(sheet.element)) renderAll();
      } finally {
        pendingSaves--;
        if (document.body.contains(sheet.element)) setSaveStatus();
      }
      if (document.body.contains(sheet.element)) {
        renderSummary();
        refreshReviewCount();
      }
    }

    // Applies changes to the page right away and saves them, as one step for
    // Ctrl+Z.
    function applyChanges(changes) {
      const steps = new Map();
      for (const { kind, id, path, value } of changes) {
        const record = recordOf(kind, id);
        if (!record) continue;
        const key = `${kind}:${id}`;
        if (!steps.has(key)) steps.set(key, { kind, id, before: {}, after: {} });
        const step = steps.get(key);
        const was = path in step.before ? step.before[path] : readPath(record, path);
        if (same(was, value)) {
          delete step.before[path];
          delete step.after[path];
        } else {
          step.before[path] = was;
          step.after[path] = value;
        }
      }
      const real = [...steps.values()].filter((s) => Object.keys(s.after).length);
      if (!real.length) return;
      for (const step of real) for (const [path, value] of Object.entries(step.after)) writePath(recordOf(step.kind, step.id), path, value);
      undoStack.push(real);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redraw(real);
      renderSummary();
      save(real.map((s) => toPatch(s, "after")));
    }

    function undo() {
      const steps = undoStack.pop();
      if (!steps) {
        toast("Nothing to undo.");
        return;
      }
      const live = steps.filter((s) => recordOf(s.kind, s.id));
      for (const step of live) for (const [path, value] of Object.entries(step.before)) writePath(recordOf(step.kind, step.id), path, value);
      // Undoing Remove from organization lists them under it again.
      if (tab === "orgs" && live.some((s) => "orgName" in s.before)) sheet.setView(computeView());
      redraw(live);
      renderSummary();
      if (live.length) save(live.map((s) => toPatch(s, "before")));
    }

    // Someone with no address gets a household the first time an address or
    // a mailed newsletter is filled in for them.
    async function ensureHousehold(contact) {
      const existing = householdOf(contact);
      if (existing) return existing;
      const { household, contact: updated } = await window.api.createHouseholdFor(contact.id);
      households.set(household.id, household);
      Object.assign(contact, updated);
      return household;
    }

    // Turning Mail on for a newsletter that's never had a copy count starts
    // it at 1.
    function mailChanges(kind, record, pubId, on) {
      const changes = [{ kind, id: record.id, path: `subs.${pubId}.mail`, value: on }];
      if (on && R.sub(record, pubId).copies === undefined) changes.push({ kind, id: record.id, path: `subs.${pubId}.copies`, value: 1 });
      return changes;
    }

    async function onEdits(edits) {
      const changes = [];
      for (const { rowId, col, value } of edits) {
        const [field, pubId] = col.key.split(":");
        const member = memberOf(rowId);
        if (tab === "orgs" && !member) {
          const o = orgs.get(rowId);
          if (!o) continue;
          if (field === "mail" && pubId) changes.push(...mailChanges("org", o, pubId, value));
          else changes.push({ kind: "org", id: rowId, path: pubId ? `subs.${pubId}.${field}` : col.key, value });
          continue;
        }
        const c = member || byId.get(rowId);
        if (!c) continue;
        if (["name", "email", "orgName"].includes(col.key)) changes.push({ kind: "contact", id: c.id, path: col.key, value });
        else if (field === "email" && pubId) changes.push({ kind: "contact", id: c.id, path: `subs.${pubId}.email`, value });
        else {
          // Clearing a household cell for someone with no address is nothing to do.
          if (!householdOf(c) && !value) continue;
          let h;
          try {
            h = await ensureHousehold(c);
          } catch (err) {
            toast(`Couldn't save that change: ${err.message}`, true);
            continue;
          }
          if (field === "mail") changes.push(...mailChanges("household", h, pubId, value));
          else changes.push({ kind: "household", id: h.id, path: pubId ? `subs.${pubId}.${field}` : col.key, value });
        }
      }
      applyChanges(changes);
    }

    // ---- the sheet ----

    const sheet = createSheet(qs("#sheet-host", container), {
      columns: columnsFor(),
      cell: (id, col) => {
        if (tab !== "orgs") return personCell(id, col);
        const member = memberOf(id);
        return member ? memberCell(member, col) : orgCell(id, col);
      },
      onToggle: (id) => {
        if (memberOf(id) || !orgs.has(id)) return;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        expansionChanged();
      },
      choices: () => [...orgs.values()].map((o) => o.name).filter(Boolean).sort((a, b) => collator.compare(a, b)),
      onChange: onEdits,
      onUndo: undo,
      onSort: (col) => {
        const sort = state[tab].sort;
        state[tab].sort = sort.key !== col.key ? { key: col.key, dir: 1 } : sort.dir === 1 ? { key: col.key, dir: -1 } : { key: null, dir: 1 };
        viewChanged();
      },
      onSelectionChange: renderSelectionBar,
      emptyHtml: () =>
        tab === "orgs"
          ? orgs.size
            ? "No organizations match the search or filter."
            : "No organizations yet. They're added when an import or a person's Organization names one, or with <strong>Add organization</strong>."
          : contacts.length
          ? "No one matches the search or filter."
          : `The mailing list is empty. <a href="#" data-empty-import>Import a spreadsheet or the signup form</a>, or use <strong>Add person</strong> to type people in.`,
    });

    // ---- selection bar ----

    function renderSelectionBar() {
      const bar = qs("#selection-bar", container);
      const wasShown = bar.style.display !== "none";
      const count = sheet.selected.size;
      bar.style.display = count ? "" : "none";
      if (count) {
        const chosen = [...sheet.selected].map((id) => byId.get(id)).filter(Boolean);
        const sharing = (id) => contacts.filter((c) => c.householdId === id).length > 1;
        const keepPub = qs("#bulk-pub", bar)?.value;
        const chosenMembers = tab === "orgs" ? [...sheet.selected].filter((id) => memberOf(id)).length : 0;
        const what =
          tab === "orgs"
            ? [count - chosenMembers ? plural(count - chosenMembers, "organization") : "", chosenMembers ? plural(chosenMembers, "member") : ""].filter(Boolean).join(" and ")
            : plural(count, "row");
        bar.innerHTML = `
          <strong>${what} selected</strong>
          <span class="bulk-group">
            <select id="bulk-pub" title="Which newsletter the next buttons change">${publications.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}</select>
            <button class="btn secondary" data-bulk="email" data-on="1" type="button">Email on</button>
            <button class="btn secondary" data-bulk="email" data-on="0" type="button">off</button>
            <button class="btn secondary" data-bulk="mail" data-on="1" type="button">Mail on</button>
            <button class="btn secondary" data-bulk="mail" data-on="0" type="button">off</button>
            <input type="text" id="bulk-copies" inputmode="numeric" placeholder="Copies" title="Copies by mail" />
            <button class="btn secondary" id="bulk-copies-btn" type="button">Set</button>
          </span>
          ${
            tab === "people"
              ? `<span class="bulk-group">
                  <input type="text" id="bulk-org" list="bulk-org-choices" placeholder="Organization" />
                  <datalist id="bulk-org-choices">${[...orgs.values()].map((o) => `<option value="${escapeHtml(o.name)}"></option>`).join("")}</datalist>
                  <button class="btn secondary" id="bulk-org-btn" type="button">Set</button>
                </span>
                ${chosen.length > 1 && chosen.some((c) => householdOf(c)) ? `<button class="btn secondary" id="combine-btn" type="button" title="Put these people at one address, getting one bundle">Make one household</button>` : ""}
                ${chosen.some((c) => householdOf(c) && sharing(c.householdId)) ? `<button class="btn secondary" id="separate-btn" type="button" title="Give each of these people an address of their own">Separate</button>` : ""}`
              : chosenMembers
              ? `<button class="btn secondary" id="unlink-btn" type="button" title="They stay on the list, with no organization">Remove from organization</button>`
              : ""
          }
          <span class="toolbar-gap"></span>
          <button class="btn danger" id="delete-selected-btn" type="button">Delete…</button>
          <button class="btn secondary" id="clear-selection-btn" type="button">Clear</button>
        `;
        if (keepPub && publications.some((p) => p.id === keepPub)) qs("#bulk-pub", bar).value = keepPub;
        wireSelectionBar(bar);
      }
      if (wasShown !== !!count) sheet.resized();
    }

    function wireSelectionBar(bar) {
      const pubId = () => qs("#bulk-pub", bar).value;
      // On the Organizations tab, ticked rows can be organizations, members
      // listed under them, or both.
      const chosenPeople = () => [...sheet.selected].map((id) => (tab === "orgs" ? memberOf(id) : byId.get(id))).filter(Boolean);
      const chosenOrgs = () => (tab === "orgs" ? [...sheet.selected].map((id) => orgs.get(id)).filter(Boolean) : []);
      const theirHouseholds = () => [...new Set(chosenPeople().map((c) => householdOf(c)).filter(Boolean))];

      qsa("[data-bulk]", bar).forEach((btn) =>
        btn.addEventListener("click", () => {
          const on = btn.dataset.on === "1";
          const field = btn.dataset.bulk;
          const changes = chosenOrgs().flatMap((o) => (field === "mail" ? mailChanges("org", o, pubId(), on) : [{ kind: "org", id: o.id, path: `subs.${pubId()}.email`, value: on }]));
          if (field === "email") {
            changes.push(...chosenPeople().map((c) => ({ kind: "contact", id: c.id, path: `subs.${pubId()}.email`, value: on })));
          } else {
            changes.push(...theirHouseholds().flatMap((h) => mailChanges("household", h, pubId(), on)));
            const without = chosenPeople().filter((c) => !householdOf(c)).length;
            if (without) toast(`${plural(without, "selected person has", "selected people have")} no address, so Mail wasn't changed for them.`, true);
          }
          applyChanges(changes);
        })
      );
      qs("#bulk-copies-btn", bar).addEventListener("click", () => {
        const text = qs("#bulk-copies", bar).value.trim();
        if (!/^\d+$/.test(text)) {
          toast("Enter a whole number of copies, like 1 or 15.", true);
          return;
        }
        const copies = Math.min(Number(text), R.MAX_COPIES);
        const targets = [...chosenOrgs().map((o) => ["org", o.id]), ...theirHouseholds().map((h) => ["household", h.id])];
        applyChanges(targets.map(([kind, id]) => ({ kind, id, path: `subs.${pubId()}.copies`, value: copies })));
      });
      qs("#bulk-org-btn", bar)?.addEventListener("click", () => {
        const name = qs("#bulk-org", bar).value.replace(/\s+/g, " ").trim();
        applyChanges(chosenPeople().map((c) => ({ kind: "contact", id: c.id, path: "orgName", value: name })));
      });
      qs("#unlink-btn", bar)?.addEventListener("click", () => {
        applyChanges(chosenPeople().map((c) => ({ kind: "contact", id: c.id, path: "orgName", value: "" })));
        sheet.setView(computeView());
        renderSummary();
        renderSelectionBar();
      });
      qs("#combine-btn", bar)?.addEventListener("click", async () => {
        const chosen = chosenPeople();
        const message =
          `Put these ${chosen.length} people at one address, getting one bundle of each newsletter?\n\n` +
          "The most complete address among them is kept. A newsletter stays on by mail if any of them had it, with the largest number of copies.";
        if (!(await confirmAction(message, "Make one household"))) return;
        try {
          await window.api.combineHouseholds({ contactIds: chosen.map((c) => c.id) });
          toast(`${plural(chosen.length, "person", "people")} now share one address.`);
          await reloadAll();
        } catch (err) {
          toast(err.message, true);
        }
      });
      qs("#separate-btn", bar)?.addEventListener("click", async () => {
        try {
          const { separated } = await window.api.separateHouseholds([...sheet.selected]);
          toast(`${plural(separated, "person", "people")} now ${separated === 1 ? "has an address" : "have addresses"} of their own (a copy of the old one) — change it if they've moved.`);
          await reloadAll();
        } catch (err) {
          toast(err.message, true);
        }
      });
      qs("#clear-selection-btn", bar).addEventListener("click", () => sheet.clearSelection());
      qs("#delete-selected-btn", bar).addEventListener("click", async () => {
        const orgIds = chosenOrgs().map((o) => o.id);
        const personIds = chosenPeople().map((c) => c.id);
        const orgText = orgIds.length ? plural(orgIds.length, "organization") : "";
        const personText = personIds.length ? plural(personIds.length, "person", "people") : "";
        const message =
          `Delete ${[orgText, personText].filter(Boolean).join(" and ")}${personIds.length ? " from the mailing list" : ""}? This can't be undone.` +
          (orgIds.length ? "\n\nAn organization's members stay on the list, no longer part of an organization. Batches already mailed keep a record of it." : "") +
          (personIds.length ? "\n\nPeople are taken off any mailing that hasn't gone out to them yet; mailings already sent keep a record of it. Anyone else at the same address stays." : "");
        if (!(await confirmAction(message, "Delete"))) return;
        try {
          if (personIds.length) await window.api.deleteContacts(personIds);
          if (orgIds.length) await window.api.deleteOrgs(orgIds);
        } catch (err) {
          toast(`Delete failed: ${err.message}`, true);
          await reloadAll();
          return;
        }
        toast(`Deleted ${[orgText, personText].filter(Boolean).join(" and ")}.`);
        await reloadAll();
      });
    }

    // ---- newsletters ----

    function renderPublicationsPanel() {
      const panel = qs("#pubs-panel", container);
      panel.innerHTML = `
        <h2 style="margin-top:0">Newsletters and magazines</h2>
        <p class="hint" style="margin-top:0">Each one gets its own Email, Mail and Copies columns, and its own mailings. Rename one by typing over its name.</p>
        ${publications
          .map(
            (p) => `<div class="row pub-row">
              <input type="text" class="pub-name" data-id="${p.id}" value="${escapeHtml(p.name)}" />
              <button class="btn danger" data-remove-pub="${p.id}" type="button">Remove…</button>
            </div>`
          )
          .join("")}
        <div class="row pub-row">
          <input type="text" id="new-pub" placeholder="Add one, e.g. Annual Report" />
          <button class="btn" id="add-pub-btn" type="button">Add</button>
        </div>
      `;
      qsa(".pub-name", panel).forEach((input) =>
        input.addEventListener("change", async () => {
          try {
            await window.api.renamePublication(input.dataset.id, input.value);
            toast("Renamed.");
          } catch (err) {
            toast(err.message, true);
          }
          await publicationsChanged();
        })
      );
      qsa("[data-remove-pub]", panel).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const name = pubName(btn.dataset.removePub);
          const message = `Remove ${name}? Everyone's Email, Mail and Copies for it are cleared. Past mailings of it keep their records.`;
          if (!(await confirmAction(message, "Remove"))) return;
          await window.api.removePublication(btn.dataset.removePub);
          toast(`Removed ${name}.`);
          await publicationsChanged();
        })
      );
      const add = async () => {
        try {
          const added = await window.api.addPublication(qs("#new-pub", panel).value);
          toast(`Added ${added.name}.`);
          await publicationsChanged();
        } catch (err) {
          toast(err.message, true);
        }
      };
      qs("#add-pub-btn", panel).addEventListener("click", add);
      qs("#new-pub", panel).addEventListener("keydown", (e) => {
        if (e.key === "Enter") add();
      });
    }

    async function publicationsChanged() {
      await loadList();
      for (const t of ["people", "orgs"]) if (/^pub:/.test(state[t].show) && !publications.some((p) => state[t].show.startsWith(`pub:${p.id}:`))) state[t].show = "all";
      renderPublicationsPanel();
      setUpTab();
    }

    // ---- everything ----

    function renderAll() {
      sheet.setView(computeView());
      renderSummary();
      renderSelectionBar();
    }

    async function reloadAll() {
      await loadList();
      sheet.clearSelection();
      undoStack.length = 0;
      renderAll();
      refreshReviewCount();
    }

    // A new search, filter or sort starts back at the top, and rows added
    // by hand stop being pinned there.
    function viewChanged() {
      pinned.length = 0;
      remember();
      sheet.setColumns(columnsFor());
      sheet.setSortMark(state[tab].sort.key, state[tab].sort.dir);
      sheet.setView(computeView(), { toTop: true });
      renderSummary();
    }

    function setUpTab() {
      qsa(".tab", container).forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
      qs("#sheet-search", container).placeholder = tab === "orgs" ? "Search organizations…" : "Search names, organizations, addresses, emails…";
      qs("#sheet-search", container).value = state[tab].search;
      qs("#sheet-show", container).innerHTML = showOptions();
      qs("#sheet-show", container).value = state[tab].show;
      if (qs("#sheet-show", container).value !== state[tab].show) state[tab].show = "all";
      qs("#add-row-btn", container).textContent = tab === "orgs" ? "Add organization" : "Add person";
      qs("#sheet-help", container).innerHTML =
        tab === "orgs"
          ? "An organization's Mail and Copies are a batch for its members, sent to its address (to whoever's under Attention). Members are marked as covered (hatched), so they don't need their own copy. " +
            "Click the arrow by a Members count to list them underneath: their rows work as on the People tab — their own Email, and their household's Mail and Copies (tinted when others live there too)."
          : "Click a cell, then type or double-click to change it; Enter and Tab move on, Esc cancels, Ctrl+Z undoes, and a block pasted from Excel fills many cells. " +
            "Shaded cells are shared by everyone at that address. Hatched cells mean their organization gets that newsletter for them.";
      undoStack.length = 0;
      sheet.clearSelection();
      viewChanged();
    }

    qsa(".tab", container).forEach((btn) =>
      btn.addEventListener("click", () => {
        if (btn.dataset.tab === tab) return;
        sheet.commitEdit();
        tab = btn.dataset.tab;
        setUpTab();
      })
    );
    qs("#members-btn", container).addEventListener("click", () => {
      sheet.commitEdit();
      const withMembers = orgsWithMembers();
      if (withMembers.every((id) => expanded.has(id))) expanded.clear();
      else withMembers.forEach((id) => expanded.add(id));
      expansionChanged();
    });
    qs("#pubs-btn", container).addEventListener("click", () => {
      const panel = qs("#pubs-panel", container);
      const open = panel.style.display === "none";
      panel.style.display = open ? "" : "none";
      if (open) renderPublicationsPanel();
      sheet.resized();
    });
    qs("#sheet-search", container).addEventListener("input", (e) => {
      state[tab].search = e.target.value;
      viewChanged();
    });
    qs("#sheet-show", container).addEventListener("change", (e) => {
      state[tab].show = e.target.value;
      viewChanged();
    });
    qs("#sheet-summary", container).addEventListener("click", (e) => {
      if (e.target.closest("[data-duplicates]")) {
        e.preventDefault();
        navigate("duplicates");
        return;
      }
      const link = e.target.closest("[data-show]");
      if (!link) return;
      e.preventDefault();
      state[tab].show = link.dataset.show;
      qs("#sheet-show", container).value = state[tab].show;
      viewChanged();
    });
    qs("#sheet-host", container).addEventListener("click", (e) => {
      if (e.target.closest("[data-empty-import]")) {
        e.preventDefault();
        navigate("import");
      }
    });

    qs("#add-row-btn", container).addEventListener("click", async () => {
      sheet.commitEdit();
      try {
        if (tab === "orgs") {
          const row = await window.api.createOrg();
          orgs.set(row.id, row);
          pinned.unshift(row.id);
        } else {
          const row = await window.api.createContact();
          contacts.push(row);
          byId.set(row.id, row);
          pinned.unshift(row.id);
        }
        sheet.setView(computeView());
        sheet.scrollToTop();
        sheet.setActive(pinned[0], "name");
        sheet.startEdit();
        renderSummary();
      } catch (err) {
        toast(`Couldn't add one: ${err.message}`, true);
      }
    });
    qs("#import-btn", container).addEventListener("click", () => {
      window.__importMode = tab === "orgs" ? "org" : "person";
      navigate("import");
    });
    qs("#export-btn", container).addEventListener("click", async () => {
      sheet.commitEdit();
      const ids = sheet.view.map((row) => row.id).filter((id) => !memberOf(id));
      if (!ids.length) {
        toast("There's nothing shown to export.", true);
        return;
      }
      try {
        const savedPath = tab === "orgs" ? await window.api.exportOrgs(ids) : await window.api.exportContacts(ids);
        if (savedPath) toast(`Exported ${plural(ids.length, tab === "orgs" ? "organization" : "person", tab === "orgs" ? "organizations" : "people")} to ${savedPath}`);
      } catch (err) {
        toast(`Export failed: ${err.message}`, true);
      }
    });

    // An edit still open when another page is picked would otherwise be lost.
    window.__beforeNavigate = () => sheet.commitEdit();
    // Another computer's changes: the same tab, filter, scroll position and
    // selection, with the new rows -- and new columns, if a newsletter was
    // added or renamed there.
    window.__refreshPage = async function refresh() {
      if (sheet.isEditing()) {
        setTimeout(() => window.__refreshPage === refresh && refresh(), 800);
        return;
      }
      const pubsBefore = JSON.stringify(publications);
      await loadList();
      if (!document.body.contains(sheet.element)) return;
      if (JSON.stringify(publications) !== pubsBefore) {
        if (qs("#pubs-panel", container).style.display !== "none") renderPublicationsPanel();
        setUpTab();
      } else renderAll();
      refreshReviewCount();
    };

    setUpTab();
    refreshReviewCount();
  },
};
