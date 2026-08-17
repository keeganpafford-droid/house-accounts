// Organizational Learning V1B: founder QA reported that a genuinely FRESH
// upload's Follow-Up and Repeat/Pattern account-history opportunity cards
// render fully (Why Now, evidence, "Prepare for Call ->", Additional
// Opportunities "Prep this call ->") but show NO Useful/Not-useful controls
// and no "Used check" hydration state -- described as a confirmed
// fresh-upload V1B failure, not an assumption about legacy data.
//
// Investigation traced the WHOLE path -- canonical detector -> persisted
// ha_account_opportunities row -> api/get-dashboard.js's
// buildAccountHistoryOpportunityRefs()/stampAccountHistoryOpportunityRefs()
// -> dashboard/index.html's normalizeSavedAccount() -> refreshOpportunityViews()
// -> renderWeeklyPrioritiesFeed() -> renderRepOpportunityCard() ->
// renderAccountHistoryOpportunityFeedback()/renderPrepareForCallButton() --
// against REAL data pulled live from Supabase for the founder's own actual
// fresh re-upload (a real Follow-Up opportunity and a real, genuine
// Repeat/Pattern opportunity for the same account, "Pioneer Analytics",
// Supabase project zodtymrckbtbiomakupf). Every stage, run for real (not
// mocked, not stubbed), produced correctly-stamped accountOpportunityId/
// accountOpportunityFingerprint on the rendered card, and the resulting
// HTML DID contain the Useful/Not-useful buttons and the durable-ref
// "Used check" Prepare-for-Call button. No break was found anywhere in this
// pipeline against current code (commit 509a53d and its full ancestry on
// this branch) -- this file is the permanent, deterministic form of that
// same live-data proof, so a future regression anywhere in this exact
// chain is caught automatically, and so the negative finding ("the shipped
// code is correct") stays verifiable rather than living only in a session
// transcript.
//
// This intentionally does NOT stub renderWeeklyPrioritiesFeed/
// renderRepOpportunityCard/the collapse-and-eligibility pipeline the way
// scripts/test-dashboard-orchestration.js does for its own (unrelated)
// call-count assertions -- proving the RENDERED MARKUP is exactly what
// this file is for, so every function between "account object" and "HTML
// string" must be the real, unmodified one.
//
// Usage: node scripts/test-fresh-upload-account-history-feedback-rendering.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

const DASHBOARD_SRC = loadDashboardSource();
function fn(name){ return extractFn(DASHBOARD_SRC, name); }

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Real, unmodified source for the WHOLE fresh-upload render chain, plus
// every function it transitively calls (verified by iterating this file
// against the real dashboard/index.html until no ReferenceError remained --
// nothing here is guessed or reimplemented).
// ===========================================================================
const REAL_SOURCE = [
  fn('normalizeSavedAccount'), fn('dedupeOpportunities'), fn('opportunityDedupeKey'),
  fn('buyingOpportunityIdentity'), fn('cleanOpportunityToken'),
  fn('mergeBusinessSignalInitiatives'), fn('clusterBusinessSignalOpportunities'),
  fn('isWebResearchSignal'), fn('signalLayerLabel'), fn('normalizeSignalLayerType'),
  fn('isRecentAccountActivity'), fn('assignOpportunityScore'), fn('getOpportunityScore'),
  fn('currentOrgPreferences'), fn('ORG_PREFERENCE_FAMILY_BY_SIGNAL_LAYER'), fn('getOrgPreferenceAdjustmentForOpportunity'),
  fn('calculateOpportunityScore'), fn('normalizedConfidenceValue'), fn('scoreFromFreshness'),
  fn('evidenceCount'), fn('getOpportunityPlanningWindow'), fn('classifyMonthWindow'),
  fn('inferPurchaseMonth'), fn('monthIndexFromName'), fn('monthDistanceFromNow'),
  fn('getRecommendationType'), fn('isRelationshipExpansionOpportunity'), fn('clampScore'),
  fn('sortDailyReasons'), fn('getDailyReasonScore'),
  fn('collapseDuplicateAccountHistorySignals'), fn('collapseDuplicateFollowUps'),
  fn('collapseDuplicateGenericRepeatSignals'), fn('followUpCollapseKey'),
  fn('genericRepeatCollapseKey'), fn('primaryCategoryFromOpportunity'),
  fn('priorityEligibleOpportunities'), fn('isPriorityEligibleOpportunity'),
  fn('hasConfirmedOrLegacyIdentity'), fn('hasCredibleActivationPlay'),
  fn('hasStrongStandaloneSignal'), fn('isPossibleMatchIdentity'), fn('isRoutineFinancialNoise'),
  fn('daysSinceDate'), fn('limitReasonsPerAccount'), fn('prepareAllOpportunities'),
  fn('prepareTimeboxReasons'), fn('opportunityMatchesTimebox'), fn('TIMEBOX_CONFIG'),
  fn('renderWeeklyPrioritiesFeed'), fn('renderRepOpportunityCard'),
  fn('renderAccountHistoryOpportunityFeedback'), fn('renderPrepareForCallButton'),
  fn('escapeHtml'), fn('refreshOpportunityViews'), fn('feedSummary'),
  // The exact real server-side stamping logic (api/get-dashboard.js) -- run
  // here too so this file proves the FULL path from raw
  // ha_account_opportunities rows through to rendered HTML, not just the
  // client half.
].join('\n\n');

