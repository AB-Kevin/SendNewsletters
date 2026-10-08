"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeTheme } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");

const store = require("./db/store");
const listImport = require("./lib/listImport");
const rules = require("./lib/contactRules");
const matching = require("./lib/matching");
const { filterContacts } = require("./lib/filter");
const { renderTemplate, htmlToPlainText } = require("./lib/merge");
const mailer = require("./lib/mailer");
const duplicates = require("./lib/duplicates");
const gravityForms = require("./lib/gravityForms");

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
  seedPublications();
  nativeTheme.themeSource = savedTheme();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// People, households (addresses) and organizations, and the newsletters each
// gets -- see lib/contactRules.js.
const BLANK_ADDRESS = { addressLine1: "", addressLine2: "", city: "", state: "", zip: "" };
const BLANK_CONTACT = { name: "", email: "", orgId: null, householdId: null, subs: {}, sourceBatch: "" };
const BLANK_HOUSEHOLD = { ...BLANK_ADDRESS, subs: {} };
const BLANK_ORG = { name: "", attn: "", email: "", ...BLANK_ADDRESS, subs: {}, sourceBatch: "" };

const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// Keeps only what each kind of record actually has, in the types it's stored
// as, whatever the renderer sent. `subs` patches are { [publicationId]:
// { email, mail, copies } } for the fields that kind uses; a copy count
// that isn't a number is dropped rather than saved as 0.
const RECORD_FIELDS = {
  contact: { text: rules.PERSON_TEXT_FIELDS, subs: ["email"] },
  household: { text: rules.ADDRESS_FIELDS, subs: ["mail", "copies"] },
  org: { text: [...rules.ORG_TEXT_FIELDS, ...rules.ADDRESS_FIELDS], subs: ["email", "mail", "copies"] },
};

function sanitizePatch(kind, patch, publicationIds) {
  const { text, subs } = RECORD_FIELDS[kind];
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (text.includes(key)) clean[key] = cleanText(value);
    else if (key === "orgName" && kind === "contact") clean.orgName = cleanText(value);
    else if (key === "subs") {
      clean.subs = {};
      for (const [pubId, fields] of Object.entries(value || {})) {
        if (!publicationIds.has(pubId)) continue;
        const entry = {};
        for (const [field, fieldValue] of Object.entries(fields || {})) {
          if (!subs.includes(field)) continue;
          if (field === "copies") {
            const copies = rules.parseCopies(fieldValue);
            if (copies !== null) entry.copies = copies;
          } else entry[field] = !!fieldValue;
        }
        clean.subs[pubId] = entry;
      }
    }
  }
  return clean;
}

function mergeSubs(current, patch) {
  const next = { ...(current || {}) };
  for (const [pubId, fields] of Object.entries(patch || {})) next[pubId] = { ...(next[pubId] || {}), ...fields };
  return next;
}

function contactLabel(contact) {
  return contact?.name || "(no name)";
}

// Everything on the mailing list, with lookups both ways.
function loadList() {
  const contacts = store.list("contacts");
  const households = store.list("households");
  const orgs = store.list("orgs");
  const publications = store.list("publications");
  const groupBy = (key) => {
    const map = new Map();
    for (const c of contacts) {
      if (!c[key]) continue;
      if (!map.has(c[key])) map.set(c[key], []);
      map.get(c[key]).push(c);
    }
    return map;
  };
  return {
    contacts,
    households,
    orgs,
    publications,
    contactById: new Map(contacts.map((c) => [c.id, c])),
    householdById: new Map(households.map((h) => [h.id, h])),
    orgById: new Map(orgs.map((o) => [o.id, o])),
    membersOf: groupBy("householdId"),
    orgMembers: groupBy("orgId"),
  };
}

function formatAddress(place) {
  return [place?.addressLine1, place?.addressLine2, place?.city, [place?.state, place?.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

// A household with who lives there and who the label goes to.
function describeHousehold(household, members, list) {
  return {
    ...household,
    members: members.map((m) => ({ id: m.id, name: m.name, orgName: list.orgById.get(m.orgId)?.name || "" })),
    addressee: rules.addresseeOf(members.map((m) => ({ name: m.name, orgName: list.orgById.get(m.orgId)?.name || "" }))),
  };
}

function describeOrg(org, list) {
  return { ...org, memberCount: (list.orgMembers.get(org.id) || []).length };
}

// The organization with this name ("The Maple Grove Mennonite Church" is
// "Maple Grove Mennonite"), if there is one.
function findOrgByName(orgs, name) {
  const key = matching.orgKey(name);
  return orgs.find((o) => matching.orgKey(o.name) === key) || null;
}

// A recipient's person, household or organization -- or, once it's been
// deleted from the list, the copy saved on the recipient at the time, so a
// mailing's history still says who it went to.
function recipientContact(recipient, list) {
  return list.contactById.get(recipient.contactId) || recipient.contactSnapshot || null;
}

function recipientHousehold(recipient, list) {
  const household = list.householdById.get(recipient.householdId);
  if (household) return describeHousehold(household, list.membersOf.get(household.id) || [], list);
  return recipient.householdSnapshot || null;
}

function recipientOrg(recipient, list) {
  const org = list.orgById.get(recipient.orgId);
  return org ? describeOrg(org, list) : recipient.orgSnapshot || null;
}

// Where a mail recipient's bundle goes: their household, or their
// organization's address for a batch.
function recipientPlace(recipient, list) {
  return recipient.orgId ? recipientOrg(recipient, list) : recipientHousehold(recipient, list);
}

// How many copies a mail recipient gets: what was recorded when it was
// marked as mailed, or until then, the current number -- so fixing a count
// on the Mailing List still changes a mailing that hasn't gone out.
function recipientCopies(recipient, place, publicationId) {
  if (recipient.channel !== "mail") return null;
  if (recipient.status === "sent" && Number.isFinite(recipient.copies)) return recipient.copies;
  return rules.copiesFor(place, publicationId);
}

function sum(values) {
  return values.reduce((total, n) => total + (Number(n) || 0), 0);
}

// Takes households or organizations off mailings once they're removed from
// the list, or folds them into `replacementId` when combined. A mailing that
// hasn't reached one yet moves to the replacement, or drops it; one that has
// keeps a copy of who and where it was -- naming the people in `before`, the
// list as it was before they moved out, when that has already happened.
function retirePlaces(kind, ids, replacementId = null, before = loadList()) {
  if (!ids.size) return;
  const idField = kind === "org" ? "orgId" : "householdId";
  const snapshotField = kind === "org" ? "orgSnapshot" : "householdSnapshot";
  const snapshots = new Map();
  for (const id of ids) {
    if (kind === "org" && before.orgById.has(id)) snapshots.set(id, describeOrg(before.orgById.get(id), before));
    if (kind === "household" && before.householdById.has(id)) {
      snapshots.set(id, describeHousehold(before.householdById.get(id), before.membersOf.get(id) || [], before));
    }
  }
  store.mutate("mailingRecipients", (recipients) => {
    const replacementIn = new Set(recipients.filter((r) => replacementId && r[idField] === replacementId).map((r) => `${r.mailingId}|${r.channel}`));
    const next = [];
    for (const r of recipients) {
      if (!ids.has(r[idField])) next.push(r);
      else if (r.status !== "pending") next.push(r[snapshotField] ? r : { ...r, [snapshotField]: snapshots.get(r[idField]) });
      else if (replacementId && !replacementIn.has(`${r.mailingId}|${r.channel}`)) {
        replacementIn.add(`${r.mailingId}|${r.channel}`);
        next.push({ ...r, [idField]: replacementId });
      }
    }
    return next;
  });
  store.removeWhere(kind === "org" ? "orgs" : "households", (row) => ids.has(row.id));
}

// Households among `ids` that nobody lives in any more.
function emptyHouseholds(ids) {
  const occupied = new Set(store.list("contacts").map((c) => c.householdId));
  return new Set([...ids].filter((id) => id && !occupied.has(id)));
}

// One save dialog for every export: the file type picked in the dialog
// decides between Excel and CSV.
async function saveTable(columns, rows, { title, defaultName, sheetName }) {
  const result = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath: `${defaultName}.xlsx`,
    filters: [
      { name: "Excel workbook", extensions: ["xlsx"] },
      { name: "CSV", extensions: ["csv"] },
    ],
  });
  if (result.canceled || !result.filePath) return null;

  if (path.extname(result.filePath).toLowerCase() === ".csv") {
    const Papa = require("papaparse");
    // The byte-order mark makes Excel read accented names as UTF-8;
    // escapeFormulae keeps a name like "=Smith" from running as a formula.
    const csv = Papa.unparse({ fields: columns, data: rows.map((row) => columns.map((c) => row[c])) }, { escapeFormulae: true });
    fs.writeFileSync(result.filePath, "﻿" + csv, "utf8");
  } else {
    const XLSX = require("xlsx");
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: columns });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    XLSX.writeFile(workbook, result.filePath);
  }
  return result.filePath;
}

