// Beta cleanup sprint: deterministic coverage for the two FIX NOW findings
// approved from the Phase 1 audit --
//   1. a paused customer account must not continue presenting as actively
//      monitored intelligence (This Week's Priorities, Recently Researched,
//      active monitoring/revenue totals) -- gated on the EXISTING canonical
//      `monitoringStatus` field, no new pause definition;
//   2. a successful pause/resume/delete inside Manage Customer Accounts
//      must refresh the shared dashboard state via the EXISTING
//      refreshAggregateDashboard() path, not a new state-management system.
//
// Convention (matching every other test file in this project): extract the
// VERBATIM, on-disk source of the functions under test directly out of
// dashboard/index.html and run them for real in a vm sandbox. Only pure
// DOM-rendering/classification helpers with no bearing on the
// monitoringStatus filtering or the refresh-call-count under test are
// stubbed -- several as spies, so the test can observe what real code
// actually passed them, not just that it didn't crash.
//
// Usage: node scripts/test-beta-cleanup-paused-accounts.js
import vm from 'node:vm';
import { extractFn, extractStatementAfter, loadDashboardSource } from './lib/dashboard-extract.js';

const DASHBOARD_SRC = loadDashboardSource();

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function createFakeLocalStorage(){
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}

function fixtureAccount(name, overrides = {}){
  return { id: `acct-${name}`, name, uploadId: 'upload-1', monitoringStatus: 'active', lastResearchedAt: null, signals: [], futureOpportunities: [], revenue: 0, ...overrides };
}

// ===========================================================================
// PART A: getRecentlyResearchedAccounts() -- a paused account is excluded
// from Recently Researched's active presentation, and reappears once
// resumed.
// ===========================================================================
const RR_REAL_SOURCE = [
  extractFn(DASHBOARD_SRC, 'RECENTLY_RESEARCHED_WINDOW_MS'),
  extractFn(DASHBOARD_SRC, 'normalizeAccountNameForKey'),
  extractFn(DASHBOARD_SRC, 'recentlyResearchedKey'),
  extractFn(DASHBOARD_SRC, 'DISMISSED_RESEARCH_STORAGE_PREFIX'),
  extractFn(DASHBOARD_SRC, 'DISMISSED_RESEARCH_PRUNE_AFTER_MS'),
  extractFn(DASHBOARD_SRC, 'dismissedResearchNamespace'),
  extractFn(DASHBOARD_SRC, 'dismissedResearchStorageKey'),
  extractFn(DASHBOARD_SRC, 'readDismissedResearchMap'),
  extractFn(DASHBOARD_SRC, 'writeDismissedResearchMap'),
  extractFn(DASHBOARD_SRC, 'pruneDismissedResearchMap'),
  extractFn(DASHBOARD_SRC, 'isResearchResultDismissed'),
  extractFn(DASHBOARD_SRC, 'getRecentlyResearchedAccounts')
].join('\n\n');

// Pure DOM-rendering/classification helpers getRecentlyResearchedAccounts()
// calls into but which have no bearing on the monitoringStatus filter under
// test -- stubbed exactly like scripts/test-dashboard-orchestration.js
// already stubs the same functions for the same reason.
const RR_STUB_SOURCE = `
function dedupeFoundSignals(signals){ return signals || []; }
function isExplicitlyVerifiedIdentity(opp){ return opp?.identityConfidence === 'confirmed'; }
function dedupeOpportunities(items){ return items || []; }
function collapseDuplicateAccountHistorySignals(items){ return items || []; }
function priorityEligibleOpportunities(items){ return items || []; }
`;

function createRRSandbox(accounts){
  const houseAuth = { getUser: () => ({ auth_user_id: 'auth-user-1', id: 'user-1', email: 'qa@example.com' }) };
  const sandbox = {
    window: { accountRadarAccounts: accounts, HouseAuth: houseAuth },
    HouseAuth: houseAuth,
    localStorage: createFakeLocalStorage(),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Math, Date, JSON, Set, Array, Object, Number, String
  };
  vm.createContext(sandbox);
  new vm.Script(`${RR_STUB_SOURCE}\n${RR_REAL_SOURCE}\n`, { filename: 'rr-extract.js' }).runInContext(sandbox);
  return sandbox;
}

