// Fresh-upload-feedback-rendering incident, root-cause fix.
//
// Founder QA (real Preview deployment, commit 79a6915): a fresh Follow-Up/
// Repeat-Pattern opportunity card (e.g. Quantum Materials) rendered with NO
// Useful/Not-useful controls and the OLD plain-onclick "Prepare for Call ->"
// button, even though the /api/get-dashboard response the browser actually
// received for that same account DID contain the correct, server-stamped
// accountOpportunityId/accountOpportunityFingerprint. DevTools showed TWO
// /api/get-dashboard requests in the same page load, both originating from
// fetchAndRenderAggregateDashboard()'s single fetch call site.
//
// Root cause: fetchAndRenderAggregateDashboard() has multiple independent,
// uncoordinated callers -- the 250ms post-DOMContentLoaded page-load
// auto-load, and refreshAggregateDashboard() (fired right after a fresh
// upload's save resolves), among others. Neither call knew about the other,
// and neither cancelled the other. Whichever response happened to arrive
// LAST simply overwrote window.accountRadarAccounts and re-rendered the
// opportunities grid -- even when it was actually the OLDER of the two
// requests. On a fresh upload made shortly after page load, this let the
// page-load fetch (issued before the new upload's ha_account_opportunities
// rows existed) resolve AFTER the correct post-upload refresh and silently
// clobber it with stale/incomplete data, discarding the refs the correct
// response had just supplied.
//
// The fix: a monotonic dashboardFetchGeneration counter, captured by each
// call before its own fetch, checked before that call is allowed to touch
// window.accountRadarAccounts/re-render. A response is applied only if it
// belongs to the most recently INITIATED call; a stale one is dropped
// regardless of arrival order.
//
// This test exercises the REAL, extracted fetchAndRenderAggregateDashboard()
// (and the real dashboardFetchGeneration/aggregateDashboardEverLoaded state
// it shares module-scope with) against a mocked fetch whose two responses
// are deliberately resolved OUT OF INITIATION ORDER -- the older call's
// network response is held back and only released after the newer call has
// already completed and rendered, exactly like the live incident. Only
// collaborators with no bearing on the race itself (DOM-cosmetic renderers,
// auth headers) are stubbed; normalizeSavedAccount() is real, so the
// asserted "correct" render still carries genuine accountOpportunityId/
// accountOpportunityFingerprint refs end to end.
//
// Usage: node scripts/test-fresh-upload-dashboard-refresh-race.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

const DASHBOARD_SRC = loadDashboardSource();
function fn(name){ return extractFn(DASHBOARD_SRC, name); }

const REAL_SOURCE = [
  fn('aggregateDashboardEverLoaded'),
  fn('dashboardFetchGeneration'),
  fn('freshUploadRenderedThisSession'),
  fn('fetchAndRenderAggregateDashboard'),
  fn('refreshAggregateDashboard'),
  fn('loadSavedDashboard'),
  fn('normalizeSavedAccount'),
  fn('dedupeOpportunities'),
  fn('opportunityDedupeKey'),
  fn('buyingOpportunityIdentity'),
  fn('cleanOpportunityToken'),
  fn('mergeBusinessSignalInitiatives'),
  fn('clusterBusinessSignalOpportunities'),
  fn('isWebResearchSignal'),
  fn('signalLayerLabel'),
  fn('normalizeSignalLayerType'),
  fn('isRecentAccountActivity'),
  fn('getRecommendationType'),
  fn('isRelationshipExpansionOpportunity'),
  fn('normalizedConfidenceValue'),
  fn('evidenceCount'),
  fn('getOpportunityPlanningWindow'),
  fn('classifyMonthWindow'),
  fn('inferPurchaseMonth'),
  fn('monthIndexFromName'),
  fn('monthDistanceFromNow'),
  fn('primaryCategoryFromOpportunity'),
  fn('shortText'),
  fn('currentOrgPreferences'),
  fn('ORG_PREFERENCE_FAMILY_BY_SIGNAL_LAYER'),
  fn('getOrgPreferenceAdjustmentForOpportunity'),
  fn('assignOpportunityScore'),
  fn('calculateOpportunityScore'),
  fn('getOpportunityScore'),
  fn('scoreFromFreshness'),
  fn('clampScore'),
  fn('daysSinceDate'),
].join('\n\n');

