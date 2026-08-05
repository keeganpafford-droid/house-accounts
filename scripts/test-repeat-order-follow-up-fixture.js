// Commercial-readiness core validation, item 2: repeat-order, pattern, and
// follow-up signal validation against a realistic historical-order CSV.
//
// This test does NOT reimplement any signal-generation logic. It extracts
// the REAL, verbatim source of the relevant dashboard/index.html functions
// (CSV parsing/normalization, order-history filtering, repeat-pattern
// detection, opportunity generation, signal-layer classification, and
// timebox/planning-window classification) by exact line range -- each
// range is defensively checked against its expected first/last line so a
// future edit to dashboard/index.html that shifts these functions fails
// this test loudly instead of silently testing stale code -- and runs
// them in a vm sandbox against scripts/fixtures/repeat-order-follow-up-fixture.csv,
// the same file format and columns a real customer upload would use.
//
// What is deliberately OUT of scope (and why):
//   - Rendering/DOM functions (renderWeeklyPrioritiesFeed, processData's
//     document.getElementById calls, etc.) are not exercised -- they only
//     paint the DOM from data these functions already produced, and pulling
//     them in would require mocking a browser document for no additional
//     signal-generation proof.
//   - The cross-source business-activity MERGE/dedupe pipeline
//     (mergeBusinessSignalInitiatives, dedupeOpportunities) is not
//     exercised -- it depends on the research-batch.js signal pipeline
//     (external providers), which this branch is not permitted to run.
//     Distinctness between a Business Activity Signal and a local
//     repeat/follow-up signal is proven at the classification level
//     (signalLayerLabel/isBusinessOpportunity), which is the layer that
//     decides which bucket an opportunity belongs to before any merge
//     logic would ever see it.
//
// Usage: node scripts/test-repeat-order-follow-up-fixture.js
import { readFileSync } from 'fs';
import vm from 'vm';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const lines = html.split('\n');

