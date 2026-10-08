"use strict";

window.Pages["gravity-forms"] = {
  async render(container) {
    let [connections, mailings] = await Promise.all([window.api.listGravityForms(), window.api.listMailings()]);
    let editingId = null;
    let discoveredForms = [];

    container.innerHTML = `
      <h1>Gravity Forms</h1>
      <p class="subtitle">Recipients fill out the form on your WordPress site. SendNewsletters sends each recipient a link with a hidden token,
        then periodically checks the Gravity Forms API for new entries and matches them back by that token.</p>

      <div class="panel">
        <p class="hint" style="margin-top:0">
          One-time setup in WordPress: on the form, add a hidden field with <strong>Allow field to be populated dynamically</strong> turned on
          (parameter name below); then under Gravity Forms → Settings → REST API, enable the API and Basic Authentication, and create a Consumer Key/Secret.
        </p>

        <h2 style="margin-top:0" id="form-title">New connection</h2>
        <div class="row">
          <div class="field" style="flex:1">
            <label>Connection name</label>
            <input type="text" id="gf-name" placeholder="e.g. Church website" />
          </div>
          <div class="field" style="flex:1">
            <label>Site URL</label>
            <input type="url" id="gf-site-url" placeholder="https://example.org" />
          </div>
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>Consumer key</label>
            <input type="text" id="gf-key" />
          </div>
          <div class="field" style="flex:1">
            <label>Consumer secret</label>
            <input type="password" id="gf-secret" placeholder="(leave blank to keep current when editing)" />
          </div>
          <button class="btn secondary" id="test-conn-btn" type="button" style="align-self:flex-end;margin-bottom:12px">Test connection</button>
        </div>
        <div class="field" id="form-picker-field" style="display:none">
          <label>Form</label>
          <select id="gf-form-picker"></select>
        </div>
        <div class="row">
          <div class="field">
            <label>Form ID</label>
            <input type="text" id="gf-form-id" placeholder="e.g. 3" />
          </div>
          <div class="field" style="flex:1">
            <label>Public page URL</label>
            <input type="url" id="gf-page-url" placeholder="https://example.org/survey" />
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>Token parameter name</label>
            <input type="text" id="gf-token-param" value="rtoken" />
          </div>
          <div class="field">
            <label>Hidden token field ID</label>
            <input type="text" id="gf-token-field-id" placeholder="e.g. 12" />
          </div>
          <div class="field">
            <label>Member ID field ID</label>
            <input type="text" id="gf-member-id-field-id" placeholder="optional, e.g. 3" />
          </div>
        </div>
        <p class="hint">Field IDs are shown in the Gravity Forms editor when you click a field (its "Field ID" appears in the field settings).
          If the form asks members for their member ID, entries without a token are matched by it against the contacts' ID column;
          anything that can't be matched with confidence is listed on the Tracking page to match by hand.</p>

        <div class="row" style="margin-top:12px">
          <button class="btn" id="save-gf-btn">Save connection</button>
          <button class="btn secondary" id="cancel-edit-btn" style="display:none">Cancel edit</button>
        </div>
      </div>

      <h2>Registered connections</h2>
      <div class="panel">
        <table>
          <thead><tr><th>Name</th><th>Site</th><th>Form ID</th><th>Used by</th><th></th></tr></thead>
          <tbody id="gf-rows"></tbody>
        </table>
        <div id="gf-empty" class="empty" style="display:none">No connections yet.</div>
      </div>
    `;

    function resetForm() {
      editingId = null;
      discoveredForms = [];
      qs("#form-title", container).textContent = "New connection";
      qs("#gf-name", container).value = "";
      qs("#gf-site-url", container).value = "";
      qs("#gf-key", container).value = "";
      qs("#gf-secret", container).value = "";
      qs("#gf-form-id", container).value = "";
      qs("#gf-page-url", container).value = "";
      qs("#gf-token-param", container).value = "rtoken";
      qs("#gf-token-field-id", container).value = "";
      qs("#gf-member-id-field-id", container).value = "";
      qs("#form-picker-field", container).style.display = "none";
      qs("#cancel-edit-btn", container).style.display = "none";
    }

    qs("#cancel-edit-btn", container).addEventListener("click", resetForm);

    qs("#test-conn-btn", container).addEventListener("click", async () => {
      const siteUrl = qs("#gf-site-url", container).value.trim();
      const key = qs("#gf-key", container).value.trim();
      const secret = qs("#gf-secret", container).value.trim();
      if (!siteUrl || !key || !secret) {
        toast("Enter site URL, consumer key, and consumer secret first.", true);
        return;
      }
      try {
        discoveredForms = await window.api.testGfConnection(siteUrl, key, secret);
        toast(`Connected — found ${discoveredForms.length} form(s).`);
        const picker = qs("#gf-form-picker", container);
        picker.innerHTML = discoveredForms.map((f) => `<option value="${f.id}">${escapeHtml(f.title)} (#${f.id})</option>`).join("");
        qs("#form-picker-field", container).style.display = "flex";
        picker.onchange = () => {
          qs("#gf-form-id", container).value = picker.value;
        };
        if (discoveredForms.length) qs("#gf-form-id", container).value = discoveredForms[0].id;
      } catch (err) {
        toast(`Connection failed: ${err.message}`, true);
      }
    });

    function usageCount(connectionId) {
      return mailings.filter((m) => m.gravityFormId === connectionId).length;
    }

    function renderList() {
      const body = qs("#gf-rows", container);
      qs("#gf-empty", container).style.display = connections.length ? "none" : "block";
      body.innerHTML = connections
        .map((c) => {
          const count = usageCount(c.id);
          return `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(c.siteUrl)}</td>
          <td>${escapeHtml(c.formId)}</td>
          <td>${count} mailing${count === 1 ? "" : "s"}</td>
          <td>
            <button class="btn secondary" data-edit="${c.id}">Edit</button>
            <button class="btn danger" data-delete="${c.id}">Delete</button>
          </td>
        </tr>`;
        })
        .join("");
      qsa("[data-edit]", body).forEach((btn) =>
        btn.addEventListener("click", () => {
          const c = connections.find((x) => x.id === btn.dataset.edit);
          editingId = c.id;
          qs("#form-title", container).textContent = `Editing: ${c.name}`;
          qs("#gf-name", container).value = c.name;
          qs("#gf-site-url", container).value = c.siteUrl;
          qs("#gf-key", container).value = c.consumerKey;
          qs("#gf-secret", container).value = "";
          qs("#gf-form-id", container).value = c.formId;
          qs("#gf-page-url", container).value = c.pageUrl;
          qs("#gf-token-param", container).value = c.tokenParamName || "rtoken";
          qs("#gf-token-field-id", container).value = c.tokenFieldId || "";
          qs("#gf-member-id-field-id", container).value = c.memberIdFieldId || "";
          qs("#cancel-edit-btn", container).style.display = "inline-block";
          window.scrollTo(0, 0);
        })
      );
      qsa("[data-delete]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          if (!(await confirmAction("Delete this connection?", "Delete"))) return;
          await window.api.deleteGravityForm(btn.dataset.delete);
          connections = await window.api.listGravityForms();
          renderList();
          toast("Connection deleted.");
        })
      );
    }

    qs("#save-gf-btn", container).addEventListener("click", async () => {
      const name = qs("#gf-name", container).value.trim();
      const siteUrl = qs("#gf-site-url", container).value.trim();
      const consumerKey = qs("#gf-key", container).value.trim();
      const consumerSecret = qs("#gf-secret", container).value.trim();
      const formId = qs("#gf-form-id", container).value.trim();
      const pageUrl = qs("#gf-page-url", container).value.trim();
      const tokenParamName = qs("#gf-token-param", container).value.trim() || "rtoken";
      const tokenFieldId = qs("#gf-token-field-id", container).value.trim();
      const memberIdFieldId = qs("#gf-member-id-field-id", container).value.trim();

      if (!name || !siteUrl || !consumerKey || !formId || !pageUrl || !tokenFieldId) {
        toast("Fill in name, site URL, consumer key, form ID, page URL, and token field ID.", true);
        return;
      }
      if (!editingId && !consumerSecret) {
        toast("Consumer secret is required for a new connection.", true);
        return;
      }

      const data = { name, siteUrl, consumerKey, formId, pageUrl, tokenParamName, tokenFieldId, memberIdFieldId };
      if (consumerSecret) data.consumerSecret = consumerSecret;

      if (editingId) {
        await window.api.updateGravityForm(editingId, data);
        toast("Connection updated.");
      } else {
        await window.api.createGravityForm(data);
        toast("Connection saved.");
      }
      connections = await window.api.listGravityForms();
      resetForm();
      renderList();
    });

    renderList();
  },
};
