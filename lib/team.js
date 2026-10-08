"use strict";

// Several computers can use one data folder at the same time, through
// OneDrive say. OneDrive can't merge two people's changes to the same file,
// so every file has exactly one writer (the same arrangement as the office's
// Duplicate Checker):
//
//   people/<id>.json          written only by that computer: who's using it,
//                             whether it's set as the host, and when it was
//                             last seen.
//   people/<id>.changes.json  written only by that computer: changes made on
//                             it that the host hasn't saved yet.
//   people/applied.json       written only by the host: how far it has got
//                             with each computer's changes.
//   everything else           written only by the host -- its own changes,
//                             and everyone else's once it has applied them.
//
// The host is the computer set as host that has been host the longest among
// those whose app is open; any other computer set as host waits. Changes
// reach the other computers as fast as OneDrive syncs them, usually within
// seconds. Their order goes by each computer's clock, so keep Windows'
// automatic time setting on.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const ACTIVE_MS = 5 * 60 * 1000; // someone not heard from for this long has left
const HEARTBEAT_MS = 60 * 1000;
// A fallback for file-change notifications OneDrive doesn't deliver; shorter
// for the end-to-end test.
const TICK_MS = Number(process.env.SENDNEWSLETTERS_TEAM_TICK_MS) || 30 * 1000;
// How long a saved change is still laid on top, in case the shared files
// that show it haven't synced to this computer yet.
const KEEP_APPLIED_MS = 2 * 60 * 1000;
// OneDrive names conflict copies "<name>-<COMPUTER>.json"; those don't match
// and are ignored.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PERSON_FILE = new RegExp(`^(${UUID})\\.json$`, "i");
const CHANGES_FILE = new RegExp(`^(${UUID})\\.changes\\.json$`, "i");
const APPLIED_FILE = "applied.json";

const peopleDir = (dataDir) => path.join(dataDir, "people");

// Lenient: someone else's file mid-sync reads as missing rather than
// stopping everything.
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    fs.rmSync(temp, { force: true });
  }
}

function readPeople(dataDir) {
  let names;
  try {
    names = fs.readdirSync(peopleDir(dataDir));
  } catch {
    return [];
  }
  return names
    .filter((name) => PERSON_FILE.test(name))
    .map((name) => readJson(path.join(peopleDir(dataDir), name), null))
    .filter((person) => person && person.id);
}

function isActive(person, now = Date.now()) {
  return person.open !== false && now - Date.parse(person.seen) < ACTIVE_MS;
}

// The open computers set as host, longest-serving first. Only the first acts
// as host; any others wait, so two computers never write the shared files at
// once.
function activeHosts(people, now = Date.now()) {
  return people
    .filter((p) => p.role === "host" && isActive(p, now))
    .sort((a, b) => String(a.hostSince).localeCompare(String(b.hostSince)) || a.id.localeCompare(b.id));
}

// This computer's place in a data folder: keeps its own files up to date and
// says when other people's change. Emits "people" when someone's presence or
// changes file changes, "shared" when the host's files change, and "tick"
// now and then.
class Team extends EventEmitter {
  constructor(identity) {
    super();
    this.identity = identity; // { id, name }
    this.dataDir = null;
    this.me = null;
    this.others = [];
    this.changes = [];
    this.seq = 0;
    this.acting = false;
    this.watchers = [];
    this.timer = null;
    this.pending = new Map(); // debounced events
    this.appliedSeen = new Map(); // seq -> when this computer first saw the host had saved it
    this.sharedStamp = null;
  }

  get peoplePath() {
    return peopleDir(this.dataDir);
  }

  personPath(id) {
    return path.join(this.peoplePath, `${id}.json`);
  }

  changesPath(id) {
    return path.join(this.peoplePath, `${id}.changes.json`);
  }

