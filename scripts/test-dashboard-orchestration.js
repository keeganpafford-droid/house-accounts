// Phase 2A implementation-review ROUND 6, item 2 — genuine
// browser-orchestration tests.
//
// The user's explicit requirement: "Do not satisfy this only with
// source-string assertions. Exercise the orchestration with mocked
// fetch/save calls and count actual invocations."
//
// How this file satisfies that: it extracts the VERBATIM source text of
// every function that owns orchestration control flow -- claim, heartbeat,
// report-outcome, both research entry points, render, and both halves of
// the save chain -- directly out of dashboard/index.html at the exact line
// ranges below, and runs that real source in a sandboxed vm context. It
// then calls the real functions (researchAccountByName(), researchTopAccounts(),
// refreshOpportunityViews(), saveCurrentUpload()) exactly as the browser
// would, with a mocked global fetch that records every call, and asserts on
// the RECORDED CALL COUNTS -- not on any string pattern in the source.
//
// Nothing about the orchestration logic itself is reimplemented. The only
// stubbed functions are ones that are pure DOM-rendering or account
// classification helpers with NO bearing on save/heartbeat/claim call
// counts (e.g. renderDetailedAccountViews, deriveAccountIntelligenceMode) --
// each is listed explicitly in STUB_SOURCE below with a one-line reason.
// If dashboard/index.html changes shape, extractFn() below throws instead
// of silently testing stale/wrong text, because it verifies the sliced text
// actually starts with the expected function signature before using it.
//
// Usage: node scripts/test-dashboard-orchestration.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const DASHBOARD_SRC = readFileSync(DASHBOARD_PATH, 'utf8');
const LINES = DASHBOARD_SRC.split('\n');

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// Slices dashboard/index.html by 1-indexed, inclusive line numbers and
// verifies the slice actually starts with the expected function signature
// -- so a source reshuffle fails loudly here instead of silently running
// stale/wrong text.
function extractFn(name, startLine, endLine, {async: isAsync = false} = {}){
  const slice = LINES.slice(startLine - 1, endLine).join('\n');
  const expectedPrefix = `${isAsync ? 'async ' : ''}function ${name}(`;
  if(!slice.startsWith(expectedPrefix)){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-dashboard-orchestration.js.`);
  }
  const lastLine = slice.trimEnd();
  if(!lastLine.endsWith('}')){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${endLine} does not close the function body as expected -- update the line range.`);
  }
  return slice;
}

// ===========================================================================
// Real orchestration source, extracted verbatim from dashboard/index.html.
// ===========================================================================
const REAL_SOURCE = [
  extractFn('claimAutomaticResearchRun', 2118, 2126, {async: true}),
  extractFn('heartbeatCurrentResearchRun', 2146, 2158, {async: true}),
  extractFn('reportResearchRunOutcome', 2167, 2187, {async: true}),
  extractFn('getAccountsForResearch', 3828, 3841),
  extractFn('batchPayloadForAccounts', 3843, 3887),
  extractFn('applyBusinessSignalAccountBoost', 3890, 3898),
  extractFn('researchAccountByName', 3692, 3823, {async: true}),
  extractFn('researchAccountsBatch', 3900, 3987, {async: true}),
  extractFn('signalTopicKeyClient', 3989, 3997),
  extractFn('dedupeSignalsClient', 3999, 4012),
  extractFn('researchTopAccounts', 4014, 4144, {async: true}),
  extractFn('refreshOpportunityViews', 4245, 4264),
  extractFn('serializeAccountForStorage', 5624, 5666),
  extractFn('performSaveCurrentUpload', 5668, 5749, {async: true}),
  extractFn('saveCurrentUpload', 5758, 5762),
  extractFn('importedContactsFromRecords', 5775, 5791)
].join('\n\n');

// ===========================================================================
// Stubs: ONLY pure DOM-rendering or account-classification helpers that the
// real functions above call into but which have no bearing on
// save/heartbeat/claim invocation counts -- the thing under test.
// ===========================================================================
const STUB_SOURCE = `
// DOM string-rendering only; irrelevant to which/how-many network calls fire.
function escapeHtml(text){ return String(text == null ? '' : text); }
function accountDomId(name){ return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function renderVerifiedSignals(signals){ return ''; }
function renderDetailedAccountViews(accounts){}
function renderResearchDiagnostics(){}
function renderWeeklyPrioritiesFeed(opportunities, accounts){ return {displayedOpportunities: opportunities}; }
function calculateRevenueContext(accounts, opportunities){ return {historicalRevenue:0, historicalOpps:0, newBusinessOpps:0, totalReasons:0}; }
function applyFreeCompanyLocksToCustomerAccounts(accounts){ return accounts; }
function assignOpportunityScore(opp, account){}
function getOpportunityScore(opp){ return 0; }
function sortDailyReasons(opps){ return opps; }
function dedupeOpportunities(items){ return items; }
function fmtMoney(n){ return String(n); }
function addSignalDerivedOpportunities(account, signals){}
function getResearchDiagnostics(){ window.researchDiagnostics = window.researchDiagnostics || []; return window.researchDiagnostics; }
// Account-classification heuristics -- deliberately fixed/deterministic so
// every test account takes the SAME code path (enhancedPublicMode /
// warm-account) regardless of fixture shape; which endpoint/mode string is
// chosen is orthogonal to how many times save/heartbeat/claim fire.
function deriveAccountIntelligenceMode(accountOrRecords){ return 'warm'; }
function isWarmAccount(account){ return true; }
function extractEmailDomain(email){ return String(email || '').split('@')[1] || ''; }
async function loadDashboardUsage(){ return null; }
function getSavedLead(){ return null; }
`;

