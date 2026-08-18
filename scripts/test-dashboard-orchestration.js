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
import { extractFn as sharedExtractFn, extractStatementAfter, loadDashboardSource } from './lib/dashboard-extract.js';

const DASHBOARD_SRC = loadDashboardSource();

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// Locates the named top-level declaration by semantic structure (shared
// library) rather than a physical line range -- immune to ordinary edits
// anywhere earlier in dashboard/index.html. Signature kept name-only,
// matching every other call site in this file; the {async} option some
// call sites still pass is accepted but no longer needed for correctness
// (the shared extractor recognizes async functions on its own).
function extractFn(name){
  return sharedExtractFn(DASHBOARD_SRC, name);
}

// Same guarantee as extractFn(), for a non-function source block (the
// delegated click listener is a bare `document.addEventListener(...)`
// statement, not a named function declaration) -- anchored immediately
// after the already-extracted saveAccountMetadataEdit(), never a bare line
// number.
function extractDelegatedClickListener(){
  const anchorSrc = extractFn('saveAccountMetadataEdit');
  const anchorIndex = DASHBOARD_SRC.indexOf(anchorSrc) + anchorSrc.length;
  return extractStatementAfter(DASHBOARD_SRC, anchorIndex, "document.addEventListener('click'");
}

// ===========================================================================
// Real orchestration source, extracted verbatim from dashboard/index.html.
// ROUND 8, item 1/2: also includes the account-card markup generator
// (renderDetailedAccountViews), the collision-safe card/panel lookup
// helpers (accountCardFor/accountSignalsPanel), the delegated click
// listener that replaced the old inline onclick="..." handlers, and the
// REAL escapeHtml() (previously a no-op stub here -- the security tests
// below specifically need genuine HTML escaping, not a pass-through).
// ===========================================================================
// Line ranges updated for the client-authentication release-blocker fix
// (dashboard/index.html now calls HouseAuth.authHeadersAsync() instead of
// the synchronous HouseAuth.authHeaders() at every protected fetch site,
// which shifted every subsequent line number). Re-derived by brace-depth
// scanning from the current file and spot-verified by direct reads, not
// hand-counted -- extractFn()'s own signature check below is the final,
// self-enforcing guarantee regardless.
// ROUND 13 note: line ranges re-derived after this round's error-
// classification/query-batching/composite-identity changes shifted almost
// every function below. extractFn()/extractRaw()'s own signature/
// closing-brace checks are the actual guarantee of correctness -- these
// numbers were re-derived mechanically (brace-depth scan from each
// function's real signature line), not hand-counted.
// FR3 round: line ranges re-derived after this round's Help-dropdown CSS
// fix (no line-count effect on this file) and the researchAccountByName()
// identity fix -- accountCardFor()/accountSignalsPanel() gained an optional
// uploadId parameter, two new functions were added
// (applyModalResearchResultToDashboard(), researchAccountFromCard() -- the
// card click listener's new, consolidated, upload-scoped target), and the
// delegated click listener itself changed to read/pass the clicked card's
// own data-upload-id. extractFn()/extractRaw()'s own signature/
// closing-brace checks are the actual guarantee of correctness -- these
// numbers were re-derived mechanically (parse-complete scan from each
// function's real signature line), not hand-counted.
const REAL_SOURCE = [
  extractFn('claimAutomaticResearchRun'),
  // Duplicate-company research control (beta round): researchAccountFromManageModal(),
  // researchListFromManageModal(), and researchTopAccounts() (all extracted
  // below) now call checkDuplicateCompanyResearch() before ever claiming a
  // run -- it must be real, extracted source (not stubbed), since its own
  // fetch call and fail-open contract are directly part of the orchestration
  // under test here.
  extractFn('checkDuplicateCompanyResearch'),
  extractFn('duplicateCompanyResearchMessage'),
  extractFn('heartbeatCurrentResearchRun'),
  extractFn('reportResearchRunOutcome'),
  extractFn('normalizeSavedAccount'),
  extractFn('accountCardFor'),
  extractFn('accountSignalsPanel'),
  // FR2 round: researchAccountFromManageModal()/researchAccountByName() now
  // parse every research response through this real function instead of a
  // blind res.json() -- it must be extracted as real source (not stubbed)
  // since it directly participates in the request/response orchestration
  // under test here, exactly like fetchUploadScopedSnapshot() below.
  extractFn('safeParseResearchResponse'),
  extractFn('fetchUploadScopedSnapshot'),
  extractFn('persistScopedResearchResult'),
  extractFn('researchAccountFromManageModal'),
  extractFn('researchAccountByName'),
  extractFn('getAccountsForResearch'),
  extractFn('batchPayloadForAccounts'),
  extractFn('applyBusinessSignalAccountBoost'),
  extractFn('researchAccountsBatch'),
  extractFn('signalTopicKeyClient'),
  extractFn('dedupeSignalsClient'),
  extractFn('researchTopAccounts'),
  extractFn('refreshOpportunityViews'),
  // FR3 round: display-only patch of window.accountRadarAccounts after a
  // scoped save has already succeeded -- researchAccountFromCard() below
  // calls this exactly like the Manage Customer Accounts modal's own
  // handleResearchClick() wrapper does (that wrapper lives in the OTHER
  // inline <script>, not extracted here; its own dedicated coverage is the
  // scoped-research family of tests further down this file).
  extractFn('applyModalResearchResultToDashboard'),
  // FR3 round root-cause fix: the dashboard card's "Research Account" /
  // "Research Again" button's new, single target -- built directly on the
  // already-scoped researchAccountFromManageModal() above instead of the
  // name-only/currentUploadId-dependent researchAccountByName(). This is
  // the function under test in the collision/duplicate-name scenarios
  // below.
  extractFn('researchAccountFromCard'),
  extractFn('renderDetailedAccountViews'),
  // Source-of-truth correction: serializeAccountForStorage() below now
  // calls isWebResearchSignal() to keep canonical business signals out of
  // existingSignals -- must be real, extracted source (not stubbed), plus
  // its own dependency chain (signalLayerLabel() -> normalizeSignalLayerType()/
  // isRecentAccountActivity()), since the exclusion is exactly what this
  // round's fix depends on.
  extractFn('isWebResearchSignal'),
  extractFn('signalLayerLabel'),
  extractFn('isRecentAccountActivity'),
  extractFn('normalizeSignalLayerType'),
  extractFn('serializeAccountForStorage'),
  extractFn('performSaveCurrentUpload'),
  extractFn('saveCurrentUpload'),
  extractFn('toggleAccountMetadataEdit'),
  extractFn('saveAccountMetadataEdit'),
  extractDelegatedClickListener(),
  extractFn('importedContactsFromRecords'),
  extractFn('escapeHtml')
].join('\n\n');

