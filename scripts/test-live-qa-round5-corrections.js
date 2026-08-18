// Founder Preview QA round 5 -- two correctness fixes plus real render-path
// coverage for each, exercised through the REAL production functions
// (extracted verbatim from dashboard/index.html, never reimplemented) and
// the REAL account-build -> save -> server-round-trip -> hydrate sequence,
// exactly like round 3/4's regression files.
//
// Root causes closed this round:
//   1. Meridian Follow-Up eligibility: isPriorityEligibleOpportunity() had
//      no age ceiling on Follow-Up Signal opportunities at all -- a single
//      real order, however old, stayed an ACTIVE opportunity forever, so
//      round 4's fix (a lone purchase can never be Repeat/Pattern) simply
//      widened who qualified for Follow-Up instead of narrowing eligibility
//      correctly. A single purchase now only creates an active Follow-Up
//      opportunity when it falls inside a 90-day window of "today" -- older
//      than that, it remains real Account History (still visible, still
//      evidence) but is no longer surfaced as something to act on this
//      week. 2+ purchases are completely unaffected (they are gated by
//      opportunityType/signalLayerType, not this age check, and only ever
//      reach this branch if they failed to cross findRepeatPatternGroups()'s
//      own 2-record minimum in the first place).
//   2. Primary/Additional "duplicate": NOT actually a dedupe/identity bug --
//      sameOpportunity()/accountOpportunityCluster() were correctly treating
//      a genuine REPEAT PATTERN opportunity and collapseDuplicateGenericRepeatSignals()'s
//      surviving best-scoring generic industry-fallback opportunity (same
//      account, opportunityType 'REPEAT PATTERN' vs a different, non-
//      authoritative type) as two legitimately DIFFERENT opportunities --
//      which they are. The visible "duplicate" was opportunityHeadline()
//      rendering the IDENTICAL string "Repeat buying window detected" for
//      both 'Annual Buying Pattern'/'Repeat Buying Pattern' (a real
//      detected cadence) and 'Reorder Due' (a generic template that merely
//      inherited the Repeat/Pattern label via low account recency, with no
//      cadence evidence at all). 'Reorder Due' now gets its own distinct
//      headline, so the two opportunities read as the two different claims
//      they actually are.
//
// Usage: node scripts/test-live-qa-round5-corrections.js
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
  extractFn(DASHBOARD_SRC, 'currentOrgPreferences'),
  extractFn(DASHBOARD_SRC, 'ORG_PREFERENCE_FAMILY_BY_SIGNAL_LAYER'),
  extractFn(DASHBOARD_SRC, 'getOrgPreferenceAdjustmentForOpportunity'),
  extractRange(DASHBOARD_SRC, 'function calculateOpportunityScore(opp){', 'function assignOpportunityScore(opp, account){'),
  extractRange(DASHBOARD_SRC, 'function monthIndexFromName(name){', 'function opportunityMatchesTimebox(opp, timebox){'),
  extractFn(DASHBOARD_SRC, 'hasMeaningfulHistoricalOrder'),
  extractFn(DASHBOARD_SRC, 'deriveAccountIntelligenceMode'),
  extractFn(DASHBOARD_SRC, 'getRelationshipStrength'),
  extractFn(DASHBOARD_SRC, 'getRelationshipMode'),
  extractFn(DASHBOARD_SRC, 'generateSimulatedSignals'),
  extractFn(DASHBOARD_SRC, 'importedContactsFromRecords'),
  extractFn(DASHBOARD_SRC, 'serializeAccountForStorage'),
  extractFn(DASHBOARD_SRC, 'generateContactId'),
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
  extractFn(DASHBOARD_SRC, 'isPossibleMatchIdentity'),
  extractFn(DASHBOARD_SRC, 'hasConfirmedOrLegacyIdentity'),
  extractFn(DASHBOARD_SRC, 'hasCredibleActivationPlay'),
  extractFn(DASHBOARD_SRC, 'signalDateAndActionabilityLine'),
  extractFn(DASHBOARD_SRC, 'pluralize'),
  extractFn(DASHBOARD_SRC, 'feedSummary'),
  extractFn(DASHBOARD_SRC, 'mergeBusinessSignalInitiatives'),
  extractFn(DASHBOARD_SRC, 'clusterBusinessSignalOpportunities'),
  extractFn(DASHBOARD_SRC, 'realPriorCategories'),
  extractFn(DASHBOARD_SRC, 'findAccountForOpp'),
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
  'parseCSV', 'inferPromoCategory', 'inferIndustry', 'isLikelyInvalidAccountName', 'parseMaybeDate',
  'isClosedHistoricalRecord', 'isActivePipelineRecord', 'hasOrderHistoryEvidence', 'sumRevenue',
  'findRepeatPatternGroups', 'createRepeatPatternOpportunities', 'categoryToPromoSuggestions',
  'generateFutureOpportunities', 'createOpportunity', 'deriveAccountIntelligenceMode',
  'getRelationshipStrength', 'getRelationshipMode', 'generateSimulatedSignals', 'importedContactsFromRecords',
  'hasMeaningfulHistoricalOrder',
  'signalLayerLabel', 'isWebResearchSignal', 'isRecentAccountActivity',
  'isAccountHistoryOpportunity', 'reorderWindowStatus', 'accountHistoryStatusLine', 'formatShortDate',
  'getRecommendationType', 'getOpportunityPlanningWindow', 'opportunityMatchesTimebox',
  'classifyMonthWindow', 'monthDistanceFromNow', 'inferPurchaseMonth',
  'serializeAccountForStorage', 'normalizeSavedAccount', 'dedupeOpportunities', 'dedupeFoundSignals',
  'buyingOpportunityIdentity', 'opportunityDedupeKey', 'opportunitiesLikelySameInitiative', 'sameOpportunity',
  'collapseDuplicateAccountHistorySignals', 'collapseDuplicateFollowUps', 'collapseDuplicateGenericRepeatSignals',
  'isPriorityEligibleOpportunity', 'priorityEligibleOpportunities', 'sortDailyReasons', 'getDailyReasonScore',
  'hasConfirmedOrLegacyIdentity', 'hasCredibleActivationPlay', 'signalDateAndActionabilityLine',
  'pluralize', 'feedSummary',
  'assignOpportunityScore', 'calculateOpportunityScore',
  'realPriorCategories', 'findAccountForOpp', 'accountOpportunityCluster', 'additionalOpportunitiesFor',
  'renderAccountContextSection', 'accountContextFallbackMessage', 'escapeHtml', 'fmtMoney', 'shortText',
  'opportunityHeadline', 'businessSignalKind'
];