const yesNo = (value) => (value ? "Yes" : "No");

// ---------------------------------------------------------------------------
// Newsletters and magazines
// ---------------------------------------------------------------------------

// The two the office sends today, added the first time the app runs; after
// that the list is whatever's been added, renamed or removed.
function seedPublications() {
  if (store.getSettings().publicationsSeeded) return;
  if (!store.list("publications").length) store.insertMany("publications", [{ name: "MAAP Newsletter" }, { name: "Our Health" }]);
  store.updateSettings({ publicationsSeeded: true });
}

ipcMain.handle("publications:list", async () => store.list("publications"));

function checkPublicationName(name, exceptId) {
  const clean = cleanText(name);
  if (!clean) throw new Error("Give it a name.");
  if (store.list("publications").some((p) => p.id !== exceptId && p.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`There's already one called "${clean}".`);
  }
  return clean;
}

ipcMain.handle("publications:add", async (event, name) => store.insert("publications", { name: checkPublicationName(name) }));

ipcMain.handle("publications:rename", async (event, id, name) => store.update("publications", id, { name: checkPublicationName(name, id) }));

// Takes it off everyone; past mailings of it keep its name.
ipcMain.handle("publications:remove", async (event, id) => {
  const strip = (row) => (row.subs && id in row.subs ? { subs: Object.fromEntries(Object.entries(row.subs).filter(([key]) => key !== id)) } : null);
  for (const collection of ["contacts", "households", "orgs"]) store.updateWhere(collection, strip);
  store.remove("publications", id);
  return true;
});

// ---------------------------------------------------------------------------
// Gravity Forms signup form
// ---------------------------------------------------------------------------

function gfConnection(overrides = {}) {
  const s = store.getSettings();
  const connection = {
    siteUrl: s.gfSiteUrl || "",
    consumerKey: s.gfConsumerKey || "",
    consumerSecret: decryptSecret(s.gfConsumerSecret),
    formId: s.gfFormId || "",
  };
  for (const [key, value] of Object.entries(overrides)) if (value) connection[key] = value;
  return connection;
}

ipcMain.handle("gf:get-settings", async () => {
  const s = store.getSettings();
  return {
    siteUrl: s.gfSiteUrl || "",
    consumerKey: s.gfConsumerKey || "",
    hasSecret: !!s.gfConsumerSecret,
    formId: s.gfFormId || "",
    formTitle: s.gfFormTitle || "",
    lastImportedEntryId: s.gfLastImportedEntryId || 0,
  };
});

// A blank secret means "the one already saved", so testing a change to the
// site URL doesn't need the secret typed in again.
ipcMain.handle("gf:list-forms", async (event, { siteUrl, consumerKey, consumerSecret }) =>
  gravityForms.listForms(gfConnection({ siteUrl: cleanText(siteUrl), consumerKey: cleanText(consumerKey), consumerSecret }))
);

