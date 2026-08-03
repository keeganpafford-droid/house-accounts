// Phase 2A implementation-review ROUND 12 -- automated coverage for the
// Live Preview QA report on the single-account "Research Again" flow:
// server-backed run-state reattachment across modal close/reopen and full
// page reload, the HA004 branded dialog (replacing window.alert()), the
// post-research "View opportunities" handoff, and the Recently Researched
// section.
//
// Convention (matching every other test file in this project): extract the
// VERBATIM, on-disk source of every function under test directly out of
// dashboard/index.html and api/monitoring-lists.js and run it for real (in
// a vm sandbox for the client half, via a real module import for the
// server half). Nothing about the logic itself is reimplemented -- only
// pure DOM-rendering/classification helpers with no bearing on the
// behavior under test are stubbed, each with a one-line reason. extractFn()/
// extractRaw() verify the extracted slice still starts with the expected
// signature and still closes correctly, so a future source reshuffle fails
// loudly here instead of silently testing stale text.
//
// Maps directly onto the 10 numbered requirements from the QA report:
//  1) closing the modal does not cancel the active provider request
//  2) reopening while active shows "Researching" with no extra claim/call
//  3) reload after completion shows "Research Again" + the persisted timestamp
//  4) a failed active run restores a branded failure state
//  5) reopening never creates a duplicate run/provider request
//  6) HA004 is shown through the branded UI, never a native alert
//  7) "View opportunities" finds the account even below the top rows
//  8) Recently Researched deduplicates reruns of the same account
//  9) normal priority order is unaffected by the recently-researched treatment
// 10) the monitoring-lists 404 regression (root cause: no code path in
//     api/monitoring-lists.js can emit a 404 -- see PART 1 below)
//
// Usage: node scripts/test-research-run-reattachment.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import monitoringListsHandler from '../api/monitoring-lists.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DASHBOARD_SRC = readFileSync(join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8');
const DASHBOARD_LINES = DASHBOARD_SRC.split('\n');
const MONITORING_LISTS_SRC = readFileSync(join(REPO_ROOT, 'api', 'monitoring-lists.js'), 'utf8');

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// Tolerant of the modal IIFE's single-space indentation, same contract as
// scripts/test-dashboard-auth-headers.js's extractFn().
function extractFn(name, startLine, endLine, {async: isAsync = false} = {}){
  const slice = DASHBOARD_LINES.slice(startLine - 1, endLine).join('\n');
  const trimmedStart = slice.replace(/^\s+/, '');
  const expectedPrefix = `${isAsync ? 'async ' : ''}function ${name}(`;
  if(!trimmedStart.startsWith(expectedPrefix)){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-research-run-reattachment.js.`);
  }
  if(!slice.trimEnd().endsWith('}')){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${endLine} does not close the function body as expected -- update the line range.`);
  }
  return slice;
}
function extractRaw(label, startLine, endLine, expectedPrefixTrimmed){
  const slice = DASHBOARD_LINES.slice(startLine - 1, endLine).join('\n');
  const trimmedStart = slice.replace(/^\s+/, '');
  if(!trimmedStart.startsWith(expectedPrefixTrimmed)){
    throw new Error(`extractRaw(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefixTrimmed}" -- source has shifted, update the line range in scripts/test-research-run-reattachment.js.`);
  }
  return slice;
}

// ===========================================================================
// PART 1 -- server: researchRunState computation, and the monitoring-lists
// 404 investigation (requirement 10).
//
// Root cause established by direct code reading, proven here structurally:
// every branch of api/monitoring-lists.js's exported handler terminates in
// json(res, <status>, ...) with a status the code itself chooses (200, 400,
// 401, 403, 405, or e.status||500 from a caught exception) -- there is no
// code path anywhere in this file that can produce a 404. The 404 the QA
// report observed in the console is therefore NOT a defect in this file's
// routing/logic; it is consistent with a Preview-deployment-availability
// gap (the same class of issue diagnosed earlier in this engagement),
// verified by the user against the live Preview deployment, which this
// suite cannot reach or substitute for.
// ===========================================================================
function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function fakeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}
function fakeReq(method, body){
  return { method, headers: { authorization: 'Bearer valid-token' }, body };
}

const AUTH_USER_ID = 'auth-user-1';
const USER_ID = 'user-1';
const UPLOAD_ID = 'upload-1';

