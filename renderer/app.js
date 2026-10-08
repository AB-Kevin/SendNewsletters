"use strict";

// Shared helpers used by every page module (renderer/pages/*.js). Each page
// module registers itself on window.Pages[name] = { render(container) }.
window.Pages = {};

function qs(sel, root = document) {
  return root.querySelector(sel);
}
function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// "1 contact" / "12 contacts", with thousands separators.
function plural(n, word, pluralWord = `${word}s`) {
  return `${Number(n).toLocaleString()} ${n === 1 ? word : pluralWord}`;
}

// Contact fields by their on-screen names -- the filter builder
// (mailing-new.js) and a past mailing's filters (mailings.js) both use these.
const CONTACT_FIELD_LABELS = {
  orgName: "Organization",
  name: "Name",
  email: "Email address",
  addressLine1: "Address",
  addressLine2: "Address 2",
  city: "City",
  state: "State",
  zip: "ZIP",
  copies: "Copies",
  sourceBatch: "Source",
};

const FILTER_OPS = [
  { value: "equals", label: "equals" },
  { value: "contains", label: "contains" },
  { value: "in", label: "is one of (comma-separated)" },
  { value: "notEmpty", label: "is not empty" },
  { value: "empty", label: "is empty" },
];
function filterOpLabel(op) {
  return FILTER_OPS.find((o) => o.value === op)?.label || op;
}
function filterRuleNeedsValue(op) {
  return op !== "empty" && op !== "notEmpty";
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function toast(message, isError = false) {
  const container = qs("#toast");
  const item = document.createElement("div");
  item.className = "toast-item" + (isError ? " toast-error" : "");
  item.textContent = message;
  container.appendChild(item);
  setTimeout(() => item.classList.add("visible"), 10);
  setTimeout(() => {
    item.classList.remove("visible");
    setTimeout(() => item.remove(), 300);
  }, isError ? 7000 : 4000);
}

// Always use this instead of window.confirm() -- see "dialog:confirm" in
// main.js for why the built-in one breaks form controls afterwards.
function confirmAction(message, okLabel) {
  return window.api.confirm(message, okLabel);
}

// A page can set `navAs` to keep another page's nav button lit -- the
// import page belongs to the Mailing List. `fill` pages (the spreadsheet)
// take the window's full height instead of scrolling as a whole. There's no
// unmount hook otherwise; a page that needs to finish something before it's
// replaced (saving an open edit) sets window.__beforeNavigate.
async function navigate(pageName) {
  const leaving = window.__beforeNavigate;
  window.__beforeNavigate = null;
  if (leaving) leaving();
  const page = window.Pages[pageName];
  const navName = page?.navAs || pageName;
  qsa(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.page === navName));
  const content = qs("#content");
  content.classList.toggle("content-fill", !!page?.fill);
  content.innerHTML = '<div class="loading">Loading…</div>';
  if (!page) {
    content.innerHTML = `<div class="empty">Unknown page: ${escapeHtml(pageName)}</div>`;
    return;
  }
  try {
    await page.render(content);
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="empty">Something went wrong: ${escapeHtml(err.message)}</div>`;
  }
  refreshNavBadges();
}

// How many possible duplicates (people, shared addresses, organizations)
// are waiting, on the Duplicates button.
async function refreshNavBadges() {
  const counts = await window.api.reviewCounts().catch(() => null);
  const badge = qs("#duplicates-badge");
  if (!counts || !badge) return;
  const waiting = counts.duplicates + counts.sharedAddresses + counts.orgDuplicates;
  badge.textContent = waiting ? waiting.toLocaleString() : "";
  badge.style.display = waiting ? "" : "none";
}

window.navigate = navigate;
window.refreshNavBadges = refreshNavBadges;
window.toast = toast;
window.confirmAction = confirmAction;
window.escapeHtml = escapeHtml;
window.plural = plural;
window.formatDate = formatDate;
window.CONTACT_FIELD_LABELS = CONTACT_FIELD_LABELS;
window.FILTER_OPS = FILTER_OPS;
window.filterOpLabel = filterOpLabel;
window.filterRuleNeedsValue = filterRuleNeedsValue;
