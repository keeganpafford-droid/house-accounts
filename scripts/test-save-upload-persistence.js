// Phase 2A / A2 + B3 defense-in-depth — validates api/save-upload.js's
// persistence path without a live database: mocks global.fetch for auth,
// upload lookup, the replace_ha_accounts_snapshot RPC, and the ha_signals
// insert, then invokes the real exported handler with fake req/res objects.
//
// Covers:
// - the account snapshot now goes through the RPC endpoint, not a raw
//   DELETE + POST pair
// - accountsSaved reflects what the RPC actually returned, not just what was
//   attempted
// - instrumentation counts (received / resolved / unique fingerprints /
//   attempted / persisted / conflict-ignored) are numerically correct against
//   a simulated ignore-duplicates conflict
// - the B3 defense-in-depth guard corrects a signal whose declared
//   signalType disagrees with its canonically-resolved eventType (the shape
//   of the exact frozen Phase 1B mismatches, simulated here for a caller
//   that has not attached canonicalEventType)
//
// What this CANNOT prove without a live Postgres/Supabase connection: that
// the advisory lock inside replace_ha_accounts_snapshot() actually
// serializes two truly concurrent calls end-to-end. That requires the
// controlled QA validation procedure against a real database — see the
// Phase 2A validation report.
//
// Usage: node scripts/test-save-upload-persistence.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler from '../api/save-upload.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function fakeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}

const UPLOAD_ID = 'upload-1';
const USER_ID = 'user-1';
let rpcCalls = [];
let signalsInsertCalls = [];
let simulateConflictOnSecondSignal = false;

function mockFetch(){
  return async (url, options = {}) => {
    const u = String(url);
    if(u.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-1', email: 'qa@example.com' });
    if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([{ id: USER_ID, email: 'qa@example.com', organization_id: null }]);
    if(u.includes('/rest/v1/ha_uploads') && options.method === 'PATCH') return jsonResponse([{ id: UPLOAD_ID }]);
    if(u.includes('/rest/v1/ha_uploads') && options.method === 'POST') return jsonResponse([{ id: UPLOAD_ID }]);
    if(u.includes('/rest/v1/ha_organizations')) return jsonResponse([]);
    if(u.includes('/rest/v1/rpc/replace_ha_accounts_snapshot')){
      const body = JSON.parse(options.body);
      rpcCalls.push(body);
      // Simulate the RPC's real behavior: it returns exactly the rows it persisted.
      const returned = (body.p_accounts || []).map((a, i) => ({ id: `acct-${i}`, upload_id: body.p_upload_id, account_name: a.account_name }));
      return jsonResponse(returned);
    }
    if(u.includes('/rest/v1/ha_signals')){
      const body = JSON.parse(options.body);
      signalsInsertCalls.push(body);
      let toReturn = body;
      if(simulateConflictOnSecondSignal && body.length > 1){
        // Simulate PostgREST's real ignore-duplicates + return=representation
        // behavior: only the rows that were NOT a conflict come back.
        toReturn = [body[0]];
      }
      return jsonResponse(toReturn.map((r, i) => ({ ...r, id: `sig-${i}`, first_seen_at: new Date().toISOString() })));
    }
    throw new Error(`Unhandled mock fetch URL in test: ${u}`);
  };
}

function fakeReq(body){
  return { method: 'POST', headers: { authorization: 'Bearer valid-token' }, body };
}

const originalFetch = global.fetch;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
let logLines = [];
function captureLog(original){ return (...args) => { logLines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); original(...args); }; }
console.log = captureLog(originalConsoleLog);
console.warn = captureLog(originalConsoleWarn);

