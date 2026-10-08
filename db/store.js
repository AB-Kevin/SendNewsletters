"use strict";

// Plain JSON-file collections instead of a native SQLite binding. SendNewsletters
// is a single-user desktop tool operating on mailing lists of at most a few
// thousand contacts, well within the range where "load the whole collection,
// mutate, write it back" is simple and fast enough -- and it avoids pulling
// in a native module (better-sqlite3) that would need node-gyp/Visual Studio
// build tools to install, which the sibling Electron apps in this workspace
// (ApplicationManager, BillManager) deliberately avoid in favor of plain JSON
// sidecar files.
//
// Every change re-reads the file before writing it, so when two computers
// share a data folder, each one's edits land on top of the other's latest
// save. What it can't do is merge two saves of the same file made at the
// same moment -- the later one wins -- which is why the Settings page asks
// people not to edit on two computers at once.

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

// The data folder holds the mailing list and everything that goes with it,
// and can be anywhere -- a folder on OneDrive, say, so more than one
// computer works from the same list (see main.js, "Data location"). The
// local folder is this computer's own app folder, for what belongs to the
// computer rather than the list.
let dataDir = null;
let localDir = null;

// Collections that make up a data folder, for telling one apart from any
// other folder.
const DATA_FILES = ["contacts.json", "households.json", "orgs.json", "publications.json", "mailings.json", "templates.json"];

function isDataFolder(dir) {
  return DATA_FILES.some((file) => fs.existsSync(path.join(dir, file)));
}

function init(dataPath, localPath) {
  dataDir = dataPath;
  localDir = localPath;
  fs.mkdirSync(path.join(dataDir, "pdf-templates"), { recursive: true });
  fs.mkdirSync(localDir, { recursive: true });
  moveLocalSettingsOut();
}

function getDataDir() {
  return dataDir;
}

// A file under the data folder from a path stored relative to it. Older
// templates stored the whole path, which stops working once the data folder
// moves, so those are looked for by file name in the same subfolder here.
function dataPath(stored, subfolder) {
  if (!stored) return null;
  if (!path.isAbsolute(stored)) return path.join(dataDir, stored);
  if (fs.existsSync(stored)) return stored;
  return path.join(dataDir, subfolder, path.basename(stored));
}

function collectionPath(name) {
  return path.join(dataDir, `${name}.json`);
}

