"use strict";

// Gravity Forms REST API v2 supports HTTP Basic Auth over HTTPS as an
// alternative to full OAuth1 request signing (consumer key as username,
// consumer secret as password) -- see docs.gravityforms.com. Basic Auth is
// enough here since SendNewsletters only ever talks to a site Kevin configures
// himself, and avoids implementing OAuth1 signing for no real benefit. This
// mirrors the same approach already used in the sibling ApplicationManager
// project's main.js (gfFetch).
async function gfFetch(siteUrl, consumerKey, consumerSecret, endpoint) {
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const base = siteUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/wp-json/gf/v2/${endpoint}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Gravity Forms API error ${res.status} for ${endpoint.split("?")[0]} -- check the site URL and key/secret.`);
  }
  return res.json();
}

async function testConnection(siteUrl, consumerKey, consumerSecret) {
  const forms = await gfFetch(siteUrl, consumerKey, consumerSecret, "forms");
  const list = Array.isArray(forms) ? forms : Object.values(forms || {});
  return list.map((f) => ({ id: String(f.id), title: f.title || `Form ${f.id}` }));
}

// The exact list-entries response envelope varies by GF version -- accepts
// either a bare array or an {entries, total_count} wrapper. totalCount is
// null when the response doesn't say.
function normalizeEntriesResponse(raw) {
  if (Array.isArray(raw)) return { entries: raw, totalCount: null };
  if (raw && Array.isArray(raw.entries)) {
    return { entries: raw.entries, totalCount: Number(raw.total_count) || null };
  }
  return { entries: [], totalCount: 0 };
}

// Gravity Forms reports date_created in UTC as "YYYY-MM-DD HH:MM:SS" with no
// zone marker, which JS would otherwise read as local time.
function parseGfDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? null : date;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

// Pages through a form's entries newest-first until it reaches one submitted
// before `since` (when the earliest mailing using this form was created).
// Nothing older can be a response to a SendNewsletters mailing, and leaving it
// out keeps e.g. last year's submissions from matching this year's
// recipients by member ID.
async function fetchEntries(gravityForm, since) {
  const collected = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = await gfFetch(
      gravityForm.siteUrl,
      gravityForm.consumerKey,
      gravityForm.consumerSecret,
      `forms/${gravityForm.formId}/entries?paging[page_size]=${PAGE_SIZE}&paging[current_page]=${page}&sorting[key]=date_created&sorting[direction]=DESC`
    );
    const { entries, totalCount } = normalizeEntriesResponse(raw);
    for (const entry of entries) {
      const created = parseGfDate(entry.date_created);
      if (since && created && created < since) return collected;
      collected.push(entry);
    }
    if (entries.length < PAGE_SIZE || (totalCount !== null && page * PAGE_SIZE >= totalCount)) break;
  }
  return collected;
}

async function fetchForm(gravityForm) {
  return gfFetch(gravityForm.siteUrl, gravityForm.consumerKey, gravityForm.consumerSecret, `forms/${gravityForm.formId}`);
}

// Pulls the submitter's name and email out of an entry using the form's own
// field definitions (its first Name and first Email field). Only shown on the
// review list so a person can recognize who an entry is from -- never used
// for matching.
function summarizeEntry(entry, form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const nameField = fields.find((f) => f.type === "name");
  const emailField = fields.find((f) => f.type === "email");
  let name = "";
  if (nameField) {
    // A "simple" name field stores one value under its own ID; the usual
    // multi-part one stores prefix/first/middle/last/suffix as sub-inputs.
    name =
      entry[String(nameField.id)] ||
      [".2", ".3", ".4", ".6", ".8"]
        .map((suffix) => entry[`${nameField.id}${suffix}`])
        .filter(Boolean)
        .join(" ");
  }
  return {
    name: String(name || "").trim(),
    email: emailField ? String(entry[String(emailField.id)] || "").trim() : "",
  };
}

// Member IDs as members type them: case, spaces and punctuation don't count.
function normalizeMemberId(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Also treats letters that are easy to type in place of a digit as that
// digit (O for 0, I and L for 1), so "StoJooo2" lines up with STOJO002. A
// few real IDs become identical once folded (differing only by an L vs an
// I); matchEntries won't pick between those and leaves them for review.
function foldLookalikes(normalizedId) {
  return normalizedId.replace(/O/g, "0").replace(/[IL]/g, "1");
}

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

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function isOneContact(group) {
  return new Set(group.map((c) => c.recipient.contactId)).size === 1;
}

// The same contact can be a recipient of more than one mailing that uses
// this form (e.g. one mailing per year); an entry belongs to the latest
// mailing created before it was submitted.
function pickRecipient(group, submittedAt) {
  const byNewest = [...group].sort((a, b) => new Date(b.mailingCreatedAt) - new Date(a.mailingCreatedAt));
  const before = submittedAt ? byNewest.find((c) => new Date(c.mailingCreatedAt) <= submittedAt) : null;
  return (before || byNewest[0]).recipient;
}

// Up to three recipients whose member ID is closest to what was typed, for a
// person to confirm on the review list.
function suggestRecipients(typedKey, byMemberId, submittedAt) {
  if (!typedKey) return [];
  const typedFolded = foldLookalikes(typedKey);
  return [...byMemberId.entries()]
    .map(([key, group]) => ({ group, distance: editDistance(typedFolded, foldLookalikes(key)) }))
    .filter((s) => s.distance <= 2)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((s) => pickRecipient(s.group, submittedAt));
}

// Matches freshly-fetched entries to mailing recipients. `candidates` has one
// { recipient, memberId, mailingCreatedAt } per recipient of the mailings
// using this form -- already-responded ones included, so a repeat submission
// is recognized as theirs rather than reported as unmatched. Tried in order:
//   1. the hidden token field (filled in from a personalized {{form_link}});
//   2. the member ID typed into the form, ignoring case/spaces/punctuation;
//   3. the same with look-alike characters folded together.
// A member ID match only counts when it points at exactly one contact.
// Everything else comes back in `unmatched` with suggestions.
function matchEntries(entries, gravityForm, candidates) {
  const byToken = new Map(candidates.map((c) => [c.recipient.responseToken, c]));
  const byMemberId = groupBy(candidates, (c) => normalizeMemberId(c.memberId));
  const byFolded = groupBy(candidates, (c) => foldLookalikes(normalizeMemberId(c.memberId)));
  const matches = [];
  const unmatched = [];

  for (const entry of entries) {
    const entryId = String(entry.id);
    const submittedAt = parseGfDate(entry.date_created);
    const token = gravityForm.tokenFieldId ? String(entry[String(gravityForm.tokenFieldId)] ?? "").trim() : "";
    const memberIdEntered = gravityForm.memberIdFieldId
      ? String(entry[String(gravityForm.memberIdFieldId)] ?? "").trim()
      : "";
    const typedKey = normalizeMemberId(memberIdEntered);

    let group = null;
    let matchedBy = null;
    if (token && byToken.has(token)) {
      group = [byToken.get(token)];
      matchedBy = "token";
    } else if (typedKey && byMemberId.has(typedKey) && isOneContact(byMemberId.get(typedKey))) {
      group = byMemberId.get(typedKey);
      matchedBy = "memberId";
    } else if (typedKey) {
      const folded = byFolded.get(foldLookalikes(typedKey));
      if (folded && isOneContact(folded)) {
        group = folded;
        matchedBy = "memberIdLookalike";
      }
    }

    if (group) {
      matches.push({ recipient: pickRecipient(group, submittedAt), entry, entryId, submittedAt, matchedBy, memberIdEntered });
    } else {
      unmatched.push({
        entry,
        entryId,
        submittedAt,
        memberIdEntered,
        suggestions: suggestRecipients(typedKey, byMemberId, submittedAt),
      });
    }
  }
  return { matches, unmatched };
}

module.exports = { gfFetch, testConnection, fetchEntries, fetchForm, summarizeEntry, matchEntries };
