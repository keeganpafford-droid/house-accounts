// Phase 1 monitoring-architecture foundation: pure, DB-free logic for
// deriving durable ha_monitoring_targets identity from ha_accounts rows,
// detecting identity collisions, and computing deterministic staggered
// due dates. No Supabase/network calls live here on purpose -- everything
// in this file is a plain function of its arguments, so it is fully
// covered by scripts/test-monitoring-targets.js without any mocking.
// scripts/backfill-monitoring-targets.js is the thin I/O wrapper that
// fetches real rows and calls into this module.
//
// Identity model (locked direction, see supabase-schema-migration-15):
// (user_id, normalizeCompanyName(account_name)) -- deliberately the SAME
// tuple api/signal-intelligence.js's event_fingerprint already uses, for
// the same reason: it is the one identity proven to survive uploads,
// research-triggered resaves, and list maintenance in this codebase today.
// Deliberately user_id-scoped, not organization_id-scoped -- see the
// migration's header comment for the named limitation this accepts.
import { createHash } from 'crypto';
import { normalizeCompanyName } from '../company-identity.js';

export { normalizeCompanyName };

// One week, in milliseconds -- the initial stagger window. Not a cadence
// decision (cadence stays weekly per the locked direction); purely the
// span new/backfilled targets' first next_due_at is spread across so
// ~20,000 targets do not all become due at once.
export const STAGGER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function identityKey(userId, normalizedCompanyName) {
  return `${userId}|${normalizedCompanyName}`;
}

