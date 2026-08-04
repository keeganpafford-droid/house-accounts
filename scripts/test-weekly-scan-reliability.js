// Priority 0 (reliability) — validates the hung-weekly-run repair in
// api/weekly-scan.js without a live database or Vercel deployment.
//
// Two testing strategies are used:
// - Pure-function tests against the exported helpers (computeDeadline,
//   isStaleRun, summarizeChunkResult, accumulateProgress, decideFinalStatus,
//   fetchWithTimeout) — fast, deterministic, no mocking needed beyond a
//   stubbed global.fetch for the one genuine AbortController exercise.
// - Full-handler integration tests that replace global.fetch with an
//   in-memory mock covering both the Supabase REST calls and the nested
//   /api/research-batch call, then invoke the real exported `handler`
//   with fake req/res objects and assert on the PATCH bodies it sent.
//
// Usage: node scripts/test-weekly-scan-reliability.js
import handler, {
  computeDeadline, isStaleRun, fetchWithTimeout, summarizeChunkResult,
  accumulateProgress, decideFinalStatus, FUNCTION_MAX_DURATION_MS, FINALIZE_RESERVE_MS,
  RESEARCH_FETCH_TIMEOUT_MS, safeSecretEqual
} from '../api/weekly-scan.js';
import { resolveOpportunityEvents, dedupeByEventFingerprint, normalizeOpportunity } from '../api/signal-intelligence.js';

// Every scenario below now runs against a fail-closed handler (security
// hotfix: weekly-monitoring authorization) — a valid CRON_SECRET and a
// matching Authorization: Bearer header are required by default so that
// pre-existing orchestration behavior is still exercised, not the auth
// wall. Tests that specifically target the auth wall itself override
// cronSecretEnv/authHeader explicitly (see the "hotfix" section below).
const TEST_CRON_SECRET = 'test-cron-secret-do-not-log-1234567890';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// Mimics PostgREST's actual column-projection behavior: a `select=` query
// parameter returns ONLY the listed columns, never the full row — a filter
// like `status=eq.running` elsewhere in the same URL does not add `status`
// to what comes back. A hand-authored fixture that happens to include every
// field the application code wants can silently mask a real select= bug
// (exactly what let the production July 27 stale-run row go undetected:
// weekly-scan.js's stale-run query omitted `status` from its select= list,
// so isStaleRun() never actually saw it). Applied to ha_weekly_runs GET
// responses below so a regression of that select= list fails a test here,
// not just in production.
function projectBySelect(row, url){
  if(!row) return row;
  const match = String(url).match(/[?&]select=([^&]+)/);
  if(!match) return row; // no select= param present -> PostgREST returns every column
  const columns = decodeURIComponent(match[1]).split(',').map(c => c.trim()).filter(Boolean);
  const projected = {};
  for(const col of columns){
    if(col.includes('(')) continue; // embedded-resource syntax (e.g. ha_users(...)) — not used by any ha_weekly_runs query in this file
    if(Object.prototype.hasOwnProperty.call(row, col)) projected[col] = row[col];
  }
  return projected;
}

function jsonResponse(data, ok = true, status = 200){
  // api/weekly-scan.js's supabase() helper reads the body via .text() (then
  // JSON.parse()s it itself); the research-batch fetch also reads .text()
  // first now. Support both, plus a no-op .headers.get() so any response
  // used as a success case is safe even if future code reads headers on
  // that path too.
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

// A response that is NOT valid JSON — models a platform-level failure page
// (e.g. a Vercel function-invocation timeout/crash), which is plain
// text/HTML, not JSON, and arrives with its own status/headers rather than
// anything api/research-batch.js's own code produced (every return path in
// that file returns JSON, including its own catch-all).
function textResponse(text, { status = 200, headers = {} } = {}){
  const lower = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower.get(String(name).toLowerCase()) ?? null },
    json: async () => { throw new SyntaxError(`Unexpected token in non-JSON test response: ${text.slice(0, 20)}`); },
    text: async () => text
  };
}

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

{
  const start = 1000000;
  assert(
    computeDeadline(start) === start + FUNCTION_MAX_DURATION_MS - FINALIZE_RESERVE_MS,
    'computeDeadline reserves FINALIZE_RESERVE_MS out of the function duration budget'
  );
}

// 5. stale running run being settled on the next invocation (decision logic)
{
  const now = Date.now();
  assert(isStaleRun({status:'running', started_at:new Date(now - 20*60*1000).toISOString()}, {now}) === true, 'a running run started 20 minutes ago is stale (past the 15-minute threshold)');
  assert(isStaleRun({status:'running', started_at:new Date(now - 5*60*1000).toISOString()}, {now}) === false, 'a running run started 5 minutes ago is not yet stale');
  assert(isStaleRun({status:'complete', started_at:new Date(now - 20*60*1000).toISOString()}, {now}) === false, 'a completed run is never considered stale regardless of age');
  assert(isStaleRun(null, {now}) === false, 'a missing run is not stale');
}

// Regression guard for the exact production defect: a row shaped exactly
// like what a select= list OMITTING `status` produces from PostgREST (the
// key is absent entirely, not status:null — that is the real shape of the
// bug that let the July 27 production run survive a full, successful
// reprocessing of its own upload without ever being settled). isStaleRun's
// own guard must never treat a missing status as a match, no matter how old
// the row is; the actual fix is the select= list in weekly-scan.js itself
// (proven by the integration test further below), but this proves the
// function does not silently paper over that class of bug either.
{
  const now = Date.now();
  const rowMissingStatus = { id:'row-without-status', started_at: new Date(now - 60 * 60 * 1000).toISOString(), summary:{accounts:10} };
  assert(isStaleRun(rowMissingStatus, {now}) === false, 'a row shaped like a select= projection that omits `status` is never settled, no matter how old — proves isStaleRun cannot silently treat a missing field as a match');
}

// 4/6. explicit outcome states — decision table
{
  assert(decideFinalStatus({accountsProcessed:10, accountsFailed:0, totalAccounts:10, sawTimeout:false}) === 'complete', 'all accounts processed, none failed, no timeout -> complete');
  assert(decideFinalStatus({accountsProcessed:2, accountsFailed:0, totalAccounts:10, sawTimeout:true}) === 'partial', '2 of 10 processed with a timeout -> partial, not a clean failure and not stuck running');
  assert(decideFinalStatus({accountsProcessed:0, accountsFailed:5, totalAccounts:10, sawTimeout:false}) === 'failed', 'zero processed, some failed, no timeout -> failed');
  assert(decideFinalStatus({accountsProcessed:0, accountsFailed:0, totalAccounts:10, sawTimeout:true}) === 'timed_out', 'zero processed due to a timeout -> timed_out, distinct from a clean failure');
  assert(decideFinalStatus({accountsProcessed:8, accountsFailed:2, totalAccounts:10, sawTimeout:false}) === 'partial', '8 of 10 processed, 2 failed, no timeout -> partial');
}

// 1. research-batch exceeding its timeout — a genuine AbortController
// exercise (small explicit timeout so the test stays fast; the mechanism
// being tested is real, not simulated).
{
  const realFetch = global.fetch;
  // A real fetch() rejects when its AbortSignal fires; this stub must do the
  // same, or the timeout it's meant to exercise never actually completes.
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const startedAt = Date.now();
  let threw = null;
  try{
    await fetchWithTimeout('https://example.com/hang', {}, 50);
  }catch(err){ threw = err; }
  const elapsed = Date.now() - startedAt;
  global.fetch = realFetch;
  assert(threw?.name === 'AbortError', 'fetchWithTimeout rejects with a distinguishable AbortError when the underlying request never resolves');
  assert(elapsed < 500, `fetchWithTimeout actually bounds the request close to its timeout (took ${elapsed}ms for a 50ms bound)`);
}

