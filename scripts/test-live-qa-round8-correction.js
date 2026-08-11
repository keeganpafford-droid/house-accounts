// Founder Preview QA round 8 -- the actual root cause of the "Refresh
// Dashboard after deleting the last upload still shows stale state"
// blocker rounds 6 and 7 both believed they had closed, but which
// survived the founder's exact live acceptance test on c3af125.
//
// Root cause, proven by tracing the real call sequence (not inferred from
// structure): a confirmed-empty workspace can reach
// fetchAndRenderAggregateDashboard() through TWO genuinely different
// server response shapes from the SAME /api/get-dashboard endpoint:
//   1. A 200 with personalEmpty:true -- api/get-dashboard.js's explicit
//      contract for viewMode==='my' when the user owns zero uploads.
//   2. A 404 "No existing customer dashboard data found yet." -- what the
//      SAME endpoint returns for viewMode==='team' once the org's last
//      upload/account/signal rows are gone. There is no team-scoped
//      personalEmpty response; this 404 IS team view's empty contract.
// defaultDashboardView() defaults an owner/admin account -- exactly the
// kind of account a founder testing their own product uses -- to 'team'
// view. So the founder's real Refresh Dashboard click was hitting shape 2
// this whole time, never shape 1. Rounds 6 and 7 only ever touched shape
// 1's branch (data.personalEmpty===true) and its own freshUploadRenderedThisSession
// lifecycle -- both real, both correctly fixed, both irrelevant to what the
// founder was actually triggering.
//
// Shape 2's catch-block handling had two independent defects of its own:
//   a. `if(isMember && noData)` -- isMember = !canCurrentUserViewTeam() --
//      excluded any team-capable (owner/admin) account from recognizing
//      this 404 as a legitimate empty state AT ALL. For those accounts it
//      fell through to the generic error path: a "No dashboard loaded: No
//      existing customer dashboard data found yet." banner, with ZERO
//      state cleared -- proving the founder's own screenshot description
//      of seeing that exact banner simultaneously with the stale panel.
//   b. Even for a plain member who DID enter this branch, its clearing
//      logic only touched memberEmptyState/leadGate/exampleOpportunity/
//      results/banner visibility -- it never cleared window.
//      accountRadarAccounts, currentUploadId/currentUploadName, the Your
//      Accounts panel, or called refreshOpportunityViews(), unlike the
//      personalEmpty branch.
//
// Fix: both branches now call one shared applyEmptyWorkspaceState() (see
// dashboard/index.html, defined immediately above
// fetchAndRenderAggregateDashboard()), and the noData branch's role
// restriction is removed -- a confirmed "no existing customer dashboard
// data" 404 is unambiguous regardless of role.
//
// This file proves BOTH halves: that the exact scenario demonstrably fails
// against the prior commit (c3af125) it inherited, and that it is fixed now
// -- through the REAL, current fetchAndRenderAggregateDashboard(), not a
// reimplementation, asserting the final DOM/state after the async call
// fully settles (not merely that a flag was reset or a function was called).
//
// Usage: node scripts/test-live-qa-round8-correction.js
import vm from 'vm';
import { execFileSync } from 'child_process';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

function makeEl(){ return { style:{display:''}, textContent:'', innerHTML:'', classList:{ _c:new Set(), add(...c){c.forEach(x=>this._c.add(x));}, remove(...c){c.forEach(x=>this._c.delete(x));}, contains(c){return this._c.has(c);} } }; }

