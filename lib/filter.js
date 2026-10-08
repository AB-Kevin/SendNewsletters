"use strict";

// The fields a mailing can narrow its recipients by -- a person's own, and
// their household's address and number of newsletters, which main.js puts
// alongside each contact before filtering. Mail/Email aren't here -- those
// decide how someone gets a mailing, not whether.
const FILTER_FIELDS = ["orgName", "name", "email", "addressLine1", "addressLine2", "city", "state", "zip", "copies", "sourceBatch"];

function matchesRule(contact, rule) {
  const value = String(contact[rule.field] ?? "").toLowerCase();
  const target = String(rule.value ?? "").toLowerCase();
  switch (rule.op) {
    case "equals":
      return value === target;
    case "contains":
      return value.includes(target);
    case "notEmpty":
      return value.trim() !== "";
    case "empty":
      return value.trim() === "";
    case "in":
      return target
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .includes(value);
    default:
      return true;
  }
}

// A mailing's recipient selection: every rule must match (AND) -- simple and
// predictable, and enough for "this mailing only goes to Pennsylvania".
function filterContacts(contacts, rules) {
  const usable = (rules || []).filter((r) => FILTER_FIELDS.includes(r.field));
  if (usable.length === 0) return contacts;
  return contacts.filter((c) => usable.every((r) => matchesRule(c, r)));
}

module.exports = { filterContacts, FILTER_FIELDS };
