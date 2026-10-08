"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard, nativeTheme } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");

const store = require("./db/store");
const csvImport = require("./lib/csvImport");
const { filterContacts, listFilterableFields } = require("./lib/filter");
const { renderTemplate, buildResponseLink, htmlToPlainText } = require("./lib/merge");
const { stampToken } = require("./lib/pdfStamp");
const { generatePaperLetter } = require("./lib/paperMerge");
const mailer = require("./lib/mailer");
const gravityForms = require("./lib/gravityForms");
const entryView = require("./lib/entryView");
const { generateToken } = require("./lib/tokens");

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let mainWindow = null;

// ---- secret encryption (SMTP password, Gravity Forms consumer secret) ----
// Uses the OS keychain (DPAPI on Windows) via Electron's safeStorage, same
// idea as any other locally-stored credential; falls back to a plain base64
// encoding only if the OS facility is unavailable, so the app still works
// rather than hard-failing on an obscure environment.
function encryptSecret(plainText) {
  if (!plainText) return "";
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plainText).toString("base64");
  }
  return "plain:" + Buffer.from(plainText, "utf8").toString("base64");
}

function decryptSecret(stored) {
  if (!stored) return "";
  if (stored.startsWith("plain:")) {
    return Buffer.from(stored.slice("plain:".length), "base64").toString("utf8");
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return "";
  }
}

// ---- theme ----
// The Settings page's Appearance choice, applied as nativeTheme.themeSource:
// the renderer's prefers-color-scheme follows it (styles.css keys its dark
// palette off that), and so do the Windows title bar and native controls.
// "system" follows Windows' own light/dark setting, live.
const THEMES = ["system", "light", "dark"];

function savedTheme() {
  const theme = store.getSettings().theme;
  return THEMES.includes(theme) ? theme : "system";
}

// styles.css's --surface-page for each theme, painted before the page loads
// so a dark-mode window doesn't flash white on open.
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? "#1b1c1e" : "#ffffff";
}

nativeTheme.on("updated", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackground());
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: windowBackground(),
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// Lets a dev/test run point at a throwaway data directory instead of the
// real one (%APPDATA%\sendnewsletters by default) -- set SENDNEWSLETTERS_DATA_DIR
// before launching to avoid ever reading, seeding, or deleting a real
// installation's contacts/templates/mailings while exercising the app.
if (process.env.SENDNEWSLETTERS_DATA_DIR) {
  app.setPath("userData", process.env.SENDNEWSLETTERS_DATA_DIR);
}

