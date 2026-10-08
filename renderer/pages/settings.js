"use strict";

window.Pages.settings = {
  async render(container) {
    const settings = await window.api.getSettings();
    const gf = await window.api.getGfSettings();
    const location = await window.api.getDataLocation();
    const team = await window.api.getTeamStatus();
    const version = await window.api.getVersion();

    container.innerHTML = `
      <h1>Settings</h1>
      <p class="subtitle">Emails are sent through your own email account via SMTP. Signups come from a Gravity Forms form on the website.</p>

      <div class="panel">
        <h2 style="margin-top:0">SMTP</h2>
        <div class="row">
          <div class="field" style="flex:1">
            <label>SMTP host</label>
            <input type="text" id="smtp-host" value="${escapeHtml(settings.smtpHost)}" placeholder="smtp.gmail.com" />
          </div>
          <div class="field">
            <label>Port</label>
            <input type="number" id="smtp-port" value="${settings.smtpPort}" />
          </div>
          <div class="field">
            <label>Use TLS (465)</label>
            <select id="smtp-secure">
              <option value="false" ${!settings.smtpSecure ? "selected" : ""}>No (STARTTLS, usually 587)</option>
              <option value="true" ${settings.smtpSecure ? "selected" : ""}>Yes (465)</option>
            </select>
          </div>
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>SMTP username</label>
            <input type="text" id="smtp-user" value="${escapeHtml(settings.smtpUser)}" />
            <p class="hint">Leave blank for an unauthenticated relay (e.g. one your IT team allowlists by static IP instead of a login).</p>
          </div>
          <div class="field" style="flex:1">
            <label>SMTP password ${settings.hasSmtpPassword ? "(saved — leave blank to keep)" : ""}</label>
            <input type="password" id="smtp-password" placeholder="${settings.hasSmtpPassword ? "••••••••" : "app password"}" />
          </div>
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>From name</label>
            <input type="text" id="from-name" value="${escapeHtml(settings.fromName)}" />
          </div>
          <div class="field" style="flex:1">
            <label>From email${settings.smtpUser ? "" : " (required — no SMTP username to fall back on)"}</label>
            <input type="email" id="from-email" value="${escapeHtml(settings.fromEmail)}" placeholder="defaults to SMTP username" />
          </div>
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>Test email address</label>
            <input type="email" id="test-email" value="${escapeHtml(settings.testEmail)}" placeholder="you@example.com" />
            <p class="hint">Where the "Test" button on a mailing sends its sample email.</p>
          </div>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn" id="save-smtp-btn">Save</button>
          <button class="btn secondary" id="test-smtp-btn">Test connection</button>
        </div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Signup form (Gravity Forms)</h2>
        <p class="hint" style="margin-top:0">Lets the Import page bring in new signups. In WordPress, under Forms → Settings → REST API, turn the API on and
          add a key with read access; the site has to use https.</p>
        <div class="row">
          <div class="field" style="flex:1">
            <label for="gf-site">Website address</label>
            <input type="url" id="gf-site" value="${escapeHtml(gf.siteUrl)}" placeholder="https://www.example.org" />
          </div>
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label for="gf-key">Consumer key</label>
            <input type="text" id="gf-key" value="${escapeHtml(gf.consumerKey)}" />
          </div>
          <div class="field" style="flex:1">
            <label for="gf-secret">Consumer secret ${gf.hasSecret ? "(saved — leave blank to keep)" : ""}</label>
            <input type="password" id="gf-secret" placeholder="${gf.hasSecret ? "••••••••" : ""}" />
          </div>
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label for="gf-form">Signup form</label>
            <select id="gf-form">${
              gf.formId ? `<option value="${escapeHtml(gf.formId)}">${escapeHtml(gf.formTitle || `Form ${gf.formId}`)}</option>` : '<option value="">Connect to see the forms</option>'
            }</select>
          </div>
          <button class="btn secondary" id="gf-connect-btn" type="button" style="align-self:flex-end;margin-bottom:12px">Connect and list forms</button>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn" id="gf-save-btn" type="button">Save</button>
        </div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Data location</h2>
        <p class="hint" style="margin-top:0">The mailing list, newsletters, templates and their PDFs, and the record of every mailing are kept in this folder${
          location.isDefault ? " on this computer" : ""
        }:</p>
        <div class="row">
          <code>${escapeHtml(location.dataDir)}</code>
          <button class="btn secondary" id="open-data-dir-btn" type="button">Open folder</button>
          <button class="btn secondary" id="change-data-dir-btn" type="button">Change…</button>
          ${location.isDefault ? "" : `<button class="btn secondary" id="default-data-dir-btn" type="button">Use this computer's own folder</button>`}
        </div>
        <p class="hint">To share one list between computers, choose the same folder on each of them — on OneDrive, say. Each computer keeps its own email,
          signup form and appearance settings.</p>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Sharing</h2>
        <p class="hint" style="margin-top:0">Several computers can work on the list at once from one shared folder. One of them is the host: it saves everyone's changes
          to the shared list, and it's the one that sends mailings. Everyone else's changes go to it, and show up on the other computers within seconds of OneDrive syncing.
          The host's app has to be open for changes to be saved; until it is, they wait safely on the computer that made them.</p>
        <div class="row" style="align-items:flex-end">
          <div class="field" style="flex:1;max-width:320px">
            <label for="team-name">Your name</label>
            <input type="text" id="team-name" value="${escapeHtml(team?.name || "")}" />
            <p class="hint">Shown to others using the same folder.</p>
          </div>
          <label class="check-label" style="margin-bottom:28px"><input type="checkbox" id="team-host" ${team?.isHost ? "checked" : ""} /> This computer is the host</label>
          <button class="btn" id="team-save-btn" type="button" style="margin-bottom:22px">Save</button>
        </div>
        <p id="team-summary"></p>
        <ul class="people-list hint" id="team-people"></ul>
        <p class="hint">If two computers are set as host, the one that has been host longer keeps the job and the other waits; when that one's app closes, the waiting one
          takes over. Changes are put in order by each computer's clock, so keep Windows' automatic time setting on.</p>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Appearance</h2>
        <div class="field">
          <label>Theme</label>
          <select id="theme-select" style="align-self:flex-start">
            <option value="system" ${settings.theme === "system" ? "selected" : ""}>Match Windows</option>
            <option value="light" ${settings.theme === "light" ? "selected" : ""}>Light</option>
            <option value="dark" ${settings.theme === "dark" ? "selected" : ""}>Dark</option>
          </select>
          <p class="hint">Applies right away. Match Windows follows Windows' own light/dark setting.</p>
        </div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">Updates</h2>
        <p class="hint">You're running version ${escapeHtml(version)}.</p>
        <div id="update-action-area"></div>
      </div>
    `;

    qs("#save-smtp-btn", container).addEventListener("click", async () => {
      await window.api.saveSmtpSettings({
        smtpHost: qs("#smtp-host", container).value.trim(),
        smtpPort: Number(qs("#smtp-port", container).value) || 587,
        smtpSecure: qs("#smtp-secure", container).value === "true",
        smtpUser: qs("#smtp-user", container).value.trim(),
        smtpPassword: qs("#smtp-password", container).value,
        fromName: qs("#from-name", container).value.trim(),
        fromEmail: qs("#from-email", container).value.trim(),
        testEmail: qs("#test-email", container).value.trim(),
      });
      toast("SMTP settings saved.");
    });

    qs("#test-smtp-btn", container).addEventListener("click", async () => {
      const btn = qs("#test-smtp-btn", container);
      btn.disabled = true;
      btn.textContent = "Testing…";
      try {
        await window.api.testSmtp();
        toast("SMTP connection succeeded.");
      } catch (err) {
        toast(`SMTP test failed: ${err.message}`, true);
      }
      btn.disabled = false;
      btn.textContent = "Test connection";
    });

    function gfFields() {
      return {
        siteUrl: qs("#gf-site", container).value.trim(),
        consumerKey: qs("#gf-key", container).value.trim(),
        consumerSecret: qs("#gf-secret", container).value,
      };
    }
    qs("#gf-connect-btn", container).addEventListener("click", async () => {
      const btn = qs("#gf-connect-btn", container);
      btn.disabled = true;
      btn.textContent = "Connecting…";
      try {
        const forms = await window.api.listGfForms(gfFields());
        const select = qs("#gf-form", container);
        const current = select.value;
        select.innerHTML = forms.map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.title)}</option>`).join("") || '<option value="">No forms on this site</option>';
        if (forms.some((f) => f.id === current)) select.value = current;
        else {
          const signup = forms.find((f) => /sign\s*up|subscribe|newsletter/i.test(f.title));
          if (signup) select.value = signup.id;
        }
        toast(`Connected — ${plural(forms.length, "form")} found. Pick the signup form and save.`);
      } catch (err) {
        toast(`Couldn't connect: ${err.message}`, true);
      }
      btn.disabled = false;
      btn.textContent = "Connect and list forms";
    });
    qs("#gf-save-btn", container).addEventListener("click", async () => {
      const select = qs("#gf-form", container);
      try {
        await window.api.saveGfSettings({ ...gfFields(), formId: select.value, formTitle: select.selectedOptions[0]?.textContent || "" });
        toast("Signup form settings saved.");
      } catch (err) {
        toast(`Couldn't save: ${err.message}`, true);
      }
    });

    qs("#open-data-dir-btn", container).addEventListener("click", () => window.api.openPath(location.dataDir));
    // Changing it reloads the window on the new folder, so a toast after that
    // comes from boot.js.
    const moveData = async (fn) => {
      try {
        const result = await fn();
        if (!result.changed && result.message) toast(result.message);
      } catch (err) {
        toast(err.message, true);
      }
    };
    qs("#change-data-dir-btn", container).addEventListener("click", () => moveData(window.api.chooseDataLocation));

    const teamSummary = qs("#team-summary", container);
    const onPage = () => document.body.contains(teamSummary);
    function renderTeam(status) {
      if (!status || !onPage()) return;
      const summary = {
        host: "This computer is the host.",
        "waiting-host": `This computer is set as the host, but ${status.host?.name ?? "another"}'s computer already is, so this computer's changes go through that one for now.`,
        editor: status.host ? `${status.host.name}'s computer is the host; changes made here are saved through it.` : "No host computer's app is open right now; changes made here wait on this computer until one is.",
      }[status.role];
      const unsaved = status.unsaved ? ` ${plural(status.unsaved, "change")} made here ${status.unsaved === 1 ? "is" : "are"} waiting to be saved.` : "";
      teamSummary.textContent = summary + unsaved;
      const others = status.people.filter((p) => !p.isMe);
      qs("#team-people", container).innerHTML = others.length
        ? others.map((p) => `<li>${escapeHtml(p.name)} — ${escapeHtml(p.computer || "")}${p.role === "host" ? " (host)" : ""}</li>`).join("")
        : "<li>Nobody else is using this folder right now.</li>";
    }
    renderTeam(team);
    const stopTeamStatus = window.api.onTeamStatus((status) => {
      if (!onPage()) stopTeamStatus();
      else renderTeam(status);
    });
    qs("#team-save-btn", container).addEventListener("click", async () => {
      try {
        const status = await window.api.saveTeamSettings({ name: qs("#team-name", container).value, isHost: qs("#team-host", container).checked });
        renderTeamStatus(status);
        renderTeam(status);
        toast("Sharing settings saved.");
      } catch (err) {
        toast(err.message, true);
      }
    });
    qs("#default-data-dir-btn", container)?.addEventListener("click", () => moveData(window.api.useDefaultDataLocation));

    qs("#theme-select", container).addEventListener("change", (e) =>
      window.api.setTheme(e.target.value).catch((err) => toast(`Couldn't change the theme: ${err.message}`, true))
    );

    // main.js owns autoUpdater and only reports status over "update:status" --
    // this just mirrors that status into the panel. window.__updateStatus
    // (set in boot.js) carries over whatever the most recent check found, so
    // opening Settings after the automatic startup check already shows its
    // result instead of starting blank every time.
    const actionArea = qs("#update-action-area", container);

    function renderUpdateAction(status) {
      let html;
      if (status.state === "checking") {
        html = `<span class="hint">Checking for updates…</span>`;
      } else if (status.state === "available") {
        html = `<button class="btn" id="update-download-btn" type="button">Download update ${escapeHtml(status.version)}</button>`;
      } else if (status.state === "downloading") {
        html = `<span class="hint">Downloading update… ${status.percent ?? 0}%</span>`;
      } else if (status.state === "downloaded") {
        html = `<button class="btn" id="update-restart-btn" type="button">Restart to install ${escapeHtml(status.version)}</button>`;
      } else if (status.state === "not-available") {
        html = `<span class="hint">You're up to date.</span> <button class="btn secondary" id="update-check-btn" type="button">Check again</button>`;
      } else if (status.state === "error") {
        html = `<span class="hint" style="color:var(--danger)">Update check failed: ${escapeHtml(status.message || "")}</span> <button class="btn secondary" id="update-check-btn" type="button">Try again</button>`;
      } else {
        html = `<button class="btn secondary" id="update-check-btn" type="button">Check for updates</button>`;
      }
      actionArea.innerHTML = html;
      qs("#update-check-btn", actionArea)?.addEventListener("click", () => window.api.checkForUpdates());
      qs("#update-download-btn", actionArea)?.addEventListener("click", () => window.api.downloadUpdate());
      qs("#update-restart-btn", actionArea)?.addEventListener("click", () => window.api.quitAndInstall());
    }

    renderUpdateAction(window.__updateStatus || { state: "idle" });
    const unsubscribeUpdateStatus = window.api.onUpdateStatus((status) => {
      // The page's own root DOM gets replaced wholesale on every navigate()
      // (there's no per-page unmount hook in this app), so once actionArea is
      // no longer attached, this render has been left behind -- stop reacting.
      if (!document.body.contains(actionArea)) {
        unsubscribeUpdateStatus();
        return;
      }
      renderUpdateAction(status);
    });
  },
};