// 2/3. one chunk succeeding and a later chunk timing out; progress
// persisted after the successful chunk before the timeout is even known.
{
  let progress = { accounts:10, totalChunks:2, chunksAttempted:0, chunksCompleted:0, accountsAttempted:0, accountsProcessed:0, accountsFailed:0, diagnostics:[] };
  progress = accumulateProgress(progress, { chunkIndex:1, totalChunks:2, chunkOutcome:{accountsAttempted:5, accountsProcessed:5, accountsFailed:0, completed:true}, chunkDiagnostics:{note:'chunk1'}, totalAccounts:10 });
  assert(progress.chunksCompleted === 1 && progress.accountsProcessed === 5, 'progress after chunk 1 alone already reflects 5 processed accounts and 1 completed chunk — this is exactly what gets PATCHed before chunk 2 is even attempted');
  progress = accumulateProgress(progress, { chunkIndex:2, totalChunks:2, chunkOutcome:{accountsAttempted:5, accountsProcessed:0, accountsFailed:5, completed:false}, chunkDiagnostics:{note:'chunk2-timeout'}, totalAccounts:10 });
  assert(progress.chunksAttempted === 2 && progress.chunksCompleted === 1 && progress.accountsProcessed === 5 && progress.accountsFailed === 5, "after chunk 2 times out, cumulative totals show 1 of 2 chunks completed and only chunk 1's accounts processed — chunk 1's progress is not lost");
  const status = decideFinalStatus({accountsProcessed:progress.accountsProcessed, accountsFailed:progress.accountsFailed, totalAccounts:10, sawTimeout:true});
  assert(status === 'partial', 'one chunk succeeding and a later chunk timing out ends the run as partial, not stuck running and not equivalent to a clean failure');
}

// summarizeChunkResult — real success shape vs. synthetic all-failed shape
{
  const success = summarizeChunkResult({diagnostics:{structuredSummary:{eligibleAccounts:5, processedAccounts:5, failedAccounts:0}}}, 5);
  assert(success.accountsProcessed === 5 && success.accountsFailed === 0, 'summarizeChunkResult reads a successful research-batch response correctly');
  const failure = summarizeChunkResult({diagnostics:{structuredSummary:{eligibleAccounts:5, processedAccounts:0, failedAccounts:5}}}, 5);
  assert(failure.accountsProcessed === 0 && failure.accountsFailed === 5, 'summarizeChunkResult reads the synthetic all-failed shape correctly');
}

// 7. retryability — a retried/partial run must not duplicate an
// already-persisted event, even if the retry's AI generation phrases it
// differently. This reuses the same resolveOpportunityEvents/
// dedupeByEventFingerprint machinery weekly-scan.js calls before every write.
{
  const account = { name: 'Avidia Bank' };
  const firstRunOpportunity = normalizeOpportunity({
    companyName: 'Avidia Bank', accountName: 'Avidia Bank',
    signalTitle: 'Westborough Branch Ribbon Cutting',
    whatChanged: 'Avidia Bank held a ribbon cutting for its new Westborough branch.',
    sourceUrl: 'https://businesswire.com/avidia-westborough',
    confidenceScore: 80
  }, account, {});
  // Simulates a later, separate invocation (a retry of a timed-out/partial
  // run) re-discovering the same real event with different wording.
  const retryRunOpportunity = normalizeOpportunity({
    companyName: 'Avidia Bank', accountName: 'Avidia Bank',
    signalTitle: 'Ribbon Cutting Ceremony for Westborough Branch',
    whatChanged: 'A ribbon cutting ceremony was held celebrating the new Westborough branch of Avidia Bank.',
    sourceUrl: 'https://westboroughchamber.org/news/avidia',
    confidenceScore: 76
  }, account, {});

  const firstRunResolved = resolveOpportunityEvents([firstRunOpportunity]);
  const retryRunResolved = resolveOpportunityEvents([retryRunOpportunity]);
  assert(
    firstRunResolved[0]?.eventFingerprint && firstRunResolved[0].eventFingerprint === retryRunResolved[0]?.eventFingerprint,
    'a retried run re-discovering the same real event (with different wording) computes the identical event_fingerprint as the original run'
  );

  // Simulate what the database's on_conflict(user_id, event_fingerprint)
  // upsert does: combine "already persisted" with "this retry's candidate"
  // and confirm only one survives.
  const alreadyPersistedRow = { user_id:'u1', event_fingerprint: firstRunResolved[0].eventFingerprint, confidence: 80, title: 'from the original run' };
  const retryRow = { user_id:'u1', event_fingerprint: retryRunResolved[0].eventFingerprint, confidence: 76, title: 'from the retry' };
  const combined = dedupeByEventFingerprint([alreadyPersistedRow, retryRow], {
    keyOf: r => `${r.user_id}|${r.event_fingerprint}`,
    scoreOf: r => Number(r.confidence || 0)
  });
  assert(combined.length === 1 && combined[0].title === 'from the original run', 'retrying a partial/timed-out run does not duplicate an already-persisted event — the composite key collapses both to one, keeping the higher-confidence row');
}

// ---------------------------------------------------------------------------
// Full-handler integration tests (mocked fetch — no live DB, no Vercel)
// ---------------------------------------------------------------------------

