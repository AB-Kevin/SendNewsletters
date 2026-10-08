"use strict";

window.Pages.mailings = {
  async render(container) {
    const mailings = await window.api.listMailings();

    container.innerHTML = `
      <h1>Mailings</h1>
      <p class="subtitle">Send a mailing's emails, and get the addresses for the copies going out by mail. Use <strong>Test</strong> first to see exactly what the email will look like.</p>
      <div class="panel">
        <table>
          <thead><tr><th>Mailing</th><th>By email</th><th>By mail</th><th></th></tr></thead>
          <tbody id="mailing-rows"></tbody>
        </table>
        <div id="mailing-empty" class="empty" style="display:none">No mailings yet — create one from "New Mailing".</div>
      </div>
    `;

    function emailCellHtml(m) {
      const s = m.stats;
      if (!s.emailTotal) return `<span class="hint">—</span>`;
      const failed = s.emailFailed
        ? ` <span class="badge badge-failed badge-link" data-failed="${m.id}" title="Show on the Delivery page">${s.emailFailed} failed</span>`
        : "";
      if (m.status !== "sent") return `${plural(s.emailTotal, "person", "people")}<br/><span class="hint">not sent yet</span>`;
      return `${s.emailSent.toLocaleString()} of ${s.emailTotal.toLocaleString()} sent${failed}`;
    }

    function mailCellHtml(m) {
      const s = m.stats;
      if (!s.mailTotal) return `<span class="hint">—</span>`;
      const progress =
        s.mailMailed === s.mailTotal
          ? `<span class="badge badge-sent">All mailed</span>`
          : s.mailMailed
          ? `<span class="hint">${s.mailMailed.toLocaleString()} of ${s.mailTotal.toLocaleString()} mailed</span>`
          : `<span class="hint">not mailed yet</span>`;
      const orgs = s.mailOrgs ? ` (${plural(s.mailOrgs, "organization batch", "organization batches")})` : "";
      return `${plural(s.mailTotal, "address", "addresses")}${orgs} · ${plural(s.copiesTotal, "copy", "copies")}<br/>${progress}`;
    }

    function filtersHtml(mailing) {
      const rules = mailing.filterRules || [];
      const channels = [mailing.includeEmail && "email", mailing.includeMail && "mail"].filter(Boolean).join(" and ");
      if (rules.length === 0) {
        return `<p class="hint" style="margin:8px 4px">Went to everyone on the mailing list set up to get it by ${channels}.</p>`;
      }
      return `
        <div style="padding:8px 4px">
          <p class="hint" style="margin:0 0 6px">Went by ${channels} to contacts where:</p>
          <ul style="margin:0;padding-left:20px">
            ${rules
              .map(
                (r) =>
                  `<li>${escapeHtml(CONTACT_FIELD_LABELS[r.field] || r.field)} <strong>${escapeHtml(filterOpLabel(r.op))}</strong>${
                    filterRuleNeedsValue(r.op) ? ` "${escapeHtml(r.value || "")}"` : ""
                  }</li>`
              )
              .join("")}
          </ul>
        </div>
      `;
    }

    function renderRows() {
      const body = qs("#mailing-rows", container);
      qs("#mailing-empty", container).style.display = mailings.length ? "none" : "block";
      body.innerHTML = mailings
        .map((m) => {
          const s = m.stats;
          const canSend = m.status !== "sent" && s.emailTotal > 0;
          const blocked = sendBlockedReason();
          return `
        <tr>
          <td>
            <strong>${escapeHtml(m.name)}</strong><br/>
            <span class="hint">${escapeHtml(m.publicationName || "")} · created ${escapeHtml(formatDate(m.createdAt))}${m.templateName ? ` · ${escapeHtml(m.templateName)}` : ""}</span>
          </td>
          <td>${emailCellHtml(m)}</td>
          <td>${mailCellHtml(m)}</td>
          <td class="actions-cell">
            ${canSend ? `<button class="btn" data-send="${m.id}" type="button" ${blocked ? `disabled title="${escapeHtml(blocked)}"` : ""}>Send emails</button>` : ""}
            ${m.templateId ? `<button class="btn secondary" data-test="${m.id}" type="button">Test</button>` : ""}
            ${s.emailSent ? `<button class="btn secondary" data-resend="${m.id}" type="button" ${blocked ? `disabled title="${escapeHtml(blocked)}"` : ""}>Resend…</button>` : ""}
            ${s.mailTotal ? `<button class="btn secondary" data-addresses="${m.id}" type="button">Mailing addresses…</button>` : ""}
            <button class="btn secondary" data-view="${m.id}" type="button">Delivery</button>
            <button class="btn secondary" data-filters="${m.id}" type="button">Who</button>
            ${s.anySent ? "" : `<button class="btn danger" data-delete="${m.id}" type="button">Delete</button>`}
          </td>
        </tr>
        <tr class="filters-row" id="filters-row-${m.id}" style="display:none"><td colspan="4"></td></tr>`;
        })
        .join("");

      qsa("[data-send]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const mailing = mailings.find((m) => m.id === btn.dataset.send);
          const count = plural(mailing.stats.emailTotal, "recipient");
          if (!(await confirmAction(`Email "${mailing.name}" to ${count} now?`, "Send"))) return;
          btn.disabled = true;
          btn.textContent = "Sending…";
          window.__busy = true;
          const stopProgress = window.api.onSendProgress((p) => {
            if (p.mailingId === mailing.id && document.body.contains(btn)) btn.textContent = `Sending ${Math.min(p.done + 1, p.total)} of ${p.total}…`;
          });
          try {
            const result = await window.api.sendMailing(mailing.id);
            toast(
              `Emailed ${plural(result.sent, "person", "people")}` +
                (result.errors.length ? `; ${result.errors.length} failed — click "failed" next to the mailing to fix them.` : ".")
            );
          } catch (err) {
            toast(`Send failed: ${err.message}`, true);
          }
          stopProgress();
          window.__busy = false;
          navigate("mailings");
        })
      );
      qsa("[data-resend]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const mailing = mailings.find((m) => m.id === btn.dataset.resend);
          const recipients = (await window.api.listDelivery(mailing.id)).filter((r) => r.channel === "email" && r.status === "sent");
          const message =
            `Email "${mailing.name}" again to all ${plural(recipients.length, "person", "people")} it was already emailed to?\n\n` +
            "They'll get the email template and PDF as they are now. To resend to just one person, use Resend on the Delivery page.";
          if (!(await confirmAction(message, "Resend"))) return;
          btn.disabled = true;
          btn.textContent = "Sending…";
          window.__busy = true;
          const stopProgress = window.api.onSendProgress((p) => {
            if (p.mailingId === mailing.id && document.body.contains(btn)) btn.textContent = `Sending ${Math.min(p.done + 1, p.total)} of ${p.total}…`;
          });
          try {
            const { sent, errors } = await window.api.resend(recipients.map((r) => r.id));
            toast(`Resent to ${plural(sent, "person", "people")}.`);
            if (errors.length) {
              const names = errors.map((e) => e.name);
              const shown = names.length > 5 ? `${names.slice(0, 5).join(", ")} and ${names.length - 5} more` : names.join(", ");
              toast(`Couldn't resend to ${errors.length}: ${shown} — ${errors[0].error}`, true);
            }
          } catch (err) {
            toast(`Resend failed: ${err.message}`, true);
          }
          stopProgress();
          window.__busy = false;
          navigate("mailings");
        })
      );
      qsa("[data-test]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "Sending…";
          try {
            const result = await window.api.sendTestMailing(btn.dataset.test);
            toast(`Test email sent to ${result.to}.`);
          } catch (err) {
            toast(`Test send failed: ${err.message}`, true);
          }
          btn.disabled = false;
          btn.textContent = "Test";
        })
      );
      qsa("[data-addresses]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          try {
            const savedPath = await window.api.exportMailingAddresses(btn.dataset.addresses);
            if (savedPath) toast(`Saved the mailing addresses to ${savedPath}`);
          } catch (err) {
            toast(`Export failed: ${err.message}`, true);
          }
        })
      );
      qsa("[data-failed]", body).forEach((badge) =>
        badge.addEventListener("click", () => {
          window.__deliveryView = { mailingId: badge.dataset.failed, statusFilter: "failed" };
          navigate("delivery");
        })
      );
      qsa("[data-view]", body).forEach((btn) =>
        btn.addEventListener("click", () => {
          window.__deliveryView = { mailingId: btn.dataset.view };
          navigate("delivery");
        })
      );
      qsa("[data-filters]", body).forEach((btn) =>
        btn.addEventListener("click", () => {
          const mailing = mailings.find((m) => m.id === btn.dataset.filters);
          const row = qs(`#filters-row-${mailing.id}`, container);
          const isOpen = row.style.display !== "none";
          row.style.display = isOpen ? "none" : "table-row";
          if (!isOpen) row.querySelector("td").innerHTML = filtersHtml(mailing);
        })
      );
      qsa("[data-delete]", body).forEach((btn) =>
        btn.addEventListener("click", async () => {
          const mailing = mailings.find((m) => m.id === btn.dataset.delete);
          if (!(await confirmAction(`Delete "${mailing?.name || "this mailing"}"? This can't be undone.`, "Delete"))) return;
          btn.disabled = true;
          try {
            await window.api.deleteMailing(btn.dataset.delete);
            toast("Mailing deleted.");
            navigate("mailings");
          } catch (err) {
            toast(`Delete failed: ${err.message}`, true);
            btn.disabled = false;
          }
        })
      );
    }

    renderRows();
  },
};
