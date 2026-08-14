// Founder live Preview QA round 10 (post round-9 empty-workspace redesign,
// which QA'd as "overwhelmingly positive"). Two tightly bounded corrections
// before banking product/commercial-activation-reasoning:
//
// Item 1 -- a successful upload must immediately retire the empty-workspace
// state. Live reproduction: a user with no customer data sees the "No
// customer data yet" card; they upload a list successfully; the real Your
// Accounts panel appears underneath with the uploaded accounts, but the
// empty-state card itself stays on screen until a manual Refresh Dashboard
// click. Root cause: processData()'s own post-upload sync
// (refreshAggregateDashboard()) always calls fetchAndRenderAggregateDashboard
// with {silent:true}. The success branch's #leadGate/#exampleOpportunity/
// #results/#memberEmptyState visibility-correcting logic used to be gated
// behind `if(!silent){...}`, so this silent, post-upload, now-populated
// response never hid #memberEmptyState. Same architectural bug class as the
// personalEmpty/noData branches fixed in rounds 6-8, but for the opposite
// (empty -> populated) transition. Fixed by extracting the reveal logic into
// applyPopulatedWorkspaceState() -- the populated-state counterpart to the
// existing applyEmptyWorkspaceState() -- and calling it unconditionally.
//
// Item 2 -- user-facing "Export Guides" / "Import Guide" terminology
// standardized to "Upload Guides" / "Upload Guide". That is a pure content
// rename covered by the existing string-assertion tests (see
// scripts/test-guided-tour-and-import-experience.js and
// scripts/test-stabilization-round.js, both updated this round); no new
// regression is needed for it here.
//
// This file exercises the REAL, unmodified, verbatim-extracted
// fetchAndRenderAggregateDashboard()/applyEmptyWorkspaceState()/
// applyPopulatedWorkspaceState()/renderEmptyWorkspaceState() (dashboard/
// index.html) inside a vm sandbox -- same extraction pattern established in
// scripts/test-live-qa-round9-empty-workspace.js -- not a reimplementation.
//
// Usage: node scripts/test-live-qa-round10-corrections.js

import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const SRC = [
  extractFn(DASHBOARD_SRC, 'renderEmptyWorkspaceState'),
  extractFn(DASHBOARD_SRC, 'applyEmptyWorkspaceState'),
  extractFn(DASHBOARD_SRC, 'applyPopulatedWorkspaceState'),
  extractFn(DASHBOARD_SRC, 'fetchAndRenderAggregateDashboard')
].join('\n\n');

function makeEl(){ return { style:{display:''}, textContent:'', innerHTML:'', hidden:false, classList:{ _c:new Set(), add(...c){c.forEach(x=>this._c.add(x));}, remove(...c){c.forEach(x=>this._c.delete(x));}, contains(c){return this._c.has(c);} } }; }

