// QA BLOCKER diagnosis -- Repeat/Follow-Up signals not surfacing from the
// confirmed repeat-order-follow-up-fixture.csv in live founder QA (52
// monitored accounts, Business Activity research runs, dashboard summary
// shows "5 business triggers - 0 reorder opportunities - 0 follow-ups").
//
// The two pre-existing tests (test-repeat-order-follow-up-fixture.js,
// test-followup-repeat-pattern-persistence-roundtrip.js) each PASS today,
// but neither proves the actual live path: the first only proves the
// CLIENT computation (parseCSV -> generateFutureOpportunities) in isolation,
// never persisted or reloaded; the second only proves persistence/reload
// survives for a HAND-CONSTRUCTED opportunity object, never one produced by
// the real fixture CSV through the real detector. Neither closes the loop:
// CSV -> generateFutureOpportunities -> serializeAccountForStorage (client
// save) -> buildAccountsFromRows (real server reconciliation, imported
// directly, no DB) -> normalizeSavedAccount (client reload) -> feedSummary/
// opportunityMatchesTimebox (what the dashboard tab actually counts/shows).
//
// This test runs that full, real, unmocked chain end to end for the exact
// fixture CSV.
//
// Usage: node scripts/test-repeat-followup-live-pipeline-e2e.js
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

// Every real, verbatim function this test needs, spanning: CSV parsing,
// account-history detection (findRepeatPatternGroups/createRepeatPatternOpportunities/
// generateFutureOpportunities), classification (isWebResearchSignal/
// signalLayerLabel), client save serialization (serializeAccountForStorage),
// client reload hydration (normalizeSavedAccount), dedupe, timebox
// filtering, and the exact dashboard summary line builder (feedSummary).
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
  extractFn(DASHBOARD_SRC, 'clusterBusinessSignalOpportunities'),
  extractFn(DASHBOARD_SRC, 'mergeBusinessSignalInitiatives'),
  extractFn(DASHBOARD_SRC, 'dedupeOpportunities'),
  extractFn(DASHBOARD_SRC, 'dedupeFoundSignals'),
  extractFn(DASHBOARD_SRC, 'getOpportunityScore'),
  extractFn(DASHBOARD_SRC, 'buyingOpportunityIdentity'),
  extractFn(DASHBOARD_SRC, 'opportunityDedupeKey'),
  extractFn(DASHBOARD_SRC, 'collapseDuplicateAccountHistorySignals'),
  extractFn(DASHBOARD_SRC, 'pluralize'),
  extractFn(DASHBOARD_SRC, 'feedSummary'),
  extractFn(DASHBOARD_SRC, 'followUpCollapseKey'),
  extractRange(DASHBOARD_SRC, 'function collapseDuplicateFollowUps(opps){', 'function collapseDuplicateAccountHistorySignals(opps){'),
  extractFn(DASHBOARD_SRC, 'limitReasonsPerAccount'),
  extractRange(DASHBOARD_SRC, 'function isPriorityEligibleOpportunity(opp){', 'function priorityEligibleOpportunities(opps){'),
  extractRange(DASHBOARD_SRC, 'function prepareTimeboxReasons(opps, timebox=activeTimebox){', 'function prepareAllOpportunities(opps){'),
  extractFn(DASHBOARD_SRC, 'sortDailyReasons'),
  extractFn(DASHBOARD_SRC, 'getDailyReasonScore'),
  extractFn(DASHBOARD_SRC, 'hasConfirmedOrLegacyIdentity'),
  extractFn(DASHBOARD_SRC, 'hasCredibleActivationPlay'),
  extractFn(DASHBOARD_SRC, 'signalDateAndActionabilityLine')
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
  'opportunityDedupeKey', 'collapseDuplicateAccountHistorySignals', 'pluralize', 'feedSummary',
  'assignOpportunityScore', 'calculateOpportunityScore',
  'collapseDuplicateFollowUps', 'collapseDuplicateGenericRepeatSignals', 'genericRepeatCollapseKey',
  'limitReasonsPerAccount', 'isPriorityEligibleOpportunity', 'priorityEligibleOpportunities',
  'prepareTimeboxReasons', 'prepareAllOpportunities', 'prepareDailyReasons',
  'sortDailyReasons', 'getDailyReasonScore', 'hasConfirmedOrLegacyIdentity', 'hasCredibleActivationPlay',
  'signalDateAndActionabilityLine'
];

const sandbox = { window: {}, console };
vm.createContext(sandbox);
new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'live-pipeline-extract.js' }).runInContext(sandbox);
const dash = sandbox.__exports;
for(const name of EXPORT_NAMES){
  assert(typeof dash[name] === 'function', `dashboard/index.html export "${name}" extracted successfully as a real function`);
}