function extractLines(label, startLine, endLine, expectedFirst, expectedLast){
  const slice = lines.slice(startLine - 1, endLine);
  const first = slice[0].trim();
  const last = slice[slice.length - 1].trim();
  if(!first.startsWith(expectedFirst)){
    throw new Error(`extractLines(${label}): dashboard/index.html line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  if(last !== expectedLast){
    throw new Error(`extractLines(${label}): dashboard/index.html line ${endLine} is "${last}", expected "${expectedLast}" -- source has shifted, update the line range in this test.`);
  }
  return slice.join('\n');
}

const SRC = [
  extractLines('timebox-config', 2388, 2393, 'const TIMEBOX_CONFIG = {', '};'),
  extractLines('opportunity-identity-helpers', 2529, 2614, 'function cleanOpportunityToken(value){', '}'),
  extractLines('is-business-opportunity', 2945, 2947, 'function isBusinessOpportunity(opp){', '}'),
  extractLines('signal-layer-label', 3595, 3605, 'function signalLayerLabel(opp){', '}'),
  extractLines('is-likely-invalid-account-name', 3579, 3586, 'function isLikelyInvalidAccountName(name){', '}'),
  extractLines('parse-csv', 3352, 3470, 'function parseCSV(text){', '}'),
  extractLines('infer-promo-category', 3472, 3492, 'function inferPromoCategory(text){', '}'),
  extractLines('infer-industry', 3494, 3502, 'function inferIndustry(client, projects){', '}'),
  extractLines('opportunity-generation', 5629, 6125, 'function estimateFutureValue(account, opportunityType){', '}'),
  extractLines('order-history-filters', 6738, 6766, 'function isClosedHistoricalRecord(record){', '}'),
  extractLines('normalize-signal-layer-type', 6785, 6800, 'function normalizeSignalLayerType(type){', '}'),
  extractLines('recommendation-type', 6803, 6852, 'function daysSinceDate(value){', '}'),
  extractLines('opportunity-scoring', 6904, 6975, 'function calculateOpportunityScore(opp){', '}'),
  extractLines('timebox-classification', 7065, 7121, 'function monthIndexFromName(name){', '}')
].join('\n\n');

const EXPORT_NAMES = [
  'parseCSV', 'inferPromoCategory', 'inferIndustry', 'isLikelyInvalidAccountName',
  'isClosedHistoricalRecord', 'isActivePipelineRecord', 'hasOrderHistoryEvidence', 'sumRevenue',
  'findRepeatPatternGroups', 'createRepeatPatternOpportunities', 'categoryToPromoSuggestions',
  'generateFutureOpportunities', 'createOpportunity',
  'signalLayerLabel', 'isBusinessOpportunity', 'isRecentAccountActivity',
  'getRecommendationType', 'getOpportunityPlanningWindow', 'opportunityMatchesTimebox',
  'classifyMonthWindow', 'monthDistanceFromNow', 'inferPurchaseMonth'
];

const sandbox = {};
vm.createContext(sandbox);
new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'dashboard-extract.js' }).runInContext(sandbox);
const dash = sandbox.__exports;
for(const name of EXPORT_NAMES){
  assert(typeof dash[name] === 'function', `dashboard/index.html export "${name}" extracted successfully as a real function`);
}

// ---------------------------------------------------------------------------
// Replicates processData()'s account-grouping loop (grouping raw CSV
// records by client, computing purchases/orderCount/subscores), WITHOUT the
// DOM rendering calls processData() itself makes (document.getElementById,
// saveCurrentUpload, etc.) -- those paint the page from data this loop
// already produced and add no additional signal-generation proof. Every
// filtering/scoring formula below is copied verbatim from
// dashboard/index.html's processData() (read directly, line ~7670) so the
// account shape fed into the REAL generateFutureOpportunities() matches
// production exactly.
function buildAccounts(records){
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

    const account = {
      name: clientName,
      industry,
      revenue: totalRevenue,
      activePipelineValue,
      orderCount,
      activePipelineCount: activePipeline.length,
      confidence,
      subscores: { revenue: revScore, frequency: freqScore, recency: recencyScore, diversity: diversityScore },
      categoryTypes: categories,
      contactName: allOrders.find(o => o.contactName)?.contactName || '',
      contactEmail: allOrders.find(o => o.contactEmail)?.contactEmail || '',
      purchases: scoringOrders,
      activePipeline,
      allRecords: allOrders,
      signals: [],
      mostRecentDate: mostRecentDate ? mostRecentDate.toLocaleDateString() : 'Unknown'
    };
    account.futureOpportunities = orderCount > 0 ? dash.generateFutureOpportunities(account) : [];
    accounts.push(account);
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// Real CSV, real fields, real production parseCSV().
// ---------------------------------------------------------------------------
const csvText = readFileSync(new URL('./fixtures/repeat-order-follow-up-fixture.csv', import.meta.url), 'utf8');
const records = dash.parseCSV(csvText);
assert(records.length === 17, `fixture parses to 17 raw CSV rows across 8 accounts (got ${records.length})`);
assert(Array.isArray(records) && records.every(r => 'client' in r && 'category' in r && 'date' in r), 'every parsed record has the real client/category/date shape parseCSV() produces');

const accounts = buildAccounts(records);
assert(accounts.length === 8, `fixture produces exactly 8 accounts (got ${accounts.length})`);
const byName = Object.fromEntries(accounts.map(a => [a.name, a]));

const TODAY = new Date();
console.log(`\n(Test run date: ${TODAY.toISOString().slice(0,10)} -- planning-window assertions below are relative to this date, matching how a rep would see the dashboard today.)\n`);

// ===========================================================================
// Scenario 1: Ridgeline Auto Group -- annual reorder approaching its
// expected window (3 years of August Headwear orders; the most recent
// order is split across 2 CSV rows, proving that does not create 2
// opportunities).
// ===========================================================================
{
  const a = byName['Ridgeline Auto Group'];
  assert(!!a, 'Ridgeline Auto Group (scenario 1: annual reorder) exists as an account');
  assert(a.orderCount === 4, `Ridgeline Auto Group has 4 qualifying purchase rows (3 order dates, 1 split across 2 line items) (got ${a.orderCount})`);
  const patterns = dash.findRepeatPatternGroups(a);
  assert(patterns.length === 1 && patterns[0].category === 'Headwear', `findRepeatPatternGroups detects exactly one real Headwear pattern from actual order history (got: ${JSON.stringify(patterns.map(p=>p.category))})`);
  assert(patterns[0].years.length === 3, `the Headwear pattern spans all 3 real purchase years (got ${patterns[0].years.length})`);

  const patternOpps = a.futureOpportunities.filter(o => o.opportunityType === 'REPEAT PATTERN');
  assert(patternOpps.length === 1, `scenario 1 required proof (no duplicate opportunities from multiple rows of one order): exactly ONE Repeat/Pattern opportunity is generated for Headwear, not one per CSV row (got ${patternOpps.length})`);
  const opp = patternOpps[0];
  assert(opp.signalLayerType === 'Repeat / Pattern Signal', `the Headwear opportunity is labeled "Repeat / Pattern Signal" (got "${opp.signalLayerType}")`);
  assert(/ordered headwear \d+ times/i.test(opp.whyNow), `signal wording clearly states the order pattern (got: "${opp.whyNow}")`);
  assert(/across 3 years/.test(opp.whyNow), `signal wording states the real multi-year span (got: "${opp.whyNow}")`);
  const recType = dash.getRecommendationType(opp);
  assert(recType === 'Annual Buying Pattern', `scenario 1 required proof (annual reorder recognized): recommendation type is "Annual Buying Pattern" (got "${recType}")`);
  const window = dash.getOpportunityPlanningWindow(opp);
  assert(window === 'week', `scenario 1 required proof (approaching its expected window): the account's typical August reorder month matches the current month, so it lands in the "This Week" planning window (got "${window}")`);
  assert(dash.opportunityMatchesTimebox(opp, 'week') === true, 'the annual-reorder opportunity is included in the "This Week" timeframe filter');
  assert(opp.commonPromoCategories.every(c => !a.purchases.some(p => p.category === c)), `scenario 1 required proof (category provenance): inferred product suggestions (${JSON.stringify(opp.commonPromoCategories)}) never duplicate an actual prior-purchase category label`);
}

// ===========================================================================
// Scenario 2: Lakeshore Manufacturing Co -- seasonal reorder approaching
// its expected window, one month out rather than this week (distinguishing
// "seasonal, upcoming" from scenario 1's "annual, due this week").
// ===========================================================================
{
  const a = byName['Lakeshore Manufacturing Co'];
  assert(!!a, 'Lakeshore Manufacturing Co (scenario 2: seasonal reorder) exists as an account');
  const patterns = dash.findRepeatPatternGroups(a);
  assert(patterns.length === 1 && patterns[0].category === 'Recognition / Awards', `findRepeatPatternGroups detects the September Recognition/Awards pattern (got: ${JSON.stringify(patterns.map(p=>p.category))})`);
  const opp = a.futureOpportunities.find(o => o.opportunityType === 'REPEAT PATTERN');
  assert(!!opp, 'a REPEAT PATTERN opportunity is generated for the seasonal pattern');
  assert(opp.signalLayerType === 'Repeat / Pattern Signal', 'the seasonal opportunity is labeled "Repeat / Pattern Signal"');
  const window = dash.getOpportunityPlanningWindow(opp);
  assert(window === 'month', `scenario 2 required proof (seasonal reorder approaching its window, distinct from scenario 1's immediate week): September is one month out from the test-run month, landing in the "This Month" window (got "${window}")`);
  assert(dash.opportunityMatchesTimebox(opp, 'month') === true && dash.opportunityMatchesTimebox(opp, 'week') === false, 'the seasonal opportunity matches the Month timeframe filter and correctly does NOT match the Week filter');
}

// ===========================================================================
// Scenario 3: Brightview Dental Group -- a recently fulfilled order that
// needs a post-delivery follow-up (not a repeat pattern: only 1 order).
// ===========================================================================
{
  const a = byName['Brightview Dental Group'];
  assert(!!a, 'Brightview Dental Group (scenario 3: follow-up) exists as an account');
  assert(a.orderCount === 1, `Brightview Dental Group has exactly 1 qualifying order, so no repeat pattern can exist (got ${a.orderCount})`);
  const patterns = dash.findRepeatPatternGroups(a);
  assert(patterns.length === 0, 'scenario 3 required proof (follow-up distinct from repeat): findRepeatPatternGroups correctly finds no pattern for a single order');
  assert(a.futureOpportunities.every(o => o.opportunityType !== 'REPEAT PATTERN'), 'no opportunity for this account is tagged opportunityType REPEAT PATTERN');
  const followUps = a.futureOpportunities.filter(o => o.signalLayerType === 'Follow-Up Signal');
  assert(followUps.length > 0, `scenario 3 required proof (recent fulfilled order recognized as a follow-up): at least one opportunity is labeled "Follow-Up Signal" (got ${a.futureOpportunities.map(o=>o.signalLayerType).join(', ')})`);
  const recType = dash.getRecommendationType(followUps[0]);
  assert(recType === 'Recent Project Follow-Up', `the follow-up opportunity's recommendation type is "Recent Project Follow-Up" (got "${recType}")`);
  const window = dash.getOpportunityPlanningWindow(followUps[0]);
  assert(window === 'week', `a 12-day-old fulfilled order lands in the "This Week" follow-up window (got "${window}")`);
}

// ===========================================================================
// Scenario 4: Pinecrest Financial Advisors -- a lapsed customer that has
// missed its normal (March) reorder timing; today's test-run date is well
// past that window.
// ===========================================================================
{
  const a = byName['Pinecrest Financial Advisors'];
  assert(!!a, 'Pinecrest Financial Advisors (scenario 4: lapsed) exists as an account');
  const patterns = dash.findRepeatPatternGroups(a);
  assert(patterns.length === 1 && patterns[0].category === 'Event / Giveaway', `scenario 4 required proof (historical cadence recognized even though lapsed): findRepeatPatternGroups still detects the real March Event/Giveaway pattern from 2 years of history (got: ${JSON.stringify(patterns.map(p=>p.category))})`);
  const daysSinceLastOrder = Math.floor((TODAY - patterns[0].lastDate) / 86400000);
  assert(daysSinceLastOrder > 365, `the account's last real order is over a year old, confirming it is genuinely lapsed (got ${daysSinceLastOrder} days)`);
  assert(a.subscores.recency < 0.55, `the account's computed recency score is low enough that generic templates classify it as Repeat/Pattern rather than Follow-Up, consistent with being lapsed (got ${a.subscores.recency.toFixed(3)})`);
  const opp = a.futureOpportunities.find(o => o.opportunityType === 'REPEAT PATTERN');
  const window = dash.getOpportunityPlanningWindow(opp);
  console.log(`NOTE (scenario 4, lapsed-timing limitation -- reported per task instructions, not fixed in this branch): getOpportunityPlanningWindow() classifies purely by month-distance-from-now modulo 12, with no concept of "overdue." Pinecrest's March pattern, now ${daysSinceLastOrder} days overdue, lands in planning window "${window}" -- the same bucket a not-yet-due March pattern would occupy from the opposite direction. The underlying cadence IS correctly detected (assertion above); surfacing "overdue" as more urgent than "upcoming" is a planning-window capability this branch does not add, per the instruction to report missing capabilities rather than expand scope.`);
  assert(typeof window === 'string' && !!window, 'lapsed timing is recognized to the extent currently supported: a planning window is still assigned rather than the opportunity being dropped');
}

// ===========================================================================
// Scenario 5: Golden Valley Steel Supply -- multiple orders in the same
// real product/category pattern, driven by volume rather than seasonal
// clustering or multi-year spread (a distinct detection path within
// findRepeatPatternGroups).
// ===========================================================================
{
  const a = byName['Golden Valley Steel Supply'];
  assert(!!a, 'Golden Valley Steel Supply (scenario 5: volume pattern) exists as an account');
  assert(a.orderCount === 4, `Golden Valley Steel Supply has 4 real Apparel orders in one year (got ${a.orderCount})`);
  const patterns = dash.findRepeatPatternGroups(a);
  assert(patterns.length === 1 && patterns[0].category === 'Apparel', `findRepeatPatternGroups detects the Apparel volume pattern (got: ${JSON.stringify(patterns.map(p=>p.category))})`);
  assert(patterns[0].years.length === 1, `scenario 5 required proof (volume-driven, not annual/seasonal): all 4 orders fall in a single year (got ${patterns[0].years.length} year(s))`);
  assert(patterns[0].confidence === 64, `scenario 5 required proof (distinct detection path): confidence is 64 (volume-only), lower than scenarios 1/2's 82 (multi-year + seasonal) (got ${patterns[0].confidence})`);
}

// ===========================================================================
// Scenario 6: Cascade Outdoor Retailers -- historical categories connected
// to a new business trigger. generateSimulatedSignals() never fabricates
// business events (verified: it always returns []), so a real
// Business-Activity-Signal opportunity can only originate from the
// separate research-batch.js provider pipeline, which this branch is not
// permitted to run. This proves the REQUIRED distinctness (repeat/pattern
// vs. business-activity) using a manually-constructed opportunity object
// in the exact shape addSignalDerivedOpportunities() in
// dashboard/index.html produces (isVerifiedSignalOpportunity: true,
// sourceUrl set) -- the same classification function
// (signalLayerLabel/isBusinessOpportunity) that the real pipeline's output
// would be run through.
// ===========================================================================
{
  const a = byName['Cascade Outdoor Retailers'];
  assert(!!a, 'Cascade Outdoor Retailers (scenario 6: history + new trigger) exists as an account');
  const patterns = dash.findRepeatPatternGroups(a);
  assert(patterns.length === 1 && patterns[0].category === 'Print / Stationery', `findRepeatPatternGroups detects the real Print/Stationery history (got: ${JSON.stringify(patterns.map(p=>p.category))})`);
  const patternOpp = a.futureOpportunities.find(o => o.opportunityType === 'REPEAT PATTERN');
  assert(patternOpp.signalLayerType === 'Repeat / Pattern Signal', 'the historical-category opportunity is labeled "Repeat / Pattern Signal"');

  const simulatedBusinessOpp = {
    account: a.name, isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/cascade-new-flagship-store',
    signalTitle: 'Cascade Outdoor Retailers opens new flagship location', opportunity: 'New Flagship Store Opening',
    reasonToReachOut: 'New store opening creates a launch-kit opportunity', evidence: ['New flagship store opening announced']
  };
  assert(dash.signalLayerLabel(simulatedBusinessOpp) === 'Business Activity Signal', 'a real, sourced business-activity opportunity is classified "Business Activity Signal"');
  assert(dash.signalLayerLabel(patternOpp) !== dash.signalLayerLabel(simulatedBusinessOpp), 'scenario 6 required proof (repeat/pattern distinct from business-activity): the two signal types receive different signalLayerType classifications for the same account');
  assert(dash.isBusinessOpportunity(simulatedBusinessOpp) === true && dash.isBusinessOpportunity(patternOpp) === false, 'isBusinessOpportunity() correctly separates the two into different buckets before any cross-source merge logic would run');

  const realCategories = new Set(a.purchases.map(p => p.category));
  assert(!realCategories.has('New Flagship Store Opening'), 'scenario 6 required proof (category provenance under a business trigger): the business-trigger opportunity name never contaminates the account\'s real prior-purchase category set');
  assert(patternOpp.commonPromoCategories.every(c => !a.purchases.some(p => p.category === c)), 'the repeat-pattern opportunity\'s inferred product suggestions still never appear as an actual prior-purchase category, even when a business-trigger opportunity exists for the same account');
}

// ===========================================================================
// Scenario 7: Meridian Office Partners -- order history exists, but no
// currently actionable REPEAT PATTERN (only 1 order, so
// findRepeatPatternGroups correctly returns nothing). Documented finding:
// generateFutureOpportunities() still attaches generic industry-fallback
// opportunities (unconditional in every industry branch, per
// dashboard/index.html ~6002-6125) whenever orderCount > 0, regardless of
// whether the account's actual categories support them -- these are
// labeled Follow-Up or Repeat/Pattern purely by the account's recency
// score, not by a detected pattern. This is current production behavior,
// reported here rather than silently asserted away or fixed (fixing it is
// outside the "avoid broader architecture work" instruction for this
// branch).
// ===========================================================================
{
  const a = byName['Meridian Office Partners'];
  assert(!!a, 'Meridian Office Partners (scenario 7: no actionable pattern) exists as an account');
  assert(a.orderCount === 1, `Meridian Office Partners has exactly 1 order, insufficient for any repeat pattern (got ${a.orderCount})`);
  const patterns = dash.findRepeatPatternGroups(a);
  assert(patterns.length === 0, 'scenario 7 required proof (no fabricated REPEAT PATTERN): findRepeatPatternGroups correctly returns no pattern for this account');
  assert(a.futureOpportunities.every(o => o.opportunityType !== 'REPEAT PATTERN'), 'no opportunity for this account carries the REPEAT PATTERN opportunityType (i.e. no fabricated reorder-cadence claim)');
  assert(a.futureOpportunities.every(o => !/ordered .* times/i.test(o.whyNow || '')), 'no opportunity for this account claims a specific historical order count/cadence it does not have');
  if(a.futureOpportunities.length){
    console.log(`NOTE (scenario 7, generic-fallback limitation -- reported per task instructions, not fixed in this branch): generateFutureOpportunities() still attached ${a.futureOpportunities.length} generic industry-fallback opportunity(ies) (${a.futureOpportunities.map(o=>`"${o.opportunity}" [${o.signalLayerType}]`).join(', ')}) for this single-order account. These are grounded in the account's real industry classification, not a fabricated purchase pattern, and none claims a repeat cadence (asserted above) -- but they are current-behavior "reasons to reach out" that exist for any account with orderCount > 0, independent of whether findRepeatPatternGroups found anything. Recommend product review before beta: whether a single-order account should receive zero generic suggestions, or whether the current "general reason to reach out" framing is acceptable as-is.`);
  }
}

// ===========================================================================
// Scenario 8: Vantage Analytics Group -- no-order-history control account.
// ===========================================================================
{
  const a = byName['Vantage Analytics Group'];
  assert(!!a, 'Vantage Analytics Group (scenario 8: control) exists as an account');
  assert(a.orderCount === 0, `Vantage Analytics Group has 0 qualifying orders (got ${a.orderCount})`);
  assert(a.futureOpportunities.length === 0, `scenario 8 required proof (accounts without actionable history receive no fabricated signals): 0 opportunities generated for the no-history control account (got ${a.futureOpportunities.length})`);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