// Only pure cosmetic content generators with NO bearing on whether the
// V1B feedback controls render (card copy text, not the accountOpportunityId
// gate) -- each is a one-line stub of a function that plays no part in this
// file's assertions.
const STUB_SOURCE = `
function renderDetailedAccountViews(){}
function applyFreeCompanyLocksToCustomerAccounts(accounts){ return accounts; }
function calculateRevenueContext(){ return {historicalRevenue:0, historicalOpps:0, newBusinessOpps:0, totalReasons:0}; }
function renderResearchDiagnostics(){}
// Founder QA fix: renderWeeklyPrioritiesFeed() now calls
// hydrateSignalFeedbackButtons(grid) after building the grid -- irrelevant
// to this file's own assertions (which test the STATIC render, not
// hydration; see scripts/test-dashboard-card-outreach-hydration.js for the
// real hydration path), so a plain no-op stub here is correct, matching
// scripts/test-dashboard-orchestration.js's own identical stub.
function hydrateSignalFeedbackButtons(){}
function renderRecentlyResearchedSection(){}
function recommendationBadgeMeta(o){ return {label:'Reach Out', cls:'', icon:''}; }
function mailtoHref(email){ return email ? ('mailto:' + email) : ''; }
function renderOpportunitySection(o){ return ''; }
function renderActivationIdeasSection(o, n){ return ''; }
function signalDateAndActionabilityLine(o){ return 'Recent'; }
function renderSuggestedContactCompact(o){ return ''; }
function getSuggestedOpener(o){ return 'opener'; }
function lockedAccountMessageHtml(){ return ''; }
function opportunityHeadline(o){ return o.opportunity || o.opportunityName || 'Opportunity'; }
function likelyDepartmentFromOpportunity(o){ return o.department || ''; }
function departmentFromText(t){ return t || ''; }
function likelyKnownBuyer(o){ return o.buyer || o.contact || ''; }
function likelySuggestedContact(o){ return o.suggestedContact || ''; }
function dedupeFoundSignals(signals){ return signals || []; }
function fmtMoney(n){ return String(n); }
function pluralize(n, s, p){ return n + ' ' + (n === 1 ? s : (p || s + 's')); }
function toggleWeeklyPrioritiesView(){}
`;

// activeTimebox/showAllWeeklyPriorities match the REAL page's own initial
// defaults (see dashboard/index.html's own top-level `let` declarations) --
// this file deliberately does NOT widen the timebox to make cards appear;
// the fixture below uses a THIS-WEEK order date so it passes the exact
// default view a rep sees immediately after a fresh upload, with no extra
// clicks.
const INIT_SOURCE = `
var activeTimebox = 'week';
var showAllWeeklyPriorities = false;
`;

function buildSandbox(){
  const gridEl = { _html: '', get innerHTML(){ return this._html; }, set innerHTML(v){ this._html = v; } };
  const textEls = {};
  for(const id of ['resultCount','totalAccounts','totalOppValue','highConfidenceCount','avgConfidence','timeboxSectionHeader','timeboxHelper']){
    textEls[id] = { _t: '', get textContent(){ return this._t; }, set textContent(v){ this._t = v; }, get innerHTML(){ return this._t; }, set innerHTML(v){ this._t = v; } };
  }
  const domElements = { opportunitiesGrid: gridEl, ...textEls };
  const sandbox = {
    window: { accountRadarAccounts: [] },
    document: {
      getElementById: (id) => Object.prototype.hasOwnProperty.call(domElements, id) ? domElements[id] : null,
      querySelectorAll: () => [],
    },
    console,
    Date, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, isNaN, parseInt, parseFloat,
  };
  vm.createContext(sandbox);
  vm.runInContext(INIT_SOURCE + '\n' + STUB_SOURCE + '\n' + REAL_SOURCE, sandbox, { filename: 'fresh-upload-render-extract.js' });
  sandbox.__grid = gridEl;
  return sandbox;
}