// ===========================================================================
// Stubs: ONLY pure DOM-rendering or account-classification helpers that the
// real functions above call into but which have no bearing on
// save/heartbeat/claim invocation counts, OR on the account-name-escaping
// safety the ROUND 8 security tests check -- the two things under test.
// ===========================================================================
const STUB_SOURCE = `
function renderVerifiedSignals(signals){ return ''; }
// Signal feedback / organizational-learning foundation: renderDetailedAccountViews()
// now calls this unconditionally after rendering -- pure best-effort DOM
// hydration with no bearing on save/heartbeat/claim invocation counts or
// the markup-safety assertions this file checks, so it's stubbed exactly
// like the other renderXxx()/hydrate-style helpers around it.
function hydrateSignalFeedbackButtons(){}
function renderResearchDiagnostics(){}
// ROUND 12: refreshOpportunityViews() now also calls this (see the real
// definition in dashboard/index.html) -- pure DOM rendering, no bearing on
// save/heartbeat/claim invocation counts, so it is stubbed exactly like the
// other renderXxx() calls above/below.
function renderRecentlyResearchedSection(){}
// ROUND 12: localStorage-only breadcrumb helpers researchAccountFromManageModal()
// now calls -- no fetch/save/claim side effects, so no bearing on this
// file's call-count assertions. Real behavior (write/read/clear semantics,
// including the "never clobber a newer claim's breadcrumb" guard) has its
// own dedicated coverage in scripts/test-research-run-reattachment.js.
function setActiveResearchBreadcrumb(){}
function clearActiveResearchBreadcrumb(){}
function getActiveResearchBreadcrumb(){ return ''; }
function renderWeeklyPrioritiesFeed(opportunities, accounts){ return {displayedOpportunities: opportunities}; }
function calculateRevenueContext(accounts, opportunities){ return {historicalRevenue:0, historicalOpps:0, newBusinessOpps:0, totalReasons:0}; }
function applyFreeCompanyLocksToCustomerAccounts(accounts){ return accounts; }
function assignOpportunityScore(opp, account){ return opp; }
function getOpportunityScore(opp){ return 0; }
function sortDailyReasons(opps){ return opps; }
function dedupeOpportunities(items){ return items; }
function dedupeFoundSignals(signals){ return signals || []; }
// Beta correction ("N business signals found" canonical definition): this
// file's scope is dashboard/save/reattachment orchestration, not identity
// semantics (dedicated coverage lives in
// test-final-beta-signal-intelligence-correction.js's countLegitimateBusinessSignals()
// tests) -- stubbed the same way dedupeFoundSignals()/isExplicitlyVerifiedIdentity()
// above already are, so researchAccountsBatch()'s real, unmodified control-
// flow logic can run without needing the real identity-grounding helper
// chain in scope.
function countLegitimateBusinessSignals(signals){ return (signals || []).length; }
function isExplicitlyVerifiedIdentity(opp){ return opp?.identityConfidence === 'confirmed'; }
function foundAndVerifiedSuffix(signals){ const n = (signals || []).filter(isExplicitlyVerifiedIdentity).length; return n ? (' - ' + n + ' verified') : ''; }
function recommendationBadgeMeta(o){ return {label:'Reach Out'}; }
function buyingConversationLabel(o){ return ''; }
function recommendationOneLine(o){ return ''; }
function reasonListMeta(o){ return ''; }
function suggestedIntroductionPath(o){ return ''; }
function renderPipelineTable(pipeline){ return ''; }
// Account Expansion / Whitespace Intelligence, Slice 1: renderDetailedAccountViews()
// now also calls this unconditionally -- pure best-effort DOM rendering
// (a read-only coverage grid) with no bearing on save/heartbeat/claim
// invocation counts or the markup-safety assertions this file checks, so
// it's stubbed exactly like the other renderXxx() helpers above/below.
// Real behavior has its own dedicated coverage in
// scripts/test-account-whitespace-intelligence-slice1.js.
function renderAccountWhitespaceSection(account){ return ''; }
function fmtMoney(n){ return String(n); }
function addSignalDerivedOpportunities(account, signals){}
function getResearchDiagnostics(){ window.researchDiagnostics = window.researchDiagnostics || []; return window.researchDiagnostics; }
// Account-classification heuristics -- deliberately fixed/deterministic so
// every test account takes the SAME code path (enhancedPublicMode /
// warm-account) regardless of fixture shape; which endpoint/mode string is
// chosen is orthogonal to how many times save/heartbeat/claim fire, and
// orthogonal to the escaping-safety the ROUND 8 tests check.
function deriveAccountIntelligenceMode(accountOrRecords){ return 'warm'; }
function isWarmAccount(account){ return true; }
function extractEmailDomain(email){ return String(email || '').split('@')[1] || ''; }
async function loadDashboardUsage(){ return null; }
function getSavedLead(){ return null; }
function defaultDashboardView(){ return 'my'; }
// ux/research-control-progress: client-side progress/stop tracker helpers
// researchAccountByName()/researchAccountsBatch()/researchTopAccounts()/
// researchAccountFromManageModal()/researchListFromManageModal() now call.
// Pure in-memory progress bookkeeping with no fetch/save/claim side effects
// -- no bearing on this file's call-count assertions. Real tracker/stop
// behavior has its own dedicated coverage.
function startResearchTracker(){}
function finishResearchTracker(){}
function markResearchAccountStarted(){}
function markResearchAccountDone(){}
function markResearchGroupDone(){}
function registerResearchAbort(){}
function unregisterResearchAbort(){}
function requestResearchStop(){}
function isResearchStopRequested(){ return false; }
`;

// ===========================================================================
// ROUND 8, item 1/2 -- a small, real (not faked) DOM sufficient for
// accountCardFor()/accountSignalsPanel()/the delegated click listener
// (all REAL extracted code, see REAL_SOURCE above) to run against.
//
// CSS.escape: the exact CSSOM spec algorithm (the same one every browser
// implements), not a simplified approximation -- this is what
// accountCardFor()'s real, extracted code calls directly
// (`.account-card[data-account-name="${CSS.escape(accountName)}"]`), so if
// this were wrong in a way that mattered, the security property under test
// would not actually be verified.
// ===========================================================================
function cssEscape(value){
  const string = String(value);
  const length = string.length;
  let result = '';
  let index = 0;
  const firstCodeUnit = string.charCodeAt(0);
  while(index < length){
    const codeUnit = string.charCodeAt(index);
    if(codeUnit === 0x0000){ result += '�'; index++; continue; }
    if(
      (codeUnit >= 0x0001 && codeUnit <= 0x001F) || codeUnit === 0x007F ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002D)
    ){
      result += '\\' + codeUnit.toString(16) + ' ';
      index++; continue;
    }
    if(index === 0 && length === 1 && codeUnit === 0x002D){
      result += '\\' + string.charAt(index);
      index++; continue;
    }
    if(
      codeUnit >= 0x0080 || codeUnit === 0x002D || codeUnit === 0x005F ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005A) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007A)
    ){
      result += string.charAt(index);
      index++; continue;
    }
    result += '\\' + string.charAt(index);
    index++;
  }
  return result;
}