function buildClientScenario({ startEmpty } = {}){
  const els = {
    savedDashboardBanner: makeEl(), dashboardLoadingSkeleton: makeEl(), memberEmptyState: makeEl(),
    leadGate: makeEl(), exampleOpportunity: makeEl(), results: makeEl(), customerDashboard: makeEl(),
    emptyWorkspaceTitle: makeEl(), emptyWorkspaceBody: makeEl(), emptyWorkspaceSwitchTeam: makeEl()
  };
  if(startEmpty){
    // Reproduces the exact on-screen state right before a successful
    // upload: the round-9 empty-workspace card is visible, and the real
    // dashboard panels are hidden -- matching applyEmptyWorkspaceState()'s
    // own output, not an arbitrary guess.
    els.memberEmptyState.style.display = 'block';
    els.memberEmptyState.hidden = false;
    els.results.style.display = 'none';
    els.leadGate.style.display = 'block';
    els.exampleOpportunity.style.display = 'block';
  } else {
    els.results.style.display = 'block';
    els.customerDashboard.style.display = 'block';
  }
  els.emptyWorkspaceSwitchTeam.hidden = true;
  let nextResponse = null;
  const renderCalls = [];
  const houseAuth = { authHeadersAsync: async () => ({Authorization:'Bearer test'}) };
  const sandbox = {
    console,
    window: { accountRadarAccounts: startEmpty ? [] : [{name:'Stale Account'}], HouseAuth: houseAuth },
    HouseAuth: houseAuth,
    document: { getElementById: id => els[id] || null },
    fetch: async () => ({ ok: nextResponse.ok !== false, status: nextResponse.status || 200, json: async () => nextResponse.body }),
    currentDashboardData: null, dashboardCanViewTeam: true, dashboardViewMode: 'my',
    defaultDashboardView: () => 'my', renderDashboardViewSwitcher: () => {}, showJoinedWelcomeIfNeeded: () => {},
    normalizeSavedAccount: a => a,
    currentUploadId: null, currentUploadName: null, currentLead: { email:'rep@example.com' },
    localStorage: { setItem(){}, getItem(){ return null; } },
    renderCustomerDashboard: (data) => { renderCalls.push(data); }, refreshOpportunityViews: () => {},
    aggregateDashboardEverLoaded: !startEmpty, freshUploadRenderedThisSession: false, dashboardFetchGeneration: 0,
    escapeHtml: s => String(s || ''), canCurrentUserViewTeam: () => true
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\nthis.__exports = { fetchAndRenderAggregateDashboard };`, { filename: 'round10-client-render.js' }).runInContext(sandbox);
  return { sandbox, els, renderCalls, setNext: (body, opts = {}) => { nextResponse = {body, ...opts}; } };
}

// ===========================================================================
// Required regression: empty workspace -> successful upload/save (SILENT
// refresh, exactly like processData()'s own post-upload
// refreshAggregateDashboard() call) -> populated workspace, with the
// empty-state card retired WITHOUT a manual Refresh Dashboard/non-silent
// call.
// ===========================================================================
{
  const { sandbox, els, renderCalls, setNext } = buildClientScenario({ startEmpty: true });
  assert(els.memberEmptyState.style.display === 'block', 'sanity: the empty-workspace card starts visible, reproducing the state right before a successful upload');

  setNext({
    accounts: [{name:'Brightview Landscaping', id:'acct-1'}],
    upload: { id:'upload-1', upload_name:'brightview.csv' },
    user: { email:'rep@example.com' },
    canViewTeam: true, viewMode: 'my'
  });
  const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:true});

  assert(result.ok === true && !result.empty, `REQUIRED: a silent post-upload refresh that confirms real accounts resolves as a real, non-empty result (got ${JSON.stringify(result.empty)})`);
  assert(els.memberEmptyState.style.display === 'none', `REQUIRED (root fix): the "No customer data yet" card is hidden after a SILENT refresh confirms accountsSaved > 0, without requiring a manual Refresh Dashboard (got "${els.memberEmptyState.style.display}")`);
  assert(els.results.style.display === 'block', `REQUIRED: the real Your Accounts panel (#results) is revealed on the same silent refresh (got "${els.results.style.display}")`);
  assert(els.leadGate.style.display === 'none', 'REQUIRED: the pre-upload lead gate is hidden once real accounts are confirmed');
  assert(els.exampleOpportunity.style.display === 'none', 'REQUIRED: the Sample Analysis / example opportunity panel is hidden once real accounts are confirmed');
  assert(renderCalls.length === 1, `REQUIRED: renderCustomerDashboard() is called with the real server data on this same silent refresh (got ${renderCalls.length} call(s))`);
  assert(sandbox.window.accountRadarAccounts.length === 1 && sandbox.window.accountRadarAccounts[0].name === 'Brightview Landscaping', 'REQUIRED: the real uploaded accounts, not the stale pre-upload array, are what the dashboard now holds');
}

// ===========================================================================
// Preserve: a genuinely empty Team View (404 noData shape) still shows the
// empty-workspace state on a silent refresh -- must not have regressed by
// making the populated-state reveal unconditional.
// ===========================================================================
{
  const { sandbox, els, setNext } = buildClientScenario({ startEmpty: false });
  sandbox.dashboardViewMode = 'team';
  sandbox.fetch = async () => ({ ok:false, status:404, json: async () => ({ error:'No existing customer dashboard data found yet.' }) });
  const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:true});
  assert(result.ok === true && result.empty === true, 'PRESERVE: a genuinely empty Team View still resolves as empty on a silent refresh');
  assert(els.memberEmptyState.style.display !== 'none', `PRESERVE: the empty-workspace card is (re)shown for a genuinely empty Team View, not left hidden (got "${els.memberEmptyState.style.display}")`);
  assert(els.results.style.display === 'none', 'PRESERVE: #results stays hidden for a genuinely empty Team View');
}

// ===========================================================================
// Preserve: empty My View while the team genuinely has data still shows the
// empty-workspace state (with the Switch to Team View action), not the
// populated dashboard.
// ===========================================================================
{
  const { sandbox, els, setNext } = buildClientScenario({ startEmpty: false });
  setNext({ personalEmpty:true, teamHasData:true }, { requestedView:'my' });
  const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:true});
  assert(result.ok === true && result.empty === true, 'PRESERVE: personalEmpty with teamHasData:true still resolves as empty for My View');
  assert(els.memberEmptyState.style.display !== 'none', `PRESERVE: the empty-workspace card is shown when My View is empty even though the team has data (got "${els.memberEmptyState.style.display}")`);
  assert(els.emptyWorkspaceSwitchTeam.hidden === false, 'PRESERVE: the "Switch to Team View" action remains visible in this case');
}

// ===========================================================================
// Preserve: deleting the final list (server now reports personalEmpty
// again after a previously populated workspace) followed by a refresh
// correctly retires the populated dashboard back to the empty-workspace
// state -- the fix must not have made the populated state "sticky".
// ===========================================================================
{
  const { sandbox, els, setNext } = buildClientScenario({ startEmpty: false });
  assert(els.results.style.display === 'block', 'sanity: scenario starts populated, reproducing "final list just deleted, now refreshing"');
  setNext({ personalEmpty:true, teamHasData:false }, { requestedView:'my' });
  const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:false});
  assert(result.ok === true && result.empty === true, 'PRESERVE: after deleting the final list, a refresh resolves as empty again');
  assert(els.memberEmptyState.style.display !== 'none', `PRESERVE: the empty-workspace card returns after the final list is deleted (got "${els.memberEmptyState.style.display}")`);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