ipcMain.handle("gf:save-settings", async (event, { siteUrl, consumerKey, consumerSecret, formId, formTitle }) => {
  const current = store.getSettings();
  const patch = { gfSiteUrl: cleanText(siteUrl), gfConsumerKey: cleanText(consumerKey), gfFormId: String(formId || ""), gfFormTitle: formTitle || "" };
  if (consumerSecret) patch.gfConsumerSecret = encryptSecret(consumerSecret);
  // A different form numbers its entries separately.
  if (patch.gfFormId !== (current.gfFormId || "")) patch.gfLastImportedEntryId = 0;
  store.updateSettings(patch);
  return true;
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

// An import reads from a file ({ kind: "file", filePath }) or the signup
// form ({ kind: "signup", includeImported }). Either way it comes out as
// { headers, rows }, and everything after that is the same.
//
// The import page re-plans on every mapping change, so the last file read
// is kept until it changes on disk, and signups are fetched once, when the
// source is chosen, and kept for that import.
let parsedFileCache = null;
let signupCache = null;

function readImportSource(source) {
  if (source.kind === "signup") {
    if (!signupCache) throw new Error("Get the signups again -- the ones fetched earlier are no longer loaded.");
    return signupCache;
  }
  const { mtimeMs } = fs.statSync(source.filePath);
  if (parsedFileCache?.filePath !== source.filePath || parsedFileCache.mtimeMs !== mtimeMs) {
    parsedFileCache = { filePath: source.filePath, mtimeMs, parsed: listImport.parseFile(source.filePath) };
  }
  return parsedFileCache.parsed;
}

ipcMain.handle("import:preview", async (event, source) => {
  let label;
  if (source.kind === "signup") {
    const connection = gfConnection();
    if (!connection.siteUrl || !connection.formId) throw new Error("Set up the signup form in Settings first.");
    const afterId = source.includeImported ? 0 : store.getSettings().gfLastImportedEntryId || 0;
    const [form, entries] = await Promise.all([gravityForms.fetchForm(connection), gravityForms.fetchEntries(connection, afterId)]);
    signupCache = { ...gravityForms.entriesToTable(form, entries), maxEntryId: Math.max(0, ...entries.map((e) => Number(e.id) || 0)) };
    label = `Signup form ${new Date().toLocaleDateString()}`;
  } else {
    label = path.basename(source.filePath);
  }
  const { headers, rows } = readImportSource(source);
  const publications = store.list("publications");
  return {
    headers,
    totalRows: rows.length,
    samples: Object.fromEntries(headers.map((h) => [h, listImport.sampleValues(rows, h, 3)])),
    mapping: listImport.guessMapping(headers, rows, publications),
    targets: listImport.importTargets(publications),
    deliveryDefaults: listImport.DELIVERY_DEFAULTS,
    publications,
    defaultBatchName: label,
  };
});

function planImport(source, mapping, options) {
  const { rows } = readImportSource(source);
  const list = loadList();
  return listImport.planImport(rows, mapping, options, { contacts: list.contacts, households: list.households, orgs: list.orgs }, list.publications);
}

ipcMain.handle("import:plan", async (event, source, mapping, options) => {
  const { stats, matches, ambiguousNames, contactInserts, after } = planImport(source, mapping, options);
  // New contacts the duplicate checker would flag once they're in --
  // usually the same person under a nickname or with a different email.
  const newIds = new Set(contactInserts.map((c) => c.id));
  const { duplicates: groups } = duplicates.findDuplicates(after.contacts, after.households, after.orgs, dismissedPairs());
  const possibleDuplicates = groups.filter((g) => g.ids.some((id) => newIds.has(id))).length;
  return { stats, ambiguousNames, possibleDuplicates, matches: matches.filter((m) => m.changedFields.length).slice(0, 200) };
});

ipcMain.handle("import:commit", async (event, source, mapping, options) => {
  const plan = planImport(source, mapping, options);
  const before = loadList();
  const now = new Date().toISOString();
  const stamp = (rows, blank) => rows.map((row) => ({ ...blank, ...row, createdAt: now, updatedAt: now }));
  const patchAll = (collection, updates) => {
    const patches = new Map(updates.map((u) => [u.id, u.patch]));
    store.updateWhere(collection, (row) => (patches.has(row.id) ? { ...patches.get(row.id), updatedAt: now } : null));
  };
  store.insertMany("orgs", stamp(plan.orgInserts, BLANK_ORG));
  patchAll("orgs", plan.orgUpdates);
  store.insertMany("households", stamp(plan.householdInserts, BLANK_HOUSEHOLD));
  patchAll("households", plan.householdUpdates);
  patchAll("contacts", plan.contactUpdates);
  store.insertMany("contacts", stamp(plan.contactInserts, BLANK_CONTACT));
  retirePlaces("household", emptyHouseholds(plan.householdDeletes), null, before);
  if (source.kind === "signup" && signupCache?.maxEntryId) {
    store.updateSettings({ gfLastImportedEntryId: Math.max(store.getSettings().gfLastImportedEntryId || 0, signupCache.maxEntryId) });
  }
  return plan.stats;
});

// ---------------------------------------------------------------------------
// The Mailing List (people, households and organizations)
// ---------------------------------------------------------------------------

ipcMain.handle("list:get", async () => {
  const list = loadList();
  return { contacts: list.contacts, households: list.households, orgs: list.orgs, publications: list.publications };
});

ipcMain.handle("contacts:create", async () =>
  store.insert("contacts", { ...BLANK_CONTACT, sourceBatch: "Added by hand", updatedAt: new Date().toISOString() })
);

ipcMain.handle("orgs:create", async () => store.insert("orgs", { ...BLANK_ORG, sourceBatch: "Added by hand", updatedAt: new Date().toISOString() }));

// Gives someone with no address a household of their own, so an address or
// a mailed newsletter can be filled in for them.
ipcMain.handle("households:create-for", async (event, contactId) => {
  const contact = store.get("contacts", contactId);
  if (!contact) throw new Error("Contact not found.");
  if (contact.householdId && store.get("households", contact.householdId)) throw new Error("They already have an address.");
  const now = new Date().toISOString();
  const household = store.insert("households", { ...BLANK_HOUSEHOLD, updatedAt: now });
  return { household, contact: store.update("contacts", contactId, { householdId: household.id, updatedAt: now }) };
});

// Takes [{ kind: "contact" | "household" | "org", id, patch }] -- one cell
// edit, a paste across many cells, a bulk change, or an undo -- in one save
// per collection. A person's Organization comes as a name (`orgName`): it
// links them to the organization of that name, starting one if there isn't
// one yet, or unlinks them when blank. Returns the saved rows, so the page
// shows exactly what was stored.
ipcMain.handle("list:update", async (event, changes) => {
  const now = new Date().toISOString();
  const publicationIds = new Set(store.list("publications").map((p) => p.id));
  const byKind = { contact: new Map(), household: new Map(), org: new Map() };
  for (const change of changes || []) {
    const patches = byKind[change.kind];
    if (!patches) continue;
    const clean = sanitizePatch(change.kind, change.patch, publicationIds);
    const prior = patches.get(change.id) || {};
    patches.set(change.id, { ...prior, ...clean, ...(prior.subs || clean.subs ? { subs: mergeSubs(prior.subs, clean.subs) } : {}) });
  }

  const createdOrgs = [];
  if ([...byKind.contact.values()].some((p) => "orgName" in p)) {
    const orgs = store.list("orgs");
    for (const patch of byKind.contact.values()) {
      if (!("orgName" in patch)) continue;
      const name = patch.orgName;
      delete patch.orgName;
      let org = name ? findOrgByName(orgs, name) : null;
      if (name && !org) {
        org = store.insert("orgs", { ...BLANK_ORG, name, sourceBatch: "Added by hand", updatedAt: now });
        orgs.push(org);
        createdOrgs.push(org);
      }
      patch.orgId = org ? org.id : null;
    }
  }
  for (const [id, patch] of byKind.org) {
    if ("name" in patch && !patch.name) throw new Error("An organization needs a name.");
    const other = "name" in patch && findOrgByName(store.list("orgs").filter((o) => o.id !== id), patch.name);
    if (other) throw new Error(`There's already an organization called "${other.name}". To fold one into the other, use Merge on the Duplicates page.`);
  }

  const collections = { contact: "contacts", household: "households", org: "orgs" };
  const saved = {};
  for (const [kind, patches] of Object.entries(byKind)) {
    if (patches.size) {
      store.updateWhere(collections[kind], (row) => {
        const patch = patches.get(row.id);
        if (!patch || !Object.keys(patch).length) return null;
        return { ...patch, ...(patch.subs ? { subs: mergeSubs(row.subs, patch.subs) } : {}), updatedAt: now };
      });
    }
    saved[collections[kind]] = store.list(collections[kind]).filter((row) => patches.has(row.id));
  }
  saved.orgs.push(...createdOrgs);
  return saved;
});

// Anyone deleted drops out of emails that haven't gone to them yet; an
// address nobody lives at any more is removed the same way. Where a mailing
// already went, the recipient keeps a copy so its history still shows who.
ipcMain.handle("contacts:delete-many", async (event, ids) => {
  const idSet = new Set(ids || []);
  const deleted = new Map(store.list("contacts").filter((c) => idSet.has(c.id)).map((c) => [c.id, c]));
  store.removeWhere("mailingRecipients", (r) => deleted.has(r.contactId) && r.status === "pending");
  store.updateWhere("mailingRecipients", (r) => (deleted.has(r.contactId) && !r.contactSnapshot ? { contactSnapshot: deleted.get(r.contactId) } : null));
  const theirHouseholds = new Set([...deleted.values()].map((c) => c.householdId).filter(Boolean));
  const left = (householdId) => store.list("contacts").some((c) => c.householdId === householdId && !deleted.has(c.id));
  retirePlaces("household", new Set([...theirHouseholds].filter((h) => !left(h))));
  const removed = store.removeWhere("contacts", (c) => deleted.has(c.id));
  return { removed };
});

// Their members stay on the list, just no longer part of it.
ipcMain.handle("orgs:delete-many", async (event, ids) => {
  const idSet = new Set(ids || []);
  retirePlaces("org", idSet);
  store.updateWhere("contacts", (c) => (idSet.has(c.orgId) ? { orgId: null, updatedAt: new Date().toISOString() } : null));
  return { removed: idSet.size };
});

// Per newsletter: on if any of them had it, and the most copies any had.
function combineSubs(records) {
  const combined = {};
  for (const record of records) {
    for (const [pubId, s] of Object.entries(record.subs || {})) {
      const c = (combined[pubId] = combined[pubId] || {});
      if (s.email) c.email = true;
      if (s.mail) c.mail = true;
      if (s.copies !== undefined) c.copies = Math.max(Number(c.copies) || 0, Number(s.copies) || 0);
    }
  }
  return combined;
}

// Puts everyone in the given households (and any given people who have no
// address yet) into one household, so the address gets one bundle. The one
// kept is the one with the most people, then the most complete address; it
// gets each newsletter by mail if any of them did, with the most copies.
function combineHouseholds({ contactIds = [], householdIds = [] }) {
  const list = loadList();
  const people = contactIds.map((id) => list.contactById.get(id)).filter(Boolean);
  const ids = new Set([...householdIds, ...people.map((c) => c.householdId)].filter((id) => list.householdById.has(id)));
  if (!ids.size) throw new Error("None of them has an address to share.");
  const candidates = [...ids].map((id) => list.householdById.get(id));
  const completeness = (h) => rules.ADDRESS_FIELDS.filter((f) => h[f]).length;
  const keep = [...candidates].sort(
    (a, b) =>
      (list.membersOf.get(b.id)?.length || 0) - (list.membersOf.get(a.id)?.length || 0) ||
      completeness(b) - completeness(a) ||
      new Date(a.createdAt) - new Date(b.createdAt)
  )[0];
  const others = new Set([...ids].filter((id) => id !== keep.id));
  const now = new Date().toISOString();
  store.update("households", keep.id, { subs: combineSubs(candidates), updatedAt: now });
  retirePlaces("household", others, keep.id);
  const moving = new Set(people.filter((c) => !list.householdById.has(c.householdId)).map((c) => c.id));
  store.updateWhere("contacts", (c) => (others.has(c.householdId) || moving.has(c.id) ? { householdId: keep.id, updatedAt: now } : null));
  return keep.id;
}

ipcMain.handle("households:combine", async (event, selection) => {
  combineHouseholds(selection);
  return true;
});

// Gives each of these people a household of their own at a copy of the same
// address -- they were grouped by mistake, or one has a separate apartment
// to fill in. It gets the same newsletters by mail, one copy each.
// Remembered, so they aren't suggested as one household again.
ipcMain.handle("households:separate", async (event, contactIds) => {
  const list = loadList();
  const now = new Date().toISOString();
  let separated = 0;
  for (const id of contactIds || []) {
    const contact = list.contactById.get(id);
    const household = contact && list.householdById.get(contact.householdId);
    if (!household || (list.membersOf.get(household.id) || []).length < 2) continue;
    const subs = Object.fromEntries(Object.entries(household.subs || {}).filter(([, s]) => s.mail).map(([pubId]) => [pubId, { mail: true, copies: 1 }]));
    const own = store.insert("households", { ...BLANK_HOUSEHOLD, ...Object.fromEntries(rules.ADDRESS_FIELDS.map((f) => [f, household[f]])), subs, updatedAt: now });
    store.update("contacts", id, { householdId: own.id, updatedAt: now });
    list.membersOf.set(household.id, list.membersOf.get(household.id).filter((m) => m.id !== id));
    dismissPairs("household", [household.id, own.id]);
    separated++;
  }
  return { separated };
});

// Column headers the importer recognizes, so an exported list can be edited
// in Excel and imported straight back. One row per person, with their
// household's address and mailed newsletters on each.
function publicationColumns(publications, { email = true, mail = true } = {}) {
  return publications.flatMap((p) => [...(email ? [`${p.name}: Email`] : []), ...(mail ? [`${p.name}: Mail`, `${p.name}: Copies`] : [])]);
}

function publicationCells(publications, emailRecord, mailRecord) {
  const cells = {};
  for (const p of publications) {
    if (emailRecord) cells[`${p.name}: Email`] = yesNo(rules.sub(emailRecord, p.id).email);
    if (mailRecord !== undefined) {
      const s = rules.sub(mailRecord, p.id);
      cells[`${p.name}: Mail`] = yesNo(s.mail);
      cells[`${p.name}: Copies`] = s.mail ? rules.copiesFor(mailRecord, p.id) : "";
    }
  }
  return cells;
}

const ADDRESS_COLUMNS = { "Address 1": "addressLine1", "Address 2": "addressLine2", City: "city", State: "state", ZIP: "zip" };
const addressCells = (place) => Object.fromEntries(Object.entries(ADDRESS_COLUMNS).map(([column, field]) => [column, place?.[field] || ""]));

ipcMain.handle("contacts:export", async (event, ids) => {
  const idSet = new Set(ids || []);
  const list = loadList();
  const columns = ["Name", "Organization", ...publicationColumns(list.publications), "Email Address", ...Object.keys(ADDRESS_COLUMNS), "Source"];
  const rows = list.contacts
    .filter((c) => idSet.has(c.id))
    .map((c) => {
      const h = list.householdById.get(c.householdId) || null;
      return {
        Name: c.name,
        Organization: list.orgById.get(c.orgId)?.name || "",
        ...publicationCells(list.publications, c, h),
        "Email Address": c.email,
        ...addressCells(h),
        Source: c.sourceBatch,
      };
    });
  return saveTable(columns, rows, { title: "Export people", defaultName: "mailing-list-people", sheetName: "People" });
});

// For importing back with "Each row is an organization".
ipcMain.handle("orgs:export", async (event, ids) => {
  const idSet = new Set(ids || []);
  const list = loadList();
  const columns = ["Organization", "Attention", ...publicationColumns(list.publications), "Email Address", ...Object.keys(ADDRESS_COLUMNS), "Members", "Source"];
  const rows = list.orgs
    .filter((o) => idSet.has(o.id))
    .map((o) => ({
      Organization: o.name,
      Attention: o.attn,
      ...publicationCells(list.publications, o, o),
      "Email Address": o.email,
      ...addressCells(o),
      Members: (list.orgMembers.get(o.id) || []).length,
      Source: o.sourceBatch,
    }));
  return saveTable(columns, rows, { title: "Export organizations", defaultName: "mailing-list-organizations", sheetName: "Organizations" });
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

// Pairs marked "not duplicates" or "keep separate": { kind, key } rows.
function dismissedPairs() {
  return new Set(store.list("reviewDismissed").map((d) => d.key));
}

function dismissPairs(kind, ids) {
  const existing = dismissedPairs();
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const key = duplicates.pairKey(ids[i], ids[j]);
      if (!existing.has(key)) {
        existing.add(key);
        rows.push({ kind, key });
      }
    }
  }
  if (rows.length) store.insertMany("reviewDismissed", rows);
}

function currentReview() {
  const list = loadList();
  return { list, ...duplicates.findDuplicates(list.contacts, list.households, list.orgs, dismissedPairs()) };
}

ipcMain.handle("review:counts", async () => {
  const { duplicates: groups, sharedAddresses, orgDuplicates } = currentReview();
  return { duplicates: groups.length, sharedAddresses: sharedAddresses.length, orgDuplicates: orgDuplicates.length };
});

ipcMain.handle("review:list", async () => {
  const { list, duplicates: groups, sharedAddresses, orgDuplicates } = currentReview();
  const household = (id) => (list.householdById.has(id) ? describeHousehold(list.householdById.get(id), list.membersOf.get(id) || [], list) : null);
  const oldestFirst = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);
  return {
    publications: list.publications,
    duplicates: groups.map((g) => ({
      contacts: g.ids
        .map((id) => list.contactById.get(id))
        .sort(oldestFirst)
        .map((c) => ({ ...c, household: household(c.householdId), org: list.orgById.get(c.orgId) || null })),
      pairs: g.pairs,
    })),
    sharedAddresses: sharedAddresses.map((g) => ({ households: g.householdIds.map(household).filter(Boolean) })),
    orgDuplicates: orgDuplicates.map((g) => ({ orgs: g.ids.map((id) => describeOrg(list.orgById.get(id), list)).sort(oldestFirst), pairs: g.pairs })),
  };
});

ipcMain.handle("review:dismiss", async (event, kind, ids) => {
  dismissPairs(kind, ids || []);
  return true;
});

// Folds duplicate people into one. `values` are the name, email and
// organization picked on the Duplicates page; `householdId` is whose address
// to keep (or null for none). They keep every newsletter any of them got by
// email. Mailings that went to any of them now show the kept contact; one
// that hasn't gone out yet sends them one copy.
ipcMain.handle("contacts:merge", async (event, { keepId, removeIds, values, householdId }) => {
  const list = loadList();
  const keep = list.contactById.get(keepId);
  const removing = (removeIds || []).filter((id) => id !== keepId && list.contactById.has(id));
  if (!keep || !removing.length) throw new Error("Those contacts are no longer on the list.");
  const group = [keep, ...removing.map((id) => list.contactById.get(id))];
  if (householdId && !group.some((c) => c.householdId === householdId)) throw new Error("That address isn't one of theirs.");
  const orgId = values.orgId && group.some((c) => c.orgId === values.orgId) ? values.orgId : null;
  const removeSet = new Set(removing);
  const now = new Date().toISOString();

  store.mutate("mailingRecipients", (recipients) => {
    const keptIn = new Set(recipients.filter((r) => r.contactId === keepId).map((r) => `${r.mailingId}|${r.channel}`));
    const next = [];
    for (const r of recipients) {
      if (!removeSet.has(r.contactId)) next.push(r);
      else if (r.status === "pending" && keptIn.has(`${r.mailingId}|${r.channel}`)) continue; // they'll get the kept contact's copy
      else {
        keptIn.add(`${r.mailingId}|${r.channel}`);
        next.push({ ...r, contactId: keepId });
      }
    }
    return next;
  });
  const emailSubs = combineSubs(group.map((c) => ({ subs: Object.fromEntries(Object.entries(c.subs || {}).map(([id, s]) => [id, { email: !!s.email }])) })));
  store.update("contacts", keepId, {
    name: cleanText(values.name),
    email: cleanText(values.email),
    orgId,
    householdId: householdId || null,
    subs: emailSubs,
    updatedAt: now,
  });
  const householdsBefore = new Set(group.map((c) => c.householdId).filter(Boolean));
  store.removeWhere("contacts", (c) => removeSet.has(c.id));
  retirePlaces("household", emptyHouseholds(householdsBefore), null, list);
  return true;
});

// Folds duplicate organizations into one: its name, attention line, email
// and address are the ones picked (`addressFrom` is whose address); it gets
// every newsletter any of them got, with the most copies any had; their
// members all belong to it now.
ipcMain.handle("orgs:merge", async (event, { keepId, removeIds, values, addressFrom }) => {
  const list = loadList();
  const keep = list.orgById.get(keepId);
  const removing = (removeIds || []).filter((id) => id !== keepId && list.orgById.has(id));
  if (!keep || !removing.length) throw new Error("Those organizations are no longer on the list.");
  const group = [keep, ...removing.map((id) => list.orgById.get(id))];
  const addressSource = group.find((o) => o.id === addressFrom) || keep;
  const removeSet = new Set(removing);
  const now = new Date().toISOString();
  retirePlaces("org", removeSet, keepId, list);
  store.update("orgs", keepId, {
    name: cleanText(values.name) || keep.name,
    attn: cleanText(values.attn),
    email: cleanText(values.email),
    ...Object.fromEntries(rules.ADDRESS_FIELDS.map((f) => [f, addressSource[f] || ""])),
    subs: combineSubs(group),
    updatedAt: now,
  });
  store.updateWhere("contacts", (c) => (removeSet.has(c.orgId) ? { orgId: keepId, updatedAt: now } : null));
  return true;
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
    title: "Select the PDF to attach",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const srcPath = result.filePaths[0];
  const destPath = path.join(store.getDataDir(), "pdf-templates", `${randomUUID()}.pdf`);
  fs.copyFileSync(srcPath, destPath);
  return { storedPath: destPath, originalName: path.basename(srcPath) };
});

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

// A mailing is one issue of one newsletter. It goes by email to each person
// (and organization) checked for it by email, and by mail to each household
// and organization checked for it by mail -- one bundle per address, however
// many of the selection live there.

// The people and organizations a mailing's filters pick out. Each is
// filtered with their address, organization name and number of copies
// alongside, so a filter can be on State as easily as on Name.
function selectRecipients(filterRules, publicationId, list) {
  const people = list.contacts.map((c) => {
    const h = list.householdById.get(c.householdId);
    return {
      ...c,
      ...Object.fromEntries(rules.ADDRESS_FIELDS.map((f) => [f, h?.[f] || ""])),
      orgName: list.orgById.get(c.orgId)?.name || "",
      copies: rules.copiesFor(h, publicationId),
    };
  });
  const orgs = list.orgs.map((o) => ({ ...o, orgName: o.name, name: o.attn, copies: rules.copiesFor(o, publicationId) }));
  return {
    people: filterContacts(people, filterRules).map((row) => list.contactById.get(row.id)),
    orgs: filterContacts(orgs, filterRules).map((row) => list.orgById.get(row.id)),
  };
}

function planRecipients(selected, { publicationId, includeEmail, includeMail }, list) {
  const households = [...new Set(selected.people.map((c) => c.householdId).filter((id) => list.householdById.has(id)))].map((id) => list.householdById.get(id));
  return {
    emailPeople: includeEmail ? selected.people.filter((c) => rules.getsEmail(c, publicationId)) : [],
    emailOrgs: includeEmail ? selected.orgs.filter((o) => rules.getsEmail(o, publicationId)) : [],
    mailHouseholds: includeMail ? households.filter((h) => rules.getsMail(h, publicationId)) : [],
    mailOrgs: includeMail ? selected.orgs.filter((o) => rules.getsMail(o, publicationId)) : [],
    households,
  };
}

ipcMain.handle("mailings:preview", async (event, filterRules, options) => {
  const list = loadList();
  const { publicationId, includeEmail, includeMail } = options;
  const selected = selectRecipients(filterRules, publicationId, list);
  const plan = planRecipients(selected, options, list);
  const addressee = (h) => describeHousehold(h, list.membersOf.get(h.id) || [], list).addressee || formatAddress(h) || "(no address)";
  const covered = (c) => rules.coveredBy(list.orgById.get(c.orgId), publicationId);
  const ownCopy = (c) => !!rules.sub(c, publicationId).email || !!rules.sub(list.householdById.get(c.householdId), publicationId).mail;
  const listOf = (items, label) => ({ count: items.length, names: items.slice(0, 8).map(label) });
  return {
    emailPeople: plan.emailPeople.length,
    emailOrgs: plan.emailOrgs.length,
    mailHouseholds: plan.mailHouseholds.length,
    mailOrgs: plan.mailOrgs.length,
    copies: sum([...plan.mailHouseholds, ...plan.mailOrgs].map((place) => rules.copiesFor(place, publicationId))),
    throughOrg: selected.people.filter((c) => covered(c) && !ownCopy(c)).length,
    emailProblems: listOf(
      includeEmail ? [...selected.people, ...selected.orgs].filter((r) => rules.sub(r, publicationId).email && !rules.getsEmail(r, publicationId)) : [],
      (r) => r.name || r.attn || "(no name)"
    ),
    mailProblems: listOf(
      includeMail ? [...plan.households, ...selected.orgs].filter((p) => rules.sub(p, publicationId).mail && !rules.getsMail(p, publicationId)) : [],
      (p) => (list.orgById.has(p.id) ? p.name : addressee(p))
    ),
    notReceiving: selected.people.filter((c) => !ownCopy(c) && !covered(c)).length,
  };
});

function publicationName(mailing, list) {
  return list.publications.find((p) => p.id === mailing.publicationId)?.name || mailing.publicationName || "";
}

function mailingStats(mailing, recipients, list) {
  const mine = recipients.filter((r) => r.mailingId === mailing.id);
  const email = mine.filter((r) => r.channel === "email");
  const mail = mine.filter((r) => r.channel === "mail");
  const copies = (rows) => sum(rows.map((r) => recipientCopies(r, recipientPlace(r, list), mailing.publicationId)));
  const mailed = mail.filter((r) => r.status === "sent");
  return {
    emailTotal: email.length,
    emailSent: email.filter((r) => r.status === "sent").length,
    emailFailed: email.filter((r) => r.status === "pending" && r.error).length,
    mailTotal: mail.length,
    mailOrgs: mail.filter((r) => r.orgId).length,
    mailMailed: mailed.length,
    copiesTotal: copies(mail),
    copiesMailed: copies(mailed),
    anySent: mine.some((r) => r.status === "sent"),
  };
}

ipcMain.handle("mailings:list", async () => {
  const recipients = store.list("mailingRecipients");
  const list = loadList();
  const templateById = new Map(store.list("templates").map((t) => [t.id, t]));
  return store
    .list("mailings")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((m) => ({
      ...m,
      publicationName: publicationName(m, list),
      templateName: m.templateId ? templateById.get(m.templateId)?.name || "(deleted template)" : "",
      stats: mailingStats(m, recipients, list),
    }));
});

ipcMain.handle("mailings:create", async (event, { name, publicationId, templateId, filterRules, includeEmail, includeMail }) => {
  const list = loadList();
  const publication = list.publications.find((p) => p.id === publicationId);
  if (!publication) throw new Error("Choose which newsletter this mailing is.");
  if (!includeEmail && !includeMail) throw new Error("Choose email, mail, or both.");
  const plan = planRecipients(selectRecipients(filterRules, publicationId, list), { publicationId, includeEmail, includeMail }, list);
  const emailCount = plan.emailPeople.length + plan.emailOrgs.length;
  if (emailCount + plan.mailHouseholds.length + plan.mailOrgs.length === 0) throw new Error(`No one in this selection is set up to get ${publication.name}.`);
  if (emailCount && !templateId) throw new Error("Choose an email template for the email recipients.");

  const mailing = store.insert("mailings", {
    name,
    publicationId,
    publicationName: publication.name,
    templateId: includeEmail ? templateId || null : null,
    filterRules,
    includeEmail: !!includeEmail,
    includeMail: !!includeMail,
    status: "draft",
  });
  const base = { mailingId: mailing.id, status: "pending", sentAt: null, error: null };
  store.insertMany("mailingRecipients", [
    ...plan.emailPeople.map((c) => ({ ...base, channel: "email", contactId: c.id })),
    ...plan.emailOrgs.map((o) => ({ ...base, channel: "email", orgId: o.id })),
    ...plan.mailHouseholds.map((h) => ({ ...base, channel: "mail", householdId: h.id })),
    ...plan.mailOrgs.map((o) => ({ ...base, channel: "mail", orgId: o.id })),
  ]);
  return mailing;
});

ipcMain.handle("mailings:delete", async (event, id) => {
  const mailing = store.get("mailings", id);
  if (!mailing) return false;
  if (store.list("mailingRecipients").some((r) => r.mailingId === id && r.status === "sent")) {
    throw new Error("This mailing has already gone out to some people and can't be deleted.");
  }
  store.removeWhere("mailingRecipients", (r) => r.mailingId === id);
  store.remove("mailings", id);
  return true;
});

// The template, its PDF and the SMTP settings for one mailing's emails. The
// PDF is read once here and attached to every email as-is, under the name it
// had when it was picked on the Templates page.
function loadSendContext(mailing) {
  const emailTemplate = mailing.templateId ? store.get("templates", mailing.templateId) : null;
  if (!emailTemplate) throw new Error("This mailing's email template no longer exists.");
  let attachment = null;
  if (emailTemplate.pdfPath) {
    try {
      attachment = { filename: emailTemplate.pdfOriginalName || "newsletter.pdf", content: fs.readFileSync(emailTemplate.pdfPath) };
    } catch {
      throw new Error(`The PDF for the "${emailTemplate.name}" template is missing from the data folder -- choose it again on the Templates page.`);
    }
  }
  return { emailTemplate, attachment, smtpConfig: resolveSmtpConfig(), publicationId: mailing.publicationId };
}

// Who an email recipient is -- a person, or an organization (to whoever its
// Attention line names) -- with the fields a template can fill in.
function emailTarget(recipient, list, publicationId) {
  if (recipient.orgId) {
    const org = list.orgById.get(recipient.orgId);
    if (!org) return null;
    return {
      email: org.email,
      label: org.name,
      fields: { ...org, name: org.attn || org.name, orgName: org.name, copies: rules.copiesFor(org, publicationId) },
    };
  }
  const contact = list.contactById.get(recipient.contactId);
  if (!contact) return null;
  const h = list.householdById.get(contact.householdId);
  return {
    email: contact.email,
    label: contactLabel(contact),
    fields: {
      ...contact,
      ...Object.fromEntries(rules.ADDRESS_FIELDS.map((f) => [f, h?.[f] || ""])),
      orgName: list.orgById.get(contact.orgId)?.name || "",
      copies: rules.copiesFor(h, publicationId),
    },
  };
}

// Builds one recipient's email from the mailing's email template as it is
// now, so a send, a test and a resend all match.
function composeEmail(fields, { emailTemplate, attachment }) {
  const html = renderTemplate(emailTemplate.body, fields, { html: true });
  return {
    subject: renderTemplate(emailTemplate.subject, fields),
    html,
    text: htmlToPlainText(html),
    attachments: attachment ? [attachment] : [],
  };
}

// Emails one recipient and records the outcome. A failure is saved as the
// recipient's `error` (the Delivery page shows it as "Send failed", with a
// way to fix the address and retry) and then rethrown.
async function emailRecipient(recipient, target, context) {
  try {
    if (!target) throw new Error("They've been deleted from the mailing list.");
    if (!rules.isValidEmail(target.email)) throw new Error("There's no usable email address for them.");
    await mailer.sendMail(context.smtpConfig, { to: target.email, ...composeEmail(target.fields, context) });
    store.update("mailingRecipients", recipient.id, { status: "sent", sentAt: new Date().toISOString(), error: null });
  } catch (err) {
    store.update("mailingRecipients", recipient.id, { error: err.message });
    throw err;
  }
}

function sendProgress(mailingId, done, total) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mailings:progress", { mailingId, done, total });
}