app.whenReady().then(() => {
  store.init(app.getPath("userData"));
  nativeTheme.themeSource = savedTheme();
  createWindow();
  setInterval(() => {
    runSync()
      .then((summary) => mainWindow?.webContents.send("sync:completed", summary))
      .catch((err) => console.error("Background sync failed:", err));
  }, SYNC_INTERVAL_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

ipcMain.handle("dialog:pick-import-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select a mailing list",
    filters: [{ name: "Spreadsheets", extensions: ["csv", "tsv", "xlsx", "xls"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("import:preview", async (event, filePath) => {
  const { headers, rows } = csvImport.parseFile(filePath);
  return { headers, sampleRows: rows.slice(0, 20), totalRows: rows.length };
});

ipcMain.handle("import:commit", async (event, filePath, mapping, batchName) => {
  const { rows } = csvImport.parseFile(filePath);
  const contacts = csvImport.buildContacts(rows, mapping, batchName || path.basename(filePath));
  const { inserted, updated } = store.upsertMany("contacts", "externalId", contacts);
  return { count: contacts.length, inserted, updated };
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

ipcMain.handle("contacts:list", async () => store.list("contacts"));

ipcMain.handle("contacts:filterable-fields", async () => listFilterableFields(store.list("contacts")));

ipcMain.handle("contacts:preview-filter", async (event, rules) => {
  const contacts = store.list("contacts");
  const matched = filterContacts(contacts, rules);
  return {
    total: matched.length,
    withEmail: matched.filter((c) => c.email).length,
    withoutEmail: matched.filter((c) => !c.email).length,
    sample: matched.slice(0, 25),
  };
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

ipcMain.handle("templates:list", async () => store.list("templates"));

ipcMain.handle("templates:create", async (event, data) => store.insert("templates", data));

ipcMain.handle("templates:update", async (event, id, patch) => store.update("templates", id, patch));

ipcMain.handle("templates:delete", async (event, id) => store.remove("templates", id));

ipcMain.handle("templates:pick-pdf", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select the fillable PDF template",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const srcPath = result.filePaths[0];
  const destName = `${randomUUID()}.pdf`;
  const destPath = path.join(store.getDataDir(), "pdf-templates", destName);
  fs.copyFileSync(srcPath, destPath);
  return { storedPath: destPath, originalName: path.basename(srcPath) };
});

// ---------------------------------------------------------------------------
// Gravity Forms connections
// ---------------------------------------------------------------------------

ipcMain.handle("gf:list", async () =>
  store.list("gravityForms").map((gf) => ({ ...gf, consumerSecret: undefined, hasSecret: !!gf.consumerSecret }))
);

ipcMain.handle("gf:test-connection", async (event, siteUrl, consumerKey, consumerSecret) =>
  gravityForms.testConnection(siteUrl, consumerKey, consumerSecret)
);

ipcMain.handle("gf:create", async (event, data) => {
  const row = store.insert("gravityForms", { ...data, consumerSecret: encryptSecret(data.consumerSecret) });
  return { ...row, consumerSecret: undefined };
});

ipcMain.handle("gf:update", async (event, id, patch) => {
  const next = { ...patch };
  if (typeof next.consumerSecret === "string" && next.consumerSecret) {
    next.consumerSecret = encryptSecret(next.consumerSecret);
  } else {
    delete next.consumerSecret;
  }
  const row = store.update("gravityForms", id, next);
  return row && { ...row, consumerSecret: undefined };
});

ipcMain.handle("gf:delete", async (event, id) => store.remove("gravityForms", id));

// ---------------------------------------------------------------------------
// Settings (SMTP)
// ---------------------------------------------------------------------------

ipcMain.handle("settings:get", async () => {
  const settings = store.getSettings();
  return {
    smtpHost: settings.smtpHost || "",
    smtpPort: settings.smtpPort || 587,
    smtpSecure: !!settings.smtpSecure,
    smtpUser: settings.smtpUser || "",
    fromName: settings.fromName || "",
    fromEmail: settings.fromEmail || "",
    hasSmtpPassword: !!settings.smtpPassword,
    testEmail: settings.testEmail || "",
    theme: savedTheme(),
  };
});

// Applies right away, unlike the SMTP form's Save button.
ipcMain.handle("settings:set-theme", async (event, theme) => {
  if (!THEMES.includes(theme)) throw new Error("Unknown theme.");
  store.updateSettings({ theme });
  nativeTheme.themeSource = theme;
  return theme;
});

ipcMain.handle("settings:save-smtp", async (event, data) => {
  const patch = {
    smtpHost: data.smtpHost,
    smtpPort: data.smtpPort,
    smtpSecure: !!data.smtpSecure,
    smtpUser: data.smtpUser,
    fromName: data.fromName,
    fromEmail: data.fromEmail,
    testEmail: data.testEmail,
  };
  if (data.smtpPassword) patch.smtpPassword = encryptSecret(data.smtpPassword);
  store.updateSettings(patch);
  return true;
});

function resolveSmtpConfig() {
  const s = store.getSettings();
  return {
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    user: s.smtpUser,
    password: decryptSecret(s.smtpPassword),
    fromName: s.fromName,
    fromEmail: s.fromEmail,
  };
}

ipcMain.handle("settings:test-smtp", async () => {
  await mailer.verifyConnection(resolveSmtpConfig());
  return true;
});

// ---------------------------------------------------------------------------
// Mailings
// ---------------------------------------------------------------------------

ipcMain.handle("mailings:list", async () => store.list("mailings"));

ipcMain.handle("mailings:create", async (event, { name, templateId, paperTemplateId, gravityFormId, filterRules }) => {
  const contacts = filterContacts(store.list("contacts"), filterRules);
  const mailing = store.insert("mailings", {
    name,
    templateId,
    paperTemplateId,
    gravityFormId,
    filterRules,
    status: "draft",
  });
  const recipients = contacts.map((contact) => ({
    mailingId: mailing.id,
    contactId: contact.id,
    channel: contact.email ? "email" : "paper",
    responseToken: generateToken(),
    status: "pending",
    sentAt: null,
    generatedFilePath: null,
    error: null,
  }));
  store.insertMany("mailingRecipients", recipients);
  return mailing;
});

function hydrateRecipients(mailingId) {
  const recipients = store.list("mailingRecipients").filter((r) => r.mailingId === mailingId);
  const contacts = store.list("contacts");
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const responses = store.list("responses");
  return recipients.map((r) => {
    const responsesForRecipient = responses.filter((resp) => resp.mailingRecipientId === r.id);
    const latest = responsesForRecipient.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))[0];
    return {
      ...r,
      contact: contactById.get(r.contactId) || null,
      response: latest || null,
    };
  });
}

ipcMain.handle("mailings:get", async (event, id) => {
  const mailing = store.get("mailings", id);
  if (!mailing) return null;
  return { ...mailing, recipients: hydrateRecipients(id) };
});

ipcMain.handle("mailings:delete", async (event, id) => {
  const mailing = store.get("mailings", id);
  if (!mailing) return false;
  if (mailing.status === "sent") throw new Error("This mailing has already been sent and can't be deleted.");
  store.removeWhere("mailingRecipients", (r) => r.mailingId === id);
  store.remove("mailings", id);
  return true;
});

function loadSendContext(mailing) {
  return {
    emailTemplate: mailing.templateId ? store.get("templates", mailing.templateId) : null,
    paperTemplate: mailing.paperTemplateId ? store.get("templates", mailing.paperTemplateId) : null,
    gravityForm: mailing.gravityFormId ? store.get("gravityForms", mailing.gravityFormId) : null,
    smtpConfig: resolveSmtpConfig(),
  };
}

// Builds one recipient's email from the mailing's email template as it is
// now. The PDF is stamped fresh from the template's file on every call --
// nothing from an earlier send is kept or reused -- so a send, a test, and a
// resend all attach the same thing.
async function composeEmail(contact, token, { emailTemplate, gravityForm }) {
  if (!emailTemplate) throw new Error("No email template selected for this mailing.");
  const link = gravityForm ? buildResponseLink(gravityForm, token) : "";
  const extraContext = { form_link: link };
  const subject = renderTemplate(emailTemplate.subject, contact, extraContext);
  const bodyHtml = renderTemplate(emailTemplate.body, contact, extraContext);
  const attachments = [];
  if (emailTemplate.pdfPath) {
    const templateBytes = fs.readFileSync(emailTemplate.pdfPath);
    const stamped = await stampToken(templateBytes, token);
    attachments.push({ filename: `form-${token}.pdf`, content: Buffer.from(stamped) });
  }
  return { subject, html: bodyHtml, text: htmlToPlainText(bodyHtml), attachments };
}

// Emails one recipient, or generates their paper letter, and records the
// outcome on the recipient. Returns "sent" or "generated". A failure is saved
// as the recipient's `error` (the Tracking page shows it as "Send failed",
// with a way to fix the address and retry) and then rethrown.
async function deliverToRecipient(recipient, contact, context) {
  const { paperTemplate, gravityForm, smtpConfig } = context;
  try {
    if (recipient.channel === "email") {
      const message = await composeEmail(contact, recipient.responseToken, context);
      await mailer.sendMail(smtpConfig, { to: contact.email, ...message });
      store.update("mailingRecipients", recipient.id, { status: "sent", sentAt: new Date().toISOString(), error: null });
      return "sent";
    }
    if (!paperTemplate) throw new Error("No paper template selected for this mailing.");
    const link = gravityForm ? buildResponseLink(gravityForm, recipient.responseToken) : "";
    const body = renderTemplate(paperTemplate.body, contact, { form_link: link });
    const letterBytes = await generatePaperLetter(body, contact, recipient.responseToken);
    const destPath = path.join(store.getDataDir(), "generated-letters", `${recipient.responseToken}.pdf`);
    fs.writeFileSync(destPath, letterBytes);
    store.update("mailingRecipients", recipient.id, {
      status: "sent",
      sentAt: new Date().toISOString(),
      generatedFilePath: destPath,
      error: null,
    });
    return "generated";
  } catch (err) {
    store.update("mailingRecipients", recipient.id, { error: err.message });
    throw err;
  }
}

ipcMain.handle("mailings:send", async (event, mailingId) => {
  const mailing = store.get("mailings", mailingId);
  if (!mailing) throw new Error("Mailing not found.");
  const context = loadSendContext(mailing);

  const recipients = store.list("mailingRecipients").filter((r) => r.mailingId === mailingId && r.status === "pending");
  const contactById = new Map(store.list("contacts").map((c) => [c.id, c]));

  const results = { sent: 0, generated: 0, errors: [] };

  for (const recipient of recipients) {
    const contact = contactById.get(recipient.contactId);
    if (!contact) continue;
    try {
      const outcome = await deliverToRecipient(recipient, contact, context);
      results[outcome]++;
    } catch (err) {
      results.errors.push({ contactId: recipient.contactId, error: err.message });
    }
  }

  store.update("mailings", mailingId, { status: "sent" });
  return results;
});

// Sends one copy of a mailing's email template to the address configured in
// Settings, without touching any recipient or the mailing's status -- lets
// Kevin see exactly what a real send will look like before committing to it.
// Renders against a real recipient's data when the mailing has one (so merge
// fields show something realistic) but always delivers to the test address,
// never the recipient's own.
ipcMain.handle("mailings:send-test", async (event, mailingId) => {
  const mailing = store.get("mailings", mailingId);
  if (!mailing) throw new Error("Mailing not found.");
  const testEmail = store.getSettings().testEmail;
  if (!testEmail) throw new Error("Set a test email address in Settings first.");
  const emailTemplate = mailing.templateId ? store.get("templates", mailing.templateId) : null;
  if (!emailTemplate) throw new Error("This mailing has no email template selected.");
  const gravityForm = mailing.gravityFormId ? store.get("gravityForms", mailing.gravityFormId) : null;
  const smtpConfig = resolveSmtpConfig();

  const emailRecipients = store.list("mailingRecipients").filter((r) => r.mailingId === mailingId && r.channel === "email");
  const contactById = new Map(store.list("contacts").map((c) => [c.id, c]));
  const sampleRecipient = emailRecipients[0];
  const sampleContact = sampleRecipient ? contactById.get(sampleRecipient.contactId) : null;
  const contact = sampleContact || {
    externalId: "TEST-1",
    name: "Test Recipient",
    email: testEmail,
    addressLine1: "123 Sample St",
    addressLine2: "",
    city: "Sampleton",
    state: "ST",
    zip: "00000",
    extra: {},
  };
  const token = sampleRecipient ? sampleRecipient.responseToken : generateToken();

  const message = await composeEmail(contact, token, { emailTemplate, gravityForm });
  await mailer.sendMail(smtpConfig, { to: testEmail, ...message, subject: `[TEST] ${message.subject}` });
  return { to: testEmail };
});

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

ipcMain.handle("tracking:list", async (event, mailingId) => {
  const recipients = mailingId
    ? store.list("mailingRecipients").filter((r) => r.mailingId === mailingId)
    : store.list("mailingRecipients");
  const contacts = new Map(store.list("contacts").map((c) => [c.id, c]));
  const mailings = new Map(store.list("mailings").map((m) => [m.id, m]));
  const responses = store.list("responses");
  return recipients.map((r) => {
    const responsesForRecipient = responses.filter((resp) => resp.mailingRecipientId === r.id);
    const latest = responsesForRecipient.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))[0];
    return {
      ...r,
      contact: contacts.get(r.contactId) || null,
      mailingName: mailings.get(r.mailingId)?.name || "",
      response: latest || null,
      attachments: recipientAttachments(responsesForRecipient),
    };
  });
});

ipcMain.handle("tracking:pick-attachment", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select the returned form (PDF or scan)",
    filters: [
      { name: "PDF or scan", extensions: ["pdf", "jpg", "jpeg", "png", "tif", "tiff"] },
      { name: "All files", extensions: ["*"] },
    ],
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths;
});

// Copies files into the data folder, so a response keeps them even if the
// originals (say, in Downloads) are moved or deleted.
function storeAttachments(filePaths) {
  const addedAt = new Date().toISOString();
  return (filePaths || []).map((src) => {
    const dest = path.join(store.getDataDir(), "attachments", `${randomUUID()}${path.extname(src)}`);
    fs.copyFileSync(src, dest);
    return { path: dest, name: path.basename(src), addedAt };
  });
}

// A response's files. Ones recorded before a response could hold several
// have at most one, as `attachmentPath`, and no original file name.
function responseAttachments(resp) {
  if (resp.attachments) return resp.attachments;
  if (!resp.attachmentPath) return [];
  return [{ path: resp.attachmentPath, name: `Attached file${path.extname(resp.attachmentPath)}`, addedAt: resp.receivedAt }];
}

// Every file on any of a recipient's responses, oldest first -- a PDF
// emailed after a web submission is on a different response than the one
// whose answers are shown.
function recipientAttachments(responsesForRecipient) {
  return responsesForRecipient
    .flatMap((resp) => responseAttachments(resp).map((file) => ({ ...file, responseId: resp.id })))
    .sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));
}

ipcMain.handle("tracking:mark-received", async (event, recipientId, { channel, notes, attachmentPaths, recordedBy }) => {
  const recipient = store.get("mailingRecipients", recipientId);
  if (!recipient) throw new Error("Recipient not found.");

  const response = store.insert("responses", {
    mailingRecipientId: recipientId,
    channel,
    receivedAt: new Date().toISOString(),
    data: null,
    gfEntryId: null,
    attachments: storeAttachments(attachmentPaths),
    notes: notes || "",
    recordedBy: recordedBy || "",
  });
  store.update("mailingRecipients", recipientId, { status: "responded" });
  return response;
});

// Paper recipients go to "sent" as soon as their letter PDF is generated, but
// that doesn't mean it's actually in the mail yet -- mailedAt records when the
// physical copy went out. Takes an array so the tracking page can mark a whole
// filtered batch at once. Email and already-responded recipients are skipped.
// A still-pending recipient (e.g. mailed from the exported address list
// without generating letters) is moved to "sent" too, so a later send of the
// mailing doesn't treat it as still needing to go out.
ipcMain.handle("tracking:mark-mailed", async (event, recipientIds) => {
  const ids = new Set(recipientIds || []);
  const now = new Date().toISOString();
  const updated = store.updateWhere("mailingRecipients", (recipient) => {
    if (!ids.has(recipient.id)) return null;
    if (recipient.channel !== "paper" || recipient.status === "responded" || recipient.mailedAt) return null;
    const patch = { mailedAt: now };
    if (recipient.status === "pending") {
      patch.status = "sent";
      patch.sentAt = recipient.sentAt || now;
    }
    return patch;
  });
  return { updated };
});

// Records (or clears) when a response was entered into the office's own
// records software -- a manual step done after each response comes in.
// Only applies to recipients who have responded. Takes an array like
// tracking:mark-mailed.
ipcMain.handle("tracking:set-entered", async (event, recipientIds, entered) => {
  const ids = new Set(recipientIds || []);
  const now = new Date().toISOString();
  const updated = store.updateWhere("mailingRecipients", (recipient) => {
    if (!ids.has(recipient.id) || recipient.status !== "responded") return null;
    if (entered ? recipient.enteredAt : !recipient.enteredAt) return null;
    return { enteredAt: entered ? now : null };
  });
  return { updated };
});

// Undoes tracking:mark-mailed. A paper recipient with no generated letter can
// only have reached "sent" by being marked mailed, so it goes back to pending.
ipcMain.handle("tracking:unmark-mailed", async (event, recipientId) => {
  const recipient = store.get("mailingRecipients", recipientId);
  if (!recipient) throw new Error("Recipient not found.");
  const patch = { mailedAt: null };
  if (recipient.status === "sent" && !recipient.generatedFilePath) {
    patch.status = "pending";
    patch.sentAt = null;
  }
  return store.update("mailingRecipients", recipientId, patch);
});

// Drops one person from a mailing, along with any responses recorded for
// them. Stored attachment files are left on disk rather than deleted.
ipcMain.handle("tracking:remove-recipient", async (event, recipientId) => {
  const recipient = store.get("mailingRecipients", recipientId);
  if (!recipient) throw new Error("Recipient not found.");
  store.removeWhere("responses", (resp) => resp.mailingRecipientId === recipientId);
  store.remove("mailingRecipients", recipientId);
  return true;
});

// Retries one recipient whose send failed, after saving a corrected email
// address on their contact. A blank address switches them to a paper letter
// instead -- e.g. a contact imported with "N/A" in the email column.
ipcMain.handle("tracking:retry-send", async (event, recipientId, email) => {
  const recipient = store.get("mailingRecipients", recipientId);
  if (!recipient) throw new Error("Recipient not found.");
  if (recipient.status !== "pending") throw new Error("This recipient has already been sent.");
  const mailing = store.get("mailings", recipient.mailingId);
  const contact = store.get("contacts", recipient.contactId);
  if (!mailing || !contact) throw new Error("This recipient's mailing or contact no longer exists.");

  const cleaned = String(email || "").trim();
  const nextContact = cleaned === contact.email ? contact : store.update("contacts", contact.id, { email: cleaned });
  const channel = cleaned ? "email" : "paper";
  const nextRecipient = channel === recipient.channel ? recipient : store.update("mailingRecipients", recipient.id, { channel });
  const outcome = await deliverToRecipient(nextRecipient, nextContact, loadSendContext(mailing));
  return { outcome };
});

// Emails the form again to recipients who were already sent it but haven't
// responded -- it went to spam, say, or the first copy had a problem. Uses
// the mailing's email template and PDF as they are now, with the recipient's
// same response token, so their link and Ref code still match them. sentAt
// keeps the original send; resentAt records the latest resend. Takes an array
// like tracking:mark-mailed; paper, unsent, and responded recipients are
// skipped. A failure is only reported back, not saved -- the recipient was
// still sent the first time.
ipcMain.handle("tracking:resend", async (event, recipientIds) => {
  const ids = new Set(recipientIds || []);
  const recipients = store
    .list("mailingRecipients")
    .filter((r) => ids.has(r.id) && r.channel === "email" && r.status === "sent");
  const contactById = new Map(store.list("contacts").map((c) => [c.id, c]));
  const mailingById = new Map(store.list("mailings").map((m) => [m.id, m]));
  const contextByMailing = new Map();

  const results = { sent: 0, errors: [] };
  for (const recipient of recipients) {
    const contact = contactById.get(recipient.contactId);
    try {
      const mailing = mailingById.get(recipient.mailingId);
      if (!mailing || !contact) throw new Error("This recipient's mailing or contact no longer exists.");
      if (!contact.email) throw new Error("This contact no longer has an email address.");
      if (!contextByMailing.has(mailing.id)) contextByMailing.set(mailing.id, loadSendContext(mailing));
      const context = contextByMailing.get(mailing.id);
      const message = await composeEmail(contact, recipient.responseToken, context);
      await mailer.sendMail(context.smtpConfig, { to: contact.email, ...message });
      store.update("mailingRecipients", recipient.id, { resentAt: new Date().toISOString() });
      results.sent++;
    } catch (err) {
      results.errors.push({ recipientId: recipient.id, name: contact?.name || "", error: err.message });
    }
  }
  return results;
});

// Both exports take the recipient IDs currently shown on the Tracking page, so
// what's exported always matches the page's mailing/status/channel/search
// filters rather than re-deriving the filter here.
function recipientsByIds(recipientIds) {
  const ids = new Set(recipientIds || []);
  return store.list("mailingRecipients").filter((r) => ids.has(r.id));
}

ipcMain.handle("tracking:export", async (event, recipientIds, format) => {
  const recipients = recipientsByIds(recipientIds);
  const contacts = new Map(store.list("contacts").map((c) => [c.id, c]));
  const responses = store.list("responses");

  const rows = recipients.map((r) => {
    const contact = contacts.get(r.contactId) || {};
    const responsesForRecipient = responses.filter((resp) => resp.mailingRecipientId === r.id);
    const latest = responsesForRecipient.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))[0];
    return {
      Name: contact.name || "",
      Email: contact.email || "",
      Channel: r.channel,
      Status: r.status,
      "Sent At": r.sentAt || "",
      "Resent At": r.resentAt || "",
      "Mailed At": r.mailedAt || "",
      "Responded Via": latest ? latest.channel : "",
      "Responded At": latest ? latest.receivedAt : "",
      "Entered At": r.enteredAt || "",
      Token: r.responseToken,
    };
  });

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export tracking table",
    defaultPath: `sendnewsletters-export.${format}`,
    filters:
      format === "xlsx" ? [{ name: "Excel", extensions: ["xlsx"] }] : [{ name: "CSV", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) return null;

  if (format === "xlsx") {
    const XLSX = require("xlsx");
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Tracking");
    XLSX.writeFile(workbook, result.filePath);
  } else {
    const Papa = require("papaparse");
    fs.writeFileSync(result.filePath, Papa.unparse(rows), "utf8");
  }
  return result.filePath;
});

ipcMain.handle("tracking:export-paper-addresses", async (event, recipientIds) => {
  const recipients = recipientsByIds(recipientIds).filter((r) => r.channel === "paper");
  const contacts = new Map(store.list("contacts").map((c) => [c.id, c]));

  const rows = recipients.map((r) => {
    const contact = contacts.get(r.contactId);
    return {
      ID: contact?.externalId || "",
      "Contact ID": r.contactId || "",
      Name: contact?.name || "",
      "Address Line 1": contact?.addressLine1 || "",
      "Address Line 2": contact?.addressLine2 || "",
      City: contact?.city || "",
      State: contact?.state || "",
      Zip: contact?.zip || "",
    };
  });

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export paper mailing addresses",
    defaultPath: "sendnewsletters-paper-addresses.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) return null;

  const Papa = require("papaparse");
  fs.writeFileSync(result.filePath, Papa.unparse(rows), "utf8");
  return result.filePath;
});

// ---------------------------------------------------------------------------
// Gravity Forms sync
// ---------------------------------------------------------------------------

// The entry's page in the WordPress admin, for seeing it exactly as
// Gravity Forms shows it.
function gfEntryUrl(gf, entryId) {
  return `${gf.siteUrl.replace(/\/+$/, "")}/wp-admin/admin.php?page=gf_entries&view=entry&id=${encodeURIComponent(gf.formId)}&lid=${encodeURIComponent(entryId)}`;
}

function cacheFormFields(gravityFormId, form) {
  store.upsertMany("gfForms", "gravityFormId", [
    { gravityFormId, fields: entryView.trimFormFields(form), fetchedAt: new Date().toISOString() },
  ]);
}

function recordWebResponse(recipientId, { entry, entryId, submittedAt, matchedBy, memberIdEntered }) {
  store.insert("responses", {
    mailingRecipientId: recipientId,
    channel: "web",
    receivedAt: (submittedAt || new Date()).toISOString(),
    data: entry,
    gfEntryId: entryId,
    matchedBy,
    memberIdEntered: memberIdEntered || "",
    attachments: [],
    notes: "",
    recordedBy: matchedBy === "manual" ? "manual-review" : "gravity-forms-sync",
  });
  // Every submission is kept, including a second one from someone who
  // already responded (often a correction). If their response was already
  // entered into the records software, this one hasn't been -- so it goes
  // back in the "not yet entered" queue, remembering when the earlier one was.
  const recipient = store.get("mailingRecipients", recipientId);
  const patch = { status: "responded" };
  if (recipient?.enteredAt) {
    patch.enteredAt = null;
    patch.previousEnteredAt = recipient.enteredAt;
  }
  store.update("mailingRecipients", recipientId, patch);
}

async function syncGravityForms() {
  const summary = { matched: 0, needsReview: 0, errors: [] };
  const mailings = store.list("mailings");
  const contactById = new Map(store.list("contacts").map((c) => [c.id, c]));

  for (const gf of store.list("gravityForms")) {
    if (!gf.formId || (!gf.tokenFieldId && !gf.memberIdFieldId)) continue;
    const linkedMailings = new Map(mailings.filter((m) => m.gravityFormId === gf.id).map((m) => [m.id, m]));
    if (linkedMailings.size === 0) continue;
    const recipients = store.list("mailingRecipients").filter((r) => linkedMailings.has(r.mailingId));
    if (recipients.length === 0) continue;

    const config = { ...gf, consumerSecret: decryptSecret(gf.consumerSecret) };
    const since = new Date(Math.min(...[...linkedMailings.values()].map((m) => new Date(m.createdAt).getTime())));
    let entries;
    try {
      entries = await gravityForms.fetchEntries(config, since);
    } catch (err) {
      console.error(`Gravity Forms sync failed for "${gf.name}":`, err.message);
      summary.errors.push(`${gf.name}: ${err.message}`);
      continue;
    }
    // Used to show who an unmatched entry is from and, cached, to label
    // answers on the Responses page -- so failing to load it shouldn't stop
    // the sync.
    const form = await gravityForms.fetchForm(config).catch(() => null);
    if (form) cacheFormFields(gf.id, form);

    const recorded = new Set(store.list("responses").filter((r) => r.gfEntryId).map((r) => r.gfEntryId));
    const candidates = recipients.map((recipient) => ({
      recipient,
      memberId: contactById.get(recipient.contactId)?.externalId || "",
      mailingCreatedAt: linkedMailings.get(recipient.mailingId).createdAt,
    }));
    const { matches, unmatched } = gravityForms.matchEntries(
      entries.filter((e) => !recorded.has(String(e.id))),
      config,
      candidates
    );

    for (const match of matches) {
      recordWebResponse(match.recipient.id, match);
      summary.matched++;
    }

    // The review list for this form is rebuilt from whatever still doesn't
    // match, so entries resolved since the last sync drop off; each entry
    // keeps its id and dismissed flag from before.
    const previous = new Map(store.list("gfUnmatched").filter((u) => u.gravityFormId === gf.id).map((u) => [u.gfEntryId, u]));
    const reviewRows = unmatched.map(({ entry, entryId, submittedAt, memberIdEntered, suggestions }) => {
      const prior = previous.get(entryId);
      const who = form ? gravityForms.summarizeEntry(entry, form) : { name: prior?.name || "", email: prior?.email || "" };
      return {
        ...(prior && { id: prior.id, createdAt: prior.createdAt }),
        gravityFormId: gf.id,
        gfEntryId: entryId,
        submittedAt: submittedAt ? submittedAt.toISOString() : null,
        memberIdEntered,
        name: who.name,
        email: who.email,
        suggestedRecipientIds: suggestions.map((r) => r.id),
        dismissed: !!prior?.dismissed,
        entry,
      };
    });
    store.removeWhere("gfUnmatched", (u) => u.gravityFormId === gf.id);
    store.insertMany("gfUnmatched", reviewRows);
    summary.needsReview += reviewRows.filter((r) => !r.dismissed).length;
  }
  return summary;
}

// The 5-minute timer and the "Sync now" button can overlap; both would read
// the same already-recorded entries and record a new one twice.
let syncInFlight = null;
function runSync() {
  if (!syncInFlight) syncInFlight = syncGravityForms().finally(() => (syncInFlight = null));
  return syncInFlight;
}

ipcMain.handle("sync:run", async () => runSync());

function describeRecipient(recipient, contactById, mailingById) {
  const contact = contactById.get(recipient.contactId);
  return {
    recipientId: recipient.id,
    name: contact?.name || "",
    memberId: contact?.externalId || "",
    mailingName: mailingById.get(recipient.mailingId)?.name || "",
    responded: recipient.status === "responded",
  };
}

// Gravity Forms entries the sync couldn't match to anyone, for a person to
// match by hand. `choices` lists, per form, everyone in its mailings --
// including people who already responded, since a repeat submission with a
// mistyped ID is theirs too.
ipcMain.handle("gf:review-list", async () => {
  const connections = new Map(store.list("gravityForms").map((g) => [g.id, g]));
  const items = store.list("gfUnmatched").filter((u) => !u.dismissed && connections.has(u.gravityFormId));
  const mailings = store.list("mailings");
  const mailingById = new Map(mailings.map((m) => [m.id, m]));
  const contactById = new Map(store.list("contacts").map((c) => [c.id, c]));
  const recipients = store.list("mailingRecipients");
  const recipientById = new Map(recipients.map((r) => [r.id, r]));

  const choices = {};
  for (const gfId of new Set(items.map((u) => u.gravityFormId))) {
    choices[gfId] = recipients
      .filter((r) => mailingById.get(r.mailingId)?.gravityFormId === gfId)
      .map((r) => describeRecipient(r, contactById, mailingById))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    choices,
    items: items
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
      .map((u) => {
        const gf = connections.get(u.gravityFormId);
        return {
          id: u.id,
          gravityFormId: u.gravityFormId,
          formName: gf.name,
          memberIdFieldSet: !!gf.memberIdFieldId,
          entryUrl: gfEntryUrl(gf, u.gfEntryId),
          submittedAt: u.submittedAt,
          memberIdEntered: u.memberIdEntered,
          name: u.name,
          email: u.email,
          suggestions: (u.suggestedRecipientIds || [])
            .map((id) => recipientById.get(id))
            .filter(Boolean)
            .map((r) => describeRecipient(r, contactById, mailingById)),
        };
      }),
  };
});

ipcMain.handle("gf:review-assign", async (event, reviewId, recipientId) => {
  const item = store.get("gfUnmatched", reviewId);
  if (!item) throw new Error("This entry is no longer waiting for review -- try syncing again.");
  const recipient = store.get("mailingRecipients", recipientId);
  if (!recipient) throw new Error("Recipient not found.");
  recordWebResponse(recipient.id, {
    entry: item.entry,
    entryId: item.gfEntryId,
    submittedAt: item.submittedAt ? new Date(item.submittedAt) : null,
    matchedBy: "manual",
    memberIdEntered: item.memberIdEntered,
  });
  store.remove("gfUnmatched", item.id);
  return true;
});

ipcMain.handle("gf:review-dismiss", async (event, reviewId) => {
  if (!store.update("gfUnmatched", reviewId, { dismissed: true })) throw new Error("Entry not found.");
  return true;
});

// ---------------------------------------------------------------------------
// Responses (reading returned forms to enter them into the records software)
// ---------------------------------------------------------------------------

// The response shown for a recipient: their Gravity Forms submission if they
// have one, since that's the one with answers to read; otherwise the latest.
function pickResponse(responsesForRecipient) {
  const newestFirst = [...responsesForRecipient].sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
  return newestFirst.find((r) => r.data && r.gfEntryId) || newestFirst[0] || null;
}

// A form's field definitions, from the copy the sync caches -- or fetched
// now if this form hasn't been synced since that cache existed. null if
// neither works; the Responses page then labels answers by field ID.
async function loadFormFields(gf) {
  const cached = store.list("gfForms").find((f) => f.gravityFormId === gf.id);
  if (cached) return cached.fields;
  try {
    const form = await gravityForms.fetchForm({ ...gf, consumerSecret: decryptSecret(gf.consumerSecret) });
    cacheFormFields(gf.id, form);
    return entryView.trimFormFields(form);
  } catch (err) {
    console.error(`Couldn't load the form definition for "${gf.name}":`, err.message);
    return null;
  }
}

// Everyone who has responded, oldest response first -- the order to work
// through them in.
ipcMain.handle("responses:list", async () => {
  const contactById = new Map(store.list("contacts").map((c) => [c.id, c]));
  const mailingById = new Map(store.list("mailings").map((m) => [m.id, m]));
  const responsesByRecipient = new Map();
  for (const resp of store.list("responses")) {
    if (!responsesByRecipient.has(resp.mailingRecipientId)) responsesByRecipient.set(resp.mailingRecipientId, []);
    responsesByRecipient.get(resp.mailingRecipientId).push(resp);
  }
  return store
    .list("mailingRecipients")
    .filter((r) => r.status === "responded")
    .map((r) => {
      const response = pickResponse(responsesByRecipient.get(r.id) || []);
      const contact = contactById.get(r.contactId);
      return {
        recipientId: r.id,
        name: contact?.name || "",
        memberId: contact?.externalId || "",
        mailingId: r.mailingId,
        mailingName: mailingById.get(r.mailingId)?.name || "",
        channel: response?.channel || "",
        receivedAt: response?.receivedAt || null,
        enteredAt: r.enteredAt || null,
      };
    })
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
});

// One recipient's response, ready to read. Shows their latest Gravity Forms
// submission unless `responseId` picks another one of theirs.
ipcMain.handle("responses:get", async (event, recipientId, responseId) => {
  const recipient = store.get("mailingRecipients", recipientId);
  if (!recipient) throw new Error("Recipient not found.");
  const theirs = store.list("responses").filter((r) => r.mailingRecipientId === recipientId);
  const response = theirs.find((r) => r.id === responseId) || pickResponse(theirs);
  const submissions = theirs
    .filter((r) => r.data && r.gfEntryId)
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))
    .map((r) => ({ responseId: r.id, receivedAt: r.receivedAt }));
  const contact = store.get("contacts", recipient.contactId);
  const mailing = store.get("mailings", recipient.mailingId);
  const gf = mailing?.gravityFormId ? store.get("gravityForms", mailing.gravityFormId) : null;

  const entry = response?.data && response.gfEntryId ? response.data : null;
  const fields = entry && gf ? await loadFormFields(gf) : null;
  return {
    recipientId,
    name: contact?.name || "",
    memberId: contact?.externalId || "",
    mailingName: mailing?.name || "",
    formName: gf?.name || "",
    enteredAt: recipient.enteredAt || null,
    previousEnteredAt: recipient.previousEnteredAt || null,
    responseId: response?.id || null,
    submissions,
    channel: response?.channel || "",
    receivedAt: response?.receivedAt || null,
    matchedBy: response?.matchedBy || "",
    memberIdEntered: response?.memberIdEntered || "",
    notes: response?.notes || "",
    attachments: recipientAttachments(theirs),
    entryUrl: entry && gf ? gfEntryUrl(gf, response.gfEntryId) : null,
    hasEntry: !!entry,
    labelsMissing: !!entry && !fields,
    answers: entry ? entryView.describeEntry(entry, fields, { skipFieldIds: [gf?.tokenFieldId] }) : [],
  };
});

