// Phase 2C: the single, shared "validated signals -> durable ha_signals
// rows" persistence boundary. Extracted verbatim from api/weekly-scan.js's
// own resolveOpportunityEvents() -> event_fingerprint -> ha_signals insert
// path (itself the same path api/save-upload.js established) -- not a
// second implementation. Both api/weekly-scan.js and the Queue monitoring
// worker (api/queues/monitoring-consumer.js, via api/lib/monitoring-
// queue.js) call this exact function; neither has its own copy of the
// row-building/dedup/on_conflict logic below.
//
// Dependency-injected supabase(path, options) fetch helper, matching this
// codebase's established pattern (api/weekly-scan.js, api/queues/
// monitoring-consumer.js, api/monitoring-scheduler.js each keep their own
// local supabase() implementation) -- this module has no hidden global
// Supabase client of its own, so it is fully testable with a mocked
// supabase function (see scripts/test-signal-persistence-
// characterization.js), never a real network/env-var dependency.
import { resolveOpportunityEvents, dedupeByEventFingerprint } from '../signal-intelligence.js';
import { fetchLegacySignalsForAccounts, applyLegacyFingerprintBridge } from '../save-upload.js';

export function clean(v = '') { return String(v || '').trim(); }

function hashString(input = '') {
  let h = 2166136261;
  const s = String(input || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

export function signalHash(userId, uploadId, accountName, s) {
  return hashString([userId, uploadId, accountName, s.signalType || s.type || '', s.signalTitle || s.title || s.whatChanged || '', s.sourceUrl || s.source || ''].join('|').toLowerCase());
}

// product/commercial-opportunity-intelligence, QA correction 4 (re-research
// persistence) -- same allowlist and rationale as api/save-upload.js's own
// refreshableSignalRow(): never event_fingerprint/user_id (identity, must
// stay stable) and never first_seen_at (when we first learned about it),
// but every column that represents our CURRENT interpretation of the event.
export function refreshableSignalRow(row) {
  return {
    user_id: row.user_id,
    event_fingerprint: row.event_fingerprint,
    signal_hash: row.signal_hash,
    signal_type: row.signal_type,
    title: row.title,
    why_reach_out: row.why_reach_out,
    confidence: row.confidence,
    source_url: row.source_url,
    source_domain: row.source_domain,
    published_at: row.published_at,
    payload: row.payload,
    last_seen_at: row.last_seen_at
  };
}

function buildSignalRow({ userId, uploadId, weeklyRunId, resolvedSignal: s }) {
  return {
    user_id: userId,
    upload_id: uploadId,
    weekly_run_id: weeklyRunId,
    account_name: clean(s.accountName),
    event_fingerprint: s.eventFingerprint,
    signal_hash: signalHash(userId, uploadId, s.accountName, s),
    signal_type: clean(s.signalType || 'Business Activity'),
    title: clean(s.signalTitle || s.whatChanged || ''),
    why_reach_out: clean(s.whyItMattersForPromo || s.suggestedOpener || ''),
    confidence: Number(s.confidenceScore || s.confidence || 0) || null,
    source_url: clean(s.sourceUrl || ''),
    source_domain: clean(s.cleanSourceName || s.sourceName || ''),
    published_at: clean(s.publicationDate || '') || null,
    payload: s,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  };
}

// The single durable-persistence boundary. Given already-VALIDATED signals
// (anything reaching this function has already passed
// validateOpportunity()/verifyCandidateCompanyGrounding() upstream -- this
// function does no grounding/identity work itself, it only persists), this:
//
//   1. runs the SAME cross-signal event-resolution pass weekly-scan.js has
//      always run (resolveOpportunityEvents) -- required even for a
//      single-account monitoring call, so a monitoring account's signal
//      gets the identical identity/event_fingerprint treatment a
//      weekly-scan signal for the same account would get;
//   2. bridges against any pre-v2 legacy rows for the touched account(s)
//      (applyLegacyFingerprintBridge, unchanged);
//   3. builds one row per resolved signal, deduped in-memory by
//      event_fingerprint (defensive -- the DB's unique constraint is the
//      final guard, not the only one);
//   4. ignore-duplicates inserts (new events only), then merge-duplicates
//      refresh-upserts (keeps interpretation current on a re-scan of an
//      already-known event, per QA correction 4) -- the exact two-step
//      write weekly-scan.js has always done.
//
// Zero-signal short-circuit: skips every network call (including the
// legacy-bridge fetch) when there is nothing to resolve. This is new
// relative to the original inline code (which always ran the legacy-bridge
// fetch even for an empty signals array), but is behavior-preserving: an
// empty resolvedSignals list can never produce a bridge match or a
// bridgeStats.bridged/multiMatch count above zero either way, so the
// caller-observable result (bridgeStats, newSignalRows) is identical --
// see scripts/test-signal-persistence-characterization.js's zero-signal
// case for the pinned proof.
//
// Throws (does not swallow) on any Supabase failure -- callers decide what
// a failed persistence means for their own completion semantics. In
// particular, the Queue monitoring worker must NOT advance cadence on a
// persistence failure; see api/lib/monitoring-queue.js's
// processMonitoringJob().
export async function persistValidatedSignals({ userId, uploadId = null, weeklyRunId = null, signals = [], supabase }) {
  const resolvedSignals = resolveOpportunityEvents(signals || []);
  if (!resolvedSignals.length) {
    return { resolvedSignals: [], rowsToInsert: [], newSignalRows: [], bridgeStats: { bridged: 0, multiMatch: 0 } };
  }

  const legacyRowsForBridge = await fetchLegacySignalsForAccounts(userId, resolvedSignals.map(s => s.accountName), supabase);
  const bridgeStats = applyLegacyFingerprintBridge(legacyRowsForBridge, resolvedSignals);

  const candidateRows = resolvedSignals
    .map(s => buildSignalRow({ userId, uploadId, weeklyRunId, resolvedSignal: s }))
    .filter(row => row.event_fingerprint);

  const rowsToInsert = dedupeByEventFingerprint(candidateRows, {
    keyOf: row => `${row.user_id}|${row.event_fingerprint}`,
    scoreOf: row => Number(row.confidence || 0)
  });

  let newSignalRows = [];
  if (rowsToInsert.length) {
    const inserted = await supabase('ha_signals?on_conflict=user_id,event_fingerprint', {
      method: 'POST',
      prefer: 'resolution=ignore-duplicates,return=representation',
      body: JSON.stringify(rowsToInsert)
    });
    // With ignore-duplicates, rows that collide with an already-stored
    // event for this account are silently skipped by Postgres and are not
    // returned here -- so newSignalRows reflects genuinely new events, and
    // a retried/duplicate persistence call never double-counts or
    // re-notifies on an event it already persisted.
    newSignalRows = Array.isArray(inserted) ? inserted : [];

    const refreshRows = rowsToInsert.map(refreshableSignalRow);
    const chunkSize = 200;
    for (let i = 0; i < refreshRows.length; i += chunkSize) {
      await supabase('ha_signals?on_conflict=user_id,event_fingerprint', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates',
        body: JSON.stringify(refreshRows.slice(i, i + chunkSize))
      });
    }
  }

  return { resolvedSignals, rowsToInsert, newSignalRows, bridgeStats };
}
