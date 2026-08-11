// Founder Preview QA round 4 (post-0450b72) -- "regression passes, live UI
// still fails" was called out explicitly. Every test below exercises the
// SAME object shapes and the SAME real, verbatim render functions the
// actual dashboard/PFC path uses, through the REAL sequence: parse ->
// account-build (processData()-equivalent, uploadId genuinely unset, no
// test-only shortcut) -> serialize -> server round trip
// (buildAccountsFromRows, real code, imported directly) -> hydrate
// (normalizeSavedAccount) -> aggregate (a mixed window.accountRadarAccounts
// containing a stale duplicate upload, exactly like a repeatedly-re-uploaded
// QA fixture produces) -> dedupe -> the REAL render functions
// (renderAccountContextSection, additionalOpportunitiesFor, getSuggestedOpener,
// opportunityHeadline).
//
// Root causes closed this round:
//   1. performSaveCurrentUpload()'s uploadId backfill (added in the prior
//      round) only touched the ACCOUNT object, never its OWN
//      futureOpportunities -- createOpportunity() bakes opp.uploadId in
//      PERMANENTLY at creation time, when account.uploadId is still unset
//      (the very first save is still in flight). findAccountForOpp()/
//      accountOpportunityCluster()'s (uploadId, name) scoped match (added
//      the prior round) can only activate when opp.uploadId is truthy --
//      with it silently staying '' forever, that fix never actually
//      engaged, and a same-named account from an OLDER upload could still
//      be resolved instead of the current one. This is also the most
//      likely explanation for the "clean" primary/additional duplicate:
//      accountOpportunityCluster() building its list from the WRONG
//      upload's account.futureOpportunities in the first place.
//   2. Meridian: createOpportunity() assigned the "Repeat / Pattern Signal"
//      family to ANY generic industry-fallback template with low recency,
//      with no check on whether the account even has the 2+ purchase
//      records findRepeatPatternGroups() itself requires before a repeat
//      cadence is even possible. Now always Follow-Up family below that
//      minimum, regardless of recency -- the classification/generation
//      root cause, not just the label or the count.
//   3. Purchase-record vs order terminology: Account Context's "Previous
//      orders ... N orders on file" claimed a fact (distinct order count)
//      the imported CSV (no order/invoice/PO identifier) cannot support.
//
// Usage: node scripts/test-live-qa-round4-corrections.js
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

const sandbox = { window: {}, console };
vm.createContext(sandbox);
new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'round4-extract.js' }).runInContext(sandbox);
const dash = sandbox.__exports;
for(const name of EXPORT_NAMES){
  assert(typeof dash[name] === 'function', `dashboard/index.html export "${name}" extracted successfully as a real function`);
}

// ---------------------------------------------------------------------------
// The real processData()-equivalent account-build loop -- uploadId is
// genuinely NOT set on the account or any of its opportunities at this
// point, exactly like the live page (the server hasn't returned one yet).
// No test-only shortcut patches this in -- that gap is the entire point
// under test.
// ---------------------------------------------------------------------------
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
      // Deliberately NO uploadId field -- matches the real account object
      // processData() constructs, which has none until the first save
      // resolves.
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

const freshRidgeline = freshAccounts.find(a => a.name === 'Ridgeline Auto Group');
assert(!freshRidgeline.uploadId, 'sanity: the freshly-parsed account genuinely has no uploadId yet, matching the real pre-first-save state');
assert((freshRidgeline.futureOpportunities[0]?.uploadId || '') === '', `sanity: its opportunities genuinely have no uploadId baked in either at this point (got "${freshRidgeline.futureOpportunities[0]?.uploadId}")`);

// ---------------------------------------------------------------------------
// Item 1: the real backfill -- performSaveCurrentUpload()'s fixed
// assignment, applied verbatim (account AND its own futureOpportunities),
// exactly as it runs the instant the first "uploaded"-stage save resolves.
// ---------------------------------------------------------------------------
const REAL_UPLOAD_ID = 'upload-fixture-fresh';
freshAccounts.forEach(a => {
  a.uploadId = a.uploadId || REAL_UPLOAD_ID;
  (a.futureOpportunities || []).forEach(opp => { opp.uploadId = opp.uploadId || REAL_UPLOAD_ID; });
});
assert(freshRidgeline.futureOpportunities.every(o => o.uploadId === REAL_UPLOAD_ID), `REQUIRED: every opportunity on the freshly-uploaded account now carries the real uploadId after the fixed backfill (got ${JSON.stringify(freshRidgeline.futureOpportunities.map(o=>o.uploadId))})`);

// Full save -> server round trip -> reload, for the fresh upload.
const freshRows = freshAccounts.map((a, i) => ({
  id: `fresh-${i}`, account_name: a.name, upload_id: REAL_UPLOAD_ID, industry: a.industry,
  contact_name: a.contactName, contact_email: a.contactEmail,
  metrics: dash.serializeAccountForStorage(a, {includeSignals:false}).metrics,
  raw_data: dash.serializeAccountForStorage(a, {includeSignals:false}).rawData,
  created_at: new Date('2026-08-11').toISOString(), updated_at: new Date('2026-08-11').toISOString()
}));

