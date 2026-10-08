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
  fs.mkdirSync(path.join(dataDir, "pdf-templates"), { recursive: true });
}

function getDataDir() {
  return dataDir;
}

function collectionPath(name) {
  return path.join(dataDir, `${name}.json`);
}

// A missing file is just an empty collection. A file that's there but won't
// parse is an error, not an empty list -- otherwise the next save would
// write a near-empty list over the damaged one, and the mailing list (edited
// in place all day) is exactly the file that can't be lost that way.
function loadCollection(name, defaultValue) {
  let text;
  try {
    text = fs.readFileSync(collectionPath(name), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return defaultValue;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name}.json in the data folder is damaged and couldn't be read. It hasn't been changed -- restore it from a backup.`);
  }
}

// Written to a temporary file and then moved into place, so a crash or power
// loss mid-write leaves the previous version rather than half a file.
function saveCollection(name, value) {
  const target = collectionPath(name);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(temp, target);
  } catch {
    // Windows can refuse the replace while something (a virus scanner, say)
    // briefly has the file open; fall back to writing it directly.
    fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf8");
    fs.rmSync(temp, { force: true });
  }
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

// For changes that rework a whole collection at once (re-pointing every
// mailing recipient of a merged contact, say): fn gets the rows and returns
// the new ones, saved in one write.
function mutate(name, fn) {
  const next = fn(list(name));
  saveCollection(name, next);
  return next;
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
  update,
  updateWhere,
  remove,
  removeWhere,
  mutate,
  getSettings,
  updateSettings,
};
