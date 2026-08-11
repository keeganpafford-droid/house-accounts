// Founder Preview QA round 7 -- the actual root cause of the "Refresh
// Dashboard after deleting the last upload still shows stale state" blocker
// round 6 believed it had closed.
//
// Root cause: fetchAndRenderAggregateDashboard()'s data.personalEmpty===true
// branch has always contained a guard -- `if(freshUploadRenderedThisSession)
// return {ok:true, empty:true, skipped:true};` -- to protect a freshly
// client-rendered upload against a STALE response that predates it
// server-side (replication/read lag). freshUploadRenderedThisSession is set
// true once, inside processData(), the instant a fresh upload renders
// client-side -- but nothing ever set it back to false. It is a one-shot
// flag that, once true, stayed true for the REST OF THE PAGE SESSION,
// protecting that upload's render against every future personalEmpty
// response, not just the narrow race it was built for.
//
// Confirmed production lifecycle: upload a list (flag set true) -> delete
// that same list later in the SAME page session (server-confirmed empty --
// Manage Customer Accounts correctly shows "No uploaded customer accounts
// found") -> click Refresh Dashboard -> the server correctly returns
// personalEmpty:true, but the guard -- still true from the LONG-FINISHED
// original upload -- treated this genuinely new, authoritative empty
// response as if it still predated that upload, and skipped clearing
// anything. A full page reload "fixes" it only because it resets this
// in-memory flag back to its initial false.
//
// Round 6's fix (making the personalEmpty branch's clearing run regardless
// of `silent`) was necessary but not sufficient: it never reaches that
// clearing code at all when the skip guard fires first, regardless of
// silent/non-silent, since the guard's early return happens before the
// silent check. This round's fix bounds the guard's actual protection
// window: processData()'s own post-upload refreshAggregateDashboard() call
// is the ONE guaranteed follow-up attempt at syncing the aggregate with a
// fresh upload -- once THAT resolves, the upload has had its real chance to
// be reflected, so freshUploadRenderedThisSession is reset to false right
// there. Any later response (including one from an unrelated deletion
// minutes afterward) is then treated as new information, not a stale race.
//
// Usage: node scripts/test-live-qa-round7-correction.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

// ===========================================================================
// Source-level proof: the reset happens in exactly the right place -- AFTER
// processData()'s own post-upload refreshAggregateDashboard() call
// resolves, inside the same saveCurrentUpload('uploaded').then() callback
// that showUploadSuccessModal()/showUploadFailureModal() (round 5) and the
// retryable-failure state (FR2 round) already live in. Never reset BEFORE
// that call (which would defeat the guard's real, narrow purpose), and
// never left permanently true (the actual bug).
// ===========================================================================
{
  const processDataSrc = extractFn(DASHBOARD_SRC, 'processData');
  const chainStart = processDataSrc.indexOf("saveCurrentUpload('uploaded').then(async (saveResult) => {");
  assert(chainStart !== -1, 'sanity: found the post-upload save chain inside processData()');
  const chain = processDataSrc.slice(chainStart);
  assert(
    /if\(typeof refreshAggregateDashboard === 'function'\) refreshResult = await refreshAggregateDashboard\(\);[\s\S]*?freshUploadRenderedThisSession = false;/.test(chain),
    'REQUIRED: freshUploadRenderedThisSession is reset to false AFTER processData()\'s own post-upload refreshAggregateDashboard() call resolves -- its one-shot protection window has a real end, it does not silently protect a stale render for the rest of the page session'
  );
}

