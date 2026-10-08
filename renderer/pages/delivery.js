"use strict";

// Sending to this recipient was attempted and failed (bad address, rejected
// by the mail server, ...) -- they're still waiting to be sent.
function isSendFailed(row) {
  return row.channel === "email" && row.status === "pending" && !!row.error;
}

// Emailed already -- the email can be sent to them again.
function canResend(row) {
  return row.channel === "email" && row.status === "sent";
}

function canMarkMailed(row) {
  return row.channel === "mail" && row.status === "pending";
}

function deliveryBadge(row) {
  if (row.channel === "mail") {
    return row.status === "sent" ? `<span class="badge badge-sent">Mailed</span>` : `<span class="badge badge-pending">To mail</span>`;
  }
  if (row.status === "sent") return `<span class="badge badge-sent">Emailed</span>`;
  if (isSendFailed(row)) return `<span class="badge badge-failed">Send failed</span>`;
  return `<span class="badge badge-pending">Not sent yet</span>`;
}

function contactAddress(c) {
  return [c?.addressLine1, c?.addressLine2, c?.city, [c?.state, c?.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

// Who a row is: an email goes to one person; a mailed bundle goes to an
// address and everyone who lives there.
function deliveryWho(row) {
  if (row.org) {
    const o = row.org;
    const reach = row.channel === "mail" ? contactAddress(o) : o.email || "";
    return { name: o.name || "(no name)", org: o.attn ? `Attn: ${o.attn}` : "Organization", reach, search: `${o.name || ""} ${o.attn || ""} ${reach}` };
  }
  if (row.channel === "mail") {
    const h = row.household || {};
    const name = h.addressee || "(no one listed)";
    return { name, org: "", reach: contactAddress(h), search: `${name} ${contactAddress(h)}` };
  }
  const c = row.contact || {};
  const name = c.name || "(no name)";
  return { name, org: row.orgName || "", reach: c.email || "", search: `${name} ${row.orgName || ""} ${c.email || ""}` };
}

window.Pages.delivery = {
  async render(container) {
    const mailings = await window.api.listMailings();
    const preset = window.__deliveryView || {};
    window.__deliveryView = null;
    let mailingFilter = preset.mailingId || mailings[0]?.id || "";
    let statusFilter = preset.statusFilter || "all";
    let searchTerm = "";
    let rows = [];
    let expandedId = null;

    container.innerHTML = `
      <h1>Delivery</h1>
      <p class="subtitle">Who each mailing went to and how — emails sent or failed, and copies to mail or already mailed.</p>

      <div class="stat-row" id="stat-row"></div>

      <div class="panel">
        <div class="row">
          <div class="field">
            <label for="mailing-filter">Mailing</label>
            <select id="mailing-filter">
              ${mailings.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("")}
              <option value="">All mailings</option>
            </select>
          </div>
          <div class="field">
            <label for="status-filter">Show</label>
            <select id="status-filter">
              <option value="all">Everyone</option>
              <option value="email">By email</option>
              <option value="emailed">— Emailed</option>
              <option value="failed">— Send failed</option>
              <option value="unsent">— Not sent yet</option>
              <option value="mail">By mail</option>
              <option value="to-mail">— To mail</option>
              <option value="mailed">— Mailed</option>
            </select>
          </div>
          <div class="field" style="flex:1">
            <label for="search-box">Search</label>
            <input type="text" id="search-box" placeholder="Name, organization, email, or address…" />
          </div>
          <div class="field-buttons">
            <button class="btn secondary" id="export-btn" type="button">Export…</button>
            <button class="btn secondary" id="export-addresses-btn" type="button">Mailing addresses…</button>
            <button class="btn" id="mark-batch-btn" type="button" style="display:none"></button>
          </div>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Sent by</th><th>Email / address</th><th class="num">Copies</th><th>When</th><th>Status</th><th></th></tr></thead>
          <tbody id="delivery-rows"></tbody>
        </table>
        <div id="delivery-empty" class="empty" style="display:none"></div>
      </div>
    `;

    qs("#mailing-filter", container).value = mailingFilter;
    qs("#status-filter", container).value = statusFilter;

    async function reload() {
      rows = await window.api.listDelivery(mailingFilter || undefined);
      renderAll();
    }

    function filteredRows() {
      const words = searchTerm.split(/\s+/).filter(Boolean);
      return rows.filter((r) => {
        switch (statusFilter) {
          case "email":
          case "mail":
            if (r.channel !== statusFilter) return false;
            break;
          case "emailed":
            if (!canResend(r)) return false;
            break;
          case "failed":
            if (!isSendFailed(r)) return false;
            break;
          case "unsent":
            if (r.channel !== "email" || r.status !== "pending" || r.error) return false;
            break;
          case "to-mail":
            if (!canMarkMailed(r)) return false;
            break;
          case "mailed":
            if (r.channel !== "mail" || r.status !== "sent") return false;
            break;
        }
        if (words.length) {
          const hay = deliveryWho(r).search.toLowerCase();
          if (!words.every((w) => hay.includes(w))) return false;
        }
        return true;
      });
    }

    function copiesSum(list) {
      return list.reduce((total, r) => total + (r.copies || 0), 0);
    }

    function renderStats() {
      const email = rows.filter((r) => r.channel === "email");
      const mail = rows.filter((r) => r.channel === "mail");
      const toMail = mail.filter(canMarkMailed);
      const mailed = mail.filter((r) => r.status === "sent");
      const failed = rows.filter(isSendFailed).length;
      qs("#stat-row", container).innerHTML = `
        ${email.length ? `<div class="stat-card"><div class="num">${email.filter(canResend).length.toLocaleString()} <span class="of">/ ${email.length.toLocaleString()}</span></div><div class="label">Emailed</div></div>` : ""}
        ${failed ? `<div class="stat-card stat-card-failed"><div class="num">${failed.toLocaleString()}</div><div class="label">Send failed</div></div>` : ""}
        ${toMail.length ? `<div class="stat-card"><div class="num">${toMail.length.toLocaleString()}</div><div class="label">To mail · ${plural(copiesSum(toMail), "copy", "copies")}</div></div>` : ""}
        ${mailed.length ? `<div class="stat-card"><div class="num">${mailed.length.toLocaleString()}</div><div class="label">Mailed · ${plural(copiesSum(mailed), "copy", "copies")}</div></div>` : ""}
      `;
    }

    function detailRow(label, value) {
      if (value === undefined || value === null || value === "") return "";
      return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
    }

    function detailHtml(r) {
      const c = r.contact;
      const h = r.household;
      return `
        <div class="row" style="align-items:flex-start;gap:40px;padding:12px 4px">
          <div>
            <h2 style="margin-top:0">This mailing</h2>
            <table class="detail-table">
              ${detailRow("Mailing", r.mailingName)}
              ${detailRow("Sent by", r.channel === "mail" ? "Mail" : "Email")}
              ${isSendFailed(r) ? detailRow("Send error", r.error) : ""}
              ${detailRow(r.channel === "mail" ? "Mailed" : "Emailed", formatDate(r.sentAt))}
              ${detailRow("Last resent", formatDate(r.resentAt))}
              ${r.channel === "mail" ? detailRow(r.status === "sent" ? "Copies mailed" : "Copies to mail", r.copies) : ""}
            </table>
            <div class="row" style="margin-top:12px;gap:8px">
              ${r.channel === "mail" && r.status === "sent" ? `<button class="btn secondary" data-unmark="${r.id}" type="button">Undo mailed</button>` : ""}
              ${r.status === "pending" ? `<button class="btn secondary" data-remove="${r.id}" type="button">Take off this mailing</button>` : ""}
            </div>
          </div>
          <div>
            <h2 style="margin-top:0">${r.org ? "Organization" : r.channel === "mail" ? "Address" : "Contact"}</h2>
            ${
              r.org
                ? `<table class="detail-table">
                    ${detailRow("Organization", r.org.name)}
                    ${detailRow("Attention", r.org.attn)}
                    ${detailRow(r.channel === "mail" ? "Address" : "Email", r.channel === "mail" ? contactAddress(r.org) : r.org.email)}
                    ${detailRow("Members", r.org.memberCount ? plural(r.org.memberCount, "person", "people") : "")}
                  </table>
                  ${r.orgDeleted ? `<p class="hint">Since removed from the mailing list — this is how it was listed when it was.</p>` : ""}`
                : r.channel === "mail"
                ? h
                  ? `<table class="detail-table">
                      ${detailRow("Address", contactAddress(h))}
                      ${detailRow("Who lives there", (h.members || []).map((m) => m.name || m.orgName).join(", "))}
                      ${detailRow("Label name", h.addressee)}
                    </table>
                    ${r.householdDeleted ? `<p class="hint">Since removed from the mailing list — this is how it was listed when it was.</p>` : ""}`
                  : `<p class="hint">This address has been removed from the mailing list.</p>`
                : c
                ? `<table class="detail-table">
                    ${detailRow("Name", c.name)}
                    ${detailRow("Organization", r.orgName)}
                    ${detailRow("Email", c.email)}
                    ${detailRow("Source", c.sourceBatch)}
                  </table>
                  ${r.contactDeleted ? `<p class="hint">Since deleted from the mailing list — this is how they were listed when it was.</p>` : ""}`
                : `<p class="hint">This contact has been deleted from the mailing list.</p>`
            }
          </div>
        </div>
      `;
    }

    function whenHtml(r) {
      if (r.status !== "sent") return "";
      return `${escapeHtml(formatDate(r.sentAt))}${r.resentAt ? `<br/><span class="hint">resent ${escapeHtml(formatDate(r.resentAt))}</span>` : ""}`;
    }

    function renderTable() {
      const list = filteredRows();
      const body = qs("#delivery-rows", container);
      const empty = qs("#delivery-empty", container);
      empty.style.display = list.length ? "none" : "block";
      empty.textContent = mailings.length ? "No one matches these filters." : 'No mailings yet — create one from "New Mailing".';
      body.innerHTML = list
        .map((r) => {
          const who = deliveryWho(r);
          return `
        <tr class="delivery-row" data-row="${r.id}">
          <td>${escapeHtml(who.name)}${who.org ? `<br/><span class="hint">${escapeHtml(who.org)}</span>` : ""}</td>
          <td><span class="badge ${r.channel === "email" ? "badge-email" : "badge-paper"}">${r.channel === "email" ? "Email" : "Mail"}</span>
            ${mailingFilter ? "" : `<br/><span class="hint">${escapeHtml(r.mailingName)}</span>`}</td>
          <td>${escapeHtml(who.reach)}</td>
          <td class="num">${r.channel === "mail" ? escapeHtml(r.copies) : ""}</td>
          <td>${whenHtml(r)}</td>
          <td>${deliveryBadge(r)}${isSendFailed(r) ? `<br/><span class="hint send-error" title="${escapeHtml(r.error)}">${escapeHtml(r.error)}</span>` : ""}</td>
          <td class="actions-cell">
            ${isSendFailed(r) ? `<button class="btn" data-retry="${r.id}" type="button">Fix &amp; resend…</button>` : ""}
            ${canResend(r) ? `<button class="btn secondary" data-resend="${r.id}" type="button">Resend</button>` : ""}
            ${canMarkMailed(r) ? `<button class="btn secondary" data-mailed="${r.id}" type="button">Mark mailed</button>` : ""}
          </td>
        </tr>
        <tr class="retry-form-row" id="retry-form-${r.id}" style="display:none"><td colspan="7"></td></tr>
        <tr class="delivery-detail-row" id="detail-${r.id}" style="display:${expandedId === r.id ? "table-row" : "none"}">
          <td colspan="7">${expandedId === r.id ? detailHtml(r) : ""}</td>
        </tr>`;
        })
        .join("");

      qsa("[data-retry]", body).forEach((btn) => btn.addEventListener("click", () => openRetryForm(btn.dataset.retry)));
      qsa("[data-resend]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const r = rows.find((row) => row.id === btn.dataset.resend);
          const who = deliveryWho(r).name;
          if (!(await confirmAction(`Email "${r.mailingName}" to ${who} again at ${deliveryWho(r).reach || "their address"}?`, "Resend"))) return;
          btn.disabled = true;
          btn.textContent = "Sending…";
          const { sent, errors } = await window.api.resend([r.id]).catch((err) => ({ sent: 0, errors: [{ error: err.message }] }));
          if (sent) toast(`Resent to ${who}.`);
          else toast(`Resend failed: ${errors[0]?.error || `${who} can't be resent to.`}`, true);
          await reload();
        })
      );
      qsa("[data-mailed]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          await window.api.markMailed([btn.dataset.mailed]);
          toast("Marked as mailed.");
          await reload();
        })
      );
      qsa("[data-unmark]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          await window.api.unmarkMailed(btn.dataset.unmark);
          toast("No longer marked as mailed.");
          await reload();
        })
      );
      qsa("[data-remove]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const r = rows.find((row) => row.id === btn.dataset.remove);
          const who = deliveryWho(r).name;
          const how = r.channel === "mail" ? "mail" : "email";
          if (!(await confirmAction(`Take ${who} off the ${how} side of "${r.mailingName}"? They stay on the mailing list.`, "Take off"))) return;
          await window.api.removeRecipient(r.id);
          if (expandedId === r.id) expandedId = null;
          toast(`${who} won't get "${r.mailingName}" by ${how}.`);
          await reload();
        })
      );
      qsa(".delivery-row", body).forEach((row) => {
        row.addEventListener("click", (e) => {
          if (e.target.closest("button, a, input")) return;
          expandedId = expandedId === row.dataset.row ? null : row.dataset.row;
          renderTable();
        });
      });

      // Acts on exactly the rows shown, so filtering to "To mail" (or
      // searching for one church's reps) and clicking this marks that set.
      const batchBtn = qs("#mark-batch-btn", container);
      const markable = list.filter(canMarkMailed);
      batchBtn.style.display = markable.length ? "" : "none";
      batchBtn.textContent = `Mark ${plural(markable.length, "shown address", "shown addresses")} mailed`;
    }

    function openRetryForm(recipientId) {
      const r = rows.find((row) => row.id === recipientId);
      const row = qs(`#retry-form-${recipientId}`, container);
      const cell = qs("td", row);
      row.style.display = "table-row";
      cell.innerHTML = `
        <div class="row" style="padding:8px 0">
          <div class="field" style="flex:1">
            <label>Email address</label>
            <input type="text" class="retry-email" value="${escapeHtml(deliveryWho(r).reach)}" />
          </div>
          <button class="btn retry-save" type="button" style="align-self:flex-end;margin-bottom:12px">Save &amp; resend</button>
          <button class="btn secondary retry-cancel" type="button" style="align-self:flex-end;margin-bottom:12px">Cancel</button>
        </div>
        <p class="hint" style="margin-top:0">The corrected address is saved on the mailing list. Leave it blank to mail a copy to their address instead.</p>
      `;
      qs(".retry-cancel", cell).addEventListener("click", () => {
        row.style.display = "none";
      });
      qs(".retry-save", cell).addEventListener("click", async () => {
        const btn = qs(".retry-save", cell);
        btn.disabled = true;
        btn.textContent = "Sending…";
        try {
          const { outcome } = await window.api.retrySend(recipientId, qs(".retry-email", cell).value);
          toast(
            outcome === "sent"
              ? "Email sent."
              : outcome === "mail"
              ? "Switched to mail — their address is now on this mailing's addresses to mail."
              : "Taken off the email side — their address is already getting this one by mail."
          );
        } catch (err) {
          toast(`Still failing: ${err.message}`, true);
        }
        await reload();
      });
      qs(".retry-email", cell).focus();
    }

    function renderAll() {
      renderStats();
      renderTable();
    }

    qs("#mailing-filter", container).addEventListener("change", async (e) => {
      mailingFilter = e.target.value;
      expandedId = null;
      await reload();
    });
    qs("#status-filter", container).addEventListener("change", (e) => {
      statusFilter = e.target.value;
      renderTable();
    });
    qs("#search-box", container).addEventListener("input", (e) => {
      searchTerm = e.target.value.toLowerCase();
      renderTable();
    });
    qs("#mark-batch-btn", container).addEventListener("click", async () => {
      const ids = filteredRows().filter(canMarkMailed).map((r) => r.id);
      if (!ids.length) return;
      if (!(await confirmAction(`Mark ${plural(ids.length, "address", "addresses")} as mailed today?`, "Mark mailed"))) return;
      const { updated } = await window.api.markMailed(ids);
      toast(`Marked ${plural(updated, "address", "addresses")} as mailed.`);
      await reload();
    });
    // Exports cover exactly the rows currently shown (all filters + search).
    async function exportShown(exportFn, onlyMail) {
      const shown = filteredRows().filter((r) => !onlyMail || r.channel === "mail");
      if (!shown.length) {
        toast(onlyMail ? "No one shown is getting this by mail." : "No one matches these filters.", true);
        return;
      }
      try {
        const savedPath = await exportFn(shown.map((r) => r.id));
        if (savedPath) toast(`Exported ${plural(shown.length, "row")} to ${savedPath}`);
      } catch (err) {
        toast(`Export failed: ${err.message}`, true);
      }
    }
    qs("#export-btn", container).addEventListener("click", () => exportShown(window.api.exportDelivery));
    qs("#export-addresses-btn", container).addEventListener("click", () => exportShown(window.api.exportAddresses, true));

    await reload();
  },
};
