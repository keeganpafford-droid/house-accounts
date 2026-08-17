// Behavioral Learning V1, Phase 2 (dashboard-only wiring) -- deterministic
// proof of the SCORE INTEGRATION, against the REAL, verbatim-extracted
// dashboard/index.html functions (same convention as
// scripts/test-live-qa-round3-corrections.js and friends -- see
// scripts/lib/dashboard-extract.js's own header for why source is located
// by name, not physical line number).
//
// This file proves the dashboard-side half of the integration:
// calculateOpportunityScore() applies getOrgPreferenceAdjustmentForOpportunity()
// as one small, bounded, additive term, sourced from the module-level
// currentOrgPreferences table a real dashboard fetch would populate from
// api/get-dashboard.js's new orgPreferences response field. The server-side
// aggregation math itself (evidence counting, dedup, families, caps) is
// already proven in isolation by scripts/test-org-preference-learning.js --
// not re-proven here.
//
// Usage: node scripts/test-behavioral-learning-dashboard-integration.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const SRC = [
  extractFn(DASHBOARD_SRC, 'currentOrgPreferences'),
  extractFn(DASHBOARD_SRC, 'ORG_PREFERENCE_FAMILY_BY_SIGNAL_LAYER'),
  extractFn(DASHBOARD_SRC, 'getOrgPreferenceAdjustmentForOpportunity'),
  extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
  extractFn(DASHBOARD_SRC, 'signalLayerLabel'),
  extractFn(DASHBOARD_SRC, 'isRelationshipExpansionOpportunity'),
  extractFn(DASHBOARD_SRC, 'getRecommendationType'),
  extractFn(DASHBOARD_SRC, 'daysSinceDate'),
  extractFn(DASHBOARD_SRC, 'scoreFromFreshness'),
  extractFn(DASHBOARD_SRC, 'normalizedConfidenceValue'),
  extractFn(DASHBOARD_SRC, 'evidenceCount'),
  extractFn(DASHBOARD_SRC, 'clampScore'),
  extractFn(DASHBOARD_SRC, 'calculateOpportunityScore'),
  // Test-only bridge: `let currentOrgPreferences` (like every other
  // top-level let/const a vm script declares) lives in the script's own
  // lexical environment, NOT as a settable property on the sandbox/global
  // object -- vm.Script.runInContext() only exposes `var`s that way.
  // Assigning sandbox.currentOrgPreferences from outside would silently
  // create an unrelated stray property while every function inside the
  // sandbox keeps closing over the ORIGINAL (always-{}) binding. This
  // function is defined WITHIN the same extracted scope, so normal JS
  // closure rules let it reassign the real binding; it is test
  // infrastructure only, not a dashboard/index.html function.
  'function __setOrgPreferences(v){ currentOrgPreferences = v; }'
].join('\n\n');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
new vm.Script(SRC, { filename: 'behavioral-learning-dashboard-integration-extract.js' }).runInContext(sandbox);
const { calculateOpportunityScore, getOrgPreferenceAdjustmentForOpportunity, __setOrgPreferences } = sandbox;

for (const fn of [calculateOpportunityScore, getOrgPreferenceAdjustmentForOpportunity, __setOrgPreferences]) {
  assert(typeof fn === 'function', `import produced a real extracted function (${fn && fn.name})`);
}

function setOrgPreferences(value){ __setOrgPreferences(value); }

