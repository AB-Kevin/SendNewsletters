"use strict";

// Mailing recipients following people, households and organizations that
// MemberManager deleted or merged (lib/retired.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const { followRetired } = require("../lib/retired");

// h1 was merged into h2, h3 deleted, o1 merged into o2; everything else is still there.
const WHERE = { "household|h1": "h2", "household|h3": null, "org|o1": "o2" };
const currentId = (kind, id) => (`${kind}|${id}` in WHERE ? WHERE[`${kind}|${id}`] : id);
const snapshotOf = (kind, id) => ({ id, was: kind });

test("nothing changes while everyone is still on the list", () => {
  const recipients = [{ id: "r1", mailingId: "m1", channel: "mail", householdId: "h2", status: "pending" }];
  const result = followRetired(recipients, currentId, snapshotOf);
  assert.equal(result.changed, 0);
  assert.equal(result.rows, recipients);
});

test("a pending recipient moves to the merged household, or drops out if that one already gets it", () => {
  const { rows, changed } = followRetired(
    [
      { id: "r1", mailingId: "m1", channel: "mail", householdId: "h1", status: "pending" },
      { id: "r2", mailingId: "m2", channel: "mail", householdId: "h1", status: "pending" },
      { id: "r3", mailingId: "m2", channel: "mail", householdId: "h2", status: "pending" },
    ],
    currentId,
    snapshotOf
  );
  assert.equal(changed, 2);
  assert.deepEqual(
    rows.map((r) => [r.id, r.householdId]),
    [
      ["r1", "h2"],
      ["r3", "h2"],
    ]
  );
});

test("a deleted household's pending copy drops out; one already mailed keeps a snapshot", () => {
  const { rows } = followRetired(
    [
      { id: "r1", mailingId: "m1", channel: "mail", householdId: "h3", status: "pending" },
      { id: "r2", mailingId: "m2", channel: "mail", householdId: "h3", status: "sent" },
      { id: "r3", mailingId: "m3", channel: "mail", orgId: "o1", status: "sent", orgSnapshot: { id: "o1", kept: true } },
    ],
    currentId,
    snapshotOf
  );
  assert.deepEqual(rows, [
    { id: "r2", mailingId: "m2", channel: "mail", householdId: "h3", status: "sent", householdSnapshot: { id: "h3", was: "household" } },
    { id: "r3", mailingId: "m3", channel: "mail", orgId: "o1", status: "sent", orgSnapshot: { id: "o1", kept: true } },
  ]);
});
