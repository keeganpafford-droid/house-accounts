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
  accumulateProgress, decideFinalStatus, FUNCTION_MAX_DURATION_MS, FINALIZE_RESERVE_MS
} from '../api/weekly-scan.js';
import { resolveOpportunityEvents, dedupeByEventFingerprint, normalizeOpportunity } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200){
  // api/weekly-scan.js's supabase() helper reads the body via .text() (then
  // JSON.parse()s it itself); the direct research-batch fetch reads .json()
  // directly. Support both so this one mock response works for either caller.
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
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

async function runHandlerScenario({ researchBehavior, weeklyRunsPatchBehavior, priorRunningRows = [] }){
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  delete process.env.CRON_SECRET;
  delete process.env.RESEND_API_KEY; // sendEmail short-circuits without this
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE; // use the new default (5)

  const patchCalls = [];
  const userId = 'user-1', uploadId = 'upload-1';
  const accounts = Array.from({length:10}, (_, i) => ({
    id:`acct-${i+1}`, account_name:`Account ${i+1}`, industry:'', contact_name:'', contact_email:'',
    metrics:{}, raw_data:{}, created_at:new Date().toISOString(), updated_at:new Date().toISOString()
  }));
  let runIdCounter = 0;
  let staleRowsServed = false;

  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';

    if(u.includes('/rest/v1/ha_uploads') && method === 'GET'){
      return jsonResponse([{ id: uploadId, user_id:userId, upload_name:'Test List', summary:{}, created_at:new Date().toISOString(), ha_users:{id:userId, email:'test@example.com', name:'Test User', company:''} }]);
    }
    if(u.includes('/rest/v1/ha_accounts')){
      return jsonResponse(accounts);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'GET'){
      // Serve the stale-run rows exactly once (the stale-check query), then
      // an empty list, so we don't loop forever finding the same rows.
      if(!staleRowsServed){ staleRowsServed = true; return jsonResponse(priorRunningRows); }
      return jsonResponse([]);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'POST'){
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

  const req = { method:'GET', headers:{host:'example.test'}, query:{limit:'25'} };
  const res = makeRes();
  try{
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
  }
  return { res, patchCalls };
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

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
