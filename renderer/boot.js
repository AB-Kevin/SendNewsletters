"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  qsa(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.page));
  });

  const version = await window.api.getVersion();
  qs("#version-tag").textContent = `v${version}`;

  // Kept in a shared spot (not just local to the Settings page) so a check
  // already run before the user opens Settings shows its result immediately
  // instead of Settings always starting from a blank "Check for updates".
  window.__updateStatus = { state: "idle" };
  window.api.onUpdateStatus((status) => {
    window.__updateStatus = status;
  });
  window.api.checkForUpdates(); // not awaited -- a startup check shouldn't hold up opening the app

  window.api.onTeamStatus(renderTeamStatus);
  window.api.onDataChanged(onDataChanged);
  renderTeamStatus(await window.api.getTeamStatus());

  navigate("contacts");
  // After the data folder changes, the window reloads; say what happened.
  const notice = await window.api.takeNotice();
  if (notice) toast(notice);
});
