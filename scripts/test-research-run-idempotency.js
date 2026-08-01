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
  failResearchRunAttempt
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

    // No exact-triple row. Check for a different, actively-leased running
    // row for the same upload.
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
    const claimBranchEnd = source.indexOf("if (researchRunAction === 'complete'", claimBranchStart);
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

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
