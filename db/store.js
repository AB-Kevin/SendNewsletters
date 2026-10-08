"use strict";

// Plain JSON-file collections instead of a native SQLite binding. SendNewsletters
// is a single-user desktop tool operating on mailing lists of at most a few
// thousand contacts, well within the range where "load the whole collection,
// mutate, write it back" is simple and fast enough -- and it avoids pulling
// in a native module (better-sqlite3) that would need node-gyp/Visual Studio
// build tools to install, which the sibling Electron apps in this workspace
// (ApplicationManager, BillManager) deliberately avoid in favor of plain JSON
// sidecar files.

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

let dataDir = null;

function init(userDataPath) {
  dataDir = path.join(userDataPath, "sendnewsletters-data");
  fs.mkdirSync(dataDir, { recursive: true });
  for (const sub of ["pdf-templates", "generated-pdfs", "generated-letters", "attachments"]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
}

function getDataDir() {
  return dataDir;
}

function collectionPath(name) {
  return path.join(dataDir, `${name}.json`);
}

function loadCollection(name, defaultValue) {
  try {
    return JSON.parse(fs.readFileSync(collectionPath(name), "utf8"));
  } catch {
    return defaultValue;
  }
}

function saveCollection(name, value) {
  fs.writeFileSync(collectionPath(name), JSON.stringify(value, null, 2), "utf8");
}

function list(name) {
  return loadCollection(name, []);
}

function get(name, id) {
  return list(name).find((row) => row.id === id) || null;
}

function insert(name, row) {
  const rows = list(name);
  const withId = { id: randomUUID(), createdAt: new Date().toISOString(), ...row };
  rows.push(withId);
  saveCollection(name, rows);
  return withId;
}

function insertMany(name, newRows) {
  const rows = list(name);
  const withIds = newRows.map((row) => ({ id: randomUUID(), createdAt: new Date().toISOString(), ...row }));
  rows.push(...withIds);
  saveCollection(name, rows);
  return withIds;
}

// Inserts rows that don't match an existing row's `keyField` value; for ones
// that do, overwrites that existing row's fields in place (same internal id
// and createdAt) instead of adding a duplicate. Used for re-importing a
// contact list where the same external ID (e.g. GroupCode) should update the
// existing contact -- so its mailing/tracking history stays linked -- rather
// than creating a second contact. Rows with an empty/missing key always
// insert, since there's nothing to match them against.
function upsertMany(name, keyField, newRows) {
  const rows = list(name);
  const indexByKey = new Map();
  rows.forEach((row, idx) => {
    if (row[keyField]) indexByKey.set(row[keyField], idx);
  });

  let inserted = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const row of newRows) {
    const key = row[keyField];
    const idx = key ? indexByKey.get(key) : undefined;
    if (idx !== undefined) {
      rows[idx] = { ...rows[idx], ...row, id: rows[idx].id, createdAt: rows[idx].createdAt };
      updated++;
    } else {
      const withId = { id: randomUUID(), createdAt: now, ...row };
      rows.push(withId);
      if (key) indexByKey.set(key, rows.length - 1);
      inserted++;
    }
  }

  saveCollection(name, rows);
  return { inserted, updated };
}

function update(name, id, patch) {
  const rows = list(name);
  const idx = rows.findIndex((row) => row.id === id);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...patch, id };
  saveCollection(name, rows);
  return rows[idx];
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
  if (changed) saveCollection(name, next);
  return changed;
}

function remove(name, id) {
  const rows = list(name);
  const next = rows.filter((row) => row.id !== id);
  saveCollection(name, next);
  return next.length !== rows.length;
}

function removeWhere(name, predicate) {
  const rows = list(name);
  const next = rows.filter((row) => !predicate(row));
  saveCollection(name, next);
  return rows.length - next.length;
}

function getSettings() {
  return loadCollection("settings", {});
}

function updateSettings(patch) {
  const current = getSettings();
  const next = { ...current, ...patch };
  saveCollection("settings", next);
  return next;
}

module.exports = {
  init,
  getDataDir,
  list,
  get,
  insert,
  insertMany,
  upsertMany,
  update,
  updateWhere,
  remove,
  removeWhere,
  getSettings,
  updateSettings,
};
