// Fresh-upload V1B feedback-controls fix, root cause 2.
//
// Founder QA (live data pulled from Supabase for Quantum Materials/
// BrightPath Learning/Velocity Software/Sterling Devices, project
// zodtymrckbtbiomakupf) established via direct SQL that persistence was
// NOT the problem: every account had correct, active ha_account_opportunities
// rows for the current upload, with categories matching exactly between
// raw_data.repeatPatterns and ha_account_opportunities.category. The bug is
// in buildAccountsFromRows() (api/get-dashboard.js).
//
// raw_data holds each account's opportunities in two overlapping arrays
// (serializeAccountForStorage(), dashboard/index.html):
//   - repeatPatterns: every Repeat/Pattern-layer opportunity.
//   - existingSignals: every non-web-research opportunity -- Follow-Up
//     Signal entries (which exist ONLY here) PLUS a second copy of every
//     Repeat/Pattern entry already in repeatPatterns (confirmed live: the
//     exact same {category, opportunityType:'REPEAT PATTERN', ...} object
//     appears in both arrays for Quantum Materials/Sterling Devices/
//     Velocity Software/BrightPath Learning).
//
// Before the fix, only the repeatPatterns copy was run through
// stampAccountHistoryOpportunityRefs(). That meant:
//   1. A Follow-Up opportunity (existingSignals-only) could never be
//      stamped -- 100% of Follow-Up cards lost their ref, no exceptions.
//   2. A genuine Repeat/Pattern opportunity's two copies (one stamped, one
//      not) reach the client with an IDENTICAL opportunityDedupeKey() and
//      an IDENTICAL getOpportunityScore() (scoring never reads the ref
//      fields) -- dedupeOpportunities()'s strict `>` tie-break keeps
//      whichever was inserted first, and existingSignals is concatenated
//      before repeatPatterns, so the UNSTAMPED copy always won.
//
// The fix: stamp the existingSignals-derived array too, with the SAME
// stampAccountHistoryOpportunityRefs() call already used for repeatPatterns.
// This file proves, against the REAL buildAccountsFromRows() and the REAL
// client dedupe/render chain (not reimplemented), that:
//   - a Follow-Up opportunity (existingSignals-only) gets its ref
//   - a genuine Repeat/Pattern opportunity's duplicate copies BOTH carry
//     the ref, so whichever one survives client-side dedupe is stamped
//   - the rendered primary cards for both expose Useful/Not useful and the
//     ref-aware ("Used check"-capable) Prepare for Call button
//
// Usage: node scripts/test-fresh-upload-existingsignals-duplicate-ref-stamp.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';
import { buildAccountsFromRows } from '../api/get-dashboard.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Step 1: server side, real buildAccountsFromRows() -- the exact shape
// confirmed live: existingSignals contains a Follow-Up (QUICK WIN) entry AND
// a duplicate copy of the genuine Repeat Pattern entry also in repeatPatterns.
// ===========================================================================
// Two separate accounts (matching the real founder evidence, which spanned
// 4 different accounts) -- the priorities feed's default view shows only
// ONE primary card per account (prepareTimeboxReasons() caps at 1 via
// limitReasonsPerAccount(..., 1)), so a single account carrying BOTH a
// Follow-Up and a Repeat Pattern opportunity would only ever surface
// whichever scores higher as a PRIMARY card -- irrelevant to the bug (which
// is about ref-stamping, not about which opportunity wins that cap) but it
// would make this file's render assertions non-deterministic. Splitting
// into two single-family accounts keeps the render proof unambiguous while
// the data-layer stamping proof below still directly exercises the exact
// duplicated-array shape confirmed live.
const FOLLOWUP_ACCOUNT = 'Fresh Duplicate Follow-Up Co';
const REPEAT_ACCOUNT = 'Fresh Duplicate Repeat Co';
const recentDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

const genuineRepeatPatternOpp = {
  account: REPEAT_ACCOUNT, contact: 'Contact 1', years: [2025, 2026],
  whyNow: `${REPEAT_ACCOUNT} has ordered apparel 2 times across 2 years.`,
  category: 'Apparel', evidence: ['2 apparel orders found'], industry: 'General Business',
  confidence: 74, department: 'HR / People', signalDate: recentDate,
  opportunity: 'Apparel Program', templateKey: 'repeat_pattern', whyNowScore: 87,
  contactEmail: 'buyer@freshrepeat.example', contactTitle: 'Marketing Manager', purchaseMonth: 0,
  quickWinScore: 74, accountRevenue: 40000, buyingCategory: 'Apparel', estimatedValue: 11000,
  mostRecentDate: recentDate, planningWindow: 'week', businessSignals: [], opportunityName: 'Apparel Program',
  opportunityType: 'REPEAT PATTERN', signalLayerType: 'Repeat / Pattern Signal', closeProbability: 74,
  opportunityScore: 87, reasonToReachOut: 'Apparel Program may be coming up again',
  relationshipStrength: 86, accountDiversityScore: 1, accountFrequencyScore: 0.5,
  conversationStarter: 'Ask if the apparel program is happening again this year.', historicalPurchaseData: []
};
const followUpOpp = {
  account: FOLLOWUP_ACCOUNT, contact: 'Contact 1', evidence: ['3 purchase records', '$40,000 historical spend'],
  industry: 'General Business', confidence: 60, department: 'Marketing', signalDate: recentDate,
  opportunity: 'Multi-Department Expansion', templateKey: 'generic_multi_department_expansion',
  whyNowScore: 90, contactEmail: 'buyer@freshfollowup2.example', contactTitle: 'Marketing Manager',
  quickWinScore: 60, accountRevenue: 40000, buyingCategory: 'Apparel', estimatedValue: 4000,
  mostRecentDate: recentDate, businessSignals: [], opportunityName: 'Multi-Department Expansion',
  opportunityType: 'QUICK WIN', signalLayerType: 'Follow-Up Signal', closeProbability: 60,
  opportunityScore: 90, reasonToReachOut: 'Recent order delivered or completed',
  relationshipStrength: 60, accountDiversityScore: 1, accountFrequencyScore: 0.3,
  conversationStarter: 'Check in and ask how the recent order was received.', historicalPurchaseData: []
};

