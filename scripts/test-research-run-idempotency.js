// Phase 2A implementation-review item 2 — validates the server-owned
// research-run idempotency mechanism in api/research-batch.js without a
// live database: mocks global.fetch for auth and the ha_research_runs REST
// calls, then exercises claimResearchRun() directly (the actual decision
// logic) against every required scenario.
//
// Usage: node scripts/test-research-run-idempotency.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import { claimResearchRun, completeResearchRun, failResearchRun, resolveUserForResearchRun } from '../api/research-batch.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

// In-memory fake ha_research_runs table, enforcing the same two constraints
// the real migration adds: unique(user_id, upload_id, research_run_id), and
// a partial unique index on upload_id where status='running'.
function makeFakeTable(){
  let rows = [];
  let nextId = 1;
  function findRunningForUpload(uploadId){ return rows.find(r => r.upload_id === uploadId && r.status === 'running'); }
  function findExact(userId, uploadId, researchRunId){ return rows.find(r => r.user_id === userId && r.upload_id === uploadId && r.research_run_id === researchRunId); }
  return {
    rows,
    async fetch(url, options = {}){
      const u = String(url);
      if(u.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-1', email: 'qa@example.com' });
      if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([{ id: 'user-1', email: 'qa@example.com' }]);
      if(u.includes('/rest/v1/ha_users?email=eq.')) return jsonResponse([{ id: 'user-1', email: 'qa@example.com' }]);
      if(u.startsWith(`https://example.supabase.co/rest/v1/ha_research_runs`) && (!options.method || options.method === 'GET')){
        const params = new URLSearchParams(u.split('?')[1]);
        let matches = rows;
        if(params.get('user_id')) matches = matches.filter(r => r.user_id === params.get('user_id').replace('eq.', ''));
        if(params.get('upload_id')) matches = matches.filter(r => r.upload_id === params.get('upload_id').replace('eq.', ''));
        if(params.get('research_run_id')) matches = matches.filter(r => r.research_run_id === params.get('research_run_id').replace('eq.', ''));
        return jsonResponse(matches);
      }
      if(u.startsWith(`https://example.supabase.co/rest/v1/ha_research_runs`) && options.method === 'POST'){
        const body = JSON.parse(options.body)[0];
        const existingExact = findExact(body.user_id, body.upload_id, body.research_run_id);
        if(existingExact){
          return jsonResponse({ message: 'duplicate key value violates unique constraint "ha_research_runs_user_upload_run_key"' }, false, 409);
        }
        const runningForUpload = findRunningForUpload(body.upload_id);
        if(body.status === 'running' && runningForUpload){
          return jsonResponse({ message: 'duplicate key value violates unique constraint "idx_ha_research_runs_one_running_per_upload"' }, false, 409);
        }
        const row = { id: `run-${nextId++}`, ...body };
        rows.push(row);
        return jsonResponse([row]);
      }
      if(u.startsWith(`https://example.supabase.co/rest/v1/ha_research_runs`) && options.method === 'PATCH'){
        const idMatch = u.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : null;
        const patch = JSON.parse(options.body);
        const row = rows.find(r => r.id === id);
        if(row) Object.assign(row, patch);
        return jsonResponse(row ? [row] : []);
      }
      throw new Error(`Unhandled mock fetch URL: ${u}`);
    }
  };
}

const originalFetch = global.fetch;

async function run(){
  // 1. Two tabs starting the SAME run id: the second must be told it's
  // already running, not launch its own research.
  {
    const table = makeFakeTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-shared' });
    const second = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-shared' });
    assert(first.blocked === false, 'the first tab successfully claims the run');
    assert(second.blocked === true && second.status === 202 && second.body.alreadyRunning === true, 'a second tab with the SAME run id is told it is already running, not allowed to start a second research execution');
  }

  // 2. Two DIFFERENT run IDs against the same upload concurrently: the
  // second must be rejected, not silently joined or allowed to run alongside
  // the first.
  {
    const table = makeFakeTable();
    global.fetch = table.fetch.bind(table);
    const first = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-A' });
    const second = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-B' });
    assert(first.blocked === false, 'the first distinct run id is claimed successfully');
    assert(second.blocked === true && second.status === 409, 'a second, DIFFERENT run id for the same upload while one is active is rejected with 409, not joined');
  }

  // 3. Retry after a network timeout: client resends the identical request
  // (same run id) while the original is presumably still in flight server-side.
  {
    const table = makeFakeTable();
    global.fetch = table.fetch.bind(table);
    const original = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-retry-timeout' });
    const retry = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-retry-timeout' });
    assert(original.blocked === false, 'the original request claims the run');
    assert(retry.blocked === true && retry.status === 202, 'a retry with the identical run id after a client-side timeout is treated as idempotent (202, already running), not a second execution');
  }

  // 4. Retry after a completed run: must not re-run research, must return
  // the cached outcome.
  {
    const table = makeFakeTable();
    global.fetch = table.fetch.bind(table);
    const original = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-done' });
    await completeResearchRun(original.rowId, { signalsReturned: 12, accountsResearched: 5 });
    const retry = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-done' });
    assert(retry.blocked === true && retry.status === 200 && retry.body.alreadyCompleted === true, 'a retry with a run id that already completed returns the cached outcome (200, alreadyCompleted)');
    assert(retry.body.resultSummary.signalsReturned === 12, 'the cached result summary from the original completed run is returned, not re-derived');
  }

  // 5. Failed run followed by an explicitly authorized new run: (a) retrying
  // the SAME id after a failure re-claims it and is allowed to proceed; (b) a
  // genuinely NEW id after a failure is also allowed to proceed (the failed
  // run does not permanently occupy the upload's "one active run" slot).
  {
    const table = makeFakeTable();
    global.fetch = table.fetch.bind(table);
    const original = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-failed' });
    await failResearchRun(original.rowId, 'simulated provider failure');
    const retrySameId = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-failed' });
    assert(retrySameId.blocked === false && retrySameId.outcome === 'reclaimed-after-failure', 'retrying the SAME run id after a failure re-claims it and is allowed to proceed');
    await failResearchRun(retrySameId.rowId, 'simulated provider failure again');
    const newIdAfterFailure = await claimResearchRun({ userId: 'user-1', uploadId: 'upload-1', researchRunId: 'run-fresh-after-failure' });
    assert(newIdAfterFailure.blocked === false, 'a genuinely new, different run id is allowed to proceed after a prior run for this upload failed -- a failed run does not permanently block the upload');
  }

  // 6. resolveUserForResearchRun: auth-token path and lead-email fallback.
  {
    const table = makeFakeTable();
    global.fetch = table.fetch.bind(table);
    const viaAuth = await resolveUserForResearchRun({ headers: { authorization: 'Bearer valid-token' } }, {});
    assert(viaAuth?.id === 'user-1', 'resolveUserForResearchRun resolves via a valid auth token');
    const viaLead = await resolveUserForResearchRun({ headers: {} }, { email: 'qa@example.com' });
    assert(viaLead?.id === 'user-1', 'resolveUserForResearchRun falls back to lead-email lookup when no auth token is present');
    const noMatch = await resolveUserForResearchRun({ headers: {} }, {});
    assert(noMatch === null, 'resolveUserForResearchRun returns null (not a thrown error) when neither an auth token nor a lead email is available');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
