// Founder Preview QA round 6 -- final correction pass on
// product/commercial-activation-reasoning before banking the branch. Four
// items, each exercised through the REAL, verbatim-extracted production
// functions (dashboard-extract.js), never reimplementations.
//
// Root causes closed this round:
//   1. fetchAndRenderAggregateDashboard()'s data.personalEmpty===true branch
//      only cleared window.accountRadarAccounts and toggled the empty-state
//      DOM when called NON-silently -- but refreshAggregateDashboard() (what
//      Refresh Dashboard and every post-upload/post-research call actually
//      uses) always calls it with {silent:true}. Deleting the last uploaded
//      list correctly emptied the server, but the client left the previous
//      upload's accounts/signals/cards on screen until a full page reload.
//      Now the whole empty-state transition runs regardless of silent (only
//      the transient loading skeleton/banner stay silent-gated, via the
//      existing `banner = silent ? null : ...` assignment).
//   2. The upload-success modal's "Research N accounts" CTA called
//      researchTopAccounts()/getAccountsForResearch() -- a completely
//      different, older orchestration path than the trusted
//      researchListFromManageModal()-backed flow "Research All Accounts"
//      (Manage Customer Accounts) uses. Factored that trusted flow's
//      post-confirm body into runListResearch(listId, {onlyUnresearched}),
//      reused by BOTH handleListResearchClick() (after its confirm dialog)
//      and the new researchListAndFocus()/window.HouseAccountManager.
//      researchList(), which the modal's CTA now calls directly -- opening
//      Manage Customer Accounts, expanding straight to the just-uploaded
//      list, and starting the SAME research call, so progress/failure are
//      never silent or ambiguous.
//   3. accountHistoryStatusLine()'s reorder-window evidence text used
//      `${years[0]}-${years[years.length-1]} pattern`, producing literal
//      "2025-2025 pattern" for a single-year detected cadence (e.g. Golden
//      Valley's four same-year quarterly batches) and reading like a date
//      interval for a real 2-year span. reorderWindowEvidenceText() now
//      phrases 1-year evidence as "based on YYYY purchase cadence" and
//      multi-year evidence as "observed in Y1, Y2, and Y3" -- copy only, no
//      pattern-detection/eligibility/planningWindow/tab change.
//   4. collapseDuplicateGenericRepeatSignals() correctly treated a real
//      REPEAT PATTERN opportunity and a same-account generic
//      industry-fallback opportunity as two distinct opportunities (they
//      are), but never asked whether they were grounded in the SAME
//      purchase evidence -- a generic fallback sharing the real pattern's
//      buying-category bucket (primaryCategoryFromOpportunity()) is now
//      suppressed outright as seller-redundant, while a generic fallback in
//      a genuinely different category bucket is untouched.
//
// Usage: node scripts/test-live-qa-round6-corrections.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';
import { buildAccountsFromRows } from '../api/get-dashboard.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