// Adds files to a response that's already recorded -- e.g. someone who
// submitted the web form and then emailed a PDF as well. Doesn't change
// whether the response counts as entered.
ipcMain.handle("responses:add-attachments", async (event, responseId, filePaths) => {
  const response = store.get("responses", responseId);
  if (!response) throw new Error("Response not found.");
  const added = storeAttachments(filePaths);
  store.update("responses", responseId, { attachments: [...responseAttachments(response), ...added], attachmentPath: null });
  return { added: added.length };
});

// Takes a file off a response. Like tracking:remove-recipient, the stored
// copy is left on disk.
ipcMain.handle("responses:remove-attachment", async (event, responseId, filePath) => {
  const response = store.get("responses", responseId);
  if (!response) throw new Error("Response not found.");
  const attachments = responseAttachments(response).filter((file) => file.path !== filePath);
  store.update("responses", responseId, { attachments, attachmentPath: null });
  return true;
});

ipcMain.handle("clipboard:write-text", async (event, text) => clipboard.writeText(String(text ?? "")));

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

// Used instead of window.confirm(): on Windows, Electron's renderer-side
// confirm()/alert() leaves the page unable to take mouse input on form
// controls afterwards (dropdowns won't open, inputs won't focus) until the
// window is blurred and refocused. A native message box owned by the main
// process doesn't have that problem.
ipcMain.handle("dialog:confirm", async (event, message, okLabel) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: [okLabel || "OK", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message,
  });
  if (mainWindow) mainWindow.webContents.focus();
  return response === 0;
});