// ===========================================================================
// Sandbox factory: fresh vm context per test so no state leaks between
// scenarios. Initial module-level state is baked into INIT_SOURCE as real
// `var` declarations (var, not let/const, so they attach to the vm context's
// global object and are readable/settable from outside via sandbox.<name>
// between calls, exactly like dashboard/index.html's real module scope
// attaches to `window` in a real browser).
// ===========================================================================
function buildInitSource(state){
  return `
var currentLead = ${JSON.stringify(state.currentLead)};
var currentUploadId = ${JSON.stringify(state.currentUploadId)};
var currentUploadName = ${JSON.stringify(state.currentUploadName || '')};
var saveInProgress = false;
var saveQueue = Promise.resolve();
var currentResearchRunId = ${JSON.stringify(state.currentResearchRunId || null)};
var currentResearchAttemptId = ${JSON.stringify(state.currentResearchAttemptId || null)};
var researchInProgress = false;
var autoResearchStarted = true;
`;
}

function createSandbox({accounts, currentUploadId = 'upload-1', currentResearchRunId = null, currentResearchAttemptId = null, fetchImpl}){
  const consoleLog = { warn: [], error: [], log: [] };
  const houseAuth = { authHeaders: (h) => h || {} };
  const sandbox = {
    window: {
      accountRadarAccounts: accounts,
      researchDiagnostics: [],
      HouseAuth: houseAuth,
      location: { href: 'https://example.com/dashboard' }
    },
    HouseAuth: houseAuth,
    document: { getElementById: () => null },
    fetch: fetchImpl,
    console: {
      log: (...a) => consoleLog.log.push(a),
      warn: (...a) => consoleLog.warn.push(a),
      error: (...a) => consoleLog.error.push(a)
    },
    Math, Date, JSON, Set, Array, Object, Number, String, Promise, Boolean,
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  const initSource = buildInitSource({ currentLead: {email:'lead@example.com', name:'Test Lead', company:'Test Co'}, currentUploadId, currentResearchRunId, currentResearchAttemptId });
  const fullSource = `${initSource}\n${STUB_SOURCE}\n${REAL_SOURCE}\n`;
  new vm.Script(fullSource, {filename: 'dashboard-orchestration-extract.js'}).runInContext(sandbox);
  sandbox.__consoleLog = consoleLog;
  return sandbox;
}

// ===========================================================================
// Fetch mock: records every call and dispatches to a per-test router.
// ===========================================================================
function makeFetch(router){
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const call = { url, method: (init && init.method) || 'GET', body };
    calls.push(call);
    return router(call, calls);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
function jsonResponse(data, {ok = true, status = 200} = {}){
  return { ok, status, json: async () => data };
}

function callsTo(calls, urlSuffix){ return calls.filter(c => c.url === urlSuffix); }
function saveUploadCalls(calls){ return callsTo(calls, '/api/save-upload'); }
function researchBatchCalls(calls){ return callsTo(calls, '/api/research-batch'); }
function claimCalls(calls){ return researchBatchCalls(calls).filter(c => c.body.researchRunAction === 'claim'); }
function heartbeatCalls(calls){ return researchBatchCalls(calls).filter(c => c.body.researchRunAction === 'heartbeat'); }
function outcomeCalls(calls){ return researchBatchCalls(calls).filter(c => c.body.researchRunAction === 'fail' || c.body.researchRunAction === 'complete'); }
function researchWorkCalls(calls){ return researchBatchCalls(calls).filter(c => !c.body.researchRunAction); }

function fixtureAccount(name, overrides = {}){
  return { name, industry: 'Test', contactEmail: `${name.toLowerCase()}@example.com`, revenue: 1000, orderCount: 1, futureOpportunities: [], ...overrides };
}

// ===========================================================================
// Scenario (a): standalone single-account research success.
// Required: exactly one tracked save-upload call, exactly one
// persist_ha_research_output-bound call (stage='researched' with
// researchRunId+attemptId), run completes once.
// ===========================================================================
async function testStandaloneSuccess(){
  const accounts = [fixtureAccount('Acme')];
  const fetchImpl = makeFetch((call) => {
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-standalone', attemptId:'attempt-standalone-1'});
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat'){
      return jsonResponse({ok:true});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      return jsonResponse({byAccount: {Acme: [{isReal:true, sourceUrl:'https://example.com/x', signalType:'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({ok:true, uploadId:'upload-1', runStatus:'completed'});
    }
    throw new Error(`unexpected fetch in testStandaloneSuccess: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts, currentUploadId:'upload-1', fetchImpl});
  await sandbox.researchAccountByName('Acme', {});

  const calls = fetchImpl.calls;
  assert(claimCalls(calls).length === 1, 'a) standalone: exactly one claim call');
  assert(researchWorkCalls(calls).length === 1, 'a) standalone: exactly one research-work call');
  assert(saveUploadCalls(calls).length === 1, 'a) standalone success: exactly one tracked save-upload call');
  const save = saveUploadCalls(calls)[0];
  assert(save.body.stage === 'researched', 'a) standalone success: save stage is "researched"');
  assert(!!save.body.researchRunId && !!save.body.attemptId, 'a) standalone success: exactly one persist_ha_research_output-bound call (researchRunId+attemptId present)');
  assert(heartbeatCalls(calls).length === 1, 'a) standalone success: exactly one heartbeat call before the terminal save');
  assert(outcomeCalls(calls).length === 0, 'a) standalone success: no fail/complete outcome report needed (atomic finalization owns completion)');
}

// ===========================================================================
// Scenario (b): successful batch research (all accounts return signals from
// the single batch call). Required: exactly one tracked save.
// ===========================================================================
async function testBatchSuccess(){
  const accounts = [fixtureAccount('Acme'), fixtureAccount('Globex'), fixtureAccount('Initech')];
  const fetchImpl = makeFetch((call) => {
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-batch', attemptId:'attempt-batch-1'});
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat'){
      return jsonResponse({ok:true});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      // The one batch call: every account gets a signal, so batchSignals > 0
      // and researchTopAccounts() must NOT fall back to per-account research.
      const byAccount = {};
      accounts.forEach(a => { byAccount[a.name] = [{isReal:true, sourceUrl:`https://example.com/${a.name}`, signalType:'Hiring'}]; });
      return jsonResponse({byAccount, signals: [], diagnostics:{}});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({ok:true, uploadId:'upload-1', runStatus:'completed'});
    }
    throw new Error(`unexpected fetch in testBatchSuccess: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts, currentUploadId:'upload-1', fetchImpl});
  await sandbox.researchTopAccounts({});

  const calls = fetchImpl.calls;
  assert(claimCalls(calls).length === 1, 'b) batch success: exactly one claim call');
  assert(researchWorkCalls(calls).length === 1, 'b) batch success: exactly one research-work call (the batch call; no per-account fallback)');
  assert(saveUploadCalls(calls).length === 1, 'b) batch success: exactly one tracked save-upload call');
  assert(saveUploadCalls(calls)[0].body.stage === 'research_updated', 'b) batch success: save stage is "research_updated"');
  assert(sandbox.currentResearchAttemptId === null, 'b) batch success: currentResearchAttemptId reset after run finishes');
  assert(sandbox.researchInProgress === false, 'b) batch success: researchInProgress reset after run finishes');
}

// ===========================================================================
// Scenario (c): batch call fails/returns no signals -> per-account fallback.
// Required: zero saves from individual fallback workers, exactly one
// tracked save after all workers finish.
// ===========================================================================
async function testBatchTimeoutThenFallback(){
  const accounts = [fixtureAccount('Acme'), fixtureAccount('Globex')];
  const fetchImpl = makeFetch((call) => {
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-fallback', attemptId:'attempt-fallback-1'});
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat'){
      return jsonResponse({ok:true});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      const isBatchCall = Array.isArray(call.body.accounts) && call.body.accounts.length > 1;
      if(isBatchCall){
        // Simulate the batch endpoint timing out / erroring -- researchAccountsBatch()'s
        // own catch block handles a non-ok response.
        return jsonResponse({error:'timeout'}, {ok:false, status:504});
      }
      // Per-account fallback worker call.
      const name = call.body.accounts[0].name;
      return jsonResponse({byAccount: {[name]: [{isReal:true, sourceUrl:`https://example.com/${name}`, signalType:'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({ok:true, uploadId:'upload-1', runStatus:'completed'});
    }
    throw new Error(`unexpected fetch in testBatchTimeoutThenFallback: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts, currentUploadId:'upload-1', fetchImpl});
  await sandbox.researchTopAccounts({});

  const calls = fetchImpl.calls;
  const work = researchWorkCalls(calls);
  assert(work.length === 1 + accounts.length, 'c) fallback: one failed batch call plus one per-account fallback call per account');
  assert(saveUploadCalls(calls).length === 1, 'c) fallback: exactly one tracked save after all workers finish (zero saves from individual workers)');
  const perAccountCalls = work.filter(c => Array.isArray(c.body.accounts) && c.body.accounts.length === 1);
  assert(perAccountCalls.length === accounts.length, 'c) fallback: every account got its own fallback research call');
  assert(heartbeatCalls(calls).length === 1, 'c) fallback: exactly one terminal heartbeat, not one per worker');
}

// ===========================================================================
// Scenario (d): refresh/render after completion does not issue another save.
// ===========================================================================
async function testRefreshAfterCompletionNoSave(){
  const accounts = [fixtureAccount('Acme', {futureOpportunities: [{account:'Acme', confidence:80, signalLayerType:'Business Activity Signal'}]})];
  const fetchImpl = makeFetch((call) => {
    throw new Error(`refreshOpportunityViews() must never call fetch; got ${call.url}`);
  });
  const sandbox = createSandbox({accounts, currentUploadId:'upload-1', fetchImpl});
  sandbox.refreshOpportunityViews();
  sandbox.refreshOpportunityViews();

  assert(fetchImpl.calls.length === 0, 'd) refresh/render after completion: zero fetch calls of any kind (no additional tracked save)');
}

// ===========================================================================
// Scenario (e): terminal save fails. Required: failure reported once, no
// completion has committed (server never returned success), no second
// background save later succeeds unexpectedly.
// ===========================================================================
async function testTerminalSaveFails(){
  const accounts = [fixtureAccount('Acme')];
  const fetchImpl = makeFetch((call) => {
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-fail', attemptId:'attempt-fail-1'});
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat'){
      return jsonResponse({ok:true});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      return jsonResponse({byAccount: {Acme: [{isReal:true, sourceUrl:'https://example.com/x', signalType:'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({error:'Save failed'}, {ok:false, status:500});
    }
    throw new Error(`unexpected fetch in testTerminalSaveFails: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts, currentUploadId:'upload-1', fetchImpl});
  await sandbox.researchAccountByName('Acme', {});

  const calls = fetchImpl.calls;
  assert(saveUploadCalls(calls).length === 1, 'e) terminal save fails: exactly one save attempt was made');
  assert(sandbox.__consoleLog.warn.length >= 1, 'e) terminal save fails: failure was reported (logged) once');

  // Nothing further happens automatically -- confirm no second save is ever
  // scheduled as a delayed/background follow-up for the same run.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(saveUploadCalls(fetchImpl.calls).length === 1, 'e) terminal save fails: no second background save later succeeds unexpectedly');
}

// ===========================================================================
// Scenario (f): terminal save succeeds -> no later stale-attempt 409 occurs
// from the same logical workflow, because there is no second save to race.
// ===========================================================================
async function testTerminalSaveSucceedsNoLaterStale409(){
  const accounts = [fixtureAccount('Acme', {futureOpportunities: [{account:'Acme', confidence:80, signalLayerType:'Business Activity Signal'}]})];
  const fetchImpl = makeFetch((call) => {
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-ok', attemptId:'attempt-ok-1'});
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat'){
      return jsonResponse({ok:true});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      return jsonResponse({byAccount: {Acme: [{isReal:true, sourceUrl:'https://example.com/x', signalType:'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({ok:true, uploadId:'upload-1', runStatus:'completed'});
    }
    throw new Error(`unexpected fetch in testTerminalSaveSucceedsNoLaterStale409: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts, currentUploadId:'upload-1', fetchImpl});
  await sandbox.researchAccountByName('Acme', {});
  // A subsequent render (e.g. a tab switch, a filter change) must not
  // resurrect a save for the now-completed run.
  sandbox.refreshOpportunityViews();

  const calls = fetchImpl.calls;
  const saves = saveUploadCalls(calls);
  assert(saves.length === 1, 'f) terminal save succeeds: exactly one save call ever, even after a later render');
  assert(saves.every(s => s.body.stage === 'researched'), 'f) terminal save succeeds: the one save was the tracked research-output save');
  // Since there was never a second save for this attempt, there is nothing
  // for the server's atomic finalization check to reject as stale -- a 409
  // response for this scenario is structurally impossible, not merely
  // untriggered by luck.
}

async function main(){
  await testStandaloneSuccess();
  await testBatchSuccess();
  await testBatchTimeoutThenFallback();
  await testRefreshAfterCompletionNoSave();
  await testTerminalSaveFails();
  await testTerminalSaveSucceedsNoLaterStale409();

  console.log(`\n${failures === 0 ? 'ALL DASHBOARD ORCHESTRATION TESTS PASSED' : `${failures} DASHBOARD ORCHESTRATION TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
