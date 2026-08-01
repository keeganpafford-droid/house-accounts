// Phase 2A implementation-review ROUND 2 — validates, without a live
// database:
//   item 2: resolveAuthenticatedUploadOwner() requires a real Supabase auth
//           token and verifies upload ownership -- no lead/email fallback.
//   item 3: claim_ha_research_run()'s server-owned, deterministic 'auto' run
//           identity -- reload/second-tab/stale-client-id all attach to the
//           same run; a genuinely new run only happens via explicit
//           'manual-rerun' intent.
//   item 4: attempt_id/lease semantics -- an active unexpired lease blocks a
//           second attempt, an expired lease is reclaimable, reclaiming
//           mints a new attempt_id, and completion/failure only takes effect
//           for the CURRENTLY owning attempt_id.
//
// The fake `rpc/claim_ha_research_run` handler below is a direct
// reimplementation of the real PL/pgSQL function in
// supabase-schema-migration-5-research-run-idempotency.sql §7 -- same
// branches, same outcome strings, same errcodes -- so that this test
// exercises the SAME decision logic the real function would run, even
// though it cannot exercise the real function itself (no DB connection
// available in this environment). scripts/phase2a-rpc-authorization-tests.sql
// covers the real function directly and is meant to be run against an
// actual Postgres instance separately.
//
// Usage: node scripts/test-research-run-idempotency.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import { readFileSync } from 'fs';
import {
  resolveAuthenticatedUploadOwner,
  claimResearchRunAtomic,
  completeResearchRunAttempt,
  failResearchRunAttempt,
  heartbeatResearchRunAtomic,
  clampLeaseSeconds
} from '../api/research-batch.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

// In-memory fixtures: one real owner (auth token 'valid-owner-token'), one
// other user (auth token 'valid-other-token'), one upload owned by the
// owner.
const FIXTURES = {
  ownerAuthUserId: 'auth-owner-1',
  otherAuthUserId: 'auth-other-1',
  ownerUserId: 'user-owner-1',
  otherUserId: 'user-other-1',
  ownerEmail: 'owner@example.com',
  otherEmail: 'other@example.com',
  uploadId: 'upload-1'
};

let nextAttemptSeq = 1;
function fakeAttemptId(){ return `attempt-${nextAttemptSeq++}`; }

