// Phase 2A / A2 + B3 defense-in-depth, extended through implementation-review
// ROUND 4 — validates api/save-upload.js's persistence path without a live
// database: mocks global.fetch for auth, upload lookup, the
// replace_ha_accounts_snapshot RPC (untracked path), the NEW
// persist_ha_research_output RPC (tracked path), and the plain ha_signals
// insert (untracked path), then invokes the real exported handler with fake
// req/res objects.
//
// Covers:
// - the account snapshot goes through an RPC endpoint, not a raw DELETE +
//   POST pair, for both the untracked and tracked paths
// - accountsSaved reflects what the RPC actually returned, not just what was
//   attempted
// - instrumentation counts (received / resolved / unique fingerprints /
//   attempted / persisted / conflict-ignored) are numerically correct against
//   a simulated ignore-duplicates conflict
// - the B3 defense-in-depth guard corrects a signal whose declared
//   signalType disagrees with its canonically-resolved eventType
// - ROUND 4: attempt metadata is MANDATORY for research-output stages; a
//   stale/replaced attempt is rejected and writes NOTHING to ha_accounts,
//   ha_signals, OR ha_uploads (all three, atomically, via ONE call to
//   persist_ha_research_output -- there is no longer a separate
//   pre-flight-then-write gap for a takeover to land in)
//
// What this CANNOT prove without a live Postgres/Supabase connection: that
// the advisory lock inside persist_ha_research_output()/
// replace_ha_accounts_snapshot() actually serializes two truly concurrent
// calls end-to-end, or that a concurrent claim_ha_research_run() call
// genuinely BLOCKS while persist_ha_research_output()'s transaction is
// open. Those require the controlled QA validation procedure against a
// real database and, for the blocking behavior specifically, two genuinely
// concurrent sessions -- see
// scripts/phase2a-rpc-authorization-tests.sql test 35's comment.
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
let accountsRpcCalls = [];       // replace_ha_accounts_snapshot (untracked path)
let persistRpcCalls = [];        // persist_ha_research_output (tracked path)
let signalsInsertCalls = [];     // plain ha_signals insert (untracked path)
let uploadPatchCalls = [];       // plain ha_uploads PATCH (untracked path only)
let simulateConflictOnSecondSignal = false;

// Phase 2A implementation-review ROUND 4 — in-memory fixtures mirroring the
// real ha_research_runs/ha_accounts/ha_signals/ha_uploads tables closely
// enough to exercise persist_ha_research_output()'s exact decision logic
// (migration 6 §3): one attempt check gates all three writes together.
let researchRuns = [];
let fakeAccounts = [];   // [{upload_id, account_name}]
let fakeSignals = [];    // [{user_id, event_fingerprint}]
let fakeUploadState = { stage: 'uploaded', summary: {} };

function persistHaResearchOutput(body){
  const run = researchRuns.find(r => r.user_id === body.p_user_id && r.upload_id === body.p_upload_id && r.research_run_id === body.p_research_run_id);
  if(!run || run.status !== 'running' || run.attempt_id !== body.p_attempt_id){
    const err = { message: 'stale attempt', code: 'HA001' };
    return { ok: false, status: 400, body: err };
  }
  let accountsPersisted = 0;
  if(body.p_accounts !== null && body.p_accounts !== undefined){
    fakeAccounts = fakeAccounts.filter(a => a.upload_id !== body.p_upload_id);
    for(const a of body.p_accounts){
      if(!a.account_name) continue;
      fakeAccounts.push({ upload_id: body.p_upload_id, account_name: a.account_name });
      accountsPersisted += 1;
    }
  }
  let signalsAttempted = 0, signalsPersisted = 0;
  if(Array.isArray(body.p_signals) && body.p_signals.length){
    for(const s of body.p_signals){
      if(!s.event_fingerprint) continue;
      signalsAttempted += 1;
      const exists = fakeSignals.some(x => x.user_id === body.p_user_id && x.event_fingerprint === s.event_fingerprint);
      if(!exists){ fakeSignals.push({ user_id: body.p_user_id, event_fingerprint: s.event_fingerprint }); signalsPersisted += 1; }
    }
  }
  if(body.p_upload_stage !== null && body.p_upload_stage !== undefined) fakeUploadState.stage = body.p_upload_stage;
  if(body.p_upload_summary !== null && body.p_upload_summary !== undefined) fakeUploadState.summary = body.p_upload_summary;
  return {
    ok: true, status: 200,
    body: {
      accountsPersisted,
      signalsAttempted,
      signalsPersisted,
      signalsConflictIgnored: Math.max(0, signalsAttempted - signalsPersisted),
      leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
      attemptId: body.p_attempt_id
    }
  };
}

