"use strict";

// What becomes of mailing recipients once MemberManager deletes or merges the
// person, household or organization they point at (its retired.json; see
// main.js, "The mailing list from MemberManager"):
//
// - a recipient that hasn't been sent to yet moves to the record it was
//   merged into -- unless that one is already on the mailing the same way,
//   when it's dropped, so nobody gets two copies -- or is dropped when the
//   record was deleted;
// - one that has been sent to stays, with a copy of who or where it was, so
//   the mailing's history still says.

const KINDS = [
  ["contact", "contactId", "contactSnapshot"],
  ["household", "householdId", "householdSnapshot"],
  ["org", "orgId", "orgSnapshot"],
];

/**
 * `recipients` re-pointed: { rows, changed }. `currentId(kind, id)` is where
 * a record is now (itself, the one it was merged into, or null);
 * `snapshotOf(kind, id)` is a copy of it as it was.
 */
function followRetired(recipients, currentId, snapshotOf) {
  const where = new Map();
  const now = (kind, id) => {
    const key = `${kind}|${id}`;
    if (!where.has(key)) where.set(key, currentId(kind, id));
    return where.get(key);
  };
  const movedKind = (r) => KINDS.find(([kind, idField]) => r[idField] && now(kind, r[idField]) !== r[idField]);
  if (!recipients.some(movedKind)) return { rows: recipients, changed: 0 };

  const key = (r, idField, id) => `${r.mailingId}|${r.channel}|${idField}|${id}`;
  const taken = new Set(recipients.flatMap((r) => KINDS.filter(([, idField]) => r[idField] && !movedKind(r)).map(([, idField]) => key(r, idField, r[idField]))));
  const rows = [];
  let changed = 0;
  for (const r of recipients) {
    const moved = movedKind(r);
    if (!moved) {
      rows.push(r);
      continue;
    }
    changed++;
    const [kind, idField, snapshotField] = moved;
    const to = now(kind, r[idField]);
    if (r.status !== "pending") rows.push(r[snapshotField] ? r : { ...r, [snapshotField]: snapshotOf(kind, r[idField]) });
    else if (to && !taken.has(key(r, idField, to))) {
      taken.add(key(r, idField, to));
      rows.push({ ...r, [idField]: to });
    }
  }
  return { rows, changed };
}

module.exports = { followRetired };