// A missing file is just an empty collection. A file that's there but won't
// parse is an error, not an empty list -- otherwise the next save would
// write a near-empty list over the damaged one, and the mailing list (edited
// in place all day) is exactly the file that can't be lost that way.
function readJson(file, defaultValue) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return defaultValue;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path.basename(file)} in ${path.dirname(file)} is damaged and couldn't be read. It hasn't been changed -- restore it from a backup.`);
  }
}

// Written to a temporary file and then moved into place, so a crash or power
// loss mid-write leaves the previous version rather than half a file.
function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(temp, file);
  } catch {
    // Windows can refuse the replace while something (a virus scanner, or
    // OneDrive syncing) briefly has the file open; fall back to writing it
    // directly.
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    fs.rmSync(temp, { force: true });
  }
}

const loadCollection = (name, defaultValue) => readJson(collectionPath(name), defaultValue);
const saveCollection = (name, value) => writeJson(collectionPath(name), value);

// ---- sharing a data folder (see lib/team.js) ----
// Only the host computer writes the shared files. Anywhere else, a change is
// recorded as a list of exactly what changed -- rows added, fields set or
// cleared, rows removed -- in that computer's own changes file, for the host
// to apply. Until it has, this computer reads the shared files with its own
// changes laid on top, so its screens show them straight away. Applying a
// change twice leaves the same result, so laying one on top of a shared file
// that already has it does no harm.
//
// `journal` is { role: "host" | "editor", append(change), pending() }; with
// none, this computer writes the files itself.
let journal = null;

function setJournal(next) {
  journal = next;
}

// The collections a change may touch: what's in a data folder, and its
// shared settings.
const SHARED_COLLECTIONS = new Set(["contacts", "households", "orgs", "publications", "templates", "mailings", "mailingRecipients", "reviewDismissed", "settings"]);

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function getPath(object, dotted) {
  return dotted.split(".").reduce((o, key) => (o == null ? undefined : o[key]), object);
}

function setPath(object, dotted, value) {
  const keys = dotted.split(".");
  let o = object;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(o[key])) o[key] = {};
    o = o[key];
  }
  o[keys[keys.length - 1]] = clone(value);
}

function unsetPath(object, dotted) {
  const keys = dotted.split(".");
  let o = object;
  for (const key of keys.slice(0, -1)) {
    o = o?.[key];
    if (!isPlainObject(o)) return;
  }
  delete o[keys[keys.length - 1]];
}

// What changed between two versions of a row (or of the settings), down to
// the field -- "subs.<newsletter>.email", not the whole subs -- so two people
// changing different cells of one contact don't undo each other.
function diffFields(before, after, prefix = "", out = { set: {}, unset: [] }) {
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    const a = before?.[key];
    const b = after?.[key];
    if (b === undefined) {
      if (a !== undefined) out.unset.push(dotted);
    } else if (isPlainObject(a) && isPlainObject(b)) diffFields(a, b, dotted, out);
    else if (!sameJson(a, b)) out.set[dotted] = clone(b);
  }
  return out;
}

function diffRows(before, after) {
  const was = new Map(before.map((row) => [row.id, row]));
  const now = new Set(after.map((row) => row.id));
  const change = { inserts: [], patches: [], removes: [] };
  for (const row of after) {
    const old = was.get(row.id);
    if (!old) change.inserts.push(clone(row));
    else if (old !== row) {
      const fields = diffFields(old, row);
      if (Object.keys(fields.set).length || fields.unset.length) change.patches.push({ id: row.id, ...fields });
    }
  }
  for (const row of before) if (!now.has(row.id)) change.removes.push(row.id);
  return change;
}

const isEmptyChange = (c) =>
  c.collection === "settings" ? !Object.keys(c.set || {}).length && !c.unset?.length : !c.inserts?.length && !c.patches?.length && !c.removes?.length;

// One recorded change applied to a collection's rows (returned as a new
// array; the rows passed in aren't touched). A row added that's already
// there is updated instead, and a change to a row someone has since removed
// is skipped.
function applyChange(rows, change) {
  const index = new Map(rows.map((row, i) => [row.id, i]));
  const next = rows.slice();
  const copied = new Set();
  const editable = (i) => {
    if (!copied.has(i)) {
      next[i] = clone(next[i]);
      copied.add(i);
    }
    return next[i];
  };
  for (const row of change.inserts || []) {
    if (index.has(row.id)) Object.assign(editable(index.get(row.id)), clone(row));
    else {
      index.set(row.id, next.length);
      copied.add(next.length);
      next.push(clone(row));
    }
  }
  for (const patch of change.patches || []) {
    const i = index.get(patch.id);
    if (i === undefined) continue;
    const row = editable(i);
    for (const [dotted, value] of Object.entries(patch.set || {})) setPath(row, dotted, value);
    for (const dotted of patch.unset || []) unsetPath(row, dotted);
  }
  if (!change.removes?.length) return next;
  const gone = new Set(change.removes);
  return next.filter((row) => !gone.has(row.id));
}

function applySettingsChange(settings, change) {
  const next = clone(settings);
  for (const [dotted, value] of Object.entries(change.set || {})) setPath(next, dotted, value);
  for (const dotted of change.unset || []) unsetPath(next, dotted);
  return next;
}

const pendingFor = (name) => (journal ? journal.pending().filter((c) => c.collection === name) : []);

// Writes a collection: the file itself on the host (or with no sharing), a
// recorded change anywhere else.
function commit(name, before, after) {
  if (journal?.role !== "editor") {
    saveCollection(name, after);
    return;
  }
  const change = { collection: name, ...diffRows(before, after) };
  if (!isEmptyChange(change)) journal.append(change);
}

// The host's job: applies changes other computers sent, in the order given
// (oldest first), each collection read and written once.
function applyIncoming(changes) {
  const byCollection = new Map();
  for (const change of changes) {
    if (!SHARED_COLLECTIONS.has(change.collection)) continue;
    if (!byCollection.has(change.collection)) byCollection.set(change.collection, []);
    byCollection.get(change.collection).push(change);
  }
  for (const [name, list] of byCollection) {
    if (name === "settings") saveCollection(name, list.reduce(applySettingsChange, loadCollection(name, {})));
    else saveCollection(name, list.reduce(applyChange, loadCollection(name, [])));
  }
}

// Whether the shared files already show a change -- once they do, the
// computer that made it can stop laying it on top.
function isReflected(change) {
  const fieldsMatch = (record, fields) =>
    Object.entries(fields.set || {}).every(([dotted, value]) => sameJson(getPath(record, dotted), value)) &&
    (fields.unset || []).every((dotted) => getPath(record, dotted) === undefined);
  if (change.collection === "settings") return fieldsMatch(loadCollection("settings", {}), change);
  const rows = new Map(loadCollection(change.collection, []).map((row) => [row.id, row]));
  return (
    (change.inserts || []).every((row) => rows.has(row.id)) &&
    (change.removes || []).every((id) => !rows.has(id)) &&
    (change.patches || []).every((patch) => !rows.has(patch.id) || fieldsMatch(rows.get(patch.id), patch))
  );
}

function list(name) {
  return pendingFor(name).reduce(applyChange, loadCollection(name, []));
}

function get(name, id) {
  return list(name).find((row) => row.id === id) || null;
}

function insert(name, row) {
  const rows = list(name);
  const withId = { id: randomUUID(), createdAt: new Date().toISOString(), ...row };
  commit(name, rows, [...rows, withId]);
  return withId;
}

function insertMany(name, newRows) {
  if (!newRows.length) return [];
  const rows = list(name);
  const withIds = newRows.map((row) => ({ id: randomUUID(), createdAt: new Date().toISOString(), ...row }));
  commit(name, rows, [...rows, ...withIds]);
  return withIds;
}

function update(name, id, patch) {
  const rows = list(name);
  const idx = rows.findIndex((row) => row.id === id);
  if (idx === -1) return null;
  const next = rows.slice();
  next[idx] = { ...rows[idx], ...patch, id };
  commit(name, rows, next);
  return next[idx];
}

// Applies patchFn(row) to every row in one load/save; rows for which it
// returns a falsy value are left untouched. Returns how many rows changed.
function updateWhere(name, patchFn) {
  const rows = list(name);
  let changed = 0;
  const next = rows.map((row) => {
    const patch = patchFn(row);
    if (!patch) return row;
    changed++;
    return { ...row, ...patch, id: row.id };
  });
  if (changed) commit(name, rows, next);
  return changed;
}

function remove(name, id) {
  const rows = list(name);
  const next = rows.filter((row) => row.id !== id);
  if (next.length !== rows.length) commit(name, rows, next);
  return next.length !== rows.length;
}

function removeWhere(name, predicate) {
  const rows = list(name);
  const next = rows.filter((row) => !predicate(row));
  if (next.length !== rows.length) commit(name, rows, next);
  return rows.length - next.length;
}

// For changes that rework a whole collection at once (re-pointing every
// mailing recipient of a merged contact, say): fn gets the rows and returns
// the new ones, saved in one write.
function mutate(name, fn) {
  const rows = list(name);
  const next = fn(rows);
  commit(name, rows, next);
  return next;
}

// Settings that belong to this computer rather than to the list, kept in the
// local folder: how it sends email, its connection to the signup form, and
// its appearance. The passwords among them are encrypted with this Windows
// account's key, which no other computer can read -- in a shared data folder,
// a second computer re-entering the password would lock the first one out.
// Everything else (when the signup form was last imported, say) goes with
// the list. Who is using this computer and whether it's the host for a
// shared folder (see lib/team.js) belong to the computer too.
const LOCAL_SETTINGS = new Set([
  "personId",
  "personName",
  "isHost",
  "hostSince",
  "theme",
  "smtpHost",
  "smtpPort",
  "smtpSecure",
  "smtpUser",
  "smtpPassword",
  "fromName",
  "fromEmail",
  "testEmail",
  "gfSiteUrl",
  "gfConsumerKey",
  "gfConsumerSecret",
  "gfFormId",
  "gfFormTitle",
]);

const localSettingsPath = () => path.join(localDir, "local-settings.json");

// Data folders from before the split kept everything in their settings.json;
// this computer's part moves to the local folder the first time it's opened.
function moveLocalSettingsOut() {
  const shared = loadCollection("settings", {});
  const mine = Object.keys(shared).filter((key) => LOCAL_SETTINGS.has(key));
  if (!mine.length) return;
  if (!fs.existsSync(localSettingsPath())) writeJson(localSettingsPath(), Object.fromEntries(mine.map((key) => [key, shared[key]])));
  saveCollection("settings", Object.fromEntries(Object.entries(shared).filter(([key]) => !LOCAL_SETTINGS.has(key))));
}

const sharedSettings = () => pendingFor("settings").reduce(applySettingsChange, loadCollection("settings", {}));

function getSettings() {
  return { ...sharedSettings(), ...readJson(localSettingsPath(), {}) };
}

function updateSettings(patch) {
  const local = {};
  const shared = {};
  for (const [key, value] of Object.entries(patch)) (LOCAL_SETTINGS.has(key) ? local : shared)[key] = value;
  if (Object.keys(local).length) writeJson(localSettingsPath(), { ...readJson(localSettingsPath(), {}), ...local });
  if (Object.keys(shared).length) {
    const before = sharedSettings();
    const after = { ...before, ...shared };
    if (journal?.role !== "editor") saveCollection("settings", after);
    else {
      const change = { collection: "settings", ...diffFields(before, after) };
      if (!isEmptyChange(change)) journal.append(change);
    }
  }
  return getSettings();
}

// Each shared collection as this computer sees it, unsaved changes and all
// -- for copying the list somewhere new.
function snapshot() {
  return Object.fromEntries([...SHARED_COLLECTIONS].map((name) => [name, name === "settings" ? sharedSettings() : list(name)]));
}

module.exports = {
  init,
  isDataFolder,
  getDataDir,
  dataPath,
  setJournal,
  applyIncoming,
  isReflected,
  snapshot,
  writeJson,
  readJson,
  list,
  get,
  insert,
  insertMany,
  update,
  updateWhere,
  remove,
  removeWhere,
  mutate,
  getSettings,
  updateSettings,
};
