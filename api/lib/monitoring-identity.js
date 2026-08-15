// Monitoring Identity V1: the durable identity anchor for a recurring
// monitoring target ("who is this customer on the public web?"), resolved
// once from account-side evidence and reused by every future monitoring
// cycle -- never reinvented per candidate signal. See the Phase 2C
// grounding-policy design for the full rationale; this module is
// deliberately the smallest thing that satisfies it.
//
// Two independent concerns live here, kept in separate functions on
// purpose:
//   1. resolveTargetIdentity() -- decides what a TARGET's durable identity
//      anchor should be, from account-side data only (uploaded website,
//      contact emails). Never touches a research candidate/signal.
//   2. classifyMonitoringSignalEligibility() -- decides what a single
//      ALREADY-GROUNDED signal (verifyCandidateCompanyGrounding()'s
//      output) is allowed to become downstream (priority/secondary/
//      hidden). Reads identityConfidence + the underlying `reasons`, not
//      just the identityConfidence label -- see its own comment for why
//      today's 'confirmed' alone is not a strong-enough proxy.
//
// Reuses proven existing logic rather than inventing parallel notions of
// "same domain" or "is this a business email":
//   - sourceDomain() (api/signal-intelligence.js) is the one hostname-
//     normalization boundary already used throughout grounding/dedup.
//     normalizeDomain() below only adds a protocol fallback so a bare
//     "acme.com" (how an uploaded website is often entered) normalizes
//     identically to a full URL -- it does not reimplement the hostname
//     logic itself.
//   - domainFromContactEmail() (api/research-batch.js) is the existing,
//     already-tested free-mail-exclusion + domain-extraction logic the
//     interactive research endpoint already relies on. Reused verbatim,
//     not reimplemented.
import { sourceDomain, clean } from '../signal-intelligence.js';
import { domainFromContactEmail } from '../research-batch.js';
// Monitoring Identity V1, Path B wiring: the existing durable
// (user_id, normalizeCompanyName(account_name)) identity convention
// ha_monitoring_targets is already keyed by (see monitoring-targets.js's
// own header comment) -- the ONE join key buildTargetIdentityIndex()/
// lookupTargetIdentity() below reuse, so every read-time consumer
// (dashboard, weekly digest) resolves a signal's target the same way,
// not a second notion of "which target does this row belong to."
import { identityKey, normalizeCompanyName } from './monitoring-targets.js';

// Reuses sourceDomain()'s exact hostname/www/case normalization -- the
// only addition is tolerating a bare domain (no scheme), which is how an
// uploaded "website" field is commonly entered ("acme.com" rather than
// "https://acme.com").
export function normalizeDomain(value) {
  const trimmed = clean(value || '');
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return sourceDomain(withScheme);
}

// Every non-free-mail business domain found across an account's contact
// list, normalized and deduplicated -- domainFromContactEmail() already
// excludes free-mail providers (gmail/yahoo/hotmail/outlook/icloud/aol/
// example.*); this just applies it to every contact (not only the first)
// and routes the result through the SAME normalizeDomain() boundary as
// everything else in this module, so a business domain compares equal
// regardless of whether it arrived via an uploaded website or a contact
// email.
export function extractBusinessDomainsFromContacts(contacts) {
  const domains = new Set();
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const raw = domainFromContactEmail(contact?.email || '');
    const normalized = normalizeDomain(raw);
    if (normalized) domains.add(normalized);
  }
  return domains;
}