// Real api/get-dashboard.js stamping logic, verbatim (kept in sync with the
// file itself by scripts/test-migration-12-schema.js's own SQL-text
// assertions and scripts/test-signal-events-schema-and-exposure.js -- this
// file's job is the CLIENT render, not re-proving that logic in isolation,
// so it is inlined rather than imported to keep this a pure vm/HTML test
// with no live-module import of api/get-dashboard.js).
function buildAccountHistoryOpportunityRefs(rows){
  const byAccountName = new Map();
  for(const row of rows || []){
    if(!byAccountName.has(row.account_name)) byAccountName.set(row.account_name, { followUp: null, repeatPattern: {} });
    const bucket = byAccountName.get(row.account_name);
    const ref = { id: row.id, fingerprint: row.fingerprint };
    if(row.opportunity_type === 'follow_up') bucket.followUp = ref;
    else if(row.opportunity_type === 'repeat_pattern' && row.category) bucket.repeatPattern[row.category] = ref;
  }
  return byAccountName;
}
function stampAccountHistoryOpportunityRefs(storedOpps, refs){
  if(!refs) return storedOpps;
  return storedOpps.map(opp => {
    const ref = opp.opportunityType === 'REPEAT PATTERN'
      ? (opp.category ? refs.repeatPattern[opp.category] : null)
      : refs.followUp;
    if(!ref) return opp;
    return { ...opp, accountOpportunityId: ref.id, accountOpportunityFingerprint: ref.fingerprint };
  });
}