// Pure DOM-cosmetic / permission collaborators -- none of them touch
// window.accountRadarAccounts or the opportunities grid, so stubbing them
// has no bearing on the race-guard logic under test. refreshOpportunityViews
// is the one meaningful stub: it records EVERY time it is invoked and a
// snapshot of window.accountRadarAccounts at that moment, which is exactly
// what proves whether the stale response ever got a chance to render.
const STUB_SOURCE = `
function canCurrentUserViewTeam(){ return false; }
function defaultDashboardView(){ return 'my'; }
function renderDashboardViewSwitcher(){}
function showJoinedWelcomeIfNeeded(){}
function applyEmptyWorkspaceState(){ emptyWorkspaceCalls.push(1); }
function applyPopulatedWorkspaceState(){}
function renderCustomerDashboard(data){ renderCustomerDashboardCalls.push(data); }
function escapeHtml(s){ return String(s || ''); }
function likelyDepartmentFromOpportunity(o){ return o.department || ''; }
function departmentFromText(t){ return t || ''; }
function likelyKnownBuyer(o){ return o.buyer || o.contact || ''; }
function likelySuggestedContact(o){ return o.suggestedContact || ''; }
function dedupeFoundSignals(signals){ return signals || []; }
var renderLog = [];
var emptyWorkspaceCalls = [];
var renderCustomerDashboardCalls = [];
function refreshOpportunityViews(){
  renderLog.push((window.accountRadarAccounts || []).map(a => ({
    name: a.name,
    opportunities: (a.futureOpportunities || []).map(o => ({
      opportunity: o.opportunity,
      accountOpportunityId: o.accountOpportunityId || null,
      accountOpportunityFingerprint: o.accountOpportunityFingerprint || null
    }))
  })));
}
`;

const INIT_SOURCE = `
var currentDashboardData = null;
var dashboardCanViewTeam = false;
var dashboardViewMode = null;
var currentUploadId = null;
var currentUploadName = null;
var currentLead = null;
`;

const localStorageStub = { setItem(){}, getItem(){ return null; } };
const domElements = {
  savedDashboardBanner: { style:{}, textContent:'', innerHTML:'', set display(v){}, get display(){return '';} },
  dashboardLoadingSkeleton: { classList: { add(){}, remove(){} } },
};

const sandbox = {
  window: { accountRadarAccounts: [] },
  document: { getElementById: (id) => domElements[id] || null },
  localStorage: localStorageStub,
  HouseAuth: { authHeadersAsync: async () => ({}) },
  console,
  Date, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, isNaN, parseInt, parseFloat, Promise,
};
vm.createContext(sandbox);

let fetchCallCount = 0;
let releaseStaleResponse = null;
const STALE_RESPONSE = {
  // The page-load fetch: issued BEFORE the fresh upload's opportunity rows
  // existed server-side. Quantum Materials is present (this account isn't
  // new), but its Follow-Up opportunity has not yet been ref-stamped --
  // exactly the "reset"/unstamped shape the live incident's DOM showed.
  accounts: [{
    name: 'Quantum Materials',
    uploadId: 'upload-1',
    monitoringStatus: 'active',
    revenue: 40000,
    orderCount: 3,
    confidence: 60,
    relationshipStrength: 50,
    mostRecentDate: '2026-08-01',
    subscores: { revenue: 0.4, frequency: 0.3, recency: 0.3, diversity: 0.5 },
    purchases: [], projects: [], allProjects: [], activePipeline: [], categoryTypes: [], signals: [],
    futureOpportunities: [{
      opportunity: 'Reconnect with Quantum Materials',
      opportunityType: 'FOLLOW UP',
      signalLayerType: 'Follow-Up Signal',
      account: 'Quantum Materials',
      confidence: 60,
      actionabilityStatus: 'actionable'
      // no accountOpportunityId/accountOpportunityFingerprint yet
    }]
  }],
  upload: { id: 'upload-1', upload_name: 'Fresh list' },
  user: { email: 'kpafford@wodelder.com' },
  canViewTeam: false,
  viewMode: 'my'
};
const CORRECT_RESPONSE = {
  // The post-upload refresh: issued AFTER save-upload persisted
  // ha_account_opportunities, so the ref is present.
  accounts: [{
    name: 'Quantum Materials',
    uploadId: 'upload-1',
    monitoringStatus: 'active',
    revenue: 40000,
    orderCount: 3,
    confidence: 60,
    relationshipStrength: 50,
    mostRecentDate: '2026-08-01',
    subscores: { revenue: 0.4, frequency: 0.3, recency: 0.3, diversity: 0.5 },
    purchases: [], projects: [], allProjects: [], activePipeline: [], categoryTypes: [], signals: [],
    futureOpportunities: [{
      opportunity: 'Reconnect with Quantum Materials',
      opportunityType: 'FOLLOW UP',
      signalLayerType: 'Follow-Up Signal',
      account: 'Quantum Materials',
      confidence: 60,
      actionabilityStatus: 'actionable',
      accountOpportunityId: 'oppo-real-id-123',
      accountOpportunityFingerprint: 'fingerprint-abc'
    }]
  }],
  upload: { id: 'upload-1', upload_name: 'Fresh list' },
  user: { email: 'kpafford@wodelder.com' },
  canViewTeam: false,
  viewMode: 'my'
};

