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
// REGRESSION (confirmed production incident, first Phase 2C live signals):
// refreshableSignalRow() omitted account_name -- ha_signals' only NOT
// NULL, no-default column besides signal_hash -- so the merge-duplicates
// refresh-upsert failed Postgres' pre-conflict NOT NULL validation on
// EVERY call, even though the permissive mocks above never caught it
// (they accept any row shape, exactly like Postgres does NOT). The
// dedicated "schema-aware mock" section below specifically enforces the
// real NOT NULL columns, closing that blind spot.
//
// Usage: node scripts/test-signal-persistence-characterization.js
import { persistValidatedSignals, refreshableSignalRow } from '../api/lib/signal-persistence.js';

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

// ---------------------------------------------------------------------------
// REGRESSION: refreshableSignalRow() must include account_name.
// ---------------------------------------------------------------------------
{
  const row = {
    user_id: 'u1', event_fingerprint: 'fp-1', signal_hash: 'hash-1', account_name: 'Clearwater Engineering',
    signal_type: 'Business Activity', title: 'Title', why_reach_out: 'Reason', confidence: 80,
    source_url: 'https://example.com', source_domain: 'example.com', published_at: '2026-08-01',
    payload: { some: 'data' }, last_seen_at: '2026-08-01T00:00:00.000Z'
  };
  const shaped = refreshableSignalRow(row);
  assert(shaped.account_name === 'Clearwater Engineering', 'REQUIRED (regression): refreshableSignalRow() includes account_name in its refresh-upsert shape');
  assert(!('first_seen_at' in shaped), 'refreshableSignalRow() still never carries first_seen_at through (unchanged by the fix)');
  assert(shaped.event_fingerprint === 'fp-1' && shaped.user_id === 'u1' && shaped.signal_hash === 'hash-1', 'refreshableSignalRow() still keeps the identity/conflict-target columns (unchanged by the fix)');
}

// ---------------------------------------------------------------------------
// REGRESSION: the second (merge-duplicates) upsert call's actual request
// body includes account_name, not just the object returned by
// refreshableSignalRow() in isolation.
// ---------------------------------------------------------------------------
{
  const { supabase, calls } = makeMockSupabase();
  await persistValidatedSignals({ userId: 'u1', signals: [makeSignal()], supabase });
  const refreshCall = calls.find(c => c.options.prefer === 'resolution=merge-duplicates');
  assert(!!refreshCall, 'sanity: a merge-duplicates refresh-upsert call was made');
  const refreshBody = JSON.parse(refreshCall.options.body);
  assert(Array.isArray(refreshBody) && refreshBody.length === 1 && refreshBody[0].account_name === 'Gamma Co', `REQUIRED (regression): the ACTUAL refresh-upsert request body sent to Supabase includes account_name (got ${JSON.stringify(refreshBody[0]?.account_name)})`);
}

// ---------------------------------------------------------------------------
// REGRESSION: a schema-aware mock that enforces ha_signals' real NOT NULL
// columns (account_name, signal_hash -- confirmed via information_schema
// against the live production schema) now succeeds end to end. This is
// deliberately STRICTER than makeMockSupabase() above, which (like every
// prior test in this file) accepts any row shape -- exactly the blind spot
// that let the original bug ship past a fully-passing test suite.
// ---------------------------------------------------------------------------
function makeSchemaAwareMockSupabase({ insertResponder = null } = {}) {
  const NOT_NULL_NO_DEFAULT_COLUMNS = ['account_name', 'signal_hash'];
  const calls = [];
  let ignoreDuplicatesCallCount = 0;
  const supabase = async (path, options = {}) => {
    calls.push({ path, options: { ...options } });
    if (options.method === 'GET') return [];
    if (path.startsWith('ha_signals') && options.body) {
      const rows = JSON.parse(options.body);
      for (const row of rows) {
        for (const col of NOT_NULL_NO_DEFAULT_COLUMNS) {
          if (row[col] === undefined || row[col] === null) {
            // The exact error shape the real production incident hit.
            const err = new Error(`Supabase 400: null value in column "${col}" of relation "ha_signals" violates not-null constraint`);
            err.status = 400;
            throw err;
          }
        }
      }
      if (options.prefer && options.prefer.includes('ignore-duplicates')) {
        ignoreDuplicatesCallCount += 1;
        if (insertResponder) return insertResponder(rows, ignoreDuplicatesCallCount);
      }
    }
    return JSON.parse(options.body);
  };
  return { supabase, calls };
}

{
  const { supabase } = makeSchemaAwareMockSupabase();
  const result = await persistValidatedSignals({ userId: 'u1', signals: [makeSignal()], supabase });
  assert(result.newSignalRows.length === 1, `REQUIRED (regression): persistValidatedSignals() now succeeds end to end against a mock that enforces the REAL NOT NULL columns Postgres actually has, closing the exact gap the permissive mocks above missed (this is the mock that would have caught the original bug before it shipped)`);
}

// ---------------------------------------------------------------------------
// REGRESSION: existing duplicate-refresh semantics remain unchanged by the
// fix -- same repeat-scan behavior as the earlier (permissive-mock) test,
// now proven against the schema-aware mock too.
// ---------------------------------------------------------------------------
{
  const { supabase } = makeSchemaAwareMockSupabase({
    // First ignore-duplicates insert: genuinely new, Postgres returns the
    // row. Second: Postgres silently skips the already-known
    // event_fingerprint, returns nothing -- same simulated semantics as
    // the earlier permissive-mock repeat-scan test.
    insertResponder: (rows, callNumber) => (callNumber === 1 ? rows : [])
  });
  const signal = makeSignal();
  const first = await persistValidatedSignals({ userId: 'u1', signals: [signal], supabase });
  assert(first.newSignalRows.length === 1, 'unchanged: first persistence of a new event still reports exactly one new row against the schema-aware mock');

  const second = await persistValidatedSignals({ userId: 'u1', signals: [signal], supabase });
  assert(second.rowsToInsert.length === 1, 'unchanged: a repeat scan still BUILDS and ATTEMPTS the row');
  assert(second.newSignalRows.length === 0, 'unchanged: a repeat scan of an already-known event still reports ZERO new rows');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