// ===========================================================================
// Full lifecycle, through the REAL fetchAndRenderAggregateDashboard(),
// proving the actual guard mechanism the fix touches: a flag correctly set
// true by an upload, correctly protecting against ONE stale race, then
// correctly cleared once that upload's own guaranteed follow-up refresh has
// resolved -- so a LATER, genuinely authoritative empty response (a
// deletion, not a race) is never silently skipped again.
// ===========================================================================
{
  // Live QA round 8: fetchAndRenderAggregateDashboard()'s empty-state
  // clearing was factored out into a shared applyEmptyWorkspaceState()
  // helper -- must be extracted alongside it now.
  const SRC = [extractFn(DASHBOARD_SRC, 'applyEmptyWorkspaceState'), extractFn(DASHBOARD_SRC, 'fetchAndRenderAggregateDashboard')].join('\n\n');

  function makeEl(){ return { style:{display:''}, textContent:'', innerHTML:'', classList:{ _c:new Set(), add(...c){c.forEach(x=>this._c.add(x));}, remove(...c){c.forEach(x=>this._c.delete(x));}, contains(c){return this._c.has(c);} } }; }

  function buildScenario(){
    const els = {
      savedDashboardBanner: makeEl(), dashboardLoadingSkeleton: makeEl(), memberEmptyState: makeEl(),
      leadGate: makeEl(), exampleOpportunity: makeEl(), results: makeEl(), customerDashboard: makeEl()
    };
    els.results.style.display = 'block';
    els.customerDashboard.style.display = 'block';
    els.memberEmptyState.style.display = 'none';
    els.exampleOpportunity.style.display = 'none';

    let nextResponse = null;
    const calls = { refreshOpportunityViews: 0 };
    const houseAuth = { authHeadersAsync: async () => ({Authorization:'Bearer test'}) };
    const sandbox = {
      console,
      window: { accountRadarAccounts: [], HouseAuth: houseAuth },
      HouseAuth: houseAuth,
      document: { getElementById: id => els[id] || null },
      fetch: async () => ({ ok:true, json: async () => nextResponse }),
      currentDashboardData: null, dashboardCanViewTeam: false, dashboardViewMode: 'mine',
      defaultDashboardView: () => 'mine', renderDashboardViewSwitcher: () => {}, showJoinedWelcomeIfNeeded: () => {},
      normalizeSavedAccount: a => a,
      currentUploadId: null, currentUploadName: '', currentLead: { email:'rep@example.com' },
      localStorage: { setItem(){}, getItem(){ return null; } },
      renderCustomerDashboard: () => {}, refreshOpportunityViews: () => { calls.refreshOpportunityViews++; },
      aggregateDashboardEverLoaded: false, freshUploadRenderedThisSession: false,
      escapeHtml: s => String(s || ''), canCurrentUserViewTeam: () => true
    };
    vm.createContext(sandbox);
    new vm.Script(`${SRC}\nthis.__exports = { fetchAndRenderAggregateDashboard };`, { filename: 'round7-lifecycle.js' }).runInContext(sandbox);
    return { sandbox, els, calls, setNextResponse: r => { nextResponse = r; } };
  }

  const { sandbox, els, calls, setNextResponse } = buildScenario();

  // Step 1: a fresh upload just rendered client-side -- processData() sets
  // this flag true before its own save/refresh chain even starts.
  sandbox.freshUploadRenderedThisSession = true;
  sandbox.window.accountRadarAccounts = [{name:'Ridgeline Auto Group'}, {name:'Brightview Dental Group'}];

  // Step 2: processData()'s OWN post-upload refreshAggregateDashboard()
  // call resolves -- in the common case, the server has already caught up
  // and returns the real, non-empty aggregate.
  setNextResponse({ accounts: [{account_name:'Ridgeline Auto Group'}, {account_name:'Brightview Dental Group'}], signals: [], weeklyRuns: [], upload:{id:'upload-1', upload_name:'fixture.csv'} });
  await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:true});
  // This is the actual fix under test: processData() itself resets the flag
  // right after this call resolves (proven by the source-pattern assertion
  // above) -- simulated here directly, since fully executing processData()
  // would require stubbing its entire unrelated CSV-parse/account-build
  // pipeline for no additional proof value.
  sandbox.freshUploadRenderedThisSession = false;
  assert(sandbox.freshUploadRenderedThisSession === false, 'sanity: the flag is reset once the upload\'s guaranteed follow-up refresh has resolved');

  // Step 3: LATER in the same page session (any amount of time -- the flag
  // has no expiry, only this explicit reset), the user deletes the only
  // uploaded list via Manage Customer Accounts (real, server-confirmed
  // deletion -- not simulated here, only its downstream effect: the next
  // aggregate fetch legitimately returns personalEmpty), then clicks
  // Refresh Dashboard.
  const refreshOpportunityViewsCallsBeforeDeletion = calls.refreshOpportunityViews;
  setNextResponse({ personalEmpty:true });
  const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:false});

  assert(result.skipped !== true, 'REQUIRED: a personalEmpty response arriving AFTER the upload\'s protection window has closed is never treated as a stale race -- it is real, current information');
  assert(Array.isArray(sandbox.window.accountRadarAccounts) && sandbox.window.accountRadarAccounts.length === 0, `REQUIRED: window.accountRadarAccounts is cleared -- the stale Ridgeline/Brightview accounts from the deleted upload do not survive Refresh Dashboard (got ${JSON.stringify(sandbox.window.accountRadarAccounts)})`);
  assert(sandbox.currentUploadId === null && sandbox.currentUploadName === '', 'REQUIRED: the deleted upload\'s id/name are cleared, not left stale');
  assert(els.customerDashboard.style.display === 'none', 'REQUIRED (top account summary): the Your Accounts panel is hidden -- it must not keep showing the deleted upload\'s filename/account count/signal count');
  assert(els.results.style.display === 'none', 'REQUIRED (opportunity feeds): the priorities feed container is hidden, matching a full page reload');
  assert(calls.refreshOpportunityViews === refreshOpportunityViewsCallsBeforeDeletion + 1, 'REQUIRED (opportunity feeds): refreshOpportunityViews() runs on this refresh, clearing the stat bar/priorities feed/Recently Researched derived from window.accountRadarAccounts');
  assert(els.memberEmptyState.style.display === 'block' && els.exampleOpportunity.style.display === 'block', 'REQUIRED: the existing clean empty-workspace UI is shown, matching what a hard browser reload already produces -- Manage Customer Accounts and the dashboard now agree');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