// A realistic, already-eligible Business Activity opportunity -- everything
// here is exactly the shape calculateOpportunityScore() reads. Eligibility
// itself (classifyMonitoringSignalEligibility()/actionability) has already
// run upstream, server-side, by the time an opportunity reaches this
// function at all -- this fixture represents "already valid," matching the
// real pipeline.
function businessActivityOpp(overrides = {}){
  return {
    signalLayerType: 'Business Activity Signal',
    accountRevenue: 50000,
    accountOrderCount: 3,
    accountRecencyScore: 0.4,
    accountFrequencyScore: 0.3,
    accountDiversityScore: 0.2,
    confidenceScore: 72,
    signalDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    reasonToReachOut: 'Acme Fixtures just announced a new distribution center opening.',
    whyNow: 'Acme Fixtures just announced a new distribution center opening.',
    conversationStarter: 'Are you centralizing apparel/gear for the new site?',
    evidence: ['Acme Fixtures opens new distribution center'],
    sourceUrl: 'https://news.example.com/acme-fixtures',
    likelyProducts: ['Apparel'],
    ...overrides
  };
}
function followUpOpp(overrides = {}){
  return {
    signalLayerType: 'Follow-Up Signal',
    accountRevenue: 50000,
    accountOrderCount: 3,
    accountRecencyScore: 0.4,
    accountFrequencyScore: 0.3,
    accountDiversityScore: 0.2,
    confidenceScore: 72,
    lastOrderDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    reasonToReachOut: 'Delivered apparel order last quarter -- worth a check-in.',
    whyNow: 'Delivered apparel order last quarter -- worth a check-in.',
    conversationStarter: 'How did the last shipment work out?',
    evidence: ['Delivered apparel order'],
    likelyProducts: ['Apparel'],
    ...overrides
  };
}
function repeatPatternOpp(overrides = {}){
  return {
    signalLayerType: 'Repeat / Pattern Signal',
    accountRevenue: 50000,
    accountOrderCount: 5,
    accountRecencyScore: 0.4,
    accountFrequencyScore: 0.5,
    accountDiversityScore: 0.2,
    confidenceScore: 72,
    reasonToReachOut: 'Annual apparel reorder is due again this quarter.',
    whyNow: 'Annual apparel reorder is due again this quarter.',
    conversationStarter: 'Is the annual apparel program happening again this year?',
    evidence: ['Annual apparel reorder'],
    likelyProducts: ['Apparel'],
    ...overrides
  };
}
function sufficientPositivePreference(adjustment = 8){
  return { adjustment, sufficientEvidence: true, totalEvidenceCount: 12, qualityPositiveCount: 10, qualityNegativeCount: 2, outcomePositiveCount: 0 };
}
function sufficientNegativePreference(adjustment = -6){
  return { adjustment, sufficientEvidence: true, totalEvidenceCount: 9, qualityPositiveCount: 1, qualityNegativeCount: 8, outcomePositiveCount: 0 };
}
function insufficientPreference(){
  return { adjustment: 0, sufficientEvidence: false, totalEvidenceCount: 2, qualityPositiveCount: 1, qualityNegativeCount: 1, outcomePositiveCount: 0 };
}

// ===========================================================================
// A. Zero-evidence equivalence -- with no qualifying preference (no data at
//    all, and separately, data present but below the evidence floor), the
//    score is numerically identical to the true baseline, and ordering
//    across families is unchanged.
// ===========================================================================
{
  setOrgPreferences({});
  const withNoPreferencesAtAll = calculateOpportunityScore(businessActivityOpp());
  setOrgPreferences(null);
  const withNullPreferences = calculateOpportunityScore(businessActivityOpp());
  assert(withNoPreferencesAtAll === withNullPreferences, `REQUIRED: an empty {} and a null/missing preferences table produce byte-identical scores (got ${withNoPreferencesAtAll} vs ${withNullPreferences})`);
}
{
  setOrgPreferences({});
  const baseline = calculateOpportunityScore(businessActivityOpp());
  setOrgPreferences({ BUSINESS_ACTIVITY: insufficientPreference() });
  const withInsufficientEvidence = calculateOpportunityScore(businessActivityOpp());
  assert(baseline === withInsufficientEvidence, `REQUIRED: a preference entry present but below the evidence floor (sufficientEvidence:false) produces the SAME score as no data at all (got baseline=${baseline}, withInsufficientEvidence=${withInsufficientEvidence})`);
}
{
  // Ordering across three otherwise-distinct opportunities, no preferences
  // loaded, must match ordering with preferences loaded but insufficient
  // everywhere.
  setOrgPreferences({});
  const scoresBaseline = [businessActivityOpp(), followUpOpp(), repeatPatternOpp()].map(calculateOpportunityScore);
  setOrgPreferences({ BUSINESS_ACTIVITY: insufficientPreference(), FOLLOW_UP: insufficientPreference(), REPEAT_PATTERN: insufficientPreference() });
  const scoresInsufficient = [businessActivityOpp(), followUpOpp(), repeatPatternOpp()].map(calculateOpportunityScore);
  assert(JSON.stringify(scoresBaseline) === JSON.stringify(scoresInsufficient), `REQUIRED: ordering/scores across three different families are unchanged when all evidence is insufficient (got ${JSON.stringify(scoresBaseline)} vs ${JSON.stringify(scoresInsufficient)})`);
}