// Guards against the same mailing being sent twice at once (a double click,
// or navigating away and back mid-send and clicking again).
const sendsInFlight = new Set();

ipcMain.handle("mailings:send", async (event, mailingId) => {
  const mailing = store.get("mailings", mailingId);
  if (!mailing) throw new Error("Mailing not found.");
  if (sendsInFlight.has(mailingId)) throw new Error("This mailing is already sending.");
  sendsInFlight.add(mailingId);
  try {
    const recipients = store.list("mailingRecipients").filter((r) => r.mailingId === mailingId && r.channel === "email" && r.status === "pending");
    const results = { sent: 0, errors: [] };
    if (recipients.length) {
      const context = loadSendContext(mailing);
      // Checked up front so a wrong password or unreachable server is one
      // error here, rather than every recipient marked as a failed send.
      try {
        await mailer.verifyConnection(context.smtpConfig);
      } catch (err) {
        throw new Error(`Couldn't connect to the mail server (${err.message}). Check Settings and try again -- nothing was sent.`);
      }
      const list = loadList();
      for (const [i, recipient] of recipients.entries()) {
        sendProgress(mailingId, i, recipients.length);
        const target = emailTarget(recipient, list, mailing.publicationId);
        try {
          await emailRecipient(recipient, target, context);
          results.sent++;
        } catch (err) {
          results.errors.push({ name: target?.label || "(deleted)", error: err.message });
        }
      }
      sendProgress(mailingId, recipients.length, recipients.length);
    }
    store.update("mailings", mailingId, { status: "sent", sentAt: mailing.sentAt || new Date().toISOString() });
    return results;
  } finally {
    sendsInFlight.delete(mailingId);
  }
});

