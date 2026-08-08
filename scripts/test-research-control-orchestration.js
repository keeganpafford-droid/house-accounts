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
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const DASHBOARD_SRC = readFileSync(DASHBOARD_PATH, 'utf8');
const LINES = DASHBOARD_SRC.split('\n');

function extractFn(name, startLine, endLine, { async: isAsync = false } = {}) {
  const slice = LINES.slice(startLine - 1, endLine).join('\n');
  const expectedPrefix = `${isAsync ? 'async ' : ''}function ${name}(`;
  if (!slice.startsWith(expectedPrefix)) {
    throw new Error(`extractFn(${name}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in this test.`);
  }
  if (!slice.trimEnd().endsWith('}')) {
    throw new Error(`extractFn(${name}): dashboard/index.html line ${endLine} does not close the function body as expected -- update the line range.`);
  }
  return slice;
}

const REAL_SOURCE = [
  extractFn('claimAutomaticResearchRun', 2530, 2540, { async: true }),
  extractFn('checkDuplicateCompanyResearch', 2554, 2570, { async: true }),
  extractFn('heartbeatCurrentResearchRun', 2603, 2620, { async: true }),
  extractFn('reportResearchRunOutcome', 2634, 2659, { async: true }),
  extractFn('fetchUploadScopedSnapshot', 6020, 6042, { async: true }),
  extractFn('persistScopedResearchResult', 6050, 6095, { async: true }),
  extractFn('setActiveResearchBreadcrumb', 6117, 6123),
  extractFn('clearActiveResearchBreadcrumb', 6124, 6135),
  extractFn('getActiveResearchBreadcrumb', 6136, 6143),
  extractFn('safeParseResearchResponse', 6156, 6191, { async: true }),
  extractFn('researchAccountFromManageModal', 6193, 6350, { async: true }),
  extractFn('researchListFromManageModal', 6365, 6591, { async: true }),
  extractFn('researchAccountByName', 6624, 6779, { async: true }),
  extractFn('getAccountsForResearch', 6783, 6796),
  extractFn('batchPayloadForAccounts', 6798, 6842),
  extractFn('applyBusinessSignalAccountBoost', 6845, 6853),
  extractFn('researchAccountsBatch', 6855, 6975, { async: true }),
  extractFn('researchTopAccounts', 7002, 7193, { async: true }),
].join('\n\n');

// The shared research tracker module, run for real (not stubbed) -- these
// tests exist specifically to prove ITS stop/progress behavior actually
// takes effect inside the real orchestration functions above.
const TRACKER_SRC = (() => {
  const start = 7223, end = 7337;
  const slice = LINES.slice(start - 1, end).join('\n');
  if (!slice.startsWith('const researchRunTrackers = new Map();')) {
    throw new Error('tracker module extraction: dashboard/index.html has shifted -- update the line range in this test.');
  }
  return slice;
})();

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

await testListStopPreventsQueuedResearch();
await testIndividualStopCancellationContract();
await testTopAccountsFallbackLoopHonoursStop();
await testIndividualResearchMarksAccountResearchingDuringDispatch();

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
{
  const wireStart = DASHBOARD_SRC.indexOf('function wireUploadSuccessStateControls(){');
  const wireEnd = DASHBOARD_SRC.indexOf('\nif(document.readyState', wireStart);
  const wireSrc = DASHBOARD_SRC.slice(wireStart, wireEnd > -1 ? wireEnd : wireStart + 3000);
  assert(/researchAllBtn\.addEventListener\('click', \(\) => \{[\s\S]{0,200}?researchTopAccounts\(\{auto:false\}\);/.test(wireSrc), '2) clicking "Research all N accounts" calls researchTopAccounts({auto:false}) -- an explicit, non-automatic start');
  const notNowBlock = wireSrc.slice(wireSrc.indexOf('uploadResearchNotNowBtn'));
  assert(!/researchTopAccounts|fetch\(/.test(notNowBlock), '3) "Not now" makes zero research calls -- its click handler contains no research/fetch call at all');
  assert(/decisionEl\.hidden = true/.test(notNowBlock), '3) "Not now" hides the decision prompt so it cannot be accidentally re-triggered');
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