// ===========================================================================
// B. Positive-family preference -- sufficient positive evidence produces
//    the exact expected bounded delta, and can flip relative ordering
//    between two otherwise-comparable eligible opportunities.
// ===========================================================================
{
  setOrgPreferences({});
  const baseline = calculateOpportunityScore(businessActivityOpp());
  setOrgPreferences({ BUSINESS_ACTIVITY: sufficientPositivePreference(8) });
  const withAdjustment = calculateOpportunityScore(businessActivityOpp());
  // clampScore rounds and bounds to [0,100] -- assert the exact delta only
  // when neither score sits at the clamp boundary, which this fixture's
  // mid-range inputs are designed to avoid.
  assert(withAdjustment - baseline === 8, `REQUIRED: sufficient +8 BUSINESS_ACTIVITY evidence raises the score by exactly 8 (got baseline=${baseline}, withAdjustment=${withAdjustment}, delta=${withAdjustment - baseline})`);
}
{
  setOrgPreferences({});
  const baseline = calculateOpportunityScore(followUpOpp());
  setOrgPreferences({ FOLLOW_UP: sufficientPositivePreference(8) });
  const withAdjustment = calculateOpportunityScore(followUpOpp());
  assert(withAdjustment - baseline === 8, `REQUIRED: sufficient +8 FOLLOW_UP evidence raises the score by exactly 8 (got baseline=${baseline}, withAdjustment=${withAdjustment}, delta=${withAdjustment - baseline})`);
}
{
  setOrgPreferences({});
  const baseline = calculateOpportunityScore(repeatPatternOpp());
  setOrgPreferences({ REPEAT_PATTERN: sufficientPositivePreference(8) });
  const withAdjustment = calculateOpportunityScore(repeatPatternOpp());
  assert(withAdjustment - baseline === 8, `REQUIRED: sufficient +8 REPEAT_PATTERN evidence raises the score by exactly 8 (got baseline=${baseline}, withAdjustment=${withAdjustment}, delta=${withAdjustment - baseline})`);
}
{
  // A genuine reorder: two DIFFERENT-family opportunities that rank Y above
  // X at baseline; a positive preference for X's family alone closes and
  // flips the gap.
  setOrgPreferences({});
  const x = businessActivityOpp({ accountRevenue: 5000, confidenceScore: 70 });
  const y = followUpOpp({ accountRevenue: 5000, confidenceScore: 62 });
  const baselineX = calculateOpportunityScore(x);
  const baselineY = calculateOpportunityScore(y);
  assert(baselineY > baselineX, `sanity: fixture Y outranks fixture X at baseline, so a real reorder is meaningful to prove (got X=${baselineX}, Y=${baselineY})`);
  setOrgPreferences({ BUSINESS_ACTIVITY: sufficientPositivePreference(8) });
  const adjustedX = calculateOpportunityScore(x);
  const adjustedY = calculateOpportunityScore(y);
  assert(adjustedY === baselineY, `sanity: Y's own score is unaffected by a preference entry for a DIFFERENT family (got ${adjustedY} vs baseline ${baselineY})`);
  assert(adjustedX > adjustedY, `REQUIRED: a sufficient positive BUSINESS_ACTIVITY preference flips the ordering -- X now outranks Y, having trailed it at baseline (got X=${adjustedX}, Y=${adjustedY})`);
}

// ===========================================================================
// C. Negative-family preference -- reduces, but never invalidates, an
//    already-eligible recommendation (it stays a real, positive-scoring,
//    still-present opportunity, just lower-ranked).
// ===========================================================================
{
  setOrgPreferences({});
  const baseline = calculateOpportunityScore(businessActivityOpp());
  setOrgPreferences({ BUSINESS_ACTIVITY: sufficientNegativePreference(-6) });
  const withAdjustment = calculateOpportunityScore(businessActivityOpp());
  assert(baseline - withAdjustment === 6, `REQUIRED: sufficient net-negative evidence reduces the score by exactly the bounded delta (got baseline=${baseline}, withAdjustment=${withAdjustment})`);
  assert(withAdjustment > 0, `REQUIRED: the recommendation remains a real, positive-scoring opportunity -- negative preference reduces rank, it never zeroes out or invalidates an already-eligible item (got ${withAdjustment})`);
}

