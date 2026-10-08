"use strict";

const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");
const XLSX = require("xlsx");
const { randomUUID } = require("crypto");
const rules = require("./contactRules");
const matching = require("./matching");

// What a column in an imported file can be brought in as. First/middle/last
// name aren't stored on their own -- they're joined into the person's name
// -- since member lists usually split the name and church lists usually
// don't. The plain Email/Mail/Number of newsletters columns apply to the
// newsletters ticked for the import; each newsletter also has its own, for a
// file that says which newsletter is which (like this app's own export).
// `group` is the heading the option is listed under.
function importTargets(publications) {
  return [
    { value: "", label: "Don't import" },
    { value: "name", label: "Name (full)" },
    { value: "firstName", label: "First name" },
    { value: "middleName", label: "Middle name" },
    { value: "lastName", label: "Last name" },
    { value: "orgName", label: "Organization" },
    { value: "email", label: "Email address" },
    { value: "addressLine1", label: "Address line 1" },
    { value: "addressLine2", label: "Address line 2" },
    { value: "city", label: "City" },
    { value: "state", label: "State" },
    { value: "zip", label: "ZIP" },
    { value: "sendByEmail", label: "Email (yes/no)", group: "For the newsletters ticked below" },
    { value: "sendByMail", label: "Mail (yes/no)", group: "For the newsletters ticked below" },
    { value: "delivery", label: "Mail / Email / Both", group: "For the newsletters ticked below" },
    { value: "copies", label: "Number of copies", group: "For the newsletters ticked below" },
    ...publications.flatMap((p) => [
      { value: `email:${p.id}`, label: `${p.name}: Email (yes/no)`, group: p.name },
      { value: `mail:${p.id}`, label: `${p.name}: Mail (yes/no)`, group: p.name },
      { value: `delivery:${p.id}`, label: `${p.name}: Mail / Email / Both`, group: p.name },
      { value: `copies:${p.id}`, label: `${p.name}: Number of copies`, group: p.name },
    ]),
  ];
}
const NAME_PART_TARGETS = ["firstName", "middleName", "lastName"];
const TEXT_TARGETS = new Set(["name", ...NAME_PART_TARGETS, "orgName", "email", ...rules.ADDRESS_FIELDS]);

// How someone new to a newsletter gets it when the file has no Mail/Email
// column to say so -- or, with options.replaceDelivery, everyone in the file.
const DELIVERY_DEFAULTS = [
  { value: "auto", label: "By email if they have an email address, otherwise by mail" },
  { value: "mail", label: "By mail (everyone with a mailing address)" },
  { value: "email", label: "By email (everyone with an email address)" },
  { value: "both", label: "Both — mail and email, wherever we have the address for it" },
];