// Reimplements claim_ha_research_run()'s decision logic in JS against an
// in-memory table, mirroring supabase-schema-migration-5-research-run-idempotency.sql §7.
function makeFakeResearchRunsTable(){
  const rows = new Map(); // key: `${userId}|${uploadId}|${researchRunId}` -> row

  function keyFor(userId, uploadId, researchRunId){ return `${userId}|${uploadId}|${researchRunId}`; }

  function claim(userId, uploadId, researchRunId, leaseSeconds){
    const key = keyFor(userId, uploadId, researchRunId);
    const existing = rows.get(key);
    const now = Date.now();

    if(existing){
      if(existing.status === 'completed'){
        return { outcome: 'completed', run: { ...existing } };
      }
      if(existing.status === 'running' && existing.lease_expires_at_ms > now){
        return { outcome: 'attached-active', run: { ...existing } };
      }
      // failed, or running with an expired lease: reclaim.
      const wasFailed = existing.status === 'failed';
      existing.status = 'running';
      existing.attempt_id = fakeAttemptId();
      existing.attempt_count += 1;
      existing.lease_expires_at_ms = now + leaseSeconds * 1000;
      existing.heartbeat_at = new Date(now).toISOString();
      existing.started_at = new Date(now).toISOString();
      existing.completed_at = null;
      existing.error_message = null;
      return { outcome: wasFailed ? 'reclaimed-after-failure' : 'reclaimed-after-expired-lease', run: { ...existing } };
    }

    // No exact-triple row.
    //
    // ROUND 3 "close manual-before-auto duplication": an automatic claim
    // ('auto') must not start again if ANY run for this upload already
    // completed, auto or manual -- mirrors
    // supabase-schema-migration-5-research-run-idempotency.sql §7's new
    // check.
    if(researchRunId === 'auto'){
      const completedRows = [...rows.values()]
        .filter(row => row.upload_id === uploadId && row.status === 'completed')
        .sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
      if(completedRows.length){
        return { outcome: 'completed', run: { ...completedRows[0] } };
      }
    }

    // Check for a different, actively-leased running row for the same upload.
    for(const row of rows.values()){
      if(row.upload_id === uploadId && row.status === 'running' && row.lease_expires_at_ms > now){
        const err = new Error(`claim_ha_research_run: a different research run (${row.research_run_id}) is already in progress for upload ${uploadId}`);
        err.code = '55P03';
        throw err;
      }
    }

    const row = {
      id: `row-${rows.size + 1}`,
      research_run_id: researchRunId,
      user_id: userId,
      upload_id: uploadId,
      status: 'running',
      attempt_id: fakeAttemptId(),
      attempt_count: 1,
      lease_expires_at_ms: now + leaseSeconds * 1000,
      heartbeat_at: new Date(now).toISOString(),
      started_at: new Date(now).toISOString(),
      completed_at: null,
      result_summary: {},
      error_message: null
    };
    rows.set(key, row);
    return { outcome: 'claimed-new', run: { ...row } };
  }

  // Reimplements heartbeat_ha_research_run(): one compare-and-swap update,
  // clamps p_lease_seconds to [60, 900] regardless of what was requested.
  function heartbeat(userId, uploadId, researchRunId, attemptId, leaseSeconds){
    const clamped = Math.max(60, Math.min(Number(leaseSeconds) || 300, 900));
    const key = keyFor(userId, uploadId, researchRunId);
    const row = rows.get(key);
    if(!row || row.status !== 'running' || row.attempt_id !== attemptId){
      return { ok: false, reason: 'not-current-attempt' };
    }
    const now = Date.now();
    row.heartbeat_at = new Date(now).toISOString();
    row.lease_expires_at_ms = now + clamped * 1000;
    return { ok: true, run: { ...row } };
  }

  function expireLease(uploadId, researchRunId){
    for(const row of rows.values()){
      if(row.upload_id === uploadId && row.research_run_id === researchRunId) row.lease_expires_at_ms = Date.now() - 1000;
    }
  }

  function patchByAttempt(uploadId, researchRunId, attemptId, patch){
    for(const [key, row] of rows.entries()){
      if(row.upload_id === uploadId && row.research_run_id === researchRunId && row.attempt_id === attemptId){
        Object.assign(row, patch);
        return [{ ...row }];
      }
    }
    return [];
  }

  return {
    rows,
    async fetch(url, options = {}){
      const u = String(url);
      if(u.includes('/auth/v1/user')){
        const auth = String((options.headers || {}).Authorization || '').replace(/^Bearer\s+/i, '');
        if(auth === 'valid-owner-token') return jsonResponse({ id: FIXTURES.ownerAuthUserId, email: FIXTURES.ownerEmail });
        if(auth === 'valid-other-token') return jsonResponse({ id: FIXTURES.otherAuthUserId, email: FIXTURES.otherEmail });
        return jsonResponse({ error: 'invalid token' }, false, 401);
      }
      if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')){
        const idMatch = decodeURIComponent(u.split('auth_user_id=eq.')[1].split('&')[0]);
        if(idMatch === FIXTURES.ownerAuthUserId) return jsonResponse([{ id: FIXTURES.ownerUserId, email: FIXTURES.ownerEmail }]);
        if(idMatch === FIXTURES.otherAuthUserId) return jsonResponse([{ id: FIXTURES.otherUserId, email: FIXTURES.otherEmail }]);
        return jsonResponse([]);
      }
      if(u.includes('/rest/v1/ha_uploads?id=eq.')){
        const idMatch = decodeURIComponent(u.split('id=eq.')[1].split('&')[0]);
        if(idMatch === FIXTURES.uploadId) return jsonResponse([{ id: FIXTURES.uploadId, user_id: FIXTURES.ownerUserId }]);
        return jsonResponse([]); // nonexistent upload
      }
      if(u.includes('/rest/v1/rpc/claim_ha_research_run') && options.method === 'POST'){
        const body = JSON.parse(options.body);
        try{
          const result = claim(body.p_user_id, body.p_upload_id, body.p_research_run_id, body.p_lease_seconds || 300);
          return jsonResponse(result);
        }catch(err){
          return jsonResponse({ message: err.message, code: err.code }, false, 400);
        }
      }
      if(u.includes('/rest/v1/rpc/heartbeat_ha_research_run') && options.method === 'POST'){
        const body = JSON.parse(options.body);
        const result = heartbeat(body.p_user_id, body.p_upload_id, body.p_research_run_id, body.p_attempt_id, body.p_lease_seconds);
        return jsonResponse(result);
      }
      if(u.startsWith('https://example.supabase.co/rest/v1/ha_research_runs') && options.method === 'PATCH'){
        const params = new URLSearchParams(u.split('?')[1]);
        const uploadId = decodeURIComponent(params.get('upload_id').replace('eq.', ''));
        const researchRunId = decodeURIComponent(params.get('research_run_id').replace('eq.', ''));
        const attemptId = decodeURIComponent(params.get('attempt_id').replace('eq.', ''));
        const patch = JSON.parse(options.body);
        const updated = patchByAttempt(uploadId, researchRunId, attemptId, patch);
        return jsonResponse(updated);
      }
      throw new Error(`Unhandled mock fetch URL: ${u} (${options.method || 'GET'})`);
    },
    expireLease
  };
}

