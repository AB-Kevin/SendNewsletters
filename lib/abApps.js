"use strict";

// What this app takes from AB Apps, the office's launcher, which signs
// people in once for every app. While someone is signed in, AB Apps keeps
// who it is in this Windows account's AppData:
//
//   %APPDATA%\AB Apps\identity.json
//   { "version": 1, "personId", "name", "class", "signedInAt", "dataDir" }
//
// and the mail server and website a manager set on its Mail and website
// page in its shared folder:
//
//   <dataDir>\shared\services.json   { "version": 1, "mail", "website" }
//
// Each is null when AB Apps isn't installed, nobody is signed in, a manager
// hasn't set it, or the file can't be read -- and then this app uses its own
// settings, so it still works without AB Apps. Like AB Apps' PIN, this is a
// convenience, not a security boundary.

const fs = require("fs");
const path = require("path");

const CLASSES = ["manager", "employee", "contractor"];

/** AB Apps' folder in AppData, or AB_APPS_PROFILE, which AB Apps also honors, for test runs. */
const identityDir = (appDataDir) => process.env.AB_APPS_PROFILE || path.join(appDataDir, "AB Apps");
const identityPath = (appDataDir) => path.join(identityDir(appDataDir), "identity.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null; // missing, mid-sync or damaged: the same as not there
  }
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** Who is signed in to AB Apps: { personId, name, class, dataDir }, or null. */
function readIdentity(appDataDir) {
  const identity = readJson(identityPath(appDataDir));
  if (identity?.version !== 1) return null;
  const name = text(identity.name);
  if (!/^[0-9a-f-]{36}$/i.test(identity.personId ?? "") || !name || name.length > 80) return null;
  if (!CLASSES.includes(identity.class) || !text(identity.dataDir)) return null;
  return { personId: identity.personId, name, class: identity.class, dataDir: identity.dataDir };
}

/**
 * Calls onChange(identity) when someone signs in to AB Apps, signs out, or is
 * renamed, checking every two seconds. Returns a function that stops it.
 */
function watchIdentity(appDataDir, onChange) {
  const file = identityPath(appDataDir);
  let last = JSON.stringify(readIdentity(appDataDir));
  const check = () => {
    const next = readIdentity(appDataDir);
    if (JSON.stringify(next) === last) return;
    last = JSON.stringify(next);
    onChange(next);
  };
  fs.watchFile(file, { interval: 2000 }, check);
  return () => fs.unwatchFile(file, check);
}

function cleanMail(mail) {
  const port = Number(mail?.port);
  if (!text(mail?.host) || !text(mail?.fromEmail) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: text(mail.host), port, secure: mail.secure === true, fromName: text(mail.fromName), fromEmail: text(mail.fromEmail) };
}

function cleanWebsite(website) {
  const siteUrl = text(website?.siteUrl).replace(/\/+$/, "");
  if (!/^https:\/\//i.test(siteUrl) || !text(website?.consumerKey) || !text(website?.consumerSecret)) return null;
  return { siteUrl, consumerKey: text(website.consumerKey), consumerSecret: text(website.consumerSecret) };
}

/** { mail, website } from AB Apps, each null when it isn't shared. `appDataDir` is app.getPath("appData"). */
function sharedServices(appDataDir) {
  const identity = readIdentity(appDataDir);
  if (!identity) return { mail: null, website: null };
  const services = readJson(path.join(identity.dataDir, "shared", "services.json"));
  if (services?.version !== 1) return { mail: null, website: null };
  return { mail: cleanMail(services.mail), website: cleanWebsite(services.website) };
}

module.exports = { identityPath, readIdentity, watchIdentity, sharedServices };