// ===========================================================================
// Item 1: a silent aggregate refresh that confirms zero accounts must clear
// the previous aggregate state, exactly like a full page reload does --
// exercised against the REAL fetchAndRenderAggregateDashboard(), with only
// its genuinely out-of-scope internal renderers (renderCustomerDashboard's
// own HTML, refreshOpportunityViews' own feed-scoring internals) stubbed as
// spies -- the claim under test is fetchAndRenderAggregateDashboard()'s OWN
// control flow and its OWN direct global/DOM mutations.
// ===========================================================================
{
  // Live QA round 8: fetchAndRenderAggregateDashboard()'s empty-state
  // clearing was factored out into a shared applyEmptyWorkspaceState()
  // helper (also used by the team-view 404 catch branch) -- must be
  // extracted alongside it now.
  const SRC = [extractFn(DASHBOARD_SRC, 'renderEmptyWorkspaceState'), extractFn(DASHBOARD_SRC, 'applyEmptyWorkspaceState'), extractFn(DASHBOARD_SRC, 'fetchAndRenderAggregateDashboard')].join('\n\n');

  function makeEl(){ return { style:{display:''}, textContent:'', innerHTML:'', classList:{ _c:new Set(), add(...c){c.forEach(x=>this._c.add(x));}, remove(...c){c.forEach(x=>this._c.delete(x));}, contains(c){return this._c.has(c);} } }; }

  function buildScenario(){
    const els = {
      savedDashboardBanner: makeEl(),
      dashboardLoadingSkeleton: makeEl(),
      memberEmptyState: makeEl(),
      leadGate: makeEl(),
      exampleOpportunity: makeEl(),
      results: makeEl(),
      customerDashboard: makeEl(),
      emptyWorkspaceTitle: makeEl(),
      emptyWorkspaceBody: makeEl(),
      emptyWorkspaceSwitchTeam: makeEl()
    };
    els.results.style.display = 'block';
    els.customerDashboard.style.display = 'block';
    els.memberEmptyState.style.display = 'none';
    els.exampleOpportunity.style.display = 'none';
    els.emptyWorkspaceSwitchTeam.hidden = true;

    const calls = { refreshOpportunityViews: 0, renderCustomerDashboard: 0 };
    const houseAuth = { authHeadersAsync: async () => ({Authorization:'Bearer test'}) };
    const sandbox = {
      console,
      window: { accountRadarAccounts: [{name:'Stale Account'}], HouseAuth: houseAuth },
      // The real code reads the bare identifier HouseAuth (not window.HouseAuth)
      // in its ternary's true branch -- on the real page these resolve to the
      // same object because non-module top-level scripts attach every global
      // to window, but this minimal sandbox needs both bindings set explicitly.
      HouseAuth: houseAuth,
      document: { getElementById: id => els[id] || null },
      fetch: async () => ({ ok:true, json: async () => ({ personalEmpty:true }) }),
      currentDashboardData: null,
      dashboardCanViewTeam: false,
      dashboardViewMode: 'mine',
      defaultDashboardView: () => 'mine',
      renderDashboardViewSwitcher: () => {},
      showJoinedWelcomeIfNeeded: () => {},
      normalizeSavedAccount: a => a,
      currentUploadId: 'upload-still-set-from-before-deletion',
      currentUploadName: 'Deleted List.csv',
      currentLead: { email:'rep@example.com' },
      localStorage: { setItem(){}, getItem(){ return null; } },
      renderCustomerDashboard: () => { calls.renderCustomerDashboard++; },
      refreshOpportunityViews: () => { calls.refreshOpportunityViews++; },
      aggregateDashboardEverLoaded: true,
      freshUploadRenderedThisSession: false,
      escapeHtml: s => String(s || ''),
      canCurrentUserViewTeam: () => true
    };
    vm.createContext(sandbox);
    new vm.Script(`${SRC}\nthis.__exports = { fetchAndRenderAggregateDashboard };`, { filename: 'round6-empty-refresh.js' }).runInContext(sandbox);
    return { sandbox, els, calls };
  }

  // Required regression: populated workspace -> delete last upload ->
  // aggregate refresh (silent, exactly like refreshAggregateDashboard()
  // calls it) returns zero -> no stale account/signal/dashboard state
  // remains, no browser reload required.
  {
    const { sandbox, els, calls } = buildScenario();
    const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:true});
    assert(result.ok === true && result.empty === true, 'sanity: a silent refresh confirming personalEmpty resolves {ok:true, empty:true}');
    assert(Array.isArray(sandbox.window.accountRadarAccounts) && sandbox.window.accountRadarAccounts.length === 0, `REQUIRED: window.accountRadarAccounts is cleared to [] even on a SILENT refresh (got ${JSON.stringify(sandbox.window.accountRadarAccounts)})`);
    assert(sandbox.currentUploadId === null, 'REQUIRED: the stale currentUploadId from the deleted upload is cleared, not left pointing at a now-nonexistent list');
    assert(sandbox.currentUploadName === '', 'REQUIRED: the stale currentUploadName from the deleted upload is cleared');
    assert(els.customerDashboard.style.display === 'none', 'REQUIRED: the Your Accounts panel (#customerDashboard) is hidden -- it must not keep showing the old filename/account count');
    assert(els.results.style.display === 'none', 'REQUIRED: the priorities feed container (#results) is hidden on a confirmed-empty SILENT refresh, same as a full page reload');
    assert(els.memberEmptyState.style.display === 'block', 'REQUIRED: the existing clean empty-state UI (#memberEmptyState) is shown on a confirmed-empty SILENT refresh -- reusing it, not a new onboarding redesign');
    // Live QA round 9: the hardcoded "Sample Analysis / Acme Manufacturing"
    // example card is no longer shown for this signed-in path -- replaced
    // by renderEmptyWorkspaceState()'s modern empty-state copy inside
    // #memberEmptyState itself.
    assert(els.exampleOpportunity.style.display !== 'block', 'REQUIRED: the old Sample Analysis example card is NOT shown for a signed-in confirmed-empty workspace');
    assert(els.emptyWorkspaceTitle.textContent === 'No customer data yet', `REQUIRED: the empty-state title reads "No customer data yet" (got "${els.emptyWorkspaceTitle.textContent}")`);
    assert(/Upload a customer order history/.test(els.emptyWorkspaceBody.textContent), `REQUIRED: the empty-state body explains what happens after upload (got "${els.emptyWorkspaceBody.textContent}")`);
    assert(calls.refreshOpportunityViews === 1, 'REQUIRED: refreshOpportunityViews() (which clears the stat bar, priorities feed, detailed account views, and Recently Researched -- all four derived from window.accountRadarAccounts) is called even on a silent refresh, so none of them can keep showing stale content');
  }

  // Sanity: the pre-existing "a fresher upload already rendered client-side
  // this session" guard must still short-circuit BEFORE any of this new
  // unconditional clearing -- this fix must not regress that protection.
  {
    const { sandbox, els } = buildScenario();
    sandbox.freshUploadRenderedThisSession = true;
    sandbox.window.accountRadarAccounts = [{name:'Freshly Uploaded Account'}];
    const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:true});
    assert(result.skipped === true, 'sanity: a stale personalEmpty response is still recognized as stale (skipped) when a fresher upload already rendered client-side this session');
    assert(sandbox.window.accountRadarAccounts.length === 1, 'sanity: the freshly-rendered upload\'s accounts are NOT cleared by a stale personalEmpty response racing in behind it');
    assert(els.results.style.display !== 'none', 'sanity: the already-correct dashboard the user is looking at is left untouched by the stale response');
  }
}