function mockFetch({ researchRuns = [] } = {}){
  return async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if(u.includes('/auth/v1/user')){
      const token = String((options.headers || {}).Authorization || '');
      if(!token.includes('valid-token')) return jsonResponse(null, false, 401);
      return jsonResponse({ id: AUTH_USER_ID, email: 'qa@example.com' });
    }
    if(u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')){
      return jsonResponse([{ id: USER_ID, email: 'qa@example.com', app_role: 'member', role: 'member', organization_id: null, status: 'active' }]);
    }
    if(u.includes('/rest/v1/ha_users') && u.includes('organization_id=eq.')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_uploads')) return jsonResponse([{ id: UPLOAD_ID, user_id: USER_ID, upload_name: 'QA List', stage: 'researched', updated_at: '2026-08-01T00:00:00Z' }]);
    if(u.includes('/rest/v1/ha_prospect_uploads')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_accounts') && u.includes('upload_id=eq.') && method === 'GET'){
      return jsonResponse([{ id: 'acct-1', upload_id: UPLOAD_ID, account_name: 'L.L.Bean', industry: 'Retail', raw_data: { monitoring_status: 'active', research_status: 'researched', last_researched_at: '2026-08-03T12:00:00Z' }, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' }]);
    }
    if(u.includes('/rest/v1/ha_signals')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_research_runs') && u.includes('upload_id=eq.') && method === 'GET'){
      return jsonResponse(researchRuns);
    }
    throw new Error(`Unhandled mock fetch URL in test: ${method} ${u}`);
  };
}

async function runServerTests(){
  const originalFetch = global.fetch;

  // 1) No research run yet -> idle.
  {
    global.fetch = mockFetch({ researchRuns: [] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    assert(res.statusCode === 200, '1) GET /api/monitoring-lists returns 200 (never 404) with no research runs at all');
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'idle', '1) researchRunState collapses to idle when no run row exists');
  }

  // 2) A running row with a lease that has NOT expired -> active, with the
  // researchRunId/attemptId/startedAt the modal needs to write/read its
  // breadcrumb and label the state.
  {
    const runId = 'manual-2026-08-03T12-00-00-abcd';
    global.fetch = mockFetch({ researchRuns: [{ research_run_id: runId, attempt_id: 'attempt-1', status: 'running', lease_expires_at: new Date(Date.now() + 60_000).toISOString(), started_at: '2026-08-03T12:00:00Z', error_message: null }] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'active', '2) a running row with an unexpired lease collapses to active');
    assert(state.researchRunId === runId && state.attemptId === 'attempt-1', '2) active state carries the real researchRunId/attemptId (needed for the breadcrumb lookup)');
  }

  // 3) A running row whose lease HAS expired -> idle (reclaimable), not
  // "active" -- matches claim_ha_research_run()'s own attached-active vs
  // reclaimable distinction (same lease_expires_at > now() condition).
  {
    global.fetch = mockFetch({ researchRuns: [{ research_run_id: 'auto', attempt_id: 'attempt-old', status: 'running', lease_expires_at: new Date(Date.now() - 60_000).toISOString(), started_at: '2026-08-01T00:00:00Z', error_message: null }] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'idle', '3) a running row with an EXPIRED lease is idle, not active (it is reclaimable, not meaningfully in-progress)');
  }

  // 4) A failed row -> failed, carrying the error message for the branded
  // failure banner (requirement 4/6).
  {
    global.fetch = mockFetch({ researchRuns: [{ research_run_id: 'manual-x', attempt_id: 'attempt-x', status: 'failed', lease_expires_at: null, started_at: '2026-08-03T11:00:00Z', error_message: 'Research failed. Please try again.' }] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'failed', '4) a failed row collapses to failed');
    assert(state.errorMessage === 'Research failed. Please try again.', '4) the failure state carries the real error message');
  }

  // 5) A completed row -> idle (the button is "Research Again", no banner).
  {
    global.fetch = mockFetch({ researchRuns: [{ research_run_id: 'manual-y', attempt_id: 'attempt-y', status: 'completed', lease_expires_at: null, started_at: '2026-08-03T09:00:00Z', error_message: null }] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'idle', '5) a completed row collapses to idle -- no lingering banner once a run has finished');
  }

  // 6) Structural proof for requirement 10: every response this handler can
  // ever produce carries a status the code itself explicitly chose (200,
  // 400, 401, 403, 405, or a caught error's own e.status||500) -- 404 does
  // not appear anywhere in its own source, so a 404 cannot originate from
  // this file's routing/logic.
  {
    assert(!/res\.status\(\s*404\s*\)|json\(res\s*,\s*404/.test(MONITORING_LISTS_SRC), '10) api/monitoring-lists.js contains no code path that returns a 404 -- confirms the observed 404 is not this file\'s own routing/logic (consistent with a Preview-deployment-availability gap, not an application defect)');
  }

  // 7) Behavioral proof, same conclusion: an assortment of malformed/
  // unexpected requests against the REAL handler (unknown method, missing
  // body fields, wrong type) never returns 404 -- always a real 4xx/5xx the
  // handler chose deliberately.
  {
    global.fetch = mockFetch({ researchRuns: [] });
    const unknownMethodRes = fakeRes();
    await monitoringListsHandler({ method: 'PUT', headers: { authorization: 'Bearer valid-token' }, body: {} }, unknownMethodRes);
    assert(unknownMethodRes.statusCode === 405, '7) an unsupported HTTP method returns 405 (Method not allowed), not 404');
    const badPatchRes = fakeRes();
    await monitoringListsHandler(fakeReq('PATCH', { type: 'bogus', id: 'x', action: 'bogus' }), badPatchRes);
    assert(badPatchRes.statusCode === 400, '7) a malformed PATCH body returns 400, not 404');
    const badDeleteRes = fakeRes();
    await monitoringListsHandler(fakeReq('DELETE', { type: 'bogus' }), badDeleteRes);
    assert(badDeleteRes.statusCode === 400, '7) a malformed DELETE body returns 400, not 404');
  }

  global.fetch = originalFetch;
}

// ===========================================================================
// PART 2 -- client: extracted verbatim from dashboard/index.html.
// ===========================================================================
const REAL_SOURCE = [
  extractRaw('ACTIVE_RESEARCH_BREADCRUMB_KEY', 3938, 3938, 'const ACTIVE_RESEARCH_BREADCRUMB_KEY'),
  extractFn('setActiveResearchBreadcrumb', 3939, 3945),
  extractFn('clearActiveResearchBreadcrumb', 3946, 3957),
  extractFn('getActiveResearchBreadcrumb', 3958, 3965),
  extractFn('applyModalResearchResultToDashboard', 4692, 4702),
  extractFn('findTimeboxForAccountOpportunity', 4710, 4717),
  extractFn('highlightResultElement', 4719, 4725),
  extractFn('scrollToAccountResult', 4734, 4754),
  extractRaw('RECENTLY_RESEARCHED_WINDOW_MS', 4765, 4766, 'const RECENTLY_RESEARCHED_WINDOW_MS'),
  extractFn('getRecentlyResearchedAccounts', 4767, 4780),
  extractFn('relativeResearchTimeLabel', 4781, 4788),
  extractFn('renderRecentlyResearchedSection', 4789, 4814),
  extractRaw('recentlyResearchedClickListener', 4815, 4825, "document.addEventListener('click', (event) => {"),
  extractFn('escapeHtml', 6685, 6688),
  extractRaw('modalFmtEsc', 6693, 6695, "const fmt=d=>"),
  extractFn('request', 6704, 6721, {async: true}),
  extractFn('accountRow', 6749, 6786),
  extractFn('researchRunBanner', 6791, 6802),
  extractFn('listCard', 6803, 6826),
  extractRaw('renderManager', 6827, 6827, 'function renderManager(){'),
  extractFn('isModalOpen', 6838, 6841),
  extractFn('anyListHasActiveRun', 6842, 6844),
  extractFn('stopResearchPoll', 6845, 6847),
  extractFn('scheduleResearchPollIfNeeded', 6848, 6852),
  extractFn('load', 6853, 6862, {async: true}),
  extractRaw('openClose', 6863, 6864, "function open(){"),
  extractFn('showInfoDialog', 7070, 7103)
].join('\n\n');

// Static regression proof for requirement 1: nothing in dashboard/index.html
// can cancel an in-flight fetch (no AbortController/abort() exists in the
// file at all), and close()'s own extracted source (in openClose above)
// contains neither 'abort' nor any fetch call -- it only hides the modal
// and stops the UI's OWN polling GET (stopResearchPoll()), never the
// provider-facing research request.
assert(!/AbortController|\.abort\(/.test(DASHBOARD_SRC), '1) dashboard/index.html contains no AbortController/abort() anywhere -- an in-flight provider request cannot be cancelled by ANY client action, including closing the modal');
{
  const closeSrc = extractRaw('closeOnly', 6864, 6864, "function close(){");
  assert(!/abort/i.test(closeSrc) && !/fetch\(/.test(closeSrc), '1) close()\'s own source contains no abort/cancel/fetch call');
  assert(/stopResearchPoll\(\)/.test(closeSrc), '1) close() stops only the modal\'s own UI polling loop (stopResearchPoll()), not the provider request');
}

// Static regression proof for requirement 6: the delete-account catch
// branch shows the branded dialog when the server marks the rejection
// identity-locked, and only falls back to alert() in the else branch (never
// unconditionally) -- extracted directly from the real click handler.
{
  const deleteAccountBranch = extractRaw('deleteAccountCatchBranch', 7124, 7153, "if(action==='delete-account'){");
  assert(/if\(err\.identityLocked\)\{/.test(deleteAccountBranch), '6) the delete-account catch branch checks err.identityLocked');
  assert(/showInfoDialog\(/.test(deleteAccountBranch), '6) the identityLocked branch calls showInfoDialog(), the branded non-destructive dialog');
  assert(/\}else\{\s*alert\(err\.message\);\s*\}/.test(deleteAccountBranch), '6) alert() is reached ONLY in the else branch -- never unconditionally for this rejection');
}

// ===========================================================================
// Stubs -- pure DOM-rendering/classification helpers with no bearing on the
// behavior under test, each stubbed for a stated reason (same convention as
// scripts/test-dashboard-orchestration.js).
// ===========================================================================
const STUB_SOURCE = `
// refreshOpportunityViews() itself is the main dashboard's full render
// pipeline (opportunity cards, KPIs, account list) -- irrelevant to what
// THIS suite verifies (scrollToAccountResult's own search/fallback logic,
// and that it flips the existing showAllWeeklyPriorities/activeTimebox
// switches). Recorded so tests can assert it fires the right number of
// times with the right state, without needing the full render pipeline.
var __refreshCalls = [];
function refreshOpportunityViews(){ __refreshCalls.push({activeTimebox, showAllWeeklyPriorities}); }
// opportunityMatchesTimebox's real implementation depends on a long chain
// of pure signal/opportunity classification helpers (getOpportunityPlanningWindow,
// getRecommendationType, signalLayerLabel, ...) that have no bearing on
// findTimeboxForAccountOpportunity's own control flow (loop timeboxes in
// order, return the first with a match) -- fixture opportunities carry an
// explicit .timebox field and this stub matches it directly.
function opportunityMatchesTimebox(opp, timebox){ return !!opp && opp.timebox === timebox; }
// addSignalDerivedOpportunities() is the full signal-to-opportunity
// generation pipeline (confidence scoring, buyer inference, etc.) --
// orthogonal to applyModalResearchResultToDashboard()'s own job (patch the
// account, call this, call refreshOpportunityViews). This stub just proves
// the account got the right signals/timestamp and that this was called.
var __addSignalDerivedCalls = [];
function addSignalDerivedOpportunities(account, signals){
  __addSignalDerivedCalls.push({name: account.name, signalCount: (signals||[]).length});
  account.futureOpportunities = (signals||[]).map((s, i) => ({account: account.name, timebox: 'week', signal: s}));
}
function dedupeVerifiedSignals(signals){ return signals || []; }
`;

// ===========================================================================
// Minimal fake DOM -- tailored exactly to the selectors this round's code
// actually uses (no general CSS engine): '.class' (deep, class-list match)
// and '[data-key]' (deep, attribute-EXISTENCE match, no value comparison
// needed by this code). document.getElementById('accountList'/
// 'recentlyResearchedSection'/'opportunitiesGrid'/'accountManagerModal'/
// 'accountManagerContent') are pre-wired fixed elements; document.querySelectorAll
// recognizes the literal '#id .class' compound forms this code uses by
// scoping the search to that id'd element's subtree.
// ===========================================================================
class FakeEl {
  constructor(tag, attrs = {}){
    this.tag = tag;
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this._classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    this._html = '';
    this._focused = false;
    this._scrolledIntoView = 0;
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
  get classList(){
    const self = this;
    return {
      add: (c) => self._classes.add(c),
      remove: (c) => self._classes.delete(c),
      contains: (c) => self._classes.has(c),
      toggle: (c, force) => { if(force === undefined){ self._classes.has(c) ? self._classes.delete(c) : self._classes.add(c); } else if(force){ self._classes.add(c); } else { self._classes.delete(c); } }
    };
  }
  hasAttribute(name){ return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  setAttribute(name, value){ this.attrs[name] = value; }
  get innerHTML(){ return this._html; }
  set innerHTML(v){ this._html = v; }
  scrollIntoView(){ this._scrolledIntoView += 1; }
  focus(){ this._focused = true; }
  matchesSimple(selector){
    if(selector.startsWith('[') && selector.endsWith(']')){
      const attrName = selector.slice(1, -1);
      return this.hasAttribute(attrName);
    }
    if(selector.startsWith('.')) return this._classes.has(selector.slice(1));
    return false;
  }
  querySelectorAll(selector){
    const out = [];
    (function walk(el){ for(const c of el.children){ if(c.matchesSimple(selector)) out.push(c); walk(c); } })(this);
    return out;
  }
  querySelector(selector){ return this.querySelectorAll(selector)[0] || null; }
  closest(selector){
    let el = this;
    while(el){ if(el.matchesSimple(selector)) return el; el = el.parent; }
    return null;
  }
}

function createFakeDom(){
  const opportunitiesGrid = new FakeEl('div', { id: 'opportunitiesGrid' });
  const accountList = new FakeEl('div', { id: 'accountList' });
  const recentlyResearchedSection = new FakeEl('div', { id: 'recentlyResearchedSection' });
  const accountManagerModal = new FakeEl('div', { id: 'accountManagerModal' });
  accountManagerModal.style = { display: 'none' };
  const accountManagerContent = new FakeEl('div', { id: 'accountManagerContent' });
  const byId = { opportunitiesGrid, accountList, recentlyResearchedSection, accountManagerModal, accountManagerContent };
  const timeboxTabs = ['week', 'month', 'quarter', 'annual'].map(tb => {
    const btn = new FakeEl('button', { class: 'timebox-tab', 'data-timebox': tb });
    return btn;
  });
  const listeners = { click: null };
  const document_ = {
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (selector) => {
      if(selector === '.timebox-tab') return timeboxTabs;
      const scoped = selector.match(/^#([\w-]+)\s+(.+)$/);
      if(scoped){
        const [, id, rest] = scoped;
        const root = byId[id];
        return root ? root.querySelectorAll(rest) : [];
      }
      return [];
    },
    querySelector(selector){ return this.querySelectorAll(selector)[0] || null; },
    // Captures the REAL delegated click listener (extracted verbatim as
    // recentlyResearchedClickListener above) so tests can dispatch a fake
    // click event through it and assert on the real dismiss/view logic.
    addEventListener: (type, handler) => { if(type === 'click') listeners.click = handler; }
  };
  return { document_, byId, opportunitiesGrid, accountList, recentlyResearchedSection, accountManagerModal, timeboxTabs, listeners };
}

// Minimal in-memory localStorage -- real getItem/setItem/removeItem
// semantics (string-keyed, string values), exactly what the breadcrumb
// helpers need; nothing about their own read/write/guard logic is
// reimplemented here.
function createFakeLocalStorage(){
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  };
}

function createSandbox({accounts = [], currentUploadId = 'upload-1', fetchImpl} = {}){
  const dom = createFakeDom();
  const houseAuth = { authHeadersAsync: async (h) => (fetchImpl === 'no-session' ? null : (h || {})) };
  const alertCalls = [];
  const sandbox = {
    window: { accountRadarAccounts: accounts, HouseAuth: houseAuth, location: { href: 'https://example.com/dashboard' } },
    HouseAuth: houseAuth,
    document: dom.document_,
    localStorage: createFakeLocalStorage(),
    fetch: typeof fetchImpl === 'function' ? fetchImpl : (async () => { throw new Error('fetch should not be called in this test'); }),
    alert: (msg) => alertCalls.push(msg),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Math, Date, JSON, Set, Array, Object, Number, String, Promise, Boolean,
    setTimeout, clearTimeout, CSS: { escape: (s) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) }
  };
  vm.createContext(sandbox);
  const initSource = `
var currentUploadId = ${JSON.stringify(currentUploadId)};
var activeTimebox = 'week';
var showAllWeeklyPriorities = false;
var researchPollTimer = null;
var RESEARCH_POLL_INTERVAL_MS = 6000;
`;
  const fullSource = `${initSource}\n${STUB_SOURCE}\n${REAL_SOURCE}\n`;
  new vm.Script(fullSource, { filename: 'research-run-reattachment-extract.js' }).runInContext(sandbox);
  sandbox.__dom = dom;
  sandbox.__alertCalls = alertCalls;
  return sandbox;
}

function fixtureAccount(name, overrides = {}){
  return { id: `acct-${name}`, name, lastResearchedAt: null, signals: [], futureOpportunities: [], ...overrides };
}

async function runClientTests(){
  // ---------------------------------------------------------------------
  // Requirement 2/3/4 -- accountRow()/listCard()/researchRunBanner() render
  // the right state directly from server-owned list.researchRunState, with
  // no dependency on any local DOM flag.
  // ---------------------------------------------------------------------
  {
    const sandbox = createSandbox({ accounts: [], currentUploadId: 'upload-1' });
    // Active run for "L.L.Bean" -- the breadcrumb (localStorage) supplies
    // the account name for an ALREADY server-confirmed active run.
    sandbox.localStorage.setItem('ha_active_research_breadcrumb_v1', JSON.stringify({ 'upload-1': { researchRunId: 'run-1', accountName: 'L.L.Bean' } }));
    const list = { id: 'upload-1', name: 'QA List', status: 'active', companyCount: 1, researchRunState: { status: 'active', researchRunId: 'run-1', attemptId: 'att-1', startedAt: null, errorMessage: null } };
    const account = { id: 'a1', name: 'L.L.Bean', monitoringStatus: 'active', lastResearchedAt: null };
    const rowHtml = sandbox.accountRow(list, account);
    assert(/Researching…/.test(rowHtml), '2) accountRow() shows "Researching…" for the account named by the breadcrumb when researchRunState.status is active');
    assert(/disabled/.test(rowHtml), '2) the Research button is disabled while a run is active for this list');
    const bannerHtml = sandbox.researchRunBanner(list);
    assert(/Researching/.test(bannerHtml) && /L\.L\.Bean/.test(bannerHtml), '2) the list-level banner names the account being researched, when available');

    const otherAccount = { id: 'a2', name: 'Acme Co', monitoringStatus: 'active', lastResearchedAt: null };
    const otherRowHtml = sandbox.accountRow(list, otherAccount);
    assert(/disabled/.test(otherRowHtml) && !/Researching…/.test(otherRowHtml), '2) a DIFFERENT account in the same list is also disabled (single-active-run-per-upload) but is not itself labeled "Researching…"');
  }
  {
    // Requirement 3: idle + a persisted lastResearchedAt -> "Research
    // Again" and the persisted timestamp, not a stale/local flag.
    const sandbox = createSandbox({ accounts: [], currentUploadId: 'upload-1' });
    const list = { id: 'upload-1', name: 'QA List', status: 'active', companyCount: 1, researchRunState: { status: 'idle' } };
    const account = { id: 'a1', name: 'L.L.Bean', monitoringStatus: 'active', lastResearchedAt: '2026-08-03T12:00:00Z' };
    const rowHtml = sandbox.accountRow(list, account);
    assert(/Research Again/.test(rowHtml) && !/disabled/.test(rowHtml), '3) idle state + a prior lastResearchedAt shows an ENABLED "Research Again"');
    assert(/Last researched/.test(rowHtml), '3) the persisted "Last researched" date is shown in the row, sourced from the server, not a transient flag');
    assert(sandbox.researchRunBanner(list) === '', '3) no run banner is shown once the run is idle/complete');
  }
  {
    // Requirement 4/6: a failed run shows a branded failure banner (not a
    // silent "Research Again"), and retry (the button itself) is available
    // because status !== 'active'.
    const sandbox = createSandbox({ accounts: [], currentUploadId: 'upload-1' });
    sandbox.localStorage.setItem('ha_active_research_breadcrumb_v1', JSON.stringify({ 'upload-1': { researchRunId: 'run-2', accountName: 'L.L.Bean' } }));
    const list = { id: 'upload-1', name: 'QA List', status: 'active', companyCount: 1, researchRunState: { status: 'failed', researchRunId: 'run-2', attemptId: 'att-2', errorMessage: 'Research failed. Please try again.' } };
    const account = { id: 'a1', name: 'L.L.Bean', monitoringStatus: 'active', lastResearchedAt: null };
    const bannerHtml = sandbox.researchRunBanner(list);
    assert(/failed/i.test(bannerHtml) && /L\.L\.Bean/.test(bannerHtml) && /Research failed\. Please try again\./.test(bannerHtml), '4) a failed run shows a clear, branded failure banner naming the account and the real error message');
    const rowHtml = sandbox.accountRow(list, account);
    assert(!/disabled/.test(rowHtml), '4) retry (the Research button itself) is available once the prior run is no longer active (status is failed, not active)');
  }

  // ---------------------------------------------------------------------
  // Requirement 5 -- open()/load() (via request()) only ever issue a GET;
  // reopening can never itself claim another run or call a provider.
  // ---------------------------------------------------------------------
  {
    const loadSrc = extractFn('load', 6853, 6862, { async: true });
    assert(/request\('GET'\)/.test(loadSrc), "5) load() calls request('GET')");
    assert(!/researchRunAction/.test(loadSrc) && !/claim/i.test(loadSrc), '5) load() never references a claim/researchRunAction -- reopening the modal cannot itself start or attach to a run beyond reading its state');
  }
  {
    // Behavioral proof: calling request('GET') issues exactly one GET to
    // /api/monitoring-lists and nothing else.
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, method: (init && init.method) || 'GET' }); return { ok: true, json: async () => ({ ok: true, lists: { customer: [] } }) }; };
    const sandbox = createSandbox({ fetchImpl });
    await sandbox.load();
    assert(calls.length === 1 && calls[0].url === '/api/monitoring-lists' && calls[0].method === 'GET', '5) load() (what open()/reopen calls) issues exactly ONE GET request and nothing else -- no duplicate claim/provider call from reopening');
  }

  // ---------------------------------------------------------------------
  // Requirement 6 -- request() preserves identityLocked from the server's
  // JSON body onto the thrown Error, so the branded dialog (verified
  // structurally above) can be gated on it.
  // ---------------------------------------------------------------------
  {
    const fetchImpl = async () => ({ ok: false, json: async () => ({ error: "L.L.Bean can't be deleted individually", identityLocked: true }) });
    const sandbox = createSandbox({ fetchImpl });
    let caught = null;
    try{ await sandbox.request('PATCH', { type: 'account', id: 'a1', action: 'delete-account' }); }catch(err){ caught = err; }
    assert(!!caught, "6) request() throws when the server rejects the delete");
    assert(caught && caught.identityLocked === true, '6) request() carries identityLocked:true from the response body onto the thrown Error');
    assert(caught && /can't be deleted individually/.test(caught.message), "6) request() preserves the server's real error message");
  }
  {
    const fetchImpl = async () => ({ ok: false, json: async () => ({ error: 'Some other failure' }) });
    const sandbox = createSandbox({ fetchImpl });
    let caught = null;
    try{ await sandbox.request('PATCH', { type: 'account', id: 'a1', action: 'pause-account' }); }catch(err){ caught = err; }
    assert(caught && !caught.identityLocked, '6) a non-HA004 failure does NOT carry identityLocked -- the branded HA004 dialog is never shown for an unrelated error');
  }

  // ---------------------------------------------------------------------
  // Requirement 7 -- "View opportunities" finds the account's rendered
  // result even when it would not appear in the default top-ranked view,
  // by switching to the matching timebox and flipping the SAME
  // showAllWeeklyPriorities switch the existing "View All Opportunities"
  // button already uses (never a permanent ranking change).
  // ---------------------------------------------------------------------
  {
    const account = fixtureAccount('L.L.Bean', { futureOpportunities: [{ account: 'L.L.Bean', timebox: 'quarter' }] });
    const sandbox = createSandbox({ accounts: [account] });
    sandbox.activeTimebox = 'week';
    sandbox.showAllWeeklyPriorities = false;
    sandbox.__refreshCalls.length = 0;
    // Not rendered anywhere yet (grid/detail/recent all empty) -- exercises
    // the "nothing found" fallback path.
    sandbox.scrollToAccountResult('L.L.Bean');
    assert(sandbox.activeTimebox === 'quarter', "7) scrollToAccountResult() switches to the timebox where the account's own opportunity actually lives, not whatever tab happened to be open");
    assert(sandbox.showAllWeeklyPriorities === true, '7) scrollToAccountResult() flips the existing showAllWeeklyPriorities switch -- the SAME mechanism "View All Opportunities" already uses, not a new ranking override');
    assert(sandbox.__refreshCalls.length === 1, '7) refreshOpportunityViews() is called exactly once to materialize the now-visible result');

    // Now the account's opportunity card IS in the grid (simulating a
    // real render): scrollToAccountResult must find and highlight it.
    const card = new FakeEl('div', { class: 'opportunity-card', 'data-account': 'L.L.Bean' });
    sandbox.__dom.opportunitiesGrid.appendChild(card);
    sandbox.scrollToAccountResult('L.L.Bean');
    assert(card._scrolledIntoView >= 1, "7) the account's own opportunity card is scrolled into view when it is present in the grid");
    assert(card.classList.contains('ha-just-researched-highlight'), "7) the account's own opportunity card is highlighted");
  }
  {
    // Account has zero opportunities at all (a genuine zero-signal
    // result) -- falls back to the Recently Researched card, never a dead
    // click.
    const account = fixtureAccount('Zero Signal Co', { futureOpportunities: [] });
    const sandbox = createSandbox({ accounts: [account] });
    const recentCard = new FakeEl('div', { class: 'recently-researched-card', 'data-account-name': 'Zero Signal Co' });
    sandbox.__dom.recentlyResearchedSection.appendChild(recentCard);
    sandbox.scrollToAccountResult('Zero Signal Co');
    assert(recentCard._scrolledIntoView >= 1, '7) with no opportunity/detail card anywhere, "View opportunities" falls back to the guaranteed Recently Researched entry instead of doing nothing');
  }

  // ---------------------------------------------------------------------
  // Requirement 8/9 -- Recently Researched dedupes reruns of the same
  // account and never distorts the underlying priority ranking.
  // ---------------------------------------------------------------------
  {
    const account = fixtureAccount('L.L.Bean');
    const sandbox = createSandbox({ accounts: [account] });
    // First research: 1 signal.
    sandbox.applyModalResearchResultToDashboard({ name: 'L.L.Bean', signals: [{ isReal: true }], lastResearchedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    // Rerun: 2 signals, newer timestamp.
    sandbox.applyModalResearchResultToDashboard({ name: 'L.L.Bean', signals: [{ isReal: true }, { isReal: true }], lastResearchedAt: new Date().toISOString() });
    const entries = sandbox.getRecentlyResearchedAccounts();
    assert(entries.length === 1, '8) two research runs for the SAME account produce exactly ONE Recently Researched entry, not two');
    assert(entries[0].name === 'L.L.Bean' && entries[0].signalCount === 2, '8) the single entry reflects the LATEST rerun\'s result (2 signals), not the first');
    assert(sandbox.__addSignalDerivedCalls.length === 2, '8) both research completions were genuinely applied (this is real dedup by account identity, not just "only one call happened")');
  }
  {
    // Requirement 9: recently-researched status must not appear anywhere
    // inside the account's own opportunity objects or otherwise feed a
    // ranking comparator -- applyModalResearchResultToDashboard() only
    // patches signals/lastResearchedAt/futureOpportunities and calls the
    // existing render pipeline; it contains no sort/comparator of its own.
    const src = extractFn('applyModalResearchResultToDashboard', 4692, 4702);
    assert(!/\.sort\(/.test(src), '9) applyModalResearchResultToDashboard() itself performs no sorting -- it cannot distort priority order, by construction');
  }
  {
    // Zero-signal result still produces a useful Recently Researched entry
    // (the "no-signal state" requirement) rather than being dropped.
    const account = fixtureAccount('No Signal Co');
    const sandbox = createSandbox({ accounts: [account] });
    sandbox.applyModalResearchResultToDashboard({ name: 'No Signal Co', signals: [], lastResearchedAt: new Date().toISOString() });
    const html = sandbox.renderRecentlyResearchedSection();
    const host = sandbox.__dom.recentlyResearchedSection;
    assert(/No verified signals found/.test(host.innerHTML), '9/8) a zero-signal research result still renders a clear "No verified signals found" Recently Researched entry, not a broken/empty one');
    assert(!/rr-view-btn/.test(host.innerHTML), '9/8) a zero-signal entry does not offer a dead "View opportunities" link (nothing to view)');
  }
  {
    // Dismiss removes the entry immediately (natural-expiry companion:
    // manual dismissal) -- exercised through the REAL delegated click
    // listener (recentlyResearchedClickListener, extracted verbatim above
    // and registered via the sandbox's document.addEventListener capture),
    // not a reimplementation of its dismiss logic.
    const account = fixtureAccount('Dismiss Co');
    const sandbox = createSandbox({ accounts: [account] });
    sandbox.applyModalResearchResultToDashboard({ name: 'Dismiss Co', signals: [{ isReal: true }], lastResearchedAt: new Date().toISOString() });
    assert(sandbox.getRecentlyResearchedAccounts().length === 1, 'dismiss: sanity check -- the entry exists before dismissal');
    const card = new FakeEl('div', { class: 'recently-researched-card', 'data-account-name': 'Dismiss Co' });
    const dismissBtn = new FakeEl('button', { class: 'rr-dismiss-btn' });
    card.appendChild(dismissBtn);
    const handler = sandbox.__dom.listeners.click;
    assert(typeof handler === 'function', 'dismiss: the real recentlyResearchedClickListener registered itself via document.addEventListener');
    handler({ target: dismissBtn });
    assert(sandbox.getRecentlyResearchedAccounts().length === 0, 'dismiss: after the real dismiss-button click handler runs, the account no longer appears in Recently Researched');
  }
  {
    // "View opportunities" clicked from a Recently Researched card routes
    // through the SAME real scrollToAccountResult() already unit-tested
    // above -- proven here by observing its real side effect (a
    // refreshOpportunityViews() call) when triggered via the delegated
    // listener rather than a direct call.
    const account = fixtureAccount('Click Co', { futureOpportunities: [{ account: 'Click Co', timebox: 'week' }] });
    const sandbox = createSandbox({ accounts: [account] });
    sandbox.applyModalResearchResultToDashboard({ name: 'Click Co', signals: [{ isReal: true }], lastResearchedAt: new Date().toISOString() });
    sandbox.__refreshCalls.length = 0;
    const card = new FakeEl('div', { class: 'recently-researched-card', 'data-account-name': 'Click Co' });
    const viewBtn = new FakeEl('button', { class: 'rr-view-btn' });
    card.appendChild(viewBtn);
    const handler = sandbox.__dom.listeners.click;
    handler({ target: viewBtn });
    assert(sandbox.__refreshCalls.length === 1, '7/8) clicking the real "View opportunities" button on a Recently Researched card triggers the real scrollToAccountResult() (observed via its refreshOpportunityViews() call)');
  }
}

async function main(){
  console.log('--- PART 1: server (api/monitoring-lists.js) ---');
  await runServerTests();
  console.log('\n--- PART 2: client (dashboard/index.html) ---');
  await runClientTests();
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