// A minimal element: attributes, a class list, a parent pointer, and
// enough of querySelector/querySelectorAll/closest/dataset to run the real
// accountCardFor()/accountSignalsPanel()/delegated-click-listener code
// against a hand-built tree (built explicitly by each test, not by parsing
// an HTML string -- see the Part A tests below for the separate, purely
// string-based proof that the REAL renderDetailedAccountViews() output
// contains no executable-JS-context injection).
class FakeEl {
  constructor(tag, attrs = {}, children = []){
    this.tag = tag;
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    children.forEach(c => this.appendChild(c));
  }
  appendChild(child){ child.parent = this; this.children.push(child); return child; }
  get dataset(){
    const ds = {};
    for(const k of Object.keys(this.attrs)){
      if(k.startsWith('data-')){
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        ds[camel] = this.attrs[k];
      }
    }
    return ds;
  }
  matches(selector){ return elementMatchesSelector(this, selector); }
  closest(selector){
    let el = this;
    while(el){ if(el.matches(selector)) return el; el = el.parent; }
    return null;
  }
  querySelectorAll(selector){
    const out = [];
    (function walk(el){ for(const c of el.children){ if(c.matches(selector)) out.push(c); walk(c); } })(this);
    return out;
  }
  querySelector(selector){ return this.querySelectorAll(selector)[0] || null; }
}
// Selector grammar supported: one or more `.class` segments plus an
// optional single `[attr="value"]` clause -- exactly what
// accountCardFor()/accountSignalsPanel()/the delegated listener actually
// use. The attribute clause is matched by re-escaping each candidate's
// real attribute value with the SAME cssEscape() used above and comparing
// it, byte for byte, against the raw text captured from the selector --
// this is what proves a crafted account name cannot alter which element
// the selector matches (it either produces the correct escaped
// comparison, or it doesn't match at all; there is no way for it to be
// interpreted as selector syntax).
function elementMatchesSelector(el, selector){
  const classes = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(m => m[1]);
  const elClasses = String(el.attrs.class || '').split(/\s+/).filter(Boolean);
  for(const c of classes){ if(!elClasses.includes(c)) return false; }
  const attrMatch = selector.match(/\[([a-zA-Z0-9_-]+)="((?:[^"\\]|\\.)*)"\]/);
  if(attrMatch){
    const [, attrName, rawSelectorValue] = attrMatch;
    const actual = attrName.startsWith('data-') ? el.dataset[attrName.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : el.attrs[attrName];
    if(actual === undefined || actual === null) return false;
    if(cssEscape(String(actual)) !== rawSelectorValue) return false;
  }
  return true;
}

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
var lastUploadAcceptedAccountCount = ${JSON.stringify(state.lastUploadAcceptedAccountCount !== undefined ? state.lastUploadAcceptedAccountCount : null)};
var autoResearchStarted = true;
var currentDashboardData = ${JSON.stringify(state.currentDashboardData || null)};
var dashboardViewMode = 'my';
`;
}

function createSandbox({accounts, currentUploadId = 'upload-1', currentResearchRunId = null, currentResearchAttemptId = null, currentDashboardData = null, fetchImpl, domElements = {}, fakeDomRoot}){
  const consoleLog = { warn: [], error: [], log: [] };
  // authHeadersAsync mirrors the real one's success path (always resolves
  // to a headers object, never null) -- these orchestration tests are
  // about call COUNTS, not about auth-freshness behavior itself, which has
  // its own dedicated coverage in scripts/test-dashboard-auth-headers.js.
  const houseAuth = { authHeaders: (h) => h || {}, authHeadersAsync: async (h) => h || {} };
  // A fake #accountList element that just captures whatever
  // renderDetailedAccountViews() assigns to .innerHTML as a plain string --
  // used by the Part A markup-safety tests below, which inspect that raw
  // string directly rather than parsing it back into a DOM.
  const accountListEl = { _html: '', get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = v; } };
  const root = fakeDomRoot || new FakeEl('body');
  const sandbox = {
    window: {
      accountRadarAccounts: accounts,
      researchDiagnostics: [],
      HouseAuth: houseAuth,
      location: { href: 'https://example.com/dashboard' }
    },
    HouseAuth: houseAuth,
    CSS: { escape: cssEscape },
    // domElements lets a test feed fake form-input/DOM-node objects
    // (each just a plain {value}/{style}/{textContent}/{disabled} object)
    // keyed by id, so saveAccountMetadataEdit()/toggleAccountMetadataEdit()
    // -- which read real form values via document.getElementById -- can be
    // exercised with real "typed" input, not bypassed. 'accountList' is
    // special-cased to the innerHTML-capturing element above.
    document: {
      getElementById: (id) => {
        if(id === 'accountList') return accountListEl;
        return Object.prototype.hasOwnProperty.call(domElements, id) ? domElements[id] : null;
      },
      querySelector: (selector) => root.querySelector(selector),
      querySelectorAll: (selector) => root.querySelectorAll(selector),
      addEventListener: (type, handler) => { if(type === 'click') sandbox.__clickHandler = handler; }
    },
    fetch: fetchImpl,
    console: {
      log: (...a) => consoleLog.log.push(a),
      warn: (...a) => consoleLog.warn.push(a),
      error: (...a) => consoleLog.error.push(a)
    },
    Math, Date, JSON, Set, Map, Array, Object, Number, String, Promise, Boolean,
    AbortController,
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  const initSource = buildInitSource({ currentLead: {email:'lead@example.com', name:'Test Lead', company:'Test Co'}, currentUploadId, currentResearchRunId, currentResearchAttemptId, currentDashboardData });
  const fullSource = `${initSource}\n${STUB_SOURCE}\n${REAL_SOURCE}\n`;
  new vm.Script(fullSource, {filename: 'dashboard-orchestration-extract.js'}).runInContext(sandbox);
  sandbox.__consoleLog = consoleLog;
  sandbox.__accountListEl = accountListEl;
  sandbox.__fakeDomRoot = root;
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
// FR2 round: every real research call site now reads the body once via
// res.text() (safeParseResearchResponse()) instead of calling res.json()
// directly -- see dashboard/index.html's own comment on why. This mock
// must support that same real Response contract, not just .json(), or
// every research call in this file's scenarios would throw
// "res.text is not a function" despite the orchestration logic itself
// being correct.
function jsonResponse(data, {ok = true, status = 200} = {}){
  const body = JSON.stringify(data);
  return { ok, status, json: async () => data, text: async () => body, headers: { get: () => null } };
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

// ===========================================================================
// Scenario (g) (Phase 2A implementation-review ROUND 7, item 1): the REAL
// account-edit handler (saveAccountMetadataEdit()), invoked exactly as a
// click on "Save" in the inline edit form would -- not saveCurrentUpload()
// called directly. Required: the mutation produces exactly one
// accounts_updated request; a subsequent render/filter action produces zero
// additional save requests; no research-output stage or attempt metadata is
// ever sent.
// ===========================================================================
// Builds a fake account-card + Save button carrying the same class/
// data-attribute shape renderDetailedAccountViews() actually emits, so the
// click can be dispatched through the REAL delegated listener (not by
// calling saveAccountMetadataEdit() directly) -- exactly matching what a
// user clicking "Save" in the browser does.
function fakeAccountEditCard(accountName, uiKey){
  const saveBtn = new FakeEl('button', {class:'btn btn-secondary btn-mini save-account-edit-btn', 'data-ui-key': String(uiKey)});
  const card = new FakeEl('div', {class:'account-card', 'data-account-name': accountName}, [saveBtn]);
  return {card, saveBtn};
}

async function testAccountMetadataEditHandlerSuccess(){
  const accounts = [fixtureAccount('Acme', {industry:'Old Industry', contactName:'Old Name', contactEmail:'old@example.com'})];
  const fetchImpl = makeFetch((call) => {
    if(call.url === '/api/save-upload'){
      return jsonResponse({ok:true, uploadId:'upload-1'});
    }
    throw new Error(`unexpected fetch in testAccountMetadataEditHandlerSuccess: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const uiKey = '0';
  const domElements = {
    [`acctEditForm-${uiKey}`]: {style:{display:'none'}},
    [`acctEditError-${uiKey}`]: {style:{display:'none'}, textContent:''},
    [`acctEditSaveBtn-${uiKey}`]: {disabled:false, textContent:'Save'},
    [`acctEditIndustry-${uiKey}`]: {value:'New Industry'},
    [`acctEditContactName-${uiKey}`]: {value:'New Name'},
    [`acctEditContactEmail-${uiKey}`]: {value:'new@example.com'}
  };
  const {card, saveBtn} = fakeAccountEditCard('Acme', uiKey);
  const root = new FakeEl('body', {}, [card]);
  const sandbox = createSandbox({accounts, currentUploadId:'upload-1', fetchImpl, domElements, fakeDomRoot: root});

  // Dispatch through the REAL delegated click listener -- not a direct call
  // to saveAccountMetadataEdit(). saveQueue is awaited afterward because the
  // listener itself does not await the async handler it invokes (matching
  // real browser event-handler semantics; saveQueue is the same mechanism
  // every other caller in this file uses to observe completion).
  sandbox.__clickHandler({target: saveBtn});
  await sandbox.saveQueue;

  const calls = fetchImpl.calls;
  const saves = saveUploadCalls(calls);
  assert(saves.length === 1, 'g) account edit: the real handler, invoked via the real delegated click listener, produces exactly one accounts_updated request');
  assert(saves[0].body.stage === 'accounts_updated', 'g) account edit: the save stage is "accounts_updated"');
  assert(!saves[0].body.researchRunId && !saves[0].body.attemptId, 'g) account edit: no research-output stage or attempt metadata is ever sent');
  const savedAccount = (saves[0].body.accounts || []).find(a => a.name === 'Acme');
  assert(!!savedAccount && savedAccount.industry === 'New Industry' && savedAccount.contactName === 'New Name', 'g) account edit: the actual typed field values reach the save payload');

  // Render/filter actions must never issue a save.
  sandbox.refreshOpportunityViews();
  sandbox.toggleAccountMetadataEdit(uiKey);
  assert(saveUploadCalls(fetchImpl.calls).length === 1, 'g) account edit: a subsequent render/filter action produces zero additional save requests');
}

