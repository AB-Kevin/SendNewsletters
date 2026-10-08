"use strict";

// Replaces {{field}} placeholders in a template string with one contact's
// values ({{name}}, {{orgName}}, {{copies}}, ...). A field that resolves to
// nothing is left blank rather than left as a literal "{{field}}", since
// author intent for a missing value (no organization, say) is almost always
// "leave it out". Pass { html: true } for an HTML body, so a value like
// "Smith & Sons" comes out as text instead of being read as markup.
function renderTemplate(templateStr, contact, { html = false } = {}) {
  return String(templateStr || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, field) => {
    const value = contact[field];
    const text = value === undefined || value === null || typeof value === "object" ? "" : String(value);
    return html ? escapeHtml(text) : text;
  });
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Converts a rich-text email body (HTML from the templates editor) to a
// plain-text fallback for the multipart/alternative part of the email --
// mail clients that don't render HTML, and spam filters that weigh a
// text-only message favorably, both get something readable instead of raw
// markup. Not a general HTML parser -- just enough to turn block-level tags
// into line breaks and strip the rest, which is all a template editor's own
// output needs.
function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { renderTemplate, htmlToPlainText };