function mockFetch(){
  return async (url, options = {}) => {
    const u = String(url);
    if(u.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-1', email: 'qa@example.com' });
    if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([{ id: USER_ID, email: 'qa@example.com', organization_id: null }]);
    if(u.includes('/rest/v1/ha_uploads') && options.method === 'PATCH'){ uploadPatchCalls.push(JSON.parse(options.body)); return jsonResponse([{ id: UPLOAD_ID }]); }
    if(u.includes('/rest/v1/ha_uploads') && options.method === 'POST') return jsonResponse([{ id: UPLOAD_ID }]);
    if(u.includes('/rest/v1/ha_organizations')) return jsonResponse([]);
    if(u.includes('/rest/v1/rpc/persist_ha_research_output')){
      const body = JSON.parse(options.body);
      persistRpcCalls.push(body);
      const result = persistHaResearchOutput(body);
      return jsonResponse(result.body, result.ok, result.status);
    }
    if(u.includes('/rest/v1/rpc/replace_ha_accounts_snapshot')){
      const body = JSON.parse(options.body);
      accountsRpcCalls.push(body);
      const returned = (body.p_accounts || []).map((a, i) => ({ id: `acct-${i}`, upload_id: body.p_upload_id, account_name: a.account_name }));
      return jsonResponse(returned);
    }
    if(u.includes('/rest/v1/ha_signals')){
      const body = JSON.parse(options.body);
      signalsInsertCalls.push(body);
      let toReturn = body;
      if(simulateConflictOnSecondSignal && body.length > 1){
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

function resetAll(){
  accountsRpcCalls = []; persistRpcCalls = []; signalsInsertCalls = []; uploadPatchCalls = [];
  researchRuns = []; fakeAccounts = []; fakeSignals = []; fakeUploadState = { stage: 'uploaded', summary: {} };
  simulateConflictOnSecondSignal = false; logLines = [];
  global.fetch = mockFetch();
}

const originalFetch = global.fetch;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
let logLines = [];
function captureLog(original){ return (...args) => { logLines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); original(...args); }; }
console.log = captureLog(originalConsoleLog);
console.warn = captureLog(originalConsoleWarn);

async function run(){
  // =========================================================================
  // UNTRACKED PATH (stage='uploaded'): unchanged behavior, still goes
  // through replace_ha_accounts_snapshot() with no attempt parameters and a
  // plain ha_signals insert.
  // =========================================================================

  // 1. Normal untracked save: account snapshot goes through the RPC, not
  // DELETE+POST.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      uploadName: 'QA Block 1',
      stage: 'uploaded',
      accounts: [
        { name: 'Acme Co', signals: [] },
        { name: 'Beta Inc', signals: [] }
      ]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'an untracked (stage=uploaded) save returns 200');
    assert(accountsRpcCalls.length === 1, 'exactly one call to replace_ha_accounts_snapshot is made for one untracked save');
    assert(accountsRpcCalls[0].p_upload_id === UPLOAD_ID && accountsRpcCalls[0].p_user_id === USER_ID, 'the RPC call carries the correct upload_id and user_id');
    assert(accountsRpcCalls[0].p_research_run_id === undefined, 'the untracked path never passes attempt parameters to replace_ha_accounts_snapshot');
    assert(res.body.accountsSaved === 2, 'accountsSaved reflects what the RPC actually returned');
    assert(persistRpcCalls.length === 0, 'the tracked persist_ha_research_output RPC is never called for an untracked save');
  }

  // 2. Signal instrumentation (untracked path): two signals submitted, one
  // is a genuine conflict.
  {
    resetAll();
    const commonFields = { accountName: 'Acme Co', sourceUrl: 'https://example.com/a', confidenceScore: 70 };
    simulateConflictOnSecondSignal = true;
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      uploadName: 'QA Block 1',
      stage: 'uploaded',
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
    assert(res.statusCode === 200, 'the untracked signal-conflict scenario still returns 200');
    assert(res.body.signalsAttempted === 2, 'response reports 2 attempted signal inserts');
    assert(res.body.signalsSaved === 1, 'response reports exactly 1 persisted row, matching the simulated conflict');
    assert(res.body.signalsConflictIgnored === 1, 'response reports exactly 1 conflict-ignored row, not silently absent');
  }

  // 3. B3 defense-in-depth (untracked path): a signal whose declared type
  // disagrees with its canonically-resolved eventType must be corrected.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      uploadName: 'QA Block 1',
      stage: 'uploaded',
      accounts: [{
        name: 'Acme Co',
        signals: [{
          accountName: 'Acme Co', sourceUrl: 'https://example.com/b', confidenceScore: 75,
          signalType: 'Totally Wrong Label', type: 'Totally Wrong Label',
          signalTitle: 'Acme completes acquisition of Rival Inc',
          whatChanged: 'Acme Corp completes acquisition of Rival Inc.'
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

  // =========================================================================
  // TRACKED PATH (ROUND 4): research-output stages go through ONE call to
  // persist_ha_research_output(). Attempt metadata is now MANDATORY.
  // =========================================================================

  // 4. Missing attempt metadata for a research-output stage is rejected,
  // before any work happens.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      // no researchRunId, no attemptId
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'a research-output-stage save with NO researchRunId/attemptId is rejected 400 -- attempt metadata is mandatory, not opt-in');
    assert(uploadPatchCalls.length === 0 && accountsRpcCalls.length === 0 && persistRpcCalls.length === 0, 'nothing was written for the missing-metadata request');
  }

  // 4b. attemptId without researchRunId is rejected as malformed too.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      attemptId: 'orphan-attempt-id', // no researchRunId
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'attemptId without researchRunId is rejected 400 for a research-output stage');
  }

  // 4c. missing uploadId for a research-output stage is rejected.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'some-attempt',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'a research-output-stage save with no uploadId at all is rejected 400');
  }

  // 5. A STALE attempt (already reclaimed) is rejected, and NOTHING is
  // written to ha_accounts, ha_signals, OR ha_uploads -- all three,
  // together, via the ONE atomic call. This is the exact scenario the round
  // 3 package could not yet guarantee for signals/upload-state.
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-B-current' }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-A-stale', // reclaimed -- the row now shows attempt-B-current
      summary: { note: 'should not persist' },
      accounts: [{ name: 'Stale Account Write', signals: [{
        accountName: 'Stale Account Write', signalTitle: 'Stale signal', sourceUrl: 'https://example.com/stale', confidenceScore: 50, signalType: 'Award'
      }] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 409 && res.body.staleAttempt === true, 'a stale (superseded) attempt is rejected 409 with staleAttempt:true');
    assert(uploadPatchCalls.length === 0, 'the plain ha_uploads PATCH never runs for a tracked save (it goes through the RPC instead)');
    assert(persistRpcCalls.length === 1, 'persist_ha_research_output WAS called (and correctly rejected the request)');
    assert(fakeAccounts.filter(a => a.upload_id === UPLOAD_ID).length === 0, 'ATTEMPT A: zero ha_accounts rows were written for this upload');
    assert(fakeSignals.length === 0, 'ATTEMPT A: zero ha_signals rows were written');
    assert(fakeUploadState.stage === 'uploaded' && fakeUploadState.summary.note === undefined, 'ATTEMPT A: ha_uploads research-state (stage/summary) was NOT overwritten');
  }

  // 6. The CURRENT (still-owning) attempt succeeds, and accounts + signals +
  // upload-state all persist together via the same call.
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-current' }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-current',
      summary: { accountCount: 1 },
      accounts: [{ name: 'Current Attempt Write', signals: [{
        accountName: 'Current Attempt Write', signalTitle: 'Real signal', sourceUrl: 'https://example.com/real', confidenceScore: 80, signalType: 'Acquisition'
      }] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'the current attempt saves successfully');
    assert(persistRpcCalls.length === 1 && persistRpcCalls[0].p_research_run_id === 'auto' && persistRpcCalls[0].p_attempt_id === 'attempt-current', 'exactly one call to persist_ha_research_output carries the current researchRunId/attemptId');
    assert(fakeAccounts.some(a => a.upload_id === UPLOAD_ID && a.account_name === 'Current Attempt Write'), 'the account was persisted');
    assert(fakeSignals.length === 1, 'the signal was persisted');
    assert(fakeUploadState.stage === 'researched' && fakeUploadState.summary.accountCount === 1, 'ha_uploads research-state was updated atomically alongside accounts/signals');
    assert(res.body.accountsSaved === 1 && res.body.signalsSaved === 1, 'the response reflects the RPC-returned counts');
  }

  // 7. Test 1-2-3-4-5 of the required scenario list, stated explicitly in
  // order: (1) attempt A passes an earlier heartbeat/claim, (2) attempt B
  // reclaims, (3) A attempts account persistence, (4) A attempts signal
  // persistence, (5) A attempts upload-summary persistence -- (6) all
  // rejected together, no row changes. Under the round-4 architecture these
  // are no longer three separate application-level calls to test
  // separately -- they are three effects of the SAME single call, which is
  // exactly the fix. This test asserts that structurally: one save request
  // carrying accounts + signals + a summary update produces exactly ONE
  // RPC call, and that call's rejection covers all three simultaneously.
  {
    resetAll();
    // (1) Attempt A claims/heartbeats successfully first.
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-A' }];
    // (2) Attempt B reclaims -- simulated directly by mutating the fixture,
    // exactly as claim_ha_research_run()'s reclaim would.
    researchRuns[0].attempt_id = 'attempt-B';
    // (3)+(4)+(5) Attempt A attempts persistence of accounts, signals, AND
    // an upload summary update, all in the SAME request.
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'research_updated',
      researchRunId: 'auto',
      attemptId: 'attempt-A',
      summary: { accountCount: 999, note: 'attempt A should not persist this' },
      accounts: [{ name: 'A Account', signals: [{
        accountName: 'A Account', signalTitle: 'A signal', sourceUrl: 'https://example.com/a-sig', confidenceScore: 60, signalType: 'Hiring'
      }] }]
    });
    const res = fakeRes();
    await handler(req, res);
    // (6) All rejected together, no row changes.
    assert(res.statusCode === 409 && res.body.staleAttempt === true, 'attempt A -- reclaimed by B before its request was even sent -- is rejected 409');
    assert(persistRpcCalls.length === 1, 'exactly ONE RPC call was made for the combined account+signal+summary save request (not three separate calls that could partially succeed)');
    assert(fakeAccounts.length === 0, 'account persistence: rejected, zero rows');
    assert(fakeSignals.length === 0, 'signal persistence: rejected, zero rows');
    assert(fakeUploadState.summary.note === undefined, 'upload-summary persistence: rejected, zero change');
  }

  // 8. Structural proof that there is no longer a "gap between account
  // persistence and signal persistence": the tracked path never calls
  // replace_ha_accounts_snapshot or the plain ha_signals insert endpoint at
  // all -- only ever persist_ha_research_output, once.
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-x' }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-x',
      accounts: [{ name: 'Solo Account', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'the tracked save succeeds');
    assert(accountsRpcCalls.length === 0, 'the tracked path never calls replace_ha_accounts_snapshot directly -- there is no separate account-only persistence step for a takeover to land between');
    assert(signalsInsertCalls.length === 0, 'the tracked path never calls the plain ha_signals insert endpoint directly -- there is no separate signal-only persistence step either');
    assert(persistRpcCalls.length === 1, 'exactly one consolidated call handles both');
  }

  global.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