// ===========================================================================
// Item 2: the upload-success modal's "Research N accounts" CTA must trigger
// the SAME trusted list-scoped research path as "Research All Accounts" in
// Manage Customer Accounts -- not a second orchestration route. Source-
// pattern assertions follow this codebase's own established convention for
// verifying document.createElement()-built dialogs and the Manage Customer
// Accounts IIFE's wiring (see scripts/test-followup-round.js's overlay-caller
// checks, scripts/test-research-control-orchestration.js's confirm-dialog
// checks) -- plus a real, extracted, behaviorally-exercised proof of
// runListResearch() (the shared function BOTH entry points now call) itself.
// ===========================================================================
{
  const showSuccessSrc = extractFn(DASHBOARD_SRC, 'showUploadSuccessModal');
  assert(!/researchTopAccounts\(\{auto:false\}\)/.test(showSuccessSrc), 'REQUIRED: the modal no longer calls researchTopAccounts() -- the second, untrusted research orchestration route the founder\'s QA caught is gone');
  assert(/window\.HouseAccountManager\.researchList\(uploadId\)/.test(showSuccessSrc), 'REQUIRED: the modal\'s Research CTA calls window.HouseAccountManager.researchList(uploadId), the same-process entry point into the trusted Manage Customer Accounts research flow');
  assert(/showUploadFailureModal\('Could not start research for this upload/.test(showSuccessSrc), 'REQUIRED: if window.HouseAccountManager.researchList is unexpectedly unavailable, a truthful failure modal is shown -- clicking Research never just silently closes with nothing happening');

  const managerExposeSrc = DASHBOARD_SRC.slice(DASHBOARD_SRC.indexOf('window.HouseAccountManager = {'), DASHBOARD_SRC.indexOf('window.HouseAccountManager = {') + 400);
  assert(/researchList\(uploadId\)\{ return researchListAndFocus\(uploadId\); \}/.test(managerExposeSrc), 'REQUIRED: window.HouseAccountManager.researchList is wired directly to researchListAndFocus(), no intermediate re-implementation');

  const focusSrc = extractFn(DASHBOARD_SRC, 'researchListAndFocus');
  assert(/^\s*open\(\);/m.test(focusSrc), 'REQUIRED: researchListAndFocus() opens Manage Customer Accounts (the existing progress UI becomes visible)');
  assert(/await load\(\);/.test(focusSrc), 'REQUIRED: researchListAndFocus() awaits a fresh list load before trying to expand the target list, so a just-uploaded list is guaranteed to already be in cachedLists');
  assert(/await expandUpload\(uploadId\);/.test(focusSrc), 'REQUIRED: researchListAndFocus() expands straight to the just-uploaded list -- founder QA specifically asked for this instead of a collapsed list the user has to find and click themselves');
  assert(/await runListResearch\(uploadId, \{onlyUnresearched:false\}\);/.test(focusSrc), 'REQUIRED: researchListAndFocus() runs the full-list research scope (matching "Research All Accounts", not "Research Unresearched Accounts")');

  const handleClickSrc = extractFn(DASHBOARD_SRC, 'handleListResearchClick');
  assert(/await runListResearch\(listId, \{onlyUnresearched\}\);/.test(handleClickSrc), 'REQUIRED: the trusted menu-item entry point (handleListResearchClick, after its confirm dialog) calls the exact SAME runListResearch() the modal CTA now calls -- proving both paths converge on one function, not two research engines');

  // Real behavioral proof of runListResearch() itself -- extracted verbatim,
  // its own out-of-scope dependencies (load(), refreshAggregateDashboard(),
  // openResearchedAccountOpportunities/highlightResultElement -- all
  // reachable only on paths this test doesn't exercise) stubbed, exactly as
  // round4's test stubbed genuinely-unreached dependencies.
  const runSrc = extractFn(DASHBOARD_SRC, 'runListResearch');

  function makeStatusEl(){ return { hidden:true, classList:{ _c:new Set(), add(c){this._c.add(c);}, remove(c){this._c.delete(c);}, contains(c){return this._c.has(c);} }, _text:'', get textContent(){return this._text;}, set textContent(v){this._text=String(v);}, innerHTML:'', append(node){ this._text += node.text || ''; }, appendChild(){} };}

  function buildRunListResearchSandbox({researchResult, researchThrows}){
    const statusEl = makeStatusEl();
    const loadCalls = [];
    const sandbox = {
      console,
      CSS: { escape: s => s },
      document: { querySelector: () => statusEl, createTextNode: t => ({text:t}) },
      load: async () => { loadCalls.push(true); },
      researchListFromManageModal: async () => {
        if(researchThrows) throw new Error(researchThrows);
        return researchResult;
      },
      refreshAggregateDashboard: async () => ({ok:true}),
      openResearchedAccountOpportunities: () => {},
      highlightResultElement: () => {}
    };
    vm.createContext(sandbox);
    new vm.Script(`${runSrc}\nthis.__exports = { runListResearch };`, { filename: 'round6-runlistresearch.js' }).runInContext(sandbox);
    return { sandbox, statusEl, loadCalls };
  }

  {
    const { sandbox, statusEl } = buildRunListResearchSandbox({ researchResult: { ok:true, attempted:8, withSignals:3, totalSignals:5, failures:0, skippedDuplicates:[], unattempted:0, accountsWithOpportunities:[] } });
    await sandbox.__exports.runListResearch('upload-fresh', {onlyUnresearched:false});
    assert(statusEl.hidden === false && statusEl.classList.contains('is-success'), 'REQUIRED: a successful run (via the exact trusted researchListFromManageModal() call) reports success on the list\'s own status line');
    assert(/8 accounts attempted/.test(statusEl.textContent), `REQUIRED: the success status line reports the real attempted count (got "${statusEl.textContent}")`);
  }
  {
    const { sandbox, statusEl } = buildRunListResearchSandbox({ researchThrows: 'Another research run is currently active for this uploaded list.' });
    await sandbox.__exports.runListResearch('upload-fresh', {onlyUnresearched:false});
    assert(statusEl.hidden === false && statusEl.classList.contains('is-error'), 'REQUIRED: if research fails to start (e.g. a claim conflict), a truthful failure state is surfaced on the list\'s status line -- never a silent close with nothing shown');
    assert(/Another research run is currently active/.test(statusEl.textContent), `REQUIRED: the failure message is the real, specific error, not a generic fallback (got "${statusEl.textContent}")`);
  }
}

// ===========================================================================
// Item 3: reorder-status wording -- copy only. No "N-N pattern" gibberish
// for a single-year detected cadence; natural "observed in ..." phrasing
// for genuine multi-year spans.
// ===========================================================================
{
  const SRC = [
    extractRange(DASHBOARD_SRC, 'function reorderWindowStatus(opp){', 'function accountHistoryStatusLine(opp){'),
    extractFn(DASHBOARD_SRC, 'accountHistoryStatusLine'),
    extractFn(DASHBOARD_SRC, 'signalLayerLabel'),
    extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
    extractFn(DASHBOARD_SRC, 'isWebResearchSignal'),
    extractFn(DASHBOARD_SRC, 'formatShortDate'),
    extractFn(DASHBOARD_SRC, 'parseMaybeDate'),
    extractFn(DASHBOARD_SRC, 'monthDistanceFromNow'),
    extractFn(DASHBOARD_SRC, 'inferPurchaseMonth'),
    extractFn(DASHBOARD_SRC, 'monthIndexFromName')
  ].join('\n\n');
  const EXPORT_NAMES = ['reorderWindowEvidenceText', 'accountHistoryStatusLine', 'reorderWindowStatus'];
  const sandbox = { window:{}, console };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'round6-copy.js' }).runInContext(sandbox);
  const dash = sandbox.__exports;

  assert(dash.reorderWindowEvidenceText('January', [2025]) === 'January · based on 2025 purchase cadence', `REQUIRED: a single-year pattern (e.g. Golden Valley's same-year quarterly batches) never renders as a year range (got "${dash.reorderWindowEvidenceText('January', [2025])}")`);
  assert(!/2025.–20\d\d pattern/.test(dash.reorderWindowEvidenceText('January', [2025])), 'REQUIRED: the exact founder-flagged "2025–2025 pattern" gibberish never appears');
  assert(dash.reorderWindowEvidenceText('November', [2023, 2024]) === 'November · observed in 2023 and 2024', `REQUIRED: a genuine 2-year span reads as "observed in Y1 and Y2" (got "${dash.reorderWindowEvidenceText('November', [2023, 2024])}")`);
  assert(dash.reorderWindowEvidenceText('August', [2023, 2024, 2025]) === 'August · observed in 2023, 2024, and 2025', `REQUIRED: a genuine 3-year span reads as "observed in Y1, Y2, and Y3" (got "${dash.reorderWindowEvidenceText('August', [2023, 2024, 2025])}")`);
  assert(dash.reorderWindowEvidenceText('', [2023, 2024]) === '', 'sanity: no month label means no evidence text at all');
  assert(dash.reorderWindowEvidenceText('August', []) === 'August', 'sanity: no years means the bare month label, never a broken join');

  // Through the real accountHistoryStatusLine() render function directly.
  const oneYearOpp = { opportunityType:'REPEAT PATTERN', signalLayerType:'Repeat / Pattern Signal', purchaseMonthLabel:'January', years:[2025], signalDate: new Date(Date.now() - 30*86400000).toISOString(), purchaseMonth: new Date().getMonth() };
  const line = dash.accountHistoryStatusLine(oneYearOpp);
  assert(!/\d{4}.–\d{4} pattern/.test(line), `REQUIRED: the real accountHistoryStatusLine() output for a single-year pattern never contains a year-range parenthetical (got "${line}")`);
  assert(/based on 2025 purchase cadence/.test(line), `REQUIRED: the real render output uses the natural single-year phrasing (got "${line}")`);
}