// ---------------------------------------------------------------------------
// Stage 1: CSV upload -> parseCSV -> processData()'s REAL account-grouping
// loop, copied field-for-field from dashboard/index.html's processData()
// (verified against the live source at scripts/lib source offset, read
// directly) INCLUDING the fields the older, narrower
// test-repeat-order-follow-up-fixture.js test omits (relationshipStrength,
// relationshipMode, signals, intelligenceMode, contacts) -- so this stage
// cannot mask a real defect the way an incomplete reimplementation could.
// ---------------------------------------------------------------------------
function buildAccountsLikeProcessData(records){
  const clients = {};
  records.forEach(record => {
    if(!clients[record.client]) clients[record.client] = [];
    clients[record.client].push(record);
  });
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
    const activePipelineValue = dash.sumRevenue(activePipeline);
    const orderCount = scoringOrders.length;
    const categories = new Set(scoringOrders.map(o => o.category).filter(Boolean));
    const projects = [...new Set(scoringOrders.map(o => o.project).filter(Boolean))];
    const allProjects = [...new Set(allOrders.map(o => o.project).filter(Boolean))];

    const now = new Date();
    const mostRecentDate = scoringOrders.filter(o => o.date).sort((a, b) => b.date - a.date)[0]?.date;
    const daysSinceLast = mostRecentDate ? Math.floor((now - mostRecentDate) / (1000 * 60 * 60 * 24)) : 999;

    const revScore = (totalRevenue - minRev) / revRange;
    const freqScore = Math.min(orderCount / 10, 1);
    const recencyScore = Math.max(1 - (daysSinceLast / 365), 0);
    const diversityScore = Math.min(categories.size / 4, 1);
    const totalScore = orderCount > 0 ? (revScore * 0.4 + freqScore * 0.2 + recencyScore * 0.25 + diversityScore * 0.15) : 0;
    const confidence = Math.min(totalScore * 100, 100);

    const uploadedIndustry = allOrders.find(o => o.uploadedIndustry)?.uploadedIndustry || '';
    const industry = uploadedIndustry || dash.inferIndustry(clientName, allProjects);
    const firstRecord = scoringOrders[0] || allOrders[0] || {};
    const contacts = dash.importedContactsFromRecords(allOrders);
    const intelligenceMode = dash.deriveAccountIntelligenceMode(allOrders);

    const account = {
      name: clientName, industry, revenue: totalRevenue, activePipelineValue, orderCount,
      activePipelineCount: activePipeline.length, confidence,
      subscores: { revenue: revScore, frequency: freqScore, recency: recencyScore, diversity: diversityScore },
      categoryTypes: categories, projects, allProjects,
      contactName: contacts[0]?.name || firstRecord.contactName || '',
      contactEmail: contacts[0]?.email || firstRecord.contactEmail || '',
      contactTitle: contacts[0]?.title || firstRecord.contactTitle || '',
      contactDepartment: contacts[0]?.department || firstRecord.contactDepartment || '',
      contactPhone: contacts[0]?.phone || firstRecord.contactPhone || '',
      contacts, website: allOrders.find(o => o.website)?.website || '',
      location: allOrders.find(o => o.location)?.location || '',
      assignedRep: allOrders.find(o => o.assignedRep)?.assignedRep || '',
      intelligenceMode, notes: allOrders.find(o => o.notes)?.notes || '',
      employees: allOrders.find(o => o.employees)?.employees || '',
      purchases: scoringOrders, activePipeline, allRecords: allOrders,
      mostRecentDate: mostRecentDate ? mostRecentDate.toLocaleDateString() : 'Unknown'
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
const uploadAccounts = buildAccountsLikeProcessData(records);
assert(uploadAccounts.length === 8, `stage 1: fixture produces exactly 8 accounts from the real processData()-equivalent grouping (got ${uploadAccounts.length})`);

const ridgelineAtUpload = uploadAccounts.find(a => a.name === 'Ridgeline Auto Group');
const ridgelinePatternAtUpload = (ridgelineAtUpload.futureOpportunities || []).find(o => o.opportunityType === 'REPEAT PATTERN');
assert(!!ridgelinePatternAtUpload, `stage 1 sanity: Ridgeline's REPEAT PATTERN opportunity exists immediately after CSV upload, before any save (got ${JSON.stringify((ridgelineAtUpload.futureOpportunities||[]).map(o=>o.opportunityType))})`);

const brightviewAtUpload = uploadAccounts.find(a => a.name === 'Brightview Dental Group');
const brightviewFollowUpAtUpload = (brightviewAtUpload.futureOpportunities || []).find(o => o.signalLayerType === 'Follow-Up Signal');
assert(!!brightviewFollowUpAtUpload, 'stage 1 sanity: Brightview\'s Follow-Up Signal opportunity exists immediately after CSV upload, before any save');

// ---------------------------------------------------------------------------
// Stage 2: the client's FIRST save (stage='uploaded', the exact save
// performCurrentUpload() fires right after processData()) -- serializes
// account.futureOpportunities into raw_data.repeatPatterns/existingSignals
// via the real serializeAccountForStorage(). uploadId assigned as the
// server would once the upload row exists (ROUND 13 field).
// ---------------------------------------------------------------------------
uploadAccounts.forEach(a => { a.uploadId = 'upload-fixture-1'; (a.futureOpportunities||[]).forEach(o => { o.uploadId = a.uploadId; }); });
const savedPayloads = uploadAccounts.map(a => dash.serializeAccountForStorage(a, { includeSignals: false }));

const ridgelineSaved = savedPayloads.find(p => p.name === 'Ridgeline Auto Group');
assert(Array.isArray(ridgelineSaved.rawData.repeatPatterns) && ridgelineSaved.rawData.repeatPatterns.some(o => o.opportunityType === 'REPEAT PATTERN' && /headwear/i.test(o.opportunity || '')), `stage 2: Ridgeline's raw_data.repeatPatterns carries the real Headwear REPEAT PATTERN entry on the very first (stage='uploaded') save (got ${JSON.stringify(ridgelineSaved.rawData.repeatPatterns.map(o=>o.opportunityType))})`);
const brightviewSaved = savedPayloads.find(p => p.name === 'Brightview Dental Group');
assert(Array.isArray(brightviewSaved.rawData.existingSignals) && brightviewSaved.rawData.existingSignals.some(o => o.signalLayerType === 'Follow-Up Signal'), `stage 2: Brightview's raw_data.existingSignals carries its Follow-Up Signal on the very first save (got ${JSON.stringify(brightviewSaved.rawData.existingSignals.map(o=>o.signalLayerType))})`);

// ---------------------------------------------------------------------------
// Stage 3: what api/save-upload.js actually persists -- raw_data is the
// client's rawData verbatim, no server-side transform (confirmed by reading
// api/save-upload.js lines ~554/728: `raw_data: a.rawData || {}`). Simulated
// here as plain DB rows, exactly the shape buildAccountsFromRows() (the
// live GET /api/get-dashboard handler's core, imported directly -- REAL
// code, not mocked) expects to read back.
// ---------------------------------------------------------------------------
const accountRows = savedPayloads.map((p, i) => ({
  id: `acct-${i}`, account_name: p.name, upload_id: 'upload-fixture-1', industry: p.industry,
  contact_name: p.contactName, contact_email: p.contactEmail, metrics: p.metrics,
  raw_data: p.rawData, created_at: new Date('2026-08-01').toISOString(), updated_at: new Date('2026-08-01').toISOString()
}));

// No ha_signals rows for these 8 accounts -- Business Activity research (the
// founder's separate "5 business triggers") is out of scope for THIS
// fixture; the point under test is repeat/follow-up survival, which must
// hold with zero live signal rows.
const serverAccounts = buildAccountsFromRows(accountRows, []).accountList;
const ridgelineServer = serverAccounts.find(a => a.name === 'Ridgeline Auto Group');
assert(!!ridgelineServer, 'stage 3: Ridgeline survives the real server-side buildAccountsFromRows() reconciliation');
console.log(`  (stage 3 debug) Ridgeline server-side futureOpportunities: ${JSON.stringify((ridgelineServer.futureOpportunities||[]).map(o=>({signalLayerType:o.signalLayerType, opportunityType:o.opportunityType})))}`);
const brightviewServer = serverAccounts.find(a => a.name === 'Brightview Dental Group');
console.log(`  (stage 3 debug) Brightview server-side futureOpportunities: ${JSON.stringify((brightviewServer.futureOpportunities||[]).map(o=>({signalLayerType:o.signalLayerType, opportunityType:o.opportunityType})))}`);

// ---------------------------------------------------------------------------
// Stage 4: the client's reload -- exactly what happens on a dashboard
// refresh / after Research All triggers get-dashboard.js, via the real
// normalizeSavedAccount().
// ---------------------------------------------------------------------------
const reloadedAccounts = serverAccounts.map(dash.normalizeSavedAccount);
const ridgelineReloaded = reloadedAccounts.find(a => a.name === 'Ridgeline Auto Group');
const ridgelinePatternReloaded = (ridgelineReloaded.futureOpportunities || []).find(o => o.signalLayerType === 'Repeat / Pattern Signal');
assert(!!ridgelinePatternReloaded, `REQUIRED: Ridgeline's Repeat/Pattern Signal survives the full upload -> save -> server reconciliation -> reload cycle (got ${JSON.stringify((ridgelineReloaded.futureOpportunities||[]).map(o=>o.signalLayerType))})`);
assert(ridgelinePatternReloaded && ridgelinePatternReloaded.opportunityType === 'REPEAT PATTERN', `REQUIRED: the reloaded Ridgeline opportunity still carries opportunityType 'REPEAT PATTERN' (not corrupted by server-side reconcileStoredOpportunity()) (got "${ridgelinePatternReloaded && ridgelinePatternReloaded.opportunityType}")`);
assert(ridgelinePatternReloaded && ridgelinePatternReloaded.actionabilityStatus === undefined, `REQUIRED: the reloaded Ridgeline opportunity carries no fabricated actionabilityStatus (order-history opportunities are judged by recency, not an event date) (got ${JSON.stringify(ridgelinePatternReloaded && ridgelinePatternReloaded.actionabilityStatus)})`);

const brightviewReloaded = reloadedAccounts.find(a => a.name === 'Brightview Dental Group');
const brightviewFollowUpReloaded = (brightviewReloaded.futureOpportunities || []).find(o => o.signalLayerType === 'Follow-Up Signal');
assert(!!brightviewFollowUpReloaded, `REQUIRED: Brightview's Follow-Up Signal survives the full upload -> save -> server reconciliation -> reload cycle (got ${JSON.stringify((brightviewReloaded.futureOpportunities||[]).map(o=>o.signalLayerType))})`);

// ---------------------------------------------------------------------------
// Stage 5: exactly what renderWeeklyPrioritiesFeed()/feedSummary() show on
// the dashboard's default "This Week" tab -- the literal counts the founder
// reported as "0 reorder opportunities - 0 follow-ups". This is
// prepareAllOpportunities()/prepareTimeboxReasons(), the REAL functions
// renderWeeklyPrioritiesFeed() calls (dashboard/index.html line ~10768-10769)
// -- not a raw dedupeOpportunities()/opportunityMatchesTimebox() filter like
// the earlier draft of this test used, which skipped the
// collapseDuplicateAccountHistorySignals()+priorityEligibleOpportunities()
// gate the real render path always applies first.
// ---------------------------------------------------------------------------
const allOppsRaw = dash.dedupeOpportunities(reloadedAccounts.flatMap(a => a.futureOpportunities || []));
const allOpportunities = dash.prepareAllOpportunities(allOppsRaw).filter(o => dash.opportunityMatchesTimebox(o, 'week'));
const weekOpportunities = dash.prepareTimeboxReasons(allOppsRaw, 'week');
const monthOpportunities = dash.prepareTimeboxReasons(allOppsRaw, 'month');
console.log(`  (stage 5 debug) week tab: ${JSON.stringify(weekOpportunities.map(o=>`${o.account}/${o.signalLayerType}`))}`);
console.log(`  (stage 5 debug) month tab: ${JSON.stringify(monthOpportunities.map(o=>`${o.account}/${o.signalLayerType}`))}`);
console.log(`  (stage 5 debug) week feedSummary: "${dash.feedSummary(weekOpportunities)}"`);
console.log(`  (stage 5 debug) month feedSummary: "${dash.feedSummary(monthOpportunities)}"`);

assert(weekOpportunities.some(o => o.account === 'Ridgeline Auto Group' && o.signalLayerType === 'Repeat / Pattern Signal'), 'REQUIRED (scenario 1): Ridgeline\'s annual Headwear reorder opportunity is present in the "This Week" tab after the full live-shaped round trip');
assert(weekOpportunities.some(o => o.account === 'Brightview Dental Group' && o.signalLayerType === 'Follow-Up Signal'), 'REQUIRED (scenario 3): Brightview\'s follow-up opportunity is present in the "This Week" tab after the full live-shaped round trip');
assert(monthOpportunities.some(o => o.account === 'Lakeshore Manufacturing Co' && o.signalLayerType === 'Repeat / Pattern Signal'), 'REQUIRED (scenario 2): Lakeshore\'s seasonal reorder opportunity is present in the "This Month" tab after the full live-shaped round trip');

const weekSummary = dash.feedSummary(weekOpportunities);
assert(!/0 reorder opportunit/.test(weekSummary), `REQUIRED: the "This Week" dashboard summary line does not read "0 reorder opportunities" (got "${weekSummary}")`);
assert(!/0 follow-up/.test(weekSummary), `REQUIRED: the "This Week" dashboard summary line does not read "0 follow-ups" (got "${weekSummary}")`);

// ---------------------------------------------------------------------------
// Control cases: stale/no-history accounts remain exactly as suppressed as
// the existing fixture test already proved at the pure-detector layer --
// this proves that suppression ALSO survives the full persisted round trip,
// not just the in-memory computation.
// ---------------------------------------------------------------------------
const vantageReloaded = reloadedAccounts.find(a => a.name === 'Vantage Analytics Group');
assert(vantageReloaded.futureOpportunities.length === 0, `control: Vantage Analytics Group (no order history) still has 0 opportunities after the full round trip (got ${vantageReloaded.futureOpportunities.length})`);

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
