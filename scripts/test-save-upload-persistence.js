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
const OTHER_USER_ID = 'user-2';
// ROUND 7, item 2: ownership is now checked via a real ha_uploads lookup
// (id + user_id) BEFORE any RPC/mutation. This map is the mock's source of
// truth for that lookup; tests that need a "wrong owner" scenario point
// uploadOwnerMap[UPLOAD_ID] at OTHER_USER_ID instead.
let uploadOwnerMap = { [UPLOAD_ID]: USER_ID };
let accountsRpcCalls = [];
let persistRpcCalls = [];
let signalsInsertCalls = [];
let uploadPatchCalls = [];
let uploadOwnershipLookupCalls = [];
let simulateConflictOnSecondSignal = false;
// ROUND 7, item 3: simulates a generic/unexpected failure reaching
// replace_ha_accounts_snapshot (a network error, a dropped connection) --
// deliberately NOT one of the known HA00x/55P03 error codes, to prove the
// request fails CLOSED (500, nothing written) rather than being
// misinterpreted as "no active run" / silently succeeding.
let simulateAccountsRpcNetworkFailure = false;

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
  // Migration 6 correction: the attempt-validation UPDATE also requires the
  // row's OWN lease to still be unexpired, mirroring the same
  // lease_expires_at > now() condition added to heartbeat_ha_research_run()
  // (migration 5). An attempt whose lease already lapsed cannot finalize
  // through this RPC even if nobody has reclaimed it yet -- attempt_id
  // ownership alone is not sufficient.
  const leaseExpired = run && run.lease_expires_at_ms !== undefined && run.lease_expires_at_ms <= Date.now();
  if(!run || run.status !== 'running' || run.attempt_id !== body.p_attempt_id || leaseExpired){
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
      const existing = fakeSignals.find(x => x.user_id === body.p_user_id && x.event_fingerprint === s.event_fingerprint);
      if(!existing){
        // Migration 9: a genuinely new event_fingerprint is INSERTed --
        // first_seen_at/last_seen_at both set to "now", exactly like the
        // real INSERT's own VALUES clause.
        fakeSignals.push({
          user_id: body.p_user_id, upload_id: body.p_upload_id, account_name: s.account_name,
          signal_hash: s.signal_hash, event_fingerprint: s.event_fingerprint,
          signal_type: s.signal_type, title: s.title, why_reach_out: s.why_reach_out,
          confidence: s.confidence, source_url: s.source_url, source_domain: s.source_domain,
          published_at: s.published_at, payload: s.payload || {},
          first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString()
        });
        signalsPersisted += 1;
      } else {
        // Migration 9: ON CONFLICT DO UPDATE -- refreshes exactly the
        // interpretation columns, mirroring the real SET list. Identity
        // (user_id, event_fingerprint) cannot change (it's the match key);
        // first_seen_at, upload_id, account_name are deliberately excluded
        // from this update, exactly like the real migration.
        existing.signal_hash = s.signal_hash;
        existing.signal_type = s.signal_type;
        existing.title = s.title;
        existing.why_reach_out = s.why_reach_out;
        existing.confidence = s.confidence;
        existing.source_url = s.source_url;
        existing.source_domain = s.source_domain;
        existing.published_at = s.published_at;
        existing.payload = s.payload || {};
        existing.last_seen_at = new Date().toISOString();
        // NOT incremented: signalsPersisted must keep meaning "genuinely
        // NEW rows" (the xmax=0 trick in the real migration), never a
        // refreshed-but-already-known event.
      }
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

// Phase 2A implementation-review ROUND 7, items 3-4 -- reimplements
// replace_ha_accounts_snapshot()'s p_mode logic (mode validation, the
// active-run/research-history checks now performed INSIDE the RPC instead
// of a separate `.catch(() => [])`-guarded pre-flight query, and the
// accounts_maintenance account-identity lock), the SAME way
// persistHaResearchOutput() above reimplements persist_ha_research_output()
// -- mirroring the real PL/pgSQL function's branches/outcomes so this file
// exercises the SAME decision logic api/save-upload.js actually depends on,
// even though it cannot call the real RPC (no DB connection in this
// session). See supabase-schema-migration-7-mode-scoped-account-writes.sql
// and scripts/phase2a-rpc-authorization-tests.sql for direct RPC-level
// coverage of this same logic.
function replaceHaAccountsSnapshot(body){
  const mode = body.p_mode;
  if(!mode || !['initial_upload', 'accounts_maintenance', 'tracked_research'].includes(mode)){
    return { ok: false, status: 400, body: { message: 'invalid p_mode', code: '22023' } };
  }
  const hasHistory = researchRuns.some(r => r.upload_id === body.p_upload_id);
  if(mode === 'initial_upload' && hasHistory){
    return { ok: false, status: 400, body: { message: 'upload already has research history', code: 'HA003' } };
  }
  if(mode === 'accounts_maintenance'){
    const now = Date.now();
    const activeRunning = researchRuns.some(r => r.upload_id === body.p_upload_id && r.status === 'running' && (r.lease_expires_at_ms === undefined || r.lease_expires_at_ms > now));
    if(activeRunning){
      return { ok: false, status: 400, body: { message: 'a research run is currently active', code: '55P03' } };
    }
    if(hasHistory){
      const existingNames = new Set(fakeAccounts.filter(a => a.upload_id === body.p_upload_id).map(a => a.account_name));
      const incomingNames = new Set((body.p_accounts || []).map(a => a.account_name).filter(Boolean));
      const identical = existingNames.size === incomingNames.size && [...existingNames].every(n => incomingNames.has(n));
      if(!identical){
        return { ok: false, status: 400, body: { message: 'accounts_maintenance cannot add, remove, or rename accounts once research history exists', code: 'HA004' } };
      }
    }
  }
  fakeAccounts = fakeAccounts.filter(a => a.upload_id !== body.p_upload_id);
  const inserted = [];
  for(const a of (body.p_accounts || [])){
    if(!a.account_name) continue;
    const row = { upload_id: body.p_upload_id, account_name: a.account_name, industry: a.industry, contact_name: a.contact_name, contact_email: a.contact_email };
    fakeAccounts.push(row);
    inserted.push(row);
  }
  return { ok: true, status: 200, body: inserted };
}

function mockFetch(){
  return async (url, options = {}) => {
    const u = String(url);
    if(u.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-1', email: 'qa@example.com' });
    if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([{ id: USER_ID, email: 'qa@example.com', organization_id: null }]);
    if(u.includes('/rest/v1/ha_users?on_conflict=email') && options.method === 'POST'){
      // The legacy anonymous lead.email upsert path (Auth 6) -- a genuinely
      // NEW anonymous upload with no token. Returns a fresh user id derived
      // from the submitted email so it's distinguishable from USER_ID.
      const [row] = JSON.parse(options.body);
      return jsonResponse([{ id: `anon-${row.email}`, email: row.email, organization_id: null }]);
    }
    // ROUND 7, item 2: the ownership pre-check, performed BEFORE any
    // RPC/mutation whenever uploadId is present. Distinguished from the
    // PATCH/POST handlers below by method (GET) and by carrying
    // "user_id=eq." in the query string.
    if(u.includes('/rest/v1/ha_uploads') && u.includes('user_id=eq.') && (!options.method || options.method === 'GET')){
      uploadOwnershipLookupCalls.push(u);
      const idMatch = u.match(/id=eq\.([^&]+)/);
      const userMatch = u.match(/user_id=eq\.([^&]+)/);
      const qUploadId = idMatch ? decodeURIComponent(idMatch[1]) : null;
      const qUserId = userMatch ? decodeURIComponent(userMatch[1]) : null;
      const owns = qUploadId && qUserId && uploadOwnerMap[qUploadId] === qUserId;
      return jsonResponse(owns ? [{ id: qUploadId }] : []);
    }
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
      if(simulateAccountsRpcNetworkFailure){
        // A real network/connection failure -- fetch() itself rejects, no
        // response object at all. NOT one of the known HA00x/55P03 codes.
        throw new Error('simulated network failure reaching replace_ha_accounts_snapshot');
      }
      const result = replaceHaAccountsSnapshot(body);
      return jsonResponse(result.body, result.ok, result.status);
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
// ROUND 7, item 2 -- no Authorization header at all, simulating a request
// with no session token (authFetchUser() returns null immediately without
// even reaching the mock's /auth/v1/user handler, exactly like the real
// api/save-upload.js's authFetchUser() does when req.headers.authorization
// is empty).
function fakeReqNoAuth(body){
  return { method: 'POST', headers: {}, body };
}

function resetAll(){
  accountsRpcCalls = []; persistRpcCalls = []; signalsInsertCalls = []; uploadPatchCalls = []; uploadOwnershipLookupCalls = [];
  uploadOwnerMap = { [UPLOAD_ID]: USER_ID };
  researchRuns = []; fakeAccounts = []; fakeSignals = []; fakeUploadState = { stage: 'uploaded', summary: {} };
  simulateConflictOnSecondSignal = false; simulateAccountsRpcNetworkFailure = false; logLines = [];
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
  // Phase 2A implementation-review ROUND 7, item 2: identity/authentication
  // rules. All seven required scenarios. "All existing-upload failures must
  // occur before any RPC or mutation" is asserted directly via
  // accountsRpcCalls/persistRpcCalls/uploadPatchCalls staying empty.
  // =========================================================================

  // Auth 1: no token + existing uploadId + correct owner email -- rejected.
  // A request-supplied email is not authentication, full stop, the moment
  // uploadId is present.
  {
    resetAll();
    const req = fakeReqNoAuth({
      lead: { email: 'qa@example.com' }, // the REAL owner's email
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 401, 'Auth 1: no token + existing uploadId + correct owner email is rejected 401 -- the email is never consulted as identity once uploadId is present');
    assert(uploadOwnershipLookupCalls.length === 0 && accountsRpcCalls.length === 0 && uploadPatchCalls.length === 0, 'Auth 1: rejected before any ownership lookup, RPC, or mutation');
  }

  // Auth 2: no token + stage=accounts_updated -- rejected (authentication is
  // mandatory for every stage other than "uploaded", independent of
  // whether uploadId happens to be present too).
  {
    resetAll();
    const req = fakeReqNoAuth({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 401, 'Auth 2: no token + stage="accounts_updated" is rejected 401');
    assert(accountsRpcCalls.length === 0, 'Auth 2: rejected before any RPC call');
  }

  // Auth 3: spoofed owner email + another user's upload -- rejected the
  // same way as Auth 1, regardless of what the supplied email claims to be.
  // (There is no separate "spoofed" code path to test -- the point IS that
  // email content is irrelevant here; this scenario is Auth 1 restated with
  // an explicitly adversarial framing to make that explicit.)
  {
    resetAll();
    const req = fakeReqNoAuth({
      lead: { email: 'qa@example.com', name: 'Attacker pretending to be the owner' },
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      accounts: [{ name: 'Hijacked Accounts', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 401, 'Auth 3: a spoofed/correct-looking owner email with no token is still rejected 401 against an existing upload');
    assert(accountsRpcCalls.length === 0, 'Auth 3: nothing was written');
  }

  // Auth 4: valid token + wrong upload owner -- rejected 403. The token
  // resolves to a real, authenticated user (USER_ID, per the mock's fixed
  // /auth/v1/user + ha_users responses) but that user does not own
  // UPLOAD_ID in this scenario (ownership transferred to OTHER_USER_ID).
  {
    resetAll();
    uploadOwnerMap[UPLOAD_ID] = OTHER_USER_ID;
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 403, 'Auth 4: a valid token whose user does not own the target upload is rejected 403');
    assert(uploadOwnershipLookupCalls.length === 1, 'Auth 4: the ownership lookup was actually performed');
    assert(accountsRpcCalls.length === 0, 'Auth 4: rejected before any RPC call');
  }

  // Auth 5: valid owner token -- succeeds normally.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      uploadName: 'Auth 5',
      stage: 'uploaded',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'Auth 5: a valid token whose user DOES own the target upload succeeds');
    assert(uploadOwnershipLookupCalls.length === 1 && accountsRpcCalls.length === 1, 'Auth 5: the ownership lookup ran, then the RPC ran');
  }

  // Auth 6: anonymous new-upload request with NO uploadId -- the one
  // remaining legitimate case for the legacy lead.email fallback. Still
  // succeeds, exactly as before this round.
  {
    resetAll();
    const req = fakeReqNoAuth({
      lead: { email: 'brand-new-anonymous@example.com', name: 'New Lead' },
      stage: 'uploaded',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'Auth 6: an anonymous stage="uploaded" request with NO uploadId (genuinely new upload) still succeeds via the legacy lead.email fallback');
  }

  // Auth 7: anonymous request that ATTEMPTS to provide an uploadId -- this
  // is the core fix. Before this round, this succeeded via the lead.email
  // fallback (the exact gap item 2 closes): anyone who knew (or guessed) an
  // upload's owner's email could fully overwrite that upload's accounts
  // with no token at all. Now it is rejected 401 like any other
  // uploadId-present request with no token.
  {
    resetAll();
    const req = fakeReqNoAuth({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 401, 'Auth 7: an anonymous request that supplies uploadId is rejected 401 -- lead.email can never target an EXISTING upload, only create a new one');
    assert(accountsRpcCalls.length === 0, 'Auth 7: nothing was written');
  }

  // =========================================================================
  // Phase 2A implementation-review ROUND 7, item 3: fail-closed on a
  // database/RPC failure. A generic, unrecognized failure reaching
  // replace_ha_accounts_snapshot() (simulating a network error or dropped
  // connection -- NOT one of the known HA00x/55P03 codes) must reject the
  // whole request (500), never be interpreted as "no active run" / success.
  // =========================================================================
  {
    resetAll();
    simulateAccountsRpcNetworkFailure = true;
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'uploaded',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 500, 'Fail-closed: an unrecognized failure reaching replace_ha_accounts_snapshot() rejects the whole request (500), not 200');
    assert(fakeAccounts.length === 0, 'Fail-closed: nothing was written when the state-check/write call itself failed');
  }

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
  // ROUND 7, item 3: p_mode=initial_upload's ONLY state check is "does this
  // upload have ANY research history" (per the user's exact mode spec, it
  // has no separate active-run check of its own) -- an active run counts as
  // history, so this is rejected the same way as a completed one (HA003,
  // 400), not a distinct 409. This is actually MORE correct than a
  // dedicated 409 would be here: once ANY research has happened for this
  // upload, stage="uploaded" is wrong regardless of whether that run is
  // still active or has since completed -- retrying the SAME stage later
  // would never succeed either way, so "try again" (409) would be
  // misleading; "use a different stage" (400) is the accurate signal.
  // stage="accounts_updated" (test 6e below) is the one that gets a
  // dedicated 409 for an active run, because retrying accounts_updated
  // later legitimately DOES succeed once the run completes.
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
    assert(res.statusCode === 400, 'stage="uploaded" against an upload with a currently ACTIVE research run is rejected 400 (HA003, "already has research history") -- it must not overwrite/append while research is in flight or ever again for this stage');
    assert(accountsRpcCalls.length === 1 && accountsRpcCalls[0].p_mode === 'initial_upload', 'ROUND 7 item 3: the history check now runs INSIDE replace_ha_accounts_snapshot() (p_mode=initial_upload) -- the RPC IS called (and rejects with HA003), not skipped by a separate pre-flight check');
    assert(fakeAccounts.length === 0, 'nothing was written for the active-run case');
  }

  // 6. Phase 2A implementation-review ROUND 6, item 3 — stage="uploaded" is
  // now initial-upload-creation ONLY. Reusing it against an upload that
  // already has ANY research history (even a merely COMPLETED run) is
  // rejected; stage="accounts_updated" (tested below) is the correct way to
  // edit accounts after research has happened.
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
    assert(res.statusCode === 400, 'ROUND 6 item 3: stage="uploaded" cannot be reused for an upload that already has research history (even a merely completed run) -- it is initial-creation-only now');
    assert(accountsRpcCalls.length === 1 && accountsRpcCalls[0].p_mode === 'initial_upload', 'ROUND 7 item 3: the reuse-rejection now runs INSIDE replace_ha_accounts_snapshot() (p_mode=initial_upload) -- the RPC IS called (and rejects with HA003), not skipped by a separate pre-flight check');
    assert(fakeAccounts.length === 0, 'nothing was written for the rejected reused-uploaded request');
  }

  // =========================================================================
  // Phase 2A implementation-review ROUND 6, item 3: stage="accounts_updated"
  // -- authenticated accounts-only maintenance for an upload that already
  // has research history. No signals, no research summary/results, no
  // attempt metadata; rejected while an ACTIVE research run exists;
  // permitted after completion; must preserve the existing research stage
  // and research summary rather than overwrite/reset them.
  // =========================================================================

  // 6a. accounts_updated requires an existing uploadId (cannot create).
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      stage: 'accounts_updated',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'stage="accounts_updated" with no uploadId is rejected 400 -- it is maintenance for an upload that already exists, not a way to create one');
  }

  // 6b. accounts_updated cannot carry signals.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      accounts: [{ name: 'Acme Co', signals: [trackedSignal()] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'stage="accounts_updated" carrying signals is rejected 400');
  }

  // 6c. accounts_updated cannot carry a research-result summary.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      summary: { accountCount: 1, reasonsToReachOut: 5 },
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'stage="accounts_updated" carrying a non-zero research-result summary is rejected 400');
  }

  // 6d. accounts_updated cannot carry attempt metadata.
  {
    resetAll();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      researchRunId: 'auto',
      attemptId: 'some-attempt',
      accounts: [{ name: 'Acme Co', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'stage="accounts_updated" carrying researchRunId/attemptId is rejected 400');
  }

  // 6e. accounts_updated is rejected while an ACTIVE research run exists.
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-active', lease_expires_at_ms: Date.now() + 300000 }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      accounts: [{ name: 'Edited Account Name', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 409, 'stage="accounts_updated" against an upload with a currently ACTIVE research run is rejected 409');
    assert(accountsRpcCalls.length === 1 && accountsRpcCalls[0].p_mode === 'accounts_maintenance', 'ROUND 7 item 3: the active-run check now runs INSIDE replace_ha_accounts_snapshot() (p_mode=accounts_maintenance) -- the RPC IS called (and rejects with 55P03), not skipped by a separate pre-flight check');
    assert(fakeAccounts.length === 0, 'nothing was written while a run is active');
  }

  // 6f-6h. accounts_updated after a COMPLETED run: succeeds, changes ONLY
  // the account snapshot (same account name, updated fields -- a rename
  // would now be rejected by the ROUND 7 identity lock, see tests 50-52
  // below), does not touch ha_signals, does not change the completed
  // research run, and does not replace/erase the prior research summary or
  // reset the upload to an initial/unresearched state.
  {
    resetAll();
    const priorSummary = { accountCount: 3, reasonsToReachOut: 7, highConfidenceAccounts: 2 };
    fakeUploadState = { stage: 'researched', summary: priorSummary };
    fakeSignals = [{ user_id: USER_ID, event_fingerprint: 'preexisting-fingerprint' }];
    fakeAccounts = [{ upload_id: UPLOAD_ID, account_name: 'Stable Account', industry: 'Old Industry' }];
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'completed', attempt_id: 'attempt-done', completed_at: new Date().toISOString(), lease_expires_at_ms: Date.now() - 1000, result_summary: { accountsPersisted: 3, signalsPersisted: 1 } }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      accounts: [{ name: 'Stable Account', industry: 'New Industry', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, '6f) stage="accounts_updated" against an upload with a COMPLETED (not active) run succeeds');
    assert(accountsRpcCalls.length === 1 && accountsRpcCalls[0].p_accounts[0].account_name === 'Stable Account', '6f) the account snapshot was updated via replace_ha_accounts_snapshot');
    assert(uploadPatchCalls.length === 0, '6g) accounts_updated never issues a PATCH to ha_uploads -- it does not touch stage/summary at all, by construction');
    assert(fakeUploadState.stage === 'researched' && fakeUploadState.summary === priorSummary, '6g) the existing research stage and research summary are preserved exactly, not overwritten or reset to an initial/unresearched state');
    assert(signalsInsertCalls.length === 0 && fakeSignals.length === 1 && fakeSignals[0].event_fingerprint === 'preexisting-fingerprint', '6h) ha_signals is completely untouched by an accounts_updated save');
    assert(researchRuns[0].status === 'completed' && researchRuns[0].result_summary.accountsPersisted === 3, '6h) the completed research run row itself is unchanged');
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

  // Migration 6 correction: an EXPIRED-but-not-yet-reclaimed attempt (same
  // attempt_id still on the row, status still 'running', nobody has called
  // claim_ha_research_run() to reclaim it yet) must not be able to renew
  // itself and persist/finalize through persist_ha_research_output(). This
  // is distinct from ITEM 1 TEST 6 above, which covers an attempt_id that no
  // longer matches at all (already superseded) -- here the attempt_id still
  // matches, but the lease itself has already lapsed.
  {
    resetAll();
    researchRuns = [{
      user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto',
      status: 'running', attempt_id: 'attempt-expired-not-reclaimed',
      lease_expires_at_ms: Date.now() - 1000
    }];
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-expired-not-reclaimed',
      accounts: [{ name: 'Expired Lease Write', signals: [] }]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 409 && res.body.staleAttempt === true, 'an attempt whose lease already expired is rejected even though its attempt_id still matches the row -- it cannot renew itself through persist_ha_research_output()');
    assert(fakeAccounts.filter(a => a.upload_id === UPLOAD_ID).length === 0, 'nothing was written to accounts by the expired attempt');
    assert(researchRuns[0].status === 'running' && researchRuns[0].attempt_id === 'attempt-expired-not-reclaimed' && !researchRuns[0].completed_at, 'the row is left exactly as it was -- still running, still unreclaimed, not finalized by the expired attempt');
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

  // =========================================================================
  // Phase 2A implementation-review ROUND 7, item 4: account-identity lock.
  // accounts_updated after research history exists is metadata-only.
  // =========================================================================
  function seedResearchedUploadWithTwoAccounts(){
    fakeAccounts = [
      { upload_id: UPLOAD_ID, account_name: 'Alpha Co', industry: 'Old Industry', contact_email: 'old@example.com' },
      { upload_id: UPLOAD_ID, account_name: 'Beta Co', industry: 'Other Industry' }
    ];
    fakeSignals = [{ user_id: USER_ID, event_fingerprint: 'fp-alpha' }];
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'completed', attempt_id: 'attempt-done', completed_at: new Date().toISOString(), lease_expires_at_ms: Date.now() - 1000, result_summary: { accountsPersisted: 2 } }];
  }

  // Identity 1: a contact-field update succeeds.
  {
    resetAll();
    seedResearchedUploadWithTwoAccounts();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      accounts: [
        { name: 'Alpha Co', industry: 'Old Industry', contactEmail: 'new@example.com', signals: [] },
        { name: 'Beta Co', industry: 'Other Industry', signals: [] }
      ]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'Identity 1: a contact-email-only update (same account_name set) succeeds');
    assert(fakeAccounts.find(a => a.account_name === 'Alpha Co').contact_email === 'new@example.com', 'Identity 1: the contact email was actually updated');
  }

  // Identity 2: an industry update succeeds.
  {
    resetAll();
    seedResearchedUploadWithTwoAccounts();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      accounts: [
        { name: 'Alpha Co', industry: 'Brand New Industry', signals: [] },
        { name: 'Beta Co', industry: 'Other Industry', signals: [] }
      ]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'Identity 2: an industry-only update (same account_name set) succeeds');
    assert(fakeAccounts.find(a => a.account_name === 'Alpha Co').industry === 'Brand New Industry', 'Identity 2: the industry was actually updated');
  }

  // Identity 3: a rename is rejected.
  {
    resetAll();
    seedResearchedUploadWithTwoAccounts();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      accounts: [
        { name: 'Alpha Co Renamed', industry: 'Old Industry', signals: [] },
        { name: 'Beta Co', industry: 'Other Industry', signals: [] }
      ]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'Identity 3: renaming an account (Alpha Co -> Alpha Co Renamed) is rejected 400 (HA004)');
    assert(fakeAccounts.some(a => a.account_name === 'Alpha Co') && !fakeAccounts.some(a => a.account_name === 'Alpha Co Renamed'), 'Identity 3: nothing was written -- the original account name is untouched');
  }

  // Identity 4: an addition is rejected.
  {
    resetAll();
    seedResearchedUploadWithTwoAccounts();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      accounts: [
        { name: 'Alpha Co', industry: 'Old Industry', signals: [] },
        { name: 'Beta Co', industry: 'Other Industry', signals: [] },
        { name: 'Gamma Co', industry: 'New', signals: [] }
      ]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'Identity 4: adding a new account (Gamma Co) is rejected 400 (HA004)');
    assert(!fakeAccounts.some(a => a.account_name === 'Gamma Co'), 'Identity 4: the addition was not written');
  }

  // Identity 5: a removal is rejected.
  {
    resetAll();
    seedResearchedUploadWithTwoAccounts();
    const req = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'accounts_updated',
      accounts: [
        { name: 'Alpha Co', industry: 'Old Industry', signals: [] }
      ]
    });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'Identity 5: removing an account (Beta Co) is rejected 400 (HA004)');
    assert(fakeAccounts.some(a => a.account_name === 'Beta Co'), 'Identity 5: Beta Co was not removed');
  }

  // Identity 6: signals remain associated with the unchanged account names
  // after all three rejected identity-changing attempts above.
  {
    resetAll();
    seedResearchedUploadWithTwoAccounts();
    await handler(fakeReq({ lead: { email: 'qa@example.com' }, uploadId: UPLOAD_ID, stage: 'accounts_updated', accounts: [{ name: 'Alpha Co Renamed', signals: [] }, { name: 'Beta Co', signals: [] }] }), fakeRes());
    await handler(fakeReq({ lead: { email: 'qa@example.com' }, uploadId: UPLOAD_ID, stage: 'accounts_updated', accounts: [{ name: 'Alpha Co', signals: [] }, { name: 'Beta Co', signals: [] }, { name: 'Gamma Co', signals: [] }] }), fakeRes());
    await handler(fakeReq({ lead: { email: 'qa@example.com' }, uploadId: UPLOAD_ID, stage: 'accounts_updated', accounts: [{ name: 'Alpha Co', signals: [] }] }), fakeRes());
    assert(fakeSignals.some(s => s.event_fingerprint === 'fp-alpha'), 'Identity 6: the signal originally associated with Alpha Co is still present, unaffected by any of the rejected identity-changing attempts');
    assert(fakeAccounts.length === 2 && fakeAccounts.some(a => a.account_name === 'Alpha Co') && fakeAccounts.some(a => a.account_name === 'Beta Co'), 'Identity 6: the account set is exactly as it was -- Alpha Co and Beta Co, nothing added/removed/renamed');
  }

  // Note: the only way to actually change which accounts exist for an
  // already-researched upload is a genuinely new upload/version, or a
  // rerun -- both explicitly out of scope for this phase (see migration 7
  // §5, migration 4 §4). stage="uploaded" itself is rejected once history
  // exists (test 6 above), and accounts_updated is identity-locked (tests
  // Identity 3-5 above) -- there is no server-side pathway left that can
  // change the account_name set once research history exists.

  // ===========================================================================
  // Migration 9 (approved DB change): persist_ha_research_output()'s
  // ha_signals insert now upserts (ON CONFLICT DO UPDATE) instead of
  // ignoring conflicts, refreshing exactly the interpretation columns.
  // persistHaResearchOutput() above was updated to mirror this new SQL
  // behavior for these tests. Two required proofs:
  // ===========================================================================

  // REFRESH SEMANTICS TEST: an already-known event_fingerprint, re-
  // researched via a genuine manual rerun (a distinct research_run_id/
  // attempt_id, exactly like a real "Research Account" re-click), refreshes
  // the interpretation fields while leaving identity (user_id,
  // event_fingerprint) and discovery history (first_seen_at) untouched.
  //
  // event_fingerprint is computed by resolveOpportunityEvents() from
  // company/canonical-type/location/year -- NOT supplied by the caller (a
  // client-provided eventFingerprint field is ignored/recomputed) -- so
  // this test drives BOTH the original discovery and the re-research
  // through the real handler with the SAME account name and title (title
  // text doesn't affect the fingerprint, but keeping it identical makes the
  // "this is the same real-world event" framing honest) rather than
  // hand-guessing the computed fingerprint string.
  {
    resetAll();
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-original', lease_expires_at_ms: Date.now() + 300000 }];
    const originalSignal = {
      accountName: 'Dover Honda', signalType: 'Community / Sponsorship',
      signalTitle: 'Holiday Parade Sponsorship', whatChanged: 'Dover Honda is the lead Platinum Sponsor for the 2026 Dover Holiday Parade.',
      sourceUrl: 'https://example.com/dover-honda-parade', confidenceScore: 70,
      commercialPlay: null, activationIdeas: [], expansionPotential: null,
      conversationStarter: 'Anything coming up that we should be thinking about?'
    };
    const originalReq = fakeReq({
      lead: { email: 'qa@example.com' }, uploadId: UPLOAD_ID, stage: 'researched',
      researchRunId: 'auto', attemptId: 'attempt-original',
      accounts: [{ name: 'Dover Honda', signals: [originalSignal] }]
    });
    const originalRes = fakeRes();
    await handler(originalReq, originalRes);
    assert(originalRes.statusCode === 200, `sanity: the original discovery save succeeds (got status ${originalRes.statusCode}, body ${JSON.stringify(originalRes.body)})`);
    assert(originalRes.body.signalsSaved === 1, 'sanity: the original discovery reports exactly 1 genuinely new signal');
    const originalRow = fakeSignals.find(s => s.account_name === 'Dover Honda');
    assert(!!originalRow, 'sanity: the original signal row exists');
    const realFingerprint = originalRow.event_fingerprint;
    const originalFirstSeenAt = originalRow.first_seen_at;
    // Force a distinguishable original first_seen_at (the mock sets it to
    // "now" on insert) so a later "unchanged" comparison is meaningful, not
    // a same-millisecond coincidence.
    originalRow.first_seen_at = '2025-01-01T00:00:00.000Z';
    originalRow.last_seen_at = '2025-01-01T00:00:00.000Z';

    researchRuns.push({ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'manual-rerun-dover', status: 'running', attempt_id: 'attempt-refresh-current', lease_expires_at_ms: Date.now() + 300000 });
    const freshPayload = {
      commercialPlay: { concept: 'Holiday Parade Sponsorship', narrative: 'Dover Honda is the lead Platinum Sponsor for the 2026 Dover Holiday Parade.' },
      activationIdeas: ['Parade-day team kit', 'Family-focused giveaway bags'],
      expansionPotential: { narrative: 'A recurring annual sponsorship.', tags: ['recurring-program'] },
      conversationStarter: 'We had a couple ideas for the Holiday Parade, including a parade-day team kit. Would it be okay if I sent a few concepts over?'
    };
    const refreshReq = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'manual-rerun-dover',
      attemptId: 'attempt-refresh-current',
      accounts: [{
        name: 'Dover Honda',
        signals: [{
          accountName: 'Dover Honda', signalType: 'Community / Sponsorship',
          signalTitle: 'Holiday Parade Sponsorship', whatChanged: 'Dover Honda is the lead Platinum Sponsor for the 2026 Dover Holiday Parade.',
          sourceUrl: 'https://example.com/dover-honda-parade-fresh', confidenceScore: 88,
          ...freshPayload
        }]
      }]
    });
    const res = fakeRes();
    await handler(refreshReq, res);
    assert(res.statusCode === 200, `refresh semantics: the re-research save succeeds (got status ${res.statusCode}, body ${JSON.stringify(res.body)})`);
    const matching = fakeSignals.filter(s => s.user_id === USER_ID && s.event_fingerprint === realFingerprint);
    assert(matching.length === 1, `refresh semantics: exactly one canonical signal row still exists for this event_fingerprint (got ${matching.length})`);
    const row = matching[0];
    assert(row.event_fingerprint === realFingerprint, 'refresh semantics: event_fingerprint is unchanged -- canonical event identity is untouched');
    assert(row.first_seen_at === '2025-01-01T00:00:00.000Z', `refresh semantics: first_seen_at is unchanged (got "${row.first_seen_at}")`);
    assert(row.last_seen_at !== '2025-01-01T00:00:00.000Z', 'refresh semantics: last_seen_at IS refreshed to a new value');
    assert(row.payload.commercialPlay && row.payload.commercialPlay.concept === 'Holiday Parade Sponsorship', `refresh semantics: the latest interpretation (commercialPlay) is present (got ${JSON.stringify(row.payload.commercialPlay)})`);
    assert(Array.isArray(row.payload.activationIdeas) && row.payload.activationIdeas.length === 2, 'refresh semantics: the latest activationIdeas are present');
    assert(row.payload.expansionPotential && row.payload.expansionPotential.tags.includes('recurring-program'), 'refresh semantics: the latest expansionPotential is present');
    assert(/would it be okay if i sent/i.test(row.payload.conversationStarter || ''), 'refresh semantics: the latest conversationStarter (concept-led approach) is present, not the old generic discovery question');
    assert(res.body.signalsSaved === 0, 'refresh semantics: signalsSaved (genuinely-new count) is 0 -- a refresh of an already-known event must never be counted/reported as a newly discovered one (notification-idempotency contract)');
    assert(researchRuns.find(r => r.research_run_id === 'manual-rerun-dover').status === 'completed', 'sanity: the manual rerun attempt itself finalizes normally');
  }

  // STALE-ATTEMPT PROTECTION TEST (critical safeguard 2): an older/late
  // attempt result must not be able to overwrite a newer, already-accepted
  // research result now that DO UPDATE is supported. Simulates the exact
  // race: attempt A is superseded by attempt B (reclaim) for the SAME
  // research_run_id; B completes and refreshes an event's payload; A's
  // late-arriving call (its attempt_id no longer matches) must still be
  // rejected, and B's refreshed payload must be completely untouched by A's
  // rejected call. Both calls use the IDENTICAL account name/signal title
  // (only commercialPlay differs) so they resolve to the SAME real computed
  // event_fingerprint -- see the refresh-semantics test above for why a
  // hand-guessed fingerprint string cannot be used here.
  {
    resetAll();
    // State AFTER B has already reclaimed the row (A's attempt_id no longer
    // matches -- this is what claim_ha_research_run() does on reclaim).
    researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-B-fresher', lease_expires_at_ms: Date.now() + 300000 }];
    const raceSignalBase = {
      accountName: 'Race Co', signalType: 'Event', signalTitle: 'Race Co Signal',
      whatChanged: 'Race Co event.', confidenceScore: 90
    };
    const bReq = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-B-fresher',
      accounts: [{
        name: 'Race Co',
        signals: [{
          ...raceSignalBase, sourceUrl: 'https://example.com/race-fresh',
          commercialPlay: { concept: 'Fresh Play', narrative: 'A genuinely fresh, specific commercial play from attempt B.' }
        }]
      }]
    });
    const bRes = fakeRes();
    await handler(bReq, bRes);
    assert(bRes.statusCode === 200, `sanity: the current (reclaimed) attempt B succeeds (got status ${bRes.statusCode}, body ${JSON.stringify(bRes.body)})`);
    const afterB = fakeSignals.find(s => s.account_name === 'Race Co');
    assert(afterB && afterB.payload.commercialPlay.concept === 'Fresh Play', 'sanity: attempt B\'s fresh payload is persisted');
    const raceFingerprint = afterB.event_fingerprint;

    // Attempt A's late-arriving call, using its OWN now-superseded
    // attempt_id, tries to persist a DIFFERENT (stale/regressive) payload
    // for the SAME real-world event (same account, same signal shape ->
    // same computed event_fingerprint).
    const aReq = fakeReq({
      lead: { email: 'qa@example.com' },
      uploadId: UPLOAD_ID,
      stage: 'researched',
      researchRunId: 'auto',
      attemptId: 'attempt-A-stale-race',
      accounts: [{
        name: 'Race Co',
        signals: [{
          ...raceSignalBase, sourceUrl: 'https://example.com/race-stale',
          commercialPlay: { concept: 'Stale Play', narrative: 'A stale, late-arriving payload from the superseded attempt A.' }
        }]
      }]
    });
    const aRes = fakeRes();
    await handler(aReq, aRes);
    assert(aRes.statusCode === 409 && aRes.body.staleAttempt === true, `required (critical safeguard 2): attempt A's late call is rejected as a stale attempt, even though DO UPDATE now allows refreshing an existing row (got status ${aRes.statusCode}, body ${JSON.stringify(aRes.body)})`);
    const afterA = fakeSignals.find(s => s.event_fingerprint === raceFingerprint);
    assert(afterA.payload.commercialPlay.concept === 'Fresh Play', `required (critical safeguard 2): the rejected stale attempt A did NOT overwrite attempt B's fresher payload -- it is still "Fresh Play" (got "${afterA.payload.commercialPlay.concept}")`);
    assert(researchRuns.find(r => r.research_run_id === 'auto').attempt_id === 'attempt-B-fresher', 'required (critical safeguard 2): the run row still reflects attempt B as current -- the stale call did not touch it');
  }

  global.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
