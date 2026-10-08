"use strict";

// Finds contacts on the mailing list that might be the same person,
// separate households that look like the same address, and organizations
// that might be the same church -- for a person to
// look over on the Duplicates page, since the list is pulled together from
// several sources that each spell people a little differently.
//
// Email addresses and street addresses count most, because names don't
// line up reliably (Bob on one list, Robert on another). A pair someone has
// marked "not duplicates" (or "keep separate") is never suggested again.

const rules = require("./contactRules");
const matching = require("./matching");

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

function eachPair(list, fn) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) fn(list[i], list[j]);
}

// Joins pairs that share a member into groups: if A looks like B and B like
// C, all three are shown together.
function groupPairs(pairs) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const { a, b } of pairs) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const groups = new Map();
  for (const pair of pairs) {
    const root = find(pair.a);
    if (!groups.has(root)) groups.set(root, { ids: new Set(), pairs: [] });
    const group = groups.get(root);
    group.ids.add(pair.a);
    group.ids.add(pair.b);
    group.pairs.push(pair);
  }
  return [...groups.values()].map((g) => ({ ids: [...g.ids], pairs: g.pairs }));
}

// At most this many people sharing a name with someone (and nothing to tell
// them apart) before the name is too common to say anything -- there are a
// lot of John Stoltzfuses.
const NAME_ONLY_LIMIT = 3;

// `dismissed` is a Set of pairKey()s marked as not duplicates / separate.
function findDuplicates(contacts, households, orgs, dismissed) {
  const householdById = new Map(households.map((h) => [h.id, h]));
  const streetOf = (c) => matching.streetKey(householdById.get(c.householdId));
  const pairs = new Map();
  const add = (a, b, reason) => {
    const key = pairKey(a.id, b.id);
    if (dismissed.has(key)) return;
    if (!pairs.has(key)) pairs.set(key, { a: a.id, b: b.id, reasons: [] });
    if (!pairs.get(key).reasons.includes(reason)) pairs.get(key).reasons.push(reason);
  };

  // Same email address. Each person on the list is meant to have their own,
  // so two contacts sharing one are worth a look even with different names.
  for (const group of groupBy(contacts.filter((c) => rules.isValidEmail(c.email)), (c) => matching.normalizeEmail(c.email))) {
    eachPair(group, (a, b) => add(a, b, "email"));
  }

  // Same street address and names that could be the same person (Bob /
  // Robert, J / John). Different names at one address are a household, not
  // a duplicate.
  for (const group of groupBy(contacts, streetOf)) {
    eachPair(group, (a, b) => {
      if (a.name && b.name && matching.namesSimilar(a.name, b.name)) add(a, b, "address");
    });
  }

  // The same name where nothing disagrees and one fills in what the other
  // is missing -- typically a signup-form entry (name and email) for
  // someone already on the mailing list by address.
  const nameOnly = [];
  for (const group of groupBy(contacts.filter((c) => c.name), (c) => matching.nameParts(c.name).last)) {
    eachPair(group, (a, b) => {
      if (!matching.namesSimilar(a.name, b.name)) return;
      const emailA = rules.isValidEmail(a.email) ? matching.normalizeEmail(a.email) : "";
      const emailB = rules.isValidEmail(b.email) ? matching.normalizeEmail(b.email) : "";
      const streetA = streetOf(a) || "";
      const streetB = streetOf(b) || "";
      const conflict = (emailA && emailB && emailA !== emailB) || (streetA && streetB && streetA !== streetB);
      const fillsIn = !!emailA !== !!emailB || !!streetA !== !!streetB;
      if (!conflict && fillsIn) nameOnly.push([a, b]);
    });
  }
  const nameOnlyCount = new Map();
  for (const [a, b] of nameOnly) {
    nameOnlyCount.set(a.id, (nameOnlyCount.get(a.id) || 0) + 1);
    nameOnlyCount.set(b.id, (nameOnlyCount.get(b.id) || 0) + 1);
  }
  for (const [a, b] of nameOnly) {
    if (nameOnlyCount.get(a.id) <= NAME_ONLY_LIMIT && nameOnlyCount.get(b.id) <= NAME_ONLY_LIMIT) add(a, b, "name");
  }

  // Separate households at what looks like one address ("123 Main St" and
  // "123 Main Street, Apt 2" vs no apartment). Two apartments with different
  // numbers in the same building aren't suggested.
  const householdPairs = [];
  for (const group of groupBy(households, (h) => matching.streetKey(h))) {
    eachPair(group, (a, b) => {
      const unitA = matching.normalizeAddress(a.addressLine2);
      const unitB = matching.normalizeAddress(b.addressLine2);
      if (unitA && unitB && unitA !== unitB) return;
      if (!dismissed.has(pairKey(a.id, b.id))) householdPairs.push({ a: a.id, b: b.id });
    });
  }

  // Organizations that might be the same church: the same street address,
  // or one name inside the other ("Maple Grove" / "Maple Grove Mennonite").
  // Names that differ only in "The" or "Church" are already one organization.
  const orgPairs = new Map();
  const addOrg = (a, b, reason) => {
    const key = pairKey(a.id, b.id);
    if (dismissed.has(key)) return;
    if (!orgPairs.has(key)) orgPairs.set(key, { a: a.id, b: b.id, reasons: [] });
    if (!orgPairs.get(key).reasons.includes(reason)) orgPairs.get(key).reasons.push(reason);
  };
  for (const group of groupBy(orgs, (o) => matching.streetKey(o))) eachPair(group, (a, b) => addOrg(a, b, "orgAddress"));
  const named = orgs.map((o) => ({ org: o, key: matching.orgKey(o.name) })).filter((o) => o.key.length >= 4);
  eachPair(named, (a, b) => {
    const contains = (x, y) => ` ${x} `.includes(` ${y} `);
    if (contains(a.key, b.key) || contains(b.key, a.key)) addOrg(a.org, b.org, "orgName");
  });

  return {
    duplicates: groupPairs([...pairs.values()]),
    sharedAddresses: groupPairs(householdPairs).map((g) => ({ householdIds: g.ids })),
    orgDuplicates: groupPairs([...orgPairs.values()]),
  };
}

module.exports = { findDuplicates, pairKey };
