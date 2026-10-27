"use strict";

// The mail server and website AB Apps shares with the office's apps. A
// manager sets them once on AB Apps' Mail and website page; AB Apps keeps
// them in its shared folder, which its identity file names while someone is
// signed in:
//
//   %APPDATA%\AB Apps\identity.json   { "version": 1, "dataDir", ... }
//   <dataDir>\shared\services.json     { "version": 1, "mail", "website" }
//
// Either part is null when AB Apps isn't installed, nobody is signed in, the
// manager hasn't set it, or the file can't be read -- and then this app uses
// its own settings, so it still works without AB Apps.

const fs = require("fs");
const path = require("path");

/** AB Apps' folder in AppData, or AB_APPS_PROFILE, which AB Apps also honors, for test runs. */
const identityDir = (appDataDir) => process.env.AB_APPS_PROFILE || path.join(appDataDir, "AB Apps");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null; // missing, mid-sync or damaged: the same as not shared
  }
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

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
  const identity = readJson(path.join(identityDir(appDataDir), "identity.json"));
  if (identity?.version !== 1 || !text(identity.dataDir)) return { mail: null, website: null };
  const services = readJson(path.join(identity.dataDir, "shared", "services.json"));
  if (services?.version !== 1) return { mail: null, website: null };
  return { mail: cleanMail(services.mail), website: cleanWebsite(services.website) };
}

module.exports = { sharedServices };
