"use strict";

// Rules about who gets which newsletter, shared by the main process (who a
// mailing goes to) and the Mailing List page (which cells to flag), so the
// two can't disagree. Loaded with require() in main and as a plain <script>
// in the renderer, where it's window.ContactRules.
//
// There are three kinds of recipient:
// - a person: their name and email, the organization they belong to (if
//   any), and which newsletters they get by email;
// - a household: an address shared by everyone who lives there, and which
//   newsletters it gets by mail and how many copies -- one bundle per
//   address, not one per person;
// - an organization (a church): its own address and email, and which
//   newsletters it gets as a batch, for its members.
//
// Each keeps its newsletters as `subs`: { [publicationId]: { email, mail,
// copies } } (a person only uses email; a household only mail and copies).
// A person whose organization gets a newsletter as a batch is "covered" for
// it: imports don't sign them up for their own copy, but they can still
// have one.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ContactRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PERSON_TEXT_FIELDS = ["name", "email"];
  const ORG_TEXT_FIELDS = ["name", "attn", "email"];
  const ADDRESS_FIELDS = ["addressLine1", "addressLine2", "city", "state", "zip"];
  const MAX_COPIES = 100000;

  // Deliberately loose -- just enough to catch a blank, a phone number, or
  // "N/A" sitting in the email column. The mail server is the real check.
  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  // Enough to put on an envelope: a street line plus a city or ZIP.
  function hasMailingAddress(place) {
    const has = (v) => String(v || "").trim() !== "";
    return !!place && has(place.addressLine1) && (has(place.city) || has(place.zip));
  }

  function sub(record, publicationId) {
    return record?.subs?.[publicationId] || {};
  }

  function copiesFor(record, publicationId) {
    const n = Number(sub(record, publicationId).copies);
    return Number.isFinite(n) ? n : 0;
  }

  // Whether a person, household or organization actually receives a
  // newsletter -- checked, and with what it takes to deliver it.
  function getsEmail(record, publicationId) {
    return !!sub(record, publicationId).email && isValidEmail(record.email);
  }

  function getsMail(place, publicationId) {
    return !!sub(place, publicationId).mail && hasMailingAddress(place) && copiesFor(place, publicationId) >= 1;
  }

  function coveredBy(org, publicationId) {
    return !!sub(org, publicationId).mail;
  }

  // What's wrong with how something is set up to get its newsletters, keyed
  // by the cell to flag ("email", "addressLine1", "copies:<publicationId>").
  // Getting nothing at all isn't a problem -- they've just been left off.
  function problems(record, publications, { email = true, mail = true } = {}) {
    const found = {};
    for (const p of publications) {
      const s = sub(record, p.id);
      if (email && s.email && !isValidEmail(record.email)) {
        found.email = `${p.name} is checked to go by email, but this isn't a usable email address.`;
      }
      if (mail && s.mail && !hasMailingAddress(record)) {
        found.addressLine1 = `${p.name} is checked to go by mail, but the address is incomplete (needs a street and a city or ZIP).`;
      }
      if (mail && s.mail && copiesFor(record, p.id) < 1) found[`copies:${p.id}`] = `${p.name} is checked to go by mail, but the number of copies is 0.`;
    }
    return found;
  }

  // Who an address label is to: "John & Mary Stoltzfus" when they share a
  // last name, otherwise everyone's name in full; someone with no name is
  // listed by their organization.
  function addresseeOf(members) {
    const names = members.map((m) => String(m.name || "").trim()).filter(Boolean);
    if (!names.length) return [...new Set(members.map((m) => m.orgName).filter(Boolean))].join(" & ");
    const split = names.map((n) => {
      const words = n.split(/\s+/);
      return { first: words.slice(0, -1).join(" "), last: words[words.length - 1] };
    });
    const sameLast = names.length > 1 && split.every((s) => s.first && s.last.toLowerCase() === split[0].last.toLowerCase());
    const join = (list) => (list.length <= 2 ? list.join(" & ") : `${list.slice(0, -1).join(", ")} & ${list[list.length - 1]}`);
    return sameLast ? `${join(split.map((s) => s.first))} ${split[0].last}` : join(names);
  }

  // Yes/no cells from a spreadsheet ("x", "Yes", "TRUE", "1", a check mark).
  // Anything not recognizably "no" counts as yes, so a column of x's and
  // blanks works however the x's were typed.
  const FALSE_WORDS = new Set(["", "no", "n", "false", "f", "0", "none", "-", "off", "unchecked"]);
  function parseFlag(value) {
    if (typeof value === "boolean") return value;
    return !FALSE_WORDS.has(String(value ?? "").trim().toLowerCase());
  }

  // True when a cell is plainly meant as yes/no rather than holding, say, an
  // email address -- used to tell a "Mail" checkbox column from a "Mailing
  // address" column when guessing import mappings.
  const FLAG_WORDS = new Set([...FALSE_WORDS, "yes", "y", "true", "t", "1", "x", "✓", "✔", "on", "checked"]);
  function looksLikeFlag(value) {
    return FLAG_WORDS.has(String(value ?? "").trim().toLowerCase());
  }

  // A whole number of copies, or null when the cell doesn't hold one
  // (blank, "N/A") -- callers then keep whatever was there before. Reads the
  // first number in the cell, so "15 copies" and Excel's "15.0" both work.
  function parseCopies(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), MAX_COPIES) : null;
    const match = String(value ?? "").match(/\d+(\.\d+)?/);
    if (!match) return null;
    return Math.min(Math.round(Number(match[0])), MAX_COPIES);
  }

  // An organization's name for telling whether two are the same church:
  // "The Maple Grove Mennonite Church" and "Maple Grove Mennonite" agree.
  const ORG_FILLER_WORDS = new Set(["the", "church", "congregation"]);
  function orgKey(name) {
    const words = String(name || "")
      .toLowerCase()
      .replace(/\band\b/g, "&")
      .replace(/[^\p{L}\p{N}&\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
    const core = words.filter((w) => !ORG_FILLER_WORDS.has(w));
    return (core.length ? core : words).join(" ");
  }

  // Two subscriptions mean the same thing: unchecked is unchecked whether
  // it was ever set, and the copy count only matters while Mail is on.
  function subsEqual(a, b) {
    const ids = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const id of ids) {
      const x = a?.[id] || {};
      const y = b?.[id] || {};
      if (!!x.email !== !!y.email || !!x.mail !== !!y.mail) return false;
      if (x.mail && Number(x.copies || 0) !== Number(y.copies || 0)) return false;
    }
    return true;
  }

  return {
    PERSON_TEXT_FIELDS,
    ORG_TEXT_FIELDS,
    ADDRESS_FIELDS,
    MAX_COPIES,
    isValidEmail,
    hasMailingAddress,
    sub,
    copiesFor,
    getsEmail,
    getsMail,
    coveredBy,
    problems,
    addresseeOf,
    parseFlag,
    looksLikeFlag,
    parseCopies,
    subsEqual,
    orgKey,
  };
});