// ===========================================================================
// D. Cap -- extreme fixture evidence cannot move a score by more than the
//    server's own bounded [-8, 8] range, even if a malformed/extreme
//    adjustment value somehow arrived at the client.
// ===========================================================================
{
  setOrgPreferences({});
  const baseline = calculateOpportunityScore(businessActivityOpp());
  setOrgPreferences({ BUSINESS_ACTIVITY: { adjustment: 500, sufficientEvidence: true, totalEvidenceCount: 999, qualityPositiveCount: 999, qualityNegativeCount: 0, outcomePositiveCount: 0 } });
  const withExtreme = calculateOpportunityScore(businessActivityOpp());
  assert(withExtreme - baseline === 8, `REQUIRED: the client-side lookup re-clamps to +/-8 defensively even if a malformed adjustment value somehow arrived (got delta=${withExtreme - baseline})`);
}
{
  setOrgPreferences({});
  const baseline = calculateOpportunityScore(businessActivityOpp());
  setOrgPreferences({ BUSINESS_ACTIVITY: { adjustment: -500, sufficientEvidence: true, totalEvidenceCount: 999, qualityPositiveCount: 0, qualityNegativeCount: 999, outcomePositiveCount: 0 } });
  const withExtreme = calculateOpportunityScore(businessActivityOpp());
  assert(baseline - withExtreme === 8, `REQUIRED: the negative direction is equally re-clamped to -8 (got delta=${withExtreme - baseline})`);
}

// ===========================================================================
// E. Truth-gate independence -- behavioral learning operates entirely
//    downstream of eligibility. This function only ever runs on candidates
//    that already cleared classifyMonitoringSignalEligibility()/
//    classifyLegacySignalActionability() upstream (server-side, before an
//    opportunity ever reaches the dashboard client at all) -- there is no
//    parameter, branch, or code path here through which a preference
//    adjustment could promote an ineligible/secondary/stale signal, because
//    this function has no eligibility concept to override in the first
//    place. Proven structurally: an "ineligible" signal, by construction,
//    never reaches calculateOpportunityScore() as an argument at all (see
//    api/get-dashboard.js's buildAccountsFromRows(), which gates
//    futureOpportunities on classifyMonitoringSignalEligibility() === 'priority'
//    BEFORE signalToOpportunity() is ever called) -- there is no
//    "hypothetical +8 on an ineligible signal" scenario to construct here,
//    because the object would never exist at this layer. This test instead
//    proves the adjacent, directly-testable guarantee: a huge preference
//    adjustment can move a score by at most 8 points on a 0-100 scale --
//    nowhere near enough to manufacture false actionability signals
//    (evidenceCount/sourceUrl/reasonToReachOut) that don't exist, which is
//    the only OTHER mechanism by which this function's own output changes.
// ===========================================================================
{
  const noEvidenceOpp = businessActivityOpp({ reasonToReachOut: '', whyNow: '', evidence: [], sourceUrl: '', conversationStarter: '', likelyProducts: [] });
  setOrgPreferences({});
  const baseline = calculateOpportunityScore(noEvidenceOpp);
  setOrgPreferences({ BUSINESS_ACTIVITY: sufficientPositivePreference(8) });
  const withMaxPositive = calculateOpportunityScore(noEvidenceOpp);
  assert(withMaxPositive - baseline === 8, 'sanity: the +8 delta applies identically regardless of how weak the underlying evidence is');
  assert(withMaxPositive < 50, `REQUIRED: even the maximum +8 preference adjustment cannot lift a genuinely weak/low-evidence recommendation into a strong score -- it only ever perturbs the baseline that evidence/actionability already established (got ${withMaxPositive})`);
}

