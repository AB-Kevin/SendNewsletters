"use strict";

const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");
const XLSX = require("xlsx");

// Reads a .csv/.tsv or .xlsx/.xls file into { headers, rows } where rows is
// an array of plain objects keyed by header text. Used both for the initial
// column-mapping preview (a handful of rows) and the real import (all rows).
function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv" || ext === ".tsv") {
    const text = fs.readFileSync(filePath, "utf8");
    const result = Papa.parse(text, { header: true, skipEmptyLines: true });
    return { headers: result.meta.fields || [], rows: result.data };
  }
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

// "externalId" (not "id") so a mapped ID column can never collide with the
// row's own internal id (the UUID primary key every store row gets).
const CORE_FIELDS = ["externalId", "name", "email", "addressLine1", "addressLine2", "city", "state", "zip"];

// Turns raw parsed rows into contact records ready for db/store insert:
// mapping is { [header]: coreFieldName | "" }. Any header left unmapped (or
// explicitly mapped to "") is preserved verbatim in `extra` so nothing from
// the source file is lost, even if it wasn't one of the recognized fields --
// requirement (2) lets a mailing filter on ANY column from the file, not
// just the ones SendNewsletters knows by name.
function buildContacts(rows, mapping, sourceBatch) {
  const reverseCore = {};
  for (const [header, target] of Object.entries(mapping)) {
    if (CORE_FIELDS.includes(target)) reverseCore[header] = target;
  }
  return rows.map((row) => {
    const contact = {
      externalId: "",
      name: "",
      email: "",
      addressLine1: "",
      addressLine2: "",
      city: "",
      state: "",
      zip: "",
      extra: {},
      sourceBatch,
    };
    for (const [header, value] of Object.entries(row)) {
      const coreField = reverseCore[header];
      if (coreField) {
        contact[coreField] = String(value ?? "").trim();
      } else {
        contact.extra[header] = String(value ?? "").trim();
      }
    }
    return contact;
  });
}

module.exports = { parseFile, buildContacts, CORE_FIELDS };
