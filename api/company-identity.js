// Shared, server-side company-name identity normalization.
//
// Before this file, the exact same regex logic existed as four independent
// copies: api/save-upload.js's normalizeCompanyName(), api/settings.js's
// normalizeName(), api/save-prospect-upload.js's normalizeCompanyName(), and
// dashboard/index.html's client-side normalizeCompanyNameForLimit() (kept as
// its own client copy -- see below). This module is the one server-side
// source of truth going forward, used by save-upload.js and settings.js
// (their existing free-plan company-count enforcement) and by
// research-batch.js (duplicate-company research control). Behavior is
// preserved EXACTLY as it existed in production before this extraction --
// same order of operations, same regex -- so existing plan-limit enforcement
// is unaffected.
//
// Deliberately name-based, not fuzzy, and never domain-based: ha_accounts has
// no reliable, consistently-populated domain column today (website is an
// optional, unindexed field inside raw_data jsonb, frequently empty or
// inconsistent), so name is the only identity signal available. Strips
// common legal suffixes (inc/llc/corp/corporation/co/company/ltd/limited/
// incorporated) and punctuation/whitespace so "ABC Manufacturing" and "ABC
// Manufacturing LLC" normalize to the same key -- but does NOT do fuzzy or
// partial matching, so genuinely different company names never collapse
// together just because they look similar.
//
// dashboard/index.html's client-side normalizeCompanyNameForLimit() is left
// as its own copy deliberately: it runs in the browser (a static HTML file,
// not a bundled/built app) and cannot import a server-only module without a
// build step this repo does not have. It is BYTE-IDENTICAL in logic to this
// function today -- if this regex ever changes, update that copy too.
export function normalizeCompanyName(name = ''){
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
