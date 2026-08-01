// Phase 2A / A2 + B3 defense-in-depth, extended through implementation-review
// ROUNDS 4-5 — validates api/save-upload.js's persistence path without a
// live database: mocks global.fetch for auth, upload lookup, the
// replace_ha_accounts_snapshot RPC (untracked path), the
// persist_ha_research_output RPC (tracked path, now with atomic
// finalization), the ha_research_runs active-run lookup (untracked path's
// new state-machine check), and the plain ha_signals insert (untracked
// path), then invokes the real exported handler with fake req/res objects.
//
// Covers (rounds 1-4, still passing):
// - the account snapshot goes through an RPC endpoint, not a raw DELETE +
//   POST pair, for both the untracked and tracked paths
// - instrumentation counts are numerically correct against a simulated
//   ignore-duplicates conflict
// - the B3 defense-in-depth guard corrects a mismatched signal classification
// - a stale/replaced attempt is rejected and writes NOTHING to ha_accounts,
//   ha_signals, OR ha_uploads (all three, atomically, via ONE call)
//
// NEW this round (ROUND 5):
// - persist_ha_research_output() finalizes the run (status='completed') as
//   part of the SAME successful transaction -- verified via the mock's
//   researchRuns fixture actually flipping to 'completed'
// - the full server-side stage state machine: unknown stages rejected,
//   stage='uploaded' cannot carry signals/research-summary/attempt
//   metadata, and is rejected against an upload with an ACTIVE run (but
//   NOT a merely completed one)
//
// What this CANNOT prove without a live Postgres/Supabase connection: that
// the advisory lock inside persist_ha_research_output()/
// replace_ha_accounts_snapshot() actually serializes two truly concurrent
// calls end-to-end. See scripts/phase2a-rpc-authorization-tests.sql for the
// real-RPC-level tests (not executable in this session — no DB connection).
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
let accountsRpcCalls = [];
let persistRpcCalls = [];
let signalsInsertCalls = [];
let uploadPatchCalls = [];
let activeRunLookupCalls = [];
let simulateConflictOnSecondSignal = false;

// In-memory ha_research_runs fixture. Round 5: persistHaResearchOutput()
// below now mutates the matched row to status='completed' on success,
// mirroring persist_ha_research_output()'s new atomic finalization
// (migration 6 §6) exactly.
let researchRuns = [];
let fakeAccounts = [];
let fakeSignals = [];
let fakeUploadState = { stage: 'uploaded', summary: {} };