// Deterministic 0..2^32-1 integer from a stable string. sha256 (not the
// weaker FNV-1a hashString() already used elsewhere in this codebase for
// non-security instrumentation) purely because Node's crypto module makes
// it free and this value never needs to be short/human-readable -- there is
// no security property being relied on here, only determinism and a
// reasonably even distribution.
function stableHashInt(input) {
  const hex = createHash('sha256').update(String(input || '')).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

// Deterministic initial due date for a given identity: same (userId,
// normalizedCompanyName) always lands in the same relative offset within
// the stagger window, independent of insertion order, backfill re-run
// timing, or signup clustering -- required for idempotency (re-running the
// backfill must compute the identical next_due_at for an identity it has
// already seen, even though this function is only ever actually called for
// identities NOT yet present -- see buildBackfillPlan()) and for spreading
// load without depending on uniform arrival patterns.
export function computeStaggeredDueDate(userId, normalizedCompanyName, referenceNowMs = Date.now()) {
  const offsetMs = stableHashInt(identityKey(userId, normalizedCompanyName)) % STAGGER_WINDOW_MS;
  return new Date(referenceNowMs + offsetMs).toISOString();
}

// ha_accounts.raw_data.monitoring_status -> ha_monitoring_targets.status.
// 'paused' is temporary (the account may resume monitoring later, keep the
// target but stop scheduling it). 'archived' maps to 'removed': the
// account is not coming back, so no future monitoring is intended for it,
// same terminal posture as a target whose account was deleted outright.
// Anything else (missing, 'active', unrecognized) is 'active' -- matches
// api/weekly-scan.js's own existing filter, which only ever excludes
// 'paused'/'archived' and treats everything else as monitorable.
function targetStatusFromMonitoringStatus(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (v === 'paused') return 'paused';
  if (v === 'archived') return 'removed';
  return 'active';
}

// Groups raw account rows into one candidate monitoring target per
// (user_id, normalized_company_name), and separately reports any identity
// where more than one DISTINCT literal account_name collapses onto the
// same normalized key for the same user -- an ambiguous case this
// function deliberately refuses to resolve on its own.
//
// Why a collision is not "the same company re-uploaded": the same literal
// account_name reappearing across multiple uploads/account rows for one
// user is the NORMAL, expected case this identity model exists to unify
// (e.g. a customer list re-uploaded weekly) -- that collapses to exactly
// one group, no collision. A collision only exists when two or more
// DIFFERENTLY-SPELLED live account names (e.g. "ABC Manufacturing" vs
// "A.B.C. Manufacturing") happen to normalize to the identical key for the
// same user -- normalizeCompanyName() is deliberately name-based and never
// fuzzy (see company-identity.js), so this can only happen from real
// spelling variation, and this function cannot know whether that variation
// means "same real company, unify" or "coincidentally similar names,
// different real companies." Per the product decision, it does neither
// silently: no target is produced for a colliding identity at all (see
// buildBackfillPlan() -- a missing target simply never gets scheduled,
// which is the conservative failure mode: it can never become a source of
// wrong-company intelligence), and the collision is reported so a human
// can resolve it later.
//
// accountRows: [{ id, user_id, organization_id, account_name, upload_id,
//   updated_at, monitoring_status }]
export function groupAccountsForBackfill(accountRows = []) {
  const byKey = new Map();
  for (const row of accountRows || []) {
    const normalized = normalizeCompanyName(row?.account_name);
    // A name that normalizes to nothing (blank/purely-punctuation input)
    // has no safe identity to monitor under -- skipped, not defaulted to
    // some placeholder key that could collide across unrelated accounts.
    if (!normalized) continue;
    const key = identityKey(row.user_id, normalized);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const groups = [];
  const collisions = [];
  for (const rows of byKey.values()) {
    const distinctLiteralNames = Array.from(new Set(rows.map(r => String(r.account_name || '').trim()))).sort();
    if (distinctLiteralNames.length > 1) {
      collisions.push({
        userId: rows[0].user_id,
        normalizedCompanyName: normalizeCompanyName(rows[0].account_name),
        literalNames: distinctLiteralNames,
        accountIds: rows.map(r => r.id)
      });
      continue;
    }
    // Single literal name, possibly several rows (re-uploads over time) --
    // the most recently updated row is authoritative for display/status/
    // upload-pointer fields. Ties (identical updated_at) fall back to
    // whichever the input order already put first, which is fine: they are
    // the same literal name, so display fields cannot meaningfully differ.
    const authoritative = [...rows].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))[0];
    groups.push({
      userId: authoritative.user_id,
      organizationId: authoritative.organization_id,
      normalizedCompanyName: normalizeCompanyName(authoritative.account_name),
      displayAccountName: authoritative.account_name,
      currentUploadId: authoritative.upload_id || null,
      status: targetStatusFromMonitoringStatus(authoritative.monitoring_status)
    });
  }
  return { groups, collisions };
}

// Idempotent plan: only identities NOT already present in existingKeys are
// scheduled for insertion, each with a freshly-computed staggered
// next_due_at. Re-running the backfill against the same groups + the same
// (now-larger) existingKeys set therefore always converges to
// toInsert:[] -- a no-op, not a re-insert or an update. Deliberately never
// updates an already-present target's status/display/upload fields here:
// once a target exists, keeping it in sync with later account-list changes
// is future-phase "sync on save" work, not this one-time backfill's job --
// see the migration's header comment.
//
// existingKeys: Set<string> of identityKey(userId, normalizedCompanyName)
// for targets that already exist in ha_monitoring_targets.
export function buildBackfillPlan({ groups = [], existingKeys = new Set(), now = Date.now() } = {}) {
  const toInsert = [];
  let alreadyPresentCount = 0;
  for (const g of groups) {
    const key = identityKey(g.userId, g.normalizedCompanyName);
    if (existingKeys.has(key)) { alreadyPresentCount += 1; continue; }
    toInsert.push({
      user_id: g.userId,
      organization_id: g.organizationId,
      normalized_company_name: g.normalizedCompanyName,
      display_account_name: g.displayAccountName,
      current_upload_id: g.currentUploadId,
      status: g.status,
      next_due_at: computeStaggeredDueDate(g.userId, g.normalizedCompanyName, now)
    });
  }
  return { toInsert, alreadyPresentCount };
}