{
  const now = new Date().toISOString();
  const active = fixtureAccount('Active Co', { lastResearchedAt: now, monitoringStatus: 'active' });
  const paused = fixtureAccount('Paused Co', { lastResearchedAt: now, monitoringStatus: 'paused' });
  const sandbox = createRRSandbox([active, paused]);
  const entries = sandbox.getRecentlyResearchedAccounts();
  assert(entries.some(e => e.name === 'Active Co'), 'sanity: an actively-monitored, recently-researched account appears in Recently Researched');
  assert(!entries.some(e => e.name === 'Paused Co'), 'REQUIRED: a paused account does NOT appear in Recently Researched, even though it was researched within the 30-minute window');
}
{
  const now = new Date().toISOString();
  const resumed = fixtureAccount('Resumed Co', { lastResearchedAt: now, monitoringStatus: 'active' });
  const sandbox = createRRSandbox([resumed]);
  const entries = sandbox.getRecentlyResearchedAccounts();
  assert(entries.some(e => e.name === 'Resumed Co'), 'REQUIRED: an account resumed back to active (monitoringStatus === "active") is presented in Recently Researched again');
}

// ===========================================================================
// PART B: refreshOpportunityViews() -- excludes paused accounts from the
// Priorities feed AND the "monitored account"/revenue totals, while still
// passing the FULL account list (paused included) to the account grid/
// detail view, so historical data is never hidden or deleted -- only its
// presentation as active intelligence stops.
// ===========================================================================
const RO_REAL_SOURCE = extractFn(DASHBOARD_SRC, 'refreshOpportunityViews');

function createROSandbox(accounts){
  const calls = { renderWeeklyPrioritiesFeed: [], calculateRevenueContext: [], renderDetailedAccountViews: [] };
  const stubSource = `
function renderWeeklyPrioritiesFeed(opportunities, accounts){ __calls.renderWeeklyPrioritiesFeed.push({opportunities, accounts}); return {displayedOpportunities: opportunities}; }
function calculateRevenueContext(accounts, opportunities){ __calls.calculateRevenueContext.push({accounts, opportunities}); return {historicalRevenue:0, historicalOpps:0, newBusinessOpps:0, totalReasons:0}; }
function renderDetailedAccountViews(accounts){ __calls.renderDetailedAccountViews.push(accounts); }
function applyFreeCompanyLocksToCustomerAccounts(accounts){ return accounts; }
function assignOpportunityScore(opp){ return opp; }
function getOpportunityScore(){ return 0; }
function sortDailyReasons(opps){ return opps || []; }
function dedupeOpportunities(items){ return items || []; }
function renderResearchDiagnostics(){}
function renderRecentlyResearchedSection(){}
`;
  const sandbox = {
    window: { accountRadarAccounts: accounts },
    document: { getElementById: () => null },
    __calls: calls,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Math, Date, JSON, Set, Array, Object, Number, String
  };
  vm.createContext(sandbox);
  new vm.Script(`${stubSource}\n${RO_REAL_SOURCE}\n`, { filename: 'ro-extract.js' }).runInContext(sandbox);
  return sandbox;
}

{
  const activeAcc = fixtureAccount('Active Co', { monitoringStatus: 'active', futureOpportunities: [{ account: 'Active Co', confidence: 80 }] });
  const pausedAcc = fixtureAccount('Paused Co', { monitoringStatus: 'paused', futureOpportunities: [{ account: 'Paused Co', confidence: 90 }] });
  const sandbox = createROSandbox([activeAcc, pausedAcc]);
  sandbox.refreshOpportunityViews();

  const feedCall = sandbox.__calls.renderWeeklyPrioritiesFeed[0];
  assert(!!feedCall, 'sanity: renderWeeklyPrioritiesFeed() was called');
  assert(feedCall.opportunities.every(o => o.account !== 'Paused Co'), 'REQUIRED: opportunities passed to build This Week\'s Priorities exclude a paused account\'s opportunities');
  assert(feedCall.opportunities.some(o => o.account === 'Active Co'), 'an actively-monitored account\'s opportunities are still included in the Priorities feed');
  assert(feedCall.accounts.length === 1 && feedCall.accounts[0].name === 'Active Co', 'REQUIRED: the "monitored account" total passed alongside the Priorities feed excludes the paused account');

  const revenueCall = sandbox.__calls.calculateRevenueContext[0];
  assert(revenueCall.accounts.length === 1 && revenueCall.accounts[0].name === 'Active Co', 'REQUIRED: calculateRevenueContext() (feeding the active monitoring/revenue totals) receives only actively-monitored accounts');

  const detailCall = sandbox.__calls.renderDetailedAccountViews[0];
  assert(detailCall.length === 2, 'the paused account\'s underlying data is preserved and still passed to the account grid/detail view -- pausing stops active presentation, it does not delete history');
}
{
  const resumedAcc = fixtureAccount('Resumed Co', { monitoringStatus: 'active', futureOpportunities: [{ account: 'Resumed Co', confidence: 80 }] });
  const sandbox = createROSandbox([resumedAcc]);
  sandbox.refreshOpportunityViews();
  const feedCall = sandbox.__calls.renderWeeklyPrioritiesFeed[0];
  assert(feedCall.opportunities.some(o => o.account === 'Resumed Co'), 'REQUIRED: an account resumed back to active is included in the Priorities feed again');
  assert(feedCall.accounts.some(a => a.name === 'Resumed Co'), 'REQUIRED: a resumed account is counted again in the "monitored account" total');

  const revenueCall = sandbox.__calls.calculateRevenueContext[0];
  assert(revenueCall.accounts.some(a => a.name === 'Resumed Co'), 'REQUIRED: a resumed account is counted again in the active revenue totals');
}