const sandbox = { window: { addEventListener(){},}, console, document: { addEventListener(){} } };
vm.createContext(sandbox);
new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'round5-extract.js' }).runInContext(sandbox);
const dash = sandbox.__exports;
for(const name of EXPORT_NAMES){
  assert(typeof dash[name] === 'function', `dashboard/index.html export "${name}" extracted successfully as a real function`);
}

// Same processData()-equivalent account-build loop round 3/4 used -- real
// account-build shape, uploadId genuinely unset.
function buildAccountsLikeProcessData(records){
  const clients = {};
  records.forEach(record => { if(!clients[record.client]) clients[record.client] = []; clients[record.client].push(record); });
  const closedRevenueByClient = Object.values(clients).map(orders => {
    const closed = orders.filter(dash.isClosedHistoricalRecord).filter(dash.hasOrderHistoryEvidence);
    return dash.sumRevenue(closed);
  });
  const minRev = Math.min(...closedRevenueByClient, 0);
  const maxRev = Math.max(...closedRevenueByClient, 1);
  const revRange = maxRev - minRev || 1;
  const accounts = [];
  for(const clientName in clients){
    const allOrders = clients[clientName];
    const closedOrders = allOrders.filter(dash.isClosedHistoricalRecord);
    const activePipeline = allOrders.filter(o => dash.hasOrderHistoryEvidence(o) && (!dash.isClosedHistoricalRecord(o) || dash.isActivePipelineRecord(o)));
    const scoringOrders = closedOrders.filter(dash.hasOrderHistoryEvidence);
    const totalRevenue = dash.sumRevenue(scoringOrders);
    const orderCount = scoringOrders.length;
    const categories = new Set(scoringOrders.map(o => o.category).filter(Boolean));
    const mostRecentDate = scoringOrders.filter(o => o.date).sort((a, b) => b.date - a.date)[0]?.date;
    const daysSinceLast = mostRecentDate ? Math.floor((new Date() - mostRecentDate) / (1000 * 60 * 60 * 24)) : 999;
    const revScore = (totalRevenue - minRev) / revRange;
    const freqScore = Math.min(orderCount / 10, 1);
    const recencyScore = Math.max(1 - (daysSinceLast / 365), 0);
    const diversityScore = Math.min(categories.size / 4, 1);
    const contacts = dash.importedContactsFromRecords(allOrders);
    const account = {
      name: clientName, industry: dash.inferIndustry(clientName, []), revenue: totalRevenue,
      activePipelineValue: dash.sumRevenue(activePipeline), orderCount, activePipelineCount: activePipeline.length,
      confidence: 50,
      subscores: { revenue: revScore, frequency: freqScore, recency: recencyScore, diversity: diversityScore },
      categoryTypes: categories,
      contactName: contacts[0]?.name || '', contactEmail: contacts[0]?.email || '', contacts,
      intelligenceMode: dash.deriveAccountIntelligenceMode(allOrders),
      purchases: scoringOrders, activePipeline, allRecords: allOrders,
      mostRecentDate: mostRecentDate ? mostRecentDate.toISOString().slice(0,10) : 'Unknown'
    };
    account.relationshipStrength = dash.getRelationshipStrength(account);
    account.relationshipMode = dash.getRelationshipMode(account);
    account.signals = dash.generateSimulatedSignals(account, {});
    account.futureOpportunities = orderCount > 0 ? dash.generateFutureOpportunities(account) : [];
    accounts.push(account);
  }
  return accounts;
}

