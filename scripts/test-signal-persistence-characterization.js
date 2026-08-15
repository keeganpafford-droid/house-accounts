// Phase 2C: characterizes api/lib/signal-persistence.js's
// persistValidatedSignals() -- the single shared "validated signals ->
// durable ha_signals rows" boundary api/weekly-scan.js and the Queue
// monitoring worker (api/queues/monitoring-consumer.js) both call. Proves,
// with a fully mocked supabase() (no real network/env dependency, same
// dependency-injection philosophy as scripts/test-monitoring-queue-
// adapter.js), the exact list of behaviors required before this boundary
// could be trusted to gate Queue-worker cadence advancement:
//   - event_fingerprint generation (same real event -> same fingerprint)
//   - which fields are persisted
//   - user_id / account attribution
//   - source URL / evidence persistence
//   - on_conflict=user_id,event_fingerprint behavior (exact insert/refresh
//     calls, not inferred)
//   - repeat scan / duplicate behavior
//   - zero-signal behavior
//   - failure behavior (persistence failure is never swallowed)
//
// Usage: node scripts/test-signal-persistence-characterization.js
import { persistValidatedSignals } from '../api/lib/signal-persistence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}
async function assertRejects(promise, message) {
  try { await promise; failures += 1; console.error(`FAIL: ${message} (did not reject)`); }
  catch { console.log(`PASS: ${message}`); }
}