// ===========================================================================
// PART C: Manage Customer Accounts modal -- a successful pause/resume/
// delete action calls the EXISTING refreshAggregateDashboard() so the main
// dashboard reflects the mutation immediately. A FAILED request does not.
// Only extracts the real request()/delegated-click-listener source; every
// other function the listener references before/around the
// [data-account-act] branch (menu/pagination/research handlers) is never
// actually invoked because the fake click target's closest() only matches
// '[data-account-act]' -- so none of those need to be defined at all.
// ===========================================================================
// extractFn('load') is used ONLY to compute the delegated click listener's
// position in DASHBOARD_SRC (extractStatementAfter's anchor) -- its text is
// never included in the assembled sandbox script, so there is no risk of a
// duplicate `function load(){...}` declaration colliding with this file's
// own spy stub of the same name below.
const LOAD_ANCHOR_SRC = extractFn(DASHBOARD_SRC, 'load');
const LOAD_ANCHOR_INDEX = DASHBOARD_SRC.indexOf(LOAD_ANCHOR_SRC) + LOAD_ANCHOR_SRC.length;
const DELEGATED_CLICK_LISTENER_SRC = extractStatementAfter(DASHBOARD_SRC, LOAD_ANCHOR_INDEX, "document.addEventListener('click'");
if(!/data-account-act/.test(DELEGATED_CLICK_LISTENER_SRC)){
  throw new Error('sanity: the extracted delegated click listener does not contain the data-account-act branch -- extraction anchor is stale, fix the test before trusting its results.');
}

const REQUEST_REAL_SOURCE = extractFn(DASHBOARD_SRC, 'request');