// ===========================================================================
// F. Cross-org isolation, at the dashboard layer -- proven by construction:
//    currentOrgPreferences is populated ONCE per dashboard fetch from THIS
//    request's own server-derived organization, and the client holds no
//    concept of "other organizations" at all -- there is no code path here
//    through which a second organization's data could ever reach this
//    lookup table. The real isolation guarantee (one org's raw events can
//    never contaminate another's COMPUTED preferences) is proven server-side
//    in scripts/test-org-preference-learning.js; this proves the CLIENT
//    trusts exactly one preferences table per render, never merges/receives
//    a second one.
// ===========================================================================
{
  // Org A's preferences loaded; simulate re-rendering the SAME opportunity
  // object as if Org B's (very different) preferences were the active
  // table -- proves the lookup is a pure function of whatever table is
  // CURRENTLY set, with no memory of, or blending with, a prior org's data.
  setOrgPreferences({ BUSINESS_ACTIVITY: sufficientPositivePreference(8) });
  const asOrgA = calculateOpportunityScore(businessActivityOpp());
  setOrgPreferences({ BUSINESS_ACTIVITY: sufficientNegativePreference(-6) });
  const asOrgB = calculateOpportunityScore(businessActivityOpp());
  setOrgPreferences({});
  const asOrgCNoData = calculateOpportunityScore(businessActivityOpp());
  assert(asOrgA !== asOrgB, `REQUIRED: switching the active preferences table (simulating a different organization's dashboard render) fully replaces the prior table's effect, never blends with it (got orgA=${asOrgA}, orgB=${asOrgB})`);
  assert(asOrgCNoData === asOrgA - 8 && asOrgCNoData === asOrgB + 6, `REQUIRED: a third render with no preferences shows neither org A's nor org B's residual influence (got ${asOrgCNoData})`);
}

// ===========================================================================
// G. Failure fallback -- malformed/unexpected preferences data must never
//    throw or change ranking; every case resolves to adjustment 0.
// ===========================================================================
{
  const cases = [
    ['undefined table', undefined],
    ['null table', null],
    ['non-object table', 'not-an-object'],
    ['array instead of object', []],
    ['family entry is null', { BUSINESS_ACTIVITY: null }],
    ['family entry missing sufficientEvidence', { BUSINESS_ACTIVITY: { adjustment: 8 } }],
    ['family entry with sufficientEvidence:false', { BUSINESS_ACTIVITY: { adjustment: 8, sufficientEvidence: false } }],
    ['family entry with non-numeric adjustment', { BUSINESS_ACTIVITY: { adjustment: 'a lot', sufficientEvidence: true } }],
    ['family entry with NaN adjustment', { BUSINESS_ACTIVITY: { adjustment: NaN, sufficientEvidence: true } }],
    ['wrong family key entirely', { SOME_OTHER_KEY: { adjustment: 8, sufficientEvidence: true } }]
  ];
  setOrgPreferences({});
  const baseline = calculateOpportunityScore(businessActivityOpp());
  for (const [label, badTable] of cases) {
    setOrgPreferences(badTable);
    let scoreResult;
    let threw = false;
    try { scoreResult = calculateOpportunityScore(businessActivityOpp()); }
    catch { threw = true; }
    assert(!threw, `REQUIRED: malformed preferences data (${label}) never throws -- the dashboard must still render`);
    assert(scoreResult === baseline, `REQUIRED: malformed preferences data (${label}) produces the unchanged baseline score, not a fabricated adjustment (got ${scoreResult}, baseline ${baseline})`);
  }
}
{
  // opp.signalLayerType itself missing/unrecognized -- must not throw or
  // pick an arbitrary family.
  setOrgPreferences({ BUSINESS_ACTIVITY: sufficientPositivePreference(8), FOLLOW_UP: sufficientPositivePreference(8), REPEAT_PATTERN: sufficientPositivePreference(8) });
  const adjustment = getOrgPreferenceAdjustmentForOpportunity({ signalLayerType: 'Some Unrecognized Layer' });
  assert(adjustment === 0, `REQUIRED: an opportunity with an unrecognized signalLayerType resolves to adjustment 0, never guessed into any of the three families (got ${adjustment})`);
  const adjustmentMissing = getOrgPreferenceAdjustmentForOpportunity({});
  assert(adjustmentMissing === 0, 'REQUIRED: an opportunity with no signalLayerType at all resolves to adjustment 0');
  const adjustmentNullOpp = getOrgPreferenceAdjustmentForOpportunity(null);
  assert(adjustmentNullOpp === 0, 'REQUIRED: a null/undefined opportunity never throws and resolves to adjustment 0');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