// Sends one copy of a mailing's email to the test address in Settings,
// without touching any recipient or the mailing's status -- to see exactly
// what a real send will look like before committing to it. Fills merge
// fields from a real recipient when the mailing has one.
ipcMain.handle("mailings:send-test", async (event, mailingId) => {
  const mailing = store.get("mailings", mailingId);
  if (!mailing) throw new Error("Mailing not found.");
  const testEmail = store.getSettings().testEmail;
  if (!testEmail) throw new Error("Set a test email address in Settings first.");
  const context = loadSendContext(mailing);
  const list = loadList();
  const sample = store.list("mailingRecipients").find((r) => r.mailingId === mailingId && r.channel === "email");
  const fields = (sample && emailTarget(sample, list, mailing.publicationId)?.fields) || {
    ...BLANK_ADDRESS,
    orgName: "Sample Church",
    name: "Test Recipient",
    email: testEmail,
    addressLine1: "123 Sample St",
    city: "Sampleton",
    state: "PA",
    zip: "00000",
    copies: 1,
  };
  const message = composeEmail(fields, context);
  await mailer.sendMail(context.smtpConfig, { to: testEmail, ...message, subject: `[TEST] ${message.subject}` });
  return { to: testEmail };
});

ipcMain.handle("mailings:export-addresses", async (event, mailingId) => {
  const ids = store.list("mailingRecipients").filter((r) => r.mailingId === mailingId && r.channel === "mail").map((r) => r.id);
  return exportMailingAddresses(ids);
});