async function run(){
  // 1. Normal save: account snapshot goes through the RPC, not DELETE+POST.
  {
    rpcCalls = []; signalsInsertCalls = []; simulateConflictOnSecondSignal = false; logLines = [];
    global.fetch = mockFetch();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      uploadName: 'QA Block 1',
      stage: 'research_updated',
      researchRunId: 'run-test-1',
      accounts: [
        { name: 'Acme Co', signals: [] },
        { name: 'Beta Inc', signals: [] }
      ]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'a normal save returns 200');
    assert(rpcCalls.length === 1, 'exactly one call to replace_ha_accounts_snapshot is made for one save');
    assert(rpcCalls[0].p_upload_id === UPLOAD_ID && rpcCalls[0].p_user_id === USER_ID, 'the RPC call carries the correct upload_id and user_id');
    assert(Array.isArray(rpcCalls[0].p_accounts) && rpcCalls[0].p_accounts.length === 2, 'the RPC call carries the full account snapshot as one jsonb array, not per-row calls');
    assert(res.body.accountsSaved === 2, 'accountsSaved reflects what the RPC actually returned');
    assert(logLines.some(l => l.includes('[save-upload.instrumentation]') && l.includes('run-test-1')), 'the instrumentation log line is written and carries the researchRunId');
  }

  // 2. Signal instrumentation: two signals submitted, one is a genuine
  // conflict (simulated by the mock ha_signals response omitting it) -- the
  // response and log must report attempted=2, persisted=1, conflict-ignored=1,
  // not just "signalsSaved: 2" as the pre-Phase-2A code would have implied.
  {
    rpcCalls = []; signalsInsertCalls = []; simulateConflictOnSecondSignal = true; logLines = [];
    global.fetch = mockFetch();
    const commonFields = { accountName: 'Acme Co', sourceUrl: 'https://example.com/a', confidenceScore: 70 };
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      uploadName: 'QA Block 1',
      stage: 'research_updated',
      researchRunId: 'run-test-2',
      accounts: [{
        name: 'Acme Co',
        signals: [
          { ...commonFields, signalType: 'Acquisition', type: 'Acquisition', signalTitle: 'Acme completes acquisition of Rival Inc', whatChanged: 'Acme Corp completes acquisition of Rival Inc.' },
          { ...commonFields, signalType: 'Award / Recognition', type: 'Award / Recognition', signalTitle: 'Acme wins industry award', whatChanged: 'Acme Corp wins a major industry award for innovation.' }
        ]
      }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'the signal-conflict scenario still returns 200');
    assert(res.body.signalsAttempted === 2, 'response reports 2 attempted signal inserts');
    assert(res.body.signalsSaved === 1, 'response reports exactly 1 persisted row, matching the simulated conflict');
    assert(res.body.signalsConflictIgnored === 1, 'response reports exactly 1 conflict-ignored row, not silently absent');
    const instrumentationLine = logLines.find(l => l.includes('[save-upload.instrumentation]') && l.includes('run-test-2'));
    assert(!!instrumentationLine, 'a distinct instrumentation log line exists for this run');
    if(instrumentationLine){
      const parsed = JSON.parse(instrumentationLine.replace('[save-upload.instrumentation] ', ''));
      assert(parsed.attemptedSignalInserts === 2 && parsed.persistedSignalRows === 1 && parsed.conflictIgnoredRows === 1, 'the structured log line itself carries the same attempted/persisted/conflict-ignored breakdown as the HTTP response — this is exactly the field set needed to classify a future accepted-vs-persisted gap as intentional dedup vs. actual loss');
    }
  }

  // 3. B3 defense-in-depth: a signal whose declared type disagrees with its
  // canonically-resolved eventType (no canonicalEventType attached, as if
  // from a caller that predates B3) must be corrected before persistence,
  // not silently written with two disagreeing classification fields.
  {
    rpcCalls = []; signalsInsertCalls = []; simulateConflictOnSecondSignal = false; logLines = [];
    global.fetch = mockFetch();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      uploadName: 'QA Block 1',
      stage: 'research_updated',
      researchRunId: 'run-test-3',
      accounts: [{
        name: 'Acme Co',
        signals: [{
          accountName: 'Acme Co', sourceUrl: 'https://example.com/b', confidenceScore: 75,
          signalType: 'Totally Wrong Label', type: 'Totally Wrong Label',
          signalTitle: 'Acme completes acquisition of Rival Inc',
          whatChanged: 'Acme Corp completes acquisition of Rival Inc.'
          // no canonicalEventType -- simulates a pre-B3 caller
        }]
      }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'the mismatched-classification scenario still returns 200');
    assert(signalsInsertCalls.length === 1 && signalsInsertCalls[0].length === 1, 'exactly one signal row is attempted for insert');
    assert(signalsInsertCalls[0][0].signal_type === 'Acquisition', `the persisted signal_type is corrected to the canonically-resolved label ("Acquisition"), not left as the disagreeing declared value (got "${signalsInsertCalls[0][0].signal_type}")`);
    assert(logLines.some(l => l.includes('classification mismatch corrected')), 'the correction is logged, not silently applied');
  }

  global.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
