"use strict";

// The membership software's household export (Membergroup<date>.csv): one row
// per member household, with its head's name, the household's address and
// email, its church, its Member ID (GroupCode), its plan (fundName) and
// whether it's active (statusTerm). The Import page recognizes it by its
// columns and sets the import up the way the office decided:
//
// - the head of household is the person on the list (the household file
//   already names them; the individual file isn't needed);
// - only one plan's households, the Medical Aid & Alms Plan unless another
//   is chosen on the Import page;
// - a household new to the list gets Our Health by mail; anyone already on
//   it keeps the newsletters they have;
// - an inactive household stops getting newsletters (see listImport).
//
// The middle name is left out, so names stay as they are on the list rather
// than gaining hundreds of middle initials on their envelopes; it can be
// mapped on the Import page. Every other column -- including the identity,
// health and claims details the export carries -- is left as "Don't import".

const COLUMNS = {
  FirstName: "firstName",
  LastName: "lastName",
  PrimaryEmail: "email",
  PrimaryAddressLine1: "addressLine1",
  PrimaryAddressLine2: "addressLine2",
  PrimaryCity: "city",
  PrimaryState: "state",
  PrimaryZip: "zip",
  churchName: "orgName",
  GroupCode: "memberId",
  statusTerm: "memberStatus",
};
const RECOGNIZED_BY = ["GroupCode", "MemberGroupUID", "PrimaryAddressLine1", "statusTerm", "fundName"];
const PLAN_COLUMN = "fundName";
const DEFAULT_PLAN = "Medical Aid & Alms Plan";
const NEW_MEMBERS_GET = /^our health$/i;

/**
 * The import set up for a membership export, or null if `headers` aren't
 * one: { mapping, plans: [{ name, count }], planColumn, options }, where
 * options are listImport.planImport's.
 */
function membershipPreset(headers, rows, publications) {
  if (!RECOGNIZED_BY.every((h) => headers.includes(h))) return null;
  const mapping = Object.fromEntries(headers.map((h) => [h, COLUMNS[h] || ""]));
  const counts = new Map();
  for (const row of rows) {
    const plan = String(row[PLAN_COLUMN] ?? "").trim();
    if (plan) counts.set(plan, (counts.get(plan) || 0) + 1);
  }
  const plans = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const plan = counts.has(DEFAULT_PLAN) ? DEFAULT_PLAN : plans[0]?.name || "";
  return {
    mapping,
    plans,
    planColumn: PLAN_COLUMN,
    options: {
      only: plan ? { column: PLAN_COLUMN, value: plan } : null,
      publicationIds: publications.filter((p) => NEW_MEMBERS_GET.test(p.name.trim())).map((p) => p.id),
      deliveryDefault: "mail",
      newOnly: true,
    },
  };
}

module.exports = { membershipPreset };
