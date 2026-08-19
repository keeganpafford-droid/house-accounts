// Founder Preview QA round 3 (post-e4c8713) -- four further confirmed
// global defects, each proven against the REAL, verbatim extracted
// production functions:
//
//   1. Cross-upload account identity: findAccountForOpp()/
//      accountOpportunityCluster() matched window.accountRadarAccounts by
//      NAME ONLY. Account names are unique only WITHIN one upload (the
//      SAME invariant createOpportunity()'s own opp.uploadId field and
//      normalizeSavedAccount() already established -- see their own "ROUND
//      13" comments) -- once the same company has been uploaded more than
//      once (routine for repeated fixture QA), a name-only lookup can
//      silently resolve to a stale, different upload's copy of the account,
//      explaining Account Context/cadence/Additional-Opportunities reading
//      from the wrong snapshot even after the underlying data pipeline is
//      correct.
//   2. Category/program copy drift, second call site: getReasonToReachOutTitle()
//      (the Prepare for Call SUBTITLE's own source, "Past buying suggests a
//      ___ conversation") had the exact same defect class as
//      getSuggestedOpener() (fixed in the prior round) -- naming the
//      generic opportunity/template ("Employee Recognition Program")
//      instead of the account's real, order-derived purchase category.
//   3. Primary/Additional Opportunities duplicate: sameOpportunity() only
//      compared the AI/rules-inferred buying-conversation key
//      (department/category/buyer/topic-token text), which can legitimately
//      differ by a token between two independently re-fetched/re-deduped
//      representations of the EXACT same real Repeat/Pattern opportunity --
//      even with clean, non-corrupted data. A genuinely detected pattern
//      already carries a deterministic identity (opportunityType 'REPEAT
//      PATTERN' + its own program name) that is at least as authoritative
//      as the fingerprint check sameOpportunity() already uses for business
//      opportunities.
//   4. Meridian classification (not just label): the dashboard's "N reorder
//      opportunities" summary counted ANY Repeat/Pattern-Signal-layer
//      opportunity, including a generic industry-fallback template with
//      opportunityType !== 'REPEAT PATTERN' (zero real detected cadence) --
//      inflating the fixture's real 5-account result to 6.
//
// Usage: node scripts/test-live-qa-round3-corrections.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

// ===========================================================================
// Item 1: cross-upload account identity (findAccountForOpp/accountOpportunityCluster).
// ===========================================================================
{
  const SRC = [
    extractFn(DASHBOARD_SRC, 'findAccountForOpp'),
    extractFn(DASHBOARD_SRC, 'realPriorCategories')
  ].join('\n\n');
  const sandbox = { window: { addEventListener(){},}, console, document: { addEventListener(){} } };
  vm.createContext(sandbox);
  new vm.Script(SRC, { filename: 'find-account-extract.js' }).runInContext(sandbox);
  const { findAccountForOpp } = sandbox;

  // Two uploads' worth of the SAME company name -- an OLD, pre-fix upload
  // (stale mostRecentDate) and a FRESH, correct one -- exactly the shape a
  // repeated fixture re-upload produces.
  sandbox.window.accountRadarAccounts = [
    { name: 'Ridgeline Auto Group', uploadId: 'upload-old-stale', mostRecentDate: '2025-08-13', categoryTypes: new Set(['Headwear']) },
    { name: 'Ridgeline Auto Group', uploadId: 'upload-fresh-correct', mostRecentDate: '2025-08-14', categoryTypes: new Set(['Headwear']) }
  ];
  const oppFromFreshUpload = { account: 'Ridgeline Auto Group', uploadId: 'upload-fresh-correct' };
  const resolved = findAccountForOpp(oppFromFreshUpload);
  assert(resolved && resolved.uploadId === 'upload-fresh-correct', `REQUIRED: findAccountForOpp() resolves to the SAME upload's account when opp.uploadId is set, never an earlier/stale same-named duplicate from a different upload (got uploadId "${resolved && resolved.uploadId}")`);
  assert(resolved && resolved.mostRecentDate === '2025-08-14', `REQUIRED: the resolved account carries the fresh, correct mostRecentDate, not the stale duplicate's (got "${resolved && resolved.mostRecentDate}")`);

  // Legacy/untagged opportunity (no uploadId) still falls back to a
  // name-only match rather than resolving nothing.
  const legacyOpp = { account: 'Ridgeline Auto Group' };
  const legacyResolved = findAccountForOpp(legacyOpp);
  assert(!!legacyResolved, 'sanity: an opportunity with no uploadId still resolves via the name-only fallback, unchanged from prior behavior');
}