const accountRows = [
  {
    account_name: FOLLOWUP_ACCOUNT, upload_id: 'upload-fresh-dup', industry: 'General Business',
    metrics: { revenue: 40000, orderCount: 3, confidence: 60, relationshipStrength: 60, mostRecentDate: recentDate },
    // Confirmed live: a Follow-Up opportunity exists ONLY in existingSignals
    // -- repeatPatterns never carries one at all.
    raw_data: { existingSignals: [followUpOpp], repeatPatterns: [] }
  },
  {
    account_name: REPEAT_ACCOUNT, upload_id: 'upload-fresh-dup', industry: 'General Business',
    metrics: { revenue: 40000, orderCount: 3, confidence: 74, relationshipStrength: 86, mostRecentDate: recentDate },
    raw_data: {
      // Confirmed live (Quantum Materials/Sterling Devices/Velocity
      // Software/BrightPath Learning): the SAME genuine Repeat Pattern
      // opportunity appears in BOTH existingSignals (unstamped, pre-fix)
      // AND repeatPatterns (stamped, pre-fix too).
      existingSignals: [{ ...genuineRepeatPatternOpp }],
      repeatPatterns: [{ ...genuineRepeatPatternOpp }]
    }
  }
];
const accountOpportunityRows = [
  { id: 'opp-followup-dup', account_name: FOLLOWUP_ACCOUNT, opportunity_type: 'follow_up', category: null, fingerprint: `opp:follow_up:v1:fresh duplicate follow-up co|last:${recentDate}` },
  { id: 'opp-repeat-dup', account_name: REPEAT_ACCOUNT, opportunity_type: 'repeat_pattern', category: 'Apparel', fingerprint: `opp:repeat_pattern:v1:fresh duplicate repeat co|apparel|last:${recentDate}` }
];

const { accountList } = buildAccountsFromRows(accountRows, [], accountOpportunityRows);
const followUpServerAccount = accountList.find(a => a.name === FOLLOWUP_ACCOUNT);
const repeatServerAccount = accountList.find(a => a.name === REPEAT_ACCOUNT);
assert(!!followUpServerAccount && !!repeatServerAccount, 'sanity: buildAccountsFromRows() returns both fixture accounts');

const followUpPreDedupe = followUpServerAccount.futureOpportunities;
assert(followUpPreDedupe.length === 1, `sanity: the Follow-Up account has exactly 1 stored opportunity (existingSignals-only, no duplication) (got ${followUpPreDedupe.length})`);
assert(followUpPreDedupe[0]?.accountOpportunityId === 'opp-followup-dup', `REQUIRED: the Follow-Up opportunity (existingSignals-only) is stamped with its real ha_account_opportunities id (got ${followUpPreDedupe[0]?.accountOpportunityId})`);
assert(followUpPreDedupe[0]?.accountOpportunityFingerprint === accountOpportunityRows[0].fingerprint, 'REQUIRED: the Follow-Up opportunity carries the real fingerprint');

const repeatPreDedupe = repeatServerAccount.futureOpportunities;
assert(repeatPreDedupe.length === 2, `sanity: before client dedupe, the Repeat Pattern account has 2 stored opportunities (the existingSignals duplicate AND the repeatPatterns original) (got ${repeatPreDedupe.length})`);
assert(repeatPreDedupe.every(o => o.opportunityType === 'REPEAT PATTERN'), 'sanity: both copies are the genuine REPEAT PATTERN type');
assert(repeatPreDedupe.every(o => o.accountOpportunityId === 'opp-repeat-dup'), 'REQUIRED: BOTH copies of the genuine Repeat Pattern opportunity are stamped with the same real id -- not just the repeatPatterns one');
assert(repeatPreDedupe.every(o => o.accountOpportunityFingerprint === accountOpportunityRows[1].fingerprint), 'REQUIRED: BOTH copies carry the same real fingerprint');