const csvText = readFileSync(new URL('./fixtures/repeat-order-follow-up-fixture.csv', import.meta.url), 'utf8');
const records = dash.parseCSV(csvText);
const freshAccounts = buildAccountsLikeProcessData(records);

// ===========================================================================
// Item 1: Meridian Follow-Up eligibility window.
// Meridian's one real purchase is 2025-11-20; this test runs "today" (i.e.
// whatever the machine's real clock reads), so on any date this fixture is
// run at or after roughly Feb 2026 that purchase is genuinely more than 90
// days old -- exactly the founder's Aug 2026 QA finding. Uses the real
// clock (not a frozen date) on purpose: it must never mask itself into
// passing by hardcoding a "now" the way this exact opportunity's own
// eligibility gate does NOT.
// ===========================================================================
{
  const meridian = freshAccounts.find(a => a.name === 'Meridian Office Partners');
  assert(meridian.orderCount === 1, `sanity: Meridian has exactly 1 purchase record (got ${meridian.orderCount})`);
  const meridianOpps = meridian.futureOpportunities;
  assert(meridianOpps.length > 0, 'sanity: Meridian generated at least one opportunity from its single purchase');
  assert(meridianOpps.every(o => o.signalLayerType !== 'Repeat / Pattern Signal'), `REQUIRED: a single purchase record never carries signalLayerType 'Repeat / Pattern Signal' (got ${JSON.stringify(meridianOpps.map(o=>o.signalLayerType))})`);
  assert(meridianOpps.every(o => o.opportunityType !== 'REPEAT PATTERN'), 'REQUIRED: a single purchase record never carries opportunityType \'REPEAT PATTERN\'');

  const followUpOpp = meridianOpps.find(o => o.signalLayerType === 'Follow-Up Signal');
  assert(!!followUpOpp, 'sanity: Meridian\'s single purchase generated a Follow-Up Signal opportunity');

  const daysOld = Math.floor((new Date() - new Date(followUpOpp.signalDate)) / (1000 * 60 * 60 * 24));
  assert(daysOld > 90, `sanity: Meridian's 2025-11-20 purchase is genuinely more than 90 days before today (got ${daysOld} days) -- this is what the eligibility fix must reject`);
  assert(dash.isPriorityEligibleOpportunity(followUpOpp) === false, `REQUIRED: isPriorityEligibleOpportunity() rejects a Follow-Up Signal opportunity whose only purchase is outside the 90-day window (Meridian, ${daysOld} days old)`);
  const eligible = dash.priorityEligibleOpportunities(meridianOpps);
  assert(!eligible.includes(followUpOpp), 'REQUIRED: priorityEligibleOpportunities() excludes Meridian\'s stale Follow-Up opportunity -- it creates no active opportunity, even though it remains real, visible Account History');

  // A single purchase INSIDE the window must still be allowed to create a
  // legitimate Follow-Up opportunity -- the correction must not become a
  // blanket "single purchase = never actionable" rule. Same real object,
  // only the underlying order date changes (a recent order, 10 days ago).
  // isPriorityEligibleOpportunity() reads opp.lastOrderDate || opp.mostRecentDate
  // || opp.signalDate in that precedence order -- assignOpportunityScore()
  // (called at the end of every createOpportunity()) bakes account.mostRecentDate
  // onto the opp as opp.mostRecentDate too, so a faithful "this order was
  // recent" scenario must move that field, not signalDate alone.
  const recentFollowUp = { ...followUpOpp };
  const recentDate = new Date();
  recentDate.setDate(recentDate.getDate() - 10);
  const recentDateStr = recentDate.toISOString().slice(0, 10);
  recentFollowUp.signalDate = recentDateStr;
  recentFollowUp.mostRecentDate = recentDateStr;
  assert(dash.isPriorityEligibleOpportunity(recentFollowUp) === true, 'REQUIRED: a single purchase INSIDE the Follow-Up window (10 days old) still creates an eligible, active Follow-Up opportunity -- the fix narrows the window, it does not disqualify single purchases outright');
}