function fakeClickEvent(dataset){
  return { target: { id: '', closest: (sel) => (sel === '[data-account-act]' ? { dataset } : null) } };
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

// esc() is reimplemented inline below (not extracted via extractFn) --
// the real IIFE-local `esc` name is not globally unique across
// dashboard/index.html's several scopes, so extractFn() would (correctly)
// refuse to guess which one. It is a byte-identical copy of the real
// one-line HTML-escaper the Manage Customer Accounts modal uses.
//
// document.addEventListener isn't available on `window` in this sandbox --
// the extracted listener is captured directly off `document.addEventListener`
// (a plain stub provided below) and invoked directly, rather than through a
// real DOM dispatch, exactly like other delegated-listener tests in this
// project (see scripts/test-dashboard-orchestration.js's own
// extractDelegatedClickListener() usage).
async function invokeAccountAction(action, { confirmResult = true, fetchImpl } = {}){
  const calls = { refreshAggregateDashboard: 0, load: 0, showToast: [], alert: [] };
  const houseAuth = { authHeadersAsync: async (h) => h || {} };
  const stubSource = `
function esc(v){ return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function closeAllMenus(){}
async function showDestructiveConfirm(opts){ return ${JSON.stringify(confirmResult)}; }
function showToast(message, undo){ __calls.showToast.push({message, hasUndo: typeof undo === 'function'}); }
async function load(){ __calls.load++; }
var __clickHandler = null;
`;
  const documentStub = { addEventListener: (type, handler) => { if(type === 'click') sandbox.__clickHandler = handler; } };
  const sandbox = {
    window: { HouseAuth: houseAuth },
    HouseAuth: houseAuth,
    document: documentStub,
    fetch: fetchImpl,
    alert: (msg) => calls.alert.push(msg),
    refreshAggregateDashboard: async () => { calls.refreshAggregateDashboard++; },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Math, Date, JSON, Set, Array, Object, Number, String, Promise
  };
  vm.createContext(sandbox);
  new vm.Script(`${stubSource}\n${REQUEST_REAL_SOURCE}\n${DELEGATED_CLICK_LISTENER_SRC}\n`, { filename: 'modal-action-extract.js' }).runInContext(sandbox);
  sandbox.__calls = calls;
  const ev = fakeClickEvent({ accountAct: action, accountId: 'acct-1', accountName: 'Acme Co' });
  await sandbox.__clickHandler(ev);
  return sandbox.__calls;
}

async function runPartC(){
  // Successful pause -> refreshAggregateDashboard() called exactly once.
  {
    const fetchImpl = async (url, opts) => (url === '/api/monitoring-lists' && opts.method === 'PATCH') ? jsonResponse({ ok: true }) : (() => { throw new Error(`unexpected fetch: ${url}`); })();
    const calls = await invokeAccountAction('pause-account', { fetchImpl });
    assert(calls.refreshAggregateDashboard === 1, `REQUIRED: a successful pause calls the existing refreshAggregateDashboard() exactly once (got ${calls.refreshAggregateDashboard})`);
    assert(calls.load === 1, 'the modal\'s own local load() still runs too (unchanged existing behavior)');
    assert(calls.alert.length === 0, 'no error alert on a successful pause');
  }
  // Successful resume -> refreshAggregateDashboard() called exactly once.
  {
    const fetchImpl = async (url, opts) => (url === '/api/monitoring-lists' && opts.method === 'PATCH') ? jsonResponse({ ok: true }) : (() => { throw new Error(`unexpected fetch: ${url}`); })();
    const calls = await invokeAccountAction('resume-account', { fetchImpl });
    assert(calls.refreshAggregateDashboard === 1, `REQUIRED: a successful resume calls the existing refreshAggregateDashboard() exactly once (got ${calls.refreshAggregateDashboard})`);
  }
  // Successful delete -> refreshAggregateDashboard() called exactly once.
  {
    const fetchImpl = async (url, opts) => (url === '/api/monitoring-lists' && opts.method === 'PATCH') ? jsonResponse({ ok: true }) : (() => { throw new Error(`unexpected fetch: ${url}`); })();
    const calls = await invokeAccountAction('delete-account', { fetchImpl, confirmResult: true });
    assert(calls.refreshAggregateDashboard === 1, `REQUIRED: a successful delete calls the existing refreshAggregateDashboard() exactly once (got ${calls.refreshAggregateDashboard})`);
  }
  // A cancelled delete confirmation never mutates anything and never
  // refreshes -- the user backed out.
  {
    const fetchImpl = async (url) => { throw new Error(`unexpected fetch: ${url} -- a cancelled confirm must not call the server at all`); };
    const calls = await invokeAccountAction('delete-account', { fetchImpl, confirmResult: false });
    assert(calls.refreshAggregateDashboard === 0, 'REQUIRED: a cancelled delete confirmation does not call refreshAggregateDashboard()');
    assert(calls.load === 0, 'a cancelled delete confirmation does not call load() either');
  }
  // A FAILED pause request (server error) does not call
  // refreshAggregateDashboard() -- only a genuinely successful mutation
  // should refresh the shared dashboard state.
  {
    const fetchImpl = async () => jsonResponse({ error: 'Simulated failure' }, false, 500);
    const calls = await invokeAccountAction('pause-account', { fetchImpl });
    assert(calls.refreshAggregateDashboard === 0, `REQUIRED: a failed pause request does not call refreshAggregateDashboard() (got ${calls.refreshAggregateDashboard})`);
    assert(calls.alert.length === 1, 'a failed pause request surfaces the error via the existing alert() path');
  }
  // A FAILED delete request likewise does not refresh.
  {
    const fetchImpl = async () => jsonResponse({ error: 'Simulated failure' }, false, 500);
    const calls = await invokeAccountAction('delete-account', { fetchImpl, confirmResult: true });
    assert(calls.refreshAggregateDashboard === 0, `REQUIRED: a failed delete request does not call refreshAggregateDashboard() (got ${calls.refreshAggregateDashboard})`);
  }
}
await runPartC();

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