function buildScenario(dashboardSrc){
  const els = {
    savedDashboardBanner: makeEl(), dashboardLoadingSkeleton: makeEl(), memberEmptyState: makeEl(),
    leadGate: makeEl(), exampleOpportunity: makeEl(), results: makeEl(), customerDashboard: makeEl(),
    emptyWorkspaceTitle: makeEl(), emptyWorkspaceBody: makeEl(), emptyWorkspaceSwitchTeam: makeEl()
  };
  els.results.style.display = 'block';
  els.customerDashboard.style.display = 'block';
  els.memberEmptyState.style.display = 'none';
  els.exampleOpportunity.style.display = 'none';
  els.emptyWorkspaceSwitchTeam.hidden = true;

  // The exact founder scenario: an owner/admin account (canCurrentUserViewTeam()
  // === true), whose dashboardViewMode defaults to 'team', clicking Refresh
  // Dashboard (loadSavedDashboard() -> fetchAndRenderAggregateDashboard(e,
  // {silent:false})) after deleting the only uploaded list -- the server's
  // team-scoped ha_uploads/ha_accounts/ha_signals query now finds nothing,
  // so /api/get-dashboard genuinely 404s with "No existing customer
  // dashboard data found yet."
  const houseAuth = { authHeadersAsync: async () => ({Authorization:'Bearer test'}) };
  const sandbox = {
    console,
    window: { accountRadarAccounts: [{name:'Ridgeline Auto Group'}, {name:'Brightview Dental Group'}], HouseAuth: houseAuth },
    HouseAuth: houseAuth,
    document: { getElementById: id => els[id] || null },
    fetch: async () => ({ ok:false, status:404, json: async () => ({ error:'No existing customer dashboard data found yet.' }) }),
    currentDashboardData: null, dashboardCanViewTeam: true, dashboardViewMode: 'team',
    defaultDashboardView: () => 'team', renderDashboardViewSwitcher: () => {}, showJoinedWelcomeIfNeeded: () => {},
    normalizeSavedAccount: a => a,
    currentUploadId: 'upload-deleted', currentUploadName: 'fixture.csv', currentLead: { email:'owner@example.com' },
    localStorage: { setItem(){}, getItem(){ return null; } },
    renderCustomerDashboard: () => {}, refreshOpportunityViews: () => {},
    aggregateDashboardEverLoaded: true, freshUploadRenderedThisSession: false,
    escapeHtml: s => String(s || ''),
    // The founder's own role: owner/admin, team-capable.
    canCurrentUserViewTeam: () => true
  };
  vm.createContext(sandbox);
  new vm.Script(`${dashboardSrc}\nthis.__exports = { fetchAndRenderAggregateDashboard };`, { filename: 'round8-lifecycle.js' }).runInContext(sandbox);
  return { sandbox, els };
}