// The full target-identity resolution lifecycle. Pure function: given the
// target's CURRENT stored identity and account-side evidence that existed
// independently before this call, returns either `null` (no change --
// caller should persist nothing) or the next
// { status, domain, source } to write.
//
// CIRCULARITY GUARD (hard requirement): this function's only inputs are
// account-side data -- an uploaded website and a contact list. It is never
// called with, and must never be called with, anything derived from a
// research candidate, a discovered source, or a persisted signal. A
// discovered website may be useful RESEARCH EVIDENCE for one cycle, but it
// can never become the trusted account identity that then corroborates
// itself -- that would let a same-named unrelated company's own domain
// silently become "confirmed" the moment it's discovered. Callers must
// only ever pass uploadedWebsite/contacts sourced from ha_accounts, never
// from a Serper/Firecrawl/OpenAI result.
//
// Lifecycle rules (see the design's own "Identity changes on later
// uploads" section):
//   - 'confirmed' (rep-confirmed) is NEVER auto-overwritten by this
//     function, full stop.
//   - An uploaded website is the strongest, most direct signal and always
//     supersedes a contact-derived identity (or a stale uploaded one) when
//     it differs from what's currently stored.
//   - No uploaded website this round, but the target was already
//     uploaded-website-derived: retained as-is. A later upload/sync that
//     simply lacks a website field is not treated as the customer
//     retracting their own assertion.
//   - Exactly one unique non-free-mail business domain across contacts:
//     derives (if currently unresolved) or retains (if already derived
//     from that same domain).
//   - A DIFFERENT single contact-derived domain than what's currently
//     stored, or MORE THAN ONE distinct domain now present: moves to
//     'unresolved' rather than guessing -- ambiguity is never silently
//     resolved by picking one.
//   - No usable domain at all this round (contacts missing, or all
//     free-mail): retains whatever is currently stored. Absence of new
//     information never forces a change on its own -- only an explicit
//     CONFLICT does.
export function resolveTargetIdentity({ current = {}, uploadedWebsite = '', contacts = [] } = {}) {
  const currentStatus = current.status || 'unresolved';
  const currentDomain = current.domain || null;
  const currentSource = current.source || null;

  if (currentStatus === 'confirmed') return null;

  const normalizedUploaded = normalizeDomain(uploadedWebsite);
  if (normalizedUploaded) {
    if (currentDomain === normalizedUploaded && currentSource === 'uploaded-website') return null;
    return { status: 'derived', domain: normalizedUploaded, source: 'uploaded-website' };
  }

  // No uploaded website this round -- an already uploaded-derived identity
  // is never downgraded just because this round's data omits it.
  if (currentSource === 'uploaded-website') return null;

  const businessDomains = extractBusinessDomainsFromContacts(contacts);

  if (businessDomains.size === 1) {
    const [only] = businessDomains;
    if (currentStatus === 'unresolved') {
      return { status: 'derived', domain: only, source: 'contact-derived' };
    }
    if (currentStatus === 'derived' && currentSource === 'contact-derived') {
      if (currentDomain === only) return null;
      // A different contact-derived domain than before -- a genuine
      // conflict, not new corroborating information. Move to unresolved
      // rather than silently switching.
      return { status: 'unresolved', domain: null, source: null };
    }
  }

  if (businessDomains.size > 1 && currentStatus === 'derived' && currentSource === 'contact-derived') {
    // Ambiguity now exists where there wasn't before -- same principle as
    // the single-conflicting-domain case above.
    return { status: 'unresolved', domain: null, source: null };
  }

  // Zero usable domains this round, or already unresolved with continuing
  // ambiguity/no evidence: nothing to change.
  return null;
}

// ============================================================================
// Read-time target-identity lookup -- ONE bounded (user_id, normalized
// account name) -> identity index, built once per request/invocation from
// a single already-scoped ha_monitoring_targets query, never a per-signal
// or per-account database call. Every read-time consumer
// (api/get-dashboard.js, api/weekly-scan.js's digest) builds its index the
// same way from its own already-fetched target rows and looks up through
// lookupTargetIdentity() -- one shared implementation, not two.
//
// Fail-safe by construction: a miss (no matching target row, or the
// caller never had one to fetch -- e.g. a signal whose account predates
// Monitoring Identity V1 entirely) returns {}, so
// targetIdentityDomainSource is undefined and
// classifyMonitoringSignalEligibility() falls back to its existing
// Path-A-only behavior. A missing/unresolvable target can never
// accidentally promote a signal to priority.
// ============================================================================
export function buildTargetIdentityIndex(targetRows) {
  const index = new Map();
  for (const t of targetRows || []) {
    const normalized = normalizeCompanyName(t?.display_account_name);
    if (!normalized || !t?.user_id) continue;
    index.set(identityKey(t.user_id, normalized), {
      status: t.identity_status || 'unresolved',
      domain: t.identity_domain || null,
      source: t.identity_domain_source || null
    });
  }
  return index;
}

export function lookupTargetIdentity(index, userId, accountName) {
  if (!index || !userId) return {};
  return index.get(identityKey(userId, normalizeCompanyName(accountName))) || {};
}

// ============================================================================
// Signal-level eligibility -- classifies an ALREADY-GROUNDED signal
// (verifyCandidateCompanyGrounding()'s output) into what it is allowed to
// become downstream. This is the ONE centralized policy every consumer
// (dashboard opportunity feed, Research Details, weekly digest, and any
// future proactive notification) must call -- no consumer should invent
// its own trust rule.
// ============================================================================

// Reads the ACTUAL corroborator reasons verifyCandidateCompanyGrounding()
// pushes, not just its identityConfidence label -- REQUIRED because
// today's identityConfidence:'confirmed' is reached by ANY of six
// corroborators (domain, location, publisher-geo, self-domain-inference,
// known-social-profile, exact-social-handle) treated as equivalent. This
// investigation concluded they are not: a company-name match corroborated
// only by a location string or a geo-matched publisher domain is not the
// same strength of evidence as an uploaded/contact-derived business domain
// or a KNOWN account social profile. The exact reason strings matched here
// are the literal ones verifyCandidateCompanyGrounding() pushes today (see
// that function's own comment for the full corroborator list) -- if that
// function's wording ever changes, this classification must be updated
// alongside it, which is exactly why it lives in one place.
const STRONG_REASON_MARKERS = [
  // Fires for BOTH an uploaded website match and (once the Queue path is
  // brought to contact-derivation parity) a contact-derived business
  // domain match -- entityMatch() cannot distinguish the two from the
  // candidate side, and per the strong/weak matrix both count as strong.
  // Target-level provenance (identity_domain_source) is what distinguishes
  // them for reporting/backfill purposes, not this signal-level check.
  'verified company domain',
  "matches account's known official social profile"
];
const WEAK_REASON_MARKERS = [
  'location match',
  'publisher domain matches account city+state geography',
  "candidate domain exactly matches the account's own single-token company name",
  "social handle exactly matches the account's own compacted company name",
  'social handle text resembles account name'
];