// ===========================================================================
// Step 2 + 3: client side, the REAL normalizeSavedAccount() (which runs the
// real dedupeOpportunities() internally, exactly as the browser does) and
// the REAL render chain (renderWeeklyPrioritiesFeed -> renderRepOpportunityCard
// -> renderAccountHistoryOpportunityFeedback/renderPrepareForCallButton) --
// verbatim extracted source, nothing reimplemented or stubbed for the parts
// under test.
// ===========================================================================
const DASHBOARD_SRC = loadDashboardSource();
function fn(name){ return extractFn(DASHBOARD_SRC, name); }

const REAL_SOURCE = [
  fn('normalizeSavedAccount'), fn('dedupeOpportunities'), fn('opportunityDedupeKey'),
  fn('buyingOpportunityIdentity'), fn('cleanOpportunityToken'),
  fn('mergeBusinessSignalInitiatives'), fn('clusterBusinessSignalOpportunities'),
  fn('isWebResearchSignal'), fn('signalLayerLabel'), fn('normalizeSignalLayerType'),
  fn('isRecentAccountActivity'), fn('assignOpportunityScore'), fn('getOpportunityScore'),
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
].join('\n\n');

const STUB_SOURCE = `
function renderDetailedAccountViews(){}
function applyFreeCompanyLocksToCustomerAccounts(accounts){ return accounts; }
function calculateRevenueContext(){ return {historicalRevenue:0, historicalOpps:0, newBusinessOpps:0, totalReasons:0}; }
function renderResearchDiagnostics(){}
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
  vm.runInContext(INIT_SOURCE + '\n' + STUB_SOURCE + '\n' + REAL_SOURCE, sandbox, { filename: 'existingsignals-dup-ref-stamp-extract.js' });
  sandbox.__grid = gridEl;
  return sandbox;
}

const sandbox = buildSandbox();
// Each account's futureOpportunities is the REAL array buildAccountsFromRows()
// produced above -- exactly what the browser's fetch(/api/get-dashboard)
// response actually contains (the Repeat Pattern account's is still
// duplicated). normalizeSavedAccount() runs the REAL client
// dedupeOpportunities() on each, same as production.
const normalizedFollowUp = sandbox.normalizeSavedAccount({ ...followUpServerAccount });
const normalizedRepeat = sandbox.normalizeSavedAccount({ ...repeatServerAccount });

const dedupedRepeatPatternCopies = normalizedRepeat.futureOpportunities.filter(o => o.opportunityType === 'REPEAT PATTERN');
assert(dedupedRepeatPatternCopies.length === 1, `REQUIRED: client-side dedupe collapses the two Repeat Pattern copies down to exactly one (the duplicate copies DO enter client dedupe) (got ${dedupedRepeatPatternCopies.length})`);
assert(dedupedRepeatPatternCopies[0]?.accountOpportunityId === 'opp-repeat-dup', `REQUIRED: whichever Repeat Pattern copy survives client dedupe still carries the authoritative ref (got ${dedupedRepeatPatternCopies[0]?.accountOpportunityId})`);

const dedupedFollowUp = normalizedFollowUp.futureOpportunities.find(o => o.opportunityType === 'QUICK WIN');
assert(dedupedFollowUp?.accountOpportunityId === 'opp-followup-dup', `REQUIRED: the Follow-Up opportunity survives dedupe with its authoritative ref intact (got ${dedupedFollowUp?.accountOpportunityId})`);

// Both accounts in one dashboard session, one real render pass -- the
// priorities feed's default view shows exactly 1 primary card per account,
// so each fixture account (single family each) surfaces its own primary
// card, matching the founder's actual multi-account evidence.
sandbox.window.accountRadarAccounts = [normalizedFollowUp, normalizedRepeat];
sandbox.refreshOpportunityViews();
const html = sandbox.__grid.innerHTML;

assert(html.includes(FOLLOWUP_ACCOUNT), 'sanity: the Follow-Up fixture account renders a primary card');
assert(html.includes(REPEAT_ACCOUNT), 'sanity: the Repeat Pattern fixture account renders a primary card');
assert((html.match(/signal-feedback-btn/g) || []).length === 4, `REQUIRED: exactly 2 primary cards (Follow-Up + the surviving Repeat Pattern) each expose the Useful/Not-useful pair (4 signal-feedback-btn elements total, got ${(html.match(/signal-feedback-btn/g) || []).length})`);
assert(html.includes('data-opportunity-id="opp-followup-dup"'), 'REQUIRED: the rendered Follow-Up card\'s feedback controls carry the real id');
assert(html.includes('data-opportunity-id="opp-repeat-dup"'), 'REQUIRED: the rendered Repeat Pattern card\'s feedback controls carry the real id');
assert((html.match(/account-history-prepare-btn/g) || []).length === 2, `REQUIRED: both primary cards render the ref-aware ("Used check"-capable) Prepare for Call button, not the plain onclick fallback (got ${(html.match(/account-history-prepare-btn/g) || []).length})`);
assert(!html.includes("onclick='createSalesPlayPanel"), 'REQUIRED: neither card falls back to the plain, pre-V1B Prepare for Call button');

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