// ===========================================================================
// Item 2: getReasonToReachOutTitle() category grounding.
// ===========================================================================
{
  const SRC = [
    extractFn(DASHBOARD_SRC, 'findAccountForOpp'),
    extractFn(DASHBOARD_SRC, 'realPriorCategories'),
    // Final bounded Beta trust correction: getReasonToReachOutTitle() now
    // reads canonicalSignalKind() (and its two backing tables) instead of
    // opp.signalType substring matching -- extracted alongside it so this
    // isolated sandbox has the real dependency in scope, not a stub.
    extractRange(DASHBOARD_SRC, 'const CANONICAL_KIND_BY_EVENT_TYPE = {', 'function canonicalSignalKind(opp){'),
    extractFn(DASHBOARD_SRC, 'getReasonToReachOutTitle')
  ].join('\n\n');
  const sandbox = { window: { addEventListener(){},}, console, document: { addEventListener(){} } };
  vm.createContext(sandbox);
  new vm.Script(SRC, { filename: 'reason-title-extract.js' }).runInContext(sandbox);
  const { getReasonToReachOutTitle } = sandbox;

  sandbox.window.accountRadarAccounts = [{ name: 'Brightview Dental Group', categoryTypes: new Set(['Onboarding / Recruiting']) }];
  const brightviewTitle = getReasonToReachOutTitle({
    account: 'Brightview Dental Group', opportunity: 'Employee Recognition Program',
    opportunityCategory: '', isVerifiedSignalOpportunity: false, sourceUrl: ''
  });
  assert(/onboarding \/ recruiting/i.test(brightviewTitle), `REQUIRED (Brightview PFC subtitle): "Past buying suggests..." names the account's REAL purchased category, not the unrelated generic template it came from (got "${brightviewTitle}")`);
  assert(!/recognition/i.test(brightviewTitle), `REQUIRED: the PFC subtitle never claims a "recognition" program for an account with no recognition/awards purchase history (got "${brightviewTitle}")`);

  // A real business signal (sourceUrl set) with a genuine canonical
  // classification still renders correctly. Final bounded Beta trust
  // correction: getReasonToReachOutTitle() now reads canonicalSignalKind()
  // (opp.canonicalEventType/opportunityType), not opp.signalType substring
  // matching -- a real hydrated opportunity always carries a canonical
  // classification (set at persist time by both research endpoints, or
  // self-healed at read time for a legacy row missing one), so this fixture
  // supplies the canonical enum a genuine hiring signal would actually have.
  const businessTitle = getReasonToReachOutTitle({ signalType: 'Hiring Signal', canonicalEventType: 'HIRING_ACTIVITY', sourceUrl: 'https://example.com/article', isVerifiedSignalOpportunity: true });
  assert(businessTitle === 'Hiring creates a timely reason to check in', `sanity: a genuine canonical hiring signal's title is correct (got "${businessTitle}")`);
}

