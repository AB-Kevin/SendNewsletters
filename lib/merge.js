"use strict";

// Replaces {{field}} placeholders in a template string against one contact
// record. Looks up top-level contact fields first (name, email, addressLine1,
// ...), then falls back to contact.extra[field] so any column pulled in from
// the source CSV/spreadsheet -- not just the core fields SendNewsletters knows by
// name -- can be used in a template without an "extra." prefix. A field that
// resolves to nothing is left blank rather than left as a literal
// "{{field}}", since author intent for a missing value (blank address line
// 2, for instance) is almost always "leave it out".
function renderTemplate(templateStr, contact, extraContext = {}) {
  return String(templateStr || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, rawField) => {
    if (rawField in extraContext) return String(extraContext[rawField]);
    if (rawField.startsWith("extra.")) {
      const key = rawField.slice("extra.".length);
      return String(contact.extra?.[key] ?? "");
    }
    if (rawField in contact && typeof contact[rawField] !== "object") {
      return String(contact[rawField] ?? "");
    }
    return String(contact.extra?.[rawField] ?? "");
  });
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

// Builds the personalized Gravity Forms link for one recipient: the form's
// public page URL plus the hidden token field's dynamic-population
// parameter, carrying this recipient's response token.
function buildResponseLink(gravityForm, token) {
  const url = new URL(gravityForm.pageUrl);
  url.searchParams.set(gravityForm.tokenParamName || "rtoken", token);
  return url.toString();
}

module.exports = { renderTemplate, buildResponseLink, htmlToPlainText };