// ---------------------------------------------------------------------------
// Delivery (each mailing's recipients)
// ---------------------------------------------------------------------------

ipcMain.handle("delivery:list", async (event, mailingId) => {
  const recipients = store.list("mailingRecipients").filter((r) => !mailingId || r.mailingId === mailingId);
  const list = loadList();
  const mailingById = new Map(store.list("mailings").map((m) => [m.id, m]));
  return recipients.map((r) => {
    const mailing = mailingById.get(r.mailingId);
    const base = { ...r, mailingName: mailing?.name || "", publicationName: mailing ? publicationName(mailing, list) : "" };
    if (r.orgId) {
      const org = recipientOrg(r, list);
      return { ...base, org, orgDeleted: !list.orgById.has(r.orgId), copies: recipientCopies(r, org, mailing?.publicationId) };
    }
    if (r.channel === "mail") {
      const household = recipientHousehold(r, list);
      return { ...base, household, householdDeleted: !list.householdById.has(r.householdId), copies: recipientCopies(r, household, mailing?.publicationId) };
    }
    const contact = recipientContact(r, list);
    return { ...base, contact, orgName: list.orgById.get(contact?.orgId)?.name || "", contactDeleted: !list.contactById.has(r.contactId) };
  });
});

// Addresses go from "to mail" to "mailed" here. The number of copies is
// recorded at this point, so later edits to the list don't rewrite what this
// mailing sent. Takes an array so the Delivery page can mark a whole
// filtered batch at once.
ipcMain.handle("delivery:mark-mailed", async (event, recipientIds) => {
  const ids = new Set(recipientIds || []);
  const list = loadList();
  const mailingById = new Map(store.list("mailings").map((m) => [m.id, m]));
  const now = new Date().toISOString();
  const updated = store.updateWhere("mailingRecipients", (r) => {
    if (!ids.has(r.id) || r.channel !== "mail" || r.status !== "pending") return null;
    return { status: "sent", sentAt: now, copies: rules.copiesFor(recipientPlace(r, list), mailingById.get(r.mailingId)?.publicationId) };
  });
  return { updated };
});

