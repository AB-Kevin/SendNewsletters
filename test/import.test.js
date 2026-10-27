"use strict";

// Imports with Member IDs and member status (lib/listImport.js), and the
// membership export's set-up (lib/membership.js).

const test = require("node:test");
const assert = require("node:assert/strict");
const { planImport } = require("../lib/listImport");
const { membershipPreset } = require("../lib/membership");

const publications = [
  { id: "maap", name: "MAAP Newsletter" },
  { id: "oh", name: "Our Health" },
];
const address = (line1, zip) => ({ addressLine1: line1, addressLine2: "", city: "Gordonville", state: "PA", zip });

/** A list with Amos (no Member ID yet, gets Our Health by mail) and a second Amos Beiler with a Member ID. */
function existingList() {
  return {
    households: [
      { id: "h1", ...address("102 Mill Rd", "17529"), subs: { oh: { mail: true, copies: 1 } } },
      { id: "h2", ...address("9 Hill Rd", "17529"), subs: {} },
    ],
    contacts: [
      { id: "c1", name: "Amos Beiler", email: "amos@example.org", memberId: "", orgId: null, householdId: "h1", subs: {} },
      { id: "c2", name: "Amos Beiler", email: "", memberId: "BEILA999", orgId: null, householdId: "h2", subs: {} },
    ],
    orgs: [],
  };
}

const mapping = { First: "firstName", Last: "lastName", Email: "email", Street: "addressLine1", Zip: "zip", Code: "memberId", Status: "memberStatus", Plan: "" };
const row = (fields) => ({ First: "Amos", Last: "Beiler", Email: "amos@example.org", Street: "102 Mill Rd", Zip: "17529", Code: "BEILA123", Status: "Active", Plan: "Medical Aid & Alms Plan", ...fields });
const options = (more = {}) => ({ mode: "person", publicationIds: ["oh"], deliveryDefault: "mail", newOnly: true, defaultCopies: "1", sourceBatch: "Export", ...more });
const plan = (rows, more, existing = existingList()) => planImport(rows, mapping, options(more), existing, publications);

test("the first time, a member is matched by name and address and gets their Member ID", () => {
  const p = plan([row()]);
  assert.equal(p.stats.added, 0);
  assert.deepEqual(p.contactUpdates, [{ id: "c1", patch: { memberId: "BEILA123" } }]);
});

test("after that, the Member ID finds them whatever their name or address now", () => {
  const existing = existingList();
  existing.contacts[0].memberId = "BEILA123";
  const p = plan([row({ First: "Amos J", Street: "5 New Rd", Email: "" })], {}, existing);
  assert.equal(p.stats.added, 0);
  assert.equal(p.contactUpdates[0].id, "c1");
});

test("someone with a different Member ID is never matched, however alike the names", () => {
  // The only Amos Beiler at 9 Hill Rd has BEILA999, so a row for BEILA555 there is someone new.
  const p = plan([row({ Code: "BEILA555", Street: "9 Hill Rd", Email: "" })]);
  assert.equal(p.stats.added, 1);
  assert.equal(p.contactInserts[0].memberId, "BEILA555");
});

test("Member IDs match ignoring case, spaces and dashes", () => {
  const existing = existingList();
  existing.contacts[0].memberId = "beila-123";
  const p = plan([row({ Code: "BEILA 123", Street: "", Email: "" })], {}, existing);
  assert.equal(p.stats.added, 0);
});

test("an inactive member stops getting everything, and an inactive newcomer isn't added", () => {
  const p = plan([row({ Status: "Inactive" }), row({ First: "Ruth", Last: "Esh", Email: "", Street: "1 Elm St", Code: "ESHR001", Status: "Inactive" })]);
  assert.equal(p.stats.inactiveStopped, 1);
  assert.equal(p.stats.inactiveSkipped, 1);
  assert.equal(p.stats.added, 0);
  const home = p.householdUpdates.find((u) => u.id === "h1");
  assert.equal(home.patch.subs.oh.mail, false, "they live alone, so the household's mail stops");
});

test("with newOnly, only people new to the list are signed up", () => {
  const p = plan([row(), row({ First: "Ruth", Last: "Esh", Email: "", Street: "1 Elm St", Code: "ESHR001" })]);
  assert.equal(p.stats.added, 1);
  assert.deepEqual(p.stats.starting, { oh: 1 }, "Ruth, by mail; Amos already gets it");
  const without = plan([row({ Street: "9 Hill Rd", Code: "BEILA999", Email: "" })], { newOnly: false });
  assert.deepEqual(without.stats.starting, { oh: 1 }, "without it, the other Amos is signed up too");
  const withIt = plan([row({ Street: "9 Hill Rd", Code: "BEILA999", Email: "" })]);
  assert.deepEqual(withIt.stats.starting, {});
});

test("only one plan's rows are read when asked", () => {
  const p = plan([row(), row({ Plan: "Workers' Aid Plan", First: "Ruth", Code: "X1" })], { only: { column: "Plan", value: "Medical Aid & Alms Plan" } });
  assert.equal(p.stats.outsideOnly, 1);
  assert.equal(p.stats.rowsRead, 2);
  assert.equal(p.stats.added, 0);
});

test("the membership export is recognized and set up as the office decided", () => {
  const headers = ["ID", "MemberGroupUID", "LastName", "FirstName", "MiddleName", "GroupCode", "PrimaryAddressLine1", "PrimaryCity", "PrimaryState", "PrimaryZip", "PrimaryEmail", "Last4SSN", "churchName", "fundName", "statusTerm"];
  const rows = [{ fundName: "Medical Aid & Alms Plan" }, { fundName: "Medical Aid & Alms Plan" }, { fundName: "AMISH MENNONITE CHURCH AID" }];
  const preset = membershipPreset(headers, rows, publications);
  assert.deepEqual(preset.plans, [{ name: "Medical Aid & Alms Plan", count: 2 }, { name: "AMISH MENNONITE CHURCH AID", count: 1 }]);
  assert.deepEqual(preset.options.only, { column: "fundName", value: "Medical Aid & Alms Plan" });
  assert.deepEqual(preset.options.publicationIds, ["oh"]);
  assert.equal(preset.options.newOnly, true);
  assert.equal(preset.mapping.GroupCode, "memberId");
  assert.equal(preset.mapping.statusTerm, "memberStatus");
  assert.equal(preset.mapping.Last4SSN, "", "identity and health columns aren't imported");
  assert.equal(preset.mapping.MiddleName, "", "names stay as they are");
  assert.equal(membershipPreset(["Name", "Email"], [], publications), null, "any other file is left to the usual guessing");
});