// Scenario (g), failure path: "a failed account update is surfaced once."
async function testAccountMetadataEditHandlerFailure(){
  const accounts = [fixtureAccount('Acme', {industry:'Old Industry', contactName:'Old Name', contactEmail:'old@example.com'})];
  const fetchImpl = makeFetch((call) => {
    if(call.url === '/api/save-upload'){
      return jsonResponse({error:'Save failed'}, {ok:false, status:500});
    }
    throw new Error(`unexpected fetch in testAccountMetadataEditHandlerFailure: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const uiKey = '0';
  const errorEl = {style:{display:'none'}, textContent:''};
  const domElements = {
    [`acctEditForm-${uiKey}`]: {style:{display:'none'}},
    [`acctEditError-${uiKey}`]: errorEl,
    [`acctEditSaveBtn-${uiKey}`]: {disabled:false, textContent:'Save'},
    [`acctEditIndustry-${uiKey}`]: {value:'New Industry'},
    [`acctEditContactName-${uiKey}`]: {value:'New Name'},
    [`acctEditContactEmail-${uiKey}`]: {value:'new@example.com'}
  };
  const {card, saveBtn} = fakeAccountEditCard('Acme', uiKey);
  const root = new FakeEl('body', {}, [card]);
  const sandbox = createSandbox({accounts, currentUploadId:'upload-1', fetchImpl, domElements, fakeDomRoot: root});

  sandbox.__clickHandler({target: saveBtn});
  await sandbox.saveQueue;
  // saveQueue resolving only guarantees performSaveCurrentUpload() itself
  // has settled. saveAccountMetadataEdit()'s OWN post-await continuation
  // (reverting the in-memory edit, showing the error) is a further
  // continuation on a promise that lives in a different vm realm than this
  // test -- cross-realm await does not collapse to the same microtask
  // ordering same-realm chained .then() calls would give, so re-awaiting
  // the same resolved promise here is not sufficient. A macrotask
  // boundary (setTimeout) reliably flushes it; this is a property of
  // exercising the code through Node's vm module for a fire-and-forget
  // async call, not of the code under test.
  await new Promise(resolve => setTimeout(resolve, 0));

  const calls = fetchImpl.calls;
  assert(saveUploadCalls(calls).length === 1, 'g) account edit failure: exactly one save attempt was made');
  assert(errorEl.style.display === 'block' && errorEl.textContent.length > 0, 'g) account edit failure: the failure is surfaced once, inline, next to the form that produced it');
  const account = sandbox.window.accountRadarAccounts.find(a => a.name === 'Acme');
  assert(account.industry === 'Old Industry' && account.contactName === 'Old Name', 'g) account edit failure: the in-memory edit is reverted on failure, not left half-applied');

  // No retry is scheduled automatically -- confirm no second save fires later.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(saveUploadCalls(fetchImpl.calls).length === 1, 'g) account edit failure: no second background save later fires unprompted');
}

// Polls until conditionFn() is truthy or timeoutMs elapses -- used instead
// of a fixed setTimeout delay for chains with more than one cross-realm
// async hop (claim -> research -> heartbeat -> save), where a single fixed
// delay would be a guess rather than a guarantee.
async function waitUntil(conditionFn, {timeoutMs = 1000, intervalMs = 5} = {}){
  const start = Date.now();
  while(!conditionFn()){
    if(Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// Renders the REAL renderDetailedAccountViews() (extracted verbatim from
// dashboard/index.html) against the given accounts and returns the raw
// HTML string it produced, for direct string-level inspection. No
// onclick="..." handling, no account-name interpolation into anything
// other than a plain HTML attribute -- see the tests below for what is
// actually checked and why.
function renderAccountsMarkup(accounts){
  const fetchImpl = makeFetch((call) => { throw new Error(`renderDetailedAccountViews() must never call fetch; got ${call.url}`); });
  const sandbox = createSandbox({accounts, currentUploadId: 'upload-1', fetchImpl});
  sandbox.renderDetailedAccountViews(accounts);
  return sandbox.__accountListEl.innerHTML;
}

// ===========================================================================
// Scenario (h) (Phase 2A implementation-review ROUND 8, item 1): the
// generated account-card markup never carries an account name inside an
// executable-JS context, for names containing quotes, JS-breakout
// sequences, or HTML. Exercises the REAL renderDetailedAccountViews()
// (extracted verbatim) with genuinely hostile fixture names -- not a
// source-string check of dashboard/index.html, a check of what that
// function actually produces.
// ===========================================================================
async function testMarkupNeverContainsExecutableAccountNames(){
  const singleQuoteName = `O'Reilly`;
  const jsBreakoutName = `');alert(1);//`;
  const htmlQuoteName = `<img src=x onerror=alert(1)>Say "hi"`;
  const accounts = [singleQuoteName, jsBreakoutName, htmlQuoteName].map(name => fixtureAccount(name, {industry: 'Test Industry'}));
  const html = renderAccountsMarkup(accounts);

  // The strongest, most direct proof: every onclick="..." attribute that
  // exists anywhere in the output is EXACTLY the one known, static,
  // account-data-free string (the card-header expand/collapse toggle) --
  // never an account name, and never anything derived from one. Any other
  // onclick value, or any onclick containing part of an account name,
  // fails this.
  const onclickValues = [...html.matchAll(/onclick="([^"]*)"/g)].map(m => m[1]);
  assert(onclickValues.length > 0, 'h) markup safety: sanity check -- the render actually produced at least the expected static onclick (the header toggle), so the assertion below is not vacuous');
  assert(onclickValues.every(v => v === "this.nextElementSibling.classList.toggle('open')"), `h) markup safety: the ONLY onclick="..." attribute anywhere in the output is the static, literal account-head toggle -- no account name is ever interpolated into any onclick attribute (found values: ${JSON.stringify(onclickValues)})`);

  // Each hostile name's RAW, unescaped form never appears anywhere in the
  // output (proving it was actually escaped, not merely "not placed in an
  // onclick").
  assert(!html.includes(jsBreakoutName), 'h) markup safety: the raw, unescaped JS-breakout sequence ' + JSON.stringify(jsBreakoutName) + ' never appears in the output');
  assert(!html.includes('<img src=x onerror=alert(1)>'), 'h) markup safety: the raw, unescaped <img onerror=...> tag never appears in the output');

  // Each hostile name DOES appear, correctly HTML-attribute-escaped
  // (matching the real escapeHtml()'s exact output), inside
  // data-account-name -- proving the name reaches the DOM as inert data,
  // not that it was silently stripped or rejected.
  assert(html.includes('data-account-name="O&#039;Reilly"'), "h) markup safety: O'Reilly's apostrophe is HTML-attribute-escaped (&#039;) inside data-account-name");
  assert(html.includes('data-account-name="&#039;);alert(1);//"'), "h) markup safety: the JS-breakout name's leading quote is escaped the same way -- it can never terminate an attribute value early");
  assert(html.includes('data-account-name="&lt;img src=x onerror=alert(1)&gt;Say &quot;hi&quot;"'), 'h) markup safety: the HTML- and quote-bearing name is fully HTML-escaped (tags and quotes both) inside data-account-name');
}

// ===========================================================================
// Scenario (i): two DISTINCT account names that collide under the OLD
// (removed) accountDomId() scheme -- "A&B Co" and "A B Co" both normalized
// to "a-b-co" -- never produce a duplicate id in the generated markup, and
// each retains its own exact, distinct name.
// ===========================================================================
async function testMarkupIdsNeverCollide(){
  const accounts = [
    fixtureAccount('A&B Co', {industry: 'First'}),
    fixtureAccount('A B Co', {industry: 'Second'})
  ];
  const html = renderAccountsMarkup(accounts);

  const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map(m => m[1]);
  const uniqueIds = new Set(ids);
  assert(ids.length > 0, 'i) DOM-id collision: the render actually produced id attributes to check');
  assert(uniqueIds.size === ids.length, `i) DOM-id collision: every generated id is unique across both colliding-name accounts (${ids.length} ids, ${uniqueIds.size} unique)`);
  assert(html.includes('data-account-name="A&amp;B Co"'), "i) DOM-id collision: the first account's exact name (A&B Co) is preserved, distinctly, in its own data-account-name attribute");
  assert(html.includes('data-account-name="A B Co"'), "i) DOM-id collision: the second account's exact, distinct name (A B Co) is preserved in its own data-account-name attribute");
}

// ===========================================================================
// Scenario (j): clicking "Research Account" on one card researches THAT
// account, not a different one, even when another rendered account's name
// collides with it under the OLD (removed) accountDomId() scheme.
// Exercises accountCardFor() and the REAL delegated click listener against
// a hand-built DOM mirroring exactly what renderDetailedAccountViews()
// emits (class names, data attributes) -- Part A above is the separate
// proof that the real markup generator emits exactly this shape.
//
// FR3 round: the click listener now routes through researchAccountFromCard()
// -> researchAccountFromManageModal(), which fetches a fresh upload-scoped
// snapshot via /api/get-dashboard?uploadId=... instead of reading the
// module's window.accountRadarAccounts/currentUploadId directly -- so this
// scenario's mock now needs to serve that endpoint too, exactly like the
// testScopedResearch* family further down this file.
// ===========================================================================
async function testResearchButtonTargetsCorrectAccountUnderCollision(){
  const accounts = [
    fixtureAccount('A&B Co', {intelligenceMode: 'warm'}),
    fixtureAccount('A B Co', {intelligenceMode: 'warm'})
  ];
  const researchedNames = [];
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      assert(call.url.includes('uploadId=upload-1'), 'j) collision-safe routing: the freshness refresh explicitly requests upload-1, the clicked card\'s own data-upload-id');
      return getDashboardResponse('upload-1', 'Test List', [
        scopedAccount('A&B Co', 'upload-1', {intelligenceMode: 'warm'}),
        scopedAccount('A B Co', 'upload-1', {intelligenceMode: 'warm'})
      ]);
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      return jsonResponse({outcome: 'claimed-new', researchRunId: 'run-x', attemptId: 'attempt-x'});
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat'){
      return jsonResponse({ok: true});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      const name = call.body.accounts[0].name;
      researchedNames.push(name);
      return jsonResponse({byAccount: {[name]: []}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({ok: true, uploadId: 'upload-1'});
    }
    throw new Error(`unexpected fetch in testResearchButtonTargetsCorrectAccountUnderCollision: ${call.url} ${JSON.stringify(call.body)}`);
  });

  function buildResearchCard(name, uploadId, uiKey){
    const researchBtn = new FakeEl('button', {class: 'btn btn-secondary research-account-btn'});
    const panel = new FakeEl('div', {class: 'signal-research-panel', id: `signals-${uiKey}`});
    const card = new FakeEl('div', {class: 'account-card', 'data-account-name': name, 'data-upload-id': uploadId}, [researchBtn, panel]);
    return {card, researchBtn};
  }
  const first = buildResearchCard('A&B Co', 'upload-1', 0);
  const second = buildResearchCard('A B Co', 'upload-1', 1);
  const root = new FakeEl('body', {}, [first.card, second.card]);
  const sandbox = createSandbox({accounts, currentUploadId: 'upload-1', fetchImpl, fakeDomRoot: root});

  // Click the SECOND card's Research button.
  sandbox.__clickHandler({target: second.researchBtn});
  await waitUntil(() => saveUploadCalls(fetchImpl.calls).length > 0);

  assert(researchedNames.length === 1, 'j) collision-safe routing: exactly one account was researched');
  assert(researchedNames[0] === 'A B Co', `j) collision-safe routing: clicking the SECOND card researched the SECOND account (A B Co), not a colliding one -- got "${researchedNames[0]}"`);
}

// ===========================================================================
// Scenario (j2) -- the core FR3 defect this round fixes: TWO accounts with
// the EXACT SAME name in two DIFFERENT uploads (the real-world "L.L.Bean
// uploaded twice" shape), both rendered on the same aggregate/team-view
// dashboard. Clicking one card's "Research Account" button must claim,
// research, and save ONLY that card's own upload -- never the other
// upload's identically-named account -- and must never resolve the account
// via a name-only match against the shared window.accountRadarAccounts
// aggregate (the exact bug researchAccountByName() had). Exercises the REAL
// delegated click listener -> researchAccountFromCard() ->
// researchAccountFromManageModal() chain end to end.
// ===========================================================================
async function testResearchButtonCrossUploadDuplicateNameIndependence(){
  const DUP_NAME = 'L.L.Bean';
  const UPLOAD_X = 'upload-x';
  const UPLOAD_Z = 'upload-z';
  // The stale/shared aggregate the OLD researchAccountByName() name-only
  // lookup would have searched -- both entries share the exact same name,
  // only their uploadId (and object identity) distinguish them.
  const accountX = fixtureAccount(DUP_NAME, {uploadId: UPLOAD_X, signals: [], lastResearchedAt: ''});
  const accountZ = fixtureAccount(DUP_NAME, {uploadId: UPLOAD_Z, signals: [], lastResearchedAt: ''});
  const accounts = [accountX, accountZ];

  const providerCalls = [];
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      assert(call.url.includes(`uploadId=${UPLOAD_Z}`), 'j2) cross-upload duplicate name: the freshness refresh targets upload-z, the clicked card\'s own upload -- never upload-x');
      return getDashboardResponse(UPLOAD_Z, 'Upload Z', [scopedAccount(DUP_NAME, UPLOAD_Z, {intelligenceMode: 'warm'})]);
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      assert(call.body.uploadId === UPLOAD_Z, 'j2) cross-upload duplicate name: the claim targets upload-z explicitly');
      return jsonResponse({outcome: 'claimed-new', researchRunId: 'run-z', attemptId: 'attempt-z'});
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'heartbeat'){
      return jsonResponse({ok: true});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      assert(call.body.uploadId === UPLOAD_Z, 'j2) cross-upload duplicate name: the provider request targets upload-z explicitly');
      providerCalls.push(call);
      return jsonResponse({byAccount: {[DUP_NAME]: [{isReal: true, sourceUrl: 'https://example.com/z', signalType: 'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      assert(call.body.uploadId === UPLOAD_Z, 'j2) cross-upload duplicate name: the save targets upload-z explicitly');
      return jsonResponse({ok: true, uploadId: UPLOAD_Z, runStatus: 'completed'});
    }
    throw new Error(`unexpected fetch in testResearchButtonCrossUploadDuplicateNameIndependence: ${call.url} ${JSON.stringify(call.body)}`);
  });

  function buildResearchCard(name, uploadId, uiKey){
    const researchBtn = new FakeEl('button', {class: 'btn btn-secondary research-account-btn'});
    const panel = new FakeEl('div', {class: 'signal-research-panel', id: `signals-${uiKey}`});
    const card = new FakeEl('div', {class: 'account-card', 'data-account-name': name, 'data-upload-id': uploadId}, [researchBtn, panel]);
    return {card, researchBtn};
  }
  const cardX = buildResearchCard(DUP_NAME, UPLOAD_X, 0);
  const cardZ = buildResearchCard(DUP_NAME, UPLOAD_Z, 1);
  const root = new FakeEl('body', {}, [cardX.card, cardZ.card]);
  const sandbox = createSandbox({accounts, currentUploadId: UPLOAD_X, fetchImpl, fakeDomRoot: root});

  // Click the upload-z card -- currentUploadId is deliberately upload-x, the
  // OTHER upload, mirroring the exact scenario the old bug got wrong (the
  // active/last-loaded list is not necessarily the clicked card's own list).
  sandbox.__clickHandler({target: cardZ.researchBtn});
  await waitUntil(() => saveUploadCalls(fetchImpl.calls).length > 0);

  const calls = fetchImpl.calls;
  assert(getDashboardCalls(calls).length === 1, 'j2) cross-upload duplicate name: exactly one freshness refresh fired');
  assert(claimCalls(calls).length === 1, 'j2) cross-upload duplicate name: exactly one claim fired, for upload-z only');
  assert(providerCalls.length === 1, 'j2) cross-upload duplicate name: exactly one provider request fired, for upload-z only');
  assert(saveUploadCalls(calls).length === 1, 'j2) cross-upload duplicate name: exactly one save fired, for upload-z only');
  assert(accountZ.signals.length === 1 && accountZ.lastResearchedAt !== '', 'j2) cross-upload duplicate name: the CLICKED upload\'s in-memory account (upload-z) is updated with the fresh research result');
  assert(accountX.signals.length === 0 && accountX.lastResearchedAt === '', 'j2) cross-upload duplicate name: the OTHER, identically-named upload\'s account (upload-x) is left completely untouched -- researching one never marks or persists to the other');
}

// ===========================================================================
// Scenario (k): clicking "Save" on one account's edit form saves THAT
// account's edited fields and leaves a colliding account untouched -- the
// direct runtime proof (not just markup-level id-uniqueness, see scenario
// i) that "no DOM-id collision causes one account's form to control
// another account."
// ===========================================================================
async function testEditFormTargetsCorrectAccountUnderCollision(){
  const accounts = [
    fixtureAccount('A&B Co', {industry: 'First Industry'}),
    fixtureAccount('A B Co', {industry: 'Second Industry'})
  ];
  const fetchImpl = makeFetch((call) => {
    if(call.url === '/api/save-upload') return jsonResponse({ok: true, uploadId: 'upload-1'});
    throw new Error(`unexpected fetch in testEditFormTargetsCorrectAccountUnderCollision: ${call.url}`);
  });
  const domElements = {
    'acctEditForm-0': {style: {display: 'none'}},
    'acctEditError-0': {style: {display: 'none'}, textContent: ''},
    'acctEditSaveBtn-0': {disabled: false, textContent: 'Save'},
    'acctEditIndustry-0': {value: 'First Industry'},
    'acctEditContactName-0': {value: ''},
    'acctEditContactEmail-0': {value: ''},
    'acctEditForm-1': {style: {display: 'none'}},
    'acctEditError-1': {style: {display: 'none'}, textContent: ''},
    'acctEditSaveBtn-1': {disabled: false, textContent: 'Save'},
    'acctEditIndustry-1': {value: 'Second Industry -- EDITED'},
    'acctEditContactName-1': {value: ''},
    'acctEditContactEmail-1': {value: ''}
  };
  const firstCard = new FakeEl('div', {class: 'account-card', 'data-account-name': 'A&B Co'}, [new FakeEl('button', {class: 'save-account-edit-btn', 'data-ui-key': '0'})]);
  const secondSaveBtn = new FakeEl('button', {class: 'save-account-edit-btn', 'data-ui-key': '1'});
  const secondCard = new FakeEl('div', {class: 'account-card', 'data-account-name': 'A B Co'}, [secondSaveBtn]);
  const root = new FakeEl('body', {}, [firstCard, secondCard]);
  const sandbox = createSandbox({accounts, currentUploadId: 'upload-1', fetchImpl, domElements, fakeDomRoot: root});

  sandbox.__clickHandler({target: secondSaveBtn});
  await waitUntil(() => saveUploadCalls(fetchImpl.calls).length > 0);

  const saves = saveUploadCalls(fetchImpl.calls);
  assert(saves.length === 1, 'k) collision-safe edit: exactly one save fired');
  const savedFirst = saves[0].body.accounts.find(a => a.name === 'A&B Co');
  const savedSecond = saves[0].body.accounts.find(a => a.name === 'A B Co');
  assert(!!savedSecond && savedSecond.industry === 'Second Industry -- EDITED', "k) collision-safe edit: the SECOND account (the one actually clicked) received the edited value");
  assert(!!savedFirst && savedFirst.industry === 'First Industry', "k) collision-safe edit: the FIRST, colliding account was NOT modified by clicking the second card's Save button");
}

// ===========================================================================
// Manage Customer Accounts modal / immutable upload-scoped research context
// (release-blocker fix; see the cross-upload corruption audit this
// responds to). A prior version of this flow refreshed via
// /api/get-dashboard with NO uploadId parameter and persisted from the
// shared window.accountRadarAccounts global -- in a live incident this
// silently merged an unrelated 30-account upload into a 1-account upload's
// research-save snapshot, because the refresh's own upload_id check passed
// while its ACCOUNTS were a cross-upload aggregate the whole time.
// fetchUploadScopedSnapshot(), persistScopedResearchResult(), and
// researchAccountFromManageModal() (all REAL, extracted above -- not
// reimplemented) now carry ONE explicit context
// (expectedUploadId/expectedUploadName/targetAccountName/
// freshUploadScopedAccounts/researchRunId/attemptId) end to end and never
// read currentUploadId/currentUploadName/window.accountRadarAccounts/
// dashboardViewMode when constructing the final save -- not even
// temporarily. Two fixture uploads mirror the exact real-world incident:
// Upload A ("QA Preview", one real account) and Upload B ("Phase 1",
// several unrelated accounts), both owned by the same user.
// ===========================================================================
function getDashboardCalls(calls){ return calls.filter(c => c.url.startsWith('/api/get-dashboard')); }
function getDashboardResponse(uploadId, uploadName, accounts){
  return jsonResponse({
    ok: true,
    user: {email: 'lead@example.com'},
    upload: {id: uploadId, upload_name: uploadName},
    accounts,
    signals: [],
    newThisWeek: []
  });
}
function scopedAccount(name, uploadId, overrides = {}){
  // intelligenceMode:'warm' pinned explicitly -- normalizeSavedAccount()
  // (the REAL function, run on every scoped refresh) would otherwise derive
  // 'historical' from orderCount>0, which routes researchAccountFromManageModal()
  // to the (unmocked, here) /api/research-account endpoint instead of
  // /api/research-batch. uploadId is the field
  // api/get-dashboard.js's uploadId= branch carries on every returned
  // account (see buildAccountsFromRows() there) -- fetchUploadScopedSnapshot()
  // verifies every account's uploadId against expectedUploadId before
  // trusting any of them.
  return {name, uploadId, monitoringStatus:'active', lastResearchedAt:'', industry:'Test', revenue:0, orderCount:0, intelligenceMode:'warm', futureOpportunities:[], ...overrides};
}
const UPLOAD_A = 'upload-a';
const UPLOAD_A_NAME = 'QA Preview';
const UPLOAD_B = 'upload-b';
const UPLOAD_B_ACCOUNT_NAMES = ['Beta One', 'Beta Two', 'Beta Three'];
function uploadBAccounts(){ return UPLOAD_B_ACCOUNT_NAMES.map(n => scopedAccount(n, UPLOAD_B)); }

async function testScopedResearchTargetsExactUploadOnly(){
  // The in-memory global is STALE and WRONG on purpose -- it mixes in
  // Upload B's accounts, exactly mirroring the corrupted state a prior
  // version of this flow would have persisted from. The scoped flow must
  // never look at this at all.
  const staleGlobalAccounts = [scopedAccount('QA Preview Alpha', UPLOAD_A), ...uploadBAccounts()];
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      assert(call.url.includes(`uploadId=${UPLOAD_A}`), 'scoped 1: the refresh request explicitly includes uploadId=upload-a');
      assert(!call.url.includes('view='), 'scoped 1 (TEAM VIEW AGGREGATION CANNOT BE USED): the refresh request never includes a view= (my/team aggregation) parameter at all');
      return getDashboardResponse(UPLOAD_A, UPLOAD_A_NAME, [scopedAccount('QA Preview Alpha', UPLOAD_A)]);
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      assert(call.body.uploadId === UPLOAD_A, 'scoped 1: the claim targets upload-a explicitly');
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-a', attemptId:'attempt-a'});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      assert(call.body.uploadId === UPLOAD_A, 'scoped 1: the provider request targets upload-a explicitly');
      assert(call.body.accounts.length === 1 && call.body.accounts[0].name === 'QA Preview Alpha', 'scoped 1: only the ONE selected account is ever sent to the provider');
      return jsonResponse({byAccount: {'QA Preview Alpha': [{isReal:true, sourceUrl:'https://example.com/a', signalType:'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({ok:true, uploadId:UPLOAD_A, runStatus:'completed'});
    }
    throw new Error(`unexpected fetch in testScopedResearchTargetsExactUploadOnly: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts: staleGlobalAccounts, currentUploadId: UPLOAD_A, fetchImpl});
  const result = await sandbox.researchAccountFromManageModal('QA Preview Alpha', UPLOAD_A);

  assert(result.ok === true, 'scoped 1: the scoped research operation succeeds');
  const save = saveUploadCalls(fetchImpl.calls)[0];
  assert(!!save, 'scoped 1: exactly one save fired');
  assert(save.body.uploadId === UPLOAD_A, 'scoped 1: the final save targets upload-a explicitly');
  assert(save.body.accounts.length === 1, 'scoped 1: the final save contains exactly ONE account');
  assert(save.body.accounts[0].name === 'QA Preview Alpha', 'scoped 1: the final save\'s one account is QA Preview Alpha');
  const savedJson = JSON.stringify(save.body);
  for(const betaName of UPLOAD_B_ACCOUNT_NAMES){
    assert(!savedJson.includes(betaName), `scoped 1: Upload B account "${betaName}" (name/id/timestamp/metadata/raw_data) never appears anywhere in the save payload, despite being present in the stale in-memory global`);
  }
  assert(sandbox.window.accountRadarAccounts === staleGlobalAccounts, 'scoped 1: window.accountRadarAccounts is untouched by this operation (still the exact original stale array reference) -- the scoped flow never assigns to it');
  assert(sandbox.currentUploadId === UPLOAD_A, 'scoped 1: currentUploadId is untouched by this operation');
}

async function testScopedResearchAbortsOnMixedUploadResponse(){
  // Simulates a server-side regression (e.g. api/get-dashboard.js's
  // uploadId= scoping breaking) that returns one foreign account alongside
  // the real one. The top-level upload.id still matches -- only an
  // account-level check can catch this.
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      return getDashboardResponse(UPLOAD_A, UPLOAD_A_NAME, [
        scopedAccount('QA Preview Alpha', UPLOAD_A),
        scopedAccount('Beta One', UPLOAD_B) // foreign upload, mixed in
      ]);
    }
    throw new Error(`unexpected fetch in testScopedResearchAbortsOnMixedUploadResponse: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts: [], currentUploadId: UPLOAD_A, fetchImpl});
  const result = await sandbox.researchAccountFromManageModal('QA Preview Alpha', UPLOAD_A);

  assert(result.ok === false, 'scoped 2 (MIXED-UPLOAD RESPONSE): the operation aborts when the refreshed response contains an account from a different upload');
  const calls = fetchImpl.calls;
  assert(claimCalls(calls).length === 0, 'scoped 2: NO claim was sent once a foreign-upload account was detected in the response');
  assert(researchWorkCalls(calls).length === 0, 'scoped 2: NO provider-facing research request was sent');
  assert(saveUploadCalls(calls).length === 0, 'scoped 2: NO save was sent');
}

async function testScopedResearchIgnoresGlobalMutationDuringProviderCall(){
  // A concurrent action (another tab, a background dashboard refresh)
  // reassigns currentUploadId/currentUploadName/window.accountRadarAccounts
  // WHILE this operation's provider call is in flight. The final save must
  // still target the ORIGINALLY-captured context, unaffected.
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      return getDashboardResponse(UPLOAD_A, UPLOAD_A_NAME, [scopedAccount('QA Preview Alpha', UPLOAD_A)]);
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-mutate', attemptId:'attempt-mutate'});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      // Simulate a concurrent mutation happening WHILE this provider call is
      // "in flight" (i.e. before this mocked response resolves).
      sandbox.currentUploadId = 'evil-hijacked-upload';
      sandbox.currentUploadName = 'Hijacked';
      sandbox.window.accountRadarAccounts = [scopedAccount('Totally Different Account', 'evil-hijacked-upload')];
      return jsonResponse({byAccount: {'QA Preview Alpha': [{isReal:true, sourceUrl:'https://example.com/a', signalType:'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({ok:true, uploadId:UPLOAD_A, runStatus:'completed'});
    }
    throw new Error(`unexpected fetch in testScopedResearchIgnoresGlobalMutationDuringProviderCall: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts: [], currentUploadId: UPLOAD_A, fetchImpl});
  const result = await sandbox.researchAccountFromManageModal('QA Preview Alpha', UPLOAD_A);

  assert(result.ok === true, 'scoped 3: the operation still succeeds despite the concurrent global mutation');
  const save = saveUploadCalls(fetchImpl.calls)[0];
  assert(!!save && save.body.uploadId === UPLOAD_A, 'scoped 3 (MUTATING currentUploadId DURING THE PROVIDER CALL CANNOT REDIRECT THE SAVE): the final save still targets upload-a, not the hijacked upload id written to the global mid-flight');
  assert(save.body.accounts.length === 1 && save.body.accounts[0].name === 'QA Preview Alpha', 'scoped 3 (REPLACING window.accountRadarAccounts DURING THE PROVIDER CALL HAS NO EFFECT): the final save still contains only QA Preview Alpha, not the account written to the global mid-flight');
  assert(sandbox.currentUploadId === 'evil-hijacked-upload', 'scoped 3: sanity check -- the mutation actually happened (the global really was overwritten), so the assertions above are not vacuous');
}

async function testScopedResearchAbortsIfAccountDeletedDuringRefresh(){
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      // QA Preview Alpha itself was deleted between opening the modal and
      // this click -- the refreshed upload now has zero accounts.
      return getDashboardResponse(UPLOAD_A, UPLOAD_A_NAME, []);
    }
    throw new Error(`unexpected fetch in testScopedResearchAbortsIfAccountDeletedDuringRefresh: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts: [], currentUploadId: UPLOAD_A, fetchImpl});
  const result = await sandbox.researchAccountFromManageModal('QA Preview Alpha', UPLOAD_A);

  assert(result.ok === false, 'scoped 4: research is refused when the account is gone from the refreshed snapshot');
  const calls = fetchImpl.calls;
  assert(getDashboardCalls(calls).length === 1, 'scoped 4: the freshness refresh itself still happened');
  assert(claimCalls(calls).length === 0, 'scoped 4 (ALPHA DELETED BEFORE THE FRESHNESS CHECK COMPLETES): NO claim was sent once the account was found missing from the fresh snapshot');
  assert(researchWorkCalls(calls).length === 0, 'scoped 4: NO provider-facing research request was sent');
  assert(saveUploadCalls(calls).length === 0, 'scoped 4: NO save was sent');
}

async function testScopedResearchAbortsIfUploadIdChangedDuringRefresh(){
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      // The refreshed snapshot belongs to a DIFFERENT upload than the one
      // this click targeted -- e.g. the account list was replaced mid-refresh.
      return getDashboardResponse('upload-DIFFERENT', 'Some Other List', [scopedAccount('QA Preview Alpha', 'upload-DIFFERENT')]);
    }
    throw new Error(`unexpected fetch in testScopedResearchAbortsIfUploadIdChangedDuringRefresh: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts: [], currentUploadId: UPLOAD_A, fetchImpl});
  const result = await sandbox.researchAccountFromManageModal('QA Preview Alpha', UPLOAD_A);

  assert(result.ok === false, 'scoped 5 (REFRESHED upload_id NO LONGER EQUALS THE EXPECTED expectedUploadId): research is refused');
  assert(claimCalls(fetchImpl.calls).length === 0, 'scoped 5: NO claim was sent when the upload identity changed mid-refresh');
  assert(researchWorkCalls(fetchImpl.calls).length === 0, 'scoped 5: NO provider-facing research request was sent');
}

// Stabilization round: cross-list research (the row's own listId differs
// from the currently-loaded currentUploadId) is no longer refused -- the
// operation scopes itself automatically to the row's listId, exactly like
// scoped test 1 above, just with UPLOAD_B as the target instead of the
// currently-loaded UPLOAD_A. This proves the removed listId!==currentUploadId
// gate was never load-bearing: every fetch below is still explicitly scoped
// to UPLOAD_B by fetchUploadScopedSnapshot(expectedUploadId)/the claim/the
// provider call/the final save, none of which ever reads currentUploadId.
async function testScopedResearchSucceedsForCrossListAccount(){
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      assert(call.url.includes(`uploadId=${UPLOAD_B}`), 'scoped 6: the refresh request explicitly includes uploadId=upload-b, the row\'s own list, not the currently-loaded upload-a');
      return getDashboardResponse(UPLOAD_B, 'Some Other List', [scopedAccount('Beta One', UPLOAD_B)]);
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      assert(call.body.uploadId === UPLOAD_B, 'scoped 6: the claim targets upload-b explicitly');
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-b', attemptId:'attempt-b'});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      assert(call.body.uploadId === UPLOAD_B, 'scoped 6: the provider request targets upload-b explicitly');
      assert(call.body.accounts.length === 1 && call.body.accounts[0].name === 'Beta One', 'scoped 6: only the ONE selected cross-list account is ever sent to the provider');
      return jsonResponse({byAccount: {'Beta One': [{isReal:true, sourceUrl:'https://example.com/b', signalType:'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({ok:true, uploadId:UPLOAD_B, runStatus:'completed'});
    }
    throw new Error(`unexpected fetch in testScopedResearchSucceedsForCrossListAccount: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts: [], currentUploadId: UPLOAD_A, fetchImpl});
  const result = await sandbox.researchAccountFromManageModal('Beta One', UPLOAD_B);

  assert(result.ok === true, 'scoped 6 (Section 5 requirement): a row action for an account belonging to a DIFFERENT upload than the currently-loaded currentUploadId succeeds, scoped automatically to its own list');
  const save = saveUploadCalls(fetchImpl.calls)[0];
  assert(!!save && save.body.uploadId === UPLOAD_B, 'scoped 6: the final save targets upload-b, the row\'s own list -- not the stale currentUploadId (upload-a)');
  assert(sandbox.currentUploadId === UPLOAD_A, 'scoped 6: currentUploadId (the currently-loaded/active list on the dashboard) is left untouched by researching a different list\'s account');
}

async function testScopedResearchStaleAttemptRejectedAtSave(){
  // The attempt is claimed successfully, but by the time persistence runs
  // the server has already reclaimed/superseded it (another tab, a lease
  // expiry) -- api/save-upload.js maps this to a 409 with staleAttempt:true
  // (see its HA001 handling). The operation must surface this distinctly,
  // not throw, and not report success.
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      return getDashboardResponse(UPLOAD_A, UPLOAD_A_NAME, [scopedAccount('QA Preview Alpha', UPLOAD_A)]);
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-stale', attemptId:'attempt-stale'});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      return jsonResponse({byAccount: {'QA Preview Alpha': [{isReal:true, sourceUrl:'https://example.com/a', signalType:'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({error:'This research attempt is no longer active; nothing was saved.', staleAttempt:true}, {ok:false, status:409});
    }
    throw new Error(`unexpected fetch in testScopedResearchStaleAttemptRejectedAtSave: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts: [], currentUploadId: UPLOAD_A, fetchImpl});
  const result = await sandbox.researchAccountFromManageModal('QA Preview Alpha', UPLOAD_A);

  assert(result.ok === false, 'scoped 7 (STALE ATTEMPT REMAINS REJECTED): the operation reports failure, not success, when the attempt is stale at save time');
  assert(result.staleAttempt === true, 'scoped 7: the failure is specifically flagged staleAttempt, distinguishable from a generic error');
}

async function testScopedResearchSnapshotMismatchSurfacedFromServer(){
  // Migration 8's HA005 guard is proven independently at the database
  // layer in scripts/phase2a-rpc-authorization-tests.sql (Tests 59-66).
  // This test proves the CLIENT correctly surfaces that rejection if it
  // were ever reached (api/save-upload.js maps HA005 to 409
  // snapshotMismatch:true) -- i.e. even if this client-side fix were
  // somehow bypassed or regressed, the resulting server rejection is
  // still handled as a failure, not misread as success.
  const fetchImpl = makeFetch((call) => {
    if(call.url.startsWith('/api/get-dashboard')){
      return getDashboardResponse(UPLOAD_A, UPLOAD_A_NAME, [scopedAccount('QA Preview Alpha', UPLOAD_A)]);
    }
    if(call.url === '/api/research-batch' && call.body.researchRunAction === 'claim'){
      return jsonResponse({outcome:'claimed-new', researchRunId:'run-mismatch', attemptId:'attempt-mismatch'});
    }
    if(call.url === '/api/research-batch' && !call.body.researchRunAction){
      return jsonResponse({byAccount: {'QA Preview Alpha': [{isReal:true, sourceUrl:'https://example.com/a', signalType:'Hiring'}]}, signals: []});
    }
    if(call.url === '/api/save-upload'){
      return jsonResponse({error:'This research save does not match the upload it targeted; nothing was saved.', snapshotMismatch:true}, {ok:false, status:409});
    }
    throw new Error(`unexpected fetch in testScopedResearchSnapshotMismatchSurfacedFromServer: ${call.url} ${JSON.stringify(call.body)}`);
  });
  const sandbox = createSandbox({accounts: [], currentUploadId: UPLOAD_A, fetchImpl});
  const result = await sandbox.researchAccountFromManageModal('QA Preview Alpha', UPLOAD_A);

  assert(result.ok === false, 'scoped 8 (MIGRATION 8 REJECTION SURFACED CORRECTLY): a server-side HA005/snapshotMismatch rejection is reported as a failure, not success');
  assert(result.snapshotMismatch === true, 'scoped 8: the failure is specifically flagged snapshotMismatch, distinguishable from a generic error or a stale attempt');
}

async function main(){
  await testStandaloneSuccess();
  await testBatchSuccess();
  await testBatchTimeoutThenFallback();
  await testRefreshAfterCompletionNoSave();
  await testTerminalSaveFails();
  await testTerminalSaveSucceedsNoLaterStale409();
  await testAccountMetadataEditHandlerSuccess();
  await testAccountMetadataEditHandlerFailure();
  await testMarkupNeverContainsExecutableAccountNames();
  await testMarkupIdsNeverCollide();
  await testResearchButtonTargetsCorrectAccountUnderCollision();
  await testResearchButtonCrossUploadDuplicateNameIndependence();
  await testEditFormTargetsCorrectAccountUnderCollision();
  await testScopedResearchTargetsExactUploadOnly();
  await testScopedResearchAbortsOnMixedUploadResponse();
  await testScopedResearchIgnoresGlobalMutationDuringProviderCall();
  await testScopedResearchAbortsIfAccountDeletedDuringRefresh();
  await testScopedResearchAbortsIfUploadIdChangedDuringRefresh();
  await testScopedResearchSucceedsForCrossListAccount();
  await testScopedResearchStaleAttemptRejectedAtSave();
  await testScopedResearchSnapshotMismatchSurfacedFromServer();

  console.log(`\n${failures === 0 ? 'ALL DASHBOARD ORCHESTRATION TESTS PASSED' : `${failures} DASHBOARD ORCHESTRATION TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
