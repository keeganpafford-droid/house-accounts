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
    const now = Date.now();

    // A. AUTOMATIC COMPLETION GUARD, evaluated FIRST -- before this call
    // ever looks at its own exact row. ROUND 10 fix: an automatic claim
    // ('auto') must not start again if ANY run for this upload already
    // completed, auto or manual, EVEN IF the 'auto' row itself exists and is
    // failed/expired-lease -- mirrors
    // supabase-schema-migration-5-research-run-idempotency.sql §7's
    // evaluation-order fix. Only an explicit manual-rerun request is exempt.
    if(researchRunId === 'auto'){
      const completedRows = [...rows.values()]
        .filter(row => row.upload_id === uploadId && row.status === 'completed')
        .sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
      if(completedRows.length){
        return { outcome: 'completed', run: { ...completedRows[0] } };
      }
    }

    // B. EXACT-ROW HANDLING.
    const existing = rows.get(key);
    if(existing){
      if(existing.status === 'completed'){
        return { outcome: 'completed', run: { ...existing } };
      }
      if(existing.status === 'running' && existing.lease_expires_at_ms > now){
        return { outcome: 'attached-active', run: { ...existing } };
      }
      // failed, or running with an expired lease: a RECLAIM CANDIDATE, not
      // an automatic reclaim. ROUND 10 fix: confirm no DIFFERENT
      // research_run_id is actively (non-expired) running for this same
      // upload before reclaiming -- a failed/expired exact row does not by
      // itself prove the upload's "one active run" slot is free.
      for(const row of rows.values()){
        if(row.id !== existing.id && row.upload_id === uploadId && row.status === 'running' && row.lease_expires_at_ms > now){
          const err = new Error(`claim_ha_research_run: a different research run (${row.research_run_id}) is already in progress for upload ${uploadId}`);
          err.code = '55P03';
          throw err;
        }
      }
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

    // C. NO EXACT ROW: check for a different, actively-leased running row
    // for the same upload before creating a new one.
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
  // Migration 5 correction: the row's OWN lease must still be unexpired at
  // heartbeat time -- attempt_id ownership alone is not enough. An attempt
  // whose lease already lapsed (even if nobody has reclaimed it yet) cannot
  // renew itself; only claim_ha_research_run()'s reclaim path (which mints a
  // NEW attempt_id) may resurrect it.
  function heartbeat(userId, uploadId, researchRunId, attemptId, leaseSeconds){
    const clamped = Math.max(60, Math.min(Number(leaseSeconds) || 300, 900));
    const key = keyFor(userId, uploadId, researchRunId);
    const row = rows.get(key);
    const now = Date.now();
    if(!row || row.status !== 'running' || row.attempt_id !== attemptId || row.lease_expires_at_ms <= now){
      return { ok: false, reason: 'not-current-attempt' };
    }
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

  // =========================================================================
  // Migration 5 correction: an EXPIRED lease must not be renewable by
  // heartbeat, even when the caller's attempt_id STILL matches -- i.e.
  // BEFORE any reclaim has happened, not just after a takeover (the prior
  // test above). Only claim_ha_research_run()'s reclaim path may resurrect
  // an abandoned run, and reclaiming always mints a NEW attempt_id.
  // =========================================================================
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const originalAttemptId = first.run.attempt_id;

    // 1. Expire the lease manually while retaining the same attempt_id (no
    // reclaim has happened yet -- the row still shows the original attempt).
    table.expireLease(FIXTURES.uploadId, 'auto');
    const rowBeforeHeartbeat = [...table.rows.values()][0];
    const leaseBefore = rowBeforeHeartbeat.lease_expires_at_ms;
    const heartbeatAtBefore = rowBeforeHeartbeat.heartbeat_at;
    assert(rowBeforeHeartbeat.attempt_id === originalAttemptId, 'the row still shows the original attempt_id immediately after the lease expires (nothing has reclaimed it yet)');

    // 2. Heartbeat with that (still-current, but lease-expired) attempt_id fails.
    const expiredHeartbeat = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: originalAttemptId, leaseSeconds: 300 });
    assert(expiredHeartbeat.ok === false && expiredHeartbeat.reason === 'not-current-attempt', 'a heartbeat from the CURRENT attempt_id is still rejected once its own lease has already expired -- lease liveness is required, not just attempt_id ownership');

    // 3. lease_expires_at and heartbeat_at remain unchanged -- the rejected
    // heartbeat must have no side effects on the row.
    const rowAfterHeartbeat = [...table.rows.values()][0];
    assert(rowAfterHeartbeat.lease_expires_at_ms === leaseBefore, 'lease_expires_at is untouched by the rejected heartbeat');
    assert(rowAfterHeartbeat.heartbeat_at === heartbeatAtBefore, 'heartbeat_at is untouched by the rejected heartbeat');

    // 4. A subsequent claim returns reclaimed-after-expired-lease.
    const reclaimed = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(reclaimed.ok && reclaimed.outcome === 'reclaimed-after-expired-lease', 'a subsequent claim correctly reclaims the abandoned run via the expired-lease path');

    // 5. The reclaimed run has a new attempt_id.
    assert(reclaimed.run.attempt_id !== originalAttemptId, 'reclaiming mints a NEW attempt_id, distinct from the original (now-expired) attempt');

    // 6. The old attempt still cannot heartbeat afterward.
    const staleAfterReclaim = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: originalAttemptId, leaseSeconds: 300 });
    assert(staleAfterReclaim.ok === false && staleAfterReclaim.reason === 'not-current-attempt', 'the original attempt still cannot heartbeat after the reclaim -- rejected both by attempt_id mismatch and by never having held a valid lease at heartbeat time');
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

  // =========================================================================
  // ROUND 10: claim-ordering fix. The automatic-completion guard and the
  // "is a DIFFERENT run active" check must run in the correct order relative
  // to the exact-row lookup, or a failed/expired exact row can be reclaimed
  // straight past a different run that is either actively leased or already
  // completed -- producing two simultaneously active runs for one upload, or
  // restarting research a manual rerun had already finished.
  // =========================================================================

  // Test 1: expired auto row + an actively-leased MANUAL run for the same
  // upload -- the automatic claim must be REJECTED (55P03), not reclaim its
  // own expired 'auto' row into a second simultaneously-active execution.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const auto = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(auto.ok && auto.outcome === 'claimed-new', 'the initial automatic claim succeeds');
    table.expireLease(FIXTURES.uploadId, 'auto');
    const manual = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-active' });
    assert(manual.ok && manual.outcome === 'claimed-new', 'a manual run claims successfully once the auto row\'s lease has expired (it is no longer blocking)');

    const autoRowBefore = [...table.rows.values()].find(r => r.research_run_id === 'auto');
    const autoAttemptIdBefore = autoRowBefore.attempt_id;
    const autoAttemptCountBefore = autoRowBefore.attempt_count;

    const secondAuto = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(!secondAuto.ok && secondAuto.status === 409, 'TEST 1: an automatic claim with an expired own row, while a DIFFERENT run (manual-active) is actively leased, is rejected -- not reclaimed into a second simultaneously-active run');

    const autoRowAfter = [...table.rows.values()].find(r => r.research_run_id === 'auto');
    assert(autoRowAfter.status === 'running' && autoRowAfter.lease_expires_at_ms <= Date.now(), 'TEST 1: the expired auto row is NOT reclaimed -- it still shows its expired state');
    assert(autoRowAfter.attempt_id === autoAttemptIdBefore, 'TEST 1: attempt_id is unchanged');
    assert(autoRowAfter.attempt_count === autoAttemptCountBefore, 'TEST 1: attempt_count is unchanged');
  }

  // Test 2: a FAILED (not expired-lease) manual row, with a DIFFERENT run
  // actively leased for the same upload -- reclaiming the failed row must
  // also be rejected (55P03), not just the expired-lease case above.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const manual1 = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-1' });
    assert(manual1.ok && manual1.outcome === 'claimed-new', 'manual-1 claims successfully');
    await failResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'manual-1', attemptId: manual1.run.attempt_id, errorMessage: 'provider timeout' });
    const manual2 = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-2' });
    assert(manual2.ok && manual2.outcome === 'claimed-new', 'manual-2 claims successfully once manual-1 is failed (no longer blocking)');

    const manual1AttemptIdBefore = [...table.rows.values()].find(r => r.research_run_id === 'manual-1').attempt_id;

    const reclaimAttempt = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-1' });
    assert(!reclaimAttempt.ok && reclaimAttempt.status === 409, 'TEST 2: reclaiming a FAILED exact row is rejected (55P03) while a DIFFERENT run (manual-2) is actively leased');

    const manual1RowAfter = [...table.rows.values()].find(r => r.research_run_id === 'manual-1');
    assert(manual1RowAfter.status === 'failed' && manual1RowAfter.attempt_id === manual1AttemptIdBefore, 'TEST 2: the failed manual-1 row is NOT reclaimed');
  }

  // Test 3: expired auto row + a DIFFERENT run that has already COMPLETED --
  // the automatic claim must attach to the completed result (not reclaim its
  // own expired row into a new execution).
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const auto = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    table.expireLease(FIXTURES.uploadId, 'auto');
    const manual = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-done' });
    assert(manual.ok && manual.outcome === 'claimed-new', 'manual-done claims successfully once auto has expired');
    await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'manual-done', attemptId: manual.run.attempt_id, resultSummary: { signalsReturned: 6 } });

    const autoAttemptIdBefore = [...table.rows.values()].find(r => r.research_run_id === 'auto').attempt_id;

    const secondAuto = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(secondAuto.ok && secondAuto.outcome === 'completed' && secondAuto.run.research_run_id === 'manual-done' && secondAuto.run.result_summary.signalsReturned === 6, 'TEST 3: the automatic claim attaches to the completed MANUAL run\'s result, not its own expired row');

    const autoRowAfter = [...table.rows.values()].find(r => r.research_run_id === 'auto');
    assert(autoRowAfter.attempt_id === autoAttemptIdBefore, 'TEST 3: the expired auto row is NOT reclaimed');
  }

  // Test 4: FAILED auto row + a DIFFERENT run that has already COMPLETED --
  // same completed-attach behavior as Test 3, for the failed (not just
  // expired-lease) case, with no new attempt minted for the failed row.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const auto = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    await failResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'auto', attemptId: auto.run.attempt_id, errorMessage: 'provider error' });
    const manual = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-done-2' });
    await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'manual-done-2', attemptId: manual.run.attempt_id, resultSummary: { signalsReturned: 3 } });

    const autoAttemptCountBefore = [...table.rows.values()].find(r => r.research_run_id === 'auto').attempt_count;

    const secondAuto = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(secondAuto.ok && secondAuto.outcome === 'completed' && secondAuto.run.research_run_id === 'manual-done-2', 'TEST 4: the automatic claim attaches to the completed manual run even though its OWN auto row is failed (not just expired-lease)');

    const autoRowAfter = [...table.rows.values()].find(r => r.research_run_id === 'auto');
    assert(autoRowAfter.attempt_count === autoAttemptCountBefore, 'TEST 4: no new attempt was minted for the failed auto row');
  }

  // Test 5: expired exact row with NO other active or completed blocker --
  // reclaim must still succeed normally (the round-10 fix must not
  // over-block the ordinary, unblocked reclaim path).
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    const originalAttemptId = first.run.attempt_id;
    table.expireLease(FIXTURES.uploadId, 'auto');
    const reclaimed = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(reclaimed.ok && reclaimed.outcome === 'reclaimed-after-expired-lease', 'TEST 5: an expired exact row with no other active/completed blocker still reclaims normally');
    assert(reclaimed.run.attempt_id !== originalAttemptId, 'TEST 5: reclaiming mints a new attempt_id');
  }

  // Test 6: FAILED exact manual row with no other active blocker --
  // reclaim-after-failure must still succeed normally.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const manual = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-solo' });
    await failResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'manual-solo', attemptId: manual.run.attempt_id, errorMessage: 'network error' });
    const retry = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-solo' });
    assert(retry.ok && retry.outcome === 'reclaimed-after-failure', 'TEST 6: a failed exact manual row with no other active blocker still reclaims normally (reclaimed-after-failure)');
  }

  // =========================================================================
  // ROUND 4, item 2: remove upload-bound untracked research paths.
  // =========================================================================

  // "Standalone button against an upload without attempt ID": the actual
  // HTTP contract change is that any uploadId-bound research request now
  // REQUIRES researchRunId+attemptId (400 otherwise) -- verified directly
  // against source, since exercising the full handler() would require
  // mocking OpenAI/search-provider calls unrelated to this concern (the
  // same precedent used for the round-2 "legacy anonymous flow" check
  // above).
  {
    const source = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
    const tryBlockStart = source.indexOf("const { accounts = [], mode = 'ranked', researchRunId = '' } = body;");
    const mandatoryCheck = source.indexOf('researchRunId and attemptId are required for any research request bound to an existing upload', tryBlockStart);
    assert(tryBlockStart > -1 && mandatoryCheck > -1 && mandatoryCheck - tryBlockStart < 1500,
      'the actual research handler rejects (400) any uploadId-bound request missing researchRunId/attemptId -- there is no longer an untracked-but-uploadId-bound path for ANY caller, including a standalone single-account request');
    // The gate must be unconditional on targetUploadId alone -- not
    // additionally gated on attemptId already being present (which would
    // silently re-allow the old opt-out).
    const gateSite = source.indexOf('if (targetUploadId) {', mandatoryCheck - 400);
    assert(gateSite > -1 && gateSite < mandatoryCheck, 'the mandatory researchRunId/attemptId check is unconditional on targetUploadId alone, not on attemptId already being present');
  }

  // dashboard/index.html: the standalone button must claim its own run
  // rather than proceeding untracked -- verified against source (a browser
  // DOM/fetch environment is not available in this Node test script).
  {
    const dashSource = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
    const fnStart = dashSource.indexOf('async function researchAccountByName(accountName, options = {}){');
    const fnEnd = dashSource.indexOf('\nasync function researchAccountsBatch', fnStart);
    const fnBody = dashSource.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 4000);
    assert(fnStart > -1, 'researchAccountByName() is present in dashboard/index.html');
    assert(/claimAutomaticResearchRun\('manual-rerun', undefined, \[account\.name\]\)/.test(fnBody), 'researchAccountByName() claims its own manual-rerun run when called standalone against an existing upload -- it no longer sends uploadId without a real attemptId, and now also passes its own single target company name for the target-granularity duplicate check');
    assert(/if\(currentUploadId && !attemptId\)/.test(fnBody), 'the self-claim only activates when currentUploadId is set and no attemptId was already supplied by the caller (i.e. NOT when called from researchTopAccounts()\'s fallback loop, which already has one)');
  }

  // "Standalone button with stale attempt ID": functionally, this reduces
  // to the SAME gate research-batch.js's actual research handler runs
  // (heartbeatResearchRunAtomic as a verify-before-provider-work gate) --
  // already proven generically in the "old attempt tries to call a
  // provider after takeover" test above. Restated explicitly here for the
  // standalone-button scenario specifically.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const claimed = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-standalone-1' });
    assert(claimed.ok && claimed.outcome === 'claimed-new', 'the standalone button\'s own manual-rerun claim succeeds when nothing else is active');
    table.expireLease(FIXTURES.uploadId, 'manual-standalone-1');
    await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-standalone-1' }); // simulates a takeover
    const staleGate = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-standalone-1', attemptId: claimed.run.attempt_id });
    assert(staleGate.ok === false, 'a standalone-button request carrying a stale (superseded) attemptId fails the provider-call gate, exactly like the top-accounts flow');
  }

  // "Standalone button with valid manual-run attempt": succeeds end to end
  // at the claim/gate/complete level.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const claimed = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-standalone-2' });
    assert(claimed.ok && claimed.outcome === 'claimed-new', 'the standalone button claims a fresh manual run');
    const gate = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'manual-standalone-2', attemptId: claimed.run.attempt_id });
    assert(gate.ok === true, 'the provider-call gate passes for the valid, currently-owning manual attempt');
    const completion = await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: 'manual-standalone-2', attemptId: claimed.run.attempt_id, resultSummary: { signalsReturned: 2, accountsResearched: 1 } });
    assert(completion.applied === true, 'the standalone run reports completion successfully, using its own independently-claimed attempt_id');
  }

  // "Anonymous prospecting without uploadId": already covered by the
  // round-2 "legacy anonymous flow" test above (resolveAuthenticatedUploadOwner
  // is never reached at all without uploadId) -- restated here for the
  // round-4 required test list, plus an explicit confirmation that
  // prospect_script.js's actual fetch call still sends no uploadId.
  {
    const prospectSource = readFileSync(new URL('../prospect_script.js', import.meta.url), 'utf8');
    assert(/fetch\('\/api\/research-batch'/.test(prospectSource) && !/uploadId/.test(prospectSource.match(/fetch\('\/api\/research-batch'[\s\S]{0,400}?\}\)\}/)?.[0] || ''),
      'prospect_script.js\'s research-batch call still sends no uploadId at all -- it remains outside every uploadId-bound check added across all four rounds');
  }

  // "Anonymous request spoofing uploadId": a request that supplies uploadId
  // without a valid Bearer token is rejected before anything else --
  // already proven by the "no token with a valid uploadId" test at the top
  // of this file; restated explicitly for the round-4 required test list,
  // including the case where the spoofed uploadId belongs to a real upload.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const spoofedNoToken = await resolveAuthenticatedUploadOwner({ headers: {} }, FIXTURES.uploadId);
    assert(spoofedNoToken.user === null && spoofedNoToken.reason === 'no-token', 'a request spoofing a real uploadId with no Bearer token is rejected -- ownership can only ever be established via a verified auth token, never by merely naming an upload id');
    const spoofedWrongToken = await resolveAuthenticatedUploadOwner({ headers: { authorization: 'Bearer valid-other-token' } }, FIXTURES.uploadId);
    assert(spoofedWrongToken.user === null && spoofedWrongToken.reason === 'not-owner', 'a request spoofing a real uploadId with a DIFFERENT user\'s valid token is rejected -- authentication alone is not enough, ownership of that specific upload is independently verified');
  }

  // =========================================================================
  // ROUND 4, item 3: the invariant, stated and checked structurally.
  // "For any persisted customer upload, every provider call and every
  // research-derived database write is attributable to exactly one current
  // research run and attempt."
  // =========================================================================
  {
    const rbSource = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
    const suSource = readFileSync(new URL('../api/save-upload.js', import.meta.url), 'utf8');
    // Provider calls: gated by heartbeatResearchRunAtomic() before any of
    // discoverCandidatesForAccounts/callOpenAIJson/callOpenAIWebSearch, and
    // that gate is unconditional whenever targetUploadId is present (proven
    // above). Persistence: persist_ha_research_output() is the ONLY write
    // path for research-output-stage saves (proven in
    // scripts/test-save-upload-persistence.js), and it re-validates the
    // SAME attempt inside its own transaction before writing anything.
    assert(/heartbeatResearchRunAtomic\(\{ userId: uploadOwner\.id, uploadId: targetUploadId, researchRunId: runId, attemptId \}\)/.test(rbSource),
      'every uploadId-bound research request verifies attemptId via heartbeatResearchRunAtomic() before any provider work -- no uploadId-bound code path skips this');
    assert(/rpc\/persist_ha_research_output/.test(suSource) && !/rpc\/replace_ha_accounts_snapshot[\s\S]{0,200}p_research_run_id/.test(suSource),
      'research-output-stage persistence goes through persist_ha_research_output exclusively -- the standalone replace_ha_accounts_snapshot call path no longer accepts attempt parameters at all (see api/save-upload.js\'s untracked branch, which never sets them)');
  }

  // =========================================================================
  // ROUND 5, item 1: atomic finalization -- structural verification that
  // dashboard/index.html no longer double-reports completion (the
  // persist_ha_research_output() call itself now finalizes atomically; see
  // scripts/test-save-upload-persistence.js for the functional proof
  // against the mocked RPC). Also restates item 1 test 5 ("process dies
  // before final persistence; lease expiry permits a valid reclaim")
  // explicitly under the round-5 framing.
  // =========================================================================
  {
    const dashSource = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
    const topAccountsStart = dashSource.indexOf('async function researchTopAccounts(options = {}){');
    const topAccountsEnd = dashSource.indexOf('\nfunction autoResearchTopAccountsOnce', topAccountsStart);
    const topAccountsBody = dashSource.slice(topAccountsStart, topAccountsEnd > -1 ? topAccountsEnd : topAccountsStart + 6000);
    assert(!/await reportResearchRunOutcome\('complete'/.test(topAccountsBody),
      'researchTopAccounts() no longer CALLS reportResearchRunOutcome(\'complete\', ...) on its success path -- persist_ha_research_output() finalizes the run atomically as part of the save itself, making the separate call unnecessary');
    assert(/await reportResearchRunOutcome\('fail'/.test(topAccountsBody),
      'researchTopAccounts() STILL reports failure separately -- failure handling remains a distinct path, since a research/network error may never reach persist_ha_research_output() at all');

    const byNameStart = dashSource.indexOf('async function researchAccountByName(accountName, options = {}){');
    const byNameEnd = dashSource.indexOf('\nlet researchInProgress', byNameStart);
    const byNameBody = dashSource.slice(byNameStart, byNameEnd > -1 ? byNameEnd : byNameStart + 6000);
    assert(!/await reportResearchRunOutcome\('complete'/.test(byNameBody),
      'researchAccountByName() (the standalone button) also no longer CALLS reportResearchRunOutcome(\'complete\', ...) on success, for the same reason');
    assert(/await reportResearchRunOutcome\('fail'/.test(byNameBody),
      'researchAccountByName() still reports failure separately on its catch path');
  }

  // "Process dies before calling final persistence; lease expiry permits a
  // valid reclaim" (item 1 test 5), restated explicitly: a run that was
  // successfully CLAIMED but never reached a successful
  // persist_ha_research_output() call at all (the process died somewhere
  // in between -- e.g. during the provider call) is indistinguishable, from
  // claim_ha_research_run()'s perspective, from any other abandoned
  // 'running' row with an expired lease -- already proven generically by
  // the "process dies without marking failed" test above; this restates it
  // under the round-5 framing for the required test list.
  {
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);
    const claimed = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(claimed.ok && claimed.outcome === 'claimed-new', 'a run is claimed successfully');
    // Simulate the process dying before EVER reaching persist_ha_research_output --
    // no heartbeat, no completion, no failure report, nothing.
    table.expireLease(FIXTURES.uploadId, 'auto');
    const reclaimed = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: 'auto' });
    assert(reclaimed.ok && reclaimed.outcome === 'reclaimed-after-expired-lease', 'ROUND 5 ITEM 1 TEST 5: a run whose process died before ever calling final persistence becomes reclaimable once its lease expires, with no explicit failure marking required');
  }

  // =========================================================================
  // Manage Customer Accounts modal / "Research Again" button semantics.
  // Proves, against the real decision logic, that clicking "Research Again"
  // on an already-completed account genuinely starts a NEW server-owned run
  // rather than silently reusing/attaching to the prior completed result --
  // the concern raised in the account-management-modal review: a button
  // labeled "Research Again" must not just re-display cached signals.
  // =========================================================================
  {
    // Part A: the full unresearched -> blocked-while-active -> completed ->
    // "Research Again" narrative, at the claim_ha_research_run() decision
    // level (claimResearchRunAtomic() is the RPC wrapper; the actual
    // per-click id is minted by handler()'s claim branch, verified
    // separately in Part C below).
    const table = makeFakeResearchRunsTable();
    global.fetch = table.fetch.bind(table);

    // 1) An unresearched account: the first manual-rerun claim (the id the
    // server would mint for a fresh single-account click) succeeds and
    // creates a brand-new run.
    const firstClickId = 'manual-2026-08-03T00:00:00.000Z-aaaaaa';
    const firstClick = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: firstClickId });
    assert(firstClick.ok && firstClick.outcome === 'claimed-new', 'RESEARCH AGAIN 1: an unresearched account\'s first manual single-account claim creates a new run');
    const firstAttemptId = firstClick.run.attempt_id;

    // 2) A second, DIFFERENT manual click (e.g. a double-click, or the
    // account-card button and the modal button both firing) while the first
    // is still actively leased must be blocked, not start a concurrent run.
    const secondClickId = 'manual-2026-08-03T00:00:00.000Z-bbbbbb';
    const secondClickWhileActive = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: secondClickId });
    assert(secondClickWhileActive.ok === false && secondClickWhileActive.status === 409, 'RESEARCH AGAIN 2: a second manual claim for the same upload while the first is still actively leased is rejected (409), not started concurrently');

    // 3) The first run completes.
    const completed = await completeResearchRunAttempt({ uploadId: FIXTURES.uploadId, researchRunId: firstClickId, attemptId: firstAttemptId, resultSummary: { signalsReturned: 3 } });
    assert(completed.applied === true, 'RESEARCH AGAIN 3: the first manual run completes successfully');

    // 4) "Research Again": a THIRD click, after completion, with yet another
    // fresh server-minted id (never reused -- see Part C for why this is
    // guaranteed). This must claim a genuinely NEW run (outcome
    // 'claimed-new'), not 'completed' -- if it returned 'completed', the
    // button would silently just redisplay the old result_summary instead
    // of starting a new one, which is exactly the risk being tested for.
    const researchAgainId = 'manual-2026-08-03T00:05:00.000Z-cccccc';
    const researchAgainClick = await claimResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: researchAgainId });
    assert(researchAgainClick.ok && researchAgainClick.outcome === 'claimed-new', 'RESEARCH AGAIN 4: clicking "Research Again" after completion claims a genuinely NEW run (outcome claimed-new), not the cached "completed" result');
    assert(researchAgainClick.run.attempt_id !== firstAttemptId, 'RESEARCH AGAIN 5: the "Research Again" run\'s attempt_id is different from the original completed run\'s attempt_id -- it is a distinct attempt, not a reattachment');
    assert(researchAgainClick.run.research_run_id !== firstClickId, 'RESEARCH AGAIN 6: the "Research Again" run has its own distinct research_run_id, never the id of the run it followed');

    // 5) The provider-call gate (heartbeatResearchRunAtomic, the same check
    // the real research request handler runs before ever calling a provider
    // -- see the ROUND 4 item 3 invariant test above) passes for this NEW
    // attempt, proving the pipeline would actually proceed to real work, not
    // stop after the claim.
    const gateForResearchAgain = await heartbeatResearchRunAtomic({ userId: FIXTURES.ownerUserId, uploadId: FIXTURES.uploadId, researchRunId: researchAgainId, attemptId: researchAgainClick.run.attempt_id });
    assert(gateForResearchAgain.ok === true, 'RESEARCH AGAIN 7: the provider-call gate passes for the "Research Again" run\'s own new attempt -- the request pipeline would proceed to call a provider, not stop at the claim');
  }

  // Part B: structural proof that researchAccountByName() (the real,
  // on-disk function the modal's "Research"/"Research Again" action will
  // call -- see researchAccountFromManageModal() below) only treats
  // 'attached-active' and 'completed' as "stop, do not research" outcomes.
  // 'claimed-new' (and the reclaim outcomes) fall through and proceed to the
  // actual fetch() call -- i.e. a "Research Again" claim is never silently
  // swallowed by the same early-return guard that blocks a truly active run.
  {
    const dashSource = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
    const fnStart = dashSource.indexOf('async function researchAccountByName(accountName, options = {}){');
    const fnEnd = dashSource.indexOf('\nlet researchInProgress', fnStart);
    const fnBody = dashSource.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 6000);
    const guardMatch = fnBody.match(/if\(!claim\.ok \|\| outcome === '([a-z-]+)' \|\| outcome === '([a-z-]+)'\)\{/);
    assert(!!guardMatch, 'researchAccountByName() has a single early-return outcome guard after claiming');
    const guardedOutcomes = guardMatch ? [guardMatch[1], guardMatch[2]].sort() : [];
    assert(JSON.stringify(guardedOutcomes) === JSON.stringify(['attached-active', 'completed'].sort()), `researchAccountByName() only stops research for outcome 'attached-active' or 'completed' -- 'claimed-new' and the reclaim outcomes are NOT in the stop-list, so a "Research Again" claim (which is always 'claimed-new', never 'completed' -- proved in Part A) falls through and proceeds. Actual guarded outcomes found: ${JSON.stringify(guardedOutcomes)}`);
    // After the guard, the function must build its payload/attemptContext
    // from THIS claim's own runId/attemptId (not any prior run's) and issue
    // the actual research fetch -- i.e. "proceeds" means "calls the
    // provider-facing endpoint", not merely "returns without error".
    const guardEnd = fnBody.indexOf('}', fnBody.indexOf(guardMatch[0])) ;
    const postGuardBody = fnBody.slice(guardEnd);
    assert(/runId = claim\.data\.researchRunId/.test(postGuardBody) && /attemptId = claim\.data\.attemptId/.test(postGuardBody), 'after the guard, runId/attemptId are taken from THIS claim\'s own response -- a "Research Again" run uses its own new run/attempt identity, never a stale prior one');
    assert(/await fetch\(endpoint,/.test(postGuardBody), 'after a successful claim (including "Research Again"\'s claimed-new), researchAccountByName() actually proceeds to call the research endpoint -- it does not stop after claiming');
  }

  // Part C: the server-minted manual-rerun id is guaranteed unique per
  // click, even for two clicks in the same millisecond -- mirrors the exact
  // expression in api/research-batch.js's claim branch
  // (`manual-${new Date().toISOString()}-${Math.random().toString(36).slice(2,8)}`),
  // so "Research Again" can never coincidentally collide with a prior run's
  // exact research_run_id and be misread as the SAME run by claim_ha_research_run()'s
  // exact-row branch.
  {
    const source = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
    const mintExprMatch = source.match(/researchRunId = runIntent === 'manual-rerun'\s*\n\s*\? `manual-\$\{new Date\(\)\.toISOString\(\)\}-\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 8\)\}`/);
    assert(!!mintExprMatch, 'the manual-rerun id-minting expression is present verbatim in api/research-batch.js (timestamp + random suffix)');
    const mintId = () => `manual-${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
    const idsFromSameMillisecond = new Set();
    for(let i = 0; i < 1000; i++) idsFromSameMillisecond.add(mintId());
    assert(idsFromSameMillisecond.size === 1000, 'the id-minting expression produces 1000/1000 unique ids even called in a tight loop (same-millisecond timestamps) -- collision with a prior run\'s exact id, which would misroute a "Research Again" click onto the old run via claim_ha_research_run()\'s exact-row branch, cannot practically happen');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