export function classifyCorroboratorTier(reasons = []) {
  const list = Array.isArray(reasons) ? reasons : [];
  if (list.some(r => STRONG_REASON_MARKERS.some(marker => String(r).includes(marker)))) return 'strong';
  if (list.some(r => WEAK_REASON_MARKERS.some(marker => String(r).includes(marker)))) return 'weak';
  return 'none';
}

// priority: eligible for the main opportunity feed, "new signal" treatment,
//   digest, and any proactive notification. Reached via either of two
//   paths (founder QA, live Test B follow-up -- see below for why a
//   second path was added):
//     Path A -- signal-level strong corroboration: a STRONG corroborator
//       on the signal itself (see classifyCorroboratorTier()) and no
//       contradiction. A bare name match, or a name match with only weak/
//       inferred corroboration, is never enough on its own.
//     Path B -- strongly resolved target + strong signal-side name match:
//       the TARGET already carries a Strong, independently-established
//       account-side identity anchor (identityDomainSource is
//       'uploaded-website', 'contact-derived', or the future
//       'rep-confirmed' -- never a value derived from the candidate being
//       classified; see resolveTargetIdentity()'s own circularity guard,
//       untouched by this function), AND the signal's own
//       identityConfidence is at least 'unconfirmed' -- a genuine bare/
//       exact normalized company-name match (hasBareNameMatch in
//       verifyCandidateCompanyGrounding()), never the weaker embedded-in-
//       a-larger-entity or token-only 'possible' tier. In this path the
//       source itself does not need to contain or be hosted on the target
//       domain -- once identity is durably established account-side,
//       requiring every third-party article to also independently restate
//       the customer's own domain would defeat part of the purpose of
//       resolving identity first (the canonical case: a customer-supplied
//       website + a credible, explicitly-naming third-party news article
//       with no domain backlink and no contradiction).
//   Strong target identity alone never promotes arbitrary evidence --
//   'possible' (embedded/token-only/uncorroborated single-token matches,
//   e.g. a synthetic "Harborview Medical" appearing only as part of the
//   real "Harborview Medical Center") stays 'secondary' even for a fully
//   resolved target, and an unresolved target gets no benefit from Path B
//   at all.
// secondary: visible to the rep in Research Details / "Other signals
//   found" / equivalent surfaces, always with an explicit identity
//   caveat -- never phrased as confirmed intelligence. Covers 'possible',
//   an unresolved-target 'unconfirmed', and a 'confirmed' verdict whose
//   only corroborator turned out to be weak and whose target lacks a
//   Strong anchor.
// hidden: never shown. Only 'rejected' -- checked before either path, so
//   an explicit identity contradiction can never be promoted by a strong
//   target anchor -- and in current production practice, a rejected
//   signal is already discarded before persistence (see
//   mapSignalsFromModelOutput()), so this branch mostly exists for
//   completeness/future paths that might persist rejected candidates for
//   audit purposes.
//
// LEGACY GRANDFATHER: a row with no identityConfidence at all (persisted
// before the tri-state grounding model existed -- 104 of 135 production
// ha_signals rows today) is deliberately NOT retroactively reclassified by
// this policy. This function governs signals that were actually run
// through the tri-state model; applying it backward to rows that never
// had that evaluation would silently change the visibility of a large
// number of already-relied-upon historical signals as a side effect of
// this change, which is out of scope here (see "Existing ha_signals do
// not need destructive rewriting").
const STRONG_TARGET_IDENTITY_SOURCES = ['uploaded-website', 'contact-derived', 'rep-confirmed'];

export function classifyMonitoringSignalEligibility({ identityConfidence, reasons, targetIdentityDomainSource } = {}) {
  if (identityConfidence === undefined || identityConfidence === null) return 'priority';
  if (identityConfidence === 'rejected') return 'hidden';
  const tier = classifyCorroboratorTier(reasons);
  if (tier === 'strong') return 'priority';
  const targetHasStrongAnchor = STRONG_TARGET_IDENTITY_SOURCES.includes(targetIdentityDomainSource);
  const signalAtLeastUnconfirmed = identityConfidence === 'unconfirmed' || identityConfidence === 'confirmed';
  if (targetHasStrongAnchor && signalAtLeastUnconfirmed) return 'priority';
  return 'secondary';
}