// ===========================================================================
// Existing Brightview Follow-Up must remain valid -- its one real purchase
// (2026-07-24) is recent under any realistic QA-run date, and must not be
// caught by the new 90-day ceiling.
// ===========================================================================
{
  const brightview = freshAccounts.find(a => a.name === 'Brightview Dental Group');
  assert(brightview.orderCount === 1, `sanity: Brightview has exactly 1 purchase record (got ${brightview.orderCount})`);
  const followUpOpp = brightview.futureOpportunities.find(o => o.signalLayerType === 'Follow-Up Signal');
  assert(!!followUpOpp, 'sanity: Brightview\'s single purchase generated a Follow-Up Signal opportunity');
  const daysOld = Math.floor((new Date() - new Date(followUpOpp.signalDate)) / (1000 * 60 * 60 * 24));
  if(daysOld <= 90){
    assert(dash.isPriorityEligibleOpportunity(followUpOpp) === true, `REQUIRED: Brightview's real, recent (${daysOld}-day-old) Follow-Up opportunity remains eligible -- the round-5 fix must not regress an already-correct case`);
    const eligible = dash.priorityEligibleOpportunities(brightview.futureOpportunities);
    assert(eligible.includes(followUpOpp), 'REQUIRED: priorityEligibleOpportunities() keeps Brightview\'s valid Follow-Up opportunity');
  } else {
    console.log(`NOTE: Brightview's fixture purchase (2026-07-24) is now ${daysOld} days old under the current clock and has legitimately aged out of the Follow-Up window itself -- this is expected fixture drift, not a regression, so this block is skipped rather than asserted either way.`);
  }
}