function makeRes(){
  const res = { statusCode:200, body:null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function runHandlerScenario({ researchBehavior, weeklyRunsPatchBehavior, weeklyRunsPostBehavior, priorRunningRows = [], activeRunLookupRows = [], accountsOverride, query = {}, knownUploadIds, cronSecretEnv, authHeader }){
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  // cronSecretEnv: undefined (default) -> a valid CRON_SECRET is set so
  // normal orchestration scenarios pass the auth wall unmodified; null ->
  // CRON_SECRET is deliberately unset (503 scenario); any string -> used
  // verbatim as CRON_SECRET.
  if (cronSecretEnv === null) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = cronSecretEnv === undefined ? TEST_CRON_SECRET : cronSecretEnv;
  delete process.env.RESEND_API_KEY; // sendEmail short-circuits without this
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE; // use the new default (5)

  const patchCalls = [];
  const userId = 'user-1', uploadId = 'upload-1';
  const accounts = Array.from({length:10}, (_, i) => ({
    id:`acct-${i+1}`, account_name:`Account ${i+1}`, industry:'', contact_name:'', contact_email:'',
    metrics:{}, raw_data:{}, created_at:new Date().toISOString(), updated_at:new Date().toISOString()
  }));
  const uploadRow = { id: uploadId, user_id:userId, upload_name:'Test List', summary:{}, created_at:new Date().toISOString(), ha_users:{id:userId, email:'test@example.com', name:'Test User', company:''} };
  const validUploadIds = knownUploadIds || [uploadId];
  let runIdCounter = 0;
  let staleRowsServed = false;
  const uploadsQueryShapes = [];
  const getCalls = [];

  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';

    if(u.includes('/rest/v1/ha_uploads') && method === 'GET' && u.includes('id=eq.')){
      // Targeted lookup path (?uploadId=...): resolves a single upload by id,
      // or an empty array if the id doesn't match a known upload — mirroring
      // how a malformed/nonexistent uuid behaves against the real endpoint.
      uploadsQueryShapes.push('targeted');
      const requested = decodeURIComponent(u.match(/id=eq\.([^&]+)/)?.[1] || '');
      return jsonResponse(validUploadIds.includes(requested) && requested === uploadId ? [uploadRow] : []);
    }
    if(u.includes('/rest/v1/ha_uploads') && method === 'GET'){
      // Normal sweep path (order=updated_at.desc&limit=...).
      uploadsQueryShapes.push('sweep');
      return jsonResponse([uploadRow]);
    }
    if(u.includes('/rest/v1/ha_accounts')){
      return jsonResponse(accountsOverride !== undefined ? accountsOverride : accounts);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'GET' && u.includes('limit=1')){
      // The "detect another active run" lookup performed only after a
      // run-creation 409 conflict — distinct from the stale-check query
      // below (which uses limit=20).
      getCalls.push(u);
      return jsonResponse(activeRunLookupRows.map(row => projectBySelect(row, u)));
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'GET'){
      // Serve the stale-run rows exactly once (the stale-check query), then
      // an empty list, so we don't loop forever finding the same rows.
      getCalls.push(u);
      if(!staleRowsServed){ staleRowsServed = true; return jsonResponse(priorRunningRows.map(row => projectBySelect(row, u))); }
      return jsonResponse([]);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'POST'){
      if(weeklyRunsPostBehavior){
        const overridden = weeklyRunsPostBehavior(JSON.parse(options.body)[0]);
        if(overridden) return overridden;
      }
      runIdCounter += 1;
      const body = JSON.parse(options.body)[0];
      return jsonResponse([{ id:`run-${runIdCounter}`, ...body }]);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH'){
      const body = JSON.parse(options.body);
      patchCalls.push({ url:u, body });
      if(weeklyRunsPatchBehavior) return weeklyRunsPatchBehavior(body, patchCalls);
      return jsonResponse([{ id:'run-1', ...body }]);
    }
    if(u.includes('/rest/v1/ha_signals') && method === 'POST'){
      return jsonResponse([]);
    }
    if(u.includes('/api/research-batch')){
      return researchBehavior(JSON.parse(options.body));
    }
    throw new Error(`Unhandled fetch in test mock: ${method} ${u}`);
  };

  // authHeader: undefined (default) -> a valid Bearer header matching
  // TEST_CRON_SECRET (or the overridden cronSecretEnv); null -> omit the
  // Authorization header entirely; any string -> used verbatim.
  const headers = { host:'example.test' };
  if (authHeader !== null) {
    headers.authorization = authHeader !== undefined ? authHeader : `Bearer ${cronSecretEnv === undefined ? TEST_CRON_SECRET : cronSecretEnv}`;
  }
  const req = { method:'GET', headers, query:{limit:'25', ...query} };
  const res = makeRes();
  try{
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
  }
  return { res, patchCalls, uploadsQueryShapes, getCalls };
}

{
  // Chunk 1 (accounts 1-5) succeeds; chunk 2 (accounts 6-10) times out.
  let call = 0;
  const { res, patchCalls } = await runHandlerScenario({
    researchBehavior: async (body) => {
      call += 1;
      if(call === 1){
        return jsonResponse({
          signals: [],
          diagnostics: { structuredSummary: { eligibleAccounts: body.accounts.length, processedAccounts: body.accounts.length, failedAccounts:0 } }
        });
      }
      const err = new Error('simulated abort'); err.name = 'AbortError';
      throw err;
    }
  });

  const runPatches = patchCalls.filter(p => p.url.includes('/ha_weekly_runs'));
  const progressPatches = runPatches.filter(p => p.body.summary && !p.body.status);
  const finalPatches = runPatches.filter(p => p.body.status);

  assert(progressPatches.length >= 1, 'at least one progress-only PATCH was sent after a chunk, before the run finished');
  assert(progressPatches[0]?.body?.summary?.accountsProcessed === 5, 'the progress PATCH after chunk 1 reflects 5 processed accounts — real evidence beyond the frozen creation-time summary');
  assert(finalPatches.length === 1, 'exactly one final status PATCH was sent');
  assert(finalPatches[0]?.body?.status === 'partial', 'the run ends as partial (5 of 10 processed, chunk 2 timed out) — not stuck running, not read as a clean failure');
  assert(!!finalPatches[0]?.body?.finished_at, 'the final PATCH sets finished_at');
  assert(res.statusCode === 200, 'the handler still returns a clean HTTP 200 even though one chunk timed out');
}

{
  // Stale running run being settled on the next invocation, end-to-end
  // through the handler (not just the isStaleRun() pure-function check).
  const staleStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 minutes ago
  const { patchCalls } = await runHandlerScenario({
    priorRunningRows: [{ id:'stuck-run-1', status:'running', started_at: staleStartedAt, summary:{accounts:10} }],
    researchBehavior: async (body) => jsonResponse({
      signals: [],
      diagnostics: { structuredSummary: { eligibleAccounts: body.accounts.length, processedAccounts: body.accounts.length, failedAccounts:0 } }
    })
  });
  const staleSettlePatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs?id=eq.stuck-run-1'));
  assert(!!staleSettlePatch, 'a prior run stuck in "running" for 20 minutes is PATCHed the next time this upload is processed');
  assert(staleSettlePatch?.body?.status === 'timed_out', 'the stale run is settled to timed_out, not left running and not silently deleted');
  assert(!!staleSettlePatch?.body?.finished_at, 'the stale-run settlement sets finished_at');
  assert(!!staleSettlePatch?.body?.summary?.timeoutReason, 'the stale-run settlement records a clear reason, distinguishing it from a normal completion');
  assert(staleSettlePatch?.body?.summary?.accounts === 10, "the stale run's preserved progress summary (accounts:10) is carried into the settlement, not discarded");
}

{
  // 5. Never silently swallow finalization failure: both chunks time out
  // (zero accounts processed), and the finalization PATCH itself also
  // fails. Both the processing error and the finalization error must be
  // logged distinctly.
  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => { loggedCalls.push(args.map(a => (a instanceof Error ? a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ')); };

  await runHandlerScenario({
    researchBehavior: async () => { const err = new Error('simulated abort'); err.name = 'AbortError'; throw err; },
    weeklyRunsPatchBehavior: (body) => {
      if(body.status) throw new Error('Supabase PATCH failed (simulated)'); // fail only the final/failure status PATCH, not progress PATCHes
      return jsonResponse([{ id:'run-1', ...body }]);
    }
  });

  console.error = originalConsoleError;
  assert(
    loggedCalls.some(m => m.includes('processing error for upload') && m.includes('Supabase PATCH failed (simulated)')),
    'the original processing error (the failed finalization PATCH surfacing as a thrown error) is logged'
  );
  assert(
    loggedCalls.some(m => m.includes('FAILED TO FINALIZE')),
    "a second, separate failure finalizing the run (the failure-marking PATCH itself failing) is also logged — not silently swallowed by an empty .catch(()=>{})"
  );
}

// ---------------------------------------------------------------------------
// Operational admin-targeting tests: ?uploadId=<uuid>
// ---------------------------------------------------------------------------

function successfulResearch(){
  return async (body) => jsonResponse({
    signals: [],
    diagnostics: { structuredSummary: { eligibleAccounts: body.accounts.length, processedAccounts: body.accounts.length, failedAccounts:0 } }
  });
}

{
  // uploadId found: processes that upload via the targeted lookup path, not
  // the normal sweep.
  const { res, uploadsQueryShapes } = await runHandlerScenario({
    query: { uploadId: 'upload-1' },
    researchBehavior: successfulResearch()
  });
  assert(res.statusCode === 200, 'a valid uploadId returns 200');
  assert(res.body?.scopedUploadId === 'upload-1', 'the response echoes back the scoped uploadId for operational visibility');
  assert(uploadsQueryShapes.length === 1 && uploadsQueryShapes[0] === 'targeted', 'a provided uploadId hits the targeted lookup query, not the normal limit-bounded sweep query');
}

{
  // uploadId missing: existing behavior preserved exactly — the normal sweep
  // query runs, not the targeted lookup.
  const { res, uploadsQueryShapes } = await runHandlerScenario({
    researchBehavior: successfulResearch()
  });
  assert(res.statusCode === 200, 'omitting uploadId still returns 200 (unchanged behavior)');
  assert(res.body?.scopedUploadId === null, 'the response reports scopedUploadId as null when uploadId was not provided');
  assert(uploadsQueryShapes.length === 1 && uploadsQueryShapes[0] === 'sweep', 'omitting uploadId hits the normal limit-bounded sweep query, not the targeted lookup — existing behavior is unchanged');
}

{
  // uploadId invalid: does not exist (or is malformed and resolves to no
  // match) -> 404, and the handler never reaches research-batch at all.
  let researchBatchCalled = false;
  const { res, patchCalls } = await runHandlerScenario({
    query: { uploadId: 'does-not-exist' },
    researchBehavior: async () => { researchBatchCalled = true; throw new Error('should never be called for an invalid uploadId'); }
  });
  assert(res.statusCode === 404, 'an unknown/invalid uploadId returns 404, not a 500 or a silent empty success');
  assert(!researchBatchCalled, 'an invalid uploadId short-circuits before any research-batch call is made');
  assert(patchCalls.length === 0, 'an invalid uploadId writes nothing to ha_weekly_runs — no run is created for a target that does not exist');
}

{
  // uploadId + dryRun=true: the upload is processed for real (progress/final
  // PATCHes still happen), but no email would be sent for any produced
  // signals — mirroring the non-targeted dryRun behavior exactly.
  const { res, patchCalls } = await runHandlerScenario({
    query: { uploadId: 'upload-1', dryRun: 'true' },
    researchBehavior: successfulResearch()
  });
  assert(res.body?.dryRun === true, 'dryRun is honored together with uploadId');
  assert(res.body?.scopedUploadId === 'upload-1', 'uploadId scoping and dryRun are independent — both apply together');
  const finalPatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs') && p.body.status);
  assert(!!finalPatch, 'the targeted run still reaches a final status PATCH under dryRun=true — dryRun only suppresses email, nothing else');
}

{
  // uploadId processes exactly one upload: even though the mock's sweep path
  // would return the same single upload, confirm this scenario only ever
  // creates/finalizes exactly one run — no accidental double-processing.
  const { patchCalls } = await runHandlerScenario({
    query: { uploadId: 'upload-1' },
    researchBehavior: successfulResearch()
  });
  const finalPatches = patchCalls.filter(p => p.url.includes('/ha_weekly_runs') && p.body.status);
  assert(finalPatches.length === 1, 'uploadId targeting processes exactly one upload — exactly one run reaches a final status');
}

{
  // Existing behavior without uploadId remains unchanged: re-run the
  // original "one chunk succeeds, one chunk times out -> partial" scenario
  // with no uploadId, confirming identical outcome to before this feature
  // was added.
  let call = 0;
  const { res, patchCalls } = await runHandlerScenario({
    researchBehavior: async (body) => {
      call += 1;
      if(call === 1){
        return jsonResponse({
          signals: [],
          diagnostics: { structuredSummary: { eligibleAccounts: body.accounts.length, processedAccounts: body.accounts.length, failedAccounts:0 } }
        });
      }
      const err = new Error('simulated abort'); err.name = 'AbortError';
      throw err;
    }
  });
  const finalPatches = patchCalls.filter(p => p.url.includes('/ha_weekly_runs') && p.body.status);
  assert(res.statusCode === 200, 'no-uploadId behavior: still returns 200');
  assert(finalPatches[0]?.body?.status === 'partial', 'no-uploadId behavior: chunk-timeout-produces-partial outcome is unchanged by adding the uploadId feature');
  assert(res.body?.scopedUploadId === null, 'no-uploadId behavior: scopedUploadId is null, confirming this ran through the unscoped sweep path');
}

// ---------------------------------------------------------------------------
// Monitoring lifecycle hardening tests: stale-sweep ordering, the partial
// unique index's application-level conflict handling, and terminal-state
// retries.
// ---------------------------------------------------------------------------

{
  // Zero eligible accounts: the stale-run settlement sweep must still run
  // and settle a genuinely stuck run even when this upload currently has no
  // eligible accounts at all. Before the reordering fix, the sweep sat
  // AFTER the `if(!accountPayloads.length) continue` gate, so an upload
  // that got stuck while it still had eligible accounts, then later had
  // every account removed/paused, would never be revisited by any future
  // invocation — the early `continue` skipped straight past the sweep.
  const staleStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  let researchBatchCalled = false;
  const { patchCalls } = await runHandlerScenario({
    accountsOverride: [],
    priorRunningRows: [{ id:'stuck-run-zero-accounts', status:'running', started_at: staleStartedAt, summary:{accounts:10} }],
    researchBehavior: async () => { researchBatchCalled = true; throw new Error('should never be called when there are zero eligible accounts'); }
  });
  const staleSettlePatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs?id=eq.stuck-run-zero-accounts'));
  assert(!!staleSettlePatch, 'a stuck run is settled even for an upload with zero eligible accounts this invocation — the sweep no longer depends on eligible accounts existing');
  assert(staleSettlePatch?.body?.status === 'timed_out', 'the stuck run is settled to timed_out even though this upload has no eligible accounts to process afterward');
  assert(!researchBatchCalled, 'zero eligible accounts still short-circuits before any research-batch call — settlement is the only thing that happens for this upload');
  const runCreationPatch = patchCalls.some(p => p.body?.summary && !p.body?.status && p.url !== staleSettlePatch.url);
  assert(!runCreationPatch, 'no new run is created (and therefore no progress PATCH sent) for an upload with zero eligible accounts');
}

{
  // Retry after timeout: a run previously settled as stale (timed_out) does
  // not block a fresh run from being created and completing normally on a
  // later invocation. timed_out is a terminal state, not 'running', so the
  // partial unique index has nothing to conflict with once settlement runs.
  const staleStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const { res, patchCalls } = await runHandlerScenario({
    priorRunningRows: [{ id:'stuck-run-retry', status:'running', started_at: staleStartedAt, summary:{accounts:10} }],
    researchBehavior: successfulResearch()
  });
  const staleSettlePatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs?id=eq.stuck-run-retry'));
  const finalPatches = patchCalls.filter(p => p.url.includes('/ha_weekly_runs') && p.body.status && p.url !== staleSettlePatch?.url);
  assert(!!staleSettlePatch && staleSettlePatch.body.status === 'timed_out', 'the prior run is settled to timed_out before the retry proceeds');
  assert(finalPatches.length === 1 && finalPatches[0]?.body?.status === 'complete', 'a fresh run for the same upload is created and reaches a normal completion on this retry invocation — settlement does not block it');
  assert(res.statusCode === 200, 'the retry invocation returns 200');
}

{
  // Retry after failure: a run previously settled as 'failed' (terminal,
  // not 'running') is not seen by the stale-check query at all in
  // production (it only ever selects status=eq.running) and must not block
  // a fresh run either.
  const { res, patchCalls } = await runHandlerScenario({
    priorRunningRows: [],
    researchBehavior: successfulResearch()
  });
  const finalPatches = patchCalls.filter(p => p.url.includes('/ha_weekly_runs') && p.body.status);
  assert(finalPatches.length === 1 && finalPatches[0]?.body?.status === 'complete', 'a fresh run for the same upload is created and completes normally when the only prior run for it already ended in a terminal failed state');
  assert(res.statusCode === 200, 'the retry-after-failure invocation returns 200');
}

{
  // Duplicate-running prevention: the run-creation INSERT collides with
  // idx_ha_weekly_runs_one_running_per_upload (simulated as a 409 whose
  // message names that index, exactly like PostgREST's real error shape).
  // The handler must skip this upload cleanly — no 'failed' run, no
  // research-batch call, a clear operator-facing reason — rather than
  // treating the conflict as a processing error.
  let researchBatchCalled = false;
  const { res, patchCalls } = await runHandlerScenario({
    weeklyRunsPostBehavior: () => jsonResponse({message:'duplicate key value violates unique constraint "idx_ha_weekly_runs_one_running_per_upload"'}, false, 409),
    activeRunLookupRows: [{ id:'run-already-active', started_at: new Date().toISOString() }],
    researchBehavior: async () => { researchBatchCalled = true; throw new Error('should never be called when run creation hits the duplicate-running conflict'); }
  });
  assert(res.statusCode === 200, 'a duplicate-running conflict on one upload still returns an overall 200 — it is not a request-level failure');
  const entry = res.body?.runs?.[0];
  assert(entry?.skipped === true, 'the conflicting upload is reported as skipped, not as a processed run and not as an error');
  assert(!entry?.error, 'no error field is set for a duplicate-running skip — this is expected, benign behavior, not a failure');
  assert(typeof entry?.reason === 'string' && entry.reason.includes('already in progress'), 'the skip carries a clear, operator-facing reason');
  assert(entry.reason.includes('run-already-active'), 'the reason includes the id of the run that is already active, when that lookup succeeds');
  assert(!researchBatchCalled, 'no research-batch call is made for an upload that lost the run-creation race');
  const failedPatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs') && p.body?.status === 'failed');
  assert(!failedPatch, 'no run is ever marked failed as a result of the duplicate-running conflict');
}

{
  // Concurrent invocation: two full handler() invocations processing the
  // SAME upload at the same time, backed by a single shared in-memory
  // "database" state object that enforces the partial unique index's
  // real behavior (reject a second concurrent INSERT of a 'running' row for
  // the same upload_id). This models exactly what the index guards against
  // in production: an overlapping cron tick and a manual ?uploadId=
  // trigger, or two overlapping cron ticks.
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  delete process.env.RESEND_API_KEY;
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE;

  const uploadId = 'upload-race';
  const accounts = Array.from({length:2}, (_, i) => ({
    id:`acct-${i+1}`, account_name:`Account ${i+1}`, industry:'', contact_name:'', contact_email:'',
    metrics:{}, raw_data:{}, created_at:new Date().toISOString(), updated_at:new Date().toISOString()
  }));
  const uploadRow = { id: uploadId, user_id:'user-race', upload_name:'Race List', summary:{}, created_at:new Date().toISOString(), ha_users:{id:'user-race', email:'race@example.com', name:'Race User', company:''} };

  let runningRow = null; // shared "database" state: at most one running row for this upload, ever
  let runIdCounter = 0;
  let researchBatchCalls = 0;

  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if(u.includes('/rest/v1/ha_uploads')) return jsonResponse([uploadRow]);
    if(u.includes('/rest/v1/ha_accounts')) return jsonResponse(accounts);
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'GET' && u.includes('limit=1')){
      return jsonResponse(runningRow ? [runningRow] : []);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'GET'){
      return jsonResponse([]); // nothing stale to settle in this scenario
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'POST'){
      if(runningRow){
        return jsonResponse({message:'duplicate key value violates unique constraint "idx_ha_weekly_runs_one_running_per_upload"'}, false, 409);
      }
      runIdCounter += 1;
      const body = JSON.parse(options.body)[0];
      runningRow = { id:`run-${runIdCounter}`, started_at: body.started_at };
      return jsonResponse([{ id: runningRow.id, ...body }]);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH'){
      const body = JSON.parse(options.body);
      if(body.status) runningRow = null; // reaching a terminal state frees the upload for a future run
      return jsonResponse([{ id: 'run-patched', ...body }]);
    }
    if(u.includes('/rest/v1/ha_signals') && method === 'POST') return jsonResponse([]);
    if(u.includes('/api/research-batch')){
      researchBatchCalls += 1;
      return jsonResponse({signals:[], diagnostics:{structuredSummary:{eligibleAccounts:2, processedAccounts:2, failedAccounts:0}}});
    }
    throw new Error(`Unhandled fetch in concurrent-invocation test mock: ${method} ${u}`);
  };

  const makeReq = () => ({ method:'GET', headers:{host:'example.test', authorization:`Bearer ${TEST_CRON_SECRET}`}, query:{uploadId, limit:'25'} });
  const res1 = makeRes();
  const res2 = makeRes();
  try{
    await Promise.all([handler(makeReq(), res1), handler(makeReq(), res2)]);
  } finally {
    global.fetch = realFetch;
  }

  const outcomes = [res1.body?.runs?.[0], res2.body?.runs?.[0]];
  const processed = outcomes.filter(r => r && !r.skipped && !r.error);
  const skipped = outcomes.filter(r => r?.skipped);
  assert(res1.statusCode === 200 && res2.statusCode === 200, 'both concurrent invocations return 200 — losing the race is not an HTTP error');
  assert(processed.length === 1, 'exactly one of two concurrent invocations for the same upload actually processes it');
  assert(skipped.length === 1, 'the other concurrent invocation is cleanly skipped, not failed, not double-processed');
  assert(!!skipped[0]?.reason && skipped[0].reason.includes('already in progress'), 'the losing invocation reports a clear, operator-facing reason');
  assert(researchBatchCalls === 1, 'only the winning invocation calls research-batch — the loser makes no downstream calls at all for an upload it does not own');
}

{
  // Integration proof for the select= column-projection fix, end to end.
  // Uses a mock that enforces real PostgREST column-projection via
  // projectBySelect (not a hand-authored fixture that already happens to
  // include every field the code wants) so that if weekly-scan.js's
  // stale-run query ever regresses to omit `status` again, THIS SAME mock
  // would silently strip it exactly like production does — settlement would
  // never fire, the stuck row would never clear, and the run-creation POST
  // would hit the partial unique index's conflict on every invocation,
  // permanently starving this upload. That is exactly the risk requirement
  // 6 flagged: deploying the index without this fix turns a merely-stuck
  // row into a permanently-unrecoverable one.
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  delete process.env.RESEND_API_KEY;
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE;

  const uploadId = 'upload-select-fix';
  const accounts = Array.from({length:2}, (_, i) => ({
    id:`acct-${i+1}`, account_name:`Account ${i+1}`, industry:'', contact_name:'', contact_email:'',
    metrics:{}, raw_data:{}, created_at:new Date().toISOString(), updated_at:new Date().toISOString()
  }));
  const uploadRow = { id: uploadId, user_id:'user-select-fix', upload_name:'Select Fix List', summary:{}, created_at:new Date().toISOString(), ha_users:{id:'user-select-fix', email:'selectfix@example.com', name:'Select Fix User', company:''} };
  const staleStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  // The full, real-shaped stuck row exactly as it exists in production —
  // deliberately includes every column the table actually has. Which fields
  // the application code actually sees is decided by the mock's URL-based
  // projection below, not by this fixture, matching real PostgREST behavior.
  let stuckRow = { id:'stuck-run-select-fix', upload_id: uploadId, status:'running', started_at: staleStartedAt, finished_at:null, summary:{accounts:10} };
  const getCalls = [];
  let runIdCounter = 0;

  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if(u.includes('/rest/v1/ha_uploads')) return jsonResponse([uploadRow]);
    if(u.includes('/rest/v1/ha_accounts')) return jsonResponse(accounts);
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'GET'){
      getCalls.push(u);
      const rows = stuckRow ? [projectBySelect(stuckRow, u)] : [];
      return jsonResponse(rows);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'POST'){
      if(stuckRow){
        // The real partial unique index would reject this — the stuck row
        // is still status='running' in the shared mock state.
        return jsonResponse({message:'duplicate key value violates unique constraint "idx_ha_weekly_runs_one_running_per_upload"'}, false, 409);
      }
      runIdCounter += 1;
      const body = JSON.parse(options.body)[0];
      return jsonResponse([{ id:`run-${runIdCounter}`, ...body }]);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH'){
      const body = JSON.parse(options.body);
      if(body.status && stuckRow && u.includes(stuckRow.id)) stuckRow = null; // settlement clears the blocker, exactly like the real UPDATE would
      return jsonResponse([{ id:'run-patched', ...body }]);
    }
    if(u.includes('/rest/v1/ha_signals') && method === 'POST') return jsonResponse([]);
    if(u.includes('/api/research-batch')){
      return jsonResponse({signals:[], diagnostics:{structuredSummary:{eligibleAccounts:2, processedAccounts:2, failedAccounts:0}}});
    }
    throw new Error(`Unhandled fetch in select-projection regression test mock: ${method} ${u}`);
  };

  const req = { method:'GET', headers:{host:'example.test', authorization:`Bearer ${TEST_CRON_SECRET}`}, query:{uploadId, dryRun:'true', limit:'25'} };
  const res = makeRes();
  try{
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
  }

  const staleCheckCall = getCalls.find(callUrl => !callUrl.includes('limit=1'));
  assert(!!staleCheckCall && staleCheckCall.includes('select=id,status,started_at,summary'), "weekly-scan.js's stale-run query requests `status` in its select= list — the exact fix for the defect that let the July 27 row survive settlement");
  assert(stuckRow === null, 'with the corrected projection, the stale row is actually settled — isStaleRun received a real status field this time and correctly identified it as stale, and the settlement PATCH fired');
  const entry = res.body?.runs?.[0];
  assert(!!entry && entry.skipped !== true, 'a fresh run is created and processed normally after settlement — this upload is NOT starved by the partial unique index, because the blocking row was actually cleared first');
  assert(res.statusCode === 200, 'the invocation completes with 200');
}

// ---------------------------------------------------------------------------
// research-batch non-JSON response diagnostic (follow-up investigation from
// the July 31 production failure: "Unexpected token 'A', "An error o"... is
// not valid JSON"). research-batch.js's own code always returns JSON (every
// return path, including its catch-all, uses res.status(...).json(...)), so
// a non-JSON body here is a platform-level failure page, not an application
// error. These tests confirm the diagnostic preserves status/content-type/
// x-vercel-id/body-preview instead of collapsing to an opaque JSON.parse
// SyntaxError, without changing any timeout, retry, batching, or lifecycle
// behavior.
// ---------------------------------------------------------------------------

function failureReasonFromFinalPatch(patchCalls){
  const finalPatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs') && p.body.status);
  return finalPatch?.body?.summary?.diagnostics?.chunks?.[0]?.structuredSummary?.failureReasons?.[0]?.reason;
}

{
  // Non-JSON 504 / plain-text response — the shape a Vercel function-
  // invocation timeout or crash actually returns.
  const { patchCalls, res } = await runHandlerScenario({
    researchBehavior: async () => textResponse('An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT', {
      status: 504,
      headers: { 'content-type': 'text/plain', 'x-vercel-id': 'iad1::abcde-1234567890' }
    })
  });
  const reason = failureReasonFromFinalPatch(patchCalls);
  assert(!!reason, 'a diagnostic failure reason is recorded for a non-JSON 504 response');
  assert(reason.includes('HTTP 504'), 'the diagnostic includes the real HTTP status, not just an opaque JSON.parse error');
  assert(reason.includes('content-type: text/plain'), 'the diagnostic includes the response content-type');
  assert(reason.includes('x-vercel-id: iad1::abcde-1234567890'), 'the diagnostic includes the x-vercel-id header when present');
  assert(reason.includes('An error occurred with your deployment') && reason.includes('FUNCTION_INVOCATION_TIMEOUT'), 'the diagnostic includes a readable body preview instead of a truncated JSON.parse SyntaxError message');
  const finalPatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs') && p.body.status);
  assert(finalPatch?.body?.status === 'failed', 'zero accounts processed due to a non-JSON response still ends the run as failed — a normal, explicit terminal state, not stuck running');
  assert(res.statusCode === 200, 'the weekly-scan invocation itself still returns 200 even though its one chunk failed');
}

{
  // Non-JSON response with a 200 status — proves the diagnostic path is
  // driven by "can this be parsed as JSON", not by the HTTP status code
  // alone (a platform error page can arrive with any status).
  const { patchCalls } = await runHandlerScenario({
    researchBehavior: async () => textResponse('<html><body>Service Unavailable</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })
  });
  const reason = failureReasonFromFinalPatch(patchCalls);
  assert(!!reason && reason.includes('HTTP 200'), 'a non-JSON body with a 200 status is still caught and diagnosed — success is never inferred from status code alone');
  assert(reason.includes('content-type: text/html'), 'the diagnostic reflects the actual content-type even when the status looked successful');
  assert(reason.includes('Service Unavailable'), 'the diagnostic includes the actual body content for a 200-status non-JSON response');
}

{
  // Body-prefix cap: a very long non-JSON body must be bounded to 300
  // characters in the diagnostic message, and any internal whitespace/
  // newlines collapsed to a single readable line.
  const longBody = `Error line one.\n\n${'x'.repeat(500)}`;
  const { patchCalls } = await runHandlerScenario({
    researchBehavior: async () => textResponse(longBody, { status: 500, headers: { 'content-type': 'text/plain' } })
  });
  const reason = failureReasonFromFinalPatch(patchCalls);
  assert(!!reason, 'a diagnostic reason is recorded for the long non-JSON body');
  const previewPart = reason.split('): ').slice(1).join('): ');
  assert(previewPart.length === 300, `the body preview embedded in the diagnostic is capped at exactly 300 characters (was ${previewPart.length})`);
  assert(!previewPart.includes('\n'), 'the body preview is normalized to a single line with no embedded newlines');
}

{
  // Valid JSON success is completely unchanged by the new .text()-then-parse
  // path.
  const { patchCalls, res } = await runHandlerScenario({ researchBehavior: successfulResearch() });
  const finalPatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs') && p.body.status);
  assert(finalPatch?.body?.status === 'complete', 'a valid JSON success response still results in a complete run, unchanged by the diagnostic rework');
  assert(res.statusCode === 200, 'the invocation still returns 200 for a valid JSON success response');
}

{
  // Valid JSON non-2xx response (a real research-batch application error,
  // e.g. its own res.status(500).json({error:...}) path) is unchanged: the
  // JSON.parse succeeds, and the existing `if(!researchResp.ok)` branch
  // still fires with the real error message — not the non-JSON diagnostic.
  const { patchCalls } = await runHandlerScenario({
    researchBehavior: async () => jsonResponse({ error: 'OPENAI_API_KEY not configured' }, false, 400)
  });
  const reason = failureReasonFromFinalPatch(patchCalls);
  assert(reason === 'OPENAI_API_KEY not configured', 'a valid-JSON non-2xx response still surfaces research-batch\'s own real error message verbatim, not the non-JSON diagnostic wrapper');
}

{
  // AbortError (a genuine caller-side timeout) must still short-circuit
  // before ever reaching the new text()/JSON.parse code — no "non-JSON"
  // diagnostic should ever be generated for a plain timeout.
  const { patchCalls } = await runHandlerScenario({
    researchBehavior: async () => { const err = new Error('simulated abort'); err.name = 'AbortError'; throw err; }
  });
  const reason = failureReasonFromFinalPatch(patchCalls);
  // fetchWithTimeout (pre-existing, unchanged by this fix) normalizes any
  // AbortError into this fixed message before it ever reaches the chunk's
  // own catch — so this, not the researchBehavior's original message, is
  // the correct unchanged behavior to assert against.
  assert(reason === `research-batch request exceeded ${RESEARCH_FETCH_TIMEOUT_MS}ms`, 'a genuine AbortError still surfaces fetchWithTimeout\'s own normalized message unchanged — the new non-JSON diagnostic path never fires for a timeout');
  assert(!reason.includes('non-JSON'), 'an AbortError is never mislabeled as a non-JSON response diagnostic');
  const finalPatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs') && p.body.status);
  assert(finalPatch?.body?.status === 'timed_out', 'sawTimeout/decideFinalStatus behavior for a genuine AbortError is unchanged: timed_out, not failed');
}

// ---------------------------------------------------------------------------
// Security hotfix: fail-closed CRON_SECRET / Authorization enforcement.
// (weekly-scan tests 1-6 of the required 18)
// ---------------------------------------------------------------------------

{
  // Pure-function sanity check on the comparison helper itself.
  assert(safeSecretEqual('abc123', 'abc123') === true, 'safeSecretEqual returns true for identical secrets');
  assert(safeSecretEqual('abc123', 'abc124') === false, 'safeSecretEqual returns false for equal-length but differing secrets');
  assert(safeSecretEqual('abc', 'abc123') === false, 'safeSecretEqual returns false for a length mismatch, without throwing');
  assert(safeSecretEqual('', 'abc123') === false, 'safeSecretEqual returns false for an empty provided value');
  assert(safeSecretEqual(undefined, 'abc123') === false, 'safeSecretEqual returns false for an undefined provided value, without throwing');
}

{
  // Hotfix test 1: missing CRON_SECRET -> 503, and the handler makes zero
  // downstream calls of any kind before reaching that check.
  let fetchCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async (...args) => { fetchCalls += 1; throw new Error(`unexpected fetch call while CRON_SECRET is unset: ${args[0]}`); };
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  delete process.env.CRON_SECRET;
  delete process.env.RESEND_API_KEY;
  const req = { method:'GET', headers:{host:'example.test'}, query:{limit:'25'} };
  const res = makeRes();
  try{ await handler(req, res); } finally { global.fetch = realFetch; }
  assert(res.statusCode === 503, 'a missing CRON_SECRET returns 503 immediately instead of silently skipping authorization (hotfix test 1)');
  assert(fetchCalls === 0, 'a missing CRON_SECRET results in zero Supabase/provider/research-batch requests (hotfix test 1)');
}

{
  // Hotfix test 2: CRON_SECRET is configured but no Authorization header is
  // sent -> 401, and research-batch is never reached.
  const { res } = await runHandlerScenario({
    authHeader: null,
    researchBehavior: async () => { throw new Error('research-batch should never be called for a missing Authorization header'); }
  });
  assert(res.statusCode === 401, 'a missing Authorization header returns 401 when CRON_SECRET is configured (hotfix test 2)');
}

{
  // Hotfix test 3: an Authorization header is present but carries the wrong
  // value -> 401, and research-batch is never reached.
  const { res } = await runHandlerScenario({
    authHeader: 'Bearer this-is-not-the-configured-secret',
    researchBehavior: async () => { throw new Error('research-batch should never be called for an incorrect Bearer token'); }
  });
  assert(res.statusCode === 401, 'an incorrect Bearer token returns 401 (hotfix test 3)');
}

{
  // Hotfix test 4: a correct Bearer token reaches normal orchestration
  // end-to-end (run creation, chunk processing, finalization) exactly as
  // before this hotfix.
  const { res, patchCalls } = await runHandlerScenario({ researchBehavior: successfulResearch() });
  const finalPatch = patchCalls.find(p => p.url.includes('/ha_weekly_runs') && p.body.status);
  assert(res.statusCode === 200, 'a correct Bearer token reaches normal orchestration and returns 200 (hotfix test 4)');
  assert(finalPatch?.body?.status === 'complete', 'a correct Bearer token allows the run to reach a normal completed status, unchanged by this hotfix (hotfix test 4)');
}

{
  // Hotfix test 5: the old ?secret=<correct> query-string fallback no longer
  // exists -- supplying the correct value there, with no Authorization
  // header, is still rejected.
  const { res } = await runHandlerScenario({
    authHeader: null,
    query: { secret: TEST_CRON_SECRET },
    researchBehavior: async () => { throw new Error('research-batch should never be called via the removed ?secret= fallback'); }
  });
  assert(res.statusCode === 401, 'the correct secret supplied via ?secret= (no Authorization header) is rejected -- the query-string fallback has been removed (hotfix test 5)');
}

{
  // Hotfix test 6: every rejection path (missing header, wrong token,
  // missing CRON_SECRET) performs literally zero downstream requests --
  // zero Supabase reads/writes, zero research-batch calls, zero provider
  // calls, zero Resend calls, zero ha_weekly_runs writes. A single fetch
  // spy that throws on any call proves this for all three cases at once,
  // since api/weekly-scan.js has no other way to reach a paid provider or
  // persist a run except through fetch()/its supabase() helper (which is
  // itself fetch-backed).
  const rejectionScenarios = [
    { label: 'missing Authorization header', cronSecretEnv: undefined, authHeader: null },
    { label: 'incorrect Bearer token', cronSecretEnv: undefined, authHeader: 'Bearer wrong-secret-value' },
    { label: 'missing CRON_SECRET', cronSecretEnv: null, authHeader: null }
  ];
  for (const scenario of rejectionScenarios) {
    let fetchCalls = 0;
    const realFetch = global.fetch;
    global.fetch = async (...args) => { fetchCalls += 1; throw new Error(`unexpected downstream call for a rejected request (${scenario.label}): ${args[0]}`); };
    process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
    if (scenario.cronSecretEnv === null) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = TEST_CRON_SECRET;
    delete process.env.RESEND_API_KEY;
    const headers = { host:'example.test' };
    if (scenario.authHeader !== null) headers.authorization = scenario.authHeader;
    const req = { method:'GET', headers, query:{limit:'25'} };
    const res = makeRes();
    try{ await handler(req, res); } finally { global.fetch = realFetch; }
    assert(fetchCalls === 0, `zero downstream requests (Supabase, research-batch, providers, Resend, ha_weekly_runs) are made for a rejected request: ${scenario.label} (hotfix test 6)`);
    assert(res.statusCode === 401 || res.statusCode === 503, `a rejected request (${scenario.label}) returns 401 or 503, never proceeds (hotfix test 6)`);
  }
}

// ---------------------------------------------------------------------------
// Paid-beta sprint Priority 6: weekly digest corrections (required tests
// 14-16). A custom fetch mock is used here rather than runHandlerScenario()
// since these scenarios need TWO uploads for the SAME user (a shape the
// shared single-upload mock doesn't model) and a real Resend mock (the
// shared mock deliberately unsets RESEND_API_KEY so sendEmail() short-
// circuits before ever calling fetch).
// ---------------------------------------------------------------------------

function twoUploadSameUserMock({ resendBehavior } = {}){
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  process.env.RESEND_API_KEY = 'fake-resend-key';
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE;

  const userId = 'user-digest-1';
  const uploadA = { id: 'upload-digest-a', user_id: userId, upload_name: 'List A', summary: {}, created_at: new Date().toISOString(), ha_users: { id: userId, email: 'rep@example.com', name: 'Rep One', company: '' } };
  const uploadB = { id: 'upload-digest-b', user_id: userId, upload_name: 'List B', summary: {}, created_at: new Date().toISOString(), ha_users: { id: userId, email: 'rep@example.com', name: 'Rep One', company: '' } };
  const accountsByUpload = {
    'upload-digest-a': [{ id: 'acct-a1', account_name: 'Alpha Co', industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    'upload-digest-b': [{ id: 'acct-b1', account_name: 'Beta Co', industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]
  };

  const emailCalls = [];
  const patchCalls = [];
  let runIdCounter = 0;

  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if (u.includes('/rest/v1/ha_uploads')) return jsonResponse([uploadA, uploadB]);
    if (u.includes('/rest/v1/ha_accounts')) {
      const match = u.match(/upload_id=eq\.([^&]+)/);
      const uploadId = match ? decodeURIComponent(match[1]) : '';
      return jsonResponse(accountsByUpload[uploadId] || []);
    }
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'GET') return jsonResponse([]); // nothing stale/active
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'POST') {
      runIdCounter += 1;
      const body = JSON.parse(options.body)[0];
      return jsonResponse([{ id: `run-${runIdCounter}`, ...body }]);
    }
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH') {
      const body = JSON.parse(options.body);
      patchCalls.push({ url: u, body });
      return jsonResponse([{ id: 'run-patched', ...body }]);
    }
    if (u.includes('/rest/v1/ha_signals') && method === 'POST') {
      // Real signals, one distinct row per upload's account, so the digest
      // aggregation step is proven to genuinely combine two DIFFERENT
      // result sets rather than coincidentally deduping identical ones.
      const rows = JSON.parse(options.body);
      return jsonResponse(rows);
    }
    if (u.includes('/api/research-batch')) {
      const body = JSON.parse(options.body);
      const accountName = body.accounts?.[0]?.name || 'Unknown';
      return jsonResponse({
        signals: [{
          accountName, signalType: 'Business Activity', signalTitle: `${accountName} business update`,
          whatChanged: `${accountName} had a business update`, whyItMattersForPromo: 'Timely reason to reach out',
          sourceUrl: `https://example.com/${accountName.toLowerCase().replace(/\s+/g, '-')}`, confidenceScore: 80,
          // Real research-batch responses always carry the AI-reported
          // publicationDate field (see the JSON schema researchers are
          // prompted with) -- an undated ongoing signal is correctly
          // digest-ineligible per the canonical actionability boundary, so
          // this fixture needs a real, recent date like production data
          // would have, not an artificially dateless one.
          publicationDate: new Date().toISOString()
        }],
        diagnostics: { structuredSummary: { eligibleAccounts: 1, processedAccounts: 1, failedAccounts: 0 } }
      });
    }
    if (u === 'https://api.resend.com/emails' && method === 'POST') {
      const body = JSON.parse(options.body);
      emailCalls.push(body);
      if (resendBehavior) return resendBehavior(body);
      return jsonResponse({ id: 'resend-id-1' });
    }
    throw new Error(`Unhandled fetch in digest test mock: ${method} ${u}`);
  };

  const req = { method: 'GET', headers: { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` }, query: { limit: '25' } };
  const res = makeRes();
  return { req, res, emailCalls, patchCalls, restoreFetch: () => { global.fetch = realFetch; } };
}

{
  // Hotfix/Priority 6 required test 14: one digest per user across multiple
  // uploads.
  const { req, res, emailCalls, restoreFetch } = twoUploadSameUserMock();
  try { await handler(req, res); } finally { restoreFetch(); }
  assert(res.statusCode === 200, 'the multi-upload-same-user invocation returns 200 (Priority 6 test 14)');
  assert(emailCalls.length === 1, `exactly one consolidated digest email is sent for a user with two uploads processed in the same invocation, not one email per upload (Priority 6 test 14; got ${emailCalls.length} email(s))`);
  if (emailCalls.length === 1) {
    assert(emailCalls[0].to === 'rep@example.com', 'the single digest email is addressed to the correct user (Priority 6 test 14)');
    assert(/2 new reasons/i.test(emailCalls[0].subject), `the consolidated digest subject reflects BOTH uploads' new signals combined, not just one upload's (Priority 6 test 14; got subject: "${emailCalls[0].subject}")`);
    assert(emailCalls[0].html.includes('Alpha Co') && emailCalls[0].html.includes('Beta Co'), 'the consolidated digest body includes signals from both uploads (Priority 6 test 14)');
  }
  assert(res.body?.digest?.length === 1 && res.body.digest[0].emailSent === true, 'the response reports exactly one successful digest entry for this user (Priority 6 test 14)');
}

{
  // Hotfix/Priority 6 required test 15: email failure does not fail
  // successful research.
  const { req, res, patchCalls, emailCalls, restoreFetch } = twoUploadSameUserMock({
    resendBehavior: () => jsonResponse({ message: 'Resend simulated outage' }, false, 502)
  });
  try { await handler(req, res); } finally { restoreFetch(); }
  assert(res.statusCode === 200, 'the invocation still returns 200 even though the digest email delivery failed (Priority 6 test 15)');
  const finalPatches = patchCalls.filter(p => p.body.status);
  assert(finalPatches.length === 2, 'both uploads still reach a final status PATCH despite the later email failure (Priority 6 test 15)');
  assert(finalPatches.every(p => p.body.status === 'complete'), `every upload's run status reflects its REAL research outcome (complete), never overwritten to 'failed' by the unrelated email failure (Priority 6 test 15; got: ${finalPatches.map(p => p.body.status).join(', ')})`);
  assert(emailCalls.length === 1, 'the email delivery was genuinely attempted once (Priority 6 test 15)');
  assert(res.body?.digest?.[0]?.emailSent === false && !!res.body?.digest?.[0]?.emailError, 'the response transparently reports the digest email failure without hiding it, while runs/status remain correct (Priority 6 test 15)');
}

{
  // Hotfix/Priority 6 required test 16: no email for zero new signals.
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  process.env.RESEND_API_KEY = 'fake-resend-key';
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE;

  const userId = 'user-digest-2';
  const uploadRow = { id: 'upload-digest-empty', user_id: userId, upload_name: 'Empty List', summary: {}, created_at: new Date().toISOString(), ha_users: { id: userId, email: 'quiet@example.com', name: 'Quiet Rep', company: '' } };
  const accounts = [{ id: 'acct-quiet-1', account_name: 'Quiet Co', industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  const emailCalls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if (u.includes('/rest/v1/ha_uploads')) return jsonResponse([uploadRow]);
    if (u.includes('/rest/v1/ha_accounts')) return jsonResponse(accounts);
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'GET') return jsonResponse([]);
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'POST') return jsonResponse([{ id: 'run-quiet-1', ...JSON.parse(options.body)[0] }]);
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH') return jsonResponse([{ id: 'run-patched', ...JSON.parse(options.body) }]);
    if (u.includes('/rest/v1/ha_signals') && method === 'POST') return jsonResponse([]); // zero new signals inserted
    if (u.includes('/api/research-batch')) return jsonResponse({ signals: [], diagnostics: { structuredSummary: { eligibleAccounts: 1, processedAccounts: 1, failedAccounts: 0 } } });
    if (u === 'https://api.resend.com/emails') { emailCalls.push(JSON.parse(options.body)); return jsonResponse({ id: 'should-not-be-called' }); }
    throw new Error(`Unhandled fetch in zero-signal digest test mock: ${method} ${u}`);
  };
  const req = { method: 'GET', headers: { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` }, query: { limit: '25' } };
  const res = makeRes();
  try { await handler(req, res); } finally { global.fetch = realFetch; }
  assert(res.statusCode === 200, 'a zero-new-signal invocation still returns 200 (Priority 6 test 16)');
  assert(emailCalls.length === 0, 'no digest email is sent when the user has zero new actionable signals this invocation (Priority 6 test 16)');
  assert(!res.body?.digest?.length, 'the response reports no digest entries for a user with zero new signals (Priority 6 test 16)');
}

// ---------------------------------------------------------------------------
// Reconciliation item 1/2 for the paid-beta sprint: a genuinely NEW signal
// that is retained/persisted (not discarded by makeSignal()'s actionability
// gate -- see api/research-batch.js) but is stale/undated/past the ongoing
// recency ceiling must still be excluded from weekly digest delivery, even
// though it counts as a real, newly-inserted ha_signals row.
// ---------------------------------------------------------------------------
{
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  process.env.RESEND_API_KEY = 'fake-resend-key';
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE;

  const userId = 'user-digest-3';
  const uploadRow = { id: 'upload-digest-stale', user_id: userId, upload_name: 'Stale Signal List', summary: {}, created_at: new Date().toISOString(), ha_users: { id: userId, email: 'stalerep@example.com', name: 'Stale Rep', company: '' } };
  const accounts = [{ id: 'acct-stale-1', account_name: 'Old Expo Co', industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  const emailCalls = [];
  const insertedRows = [];
  const patchCalls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if (u.includes('/rest/v1/ha_uploads')) return jsonResponse([uploadRow]);
    if (u.includes('/rest/v1/ha_accounts')) return jsonResponse(accounts);
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'GET') return jsonResponse([]);
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'POST') return jsonResponse([{ id: 'run-stale-1', ...JSON.parse(options.body)[0] }]);
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH') { patchCalls.push(JSON.parse(options.body)); return jsonResponse([{ id: 'run-patched', ...JSON.parse(options.body) }]); }
    if (u.includes('/rest/v1/ha_signals') && method === 'POST') {
      // The row genuinely gets persisted -- research/discovery succeeded and
      // the signal is retained for Research Details/account history -- it
      // is only excluded from the DIGEST, never from ha_signals itself.
      const rows = JSON.parse(options.body);
      insertedRows.push(...rows);
      return jsonResponse(rows);
    }
    if (u.includes('/api/research-batch')) {
      return jsonResponse({
        signals: [{
          accountName: 'Old Expo Co', signalType: 'Event', signalTitle: 'Old Expo Co exhibited at Trade Show 2023',
          whatChanged: 'Old Expo Co exhibited at Trade Show 2023', whyItMattersForPromo: 'Past event, no longer current',
          sourceUrl: 'https://example.com/old-expo-co-2023', confidenceScore: 85,
          eventCategory: 'event-like',
          actionabilityStatus: { status: 'stale', tense: 'past', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: false, label: 'Past event' }
        }],
        diagnostics: { structuredSummary: { eligibleAccounts: 1, processedAccounts: 1, failedAccounts: 0 } }
      });
    }
    if (u === 'https://api.resend.com/emails') { emailCalls.push(JSON.parse(options.body)); return jsonResponse({ id: 'should-not-be-called' }); }
    throw new Error(`Unhandled fetch in stale-signal digest test mock: ${method} ${u}`);
  };
  const req = { method: 'GET', headers: { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` }, query: { limit: '25' } };
  const res = makeRes();
  try { await handler(req, res); } finally { global.fetch = realFetch; }
  assert(res.statusCode === 200, 'reconciliation item 1/2: an invocation whose only new signal is non-priority-eligible still returns 200');
  assert(insertedRows.length === 1, 'reconciliation item 1/2: the stale/non-eligible signal IS genuinely persisted to ha_signals -- retained, not discarded');
  assert(insertedRows[0]?.payload?.actionabilityStatus?.isPriorityEligible === false, 'reconciliation item 1/2: the persisted row carries isPriorityEligible:false so downstream readers (dashboard, digest) can filter it');
  assert(patchCalls.some(p => p.status === 'complete'), 'reconciliation item 1/2: the research run still finalizes as complete -- persisting a non-eligible signal is not a failure');
  assert(emailCalls.length === 0, 'reconciliation item 1/2 (weekly digest delivery exclusion): no digest email is sent when the only new signal this invocation is not priority-eligible');
  assert(!res.body?.digest?.length, 'reconciliation item 1/2: the response reports no digest entries when the only new signal is non-eligible');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