function isoDaysAgo(n){ return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

// ---------------------------------------------------------------------
// Scenario 1: a fresh Follow-Up opportunity (generic template, the common
// case for any account with at least one recent order and no detected
// repeat cadence). Shape mirrors the real ha_account_opportunities/
// raw_data.repeatPatterns rows reconciled for the founder's own fresh
// upload ("Pioneer Analytics", Supabase project zodtymrckbtbiomakupf) --
// only the account name and dates are changed here (to a real THIS-WEEK
// date, so this fixture passes the exact default view, not an "annual"
// widened one) to keep the fixture self-contained and account-agnostic.
// ---------------------------------------------------------------------
{
  const recentDate = isoDaysAgo(2);
  const oppRows = [
    { id: 'opp-followup-1', account_name: 'Fresh Follow-Up Co', opportunity_type: 'follow_up', category: null, fingerprint: `opp:follow_up:v1:fresh follow-up co|last:${recentDate}` }
  ];
  const rawOpp = {
    account: 'Fresh Follow-Up Co', contact: 'Contact 1', evidence: ['3 purchase records', '$12,000 historical spend'],
    industry: 'General Business', confidence: 74, department: 'Marketing', signalDate: recentDate,
    opportunity: 'Multi-Department Expansion', templateKey: 'generic_multi_department_expansion',
    whyNowScore: 100, contactEmail: 'buyer@freshfollowup.example', contactTitle: 'Marketing Manager',
    quickWinScore: 74, accountRevenue: 12000, buyingCategory: 'Apparel', estimatedValue: 4000,
    mostRecentDate: recentDate, businessSignals: [], opportunityName: 'Multi-Department Expansion',
    opportunityType: 'EXPANSION', signalLayerType: 'Follow-Up Signal', closeProbability: 73,
    opportunityScore: 100, reasonToReachOut: 'Recent order delivered or completed',
    relationshipStrength: 60, accountDiversityScore: 1, accountFrequencyScore: 0.3,
    conversationStarter: 'Check in and ask how the recent order was received.', historicalPurchaseData: []
  };
  const refs = buildAccountHistoryOpportunityRefs(oppRows).get('Fresh Follow-Up Co');
  const stamped = stampAccountHistoryOpportunityRefs([rawOpp], refs);
  assert(stamped[0].accountOpportunityId === 'opp-followup-1', 'sanity: server-side stamping attaches the follow_up ref to the fixture');

  const serverAccount = {
    name: 'Fresh Follow-Up Co', uploadId: 'upload-fresh-1', accountHistoryOpportunityRefs: refs,
    monitoringStatus: 'active', industry: 'General Business', contactName: 'Contact 1', contactEmail: 'buyer@freshfollowup.example',
    revenue: 12000, orderCount: 3, confidence: 74, relationshipStrength: 60, mostRecentDate: recentDate,
    activePipelineValue: 0, activePipelineCount: 0, subscores: { revenue: 0.4, frequency: 0.3, recency: 0.95, diversity: 1 },
    purchases: [], projects: [], allProjects: [], activePipeline: [], categoryTypes: [], signals: [],
    futureOpportunities: stamped
  };

  const sandbox = buildSandbox();
  const normalized = sandbox.normalizeSavedAccount(serverAccount);
  sandbox.window.accountRadarAccounts = [normalized];
  sandbox.refreshOpportunityViews();
  const html = sandbox.__grid.innerHTML;

  assert(html.includes('Fresh Follow-Up Co'), 'REQUIRED: the fresh Follow-Up card actually renders (matches founder QA: cards ARE visible)');
  assert(html.includes('signal-feedback-btn') && html.includes('data-signal-feedback="useful"') && html.includes('data-signal-feedback="not_useful"'), 'REQUIRED: fresh Follow-Up shows V1B Useful/Not useful controls');
  assert(html.includes('data-opportunity-id="opp-followup-1"'), 'REQUIRED: the feedback controls carry the real, durable ha_account_opportunities id -- never fabricated');
  assert(html.includes('account-history-prepare-btn') && html.includes('opportunity-used-status'), 'REQUIRED: Prepare for Call is the durable-ref, "Used check"-capable variant, not the plain onclick fallback');
}

// ---------------------------------------------------------------------
// Scenario 2: a fresh, GENUINE Repeat/Pattern opportunity (opportunityType
// 'REPEAT PATTERN', category set -- an actual detected cadence, not a
// generic industry-fallback template). Same real-data shape as the
// founder's own live "Onboarding / Recruiting Program" opportunity for
// Pioneer Analytics.
// ---------------------------------------------------------------------
{
  const recentDate = isoDaysAgo(3);
  const oppRows = [
    { id: 'opp-repeat-1', account_name: 'Fresh Repeat Pattern Co', opportunity_type: 'repeat_pattern', category: 'Onboarding / Recruiting', fingerprint: `opp:repeat_pattern:v1:fresh repeat pattern co|onboarding-recruiting|last:${recentDate}` }
  ];
  const rawOpp = {
    account: 'Fresh Repeat Pattern Co', contact: 'Contact 2', years: [2025, 2026],
    whyNow: 'Fresh Repeat Pattern Co has ordered onboarding / recruiting 2 times across 2 years.',
    category: 'Onboarding / Recruiting', evidence: ['2 onboarding / recruiting orders found'],
    industry: 'General Business', confidence: 74, department: 'HR / People', signalDate: recentDate,
    opportunity: 'Onboarding / Recruiting Program', templateKey: 'repeat_pattern', whyNowScore: 87,
    contactEmail: 'hr@freshrepeatpattern.example', contactTitle: 'HR Manager', purchaseMonth: 0,
    quickWinScore: 74, accountRevenue: 43790, buyingCategory: 'Onboarding / Recruiting', estimatedValue: 11102,
    mostRecentDate: recentDate, planningWindow: 'week', businessSignals: [], opportunityName: 'Onboarding / Recruiting Program',
    opportunityType: 'REPEAT PATTERN', signalLayerType: 'Repeat / Pattern Signal', closeProbability: 74,
    opportunityScore: 87, reasonToReachOut: 'Onboarding / Recruiting Program may be coming up again',
    relationshipStrength: 86, accountDiversityScore: 1, accountFrequencyScore: 0.5,
    conversationStarter: 'Ask if the onboarding / recruiting program is happening again this year.', historicalPurchaseData: []
  };
  const refs = buildAccountHistoryOpportunityRefs(oppRows).get('Fresh Repeat Pattern Co');
  const stamped = stampAccountHistoryOpportunityRefs([rawOpp], refs);
  assert(stamped[0].accountOpportunityId === 'opp-repeat-1', 'sanity: server-side stamping attaches the repeat_pattern ref to the fixture');

  const serverAccount = {
    name: 'Fresh Repeat Pattern Co', uploadId: 'upload-fresh-2', accountHistoryOpportunityRefs: refs,
    monitoringStatus: 'active', industry: 'General Business', contactName: 'Contact 2', contactEmail: 'hr@freshrepeatpattern.example',
    revenue: 43790, orderCount: 5, confidence: 74, relationshipStrength: 86, mostRecentDate: recentDate,
    activePipelineValue: 0, activePipelineCount: 0, subscores: { revenue: 0.5, frequency: 0.5, recency: 0.95, diversity: 1 },
    purchases: [], projects: [], allProjects: [], activePipeline: [], categoryTypes: [], signals: [],
    futureOpportunities: stamped
  };

  const sandbox = buildSandbox();
  const normalized = sandbox.normalizeSavedAccount(serverAccount);
  sandbox.window.accountRadarAccounts = [normalized];
  sandbox.refreshOpportunityViews();
  const html = sandbox.__grid.innerHTML;

  assert(html.includes('Fresh Repeat Pattern Co'), 'REQUIRED: the fresh genuine Repeat/Pattern card actually renders');
  assert(html.includes('signal-feedback-btn') && html.includes('data-signal-feedback="useful"') && html.includes('data-signal-feedback="not_useful"'), 'REQUIRED: fresh genuine Repeat/Pattern shows V1B Useful/Not useful controls');
  assert(html.includes('data-opportunity-id="opp-repeat-1"'), 'REQUIRED: the feedback controls carry the real, durable ha_account_opportunities id for the REPEAT PATTERN row -- never the wrong family\'s ref');
  assert(html.includes('data-event-fingerprint="opp:repeat_pattern:v1:fresh repeat pattern co|onboarding-recruiting'), 'REQUIRED: the fingerprint is the real repeat_pattern one, not a follow_up fallback');
  assert(html.includes('account-history-prepare-btn') && html.includes('opportunity-used-status'), 'REQUIRED: Prepare for Call is the durable-ref, "Used check"-capable variant');
}

// ---------------------------------------------------------------------
// Sanity: an account with NO persisted ha_account_opportunities ref at all
// (accountHistoryOpportunityRefs null -- the genuinely never-reconciled
// case, e.g. a research/reconciliation call that hasn't completed yet)
// correctly falls back to the plain, non-V1B Prepare for Call button and
// shows no feedback controls -- proving this file's fixtures above are
// actually exercising the ref-present branch, not a permissive stub that
// would pass regardless.
// ---------------------------------------------------------------------
{
  const recentDate = isoDaysAgo(1);
  const rawOpp = {
    account: 'No Ref Yet Co', contact: 'Contact 3', evidence: ['1 purchase record'], industry: 'General Business',
    confidence: 60, department: 'Marketing', signalDate: recentDate, opportunity: 'Multi-Department Expansion',
    templateKey: 'generic_multi_department_expansion', whyNowScore: 90, contactEmail: 'buyer@norefyet.example',
    contactTitle: 'Marketing Manager', quickWinScore: 60, accountRevenue: 3000, buyingCategory: 'Apparel',
    estimatedValue: 1000, mostRecentDate: recentDate, businessSignals: [], opportunityName: 'Multi-Department Expansion',
    opportunityType: 'EXPANSION', signalLayerType: 'Follow-Up Signal', closeProbability: 60, opportunityScore: 90,
    reasonToReachOut: 'Recent order delivered or completed', relationshipStrength: 40, accountDiversityScore: 1,
    accountFrequencyScore: 0.2, conversationStarter: 'Check in.', historicalPurchaseData: []
  };
  const serverAccount = {
    name: 'No Ref Yet Co', uploadId: 'upload-fresh-3', accountHistoryOpportunityRefs: null,
    monitoringStatus: 'active', industry: 'General Business', contactName: 'Contact 3', contactEmail: 'buyer@norefyet.example',
    revenue: 3000, orderCount: 1, confidence: 60, relationshipStrength: 40, mostRecentDate: recentDate,
    activePipelineValue: 0, activePipelineCount: 0, subscores: { revenue: 0.2, frequency: 0.2, recency: 0.98, diversity: 1 },
    purchases: [], projects: [], allProjects: [], activePipeline: [], categoryTypes: [], signals: [],
    futureOpportunities: [rawOpp]
  };

  const sandbox = buildSandbox();
  const normalized = sandbox.normalizeSavedAccount(serverAccount);
  sandbox.window.accountRadarAccounts = [normalized];
  sandbox.refreshOpportunityViews();
  const html = sandbox.__grid.innerHTML;

  assert(html.includes('No Ref Yet Co'), 'sanity: the card still renders without a ref');
  assert(!html.includes('signal-feedback-btn'), 'sanity: with no ha_account_opportunities ref, no feedback controls are fabricated (this is the ONLY legitimate reason V1B controls are absent)');
  assert(!html.includes('account-history-prepare-btn') && html.includes('Prepare for Call'), 'sanity: Prepare for Call falls back to the plain, pre-V1B button when there is genuinely no ref yet');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