// ===========================================================================
// Item 2: primary/additional "duplicate" -- headline collision, not an
// identity/dedupe bug. Ridgeline generates a real REPEAT PATTERN
// opportunity (its 4 same-category Headwear orders spanning 2023-2025)
// AND a generic industry-fallback opportunity that inherited the
// Repeat/Pattern label via low account recency -- collapseDuplicateGenericRepeatSignals()
// correctly keeps both as distinct opportunities (verified below), and
// they must no longer render with the same headline text.
// ===========================================================================
{
  const ridgeline = freshAccounts.find(a => a.name === 'Ridgeline Auto Group');
  assert(ridgeline.orderCount === 4, `sanity: Ridgeline has 4 purchase records (got ${ridgeline.orderCount})`);
  const primaryOpp = ridgeline.futureOpportunities.find(o => o.opportunityType === 'REPEAT PATTERN');
  assert(!!primaryOpp, 'sanity: Ridgeline generated a real REPEAT PATTERN opportunity');
  const companionOpp = ridgeline.futureOpportunities.find(o => o.opportunityType !== 'REPEAT PATTERN' && dash.getRecommendationType(o) === 'Reorder Due');
  assert(!!companionOpp, 'sanity: Ridgeline also generated a generic industry-fallback opportunity classified \'Reorder Due\' (inherited Repeat/Pattern label via low recency, not a real detected cadence)');

  assert(dash.sameOpportunity(primaryOpp, companionOpp) === false, 'REQUIRED: sameOpportunity() correctly treats the real pattern and the generic fallback as two DIFFERENT opportunities -- this was never actually the bug');

  const primaryHeadline = dash.opportunityHeadline(primaryOpp);
  const companionHeadline = dash.opportunityHeadline(companionOpp);
  assert(primaryHeadline === 'Repeat buying window detected', `REQUIRED: the real REPEAT PATTERN opportunity's headline is "Repeat buying window detected" (got "${primaryHeadline}")`);
  assert(companionHeadline !== primaryHeadline, `REQUIRED (the actual round-5 root cause): the generic 'Reorder Due' companion opportunity must render a DIFFERENT headline than the real Repeat/Pattern opportunity -- both rendered "${primaryHeadline}" before this fix, which is what looked like a duplicate under Additional Opportunities Found (companion headline: "${companionHeadline}")`);

  // Full real pipeline: save -> server round trip -> hydrate -> the REAL
  // additionalOpportunitiesFor() the Prepare for Call panel calls.
  const UPLOAD_ID = 'upload-fixture-round5';
  freshAccounts.forEach(a => {
    a.uploadId = a.uploadId || UPLOAD_ID;
    (a.futureOpportunities || []).forEach(opp => { opp.uploadId = opp.uploadId || UPLOAD_ID; });
  });
  const rows = freshAccounts.map((a, i) => ({
    id: `round5-${i}`, account_name: a.name, upload_id: UPLOAD_ID, industry: a.industry,
    contact_name: a.contactName, contact_email: a.contactEmail,
    metrics: dash.serializeAccountForStorage(a, {includeSignals:false}).metrics,
    raw_data: dash.serializeAccountForStorage(a, {includeSignals:false}).rawData,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }));
  const serverAccounts = buildAccountsFromRows(rows, []).accountList;
  const reloadedAccounts = serverAccounts.map(dash.normalizeSavedAccount);
  sandbox.window.accountRadarAccounts = reloadedAccounts;

  const reloadedRidgeline = reloadedAccounts.find(a => a.name === 'Ridgeline Auto Group');
  const reloadedPrimary = reloadedRidgeline.futureOpportunities.find(o => o.opportunityType === 'REPEAT PATTERN');
  assert(!!reloadedPrimary, 'sanity: Ridgeline\'s real REPEAT PATTERN opportunity survives the full save/reload round trip');

  const additional = dash.additionalOpportunitiesFor(reloadedPrimary);
  const reloadedPrimaryHeadline = dash.opportunityHeadline(reloadedPrimary);
  const visualDuplicate = additional.find(o => dash.opportunityHeadline(o) === reloadedPrimaryHeadline);
  assert(!visualDuplicate, `REQUIRED (real PFC render path): none of the Additional Opportunities returned for Ridgeline's primary Repeat/Pattern opportunity render the SAME headline text as the primary itself (primary: "${reloadedPrimaryHeadline}"; additional headlines: ${JSON.stringify(additional.map(o => dash.opportunityHeadline(o)))})`);
  const reloadedCompanion = additional.find(o => dash.getRecommendationType(o) === 'Reorder Due');
  assert(!!reloadedCompanion, 'sanity: the generic Reorder Due companion still legitimately appears in Additional Opportunities (it is a real, distinct opportunity, not something to be removed)');
}

// ===========================================================================
// PFC render-path coverage for a Follow-Up primary too (not just Repeat/
// Pattern): Brightview's Follow-Up opportunity must never show itself as
// its own "additional" opportunity either.
// ===========================================================================
{
  const brightview = freshAccounts.find(a => a.name === 'Brightview Dental Group');
  const followUpOpp = brightview.futureOpportunities.find(o => o.signalLayerType === 'Follow-Up Signal');
  if(followUpOpp && dash.isPriorityEligibleOpportunity(followUpOpp)){
    const additional = dash.additionalOpportunitiesFor(followUpOpp);
    const selfDuplicate = additional.find(o => o.account === followUpOpp.account && o.opportunity === followUpOpp.opportunity);
    assert(!selfDuplicate, 'REQUIRED: additionalOpportunitiesFor() never returns Brightview\'s own Follow-Up primary opportunity as its own Additional Opportunity');
  } else {
    console.log('NOTE: Brightview\'s Follow-Up opportunity aged out of eligibility under the current clock (see the block above) -- skipping its own PFC additional-opportunities check since it would no longer be a reachable primary.');
  }
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