// ===========================================================================
// Explicit proof this regression fails against the prior commit (c3af125),
// per the founder's requirement -- extracted from the actual git history,
// not a hand-written "what it used to look like" approximation.
// ===========================================================================
{
  let oldSrc = null;
  try{
    const oldFile = execFileSync('git', ['show', 'c3af125:dashboard/index.html'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
    oldSrc = extractFn(oldFile, 'fetchAndRenderAggregateDashboard');
  }catch(err){
    console.log(`NOTE: could not read c3af125:dashboard/index.html from git history (${err.message}) -- skipping the before/after proof, but the fix itself is still verified below against the current file.`);
  }
  if(oldSrc){
    const { sandbox, els } = buildScenario(oldSrc);
    const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('owner@example.com', {silent:false});
    assert(result.ok === false, 'PROOF this scenario fails on c3af125: the team-view 404 for an owner/admin account was NOT recognized as a legitimate empty state (isMember && noData excluded it) -- it returned {ok:false}, the exact "No dashboard loaded: ..." error path');
    assert(sandbox.window.accountRadarAccounts.length === 2, `PROOF this scenario fails on c3af125: window.accountRadarAccounts still holds the stale accounts (got ${JSON.stringify(sandbox.window.accountRadarAccounts)}) -- nothing was cleared`);
    assert(els.customerDashboard.style.display === 'block', 'PROOF this scenario fails on c3af125: the Your Accounts panel is still visible with stale content');
    assert(els.results.style.display === 'block', 'PROOF this scenario fails on c3af125: the priorities feed container is still visible');
  }
}

// ===========================================================================
// The fix, proven against the REAL, current fetchAndRenderAggregateDashboard()
// (and its new applyEmptyWorkspaceState() helper) -- final DOM/state
// asserted only after the async call has fully settled.
// ===========================================================================
{
  const SRC = [extractFn(DASHBOARD_SRC, 'renderEmptyWorkspaceState'), extractFn(DASHBOARD_SRC, 'applyEmptyWorkspaceState'), extractFn(DASHBOARD_SRC, 'fetchAndRenderAggregateDashboard')].join('\n\n');
  const { sandbox, els } = buildScenario(SRC);

  const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('owner@example.com', {silent:false});

  assert(result.ok === true && result.empty === true, `REQUIRED: an owner/admin account's team-view confirmed-empty 404 is now recognized as a legitimate empty workspace, not an error (got ${JSON.stringify(result)})`);
  assert(Array.isArray(sandbox.window.accountRadarAccounts) && sandbox.window.accountRadarAccounts.length === 0, `REQUIRED: window.accountRadarAccounts is cleared -- the stale Ridgeline/Brightview accounts do not survive Refresh Dashboard (got ${JSON.stringify(sandbox.window.accountRadarAccounts)})`);
  assert(sandbox.currentUploadId === null, 'REQUIRED (old upload filename cannot render): currentUploadId is cleared');
  assert(sandbox.currentUploadName === '', 'REQUIRED (old upload filename cannot render): currentUploadName is cleared');
  assert(els.customerDashboard.style.display === 'none', 'REQUIRED (saved account/signal count cannot remain): the Your Accounts panel is hidden');
  assert(els.results.style.display === 'none', 'REQUIRED (old opportunity cards cannot remain): the priorities feed container is hidden');
  assert(els.memberEmptyState.style.display === 'block', 'REQUIRED: the correct empty-workspace UI is visible');
  // Live QA round 9: the hardcoded "Sample Analysis / Acme Manufacturing"
  // example card is no longer shown for this signed-in path -- replaced by
  // renderEmptyWorkspaceState()'s team-context copy inside #memberEmptyState.
  assert(els.exampleOpportunity.style.display !== 'block', 'REQUIRED: the old Sample Analysis example card is NOT shown for this confirmed-empty team workspace');
  assert(/Your team hasn't uploaded customer data yet/.test(els.emptyWorkspaceBody.textContent), `REQUIRED: the empty-state body uses team-context copy for a team-view empty workspace (got "${els.emptyWorkspaceBody.textContent}")`);
  assert(els.leadGate.style.display === 'none', 'sanity: the lead gate stays hidden for an already-authenticated user');
}

// ===========================================================================
// Sanity: the SAME fix must not regress the already-fixed 'my'-view
// personalEmpty (200) path from round 6, or the freshUploadRenderedThisSession
// stale-race guard from round 7 -- both now flow through the same shared
// applyEmptyWorkspaceState().
// ===========================================================================
{
  const SRC = [extractFn(DASHBOARD_SRC, 'renderEmptyWorkspaceState'), extractFn(DASHBOARD_SRC, 'applyEmptyWorkspaceState'), extractFn(DASHBOARD_SRC, 'fetchAndRenderAggregateDashboard')].join('\n\n');
  const els = { savedDashboardBanner: makeEl(), dashboardLoadingSkeleton: makeEl(), memberEmptyState: makeEl(), leadGate: makeEl(), exampleOpportunity: makeEl(), results: makeEl(), customerDashboard: makeEl() };
  els.results.style.display = 'block';
  els.customerDashboard.style.display = 'block';
  const houseAuth = { authHeadersAsync: async () => ({Authorization:'Bearer test'}) };
  const sandbox = {
    console,
    window: { accountRadarAccounts: [{name:'Stale'}], HouseAuth: houseAuth },
    HouseAuth: houseAuth,
    document: { getElementById: id => els[id] || null },
    fetch: async () => ({ ok:true, json: async () => ({ personalEmpty:true }) }),
    currentDashboardData: null, dashboardCanViewTeam: false, dashboardViewMode: 'mine',
    defaultDashboardView: () => 'mine', renderDashboardViewSwitcher: () => {}, showJoinedWelcomeIfNeeded: () => {},
    normalizeSavedAccount: a => a,
    currentUploadId: 'upload-deleted', currentUploadName: 'fixture.csv', currentLead: { email:'member@example.com' },
    localStorage: { setItem(){}, getItem(){ return null; } },
    renderCustomerDashboard: () => {}, refreshOpportunityViews: () => {},
    aggregateDashboardEverLoaded: true, freshUploadRenderedThisSession: true,
    escapeHtml: s => String(s || ''), canCurrentUserViewTeam: () => false
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\nthis.__exports = { fetchAndRenderAggregateDashboard };`, { filename: 'round8-guard-sanity.js' }).runInContext(sandbox);
  const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('member@example.com', {silent:true});
  assert(result.skipped === true, 'sanity: round 7\'s freshUploadRenderedThisSession stale-race guard still protects a genuinely fresher client render, unchanged by this round\'s refactor');
  assert(sandbox.window.accountRadarAccounts.length === 1, 'sanity: a stale-race personalEmpty response still does not clear a genuinely fresher render');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