ipcMain.handle("shell:open-path", async (event, filePath) => shell.openPath(filePath));
ipcMain.handle("shell:show-in-folder", async (event, filePath) => shell.showItemInFolder(filePath));
ipcMain.handle("shell:open-external", async (event, url) => {
  if (!/^https:\/\//i.test(url)) throw new Error("Only https:// links can be opened externally.");
  return shell.openExternal(url);
});
ipcMain.handle("app:get-data-dir", async () => store.getDataDir());
ipcMain.handle("app:get-version", async () => app.getVersion());

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------
// Driven entirely by the renderer's Settings page "Check for updates" button
// (and one automatic check at launch, see boot.js) -- never checks or
// downloads silently on its own beyond that, so nothing happens on the
// user's bandwidth/disk without a check having been triggered first.

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
// Lets "Check for updates" actually hit GitHub when running unpacked (npm
// start), reading dev-app-update.yml instead of silently no-op'ing. Has no
// effect on a packaged build -- those always use the real app-update.yml
// electron-builder generates, regardless of this flag.
autoUpdater.forceDevUpdateConfig = true;

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update:status", status);
  }
}

autoUpdater.on("checking-for-update", () => sendUpdateStatus({ state: "checking" }));
autoUpdater.on("update-available", (info) => sendUpdateStatus({ state: "available", version: info.version }));
autoUpdater.on("update-not-available", () => sendUpdateStatus({ state: "not-available" }));
autoUpdater.on("download-progress", (progress) =>
  sendUpdateStatus({ state: "downloading", percent: Math.round(progress.percent) })
);
autoUpdater.on("update-downloaded", (info) => sendUpdateStatus({ state: "downloaded", version: info.version }));
autoUpdater.on("error", (err) => sendUpdateStatus({ state: "error", message: err?.message || String(err) }));

ipcMain.handle("update:check", async () => {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    sendUpdateStatus({ state: "error", message: err?.message || String(err) });
  }
});

ipcMain.handle("update:download", async () => {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    sendUpdateStatus({ state: "error", message: err?.message || String(err) });
  }
});

ipcMain.handle("update:install", () => autoUpdater.quitAndInstall());