// Reads a .csv/.tsv or .xlsx/.xls file into { headers, rows } where rows is
// an array of plain objects keyed by header text.
function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") {
    // Excel's "CSV UTF-8" starts with a byte-order mark, which would
    // otherwise end up stuck to the first header's name.
    const text = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
    const result = Papa.parse(text, { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
    return { headers: result.meta.fields || [], rows: result.data };
  }
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // raw: false takes each cell as Excel displays it, so a ZIP formatted
  // "00000" keeps its leading zero and a count reads "15", not 15.0000001.
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

// A cell saying how someone gets a newsletter, in words: "Mail", "Email",
// "Both", "Mail & Email", "None". { mail, email } for one of those, null for
// a blank (which says nothing), undefined for anything else.
function parseDelivery(value) {
  const t = String(value ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^(none|neither|nothing|unsubscribed?|stop)$/.test(t)) return { mail: false, email: false };
  if (/\bboth\b/.test(t)) return { mail: true, email: true };
  const email = /e-?mail/.test(t);
  const mail = /(^|[^a-z-])(mail|mailed|post|postal|paper|print|printed|usps)\b/.test(t);
  return mail || email ? { mail, email } : undefined;
}

function sampleValues(rows, header, limit = 25) {
  const values = [];
  for (const row of rows) {
    const value = String(row[header] ?? "").trim();
    if (value) values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function normalizeHeader(header) {
  return String(header).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Best guess at what one column is, from its header and a few of its values
// (to tell an "Email" column of x's from one of addresses). Covers the
// header styles in the office's existing lists: "First Name / Last Name /
// Address 1 / Church Name", the "Name / PrimaryAddressLine1 / PrimaryZip"
// export, Gravity Forms' "Name (First)", and this app's own export, where a
// newsletter's columns are headed with its name ("Our Health: Mail").
function guessTarget(header, samples, publications) {
  const h = normalizeHeader(header);
  const flagLike = samples.length > 0 && samples.every(rules.looksLikeFlag);
  const numeric = samples.length > 0 && samples.every((s) => /^\d+(\.\d+)?$/.test(s));
  const deliveryLike = samples.length > 0 && !flagLike && samples.every((s) => parseDelivery(s));
  const among = (...names) => names.includes(h);

  for (const p of publications) {
    const name = normalizeHeader(p.name);
    if (!name || !h.includes(name)) continue;
    const rest = h.replace(name, "");
    if (deliveryLike) return `delivery:${p.id}`;
    if (rest.includes("email")) return `email:${p.id}`;
    if (rest.includes("mail")) return `mail:${p.id}`;
    if (/(copies|copy|qty|quantity|count|newsletters)/.test(rest) || (!rest && numeric)) return `copies:${p.id}`;
  }
  if (deliveryLike) return "delivery";
  if (h.includes("email")) {
    if (flagLike || /^(send|by|via|get|gets|receive|receives)/.test(h)) return "sendByEmail";
    return "email";
  }
  if (
    among("copies", "copy", "quantity", "qty", "newsletters", "count", "bundle", "bundlesize") ||
    h.includes("copies") ||
    h.includes("quantity") ||
    h.includes("qty") ||
    (h.includes("newsletter") && numeric)
  ) {
    return "copies";
  }
  if (
    among("mail", "bymail", "sendbymail", "mailed", "paper", "print", "printed", "postal", "usmail", "getsmail", "mailcopy") ||
    (h.includes("mail") && !h.includes("address") && flagLike)
  ) {
    return "sendByMail";
  }
  if (
    among("org", "orgname", "organisation", "company", "companyname", "business", "agency", "group", "groupname") ||
    h.includes("organization") ||
    h.includes("church") ||
    h.includes("congregation")
  ) {
    return "orgName";
  }
  // "...name" checks cover Gravity Forms' sub-field labels too, which come
  // through as "Name (First)", "Address (City)" and so on.
  if (among("firstname", "first", "fname", "givenname") || (h.includes("first") && h.includes("name"))) return "firstName";
  if (among("middlename", "middle", "mi", "middleinitial") || (h.includes("middle") && h.includes("name"))) return "middleName";
  if (among("lastname", "last", "lname", "surname", "familyname") || (h.includes("last") && h.includes("name"))) return "lastName";
  if (among("name", "fullname", "contactname", "recipient", "recipientname", "person", "membername", "attention", "attn", "rep")) return "name";
  if (h.includes("country")) return "";
  if (h.endsWith("city") || among("town")) return "city";
  if (h.endsWith("state") || h.includes("stateprovince") || among("st", "province")) return "state";
  if (h.includes("zip") || h.includes("postalcode") || among("postcode")) return "zip";
  if (among("apt", "suite", "unit", "street2", "addr2") || (h.includes("address") && /(2|line2)$/.test(h))) return "addressLine2";
  if (among("street", "streetaddress", "street1", "addr", "addr1") || h.includes("address")) return "addressLine1";
  return "";
}

// { [header]: target } for every column; a target is only guessed for the
// first column that looks like it, so two address-ish columns don't both
// land on Address line 1.
function guessMapping(headers, rows, publications) {
  const used = new Set();
  const mapping = {};
  for (const header of headers) {
    const target = guessTarget(header, sampleValues(rows, header), publications);
    mapping[header] = target && !used.has(target) ? target : "";
    if (target) used.add(target);
  }
  return mapping;
}

function normalizeZip(text) {
  const t = String(text).trim();
  if (/^\d{3,4}$/.test(t)) return t.padStart(5, "0"); // a ZIP Excel stored as a number
  if (/^\d{7,9}$/.test(t)) {
    const nine = t.padStart(9, "0");
    return `${nine.slice(0, 5)}-${nine.slice(5)}`;
  }
  return t;
}

// One row of the file. Text fields are only present when the cell has
// something in it. `pubs` holds what the row says about each newsletter,
// and `given` which of those the file actually has a column for (a blank in
// a Mail/Email column means "no"; a blank copies cell says nothing).
function readRow(row, mapping, tickedIds) {
  const v = {};
  const pubs = {};
  const given = {};
  const set = (pubId, field, value) => {
    pubs[pubId] = { ...pubs[pubId], [field]: value };
    given[pubId] = { ...given[pubId], [field]: true };
  };
  let copiesUnreadable = false;
  let deliveryUnreadable = false;
  const perPublication = [];
  for (const [header, target] of Object.entries(mapping)) {
    if (!target) continue;
    const text = String(row[header] ?? "").replace(/\s+/g, " ").trim();
    if (TEXT_TARGETS.has(target)) {
      if (text) v[target] = text; // two columns mapped to the same field: the last non-blank one wins
      continue;
    }
    const [kind, pubId] = target.includes(":") ? target.split(":") : [target, null];
    const values = [];
    if (kind === "delivery") {
      // One column for both: a blank says nothing, rather than "neither".
      const d = parseDelivery(text);
      if (d === undefined) deliveryUnreadable = true;
      if (!d) continue;
      values.push(["mail", d.mail], ["email", d.email]);
    } else {
      const field = { sendByEmail: "email", sendByMail: "mail", email: "email", mail: "mail", copies: "copies" }[kind];
      if (!field) continue;
      if (field === "copies") {
        const copies = rules.parseCopies(text);
        if (copies === null) {
          if (text) copiesUnreadable = true;
          continue;
        }
        values.push([field, copies]);
      } else values.push([field, rules.parseFlag(text)]);
    }
    // The plain columns go to every ticked newsletter; a newsletter's own
    // column, applied after, wins over them.
    for (const [field, value] of values) {
      if (pubId) perPublication.push([pubId, field, value]);
      else for (const id of tickedIds) set(id, field, value);
    }
  }
  for (const [pubId, field, value] of perPublication) set(pubId, field, value);
  if (!v.name) {
    const composed = NAME_PART_TARGETS.map((part) => v[part]).filter(Boolean).join(" ");
    if (composed) v.name = composed;
  }
  for (const part of NAME_PART_TARGETS) delete v[part];
  if (v.email) v.email = v.email.replace(/^mailto:/i, "");
  if (v.zip) v.zip = normalizeZip(v.zip);
  if (v.state && /^[a-z]{2}$/i.test(v.state)) v.state = v.state.toUpperCase();
  return { values: v, pubs, given, copiesUnreadable, deliveryUnreadable };
}

// ---- matching rows to people already on the list ----
// Same person = same name AND the same email or the same street address.
// Requiring the name to agree keeps two family members who share an email
// address or a house from being merged into one contact. Middle names have
// to agree (see matching.middlesAgree) but can be missing on one side.
// Anything less certain -- a nickname, a different name at the same email --
// comes in as a new contact, and the duplicate checker flags it for a person
// to decide. Organizations are matched by name alone ("The Maple Grove
// Mennonite Church" is "Maple Grove Mennonite").

function personKeys(person, address) {
  const { first, last, suffix } = matching.nameParts(person.name);
  if (!first) return [];
  const identity = `n:${first}|${last}|${suffix}`;
  const keys = [];
  const email = matching.normalizeEmail(person.email);
  if (email) keys.push(`${identity}|e:${email}`);
  const street = matching.streetKey(address);
  if (street) keys.push(`${identity}|a:${street}`);
  return keys;
}

function defaultDelivery(email, address, deliveryDefault) {
  const hasEmail = rules.isValidEmail(email);
  const hasAddress = rules.hasMailingAddress(address);
  switch (deliveryDefault) {
    case "mail":
      return { mail: hasAddress, email: false };
    case "email":
      return { mail: false, email: hasEmail };
    case "both":
      return { mail: hasAddress, email: hasEmail };
    default:
      return { mail: !hasEmail && hasAddress, email: hasEmail };
  }
}

// Whether two values for a field are the same thing written differently
// ("123 Main St" / "123 Main Street", "Smith, John" / "John Smith") -- so
// re-importing a list in another format doesn't rewrite every contact.
function sameValue(field, a, b) {
  switch (field) {
    case "name":
    case "attn":
      return matching.normalizeName(a) === matching.normalizeName(b);
    case "addressLine1":
    case "addressLine2":
      return matching.normalizeAddress(a) === matching.normalizeAddress(b);
    case "zip":
      return String(a || "").replace(/\D/g, "") === String(b || "").replace(/\D/g, "");
    default:
      return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  }
}

const BLANK_ADDRESS = { addressLine1: "", addressLine2: "", city: "", state: "", zip: "" };

function pickAddress(source) {
  return Object.fromEntries(rules.ADDRESS_FIELDS.map((f) => [f, source?.[f] || ""]));
}

// Fills in fields the row has, leaving the rest; a blank never erases.
function fillFields(target, values, fields) {
  for (const field of fields) {
    if (values[field] && !sameValue(field, values[field], target[field])) target[field] = values[field];
  }
}

function diff(before, after, fields) {
  const patch = {};
  for (const field of fields) {
    if (field === "subs" ? !rules.subsEqual(before.subs, after.subs) : (before[field] ?? null) !== (after[field] ?? null)) patch[field] = after[field];
  }
  return patch;
}

const withSub = (record, pubId, fields) => {
  record.subs = { ...(record.subs || {}), [pubId]: { ...(record.subs?.[pubId] || {}), ...fields } };
};

function summarize(person, household, org, publications) {
  return {
    name: person.name || "",
    orgName: org?.name || "",
    email: person.email || "",
    address: household
      ? [household.addressLine1, household.city, [household.state, household.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
      : "",
    gets: publications
      .filter((p) => rules.sub(person, p.id).email || rules.sub(household, p.id).mail || rules.coveredBy(org, p.id))
      .map((p) => p.name),
  };
}

// Works out what importing `rows` would do, without changing anything.
//
// options.mode is "person" (each row is a person) or "org" (each row is an
// organization, with any name in it as who the batch goes to). In person
// mode, a row with an organization but no person's name is the
// organization itself.
//
// options.publicationIds are the newsletters the file is a list for:
// everyone in it gets them, by the Mail/Email columns if there are any, or
// else by options.deliveryDefault -- except where their organization already
// gets that newsletter as a batch. Someone who already gets one keeps how
// they get it unless the file has a column saying otherwise -- or, with
// options.replaceDelivery, deliveryDefault replaces how every person in the
// file gets the ticked newsletters (for re-importing a list that went in the
// wrong way). Even then, someone whose organization gets a newsletter for
// them is left as they are, and so is anyone without the address it would
// take, rather than leaving them getting nothing.
//
// People at the same address (street, Address 2 and ZIP) share one
// household, so the address gets one bundle rather than one per person. A
// new person whose address is already on the list joins that household; Mail
// is then on if anyone's row says so, and the household's number of copies
// only goes up, never down, for a newcomer. A person already on the list
// whose row has a different street has moved: they move out on their own and
// the rest of their household stays put.
function planImport(rows, mapping, options, existing, publications) {
  const pubIds = new Set(publications.map((p) => p.id));
  const ticked = (options.publicationIds || []).filter((id) => pubIds.has(id));
  const defaultCopies = rules.parseCopies(options.defaultCopies) ?? 1;
  const orgMode = options.mode === "org";

  // Working copies of everything, as it would be after the rows so far.
  const wrap = (record) => ({ data: { ...record, subs: { ...(record.subs || {}) } }, original: record });
  const orgs = new Map(existing.orgs.map((o) => [o.id, wrap(o)]));
  const households = new Map(existing.households.map((h) => [h.id, wrap(h)]));
  const people = existing.contacts.map(wrap);

  const orgByKey = new Map();
  for (const o of orgs.values()) if (!orgByKey.has(matching.orgKey(o.data.name))) orgByKey.set(matching.orgKey(o.data.name), o);
  const findOrCreateOrg = (name) => {
    const key = matching.orgKey(name);
    if (!orgByKey.has(key)) {
      const o = { data: { id: randomUUID(), name, attn: "", email: "", ...BLANK_ADDRESS, subs: {}, sourceBatch: options.sourceBatch || "" }, original: null };
      orgs.set(o.data.id, o);
      orgByKey.set(key, o);
    }
    return orgByKey.get(key);
  };

  const membersOf = new Map();
  const members = (h) => {
    if (!membersOf.has(h.data.id)) membersOf.set(h.data.id, new Set());
    return membersOf.get(h.data.id);
  };
  for (const p of people) if (households.has(p.data.householdId)) members(households.get(p.data.householdId)).add(p);
  const originalMemberCount = new Map([...households.values()].map((h) => [h.data.id, members(h).size]));

  const householdAt = new Map();
  const indexHousehold = (h) => {
    const key = matching.addressKey(h.data);
    if (key && !householdAt.has(key)) householdAt.set(key, h);
  };
  households.forEach(indexHousehold);

  // Several people can share a key (two John Stoltzfuses at one address);
  // middle names settle which one a row is. A row that fits more than one of
  // them -- "John Stoltzfus" when the list has a John A and a John S there --
  // can't be placed, so it's skipped and counted rather than guessed at or
  // added as a third John.
  const personIndex = new Map();
  const indexPerson = (p) => {
    for (const key of personKeys(p.data, households.get(p.data.householdId)?.data)) {
      if (!personIndex.has(key)) personIndex.set(key, []);
      if (!personIndex.get(key).includes(p)) personIndex.get(key).push(p);
    }
  };
  people.forEach(indexPerson);
  const AMBIGUOUS = {};
  const findPerson = (values) => {
    const found = new Set();
    for (const key of personKeys(values, values)) {
      for (const p of personIndex.get(key) || []) if (matching.middlesAgree(p.data.name, values.name)) found.add(p);
    }
    return found.size > 1 ? AMBIGUOUS : found.values().next().value || null;
  };

  const newHousehold = () => {
    const h = { data: { id: randomUUID(), ...BLANK_ADDRESS, subs: {} }, original: null };
    households.set(h.data.id, h);
    return h;
  };

  const stats = {
    rowsRead: rows.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    ambiguous: 0,
    unreadableCopies: 0,
    unreadableDelivery: 0,
    householdJoins: 0,
    replaceCovered: 0,
    replaceNoAddress: 0,
    orgsAdded: 0,
    orgsUpdated: 0,
    starting: {},
  };
  const ambiguousNames = [];
  const noAddressNames = [];
  const replaceCovered = new Set();
  const replaceNoAddress = new Set();
  const matched = new Set();
  const inFile = new Set();
  const gettingBefore = new Map();
  const pubsFor = (parsed) => [...new Set([...ticked, ...Object.keys(parsed.given).filter((id) => pubIds.has(id))])];

  const parsedRows = rows.map((row) => readRow(row, mapping, ticked));
  const isOrgRow = (v) => orgMode || (!v.name && !!v.orgName);

  // Organizations first, so it's known which newsletters they get as a
  // batch before deciding what their members get.
  for (const parsed of parsedRows.filter((r) => isOrgRow(r.values))) {
    const { values: v } = parsed;
    if (!v.orgName) {
      if (v.name || v.email || v.addressLine1) stats.skipped++;
      continue;
    }
    if (parsed.copiesUnreadable) stats.unreadableCopies++;
    if (parsed.deliveryUnreadable) stats.unreadableDelivery++;
    const org = findOrCreateOrg(v.orgName);
    fillFields(org.data, { ...v, attn: orgMode ? v.name : undefined }, ["attn", "email", ...rules.ADDRESS_FIELDS]);
    for (const pubId of pubsFor(parsed)) {
      const given = parsed.given[pubId] || {};
      const before = rules.sub(org.data, pubId);
      const fields = {};
      if (given.mail) fields.mail = parsed.pubs[pubId].mail;
      if (given.email) fields.email = parsed.pubs[pubId].email;
      if (given.copies) fields.copies = parsed.pubs[pubId].copies;
      if (!before.mail && !before.email && !given.mail && !given.email && ticked.includes(pubId)) {
        // A batch, if there's an address to send it to.
        if (rules.hasMailingAddress(org.data)) fields.mail = true;
        else if (rules.isValidEmail(org.data.email)) fields.email = true;
      }
      withSub(org.data, pubId, fields);
      if (org.data.subs[pubId].mail && org.data.subs[pubId].copies === undefined) org.data.subs[pubId].copies = defaultCopies;
    }
  }

  const covered = (person, pubId) => rules.coveredBy(orgs.get(person.data.orgId)?.data, pubId);
  const gets = (person, pubId) =>
    !!rules.sub(person.data, pubId).email || !!rules.sub(households.get(person.data.householdId)?.data, pubId).mail || covered(person, pubId);

  for (const parsed of parsedRows.filter((r) => !isOrgRow(r.values))) {
    const { values } = parsed;
    if (!values.name && !values.email && !values.addressLine1) {
      stats.skipped++;
      continue;
    }
    if (parsed.copiesUnreadable) stats.unreadableCopies++;
    if (parsed.deliveryUnreadable) stats.unreadableDelivery++;

    let person = findPerson(values);
    if (person === AMBIGUOUS) {
      stats.ambiguous++;
      if (ambiguousNames.length < 10) ambiguousNames.push(values.name);
      continue;
    }
    const isNew = !person;
    if (isNew) {
      person = { data: { id: randomUUID(), name: "", email: "", orgId: null, householdId: null, subs: {}, sourceBatch: options.sourceBatch || "" }, original: null };
      people.push(person);
    } else if (person.original) {
      matched.add(person);
    }
    if (!gettingBefore.has(person)) gettingBefore.set(person, new Set(publications.filter((p) => gets(person, p.id)).map((p) => p.id)));
    inFile.add(person);

    // Their own fields. A blank cell never erases what's there, and a
    // matched name only changes to add detail ("John A" -> "John Amos").
    for (const field of rules.PERSON_TEXT_FIELDS) {
      const was = person.data[field];
      if (!values[field] || sameValue(field, values[field], was)) continue;
      if (field === "name" && was && matching.nameParts(values.name).middle.length <= matching.nameParts(was).middle.length) continue;
      person.data[field] = values[field];
    }
    if (values.orgName) person.data.orgId = findOrCreateOrg(values.orgName).data.id;

    // Where they live.
    const current = households.get(person.data.householdId) || null;
    let home = current;
    let mode = "member";
    if (rules.ADDRESS_FIELDS.some((f) => values[f])) {
      const given = Object.fromEntries(rules.ADDRESS_FIELDS.filter((f) => values[f]).map((f) => [f, values[f]]));
      const sameStreet = current && (!values.addressLine1 || matching.normalizeAddress(values.addressLine1) === matching.normalizeAddress(current.data.addressLine1));
      const address = sameStreet ? { ...pickAddress(current.data), ...given } : { ...BLANK_ADDRESS, ...given };
      // Their own household first: two kept-separate households can share an
      // address, and a row for one of them shouldn't move them into the other.
      const key = matching.addressKey(address);
      const there = key && current && key === matching.addressKey(current.data) ? current : key ? householdAt.get(key) : null;
      if (current && (there === current || (!there && (sameStreet || members(current).size === 1)))) {
        mode = "member"; // same place, or they live alone and the household moves with them
      } else if (there) {
        home = there;
        mode = "joining";
      } else {
        home = newHousehold();
        mode = "new";
      }
      if (home !== current) {
        if (current) members(current).delete(person);
        if (members(home).size > 0) stats.householdJoins++;
        members(home).add(person);
        person.data.householdId = home.data.id;
      }
      fillFields(home.data, address, rules.ADDRESS_FIELDS);
      indexHousehold(home);
    }

    // Their newsletters.
    for (const pubId of pubsFor(parsed)) {
      const given = parsed.given[pubId] || {};
      const row = parsed.pubs[pubId] || {};
      const getting = gets(person, pubId);
      if (given.email) withSub(person.data, pubId, { email: row.email });
      if (home && (given.mail || given.copies)) {
        const hs = rules.sub(home.data, pubId);
        const fields = {};
        if (given.mail) fields.mail = mode === "joining" ? !!hs.mail || row.mail : row.mail;
        if (given.copies) fields.copies = mode === "joining" ? Math.max(Number(hs.copies) || 0, row.copies) : row.copies;
        withSub(home.data, pubId, fields);
      }
      if (options.replaceDelivery && ticked.includes(pubId) && !(given.email && given.mail)) {
        // Replacing how they get it with deliveryDefault, for whichever of
        // mail and email the file doesn't have a column for.
        const d = defaultDelivery(person.data.email, home?.data, options.deliveryDefault);
        if (covered(person, pubId)) replaceCovered.add(person);
        else if (!given.email && !given.mail && !d.email && !d.mail) {
          if (!replaceNoAddress.has(person) && noAddressNames.length < 10) noAddressNames.push(person.data.name || values.email || "(no name)");
          replaceNoAddress.add(person);
        } else {
          if (!given.email) withSub(person.data, pubId, { email: d.email });
          // Someone joining a household doesn't stop its mail.
          if (home && !given.mail && (d.mail || mode !== "joining")) withSub(home.data, pubId, { mail: d.mail });
        }
      } else if (ticked.includes(pubId) && !given.email && !given.mail && !getting && !covered(person, pubId)) {
        // Signing someone up for a ticked newsletter they don't get yet --
        // unless their organization gets it for them.
        const d = defaultDelivery(person.data.email, home?.data, options.deliveryDefault);
        if (d.email) withSub(person.data, pubId, { email: true });
        if (d.mail && home) withSub(home.data, pubId, { mail: true });
      }
      if (home && rules.sub(home.data, pubId).mail && home.data.subs[pubId].copies === undefined) home.data.subs[pubId].copies = defaultCopies;
    }
    indexPerson(person);
  }

  // What changed, as rows to write.
  const out = { orgInserts: [], orgUpdates: [], householdInserts: [], householdUpdates: [], householdDeletes: [], contactInserts: [], contactUpdates: [] };
  for (const o of orgs.values()) {
    if (!o.original) {
      out.orgInserts.push(o.data);
      stats.orgsAdded++;
    } else {
      const patch = diff(o.original, o.data, ["attn", "email", ...rules.ADDRESS_FIELDS, "subs"]);
      if (Object.keys(patch).length) {
        out.orgUpdates.push({ id: o.data.id, patch });
        stats.orgsUpdated++;
      }
    }
  }
  for (const h of households.values()) {
    const count = members(h).size;
    if (!h.original) {
      if (count) out.householdInserts.push(h.data);
    } else if (!count && originalMemberCount.get(h.data.id) > 0) {
      out.householdDeletes.push(h.data.id);
    } else {
      const patch = diff(h.original, h.data, [...rules.ADDRESS_FIELDS, "subs"]);
      if (Object.keys(patch).length) out.householdUpdates.push({ id: h.data.id, patch });
    }
  }
  const PERSON_DIFF = [...rules.PERSON_TEXT_FIELDS, "orgId", "householdId", "subs"];
  for (const p of people) {
    if (!p.original) out.contactInserts.push(p.data);
    else {
      const patch = diff(p.original, p.data, PERSON_DIFF);
      if (Object.keys(patch).length) out.contactUpdates.push({ id: p.data.id, patch });
    }
  }

  // Who starts getting each newsletter, by any route.
  for (const p of inFile) {
    for (const pub of publications) {
      if (gets(p, pub.id) && !gettingBefore.get(p).has(pub.id)) stats.starting[pub.id] = (stats.starting[pub.id] || 0) + 1;
    }
  }

  const changedHouseholds = new Map(out.householdUpdates.map((u) => [u.id, u.patch]));
  const pubName = new Map(publications.map((p) => [p.id, p.name]));
  const originalHousehold = new Map(existing.households.map((h) => [h.id, h]));
  const originalOrg = new Map(existing.orgs.map((o) => [o.id, o]));
  const matches = [];
  for (const p of matched) {
    const own = diff(p.original, p.data, PERSON_DIFF);
    const changed = [];
    if (own.name !== undefined) changed.push("name");
    if (own.email !== undefined) changed.push("email");
    if ("orgId" in own) changed.push("orgName");
    if ("householdId" in own) changed.push("household");
    else for (const field of Object.keys(changedHouseholds.get(p.data.householdId) || {})) if (field !== "subs") changed.push(field);
    // A newsletter changed if they start or stop getting it, or how they get
    // it changed (their own email, or their household's mail or copies).
    const subChanged = (a, b, id) => !rules.subsEqual({ [id]: a?.subs?.[id] }, { [id]: b?.subs?.[id] });
    const sameHome = p.original.householdId === p.data.householdId;
    const homeNow = households.get(p.data.householdId)?.data;
    const homeBefore = originalHousehold.get(p.original.householdId);
    for (const pub of publications) {
      const startedOrStopped = gettingBefore.get(p).has(pub.id) !== gets(p, pub.id);
      if (startedOrStopped || subChanged(p.original, p.data, pub.id) || (sameHome && subChanged(homeBefore, homeNow, pub.id))) changed.push(`pub:${pubName.get(pub.id)}`);
    }
    const unique = [...new Set(changed)];
    if (unique.length) stats.updated++;
    else stats.unchanged++;
    matches.push({
      existing: summarize(p.original, originalHousehold.get(p.original.householdId), originalOrg.get(p.original.orgId), publications),
      incoming: summarize(p.data, households.get(p.data.householdId)?.data, orgs.get(p.data.orgId)?.data, publications),
      changedFields: unique,
    });
  }
  stats.added = out.contactInserts.length;
  stats.replaceCovered = replaceCovered.size;
  stats.replaceNoAddress = replaceNoAddress.size;

  return {
    ...out,
    matches,
    stats,
    ambiguousNames,
    noAddressNames,
    // Everything as it would be afterwards, for checking the result for
    // possible duplicates before anything is written.
    after: {
      contacts: people.map((p) => p.data),
      households: [...households.values()].filter((h) => members(h).size).map((h) => h.data),
      orgs: [...orgs.values()].map((o) => o.data),
    },
  };
}

module.exports = {
  importTargets,
  DELIVERY_DEFAULTS,
  parseFile,
  guessMapping,
  planImport,
  parseDelivery,
  sampleValues,
  normalizeZip,
};