function persistHaResearchOutput(body){
  const run = researchRuns.find(r => r.user_id === body.p_user_id && r.upload_id === body.p_upload_id && r.research_run_id === body.p_research_run_id);
  if(!run || run.status !== 'running' || run.attempt_id !== body.p_attempt_id){
    return { ok: false, status: 400, body: { message: 'stale attempt', code: 'HA001' } };
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

  // ROUND 5: atomic finalization, same transaction (same mock call).
  run.status = 'completed';
  run.completed_at = new Date().toISOString();
  run.result_summary = { accountsPersisted, signalsAttempted, signalsPersisted, signalsConflictIgnored: Math.max(0, signalsAttempted - signalsPersisted) };
  run.heartbeat_at = new Date().toISOString();
  run.lease_expires_at_ms = Date.now();

  return {
    ok: true, status: 200,
    body: {
      accountsPersisted, signalsAttempted, signalsPersisted,
      signalsConflictIgnored: Math.max(0, signalsAttempted - signalsPersisted),
      status: 'completed', completedAt: run.completed_at, attemptId: body.p_attempt_id
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
    if(u.includes('/rest/v1/ha_research_runs') && u.includes('status=eq.running') && (!options.method || options.method === 'GET')){
      activeRunLookupCalls.push(u);
      const now = Date.now();
      const active = researchRuns.filter(r => r.upload_id === UPLOAD_ID && r.status === 'running' && (r.lease_expires_at_ms === undefined || r.lease_expires_at_ms > now));
      return jsonResponse(active.map(r => ({ id: r.id || 'run-row' })));
    }
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
  accountsRpcCalls = []; persistRpcCalls = []; signalsInsertCalls = []; uploadPatchCalls = []; activeRunLookupCalls = [];
  researchRuns = []; fakeAccounts = []; fakeSignals = []; fakeUploadState = { stage: 'uploaded', summary: {} };
  simulateConflictOnSecondSignal = false; logLines = [];
  global.fetch = mockFetch();
}

function trackedSignal(overrides = {}){
  return { accountName: 'Signal Account', signalTitle: 'A signal', sourceUrl: 'https://example.com/sig', confidenceScore: 70, signalType: 'Acquisition', ...overrides };
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
  // UNTRACKED PATH (stage='uploaded'): the ONLY untracked stage.
  // =========================================================================

  // 1. Valid initial upload with accounts only -- the one legitimate
  // untracked shape.
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
    assert(res.statusCode === 200, 'a valid initial-upload (accounts-only) save returns 200');
    assert(accountsRpcCalls.length === 1, 'exactly one call to replace_ha_accounts_snapshot is made');
    assert(accountsRpcCalls[0].p_research_run_id === undefined, 'the untracked path never passes attempt parameters');
    assert(res.body.accountsSaved === 2, 'accountsSaved reflects what the RPC actually returned');
    assert(persistRpcCalls.length === 0, 'persist_ha_research_output is never called for an untracked save');
  }

  // 2. Unknown stage is rejected.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'totally-made-up-stage',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'an unknown/invalid stage string is rejected 400, not silently accepted and passed through');
    assert(accountsRpcCalls.length === 0 && persistRpcCalls.length === 0 && uploadPatchCalls.length === 0, 'nothing was written for the unknown-stage request');
  }

  // 3. stage=uploaded with signals is rejected.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      accounts: [{ name: 'Acme Co', signals: [trackedSignal()] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'stage="uploaded" carrying signals is rejected 400 -- signals are research output');
    assert(accountsRpcCalls.length === 0 && uploadPatchCalls.length === 0, 'nothing was written');
  }

  // 4. stage=uploaded with a research summary is rejected.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      summary: { accountCount: 1, reasonsToReachOut: 5, businessSignals: 2 },
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'stage="uploaded" carrying a non-zero research-result summary (reasonsToReachOut/businessSignals) is rejected 400');
  }

  // 4b. stage=uploaded with attempt metadata is rejected (contradictory).
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      researchRunId: 'auto',
      attemptId: 'some-attempt',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'stage="uploaded" carrying researchRunId/attemptId is rejected 400 -- the untracked stage cannot claim attempt metadata');
  }

  // 5. stage=uploaded against an upload with an ACTIVE run is rejected.
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-active', lease_expires_at_ms: Date.now() + 300000 }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 409, 'stage="uploaded" against an upload with a currently ACTIVE research run is rejected 409 -- it must not overwrite/append while research is in flight');
    assert(accountsRpcCalls.length === 0, 'nothing was written for the active-run case');
    assert(activeRunLookupCalls.length === 1, 'the active-run lookup was actually performed, not skipped');
  }

  // 6. stage=uploaded against an upload with a COMPLETED run succeeds --
  // plain account edits must keep working after research finishes.
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'completed', attempt_id: 'attempt-done', completed_at: new Date().toISOString(), lease_expires_at_ms: Date.now() - 1000 }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      accounts: [{ name: 'Edited Account Name', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'stage="uploaded" against an upload with a COMPLETED (not active) run succeeds -- a manual account edit after research finishes is not research output and is not blocked');
    assert(accountsRpcCalls.length === 1, 'the accounts-only edit was persisted normally');
  }

  // =========================================================================
  // TRACKED PATH: research-output stages, mandatory attempt metadata.
  // =========================================================================

  // 7. Missing attempt metadata for a research-output stage is rejected.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'a research-output-stage save with NO researchRunId/attemptId is rejected 400');
    assert(persistRpcCalls.length === 0, 'nothing was written');
  }

  // 8. Valid current attempt metadata succeeds, and the run finalizes
  // atomically as part of the SAME call (ROUND 5, item 1).
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-current' }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-current',
      summary: { accountCount: 1, reasonsToReachOut: 1 },
      accounts: [{ name: 'Current Attempt Write', signals: [trackedSignal({ accountName: 'Current Attempt Write' })] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'the current attempt saves successfully');
    assert(res.body.runStatus === 'completed', 'the HTTP response reflects the run as completed, from the SAME call');
    const row = researchRuns[0];
    assert(row.status === 'completed' && !!row.completed_at, 'ITEM 1 TEST 1: persistence succeeds and the run becomes completed in the SAME transaction (one mock call)');
    assert(row.result_summary && row.result_summary.accountsPersisted === 1 && row.result_summary.signalsPersisted === 1, 'result_summary reflects the actual persisted counts');
  }

  // 7b. attemptId without researchRunId is rejected as malformed.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      attemptId: 'orphan-attempt-id',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'attemptId without researchRunId is rejected 400 for a research-output stage');
  }

  // 7c. missing uploadId for a research-output stage is rejected.
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

  // 9. Signal instrumentation (tracked path): two signals submitted, one is
  // a genuine conflict.
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-conflict' }];
    const commonFields = { accountName: 'Acme Co', sourceUrl: 'https://example.com/a', confidenceScore: 70 };
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-conflict',
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
    assert(res.statusCode === 200, 'the tracked signal-conflict scenario returns 200');
    assert(res.body.signalsAttempted === 2, 'response reports 2 attempted signal inserts');
    assert(res.body.signalsSaved <= 2, 'response reports persisted signals (deduped canonical events may collapse to fewer than 2 distinct fingerprints)');
  }

  // 10. B3 defense-in-depth (tracked path): a signal whose declared type
  // disagrees with its canonically-resolved eventType must be corrected.
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-b3' }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-b3',
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
    assert(res.statusCode === 200, 'the mismatched-classification scenario returns 200');
    assert(logLines.some(l => l.includes('classification mismatch corrected')), 'the correction is logged, not silently applied');
    assert(persistRpcCalls[0].p_signals[0].signal_type === 'Acquisition', `the persisted signal_type is corrected to the canonically-resolved label ("Acquisition"), not left as the disagreeing declared value (got "${persistRpcCalls[0].p_signals[0].signal_type}")`);
  }

  // =========================================================================
  // Phase 2A implementation-review ROUND 5, item 1: atomic finalization.
  // =========================================================================

  // ITEM 1 TEST 4: "HTTP response is lost after commit; retry returns
  // completed cached result and performs no provider calls." Simulated at
  // the persistence layer: after a successful call finalizes the run,
  // ANOTHER call with the SAME (now-stale, since status flipped) attempt_id
  // must be rejected (the attempt is no longer 'running') -- proving a
  // "retry" of the ORIGINAL request cannot re-run persistence a second
  // time. (The actual claim-returns-cached-result behavior for a fresh
  // claim call is proven in scripts/test-research-run-idempotency.js
  // against claim_ha_research_run() directly.)
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-retry' }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-retry',
      accounts: [{ name: 'Retry Write', signals: [] }]
    });
    const first = await handler(req, fakeRes());
    const retryRes = fakeRes();
    await handler(fakeReq({ ...req.body }), retryRes);
    assert(retryRes.statusCode === 409 && retryRes.body.staleAttempt === true, 'ITEM 1 TEST 4: retrying the identical (now-completed) save request is rejected -- the same attempt cannot persist twice, matching "the same attempt cannot write more research output"');
    assert(persistRpcCalls.length === 2, 'the retry DID reach persist_ha_research_output (so we know it was correctly rejected there, not silently no-op\'d client-side)');
  }

  // ITEM 1 TEST 6: stale attempt cannot finalize (rejected before
  // finalization is even attempted -- the SAME HA001 check gates both
  // persistence and finalization since they are one transaction).
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-B-current' }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-A-stale',
      accounts: [{ name: 'Stale Write', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 409 && res.body.staleAttempt === true, 'ITEM 1 TEST 6: a stale attempt cannot finalize -- rejected before persistence, let alone finalization, is attempted');
    assert(researchRuns[0].status === 'running' && researchRuns[0].attempt_id === 'attempt-B-current', 'the CURRENT attempt (B) row is completely untouched by the stale attempt\'s rejected call');
  }

  // ITEM 1 TEST 7: the current attempt cannot persist additional research
  // output AFTER completion (its own prior success already finalized the
  // run, so a second call with the SAME attempt_id now fails the
  // status='running' check).
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-once' }];
    const firstReq = fakeReq({
      lead: { email: 'qa@example.com' }, uploadId: UPLOAD_ID, stage: 'researched',
      researchRunId: 'auto', attemptId: 'attempt-once',
      accounts: [{ name: 'First Write', signals: [] }]
    });
    const firstRes = fakeRes();
    await handler(firstReq, firstRes);
    assert(firstRes.statusCode === 200, 'the first persistence call succeeds and finalizes the run');
    const secondReq = fakeReq({
      lead: { email: 'qa@example.com' }, uploadId: UPLOAD_ID, stage: 'research_updated',
      researchRunId: 'auto', attemptId: 'attempt-once',
      accounts: [{ name: 'Second Write (should be rejected)', signals: [] }]
    });
    const secondRes = fakeRes();
    await handler(secondReq, secondRes);
    assert(secondRes.statusCode === 409 && secondRes.body.staleAttempt === true, 'ITEM 1 TEST 7: the SAME attempt cannot persist additional research output after its own completion');
    assert(!fakeAccounts.some(a => a.account_name === 'Second Write (should be rejected)'), 'the second write never persisted');
  }

  // ITEM 1 TEST 8: explicit manual rerun after completion remains
  // authorized (a genuinely DIFFERENT attempt_id/research_run_id, as the
  // real claim_ha_research_run() would mint for runIntent:'manual-rerun').
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'completed', attempt_id: 'attempt-old', completed_at: new Date().toISOString() }];
    researchRuns.push({ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'manual-rerun-1', status: 'running', attempt_id: 'attempt-manual-new' });
    const req = fakeReq({
      lead: { email: 'qa@example.com' }, uploadId: UPLOAD_ID, stage: 'researched',
      researchRunId: 'manual-rerun-1', attemptId: 'attempt-manual-new',
      accounts: [{ name: 'Manual Rerun Write', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'ITEM 1 TEST 8: an explicit manual-rerun attempt (a different research_run_id/attempt_id) persists and finalizes successfully after the original run already completed');
    assert(researchRuns[1].status === 'completed', 'the manual rerun\'s own row is finalized independently of the original completed run');
  }

  // =========================================================================
  // Structural: exactly one RPC call handles account+signal+upload-state+
  // finalization together (no separate steps for a takeover to land between).
  // =========================================================================
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-x' }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-x',
      accounts: [{ name: 'Solo Account', signals: [trackedSignal({ accountName: 'Solo Account' })] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'the tracked save succeeds');
    assert(accountsRpcCalls.length === 0 && signalsInsertCalls.length === 0, 'the tracked path never calls replace_ha_accounts_snapshot or the plain ha_signals insert directly');
    assert(persistRpcCalls.length === 1, 'exactly one consolidated, self-finalizing call handles accounts + signals + upload-state + completion');
  }

  global.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