// Same minimal fixture shape scripts/test-weekly-scan-reliability.js already
// relies on to produce a real, stable event_fingerprint via the real
// (unmocked) resolveOpportunityEvents()/resolveEvents() -- not a hand-wave.
function makeSignal(overrides = {}) {
  return {
    accountName: 'Gamma Co', signalType: 'Business Activity', signalTitle: 'Gamma Co opens new distribution center',
    whatChanged: 'Gamma Co opened a new distribution center', whyItMattersForPromo: 'Timely reason to reach out',
    sourceUrl: 'https://example.com/gamma-co-distribution-center', confidenceScore: 82,
    publicationDate: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
}

function makeMockSupabase({ failInsert = false, insertResponder = null } = {}) {
  const calls = [];
  const supabase = async (path, options = {}) => {
    calls.push({ path, options: { ...options } });
    if (options.method === 'GET') {
      // Legacy v1->v2 bridge fetch -- no pre-existing legacy rows in these
      // characterization tests.
      return [];
    }
    if (options.prefer && options.prefer.includes('ignore-duplicates')) {
      if (failInsert) throw new Error('Supabase 500: simulated insert failure');
      if (insertResponder) return insertResponder(JSON.parse(options.body));
      // Default: echo back exactly what was sent, simulating a genuinely
      // fresh insert (every row is new).
      return JSON.parse(options.body);
    }
    if (options.prefer && options.prefer.includes('merge-duplicates')) {
      return JSON.parse(options.body);
    }
    return [];
  };
  return { supabase, calls };
}

// ---------------------------------------------------------------------------
// event_fingerprint generation.
// ---------------------------------------------------------------------------
{
  const { supabase } = makeMockSupabase();
  const result = await persistValidatedSignals({ userId: 'u1', signals: [makeSignal()], supabase });
  assert(result.resolvedSignals.length === 1 && !!result.resolvedSignals[0].eventFingerprint, 'REQUIRED: a real, well-formed signal resolves to a non-empty event_fingerprint via the real (unmocked) resolveOpportunityEvents()');

  // Determinism: the SAME signal resolved twice (two independent calls,
  // not the dedup-within-one-call path) produces the SAME fingerprint both
  // times -- this is what the later repeat-scan/on_conflict behavior below
  // actually depends on. (Whether two DIFFERENTLY-worded descriptions of
  // the same real-world event merge to one fingerprint is resolveEvents()'s
  // own merge-threshold behavior -- already characterized by the
  // dedicated event-resolution test suites, e.g.
  // scripts/test-event-dedup-e2e.js -- not re-derived here, since this
  // module is a thin caller of that function, not a second implementation
  // of it.)
  const { supabase: supabase2 } = makeMockSupabase();
  const again = await persistValidatedSignals({ userId: 'u1', signals: [makeSignal()], supabase: supabase2 });
  assert(again.resolvedSignals[0].eventFingerprint === result.resolvedSignals[0].eventFingerprint, 'REQUIRED: event_fingerprint generation is deterministic -- the same signal resolved independently twice produces the identical fingerprint, which is what makes the on_conflict dedup below actually work');
}

// ---------------------------------------------------------------------------
// Which fields are persisted; user_id/account attribution; source URL/
// evidence persistence.
// ---------------------------------------------------------------------------
{
  const { supabase } = makeMockSupabase();
  const result = await persistValidatedSignals({ userId: 'user-42', uploadId: 'upload-1', weeklyRunId: 'run-1', signals: [makeSignal()], supabase });
  assert(result.rowsToInsert.length === 1, 'exactly one row is built for one accepted signal');
  const row = result.rowsToInsert[0];
  assert(row.user_id === 'user-42', 'REQUIRED: user_id attribution is the real caller-provided userId');
  assert(row.upload_id === 'upload-1' && row.weekly_run_id === 'run-1', 'upload_id/weekly_run_id are threaded through when provided (weekly-scan case)');
  assert(row.account_name === 'Gamma Co', 'REQUIRED: account_name attribution matches the signal\'s own accountName');
  assert(typeof row.event_fingerprint === 'string' && row.event_fingerprint.length > 0, 'event_fingerprint is persisted');
  assert(typeof row.signal_hash === 'string' && row.signal_hash.length > 0, 'signal_hash is persisted');
  assert(row.signal_type === 'Business Activity', 'signal_type is persisted');
  assert(row.title === 'Gamma Co opens new distribution center', 'title is persisted from signalTitle');
  assert(row.why_reach_out === 'Timely reason to reach out', 'why_reach_out is persisted from whyItMattersForPromo');
  assert(row.confidence === 82, 'confidence is persisted from confidenceScore');
  assert(row.source_url === 'https://example.com/gamma-co-distribution-center', 'REQUIRED: source_url (the evidence link) is persisted verbatim');
  assert(typeof row.published_at === 'string' && row.published_at.length > 0, 'published_at is persisted');
  assert(row.payload && row.payload.accountName === 'Gamma Co', 'REQUIRED: the full resolved signal is retained in payload -- evidence/context is not truncated away');
  assert(typeof row.first_seen_at === 'string' && typeof row.last_seen_at === 'string', 'first_seen_at/last_seen_at are stamped');
}

// ---------------------------------------------------------------------------
// on_conflict=user_id,event_fingerprint behavior -- exact insert and
// refresh-upsert calls, not inferred.
// ---------------------------------------------------------------------------
{
  const { supabase, calls } = makeMockSupabase();
  await persistValidatedSignals({ userId: 'u1', signals: [makeSignal()], supabase });
  const nonGet = calls.filter(c => c.options.method !== 'GET');
  assert(nonGet.length === 2, `REQUIRED: exactly two writes per persisted signal -- one ignore-duplicates insert, one merge-duplicates refresh-upsert (got ${nonGet.length})`);
  assert(nonGet[0].path === 'ha_signals?on_conflict=user_id,event_fingerprint' && nonGet[0].options.prefer === 'resolution=ignore-duplicates,return=representation', 'REQUIRED: the first write is the exact ignore-duplicates insert against ha_signals with the (user_id, event_fingerprint) conflict target');
  assert(nonGet[1].path === 'ha_signals?on_conflict=user_id,event_fingerprint' && nonGet[1].options.prefer === 'resolution=merge-duplicates', 'REQUIRED: the second write is the exact merge-duplicates refresh-upsert against the SAME conflict target');
}

// ---------------------------------------------------------------------------
// Repeat scan / duplicate behavior.
// ---------------------------------------------------------------------------
{
  let insertCallCount = 0;
  const { supabase } = makeMockSupabase({
    insertResponder: (rows) => {
      insertCallCount += 1;
      // First call: genuinely new -- Postgres returns the inserted row.
      // Second call: Postgres' ignore-duplicates silently skips the
      // already-known event_fingerprint -- returns nothing.
      return insertCallCount === 1 ? rows : [];
    }
  });
  const signal = makeSignal();
  const first = await persistValidatedSignals({ userId: 'u1', signals: [signal], supabase });
  assert(first.newSignalRows.length === 1, 'first persistence of a new event reports exactly one new row');

  const second = await persistValidatedSignals({ userId: 'u1', signals: [signal], supabase });
  assert(second.rowsToInsert.length === 1, 'REQUIRED: a repeat scan of the same event still BUILDS and ATTEMPTS the row (so interpretation can refresh), even though it will not create a new row');
  assert(second.newSignalRows.length === 0, 'REQUIRED: a repeat scan of an already-known event reports ZERO new rows -- no duplicate is created or double-counted');
  assert(insertCallCount === 2, 'the ignore-duplicates insert is attempted both times (idempotent, not skipped client-side)');
}

// ---------------------------------------------------------------------------
// Zero-signal behavior.
// ---------------------------------------------------------------------------
{
  const { supabase, calls } = makeMockSupabase();
  const result = await persistValidatedSignals({ userId: 'u1', signals: [], supabase });
  assert(calls.length === 0, 'REQUIRED: zero signals means ZERO Supabase calls of any kind -- no legacy-bridge fetch, no insert, no refresh-upsert');
  assert(result.resolvedSignals.length === 0 && result.rowsToInsert.length === 0 && result.newSignalRows.length === 0, 'a zero-signal call returns empty results, not an error');
  assert(result.bridgeStats.bridged === 0 && result.bridgeStats.multiMatch === 0, 'bridgeStats is a real, zeroed object for a zero-signal call, not undefined');
}

// ---------------------------------------------------------------------------
// Failure behavior -- a persistence failure is never swallowed.
// ---------------------------------------------------------------------------
{
  const { supabase } = makeMockSupabase({ failInsert: true });
  await assertRejects(
    persistValidatedSignals({ userId: 'u1', signals: [makeSignal()], supabase }),
    'REQUIRED: a Supabase insert failure propagates as a rejected promise -- persistValidatedSignals() never swallows a persistence error into a false success'
  );
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
