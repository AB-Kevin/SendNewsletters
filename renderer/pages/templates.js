"use strict";

const MERGE_FIELDS = ["name", "orgName", "email", "addressLine1", "city", "state", "zip", "copies"];

window.Pages.templates = {
  async render(container) {
    let templates = await window.api.listTemplates();
    let editingId = null;
    let pickedPdf = null; // { storedPath, originalName }

    container.innerHTML = `
      <h1>Templates</h1>
      <p class="subtitle">The email each mailing sends, with the newsletter attached as a PDF. Fill in each person's details with
        ${MERGE_FIELDS.map((f) => `<code>{{${f}}}</code>`).join(" ")} — <code>{{copies}}</code> is how many copies of the mailing's newsletter go to their address. Sent to an organization, <code>{{name}}</code> is its Attention line.</p>

      <div class="panel">
        <h2 style="margin-top:0" id="form-title">New template</h2>
        <div class="field">
          <label for="tpl-name">Name</label>
          <input type="text" id="tpl-name" placeholder="e.g. Fall 2026 Newsletter" />
        </div>
        <div class="field">
          <label for="tpl-subject">Subject</label>
          <input type="text" id="tpl-subject" placeholder="e.g. The Fall 2026 newsletter is here" />
        </div>
        <div class="field">
          <label>Body</label>
          <div class="rte-toolbar">
            <button type="button" class="rte-btn" data-cmd="bold" title="Bold"><b>B</b></button>
            <button type="button" class="rte-btn" data-cmd="italic" title="Italic"><i>I</i></button>
            <button type="button" class="rte-btn" data-cmd="underline" title="Underline"><u>U</u></button>
            <button type="button" class="rte-btn" data-cmd="insertUnorderedList" title="Bullet list">• List</button>
            <button type="button" class="rte-btn" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
            <button type="button" class="rte-btn" data-cmd="link" title="Insert link">Link</button>
            <button type="button" class="rte-btn" data-cmd="removeFormat" title="Clear formatting">Clear</button>
          </div>
          <div class="row" id="link-input-row" style="display:none;margin-bottom:6px">
            <input type="text" id="link-url-input" placeholder="https://example.org" style="flex:1" />
            <button type="button" class="btn secondary" id="link-insert-btn">Insert</button>
            <button type="button" class="btn secondary" id="link-cancel-btn">Cancel</button>
          </div>
          <div
            id="tpl-body"
            class="rte-body"
            contenteditable="true"
            data-placeholder="Dear {{name}}, the latest newsletter is attached. Thank you for your support!"
          ></div>
        </div>
        <div class="field">
          <label>PDF attachment</label>
          <div class="row">
            <button class="btn secondary" id="pick-pdf-btn" type="button">Choose PDF…</button>
            <span class="hint" id="pdf-name"></span>
            <button class="btn secondary" id="remove-pdf-btn" type="button" style="display:none">Remove</button>
          </div>
          <p class="hint">Attached to every email exactly as it is, under its file name. For a new issue, edit the template and choose the new PDF.</p>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn" id="save-tpl-btn" type="button">Save template</button>
          <button class="btn secondary" id="cancel-edit-btn" type="button" style="display:none">Cancel edit</button>
        </div>
      </div>

      <h2>Existing templates</h2>
      <div class="panel">
        <table>
          <thead><tr><th>Name</th><th>Subject</th><th>PDF attached</th><th></th></tr></thead>
          <tbody id="tpl-rows"></tbody>
        </table>
        <div id="tpl-empty" class="empty" style="display:none">No templates yet.</div>
      </div>
    `;

    const bodyEl = qs("#tpl-body", container);

    // Electron's BrowserWindow doesn't implement window.prompt() (only
    // alert()/confirm() are supported) -- it silently does nothing -- so the
    // link URL needs its own inline input instead.
    let savedLinkRange = null;

    qsa(".rte-btn", container).forEach((btn) => {
      btn.addEventListener("click", () => {
        bodyEl.focus();
        if (btn.dataset.cmd === "link") {
          const sel = window.getSelection();
          savedLinkRange = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
          qs("#link-input-row", container).style.display = "flex";
          qs("#link-url-input", container).value = "";
          qs("#link-url-input", container).focus();
        } else {
          document.execCommand(btn.dataset.cmd, false, null);
        }
      });
    });

    function insertLink() {
      const url = qs("#link-url-input", container).value.trim();
      const sel = window.getSelection();
      if (url && savedLinkRange) {
        sel.removeAllRanges();
        sel.addRange(savedLinkRange);
        document.execCommand("createLink", false, url);
      }
      qs("#link-input-row", container).style.display = "none";
      savedLinkRange = null;
    }
    qs("#link-insert-btn", container).addEventListener("click", insertLink);
    qs("#link-url-input", container).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        insertLink();
      }
    });
    qs("#link-cancel-btn", container).addEventListener("click", () => {
      qs("#link-input-row", container).style.display = "none";
      savedLinkRange = null;
    });

    function showPdf() {
      qs("#pdf-name", container).textContent = pickedPdf ? pickedPdf.originalName : "None";
      qs("#remove-pdf-btn", container).style.display = pickedPdf ? "" : "none";
    }

    qs("#pick-pdf-btn", container).addEventListener("click", async () => {
      const result = await window.api.pickPdfTemplate();
      if (!result) return;
      pickedPdf = result;
      showPdf();
    });
    qs("#remove-pdf-btn", container).addEventListener("click", () => {
      pickedPdf = null;
      showPdf();
    });

    function resetForm() {
      editingId = null;
      pickedPdf = null;
      qs("#form-title", container).textContent = "New template";
      qs("#tpl-name", container).value = "";
      qs("#tpl-subject", container).value = "";
      bodyEl.innerHTML = "";
      qs("#cancel-edit-btn", container).style.display = "none";
      qs("#link-input-row", container).style.display = "none";
      savedLinkRange = null;
      showPdf();
    }

    qs("#cancel-edit-btn", container).addEventListener("click", resetForm);

    function renderList() {
      const body = qs("#tpl-rows", container);
      qs("#tpl-empty", container).style.display = templates.length ? "none" : "block";
      body.innerHTML = templates
        .map(
          (t) => `
        <tr>
          <td>${escapeHtml(t.name)}</td>
          <td>${escapeHtml(t.subject || "")}</td>
          <td>${t.pdfPath ? escapeHtml(t.pdfOriginalName || "Yes") : "—"}</td>
          <td class="actions-cell">
            <button class="btn secondary" data-edit="${t.id}" type="button">Edit</button>
            <button class="btn danger" data-delete="${t.id}" type="button">Delete</button>
          </td>
        </tr>`
        )
        .join("");

      qsa("[data-edit]", body).forEach((btn) =>
        btn.addEventListener("click", () => {
          const tpl = templates.find((t) => t.id === btn.dataset.edit);
          editingId = tpl.id;
          pickedPdf = tpl.pdfPath ? { storedPath: tpl.pdfPath, originalName: tpl.pdfOriginalName || "current file" } : null;
          qs("#form-title", container).textContent = `Editing: ${tpl.name}`;
          qs("#tpl-name", container).value = tpl.name;
          qs("#tpl-subject", container).value = tpl.subject || "";
          bodyEl.innerHTML = tpl.body || "";
          qs("#cancel-edit-btn", container).style.display = "inline-block";
          showPdf();
          qs("#content").scrollTo(0, 0);
        })
      );
      qsa("[data-delete]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          if (!(await confirmAction("Delete this template? Mailings that use it won't be able to send emails.", "Delete"))) return;
          await window.api.deleteTemplate(btn.dataset.delete);
          templates = await window.api.listTemplates();
          if (editingId === btn.dataset.delete) resetForm();
          renderList();
          toast("Template deleted.");
        })
      );
    }

    qs("#save-tpl-btn", container).addEventListener("click", async () => {
      const name = qs("#tpl-name", container).value.trim();
      const subject = qs("#tpl-subject", container).value.trim();
      if (!name || !subject || bodyEl.textContent.trim() === "") {
        toast("Name, subject and body are all needed.", true);
        return;
      }
      const data = {
        name,
        subject,
        body: bodyEl.innerHTML.trim(),
        pdfPath: pickedPdf ? pickedPdf.storedPath : null,
        pdfOriginalName: pickedPdf ? pickedPdf.originalName : null,
      };
      if (editingId) {
        await window.api.updateTemplate(editingId, data);
        toast("Template updated.");
      } else {
        await window.api.createTemplate(data);
        toast("Template created.");
      }
      templates = await window.api.listTemplates();
      resetForm();
      renderList();
    });

    showPdf();
    renderList();
  },
};