ipcMain.handle("delivery:unmark-mailed", async (event, recipientId) => {
  const recipient = store.get("mailingRecipients", recipientId);
  if (!recipient || recipient.channel !== "mail") throw new Error("Recipient not found.");
  return store.update("mailingRecipients", recipientId, { status: "pending", sentAt: null, copies: null });
});

ipcMain.handle("delivery:remove-recipient", async (event, recipientId) => {
  if (!store.remove("mailingRecipients", recipientId)) throw new Error("Recipient not found.");
  return true;
});

// Retries one recipient whose email failed, after saving a corrected address.
// A blank address mails them a copy instead -- to their household, or an
// organization's own address -- or, if that address is already getting this
// mailing by mail, just takes them off the email side.
ipcMain.handle("delivery:retry-send", async (event, recipientId, email) => {
  const recipient = store.get("mailingRecipients", recipientId);
  if (!recipient || recipient.channel !== "email") throw new Error("Recipient not found.");
  if (recipient.status !== "pending") throw new Error("This recipient has already been sent.");
  const mailing = store.get("mailings", recipient.mailingId);
  const list = loadList();
  const isOrg = !!recipient.orgId;
  const record = isOrg ? list.orgById.get(recipient.orgId) : list.contactById.get(recipient.contactId);
  if (!mailing || !record) throw new Error("This recipient's mailing or contact no longer exists.");
  const pubId = mailing.publicationId;
  const now = new Date().toISOString();
  const collection = isOrg ? "orgs" : "contacts";

  const cleaned = cleanText(email);
  if (!cleaned) {
    const place = isOrg ? record : list.householdById.get(record.householdId);
    if (!rules.hasMailingAddress(place)) {
      throw new Error("There's no mailing address on file for them. Add one on the Mailing List first, or enter an email address.");
    }
    store.update(collection, record.id, { email: "", subs: mergeSubs(record.subs, { [pubId]: { email: false } }), updatedAt: now });
    const placeCollection = isOrg ? "orgs" : "households";
    const fresh = store.get(placeCollection, place.id);
    const copies = rules.copiesFor(fresh, pubId) || 1;
    store.update(placeCollection, place.id, { subs: mergeSubs(fresh.subs, { [pubId]: { mail: true, copies } }), updatedAt: now });
    const placeKey = isOrg ? "orgId" : "householdId";
    const alreadyMailed = store.list("mailingRecipients").some((r) => r.mailingId === mailing.id && r.channel === "mail" && r[placeKey] === place.id);
    if (alreadyMailed) {
      store.remove("mailingRecipients", recipient.id);
      return { outcome: "removed" };
    }
    store.update("mailingRecipients", recipient.id, { channel: "mail", contactId: null, [placeKey]: place.id, error: null });
    return { outcome: "mail" };
  }

  if (cleaned !== record.email || !rules.sub(record, pubId).email) {
    store.update(collection, record.id, { email: cleaned, subs: mergeSubs(record.subs, { [pubId]: { email: true } }), updatedAt: now });
  }
  await emailRecipient(recipient, emailTarget(recipient, loadList(), pubId), loadSendContext(mailing));
  return { outcome: "sent" };
});