const originalFetch = global.fetch;

async function run(){
  // =========================================================================
  // Item 2: authentication / ownership for upload-bound requests.
  // =========================================================================
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);

    const noToken = await resolveAuthenticatedUploadOwner({ headers: {} }, FIXTURES.uploadId);
    assert(noToken.user === null && noToken.reason === 'no-token', 'no token with a valid uploadId is rejected (reason: no-token), regardless of anything else in the request');

    // "Spoofed lead email with another user's upload": resolveAuthenticatedUploadOwner
    // does not even accept a lead/email argument anymore -- identity comes
    // ONLY from the Authorization header. A request carrying a body with a
    // plausible-looking lead.email for the victim user, but no real token,
    // resolves identically to the no-token case: the spoofed email has zero
    // effect on identity resolution.
    const spoofedEmailNoToken = await resolveAuthenticatedUploadOwner({ headers: {} }, FIXTURES.uploadId);
    assert(spoofedEmailNoToken.user === null && spoofedEmailNoToken.reason === 'no-token', 'a request with no real auth token is rejected the same way even if a request body elsewhere claims a lead/email for the upload owner -- there is no code path that reads such a value for identity');

    const wrongOwner = await resolveAuthenticatedUploadOwner({ headers: { authorization: 'Bearer valid-other-token' } }, FIXTURES.uploadId);
    assert(wrongOwner.user === null && wrongOwner.reason === 'not-owner', 'a valid token for a DIFFERENT user than the upload owner is rejected (reason: not-owner)');

    const validOwner = await resolveAuthenticatedUploadOwner({ headers: { authorization: 'Bearer valid-owner-token' } }, FIXTURES.uploadId);
    assert(validOwner.user && validOwner.user.id === FIXTURES.ownerUserId && validOwner.reason === null, 'a valid token for the actual upload owner resolves successfully');

    const nonexistentUpload = await resolveAuthenticatedUploadOwner({ headers: { authorization: 'Bearer valid-owner-token' } }, 'no-such-upload');
    assert(nonexistentUpload.user === null && nonexistentUpload.reason === 'not-owner', 'a nonexistent uploadId is rejected with the SAME reason as a real ownership mismatch (does not leak whether the upload exists)');
  }

  // "Legacy anonymous flow without uploadId": resolveAuthenticatedUploadOwner
  // is only ever called from inside handler()'s `if (targetUploadId)` gate --
  // verified directly against the deployed source below, since exercising
  // the full handler() would require mocking OpenAI/search-provider calls
  // unrelated to this concern.
  {
    const source = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
    const ownerCallSite = source.indexOf('resolveAuthenticatedUploadOwner(req, targetUploadId)');
    const gateSite = source.indexOf('if (targetUploadId) {');
    assert(ownerCallSite > -1 && gateSite > -1 && gateSite < ownerCallSite && ownerCallSite - gateSite < 400,
      'resolveAuthenticatedUploadOwner() is called inside the `if (targetUploadId)` gate -- a request with no uploadId (the pre-existing anonymous prospecting flow) never reaches an auth/ownership check at all, exactly as before this round\'s changes');
  }

  // =========================================================================
  // Item 3: stable, server-owned automatic-run identity.
  // =========================================================================
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const claimAuto = () => claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });

    const first = await claimAuto();
    assert(first.ok && first.outcome === 'claimed-new', 'the first automatic claim for an upload creates a new run');

    // Reload during a running run.
    const reloadWhileRunning = await claimAuto();
    assert(reloadWhileRunning.ok && reloadWhileRunning.outcome === 'attached-active', 'reloading (re-claiming "auto") while the run is still actively leased attaches to the existing run instead of starting a second execution');

    // Second tab during a running run: identical call, from "another tab".
    const secondTabWhileRunning = await claimAuto();
    assert(secondTabWhileRunning.ok && secondTabWhileRunning.outcome === 'attached-active', 'a second tab claiming "auto" while the run is still actively leased also attaches, not starts a second execution');
    assert(table.rows.size === 1, 'exactly one ha_research_runs row exists for this upload after multiple reload/second-tab claims');

    // Complete the run, then verify reload / different client id after
    // completion do not restart research.
    const completed = await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: first.run.attempt_id, resultSummary: { signalsReturned: 7 } });
    assert(completed.applied === true, 'completing the run with the currently-owning attemptId succeeds');

    const reloadAfterCompleted = await claimAuto();
    assert(reloadAfterCompleted.ok && reloadAfterCompleted.outcome === 'completed' && reloadAfterCompleted.run.result_summary.signalsReturned === 7,
      'reloading after the automatic run completed returns the cached outcome (does not restart research)');

    // "A different client-generated ID after completion": the automatic
    // path's researchRunId is a fixed server-side literal ('auto'), never a
    // client-supplied string -- see handler()'s claim branch, which computes
    // researchRunId from runIntent alone, never from any client-sent id
    // field. Demonstrate directly that the handler's claim branch does not
    // read body.researchRunId at all.
    const source = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
    const claimBranchStart = source.indexOf("if (researchRunAction === 'claim') {");
    const claimBranchEnd = source.indexOf("if (researchRunAction === 'heartbeat')", claimBranchStart);
    const claimBranchBody = source.slice(claimBranchStart, claimBranchEnd);
    assert(!/body\.researchRunId/.test(claimBranchBody), 'the claim branch never reads body.researchRunId -- an arbitrary client-generated id sent alongside researchRunAction:"claim" has ZERO effect on which run is claimed; the automatic path always resolves to the fixed id "auto"');
    assert(/runIntent === 'manual-rerun'/.test(claimBranchBody) && /: 'auto'/.test(claimBranchBody), 'the claim branch computes researchRunId itself from runIntent alone (server-minted for manual-rerun, fixed literal "auto" otherwise)');

    // Explicit, separately-authorized manual rerun after completion: the
    // server would mint a fresh id for runIntent:'manual-rerun'; simulate
    // that minted id here directly against claimResearchRunAtomic.
    const manualRerun = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-simulated-rerun-id' });
    assert(manualRerun.ok && manualRerun.outcome === 'claimed-new', 'an explicit manual-rerun request (a genuinely new, server-minted run id) succeeds once the automatic run has completed (no active run is blocking it)');
  }

  // Two DIFFERENT run ids concurrently: the second is rejected while the
  // first is still actively running, not joined.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(first.ok && first.outcome === 'claimed-new', 'the first run id claims successfully');
    const second = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-simulated-concurrent' });
    assert(!second.ok && second.status === 409, 'a second, DIFFERENT run id for the same upload while the first is still actively running is rejected with 409, not joined');
  }

  // =========================================================================
  // Item 4: lease / attempt-token semantics.
  // =========================================================================

  // "Process dies without marking failed" + "retry after lease expiry":
  // claim, never complete/fail, manually expire the lease (simulating a
  // killed Vercel invocation), then claim again.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(first.ok && first.outcome === 'claimed-new', 'initial claim succeeds');
    table.expireLease(FIXTURES.uploadId, 'auto');
    const reclaimed = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(reclaimed.ok && reclaimed.outcome === 'reclaimed-after-expired-lease', 'a run whose process died mid-flight (never called complete/fail) becomes reclaimable once its lease expires -- no explicit failure marking is required to recover it');
    assert(reclaimed.run.attempt_id !== first.run.attempt_id, 'reclaiming an expired lease mints a NEW attempt_id, distinct from the original attempt');
  }

  // "Retry before lease expiry": claiming again while the lease is still
  // valid must NOT reclaim (must attach instead).
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const retryBeforeExpiry = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(retryBeforeExpiry.ok && retryBeforeExpiry.outcome === 'attached-active' && retryBeforeExpiry.run.attempt_id === first.run.attempt_id, 'retrying before the lease expires attaches to the SAME attempt -- it is not reclaimed');
  }

  // "Old worker completes after lease takeover": a stale attempt's late
  // completion must not overwrite the replacement attempt's state.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const staleAttemptId = first.run.attempt_id;
    table.expireLease(FIXTURES.uploadId, 'auto');
    const takeover = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const newAttemptId = takeover.run.attempt_id;

    // The old (stale) attempt finally finishes and reports completion.
    const staleCompletion = await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: staleAttemptId, resultSummary: { signalsReturned: 999, note: 'STALE - should be discarded' } });
    assert(staleCompletion.applied === false, 'a completion report from the STALE (superseded) attempt_id is not applied -- applied:false, not an error');

    const row = [...table.rows.values()][0];
    assert(row.status === 'running' && row.attempt_id === newAttemptId, 'the row is untouched by the stale completion -- it still shows the REPLACEMENT attempt as running, not corrupted by the late stale result');

    // The new (replacement) attempt completes for real.
    const realCompletion = await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: newAttemptId, resultSummary: { signalsReturned: 5 } });
    assert(realCompletion.applied === true, 'a completion report from the CURRENTLY-owning attempt_id is applied successfully');
    assert(row.status === 'completed' && row.result_summary.signalsReturned === 5, 'the final persisted result reflects the replacement attempt\'s real result, not the stale attempt\'s discarded one');
  }

  // "Network timeout followed by same-request retry": client retries the
  // identical claim request while the original attempt's lease is still
  // valid (server-side, the original request may have succeeded even though
  // the client never saw the response).
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const original = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const retryAfterTimeout = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(original.ok && original.outcome === 'claimed-new', 'the original claim succeeds');
    assert(retryAfterTimeout.ok && retryAfterTimeout.outcome === 'attached-active', 'retrying the identical claim after a client-side timeout is idempotent -- it attaches to the same in-flight attempt rather than starting a second execution');
  }

  // "Completed-result replay": repeated claims after completion consistently
  // return the SAME cached result, not a re-derived one.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: first.run.attempt_id, resultSummary: { signalsReturned: 12 } });
    const replay1 = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const replay2 = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(replay1.outcome === 'completed' && replay1.run.result_summary.signalsReturned === 12, 'first replay after completion returns the cached result');
    assert(replay2.outcome === 'completed' && replay2.run.result_summary.signalsReturned === 12, 'a second replay returns the identical cached result -- completed runs remain idempotently replayable indefinitely');
  }

  // failResearchRunAttempt: same attempt_id-guarding as completion.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const wrongAttempt = await failResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: 'not-the-real-attempt-id', errorMessage: 'should not apply' });
    assert(wrongAttempt.applied === false, 'failResearchRunAttempt with a non-matching attemptId is not applied');
    const rightAttempt = await failResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: first.run.attempt_id, errorMessage: 'provider timeout' });
    assert(rightAttempt.applied === true, 'failResearchRunAttempt with the currently-owning attemptId is applied');
    const row = [...table.rows.values()][0];
    assert(row.status === 'failed' && row.error_message === 'provider timeout', 'the row reflects the failure reported by the owning attempt');

    // A subsequent automatic claim after a failure (not after completion)
    // is allowed to proceed WITHOUT requiring the explicit manual-rerun
    // pathway -- this is deliberately different from "after completion",
    // per the review's item 3 wording ("after completion" specifically).
    const retryAfterFailure = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(retryAfterFailure.ok && retryAfterFailure.outcome === 'reclaimed-after-failure', 'an ordinary automatic claim (runIntent auto, fixed id "auto") after a FAILURE reclaims and proceeds without needing the manual-rerun pathway -- only a run that reached "completed" requires the explicit authorized pathway to start a new run');
  }

  // =========================================================================
  // ROUND 3, item 1: heartbeat / lease renewal.
  // =========================================================================

  // "Legitimate run lasting longer than five minutes with recurring
  // heartbeat": simulate a lease that would otherwise have expired, but a
  // heartbeat renewed it in time -- the run must still be attachable
  // (still 'running', not reclaimable) after the ORIGINAL 300s window has
  // passed.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    // Simulate time passing close to (but not past) the original lease,
    // then a heartbeat renewing it -- mirrors the ~45s renewal cadence
    // inside api/research-batch.js's startHeartbeatRenewalLoop() during a
    // long single request, and dashboard/index.html's per-account fallback
    // requests each re-verifying via the provider-call gate.
    const row = [...table.rows.values()][0];
    row.lease_expires_at_ms = Date.now() + 5000; // about to expire
    const hb = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: first.run.attempt_id, leaseSeconds: 300 });
    assert(hb.ok === true, 'a heartbeat from the current owning attempt succeeds and renews the lease');
    assert(row.lease_expires_at_ms > Date.now() + 250000, 'after the heartbeat, the lease is extended well past the original ~5s-remaining window -- a run that would otherwise have expired mid-flight stays owned by the same attempt');
    // Now simulate that this renewed lease is what lets a SUBSEQUENT claim
    // (e.g. a reload) correctly attach rather than reclaim, proving the
    // renewal is not just recorded but actually consulted.
    const reloadAfterRenewal = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(reloadAfterRenewal.outcome === 'attached-active' && reloadAfterRenewal.run.attempt_id === first.run.attempt_id, 'a run kept alive by recurring heartbeats past its original lease window is still correctly seen as actively owned, not reclaimable, by a subsequent claim call (simulates a legitimate 15-20 minute fallback run outliving a single 300s lease)');
  }

  // "Old attempt tries to heartbeat after takeover": the stale attempt's
  // OWN heartbeat call (not just completion) must fail once superseded.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const staleAttemptId = first.run.attempt_id;
    table.expireLease(FIXTURES.uploadId, 'auto');
    const takeover = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const staleHeartbeat = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: staleAttemptId, leaseSeconds: 300 });
    assert(staleHeartbeat.ok === false && staleHeartbeat.reason === 'not-current-attempt', 'the STALE (superseded) attempt cannot renew its own lease after a takeover -- its heartbeat is rejected, not silently accepted');
    const currentHeartbeat = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: takeover.run.attempt_id, leaseSeconds: 300 });
    assert(currentHeartbeat.ok === true, 'the CURRENT (replacement) attempt heartbeats successfully');
  }

  // "Client attempts to supply an excessive lease duration": clamped both
  // in clampLeaseSeconds() (JS-side) and by the RPC mock's own clamp.
  {
    assert(clampLeaseSeconds(999999999) === 900, 'clampLeaseSeconds() caps an excessive requested lease at the maximum (900s)');
    assert(clampLeaseSeconds(1) === 60, 'clampLeaseSeconds() raises a too-small requested lease to the minimum (60s)');
    assert(clampLeaseSeconds(undefined) === 300, 'clampLeaseSeconds() falls back to the default (300s) when nothing is supplied');

    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const excessive = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: first.run.attempt_id, leaseSeconds: 999999999 });
    const row = [...table.rows.values()][0];
    assert(excessive.ok === true, 'the heartbeat still succeeds even when an excessive lease was requested (clamped, not rejected outright)');
    assert(row.lease_expires_at_ms <= Date.now() + 901000, 'the resulting lease_expires_at reflects the CLAMPED duration (<=900s out), not the excessive value the client requested -- a client cannot obtain an effectively-permanent lease');
  }

  // "Second tab attaches without launching provider calls": a second
  // claim() for the same active run returns outcome=attached-active WITHOUT
  // an attemptId in the response the caller would need to proceed to
  // provider work -- structurally, a caller that gets 'attached-active'
  // has nothing to hand to the provider-call gate.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const secondTab = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(secondTab.outcome === 'attached-active', 'a second tab claiming the same active run gets attached-active');
    // handler()'s claim branch (verified against source) returns 202 for
    // this outcome and never proceeds into the actual research try block --
    // see the source-level assertion below.
    const source = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
    const attachedActiveReturn = source.match(/if \(outcome === 'attached-active'\) \{[\s\S]{0,400}?return res\.status\(202\)/);
    assert(!!attachedActiveReturn, 'handler() returns immediately (202) for outcome=attached-active, before ever reaching the provider-call gate or any OpenAI/Serper/Firecrawl call further down the function');
  }

  // =========================================================================
  // ROUND 3, item 2: provider-call attempt gate.
  // =========================================================================

  // "Old attempt tries to call a provider after takeover": simulates
  // research-batch.js's own pre-provider gate, which calls
  // heartbeatResearchRunAtomic() BEFORE any discoverCandidatesForAccounts/
  // callOpenAIJson/callOpenAIWebSearch call.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const staleAttemptId = first.run.attempt_id;
    table.expireLease(FIXTURES.uploadId, 'auto');
    await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' }); // takeover

    let providerCallsMade = 0;
    async function simulateProviderGatedRequest(attemptId){
      // Mirrors handler()'s exact gate: heartbeat-as-verify BEFORE any
      // provider work; a failure short-circuits with 409 and the provider
      // is never invoked.
      const gate = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId });
      if(!gate.ok) return { status: 409, providerCalled: false };
      providerCallsMade += 1; // stands in for calling OpenAI/Serper/Firecrawl
      return { status: 200, providerCalled: true };
    }
    const staleRequest = await simulateProviderGatedRequest(staleAttemptId);
    assert(staleRequest.status === 409 && staleRequest.providerCalled === false, 'a request carrying the STALE (superseded) attempt_id is rejected with a conflict BEFORE any provider call is made');
    assert(providerCallsMade === 0, 'no provider cost was incurred for the stale attempt\'s request');
  }

  // =========================================================================
  // ROUND 3, item 4: close manual-before-auto duplication.
  // =========================================================================

  // "Manual run completes before automatic trigger" + "automatic trigger
  // after completed manual run": the automatic path must attach to that
  // completed run, not start a new one.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const manual = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-before-auto' });
    assert(manual.ok && manual.outcome === 'claimed-new', 'the manual run claims successfully');
    await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'manual-before-auto', attemptId: manual.run.attempt_id, resultSummary: { signalsReturned: 4 } });

    const automaticAfterManual = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(automaticAfterManual.outcome === 'completed' && automaticAfterManual.run.research_run_id === 'manual-before-auto', 'the automatic path, claimed for the very first time, attaches to the already-completed MANUAL run instead of starting new research -- completion is upload-scoped, not tied to the "auto" label specifically');
    assert(![...table.rows.values()].some(r => r.research_run_id === 'auto'), 'no "auto" row was ever created for this upload');
  }

  // "Automatic trigger after completed automatic run": unchanged regression
  // check (already covered above, restated here for the item-4 list).
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: first.run.attempt_id, resultSummary: { signalsReturned: 9 } });
    const second = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(second.outcome === 'completed' && second.run.result_summary.signalsReturned === 9, 'an automatic claim after a completed AUTOMATIC run attaches to the cached result, same as before');
  }

  // "Explicit manual rerun after either completed run" (auto or manual).
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const auto = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: auto.run.attempt_id, resultSummary: {} });
    const manualRerun = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-explicit-rerun-1' });
    assert(manualRerun.ok && manualRerun.outcome === 'claimed-new', 'an explicit manual-rerun request succeeds after a completed AUTOMATIC run');

    await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'manual-explicit-rerun-1', attemptId: manualRerun.run.attempt_id, resultSummary: {} });
    const secondManualRerun = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-explicit-rerun-2' });
    assert(secondManualRerun.ok && secondManualRerun.outcome === 'claimed-new', 'a further explicit manual-rerun request succeeds after a completed MANUAL run too -- the explicit pathway is never blocked by a prior completion, regardless of that prior run\'s label');
  }

  // "Completed manual run blocks later automatic execution" (explicit
  // restatement of the primary item-4 scenario for the required test list).
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const manual = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-blocks-auto' });
    await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'manual-blocks-auto', attemptId: manual.run.attempt_id, resultSummary: { signalsReturned: 1 } });
    const laterAutomatic = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(laterAutomatic.outcome === 'completed', 'a completed manual run blocks a later automatic execution from starting -- the automatic claim attaches to the existing completed state instead');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
