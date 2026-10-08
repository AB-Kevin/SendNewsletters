"use strict";

// Reads signups from a Gravity Forms form on the WordPress site, so the
// signup form can be imported like any other list.
//
// Gravity Forms REST API v2 supports HTTP Basic Auth over HTTPS as an
// alternative to full OAuth1 request signing (consumer key as username,
// consumer secret as password) -- see docs.gravityforms.com. Basic Auth is
// enough here since SendNewsletters only ever talks to a site Kevin
// configures himself, and avoids implementing OAuth1 signing for no real
// benefit. Same approach as the sibling ApplicationManager project's gfFetch.
async function gfFetch({ siteUrl, consumerKey, consumerSecret }, endpoint) {
  if (!/^https:\/\//i.test(siteUrl || "")) throw new Error("The site URL has to start with https://.");
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const base = siteUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/wp-json/gf/v2/${endpoint}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Gravity Forms answered ${res.status} for ${endpoint.split("?")[0]} -- check the site URL and the key and secret.`);
  }
  return res.json();
}

async function listForms(connection) {
  const forms = await gfFetch(connection, "forms");
  const list = Array.isArray(forms) ? forms : Object.values(forms || {});
  return list.map((f) => ({ id: String(f.id), title: f.title || `Form ${f.id}` }));
}

async function fetchForm(connection) {
  return gfFetch(connection, `forms/${encodeURIComponent(connection.formId)}`);
}

// The list-entries response is a bare array on some Gravity Forms versions
// and an { entries, total_count } wrapper on others.
function normalizeEntriesResponse(raw) {
  if (Array.isArray(raw)) return { entries: raw, totalCount: null };
  if (raw && Array.isArray(raw.entries)) return { entries: raw.entries, totalCount: Number(raw.total_count) || null };
  return { entries: [], totalCount: 0 };
}

const PAGE_SIZE = 200;
const MAX_PAGES = 100;

// The form's active entries (not spam or trash), newest first, stopping at
// the first one at or below `afterId` -- entry IDs only ever go up, so
// that's every signup since the last import.
async function fetchEntries(connection, afterId = 0) {
  const collected = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = await gfFetch(
      connection,
      `forms/${encodeURIComponent(connection.formId)}/entries?paging[page_size]=${PAGE_SIZE}&paging[current_page]=${page}&sorting[key]=id&sorting[direction]=DESC`
    );
    const { entries, totalCount } = normalizeEntriesResponse(raw);
    for (const entry of entries) {
      if (Number(entry.id) <= afterId) return collected;
      collected.push(entry);
    }
    if (entries.length < PAGE_SIZE || (totalCount !== null && page * PAGE_SIZE >= totalCount)) break;
  }
  return collected;
}

// Field types that never hold an answer.
const NON_INPUT_TYPES = new Set(["page", "section", "html", "captcha"]);

// Gravity Forms reports date_created in UTC as "YYYY-MM-DD HH:MM:SS".
function formatGfDate(value) {
  const date = new Date(String(value || "").replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

// Turns entries into the same { headers, rows } a spreadsheet file gives,
// with one column per answer, labeled from the form itself. A multi-part
// field (Name, Address) becomes one column per part -- "Name (First)",
// "Name (Last)" -- which the importer's column guessing recognizes.
function entriesToTable(form, entries) {
  const columns = [];
  for (const field of Array.isArray(form?.fields) ? form.fields : []) {
    if (NON_INPUT_TYPES.has(field.type)) continue;
    const label = String(field.adminLabel || field.label || `Field ${field.id}`).trim();
    const inputs = Array.isArray(field.inputs) ? field.inputs.filter((i) => !i.isHidden) : [];
    if (field.type === "checkbox" && inputs.length) {
      columns.push({ header: label, read: (e) => inputs.map((i) => e[String(i.id)]).filter(Boolean).join(", ") });
    } else if (inputs.length) {
      for (const input of inputs) columns.push({ header: `${label} (${input.label})`, read: (e) => e[String(input.id)] });
    } else {
      columns.push({ header: label, read: (e) => e[String(field.id)] });
    }
  }
  columns.push({ header: "Signed up", read: (e) => formatGfDate(e.date_created) });

  const seen = new Map();
  for (const col of columns) {
    const count = (seen.get(col.header) || 0) + 1;
    seen.set(col.header, count);
    if (count > 1) col.header = `${col.header} (${count})`;
  }
  const headers = columns.map((c) => c.header);
  const rows = entries.map((entry) => Object.fromEntries(columns.map((c) => [c.header, String(c.read(entry) ?? "").trim()])));
  return { headers, rows };
}

module.exports = { listForms, fetchForm, fetchEntries, entriesToTable };
