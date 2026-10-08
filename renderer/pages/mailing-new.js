"use strict";

window.Pages["mailing-new"] = {
  async render(container) {
    const [templates, publications] = await Promise.all([window.api.listTemplates(), window.api.listPublications()]);
    const fields = Object.keys(CONTACT_FIELD_LABELS);
    let rules = [];
    let previewTimer = null;
    let previewRequest = 0;

    container.innerHTML = `
      <h1>New Mailing</h1>
      <p class="subtitle">One mailing is one issue of one newsletter. Everyone checked for it by email gets it by email; each address checked for it by mail gets one bundle
        with its number of copies, however many people live there; and each organization checked for it gets its batch.</p>

      <div class="panel">
        <h2 style="margin-top:0">Who gets it?</h2>
        <div class="field" style="max-width:320px">
          <label for="mailing-pub">Newsletter</label>
          <select id="mailing-pub">${
            publications.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("") ||
            '<option value="">Add a newsletter on the Mailing List first</option>'
          }</select>
        </div>
        <div class="row" style="margin-bottom:12px">
          <label class="check-label"><input type="checkbox" id="include-email" checked /> By email</label>
          <label class="check-label"><input type="checkbox" id="include-mail" checked /> By mail</label>
        </div>
        <div id="rules-area"></div>
        <button class="btn secondary" id="add-rule-btn" type="button">+ Only send to some of the list…</button>
        <div id="preview-area" style="margin-top:16px"></div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Mailing details</h2>
        <div class="row" style="align-items:flex-start">
          <div class="field" style="flex:1;max-width:400px">
            <label for="mailing-name">Name</label>
            <input type="text" id="mailing-name" placeholder="e.g. Fall 2026 Newsletter" />
          </div>
          <div class="field" style="flex:1;max-width:400px" id="template-field">
            <label for="template-email">Email template</label>
            <select id="template-email">${
              templates.length
                ? templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}${t.pdfPath ? "" : " (no PDF attached)"}</option>`).join("")
                : '<option value="">No email templates yet — add one on the Templates page</option>'
            }</select>
          </div>
        </div>
        <button class="btn" id="create-mailing-btn" type="button" style="margin-top:8px">Create mailing</button>
      </div>
    `;

    function options() {
      return {
        publicationId: qs("#mailing-pub", container).value,
        includeEmail: qs("#include-email", container).checked,
        includeMail: qs("#include-mail", container).checked,
      };
    }

    function renderRules() {
      const area = qs("#rules-area", container);
      if (rules.length === 0) {
        area.innerHTML = `<p class="hint" style="margin-top:0">Goes to everyone on the mailing list who's set up to get this newsletter.</p>`;
        return;
      }
      area.innerHTML =
        '<p class="hint" style="margin-top:0">Only people and organizations matching all of these:</p>' +
        rules
          .map(
            (rule, i) => `
        <div class="filter-rule" data-idx="${i}">
          <select class="rule-field">${fields
            .map((f) => `<option value="${f}" ${rule.field === f ? "selected" : ""}>${escapeHtml(CONTACT_FIELD_LABELS[f])}</option>`)
            .join("")}</select>
          <select class="rule-op">${FILTER_OPS.map((o) => `<option value="${o.value}" ${rule.op === o.value ? "selected" : ""}>${o.label}</option>`).join("")}</select>
          <input type="text" class="rule-value" value="${escapeHtml(rule.value || "")}" style="${filterRuleNeedsValue(rule.op) ? "" : "display:none"}" />
          <button class="btn danger" data-remove="${i}" type="button">Remove</button>
        </div>`
          )
          .join("");

      qsa(".filter-rule", area).forEach((rowEl) => {
        const idx = Number(rowEl.dataset.idx);
        qs(".rule-field", rowEl).addEventListener("change", (e) => {
          rules[idx].field = e.target.value;
          schedulePreview();
        });
        qs(".rule-op", rowEl).addEventListener("change", (e) => {
          rules[idx].op = e.target.value;
          qs(".rule-value", rowEl).style.display = filterRuleNeedsValue(e.target.value) ? "" : "none";
          schedulePreview();
        });
        qs(".rule-value", rowEl).addEventListener("input", (e) => {
          rules[idx].value = e.target.value;
          schedulePreview();
        });
      });
      qsa("[data-remove]", area).forEach((btn) =>
        btn.addEventListener("click", () => {
          rules.splice(Number(btn.dataset.remove), 1);
          renderRules();
          schedulePreview();
        })
      );
    }

    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(renderPreview, 150);
    }

    function problemNote(problem, countText, what) {
      if (!problem.count) return "";
      const more = problem.count > problem.names.length ? ` and ${problem.count - problem.names.length} more` : "";
      return `<li>${countText} ${what}: ${problem.names.map(escapeHtml).join(", ")}${more}.</li>`;
    }

    async function renderPreview() {
      const opts = options();
      const { includeEmail, includeMail } = opts;
      qs("#template-field", container).style.display = includeEmail ? "" : "none";
      const area = qs("#preview-area", container);
      if (!opts.publicationId) {
        area.innerHTML = '<p class="hint" style="color:var(--warn)">There are no newsletters yet — add one with Newsletters… on the Mailing List.</p>';
        return;
      }
      if (!includeEmail && !includeMail) {
        area.innerHTML = '<p class="hint" style="color:var(--warn)">Choose email, mail, or both.</p>';
        return;
      }
      const request = ++previewRequest;
      const result = await window.api.previewMailing(rules, opts);
      if (request !== previewRequest || !document.body.contains(area)) return;
      const notes = [
        problemNote(result.emailProblems, plural(result.emailProblems.count, "is", "are"), "checked for email but have no usable email address, so won't be emailed"),
        problemNote(result.mailProblems, plural(result.mailProblems.count, "address is", "addresses are"), "checked for mail but incomplete or set to 0 copies, so won't be mailed"),
        result.notReceiving ? `<li>${plural(result.notReceiving, "person isn't", "people aren't")} set up to get this newsletter at all.</li>` : "",
      ].join("");
      const emailTotal = result.emailPeople + result.emailOrgs;
      area.innerHTML = `
        <div class="stat-row">
          ${includeEmail ? `<div class="stat-card"><div class="num">${emailTotal.toLocaleString()}</div><div class="label">By email${result.emailOrgs ? ` (${plural(result.emailOrgs, "organization")})` : ""}</div></div>` : ""}
          ${includeMail ? `<div class="stat-card"><div class="num">${result.mailHouseholds.toLocaleString()}</div><div class="label">Household addresses</div></div>` : ""}
          ${includeMail && result.mailOrgs ? `<div class="stat-card"><div class="num">${result.mailOrgs.toLocaleString()}</div><div class="label">Organization batches</div></div>` : ""}
          ${includeMail ? `<div class="stat-card"><div class="num">${result.copies.toLocaleString()}</div><div class="label">Copies to mail</div></div>` : ""}
        </div>
        ${result.throughOrg ? `<p class="hint">${plural(result.throughOrg, "more person gets", "more people get")} it through their organization's batch.</p>` : ""}
        ${
          notes
            ? `<ul class="hint preview-notes">${notes}</ul>
               ${result.emailProblems.count || result.mailProblems.count ? `<a href="#" id="show-problems">Fix these on the mailing list</a>` : ""}`
            : ""
        }
      `;
      qs("#show-problems", area)?.addEventListener("click", (e) => {
        e.preventDefault();
        window.__contactsView = { tab: "people", showFilter: "problems" };
        navigate("contacts");
      });
    }

    qs("#add-rule-btn", container).addEventListener("click", () => {
      rules.push({ field: "state", op: "equals", value: "" });
      renderRules();
      schedulePreview();
    });
    for (const id of ["#mailing-pub", "#include-email", "#include-mail"]) qs(id, container).addEventListener("change", schedulePreview);

    qs("#create-mailing-btn", container).addEventListener("click", async () => {
      const name = qs("#mailing-name", container).value.trim();
      if (!name) {
        toast("Give this mailing a name.", true);
        return;
      }
      const btn = qs("#create-mailing-btn", container);
      btn.disabled = true;
      try {
        await window.api.createMailing({
          name,
          templateId: qs("#template-email", container).value || null,
          filterRules: rules.filter((r) => !filterRuleNeedsValue(r.op) || String(r.value || "").trim()),
          ...options(),
        });
        toast(`Mailing "${name}" created.`);
        navigate("mailings");
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });

    renderRules();
    renderPreview();
  },
};