// ===========================================================================
// Item 3: sameOpportunity() fingerprint fix -- a real Repeat/Pattern
// opportunity must never appear as its own Additional Opportunity, even
// when the buying-conversation key legitimately differs by a token between
// two independent representations of the same real pattern.
// ===========================================================================
{
  const SRC = [
    extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(value){', 'function isRelationshipExpansionOpportunity(opp){'),
    extractRange(DASHBOARD_SRC, 'function likelyDepartmentFromOpportunity(opp){', 'function likelyKnownBuyer(opp){'),
    extractFn(DASHBOARD_SRC, 'likelyKnownBuyer'),
    extractFn(DASHBOARD_SRC, 'primaryCategoryFromOpportunity'),
    extractFn(DASHBOARD_SRC, 'getRecommendationType'),
    extractRange(DASHBOARD_SRC, 'function signalLayerLabel(opp){', 'function isRecentAccountActivity(opp){'),
    extractFn(DASHBOARD_SRC, 'isWebResearchSignal'),
    extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
    extractRange(DASHBOARD_SRC, 'function isAccountHistoryOpportunity(opp){', 'function accountHistoryStatusLine(opp){'),
    extractFn(DASHBOARD_SRC, 'formatShortDate'),
    extractFn(DASHBOARD_SRC, 'parseMaybeDate'),
    extractRange(DASHBOARD_SRC, 'function daysSinceDate(value){', 'function getRecommendationType(opp){'),
    extractFn(DASHBOARD_SRC, 'buyingOpportunityIdentity'),
    extractFn(DASHBOARD_SRC, 'opportunityDedupeKey'),
    extractFn(DASHBOARD_SRC, 'opportunitiesLikelySameInitiative'),
    extractFn(DASHBOARD_SRC, 'sameOpportunity')
  ].join('\n\n');
  const sandbox = { console };
  vm.createContext(sandbox);
  new vm.Script(SRC, { filename: 'same-opportunity-extract.js' }).runInContext(sandbox);
  const { sameOpportunity, opportunityDedupeKey } = sandbox;

  // Two representations of the EXACT same real Ridgeline Headwear pattern --
  // same account, same real opportunityType/program name, but with a subtly
  // different reasonToReachOut/whyNow phrasing (exactly what two
  // independent re-fetch/re-dedupe passes can legitimately produce), which
  // was enough to change buyingOpportunityIdentity()'s own topic token and
  // therefore the old dedupe key.
  const primary = {
    account: 'Ridgeline Auto Group', signalLayerType: 'Repeat / Pattern Signal', opportunityType: 'REPEAT PATTERN',
    opportunity: 'Headwear Program', years: [2023, 2024, 2025],
    reasonToReachOut: 'Headwear Program may be coming up again',
    whyNow: 'Ridgeline Auto Group has ordered headwear 4 times across 3 years, with activity around August.'
  };
  const additionalCopy = {
    account: 'Ridgeline Auto Group', signalLayerType: 'Repeat / Pattern Signal', opportunityType: 'REPEAT PATTERN',
    opportunity: 'Headwear Program', years: [2023, 2024, 2025],
    // Deliberately different phrasing -- same real pattern, re-derived on a
    // second, independent pass.
    reasonToReachOut: 'Headwear Program normal timing has passed',
    whyNow: 'Ridgeline Auto Group has ordered headwear 4 times, with activity around August.'
  };
  assert(opportunityDedupeKey(primary) !== opportunityDedupeKey(additionalCopy), 'sanity: the old buying-conversation key genuinely differs between these two representations -- proving this is a real gap, not a contrived one');
  assert(sameOpportunity(primary, additionalCopy) === true, `REQUIRED: sameOpportunity() recognizes two representations of the SAME real Repeat/Pattern opportunity (same account, same opportunityType 'REPEAT PATTERN', same program name) even when their buying-conversation keys differ -- this is what stops a real pattern from appearing as its own Additional Opportunity`);

  // A genuinely different real pattern for the SAME account (different
  // program) must stay distinct.
  const differentPattern = { ...additionalCopy, opportunity: 'Uniform Program' };
  assert(sameOpportunity(primary, differentPattern) === false, 'REQUIRED: two genuinely different real patterns for the same account (different program names) are never collapsed together by the new fingerprint check');
}

// ===========================================================================
// Item 4: feedSummary() reorder-opportunity count excludes Meridian's
// generic-fallback template -- proven against the real fixture CSV through
// the full real production chain (same infrastructure as
// scripts/test-repeat-followup-live-pipeline-e2e.js).
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
    extractFn(DASHBOARD_SRC, 'pluralize'),
    extractFn(DASHBOARD_SRC, 'feedSummary')
  ].join('\n\n');
  const sandbox = { window: { addEventListener(){},}, console, document: { addEventListener(){} } };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\nthis.__exports = { parseCSV, generateFutureOpportunities, feedSummary, opportunityMatchesTimebox };`, { filename: 'meridian-count-extract.js' }).runInContext(sandbox);
  const dash = sandbox.__exports;

  function buildAccounts(records){
    const clients = {};
    records.forEach(r => { if(!clients[r.client]) clients[r.client] = []; clients[r.client].push(r); });
    const closedRevenueByClient = Object.values(clients).map(orders => dash.sumRevenue ? 0 : 0); // unused here
    const accounts = [];
    for(const clientName in clients){
      const allOrders = clients[clientName];
      const scoringOrders = allOrders.filter(o => o.date && o.category);
      const orderCount = scoringOrders.length;
      const categories = new Set(scoringOrders.map(o => o.category).filter(Boolean));
      const industry = sandbox.inferIndustry ? sandbox.inferIndustry(clientName, []) : '';
      const account = {
        name: clientName, industry: industry || 'Other', revenue: 0, orderCount,
        categoryTypes: categories, purchases: scoringOrders, allRecords: allOrders,
        subscores: { recency: 0.1, frequency: 0.4, diversity: 0.25 },
        mostRecentDate: scoringOrders.length ? scoringOrders[scoringOrders.length-1].date.toISOString().slice(0,10) : 'Unknown'
      };
      account.futureOpportunities = orderCount > 0 ? dash.generateFutureOpportunities(account) : [];
      accounts.push(account);
    }
    return accounts;
  }

  const csvText = readFileSync(new URL('./fixtures/repeat-order-follow-up-fixture.csv', import.meta.url), 'utf8');
  const records = dash.parseCSV(csvText);
  const accounts = buildAccounts(records);
  const allOpportunities = accounts.flatMap(a => a.futureOpportunities || []);
  const realPatternAccounts = new Set(
    allOpportunities.filter(o => o.opportunityType === 'REPEAT PATTERN').map(o => o.account)
  );
  assert(!realPatternAccounts.has('Meridian Office Partners'), `REQUIRED: Meridian Office Partners (one order, no detected cadence) never produces a real opportunityType 'REPEAT PATTERN' entry (got real-pattern accounts: ${JSON.stringify([...realPatternAccounts])})`);
  assert(realPatternAccounts.size === 5, `REQUIRED: exactly the 5 real detected patterns (Ridgeline, Lakeshore, Pinecrest, Golden Valley, Cascade) exist across the fixture, matching the founder's expected corrected count (got ${realPatternAccounts.size}: ${JSON.stringify([...realPatternAccounts])})`);

  const summary = dash.feedSummary(allOpportunities);
  const reorderCount = Number((summary.match(/(\d+) repeat buying patterns?/) || [])[1]);
  assert(reorderCount === 5, `REQUIRED: feedSummary()'s "N repeat buying patterns" count is exactly 5 (the real detected patterns), not 6 (which would still include Meridian's generic-fallback template) -- got "${summary}"`);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