// ===========================================================================
// Item 4: dominance rule -- a real REPEAT PATTERN opportunity suppresses a
// same-category generic fallback derived from the same evidence, but never
// a genuinely different-category one.
// ===========================================================================
{
  const SRC = [
    extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG'),
    extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(value){', 'function isRelationshipExpansionOpportunity(opp){'),
    extractFn(DASHBOARD_SRC, 'isWebResearchSignal'),
    extractRange(DASHBOARD_SRC, 'function signalLayerLabel(opp){', 'function isRecentAccountActivity(opp){'),
    extractFn(DASHBOARD_SRC, 'isLikelyInvalidAccountName'),
    extractFn(DASHBOARD_SRC, 'parseMaybeDate'),
    extractFn(DASHBOARD_SRC, 'parseCSV'),
    extractFn(DASHBOARD_SRC, 'inferPromoCategory'),
    extractFn(DASHBOARD_SRC, 'inferIndustry'),
    extractFn(DASHBOARD_SRC, 'formatShortDate'),
    extractRange(DASHBOARD_SRC, 'function isAccountHistoryOpportunity(opp){', 'function accountHistoryStatusLine(opp){'),
    extractRange(DASHBOARD_SRC, 'function estimateFutureValue(account, opportunityType){', 'function getPriorityTier(opp){'),
    extractRange(DASHBOARD_SRC, 'function isClosedHistoricalRecord(record){', 'function sumRevenue(records){'),
    extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
    extractRange(DASHBOARD_SRC, 'function daysSinceDate(value){', 'function getRecommendationType(opp){'),
    extractFn(DASHBOARD_SRC, 'getRecommendationType'),
    extractRange(DASHBOARD_SRC, 'function calculateOpportunityScore(opp){', 'function assignOpportunityScore(opp, account){'),
    extractRange(DASHBOARD_SRC, 'function monthIndexFromName(name){', 'function opportunityMatchesTimebox(opp, timebox){'),
    extractFn(DASHBOARD_SRC, 'hasMeaningfulHistoricalOrder'),
    extractFn(DASHBOARD_SRC, 'deriveAccountIntelligenceMode'),
    extractFn(DASHBOARD_SRC, 'getRelationshipStrength'),
    extractFn(DASHBOARD_SRC, 'getRelationshipMode'),
    extractFn(DASHBOARD_SRC, 'generateSimulatedSignals'),
    extractFn(DASHBOARD_SRC, 'importedContactsFromRecords'),
    extractFn(DASHBOARD_SRC, 'serializeAccountForStorage'),
    extractFn(DASHBOARD_SRC, 'normalizeSavedAccount'),
    extractFn(DASHBOARD_SRC, 'dedupeOpportunities'),
    extractFn(DASHBOARD_SRC, 'dedupeFoundSignals'),
    extractFn(DASHBOARD_SRC, 'getOpportunityScore'),
    extractFn(DASHBOARD_SRC, 'buyingOpportunityIdentity'),
    extractFn(DASHBOARD_SRC, 'opportunityDedupeKey'),
    extractFn(DASHBOARD_SRC, 'opportunitiesLikelySameInitiative'),
    extractFn(DASHBOARD_SRC, 'sameOpportunity'),
    extractFn(DASHBOARD_SRC, 'collapseDuplicateAccountHistorySignals'),
    extractFn(DASHBOARD_SRC, 'followUpCollapseKey'),
    extractRange(DASHBOARD_SRC, 'function collapseDuplicateFollowUps(opps){', 'function collapseDuplicateAccountHistorySignals(opps){'),
    extractRange(DASHBOARD_SRC, 'function isPriorityEligibleOpportunity(opp){', 'function priorityEligibleOpportunities(opps){'),
    extractFn(DASHBOARD_SRC, 'sortDailyReasons'),
    extractFn(DASHBOARD_SRC, 'getDailyReasonScore'),
    extractFn(DASHBOARD_SRC, 'hasConfirmedOrLegacyIdentity'),
    extractFn(DASHBOARD_SRC, 'hasCredibleActivationPlay'),
    extractFn(DASHBOARD_SRC, 'signalDateAndActionabilityLine'),
    extractFn(DASHBOARD_SRC, 'pluralize'),
    extractFn(DASHBOARD_SRC, 'feedSummary'),
    extractFn(DASHBOARD_SRC, 'realPriorCategories'),
    extractFn(DASHBOARD_SRC, 'findAccountForOpp'),
    extractFn(DASHBOARD_SRC, 'mergeBusinessSignalInitiatives'),
    extractFn(DASHBOARD_SRC, 'clusterBusinessSignalOpportunities'),
    extractFn(DASHBOARD_SRC, 'accountOpportunityCluster'),
    extractFn(DASHBOARD_SRC, 'additionalOpportunitiesFor'),
    extractFn(DASHBOARD_SRC, 'renderAccountContextSection'),
    extractFn(DASHBOARD_SRC, 'accountContextFallbackMessage'),
    extractFn(DASHBOARD_SRC, 'escapeHtml'),
    extractFn(DASHBOARD_SRC, 'fmtMoney'),
    extractFn(DASHBOARD_SRC, 'shortText'),
    extractFn(DASHBOARD_SRC, 'opportunityHeadline'),
    extractFn(DASHBOARD_SRC, 'businessSignalKind'),
    extractFn(DASHBOARD_SRC, 'CANONICAL_KIND_BY_EVENT_TYPE'),
    extractFn(DASHBOARD_SRC, 'canonicalSignalKind')
  ].join('\n\n');

  const EXPORT_NAMES = [
    'parseCSV', 'inferIndustry', 'isClosedHistoricalRecord', 'isActivePipelineRecord', 'hasOrderHistoryEvidence', 'sumRevenue',
    'findRepeatPatternGroups', 'createRepeatPatternOpportunities', 'generateFutureOpportunities', 'createOpportunity',
    'deriveAccountIntelligenceMode', 'getRelationshipStrength', 'getRelationshipMode', 'generateSimulatedSignals',
    'importedContactsFromRecords', 'serializeAccountForStorage', 'normalizeSavedAccount', 'getRecommendationType',
    'primaryCategoryFromOpportunity', 'collapseDuplicateGenericRepeatSignals', 'collapseDuplicateAccountHistorySignals',
    'accountOpportunityCluster', 'additionalOpportunitiesFor', 'opportunityHeadline', 'getDailyReasonScore'
  ];
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'round6-dominance.js' }).runInContext(sandbox);
  const dash = sandbox.__exports;
  for(const name of EXPORT_NAMES){
    assert(typeof dash[name] === 'function', `dashboard/index.html export "${name}" extracted successfully as a real function`);
  }

  // Unit-level proof: a same-category generic is suppressed; a
  // different-category one survives -- isolated from any account-name/title
  // branching, driven purely by primaryCategoryFromOpportunity() buckets.
  {
    const realPattern = { account:'Acme Co', opportunityType:'REPEAT PATTERN', opportunity:'Headwear Program', signalLayerType:'Repeat / Pattern Signal', buyingCategory:'Apparel / Headwear' };
    const sameCategoryGeneric = { account:'Acme Co', opportunityType:'REACTIVATION', opportunity:'Service Department Apparel Program', signalLayerType:'Repeat / Pattern Signal', buyingCategory:'Apparel / Headwear' };
    const differentCategoryGeneric = { account:'Acme Co', opportunityType:'REACTIVATION', opportunity:'Customer Appreciation Program', signalLayerType:'Repeat / Pattern Signal', buyingCategory:'Events / Giveaways' };
    const result = dash.collapseDuplicateGenericRepeatSignals([realPattern, sameCategoryGeneric, differentCategoryGeneric]);
    assert(result.includes(realPattern), 'sanity: the real REPEAT PATTERN opportunity always survives');
    assert(!result.includes(sameCategoryGeneric), 'REQUIRED: a generic fallback sharing the real pattern\'s buying-category bucket is suppressed outright (dominated), not merely deduped against other generics');
    assert(result.includes(differentCategoryGeneric), 'REQUIRED: a generic fallback in a genuinely DIFFERENT category bucket is never suppressed -- it is a distinct reason to reach out, not seller-redundant');
  }

  // Full real pipeline: Ridgeline (a real multi-year Headwear pattern, plus
  // several industry-template generic opportunities, one of which shares
  // the Apparel/Headwear bucket) through the actual save/reload round trip
  // and the REAL additionalOpportunitiesFor() the PFC panel calls.
  {
    const csvText = readFileSync(new URL('./fixtures/repeat-order-follow-up-fixture.csv', import.meta.url), 'utf8');
    const records = dash.parseCSV(csvText);
    const clients = {};
    records.forEach(record => { (clients[record.client] = clients[record.client] || []).push(record); });
    const accounts = [];
    for(const clientName in clients){
      const allOrders = clients[clientName];
      const closedOrders = allOrders.filter(dash.isClosedHistoricalRecord);
      const scoringOrders = closedOrders.filter(dash.hasOrderHistoryEvidence);
      const mostRecentDate = scoringOrders.filter(o => o.date).sort((a, b) => b.date - a.date)[0]?.date;
      const daysSinceLast = mostRecentDate ? Math.floor((new Date() - mostRecentDate) / (1000 * 60 * 60 * 24)) : 999;
      const account = {
        name: clientName, industry: dash.inferIndustry(clientName, []), revenue: dash.sumRevenue(scoringOrders),
        activePipelineValue: 0, orderCount: scoringOrders.length, activePipelineCount: 0, confidence: 50,
        subscores: { revenue: 0.5, frequency: Math.min(scoringOrders.length / 10, 1), recency: Math.max(1 - daysSinceLast / 365, 0), diversity: 0.25 },
        categoryTypes: new Set(scoringOrders.map(o => o.category)),
        contactName: '', contactEmail: '', contacts: [],
        intelligenceMode: dash.deriveAccountIntelligenceMode(allOrders),
        purchases: scoringOrders, activePipeline: [], allRecords: allOrders,
        mostRecentDate: mostRecentDate ? mostRecentDate.toISOString().slice(0, 10) : 'Unknown'
      };
      account.relationshipStrength = dash.getRelationshipStrength(account);
      account.relationshipMode = dash.getRelationshipMode(account);
      account.signals = dash.generateSimulatedSignals(account, {});
      account.futureOpportunities = account.orderCount > 0 ? dash.generateFutureOpportunities(account) : [];
      accounts.push(account);
    }

    const UPLOAD_ID = 'upload-round6-dominance';
    accounts.forEach(a => {
      a.uploadId = a.uploadId || UPLOAD_ID;
      (a.futureOpportunities || []).forEach(opp => { opp.uploadId = opp.uploadId || UPLOAD_ID; });
    });
    const rows = accounts.map((a, i) => ({
      id: `round6-${i}`, account_name: a.name, upload_id: UPLOAD_ID, industry: a.industry,
      contact_name: a.contactName, contact_email: a.contactEmail,
      metrics: dash.serializeAccountForStorage(a, {includeSignals:false}).metrics,
      raw_data: dash.serializeAccountForStorage(a, {includeSignals:false}).rawData,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }));
    const serverAccounts = buildAccountsFromRows(rows, []).accountList;
    const reloadedAccounts = serverAccounts.map(dash.normalizeSavedAccount);
    sandbox.window.accountRadarAccounts = reloadedAccounts;

    const ridgeline = reloadedAccounts.find(a => a.name === 'Ridgeline Auto Group');
    const primary = ridgeline.futureOpportunities.find(o => o.opportunityType === 'REPEAT PATTERN');
    assert(!!primary, 'sanity: Ridgeline\'s real REPEAT PATTERN opportunity survives the full save/reload round trip');
    const primaryCategory = dash.primaryCategoryFromOpportunity(primary);

    const additional = dash.additionalOpportunitiesFor(primary);
    const sellerRedundantSurvivor = additional.find(o => dash.primaryCategoryFromOpportunity(o) === primaryCategory);
    assert(!sellerRedundantSurvivor, `REQUIRED (real PFC render path): no Additional Opportunity for Ridgeline shares the primary Repeat/Pattern opportunity's own buying-category bucket ("${primaryCategory}") -- got categories: ${JSON.stringify(additional.map(o => dash.primaryCategoryFromOpportunity(o)))}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