// A STALE duplicate upload of the SAME fixture, made earlier in this QA
// cycle, before any of these fixes existed -- its opportunities carry
// uploadId:'' (the pre-fix, permanently-empty shape) and a stale,
// one-day-shifted mostRecentDate (the pre-fix calendar-day bug's own
// output), exactly like a real leftover pre-fix upload still sitting in
// the workspace.
const staleAccounts = buildAccountsLikeProcessData(records);
const staleRidgeline = staleAccounts.find(a => a.name === 'Ridgeline Auto Group');
staleRidgeline.mostRecentDate = '2025-08-13'; // pre-fix shifted value
staleRidgeline.futureOpportunities.forEach(o => { o.uploadId = ''; o.mostRecentDate = '2025-08-13'; if(o.signalDate) o.signalDate = '2025-08-13'; });
const STALE_UPLOAD_ID = 'upload-fixture-stale';
const staleRows = staleAccounts.map((a, i) => ({
  id: `stale-${i}`, account_name: a.name, upload_id: STALE_UPLOAD_ID, industry: a.industry,
  contact_name: a.contactName, contact_email: a.contactEmail,
  metrics: { ...dash.serializeAccountForStorage(a, {includeSignals:false}).metrics, mostRecentDate: a.mostRecentDate },
  raw_data: dash.serializeAccountForStorage(a, {includeSignals:false}).rawData,
  created_at: new Date('2026-08-01').toISOString(), updated_at: new Date('2026-08-01').toISOString()
}));

const serverAccounts = buildAccountsFromRows([...staleRows, ...freshRows], []).accountList;
const reloadedAccounts = serverAccounts.map(dash.normalizeSavedAccount);
sandbox.window.accountRadarAccounts = reloadedAccounts;

const reloadedFreshRidgeline = reloadedAccounts.find(a => a.uploadId === REAL_UPLOAD_ID && a.name === 'Ridgeline Auto Group');
const primaryOpp = reloadedFreshRidgeline.futureOpportunities.find(o => o.opportunityType === 'REPEAT PATTERN');
assert(!!primaryOpp, 'sanity: the fresh upload\'s real Ridgeline Repeat/Pattern opportunity survives the full round trip');
assert(primaryOpp.uploadId === REAL_UPLOAD_ID, `REQUIRED: the primary opportunity used to render Account Context carries the FRESH upload's uploadId, not empty/stale (got "${primaryOpp.uploadId}")`);

// ===========================================================================
// Item 1 (calendar-day): renderAccountContextSection() -- the REAL render
// function -- must show the FRESH, correct date, never the stale
// duplicate's, even though BOTH "Ridgeline Auto Group" entries are present
// in window.accountRadarAccounts simultaneously.
// ===========================================================================
{
  const html = dash.renderAccountContextSection(primaryOpp);
  assert(/Aug 14, 2025/.test(html), `REQUIRED: Account Context (the real renderAccountContextSection()) shows "Aug 14, 2025" for Ridgeline's real order, never the stale duplicate upload's "Aug 13, 2025" (got: ${html})`);
  assert(!/Aug 13, 2025/.test(html), `REQUIRED: Account Context never shows the stale duplicate's shifted date (got: ${html})`);
}

// ===========================================================================
// Item 2 (primary/additional duplicate): additionalOpportunitiesFor() --
// the REAL function the Prepare for Call panel calls -- must never return
// the primary opportunity itself, using the SAME mixed aggregate (stale +
// fresh duplicate uploads both present) as the calendar-day case above.
// ===========================================================================
{
  const additional = dash.additionalOpportunitiesFor(primaryOpp);
  const selfDuplicate = additional.find(o => o.opportunity === primaryOpp.opportunity && o.account === primaryOpp.account && dash.opportunityHeadline(o) === dash.opportunityHeadline(primaryOpp));
  assert(!selfDuplicate, `REQUIRED: additionalOpportunitiesFor() never returns the primary Ridgeline Repeat/Pattern opportunity as its own Additional Opportunity (got ${additional.length} additional item(s): ${JSON.stringify(additional.map(o=>({account:o.account, opportunity:o.opportunity, uploadId:o.uploadId})))})`);
}

// ===========================================================================
// Item 3 (Meridian generation root cause): the REAL generateFutureOpportunities()
// output for Meridian must never carry the Repeat/Pattern family at all --
// checked on signalLayerType directly (the generation-time root cause), not
// just opportunityType or the summary count.
// ===========================================================================
{
  const meridian = freshAccounts.find(a => a.name === 'Meridian Office Partners');
  assert(meridian.orderCount === 1, `sanity: Meridian has exactly 1 purchase record (got ${meridian.orderCount})`);
  const meridianOpps = meridian.futureOpportunities;
  assert(meridianOpps.every(o => o.signalLayerType !== 'Repeat / Pattern Signal'), `REQUIRED (generation root cause): none of Meridian's generated opportunities carry signalLayerType 'Repeat / Pattern Signal' -- a single purchase record cannot support a repeat-cadence claim (got ${JSON.stringify(meridianOpps.map(o=>o.signalLayerType))})`);
  assert(meridianOpps.every(o => o.opportunityType !== 'REPEAT PATTERN'), 'REQUIRED: none of Meridian\'s opportunities carry opportunityType \'REPEAT PATTERN\' either');
  meridianOpps.forEach(o => {
    const headline = dash.opportunityHeadline(o);
    assert(headline !== 'Repeat buying window detected', `REQUIRED: no Meridian opportunity renders the "Repeat buying window detected" headline (got "${headline}" for "${o.opportunity}")`);
    assert(!/repeat|seasonal buying pattern/i.test(o.reasonToReachOut || ''), `REQUIRED: no Meridian opportunity's reasonToReachOut claims a repeat/seasonal pattern (got "${o.reasonToReachOut}" for "${o.opportunity}")`);
  });
}

// ===========================================================================
// Item 4: purchase-record terminology -- the real renderAccountContextSection()
// output for a multi-row account never claims "orders on file."
// ===========================================================================
{
  const html = dash.renderAccountContextSection(primaryOpp);
  assert(/purchase records? on file/.test(html), `REQUIRED: Account Context describes imported rows as "purchase record(s)," not "orders" (got: ${html})`);
  assert(!/\d+ orders? on file/.test(html), `REQUIRED: Account Context never claims "N orders on file" (got: ${html})`);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
