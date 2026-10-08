"use strict";

const { orgKey } = require("./contactRules");

// Name, address and email comparison shared by the importer (is this row
// someone already on the list?) and the duplicate checker (which contacts
// might be the same person, and which households share an address?).

function normalizeName(value) {
  let t = String(value || "").toLowerCase().trim();
  const parts = t.split(",");
  if (parts.length === 2 && parts[0].trim() && parts[1].trim()) t = `${parts[1]} ${parts[0]}`; // "Smith, John"
  return t
    .replace(/\band\b/g, "&")
    .replace(/[^\p{L}\p{N}&\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

function nameParts(value) {
  const words = normalizeName(value).split(" ").filter(Boolean);
  const suffix = words.length > 2 && NAME_SUFFIXES.has(words[words.length - 1]) ? words.pop() : "";
  return { first: words[0] || "", middle: words.slice(1, -1).join(" "), last: words[words.length - 1] || "", suffix };
}

// Middle names agree when either is missing or they start with the same
// letter: "John Stoltzfus" can be "John A Stoltzfus", but "John A" and
// "John S" Stoltzfus -- a father and son on one farm, often enough -- can't.
function middlesAgree(a, b) {
  const x = nameParts(a).middle;
  const y = nameParts(b).middle;
  return !x || !y || x[0] === y[0];
}

const ADDRESS_WORDS = {
  street: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct", circle: "cir",
  boulevard: "blvd", highway: "hwy", place: "pl", terrace: "ter", parkway: "pkwy", route: "rt", rte: "rt",
  north: "n", south: "s", east: "e", west: "w", apartment: "apt", suite: "ste",
};

function normalizeAddress(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(p\s*o|post\s+office)\s+box\b/g, "pobox")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ADDRESS_WORDS[word] || word)
    .join(" ");
}

function zip5(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 5);
}

// A street line plus its ZIP (or city, without one), ignoring how either is
// written. Leaves out Address 2, so "Apt 2" on one list and nothing on
// another still compare as the same building.
function streetKey(address) {
  const street = normalizeAddress(address?.addressLine1);
  const place = zip5(address?.zip) || normalizeName(address?.city);
  return street && place ? `${street}|${place}` : null;
}

// One mailbox: the street key plus Address 2, so two apartments in one
// building are two addresses.
function addressKey(address) {
  const street = streetKey(address);
  return street ? `${street}|${normalizeAddress(address.addressLine2)}` : null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

// Common nicknames, including ones usual in Amish and Mennonite families.
// Names sharing a group can be the same person.
const NICKNAME_GROUPS = [
  ["abraham", "abe"], ["albert", "al", "bert"], ["alexander", "alex", "al"], ["andrew", "andy", "drew"],
  ["anthony", "tony"], ["barbara", "barb", "barbie"], ["benjamin", "ben", "benny"], ["catherine", "katherine", "kathryn", "katie", "kate", "kathy", "cathy", "kay"],
  ["charles", "charlie", "chuck"], ["christian", "chris"], ["christopher", "chris"], ["cynthia", "cindy"], ["daniel", "dan", "danny"],
  ["david", "dave", "davey"], ["deborah", "debbie", "deb"], ["dorothy", "dot", "dottie"], ["edward", "ed", "eddie", "ted"],
  ["elias", "eli"], ["elizabeth", "lizzie", "liz", "beth", "betty", "betsy", "eliza", "lisa"], ["emanuel", "manny", "manuel"],
  ["esther", "essie"], ["frances", "fannie", "fanny", "fran"], ["gerald", "jerry"], ["henry", "hank", "harry"], ["isaac", "ike"],
  ["jacob", "jake"], ["james", "jim", "jimmy", "jamie"], ["jeremiah", "jerry"], ["john", "johnny", "jack", "jon"], ["jonathan", "jon"],
  ["joseph", "joe", "joey"], ["lawrence", "larry"], ["leonard", "leon", "len"], ["magdalena", "lena", "maggie"], ["margaret", "maggie", "peggy", "marge", "meg"],
  ["martha", "mattie", "marty"], ["mary", "polly", "molly", "mae", "mamie"], ["matilda", "mattie", "tillie"], ["matthew", "matt"], ["michael", "mike"],
  ["moses", "mose"], ["nathaniel", "nathan", "nate"], ["nicholas", "nick"], ["patricia", "patty", "pat", "trish"], ["peter", "pete"],
  ["rachel", "rae"], ["rebecca", "becky", "becca"], ["richard", "dick", "rick", "rich"], ["robert", "bob", "bobby", "rob", "robbie"],
  ["ronald", "ron"], ["samuel", "sam", "sammy"], ["sarah", "sara", "sadie", "sallie", "sally"], ["stephen", "steven", "steve"],
  ["susan", "susie", "sue", "suzanne"], ["thomas", "tom", "tommy"], ["timothy", "tim"], ["william", "bill", "will", "willy", "billy"],
];
const nicknameIndex = new Map();
NICKNAME_GROUPS.forEach((group, i) => {
  for (const name of group) {
    if (!nicknameIndex.has(name)) nicknameIndex.set(name, new Set());
    nicknameIndex.get(name).add(i);
  }
});

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

function firstNamesCompatible(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0]; // "J Stoltzfus"
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) return true; // Sam / Samuel, Dan / Daniel
  const groupsA = nicknameIndex.get(a);
  const groupsB = nicknameIndex.get(b);
  return !!groupsA && !!groupsB && [...groupsA].some((g) => groupsB.has(g));
}

// Same last name, allowing a one-letter slip in a longer one (Stoltzfus /
// Stoltzfuss).
function lastNamesCompatible(a, b) {
  return a === b || (Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 1);
}

// Whether two names could be the same person written differently --
// nicknames, initials, a typo in the last name. Middle initials and
// suffixes that disagree mean different people.
function namesSimilar(a, b) {
  const x = nameParts(a);
  const y = nameParts(b);
  if (!x.first || !y.first || x.suffix !== y.suffix || !middlesAgree(a, b)) return false;
  return lastNamesCompatible(x.last, y.last) && firstNamesCompatible(x.first, y.first);
}

module.exports = {
  normalizeName,
  nameParts,
  middlesAgree,
  normalizeAddress,
  normalizeEmail,
  orgKey,
  streetKey,
  addressKey,
  namesSimilar,
};
