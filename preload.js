const { contextBridge, ipcRenderer } = require("electron");

// Errors thrown in main.js arrive as "Error invoking remote method 'x':
// Error: <message>"; pages show the message itself.
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((err) => {
    throw new Error(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ""));
  });
}

contextBridge.exposeInMainWorld("api", {
  pickImportFile: () => invoke("dialog:pick-import-file"),
  // source: { kind: "file", filePath } or { kind: "signup", includeImported }
  previewImport: (source) => invoke("import:preview", source),
  planImport: (source, mapping, options) => invoke("import:plan", source, mapping, options),
  commitImport: (source, mapping, options) => invoke("import:commit", source, mapping, options),

  getList: () => invoke("list:get"),
  updateList: (changes) => invoke("list:update", changes),
  createContact: () => invoke("contacts:create"),
  createOrg: () => invoke("orgs:create"),
  deleteOrgs: (ids) => invoke("orgs:delete-many", ids),
  exportOrgs: (ids) => invoke("orgs:export", ids),
  mergeOrgs: (merge) => invoke("orgs:merge", merge),

  listPublications: () => invoke("publications:list"),
  addPublication: (name) => invoke("publications:add", name),
  renamePublication: (id, name) => invoke("publications:rename", id, name),
  removePublication: (id) => invoke("publications:remove", id),

  createHouseholdFor: (contactId) => invoke("households:create-for", contactId),
  combineHouseholds: (selection) => invoke("households:combine", selection),
  separateHouseholds: (contactIds) => invoke("households:separate", contactIds),
  deleteContacts: (ids) => invoke("contacts:delete-many", ids),
  exportContacts: (ids) => invoke("contacts:export", ids),

  reviewCounts: () => invoke("review:counts"),
  listReview: () => invoke("review:list"),
  dismissReview: (kind, ids) => invoke("review:dismiss", kind, ids),
  mergeContacts: (merge) => invoke("contacts:merge", merge),

  getGfSettings: () => invoke("gf:get-settings"),
  listGfForms: (connection) => invoke("gf:list-forms", connection),
  saveGfSettings: (data) => invoke("gf:save-settings", data),

  listTemplates: () => invoke("templates:list"),
  createTemplate: (data) => invoke("templates:create", data),
  updateTemplate: (id, patch) => invoke("templates:update", id, patch),
  deleteTemplate: (id) => invoke("templates:delete", id),
  pickPdfTemplate: () => invoke("templates:pick-pdf"),

  getSettings: () => invoke("settings:get"),
  saveSmtpSettings: (data) => invoke("settings:save-smtp", data),
  testSmtp: () => invoke("settings:test-smtp"),
  setTheme: (theme) => invoke("settings:set-theme", theme),

  listMailings: () => invoke("mailings:list"),
  previewMailing: (filterRules, options) => invoke("mailings:preview", filterRules, options),
  createMailing: (data) => invoke("mailings:create", data),
  deleteMailing: (id) => invoke("mailings:delete", id),
  sendMailing: (id) => invoke("mailings:send", id),
  sendTestMailing: (id) => invoke("mailings:send-test", id),
  exportMailingAddresses: (mailingId) => invoke("mailings:export-addresses", mailingId),
  onSendProgress: (callback) => {
    const listener = (event, progress) => callback(progress);
    ipcRenderer.on("mailings:progress", listener);
    return () => ipcRenderer.removeListener("mailings:progress", listener);
  },

  listDelivery: (mailingId) => invoke("delivery:list", mailingId),
  markMailed: (recipientIds) => invoke("delivery:mark-mailed", recipientIds),
  unmarkMailed: (recipientId) => invoke("delivery:unmark-mailed", recipientId),
  removeRecipient: (recipientId) => invoke("delivery:remove-recipient", recipientId),
  retrySend: (recipientId, email) => invoke("delivery:retry-send", recipientId, email),
  resend: (recipientIds) => invoke("delivery:resend", recipientIds),
  exportDelivery: (recipientIds) => invoke("delivery:export", recipientIds),
  exportAddresses: (recipientIds) => invoke("delivery:export-addresses", recipientIds),

  confirm: (message, okLabel) => invoke("dialog:confirm", message, okLabel),
  openPath: (filePath) => invoke("shell:open-path", filePath),
  getDataLocation: () => invoke("data:get-location"),
  chooseDataLocation: () => invoke("data:choose-location"),
  useDefaultDataLocation: () => invoke("data:use-default"),
  takeNotice: () => invoke("app:take-notice"),

  getTeamStatus: () => invoke("team:status"),
  saveTeamSettings: (data) => invoke("team:save", data),
  onTeamStatus: (callback) => {
    const listener = (event, status) => callback(status);
    ipcRenderer.on("team:status", listener);
    return () => ipcRenderer.removeListener("team:status", listener);
  },
  // Another computer's changes arrived (or, on the host, were saved).
  onDataChanged: (callback) => {
    const listener = (event, info) => callback(info);
    ipcRenderer.on("data:changed", listener);
    return () => ipcRenderer.removeListener("data:changed", listener);
  },
  getVersion: () => invoke("app:get-version"),

  checkForUpdates: () => invoke("update:check"),
  downloadUpdate: () => invoke("update:download"),
  quitAndInstall: () => invoke("update:install"),
  onUpdateStatus: (callback) => {
    const listener = (event, status) => callback(status);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
});