sandbox.fetch = (url) => {
  fetchCallCount += 1;
  if(fetchCallCount === 1){
    // Call A (page load): held open until explicitly released below, so it
    // resolves AFTER call B -- the exact out-of-order arrival the live
    // incident's DevTools capture showed.
    return new Promise((resolve) => {
      releaseStaleResponse = () => resolve({ ok:true, json: async () => STALE_RESPONSE });
    });
  }
  // Call B (post-upload refresh): resolves immediately with the correct,
  // ref-bearing data.
  return Promise.resolve({ ok:true, json: async () => CORRECT_RESPONSE });
};

vm.runInContext(INIT_SOURCE + '\n' + STUB_SOURCE + '\n' + REAL_SOURCE, sandbox, { filename: 'dashboard-extract.js' });

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

async function main(){
  // Call A starts (page load fetch). Its own fetch() call is issued on the
  // microtask after HouseAuth.authHeadersAsync() resolves.
  const callAPromise = sandbox.fetchAndRenderAggregateDashboard('kpafford@wodelder.com', {silent:false});
  // Let call A actually reach its fetch() call (issuing fetchCallCount===1)
  // before starting call B, so call B is genuinely the SECOND-initiated call.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(fetchCallCount === 1, 'call A (page-load fetch) issued its request first');

  // Call B starts (post-upload refresh) -- this is what a fresh upload's
  // saveCurrentUpload().then(refreshAggregateDashboard()) triggers.
  const callBPromise = sandbox.fetchAndRenderAggregateDashboard('kpafford@wodelder.com', {silent:true});
  const callBResult = await callBPromise;

  assert(fetchCallCount === 2, 'call B (post-upload refresh) issued its own request');
  assert(callBResult.ok === true && !callBResult.stale, 'call B (the newer, correct response) was applied, not dropped as stale');

  const rendersAfterB = sandbox.renderLog.length;
  assert(rendersAfterB === 1, `exactly one render happened by the time call B resolved (got ${rendersAfterB})`);
  const oppAfterB = sandbox.renderLog[0]?.[0]?.opportunities?.[0];
  assert(!!oppAfterB?.accountOpportunityId && !!oppAfterB?.accountOpportunityFingerprint,
    'the render after call B carries the real accountOpportunityId/accountOpportunityFingerprint refs');

  // Now release call A's held-open response -- the OLDER, unstamped
  // snapshot finally "arrives" after the correct one already rendered.
  releaseStaleResponse();
  const callAResult = await callAPromise;

  assert(callAResult.ok === true && callAResult.stale === true,
    'call A (the older page-load fetch, arriving last) was recognized as stale and dropped');

  const rendersAfterA = sandbox.renderLog.length;
  assert(rendersAfterA === 1,
    `call A's stale response must NOT trigger a second render that could clobber the correct one (got ${rendersAfterA} total renders)`);

  const finalAccounts = sandbox.window.accountRadarAccounts;
  const finalOpp = finalAccounts?.[0]?.futureOpportunities?.[0];
  assert(finalAccounts?.[0]?.name === 'Quantum Materials', 'window.accountRadarAccounts still reflects Quantum Materials after both calls settle');
  assert(!!finalOpp?.accountOpportunityId && !!finalOpp?.accountOpportunityFingerprint,
    'window.accountRadarAccounts still carries the correct refs after the stale response arrives -- NOT clobbered back to the unstamped shape');
  assert(finalOpp?.accountOpportunityId === 'oppo-real-id-123',
    'the surviving ref is specifically the one from the correct (call B) response, not the stale one');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
