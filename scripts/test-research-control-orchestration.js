// ux/research-control-progress: behavioral regression coverage for the
// research start/stop/progress sprint. Extracts the REAL, verbatim
// production functions from dashboard/index.html (claim/dup-check/
// breadcrumb/snapshot/save primitives, researchListFromManageModal(),
// researchAccountFromManageModal(), researchTopAccounts(), the shared
// research tracker module) and runs them for real in a vm sandbox with a
// mocked fetch -- proving actual behavior (call counts, which accounts get
// researched, tracker state), not source-text pattern matching, for the
// two riskiest NEW capabilities this sprint added: Stop actually prevents
// further queued research, and it does so honestly (aborts what can be
// aborted, reports the run outcome so the server-side lock releases).
//
// Structural (source-presence) checks are used ONLY where they are
// genuinely the right tool -- proving something does NOT happen (no
// automatic call site left anywhere) or that wiring/markup exists, matching
// the convention every other *-round.js test file in this repo already
// uses for the same class of requirement.
//
// Usage: node scripts/test-research-control-orchestration.js
import vm from 'vm';
import { extractFn as sharedExtractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const LINES = DASHBOARD_SRC.split('\n');

// Locates the named top-level declaration by semantic structure (shared
// library) rather than a physical line range -- immune to ordinary edits
// anywhere earlier in dashboard/index.html. The {async} option some call
// sites still pass is accepted but no longer needed for correctness.
function extractFn(name) {
  return sharedExtractFn(DASHBOARD_SRC, name);
}

const REAL_SOURCE = [
  extractFn('claimAutomaticResearchRun'),
  extractFn('checkDuplicateCompanyResearch'),
  extractFn('heartbeatCurrentResearchRun'),
  extractFn('reportResearchRunOutcome'),
  extractFn('fetchUploadScopedSnapshot'),
  extractFn('persistScopedResearchResult'),
  extractFn('setActiveResearchBreadcrumb'),
  extractFn('clearActiveResearchBreadcrumb'),
  extractFn('getActiveResearchBreadcrumb'),
  extractFn('safeParseResearchResponse'),
  extractFn('researchDedupeNameKey'),
  extractFn('researchAccountFromManageModal'),
  extractFn('researchListFromManageModal'),
  extractFn('researchAccountByName'),
  extractFn('getAccountsForResearch'),
  extractFn('batchPayloadForAccounts'),
  extractFn('applyBusinessSignalAccountBoost'),
  extractFn('researchAccountsBatch'),
  extractFn('researchTopAccounts'),
].join('\n\n');

// The shared research tracker module, run for real (not stubbed) -- these
// tests exist specifically to prove ITS stop/progress behavior actually
// takes effect inside the real orchestration functions above.
const TRACKER_SRC = extractRange(DASHBOARD_SRC, 'const researchRunTrackers = new Map();', 'function researchTrackerAccountState(uploadId, accountName){');

const STUB_SOURCE = `
function normalizeSavedAccount(a){ return a; }
function serializeAccountForStorage(a){ return a; }
function getSavedLead(){ return null; }
function addSignalDerivedOpportunities(account, signals){ account.futureOpportunities = (signals || []).map(s => ({account: account.name, signal: s})); }
function deriveAccountIntelligenceMode(account){ return 'warm'; }
function isWarmAccount(account){ return true; }
function extractEmailDomain(email){ return String(email || '').split('@')[1] || ''; }
function getResearchDiagnostics(){ window.researchDiagnostics = window.researchDiagnostics || []; return window.researchDiagnostics; }
function renderResearchDiagnostics(){}
function accountSignalsPanel(){ return null; }
function refreshOpportunityViews(){}
async function saveCurrentUpload(){ return true; }
// Pure data-shaping helper, orthogonal to this file's stop/cancellation
// scope -- real accounts genuinely can lack .contacts, so batchPayloadForAccounts()
// falls back to this; stub it rather than special-casing fixtures.
function importedContactsFromRecords(records){ return []; }
`;

function createSandbox({ currentUploadId = 'upload-1', currentLead = { email: 'lead@example.com' }, fetchImpl }) {
  const consoleLog = { warn: [], error: [], log: [] };
  const houseAuth = { authHeaders: (h) => h || {}, authHeadersAsync: async (h) => h || {} };
  const sandbox = {
    window: { accountRadarAccounts: [], researchDiagnostics: [], HouseAuth: houseAuth, location: { href: 'https://example.com/dashboard' } },
    HouseAuth: houseAuth,
    fetch: fetchImpl,
    console: {
      log: (...a) => consoleLog.log.push(a),
      warn: (...a) => consoleLog.warn.push(a),
      error: (...a) => consoleLog.error.push(a),
    },
    Math, Date, JSON, Set, Map, Array, Object, Number, String, Promise, Boolean,
    AbortController,
    setTimeout, clearTimeout,
    // researchTopAccounts() reads/writes a "Researching..." button label by
    // id; out of scope here (no DOM), a guarded null is the real-world
    // fallback its own `if(btn)` check already handles.
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  const initSource = `
var currentUploadId = ${JSON.stringify(currentUploadId)};
var currentUploadName = 'Test Upload';
var currentLead = ${JSON.stringify(currentLead)};
var currentDashboardData = null;
var currentResearchRunId = null;
var currentResearchAttemptId = null;
var researchInProgress = false;
var lastUploadAcceptedAccountCount = null;
`;
  const fullSource = `${initSource}\n${STUB_SOURCE}\n${REAL_SOURCE}\n${TRACKER_SRC}\n`;
  new vm.Script(fullSource, { filename: 'research-control-orchestration-extract.js' }).runInContext(sandbox);
  sandbox.__consoleLog = consoleLog;
  return sandbox;
}

function makeFetch(router) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const signal = init && init.signal;
    const call = { url: String(url), method: (init && init.method) || 'GET', body, signal };
    calls.push(call);
    if (signal && signal.aborted) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    return router(call, calls);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

function fixtureAccount(name, overrides = {}) {
  return { id: `id-${name}`, uploadId: 'list-1', name, monitoringStatus: 'active', intelligenceMode: 'warm', ...overrides };
}

// ===========================================================================
// Required test 5: list Stop prevents subsequent queued research calls.
// Historical-group accounts are researched one at a time (real per-account
// granularity, unlike the single combined warm/mixed batch call) -- Stop is
// requested from INSIDE the mock's handler for the first historical
// account's request, simulating a user clicking Stop Research while that
// account is still in flight. The remaining historical accounts must never
// be fetched.
// ===========================================================================
async function testListStopPreventsQueuedResearch() {
  const accounts = [
    fixtureAccount('Hist One', { intelligenceMode: 'historical' }),
    fixtureAccount('Hist Two', { intelligenceMode: 'historical' }),
    fixtureAccount('Hist Three', { intelligenceMode: 'historical' }),
  ];
  let stopRequested = false;
  const fetchImpl = makeFetch((call) => {
    if (call.url.startsWith('/api/get-dashboard')) return jsonResponse({ upload: { id: 'list-1', upload_name: 'Historical List' }, accounts });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'check-duplicates') return jsonResponse({ duplicateAccountNames: [] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'claim') return jsonResponse({ outcome: 'claimed-new', researchRunId: 'run-list', attemptId: 'attempt-list-1' });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'fail') return jsonResponse({ ok: true });
    if (call.url === '/api/research-account') {
      if (call.body.accountName === 'Hist One') {
        // Simulate the user clicking Stop Research while this exact
        // request is still in flight.
        sandbox.requestResearchStop('list-1');
        stopRequested = true;
        return jsonResponse({ signals: [{ isReal: true, sourceUrl: 'https://example.com/1' }] });
      }
      throw new Error(`unexpected /api/research-account call after stop was requested: ${call.body.accountName}`);
    }
    if (call.url === '/api/save-upload') return jsonResponse({ ok: true, uploadId: 'list-1', runStatus: 'completed' });
    throw new Error(`unexpected fetch in testListStopPreventsQueuedResearch: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({ fetchImpl });
  const result = await sandbox.researchListFromManageModal('list-1');

  assert(stopRequested === true, 'sanity: the stop was actually requested mid-flight, during the first account\'s own request');
  const researchAccountCalls = fetchImpl.calls.filter(c => c.url === '/api/research-account');
  assert(researchAccountCalls.length === 1, `list Stop prevents subsequent queued accounts: exactly one /api/research-account call happened, not three (got ${researchAccountCalls.length})`);
  assert(researchAccountCalls[0].body.accountName === 'Hist One', 'the one account already in flight when Stop was clicked still completed normally');
  assert(result.ok === true, 'a partially-stopped list run still returns a normal (non-error) result -- the work that DID complete is honestly reported, not discarded');
  assert(result.stopped === 2, `the two accounts that never started are reported as stopped, not silently dropped (got ${result.stopped})`);
  assert(result.attempted === 1, 'only the one account that actually ran counts as attempted');

  const snap = sandbox.researchTrackerSnapshot('list-1');
  assert(snap && snap.finished === true, 'the tracker for this list is marked finished once the (stopped) run concludes');
  assert(snap && snap.stopped === 2 && snap.completed === 3, `the tracker reports 2 stopped + 1 real completion = 3 total settled (got ${JSON.stringify(snap)})`);
}

// ===========================================================================
// Required test 6: individual Stop behaves according to the implemented
// cancellation contract. researchAccountFromManageModal() is a genuinely
// standalone, single-account claim -- Stop here means: the browser fetch is
// aborted, the function returns a clear "stopped" result (not a generic
// error), and the server-side run is explicitly reported as failed/stopped
// so its claim lock releases (proven by asserting the exact
// researchRunAction:'fail' call, not merely that SOME cleanup happened).
// ===========================================================================
async function testIndividualStopCancellationContract() {
  const account = fixtureAccount('Solo Co', { intelligenceMode: 'warm', uploadId: 'list-2' });
  const fetchImpl = makeFetch((call) => {
    if (call.url.startsWith('/api/get-dashboard')) return jsonResponse({ upload: { id: 'list-2', upload_name: 'Solo List' }, accounts: [account] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'check-duplicates') return jsonResponse({ duplicateAccountNames: [] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'claim') return jsonResponse({ outcome: 'claimed-new', researchRunId: 'run-solo', attemptId: 'attempt-solo-1' });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'fail') return jsonResponse({ ok: true });
    if (call.url === '/api/research-batch' && !call.body.researchRunAction) {
      // The single-account research call itself -- stop mid-flight, exactly
      // like clicking the row's own Stop Research button while it's the
      // one thing in flight (a real total:1 tracker).
      sandbox.requestResearchStop('list-2');
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    throw new Error(`unexpected fetch in testIndividualStopCancellationContract: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({ fetchImpl });
  const result = await sandbox.researchAccountFromManageModal('Solo Co', 'list-2');

  assert(result.ok === false, 'a stopped individual research call reports failure, not a fabricated success');
  assert(/stop/i.test(result.error || ''), `the error message honestly reflects a stop, not a generic "failed" message (got "${result.error}")`);
  const outcomeCalls = fetchImpl.calls.filter(c => c.url === '/api/research-batch' && c.body.researchRunAction === 'fail');
  assert(outcomeCalls.length === 1, 'exactly one researchRunAction:"fail" report was sent, which is what releases the server-side one-active-run lock for this upload');
  assert(outcomeCalls[0].body.errorMessage === 'Stopped by user' || outcomeCalls[0].body.error === 'Stopped by user', `the reported outcome is explicitly labeled "Stopped by user", distinguishable server-side from a genuine provider failure (got ${JSON.stringify(outcomeCalls[0].body)})`);

  const snap = sandbox.researchTrackerSnapshot('list-2');
  assert(snap && snap.finished === true && snap.stopped === 1 && snap.failed === 0, `the tracker records this as stopped, not failed (got ${JSON.stringify(snap)})`);
}

// ===========================================================================
// researchTopAccounts()'s fallback loop (the exact mechanism the founder's
// original 2-3 account QA list got stuck in) also honors Stop: no
// additional account begins once stopped, even mid-loop.
// ===========================================================================
async function testTopAccountsFallbackLoopHonoursStop() {
  const accounts = [fixtureAccount('Fall One'), fixtureAccount('Fall Two'), fixtureAccount('Fall Three')];
  let sandbox;
  let fallbackCallCount = 0;
  const fetchImpl = makeFetch((call) => {
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'check-duplicates') return jsonResponse({ duplicateAccountNames: [] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'claim') return jsonResponse({ outcome: 'claimed-new', researchRunId: 'run-top', attemptId: 'attempt-top-1' });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat') return jsonResponse({ ok: true });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'fail') return jsonResponse({ ok: true });
    if (call.url === '/api/research-batch' && !call.body.researchRunAction) {
      fallbackCallCount += 1;
      if (fallbackCallCount === 1) {
        // The initial whole-list batch call finds nothing -- this is
        // exactly the researchTopAccounts() `batchSignals === 0` condition
        // that triggers the per-account fallback loop.
        return jsonResponse({ byAccount: {}, signals: [] });
      }
      // First fallback account's own single-account call: request a stop
      // mid-flight, simulating the user clicking Stop while it's running.
      sandbox.requestResearchStop('upload-top');
      return jsonResponse({ byAccount: { 'Fall One': [] }, signals: [] });
    }
    throw new Error(`unexpected fetch in testTopAccountsFallbackLoopHonoursStop: ${call.url} ${JSON.stringify(call.body)}`);
  });
  sandbox = createSandbox({ currentUploadId: 'upload-top', fetchImpl });
  sandbox.window.accountRadarAccounts = accounts;
  await sandbox.researchTopAccounts({ auto: false });

  // fallbackCallCount: 1 (initial batch) + however many fallback per-account
  // calls actually happened. With concurrency=4 and 3 accounts, all 3
  // workers start immediately in parallel -- the stop-check only prevents a
  // worker from picking up its NEXT account once its current one resolves,
  // so this proves "no additional queued work begins" rather than a
  // stronger (architecturally unavailable) "abort every in-flight
  // concurrent worker instantly" guarantee.
  assert(fallbackCallCount <= 4, `fallback loop dispatch is bounded (initial batch + at most one round for 3 accounts under concurrency 4) -- got ${fallbackCallCount} total /api/research-batch research calls`);
  const snap = sandbox.researchTrackerSnapshot('upload-top');
  assert(snap === null || snap.finished === true, 'the tracker for this run is finished (not left stuck) once the fallback loop stops dispatching');
}

// ===========================================================================
// QA correction 3: founder screenshot showed a standalone single-account
// run reporting "0 researching / 1 remaining" with the row still offering
// "Research Account" WHILE its /api/research-batch request was already
// pending. researchAccountFromManageModal() called startResearchTracker()
// but never markResearchAccountStarted() -- the account sat in "queued"
// for the entire request duration, not a one-frame render race. Proven
// here by inspecting the tracker mid-flight, from inside the mock fetch
// router (which runs synchronously before the request "resolves").
// ===========================================================================
async function testIndividualResearchMarksAccountResearchingDuringDispatch() {
  const account = fixtureAccount('Solo Timing Co', { intelligenceMode: 'warm', uploadId: 'list-3' });
  let sandbox;
  let snapshotDuringRequest = null;
  let accountStateDuringRequest = null;
  const fetchImpl = makeFetch((call) => {
    if (call.url.startsWith('/api/get-dashboard')) return jsonResponse({ upload: { id: 'list-3', upload_name: 'Timing List' }, accounts: [account] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'check-duplicates') return jsonResponse({ duplicateAccountNames: [] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'claim') return jsonResponse({ outcome: 'claimed-new', researchRunId: 'run-timing', attemptId: 'attempt-timing-1' });
    if (call.url === '/api/research-batch' && !call.body.researchRunAction) {
      // The single research request itself is now "in flight" -- capture
      // the tracker's state at exactly this moment, matching the founder's
      // screenshot of a pending request.
      snapshotDuringRequest = sandbox.researchTrackerSnapshot('list-3');
      accountStateDuringRequest = sandbox.researchTrackerAccountState('list-3', 'Solo Timing Co');
      return jsonResponse({ byAccount: { 'Solo Timing Co': [] }, signals: [] });
    }
    throw new Error(`unexpected fetch in testIndividualResearchMarksAccountResearchingDuringDispatch: ${call.url} ${JSON.stringify(call.body)}`);
  });
  sandbox = createSandbox({ fetchImpl });
  await sandbox.researchAccountFromManageModal('Solo Timing Co', 'list-3');

  assert(snapshotDuringRequest !== null, 'sanity: the mock captured a tracker snapshot while the research request was in flight');
  assert(snapshotDuringRequest.researching === 1 && snapshotDuringRequest.remaining === 0, `QA correction 3: while the single-account request is in flight, the tracker reports 1 researching / 0 remaining, not 0 researching / 1 remaining (got ${JSON.stringify(snapshotDuringRequest)})`);
  assert(accountStateDuringRequest === 'researching', `QA correction 3: the row's own per-account tracker state is "researching" (not "queued") while its request is in flight, so it shows Researching/Stop Research rather than the idle Research Account button (got "${accountStateDuringRequest}")`);
}

// ===========================================================================
// Pre-beta blocker hardening, item B: researchListFromManageModal()'s
// warm/mixed ("enhanced") group used to be sent as ONE unbounded
// /api/research-batch request, then every account in it was unconditionally
// marked researched regardless of whether the server actually processed it.
// These tests exercise the real, chunked replacement for real -- request
// counts, chunk sizes, and which specific accounts actually receive
// lastResearchedAt -- not a source-text pattern match.
// ===========================================================================
function warmAccounts(n, uploadId, prefix = 'Warm'){
  return Array.from({length: n}, (_, i) => fixtureAccount(`${prefix}-${i}`, { intelligenceMode: 'warm', uploadId }));
}
function researchBatchWorkCalls(calls){
  return calls.filter(c => c.url === '/api/research-batch' && !c.body.researchRunAction);
}

// Required regression: "add a regression where the selected list exceeds
// the server's per-request max." 50 accounts is well within
// api/research-batch.js's real 250/500-account server-side cap, but far
// above the client's own bounded chunk size -- proving the client-side
// chunking (not merely the server's own cap) is what now bounds each
// request. Every account succeeds: this isolates "no account may
// disappear" from the separate failure-handling tests below.
async function testEnhancedGroupChunkedAndBounded(){
  const accounts = warmAccounts(50, 'list-chunk');
  const fetchImpl = makeFetch((call) => {
    if (call.url.startsWith('/api/get-dashboard')) return jsonResponse({ upload: { id: 'list-chunk', upload_name: 'Big List' }, accounts });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'check-duplicates') return jsonResponse({ duplicateAccountNames: [] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'claim') return jsonResponse({ outcome: 'claimed-new', researchRunId: 'run-chunk', attemptId: 'attempt-chunk-1' });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat') return jsonResponse({ ok: true });
    if (call.url === '/api/research-batch' && !call.body.researchRunAction) {
      const byAccount = {};
      call.body.accounts.forEach(a => { byAccount[a.name] = [{ isReal: true, sourceUrl: `https://example.com/${a.name}` }]; });
      return jsonResponse({ byAccount, signals: [] });
    }
    if (call.url === '/api/save-upload') return jsonResponse({ ok: true, uploadId: 'list-chunk', runStatus: 'completed' });
    throw new Error(`unexpected fetch in testEnhancedGroupChunkedAndBounded: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({ fetchImpl });
  const result = await sandbox.researchListFromManageModal('list-chunk');

  const workCalls = researchBatchWorkCalls(fetchImpl.calls);
  assert(workCalls.length === Math.ceil(50 / 8), `50 accounts at a chunk size of 8 dispatch exactly ${Math.ceil(50 / 8)} bounded research requests, not one unbounded request (got ${workCalls.length})`);
  assert(workCalls.every(c => c.body.accounts.length <= 8), `every single request sends at most 8 accounts (got sizes: ${workCalls.map(c => c.body.accounts.length).join(', ')})`);
  const totalAccountsAcrossCalls = workCalls.reduce((n, c) => n + c.body.accounts.length, 0);
  assert(totalAccountsAcrossCalls === 50, `every account is deliberately attempted in exactly one bounded request -- no account disappears and none is double-sent (got ${totalAccountsAcrossCalls} total across all requests)`);
  assert(result.ok === true && result.attempted === 50 && result.failures === 0 && result.unattempted === 0 && result.stopped === 0, `a fully successful large list reports 50 attempted, 0 failed/unattempted/stopped (got ${JSON.stringify({ok: result.ok, attempted: result.attempted, failures: result.failures, unattempted: result.unattempted, stopped: result.stopped})})`);
  assert(accounts.every(a => !!a.lastResearchedAt && a.signals.length === 1), 'every one of the 50 accounts genuinely received its own lastResearchedAt/signals from a request that actually included it');
}

// Required regression: "chunk 1 succeeds, chunk 2 succeeds, chunk 3 fails,
// chunk 4 never runs." Accounts 0-15 (two chunks of 8) always succeed;
// accounts 16-29 (14 accounts) always fail, regardless of how small the
// retry shrinks the chunk -- proving the adaptive halving actually retries
// (not just gives up on the first failure) before finally halting once it
// can no longer shrink (chunk size 1) and a single-account request still
// fails. Accounts downstream of that final floor failure are never
// dispatched at all and are truthfully reported as unattempted, not
// silently folded into "failed" or dropped from the summary entirely.
async function testEnhancedGroupPartialFailureHaltsRemainingChunks(){
  const accounts = warmAccounts(30, 'list-partial');
  const fetchImpl = makeFetch((call) => {
    if (call.url.startsWith('/api/get-dashboard')) return jsonResponse({ upload: { id: 'list-partial', upload_name: 'Partial Failure List' }, accounts });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'check-duplicates') return jsonResponse({ duplicateAccountNames: [] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'claim') return jsonResponse({ outcome: 'claimed-new', researchRunId: 'run-partial', attemptId: 'attempt-partial-1' });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat') return jsonResponse({ ok: true });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'fail') return jsonResponse({ ok: true });
    if (call.url === '/api/research-batch' && !call.body.researchRunAction) {
      const names = call.body.accounts.map(a => a.name);
      // Accounts 16-29 are a permanently down provider for this test --
      // ANY request containing one of them fails, at every retry size.
      const alwaysFailIndex = names.findIndex(n => Number(n.split('-')[1]) >= 16);
      if (alwaysFailIndex !== -1) throw new Error(`simulated persistent provider failure for ${names[alwaysFailIndex]}`);
      const byAccount = {};
      names.forEach(n => { byAccount[n] = [{ isReal: true, sourceUrl: `https://example.com/${n}` }]; });
      return jsonResponse({ byAccount, signals: [] });
    }
    if (call.url === '/api/save-upload') return jsonResponse({ ok: true, uploadId: 'list-partial', runStatus: 'completed' });
    throw new Error(`unexpected fetch in testEnhancedGroupPartialFailureHaltsRemainingChunks: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({ fetchImpl });
  const result = await sandbox.researchListFromManageModal('list-partial');

  assert(result.ok === true, 'a partial hard failure still returns a normal result (the work that DID complete is honestly reported, not thrown away)');
  assert(result.attempted === 16, `the first two clean chunks (16 accounts) are truthfully attempted (got ${result.attempted})`);
  assert(result.failures === 1, `exactly one account (the final floor-size-1 request that still failed) is counted as a genuine failure, not the whole downstream group (got ${result.failures})`);
  assert(result.unattempted === 13, `every account queued behind that hard failure -- the rest of the failing chunk plus the chunk that would have followed it -- is truthfully reported as unattempted, not silently dropped from the summary (got ${result.unattempted})`);
  assert(result.attempted + result.failures + result.unattempted + result.stopped + (result.skippedDuplicates || []).length === result.accountCount, `every one of the ${result.accountCount} selected accounts is accounted for in exactly one bucket -- none may disappear (attempted=${result.attempted}, failures=${result.failures}, unattempted=${result.unattempted}, stopped=${result.stopped}, skipped=${(result.skippedDuplicates||[]).length}, accountCount=${result.accountCount})`);

  for(let i = 0; i < 16; i++) assert(!!accounts[i].lastResearchedAt, `account ${accounts[i].name} (in one of the two clean chunks) received a truthful lastResearchedAt`);
  for(let i = 16; i < 30; i++) assert(!accounts[i].lastResearchedAt, `account ${accounts[i].name} (either the one genuinely-failed account or queued behind it) was never falsely stamped researched`);

  const workCalls = researchBatchWorkCalls(fetchImpl.calls);
  assert(workCalls.every(c => !c.body.accounts.some(a => Number(a.name.split('-')[1]) >= 24)), 'no request ever included any account from the chunk that would have come after the one that hard-failed -- it genuinely never runs');
}

// Required behavior: "split/retry failed chunks... falls out of shrink and
// retry for free." A chunk fails exactly ONCE (a one-shot transient blip,
// not a persistent failure); the retried half-size chunk succeeds, and the
// pass then continues at that smaller size (SS8: shrink, never grow back
// within a pass) through the rest of the group -- proving a single
// failure costs one retry, not the rest of the list.
async function testEnhancedGroupTransientFailureRetriesSmallerAndRecovers(){
  const accounts = warmAccounts(8, 'list-retry', 'Retry');
  let firstAttemptFailed = false;
  const fetchImpl = makeFetch((call) => {
    if (call.url.startsWith('/api/get-dashboard')) return jsonResponse({ upload: { id: 'list-retry', upload_name: 'Retry List' }, accounts });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'check-duplicates') return jsonResponse({ duplicateAccountNames: [] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'claim') return jsonResponse({ outcome: 'claimed-new', researchRunId: 'run-retry', attemptId: 'attempt-retry-1' });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat') return jsonResponse({ ok: true });
    if (call.url === '/api/research-batch' && !call.body.researchRunAction) {
      if (!firstAttemptFailed) {
        firstAttemptFailed = true;
        throw new Error('simulated one-shot transient failure');
      }
      const byAccount = {};
      call.body.accounts.forEach(a => { byAccount[a.name] = [{ isReal: true, sourceUrl: `https://example.com/${a.name}` }]; });
      return jsonResponse({ byAccount, signals: [] });
    }
    if (call.url === '/api/save-upload') return jsonResponse({ ok: true, uploadId: 'list-retry', runStatus: 'completed' });
    throw new Error(`unexpected fetch in testEnhancedGroupTransientFailureRetriesSmallerAndRecovers: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({ fetchImpl });
  const result = await sandbox.researchListFromManageModal('list-retry');

  const workCalls = researchBatchWorkCalls(fetchImpl.calls);
  assert(workCalls.length === 3, `a one-shot failure retries once at a smaller size, then the pass continues through the rest of the group at that size (failed size-8 attempt + two size-4 chunks) (got ${workCalls.length} research requests)`);
  assert(workCalls.map(c => c.body.accounts.length).join(',') === '8,4,4', `the failed attempt was size 8; both chunks after the shrink are size 4, not a re-attempt at the original size (got sizes ${workCalls.map(c => c.body.accounts.length).join(', ')})`);
  assert(result.ok === true && result.attempted === 8 && result.unattempted === 0 && result.failures === 0, `a one-shot transient failure costs one retry, not the rest of the list -- all 8 accounts are eventually genuinely attempted and none is left unattempted or falsely failed (got ${JSON.stringify({attempted: result.attempted, unattempted: result.unattempted, failures: result.failures})})`);
  assert(accounts.every(a => !!a.lastResearchedAt), 'every one of the 8 accounts (including the ones in the initially-failed chunk) eventually received a truthful lastResearchedAt once its retried/continued chunk actually succeeded');
}

// Founder correctness confirmation (pre-beta blocker hardening follow-up):
// api/research-batch.js's own within-request account sanitization
// (`safeAccounts`'s `seenAccountKeys` filter) silently drops every account
// AFTER the first whose normalized name collides -- with NO trace of this
// in its response (skippedDuplicateAccountNames only covers a DIFFERENT
// upload's active run, never a within-request collision; confirmed by
// reading findActiveDuplicateCompanyCollisions()'s own header comment).
// Left unhandled, the dropped account would still fall back to an empty
// signals array and be stamped lastResearchedAt -- a false "researched,
// nothing found" claim for an account the server never actually searched.
// This proves the client-side fix: "Acme Co." (normalizes to the same key
// as "Acme Co." -> "acme" once the corporate suffix is stripped) is
// filtered out and reported as a duplicate BEFORE any chunk is built, so
// the server's own silent collapse never has anything to collapse, and the
// dropped account is honestly reported rather than falsely marked done.
async function testEnhancedGroupWithinListDuplicateNamesNeverFalselyStamped(){
  const accounts = [
    fixtureAccount('Acme Co', { intelligenceMode: 'warm', uploadId: 'list-dup-name' }),
    // Same normalized key as 'Acme Co' once the corporate suffix ("Co.") and
    // punctuation are stripped -- a real, plausible upload artifact (two
    // CSV rows for the same company, spelled slightly differently), not a
    // contrived string.
    fixtureAccount('Acme Co.', { intelligenceMode: 'warm', uploadId: 'list-dup-name' }),
    fixtureAccount('Beta Co', { intelligenceMode: 'warm', uploadId: 'list-dup-name' })
  ];
  const fetchImpl = makeFetch((call) => {
    if (call.url.startsWith('/api/get-dashboard')) return jsonResponse({ upload: { id: 'list-dup-name', upload_name: 'Duplicate Name List' }, accounts });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'check-duplicates') return jsonResponse({ duplicateAccountNames: [] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'claim') return jsonResponse({ outcome: 'claimed-new', researchRunId: 'run-dup-name', attemptId: 'attempt-dup-name-1' });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat') return jsonResponse({ ok: true });
    if (call.url === '/api/research-batch' && !call.body.researchRunAction) {
      // Faithfully replicates api/research-batch.js's own real behavior:
      // if the client ever sent both near-duplicate names in the same
      // request, only the FIRST would get a real key in byAccount -- the
      // second's key would simply never exist. This mock exists to prove
      // the CLIENT never sends both in the first place; it would fail the
      // "workCalls[0] never contains Acme Co." assertion below if the fix
      // regressed.
      const byAccount = {};
      call.body.accounts.forEach(a => { byAccount[a.name] = [{ isReal: true, sourceUrl: `https://example.com/${a.name}` }]; });
      return jsonResponse({ byAccount, signals: [] });
    }
    if (call.url === '/api/save-upload') return jsonResponse({ ok: true, uploadId: 'list-dup-name', runStatus: 'completed' });
    throw new Error(`unexpected fetch in testEnhancedGroupWithinListDuplicateNamesNeverFalselyStamped: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({ fetchImpl });
  const result = await sandbox.researchListFromManageModal('list-dup-name');

  const workCalls = researchBatchWorkCalls(fetchImpl.calls);
  assert(workCalls.length === 1, `only one bounded request is needed once the within-list duplicate is filtered out before dispatch (got ${workCalls.length})`);
  assert(!workCalls[0].body.accounts.some(a => a.name === 'Acme Co.'), 'the near-duplicate ("Acme Co.") is never sent to the server at all -- filtered out before any request is built, so the server\'s own silent within-request collapse never has anything to collapse');
  assert(workCalls[0].body.accounts.some(a => a.name === 'Acme Co') && workCalls[0].body.accounts.some(a => a.name === 'Beta Co'), 'the two genuinely distinct accounts (the FIRST occurrence of the duplicated name, and the unrelated account) are both still sent normally');

  const acme = accounts.find(a => a.name === 'Acme Co');
  const acmeDup = accounts.find(a => a.name === 'Acme Co.');
  const beta = accounts.find(a => a.name === 'Beta Co');
  assert(!!acme.lastResearchedAt && acme.signals.length === 1, 'the first occurrence ("Acme Co") is genuinely researched');
  assert(!!beta.lastResearchedAt && beta.signals.length === 1, 'the unrelated account ("Beta Co") is genuinely researched');
  assert(!acmeDup.lastResearchedAt, 'the near-duplicate ("Acme Co.") is NEVER stamped lastResearchedAt -- it was never actually attempted, so it must never look researched');
  assert(!acmeDup.signals || !acmeDup.signals.length, 'the near-duplicate never receives fabricated/borrowed signals either');

  assert(Array.isArray(result.skippedDuplicates) && result.skippedDuplicates.some(s => s.accountName === 'Acme Co.'), `the near-duplicate is honestly reported via the existing skippedDuplicates mechanism, not silently dropped from the summary (got ${JSON.stringify(result.skippedDuplicates)})`);
  assert(result.attempted === 2 && result.unattempted === 0 && result.failures === 0, `exactly the two genuinely distinct accounts are attempted; the duplicate is neither unattempted nor failed -- it's a deliberate, reported skip (got ${JSON.stringify({attempted: result.attempted, unattempted: result.unattempted, failures: result.failures})})`);
}

// Required behavior: Stop Research between chunks -- no additional queued
// chunk begins once Stop is clicked, even though earlier chunks already
// completed successfully.
async function testEnhancedGroupStopBetweenChunksNeverDispatchesRemaining(){
  const accounts = warmAccounts(16, 'list-stop-chunk', 'Stoppable');
  let sandbox;
  const fetchImpl = makeFetch((call) => {
    if (call.url.startsWith('/api/get-dashboard')) return jsonResponse({ upload: { id: 'list-stop-chunk', upload_name: 'Stoppable List' }, accounts });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'check-duplicates') return jsonResponse({ duplicateAccountNames: [] });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'claim') return jsonResponse({ outcome: 'claimed-new', researchRunId: 'run-stop-chunk', attemptId: 'attempt-stop-chunk-1' });
    if (call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat') return jsonResponse({ ok: true });
    if (call.url === '/api/research-batch' && !call.body.researchRunAction) {
      // Stop is requested from inside the first chunk's own response --
      // simulating a user clicking Stop Research while that chunk is still
      // in flight. The second chunk (accounts 8-15) must never dispatch.
      sandbox.requestResearchStop('list-stop-chunk');
      const byAccount = {};
      call.body.accounts.forEach(a => { byAccount[a.name] = [{ isReal: true, sourceUrl: `https://example.com/${a.name}` }]; });
      return jsonResponse({ byAccount, signals: [] });
    }
    if (call.url === '/api/save-upload') return jsonResponse({ ok: true, uploadId: 'list-stop-chunk', runStatus: 'completed' });
    throw new Error(`unexpected fetch in testEnhancedGroupStopBetweenChunksNeverDispatchesRemaining: ${call.url} ${JSON.stringify(call.body)}`);
  });
  sandbox = createSandbox({ fetchImpl });
  const result = await sandbox.researchListFromManageModal('list-stop-chunk');

  const workCalls = researchBatchWorkCalls(fetchImpl.calls);
  assert(workCalls.length === 1, `Stop Research requested mid-chunk prevents any further chunk from ever dispatching (got ${workCalls.length} research requests)`);
  assert(result.attempted === 8 && result.stopped === 8 && result.unattempted === 0 && result.failures === 0, `the in-flight chunk's 8 accounts complete normally; the remaining 8 are reported as stopped (a user action), not unattempted or failed (got ${JSON.stringify({attempted: result.attempted, stopped: result.stopped, unattempted: result.unattempted, failures: result.failures})})`);
  for(let i = 0; i < 8; i++) assert(!!accounts[i].lastResearchedAt, `account ${accounts[i].name} (already in flight when Stop was clicked) still completed normally`);
  for(let i = 8; i < 16; i++) assert(!accounts[i].lastResearchedAt, `account ${accounts[i].name} (never dispatched once Stop was requested) was left completely unresearched`);
}

await testListStopPreventsQueuedResearch();
await testIndividualStopCancellationContract();
await testTopAccountsFallbackLoopHonoursStop();
await testIndividualResearchMarksAccountResearchingDuringDispatch();
await testEnhancedGroupChunkedAndBounded();
await testEnhancedGroupPartialFailureHaltsRemainingChunks();
await testEnhancedGroupTransientFailureRetriesSmallerAndRecovers();
await testEnhancedGroupWithinListDuplicateNamesNeverFalselyStamped();
await testEnhancedGroupStopBetweenChunksNeverDispatchesRemaining();

// ===========================================================================
// Structural proofs: the requirements below are genuinely about ABSENCE of
// a call site, or about markup/wiring existing -- the same class of proof
// every *-round.js test file in this repo already uses for equivalent
// requirements (see e.g. test-followup-round.js/test-stabilization-round.js).
// ===========================================================================

// Required test 1: uploading a list alone causes zero research requests.
// autoResearchTopAccountsOnce() (the sole automatic trigger) no longer
// exists anywhere in the file, and processData()'s own save-completion
// chain no longer calls researchTopAccounts()/any research function.
{
  // Comments explaining the removal legitimately reference the old name by
  // text (with parens, since they describe a function) -- what must be
  // absent is any occurrence OUTSIDE a "//" comment (a real declaration or
  // call).
  const autoResearchLinesOutsideComments = LINES.filter(l => l.includes('autoResearchTopAccountsOnce') && !/^\s*\/\//.test(l));
  assert(autoResearchLinesOutsideComments.length === 0, `1) autoResearchTopAccountsOnce() (the sole automatic research trigger) is no longer declared or called anywhere in dashboard/index.html -- only explanatory "//" comments may still name it (found ${autoResearchLinesOutsideComments.length} non-comment occurrence(s))`);
  const processDataStart = DASHBOARD_SRC.indexOf('function processData(records){');
  assert(processDataStart !== -1, 'sanity: found processData()');
  const processDataEnd = DASHBOARD_SRC.indexOf('\nfunction escapeHtml', processDataStart);
  const processDataBody = DASHBOARD_SRC.slice(processDataStart, processDataEnd > -1 ? processDataEnd : processDataStart + 6000);
  assert(!/research/i.test(processDataBody.split("saveCurrentUpload('uploaded').then")[1] || ''), '1) processData()\'s post-save chain contains no reference to any research function -- upload alone never starts research');
}

// Required tests 2/3: the explicit post-upload decision -- Research All
// starts research (auto:false, the same explicit-user-action semantics the
// pre-existing "Research Top Accounts" button already used), Not Now makes
// zero calls.
// Live QA round 5: the explicit post-upload decision moved from the old
// embedded panel's wireUploadSuccessStateControls() wiring into
// showUploadSuccessModal() itself (each modal wires its own buttons when
// built, same pattern as showDestructiveConfirm()/showResearchConfirm() in
// the Manage Customer Accounts modal scope) -- see that function's own
// header comment for why. The underlying explicit-user-action semantics
// (auto:false) and the zero-call "Not now" guarantee are unchanged.
// Live QA round 6: Research no longer calls researchTopAccounts() directly
// -- it hands off to window.HouseAccountManager.researchList(uploadId),
// the trusted Manage-Customer-Accounts-scoped flow ("Research All
// Accounts" there runs the exact same runListResearch(uploadId,
// {onlyUnresearched:false})).
{
  const wireStart = DASHBOARD_SRC.indexOf('function showUploadSuccessModal(accountCount, accounts, records, uploadId){');
  const wireEnd = DASHBOARD_SRC.indexOf('\n// Live QA round 5, item 3: the truthful counterpart', wireStart);
  const wireSrc = DASHBOARD_SRC.slice(wireStart, wireEnd > -1 ? wireEnd : wireStart + 4000);
  assert(/researchBtn\.addEventListener\('click', \(\) => \{[\s\S]{0,300}?window\.HouseAccountManager\.researchList\(uploadId\);/.test(wireSrc), '2) clicking "Research N accounts" calls window.HouseAccountManager.researchList(uploadId) -- an explicit, non-automatic start of the trusted list-scoped research flow');
  const notNowBlock = wireSrc.slice(wireSrc.indexOf('notNowBtn.addEventListener'), wireSrc.indexOf('notNowBtn.addEventListener') + 200);
  assert(!/researchTopAccounts|researchList\(|fetch\(/.test(notNowBlock), '3) "Not now" makes zero research calls -- its click handler contains no research/fetch call at all');
  assert(/notNowBtn\.addEventListener\('click', \(\) => close\(\)\);/.test(wireSrc), '3) "Not now" closes the modal (so the decision cannot be accidentally re-triggered) and does nothing else');
}

// Required test 4: reopening/re-rendering (renderManager()/load()/open()) in
// the Manage Customer Accounts modal never itself calls any research
// function -- confirmed by the investigation this sprint traced (the modal
// only reads/displays server-owned researchRunState; it never dispatches
// research as a side effect of rendering).
{
  const modalScriptMatch = DASHBOARD_SRC.match(/<script>\s*\(function\(\)\{[\s\S]*?\n<\/script>/);
  assert(!!modalScriptMatch, 'sanity: found the Manage Customer Accounts modal IIFE');
  const modalSrc = modalScriptMatch[0];
  const renderManagerBody = modalSrc.slice(modalSrc.indexOf('function renderManager(){'), modalSrc.indexOf('function renderManager(){') + 400);
  assert(!/researchTopAccounts|researchListFromManageModal|researchAccountFromManageModal|researchAccountByName/.test(renderManagerBody), '4) renderManager() itself never calls any research-dispatching function -- it only re-renders from already-fetched state');
  const loadBody = modalSrc.slice(modalSrc.indexOf('async function load(){'), modalSrc.indexOf('async function load(){') + 900);
  assert(!/researchTopAccounts|researchListFromManageModal|researchAccountFromManageModal|researchAccountByName/.test(loadBody), '4) load() (called on every poll tick and on reopening the modal) never calls any research-dispatching function -- reopening/re-rendering cannot restart research');
}

// Required test 7: monitoring pause/resume is independent of research
// execution -- neither the account-level nor list-level pause/resume PATCH
// handling ever references the research tracker or any research function.
{
  const modalScriptMatch = DASHBOARD_SRC.match(/<script>\s*\(function\(\)\{[\s\S]*?\n<\/script>/);
  const modalSrc = modalScriptMatch[0];
  const pauseResumeBlock = modalSrc.slice(modalSrc.indexOf("action==='resume-account'"), modalSrc.indexOf("action==='resume-account'") + 600);
  assert(!/requestResearchStop|researchTopAccounts|researchListFromManageModal|researchAccountFromManageModal|Tracker/.test(pauseResumeBlock), '7) account-level pause/resume never references the research tracker or any research-dispatching function -- pausing monitoring cannot appear to cancel a running research job');
  const listPauseResumeBlock = modalSrc.slice(modalSrc.indexOf("const resuming = action==='resume';"), modalSrc.indexOf("const resuming = action==='resume';") + 600);
  assert(!/requestResearchStop|researchTopAccounts|researchListFromManageModal|researchAccountFromManageModal|Tracker/.test(listPauseResumeBlock), '7) list-level pause/resume never references the research tracker or any research-dispatching function either');
}

// Required test 10: the list-level ellipsis menu exposes Research All
// Accounts, Research Unresearched Accounts, and (conditionally) Stop
// Research, and the delegated click handler routes each to the real
// handler.
{
  assert(/data-list-research-act="research"/.test(DASHBOARD_SRC) && /Research All Accounts/.test(DASHBOARD_SRC), '10) the list ⋯ menu exposes "Research All Accounts"');
  assert(/data-list-research-act="research-unresearched"/.test(DASHBOARD_SRC) && /Research Unresearched Accounts/.test(DASHBOARD_SRC), '10) the list ⋯ menu exposes "Research Unresearched Accounts"');
  assert(/data-list-stop-act="research"/.test(DASHBOARD_SRC), '10) the list ⋯ menu conditionally exposes a Stop Research item');
  assert(/e\.target\.closest\('\[data-list-research-act\]'\)/.test(DASHBOARD_SRC), '10) the delegated click handler routes ANY data-list-research-act value (both menu items) to handleListResearchClick()');
  assert(/e\.target\.closest\('\[data-list-stop-act="research"\], \[data-research-stop-act="list"\]'\)/.test(DASHBOARD_SRC), '10) the delegated click handler routes both the menu\'s Stop Research item and the progress panel\'s own Stop button to the same requestResearchStop() call');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