// Emails a mailing again to recipients who were already sent it -- it went
// to spam, say, or the first copy had the wrong PDF. Uses the email template
// and PDF as they are now. sentAt keeps the original send; resentAt records
// the latest resend. A failure is only reported back, not saved -- the
// recipient was still sent the first time.
ipcMain.handle("delivery:resend", async (event, recipientIds) => {
  const ids = new Set(recipientIds || []);
  const recipients = store.list("mailingRecipients").filter((r) => ids.has(r.id) && r.channel === "email" && r.status === "sent");
  const list = loadList();
  const mailingById = new Map(store.list("mailings").map((m) => [m.id, m]));
  const contextByMailing = new Map();

  const results = { sent: 0, errors: [] };
  for (const [i, recipient] of recipients.entries()) {
    sendProgress(recipient.mailingId, i, recipients.length);
    const mailing = mailingById.get(recipient.mailingId);
    const target = mailing && emailTarget(recipient, list, mailing.publicationId);
    try {
      if (!mailing || !target) throw new Error("This recipient's mailing or contact no longer exists.");
      if (!rules.isValidEmail(target.email)) throw new Error("There's no longer a usable email address for them.");
      if (!contextByMailing.has(mailing.id)) contextByMailing.set(mailing.id, loadSendContext(mailing));
      const context = contextByMailing.get(mailing.id);
      await mailer.sendMail(context.smtpConfig, { to: target.email, ...composeEmail(target.fields, context) });
      store.update("mailingRecipients", recipient.id, { resentAt: new Date().toISOString() });
      results.sent++;
    } catch (err) {
      results.errors.push({ recipientId: recipient.id, name: target?.label || "(deleted)", error: err.message });
    }
  }
  return results;
});

function recipientsByIds(recipientIds) {
  const ids = new Set(recipientIds || []);
  return store.list("mailingRecipients").filter((r) => ids.has(r.id));
}

const DELIVERY_EXPORT_COLUMNS = ["Mailing", "Newsletter", "Name", "Organization", "Sent By", "Status", "Email Address", ...Object.keys(ADDRESS_COLUMNS), "Copies", "Sent / Mailed", "Resent", "Error"];

function deliveryStatusLabel(r) {
  if (r.channel === "mail") return r.status === "sent" ? "Mailed" : "To mail";
  if (r.status === "sent") return "Emailed";
  return r.error ? "Send failed" : "Not sent yet";
}

// Who a recipient row is, for exports and labels: an organization by name
// (attention to whoever it names), a household by everyone who lives there,
// a person by name.
function recipientLabel(r, list) {
  if (r.orgId) {
    const org = recipientOrg(r, list) || {};
    return { name: org.attn || "", organization: org.name || "", place: org, email: org.email || "" };
  }
  if (r.channel === "mail") {
    const household = recipientHousehold(r, list) || {};
    return { name: household.addressee || "", organization: "", place: household, email: "" };
  }
  const contact = recipientContact(r, list) || {};
  return { name: contact.name || "", organization: list.orgById.get(contact.orgId)?.name || "", place: list.householdById.get(contact.householdId), email: contact.email || "" };
}

// Both exports take the recipient IDs currently shown on the Delivery page,
// so what's exported always matches the page's filters.
ipcMain.handle("delivery:export", async (event, recipientIds) => {
  const list = loadList();
  const mailingById = new Map(store.list("mailings").map((m) => [m.id, m]));
  const rows = recipientsByIds(recipientIds).map((r) => {
    const mailing = mailingById.get(r.mailingId);
    const who = recipientLabel(r, list);
    return {
      Mailing: mailing?.name || "",
      Newsletter: mailing ? publicationName(mailing, list) : "",
      Name: who.name,
      Organization: who.organization,
      "Sent By": r.channel === "mail" ? "Mail" : "Email",
      Status: deliveryStatusLabel(r),
      "Email Address": r.channel === "email" ? who.email : "",
      ...addressCells(who.place),
      Copies: r.channel === "mail" ? recipientCopies(r, who.place, mailing?.publicationId) : "",
      "Sent / Mailed": r.sentAt || "",
      Resent: r.resentAt || "",
      Error: r.status === "pending" ? r.error || "" : "",
    };
  });
  return saveTable(DELIVERY_EXPORT_COLUMNS, rows, { title: "Export delivery list", defaultName: "delivery", sheetName: "Delivery" });
});

// Ready for a label or envelope mail merge: one row per address -- a
// household, named for everyone who lives there, or an organization's batch,
// to whoever its Attention line names -- with how many copies go in it.
const ADDRESS_EXPORT_COLUMNS = ["Name", "Organization", ...Object.keys(ADDRESS_COLUMNS), "Copies"];

async function exportMailingAddresses(recipientIds) {
  const list = loadList();
  const mailingById = new Map(store.list("mailings").map((m) => [m.id, m]));
  const rows = recipientsByIds(recipientIds)
    .filter((r) => r.channel === "mail")
    .map((r) => {
      const who = recipientLabel(r, list);
      return { Name: who.name, Organization: who.organization, ...addressCells(who.place), Copies: recipientCopies(r, who.place, mailingById.get(r.mailingId)?.publicationId) };
    });
  return saveTable(ADDRESS_EXPORT_COLUMNS, rows, { title: "Export mailing addresses", defaultName: "mailing-addresses", sheetName: "Addresses" });
}

ipcMain.handle("delivery:export-addresses", async (event, recipientIds) => exportMailingAddresses(recipientIds));


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