  open(dataDir, { isHost, hostSince }) {
    this.close();
    this.dataDir = dataDir;
    this.me = {
      id: this.identity.id,
      name: this.identity.name,
      computer: os.hostname(),
      role: isHost ? "host" : "editor",
      hostSince: isHost ? hostSince : null,
      open: true,
      seen: null,
    };
    const saved = readJson(this.changesPath(this.me.id), {});
    this.changes = Array.isArray(saved.changes) ? saved.changes : [];
    // Never reuse a number the host has already seen, even if this
    // computer's changes file went missing.
    const appliedSeq = this.readApplied().people[this.me.id]?.seq || 0;
    this.seq = Math.max(saved.seq || 0, appliedSeq, ...this.changes.map((c) => c.seq));
    this.writePresence();
    this.refresh();
    this.sharedStamp = this.stampShared();

    const watch = (dir) => {
      try {
        const watcher = fs.watch(dir, (event, name) => this.onFileChange(dir, name));
        watcher.on("error", () => {}); // the folder went away; the tick keeps checking
        this.watchers.push(watcher);
      } catch {
        // Not watchable right now; the tick covers it.
      }
    };
    fs.mkdirSync(this.peoplePath, { recursive: true });
    watch(this.dataDir);
    watch(this.peoplePath);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  // Marks this computer as gone and stops watching.
  close() {
    if (!this.dataDir) return;
    clearInterval(this.timer);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.me.open = false;
    try {
      this.writePresence();
    } catch {
      // The data folder may be unavailable; others see this computer leave after ACTIVE_MS.
    }
    this.dataDir = null;
  }

  writePresence() {
    this.me.seen = new Date().toISOString();
    writeJson(this.personPath(this.me.id), this.me);
  }

  later(key, ms, fn) {
    clearTimeout(this.pending.get(key));
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        fn();
      }, ms)
    );
  }

  // Everyone using the folder, this computer first.
  people() {
    return this.me ? [this.me, ...this.others] : [];
  }

  refresh() {
    this.others = readPeople(this.dataDir).filter((p) => p.id !== this.me.id);
  }

  setActing(acting) {
    this.acting = acting;
  }

  setRole(isHost, hostSince) {
    this.me.role = isHost ? "host" : "editor";
    this.me.hostSince = isHost ? hostSince : null;
    this.writePresence();
  }

  setName(name) {
    this.identity.name = name;
    this.me.name = name;
    this.writePresence();
  }

  // ---- the changes this computer has made (for db/store.js) ----

  get journal() {
    const team = this;
    return {
      get role() {
        return team.acting ? "host" : "editor";
      },
      append: (change) => team.append(change),
      pending: () => team.changes,
    };
  }

  // Changes made here that the host hasn't saved yet.
  unsavedCount() {
    const savedThrough = this.readApplied().people[this.me.id]?.seq || 0;
    return this.changes.filter((c) => c.seq > savedThrough).length;
  }

  append(change) {
    this.changes.push({ ...change, seq: ++this.seq, at: new Date().toISOString() });
    this.writeChanges();
    this.emit("changes");
  }

  writeChanges() {
    writeJson(this.changesPath(this.me.id), { seq: this.seq, changes: this.changes });
  }

  // Drops changes the host has saved. A saved change is kept laid on top a
  // little longer if the shared files that show it haven't reached this
  // computer yet -- `isReflected` says whether they have.
  trim(isReflected) {
    const savedThrough = this.readApplied().people[this.me.id]?.seq || 0;
    const now = Date.now();
    const keep = this.changes.filter((change) => {
      if (change.seq > savedThrough) return true;
      if (!this.appliedSeen.has(change.seq)) this.appliedSeen.set(change.seq, now);
      return !isReflected(change) && now - this.appliedSeen.get(change.seq) < KEEP_APPLIED_MS;
    });
    if (keep.length === this.changes.length) return false;
    this.changes = keep;
    this.writeChanges();
    return true;
  }

  // ---- the host's side ----

  readApplied() {
    const applied = readJson(path.join(peopleDir(this.dataDir), APPLIED_FILE), {});
    return { people: {}, ...applied };
  }

  writeApplied(applied) {
    writeJson(path.join(this.peoplePath, APPLIED_FILE), applied);
  }

  // Every computer's changes not yet saved, this computer's included (it may
  // have made some while another was host), oldest first.
  incoming() {
    const applied = this.readApplied();
    const names = new Map(this.people().map((p) => [p.id, p.name]));
    let files;
    try {
      files = fs.readdirSync(this.peoplePath);
    } catch {
      return [];
    }
    const todo = [];
    for (const file of files) {
      const match = CHANGES_FILE.exec(file);
      if (!match) continue;
      const personId = match[1];
      const changes = personId === this.me.id ? this.changes : readJson(path.join(this.peoplePath, file), {}).changes || [];
      const done = applied.people[personId]?.seq || 0;
      for (const change of changes) if (change.seq > done) todo.push({ ...change, personId, name: names.get(personId) || "someone" });
    }
    return todo.sort((a, b) => a.at.localeCompare(b.at) || a.personId.localeCompare(b.personId) || a.seq - b.seq);
  }

  // Records that `changes` were saved. The host's own are dropped at once:
  // the files it just wrote already show them.
  markApplied(changes) {
    const applied = this.readApplied();
    const now = new Date().toISOString();
    for (const change of changes) {
      const prior = applied.people[change.personId]?.seq || 0;
      applied.people[change.personId] = { seq: Math.max(prior, change.seq), at: now, name: change.name };
    }
    this.writeApplied(applied);
    const mine = changes.filter((c) => c.personId === this.me.id).map((c) => c.seq);
    if (mine.length) {
      const through = Math.max(...mine);
      this.changes = this.changes.filter((c) => c.seq > through);
      this.writeChanges();
    }
  }

  // ---- watching ----

  // When the host's files last changed, as far as this computer can see.
  stampShared() {
    let names;
    try {
      names = fs.readdirSync(this.dataDir).filter((n) => n.endsWith(".json"));
    } catch {
      return null;
    }
    const files = [...names.map((n) => path.join(this.dataDir, n)), path.join(this.peoplePath, APPLIED_FILE)];
    return files
      .map((file) => {
        try {
          return `${path.basename(file)}:${fs.statSync(file).mtimeMs}`;
        } catch {
          return "";
        }
      })
      .join("|");
  }

  onFileChange(dir, name) {
    if (!this.dataDir || !name || name.endsWith(".tmp")) return;
    if (dir === this.peoplePath) {
      if (name === APPLIED_FILE) this.later("shared", 400, () => this.sharedChanged());
      else if ((PERSON_FILE.test(name) || CHANGES_FILE.test(name)) && !name.startsWith(this.me.id)) {
        this.later("people", 400, () => {
          this.refresh();
          this.emit("people");
        });
      }
    } else if (name.endsWith(".json")) {
      this.later("shared", 400, () => this.sharedChanged());
    }
  }

  sharedChanged() {
    if (!this.dataDir) return;
    this.sharedStamp = this.stampShared();
    this.emit("shared");
  }

  tick() {
    if (!this.dataDir) return;
    try {
      if (Date.now() - Date.parse(this.me.seen) >= HEARTBEAT_MS) this.writePresence();
    } catch {
      // Data folder unavailable for now; try again next tick.
    }
    this.refresh();
    this.emit("people");
    const stamp = this.stampShared();
    if (stamp !== this.sharedStamp) this.sharedChanged();
    this.emit("tick");
  }
}

module.exports = { ACTIVE_MS, peopleDir, readPeople, isActive, activeHosts, Team };
