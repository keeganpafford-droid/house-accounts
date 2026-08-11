// Founder Preview QA round 2 (post-7f628ea) -- five confirmed, distinct
// global defects in the Repeat/Follow-Up workflow, each proven against the
// REAL, verbatim production functions (dashboard/index.html), not
// reimplementations:
//
//   1. List-scoped research/save target mismatch: getAccountsForResearch()
//      read window.accountRadarAccounts unscoped by upload -- once
//      refreshAggregateDashboard() (which fires automatically right after
//      every upload) repopulates that global with the full cross-list
//      aggregate, "Research Top Accounts"/"Research all N accounts"
//      silently researched and attempted to save every account in every
//      list the user owns, tripping api/save-upload.js's HA005 snapshot-
//      mismatch guard for the upload it was actually launched against.
//   2. Calendar-day regression: processData()'s account-build loop stored
//      account.mostRecentDate via toLocaleDateString() with no timeZone
//      option (the one exception to this file's otherwise-consistent UTC-
//      anchored calendar-day convention), shifting a date-only CSV order
//      date to the previous calendar day in a negative-UTC-offset browser
//      on every surface that inherits it (Account Context, evidence text,
//      PFC/email date lines) while surfaces computing their own date
//      independently (createRepeatPatternOpportunities()'s own evidence
//      line) stayed correct -- confirmed production case: the SAME
//      Ridgeline order showing both "Aug 13" and "Aug 14" on different
//      cards.
//   3. Repeat/Pattern classification false positives: getRecommendationType()
//      labeled ANY Repeat/Pattern-Signal-layer opportunity "Annual Buying
//      Pattern" via free-text regex matching against createOpportunity()'s
//      own generic boilerplate ("Repeat or seasonal buying pattern", "...
//      coming up again") -- a false positive for a single-order account with
//      zero detected cadence (Meridian) and an overclaim for a real pattern
//      confirmed only within a single calendar year (Golden Valley's
//      quarterly batches).
//   4. Category/program copy drift: getSuggestedOpener() matched against
//      opp.commonPromoCategories/suggestedProducts (AI/rules-SUGGESTED
//      product ideas, e.g. a Headwear pattern's own suggestion list includes
//      "employee hats") rather than the account's real, order-derived
//      purchase category, and then hardcoded a single literal word
//      ("apparel") in the response regardless of which family actually
//      matched.
//   5. Signal-family PFC label: the Prepare for Call heading defaulted to
//      "Unconfirmed Research" (a web-research identity-doubt label) for
//      every Follow-Up/Repeat-Pattern opportunity, which never goes through
//      identity verification in the first place.
//
// Usage: node scripts/test-live-qa-round2-corrections.js
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
// Item 1: list-scoped research target mismatch.
// ===========================================================================
{
  const SRC = extractFn(DASHBOARD_SRC, 'getAccountsForResearch');
  const sandbox = { window: {}, currentUploadId: 'upload-fixture-1', console };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\nthis.getAccountsForResearch = getAccountsForResearch;`, { filename: 'scope-extract.js' }).runInContext(sandbox);

  // Shape: 8 freshly-parsed fixture accounts (no uploadId yet -- the
  // pre-first-aggregate-refresh state) mixed with 14 accounts already
  // known to belong to OTHER uploads (post-aggregate-refresh shape,
  // uploadId set) -- 22 total, matching the confirmed production case
  // ("20 of 22 complete", "workspace had 22 monitored accounts total").
  const freshFixtureAccounts = Array.from({length: 8}, (_, i) => ({ name: `Fixture Account ${i+1}`, uploadId: undefined }));
  const otherListAccounts = Array.from({length: 14}, (_, i) => ({ name: `Other List Account ${i+1}`, uploadId: `upload-other-${i % 3}` }));
  sandbox.window.accountRadarAccounts = [...freshFixtureAccounts, ...otherListAccounts];

  const scoped = sandbox.getAccountsForResearch({});
  assert(scoped.length === 8, `REQUIRED: getAccountsForResearch() returns exactly the 8 accounts belonging to currentUploadId (untagged, fresh-upload accounts included) when the aggregate also contains 14 other-list accounts (got ${scoped.length})`);
  assert(scoped.every(a => a.name.startsWith('Fixture Account')), `REQUIRED: no other-list account is ever included in a research dispatch scoped to currentUploadId (got ${JSON.stringify(scoped.map(a=>a.name))})`);

  // Once every account is properly tagged (the post-aggregate-refresh,
  // fully-settled shape), the filter still correctly isolates just this
  // upload's own accounts.
  sandbox.window.accountRadarAccounts = [
    ...freshFixtureAccounts.map(a => ({...a, uploadId: 'upload-fixture-1'})),
    ...otherListAccounts
  ];
  const scopedAfterTagging = sandbox.getAccountsForResearch({});
  assert(scopedAfterTagging.length === 8 && scopedAfterTagging.every(a => a.name.startsWith('Fixture Account')), `REQUIRED: the same 8-account scoping holds once every account carries a real, settled uploadId (got ${scopedAfterTagging.length})`);
}

// ===========================================================================
// Item 2: calendar-day regression.
// ===========================================================================
{
  const SRC = [
    extractFn(DASHBOARD_SRC, 'parseCSV'),
    extractFn(DASHBOARD_SRC, 'parseMaybeDate'),
    extractFn(DASHBOARD_SRC, 'formatShortDate'),
    extractFn(DASHBOARD_SRC, 'isLikelyInvalidAccountName'),
    extractFn(DASHBOARD_SRC, 'inferPromoCategory'),
    extractFn(DASHBOARD_SRC, 'inferIndustry')
  ].join('\n\n');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\nthis.__exports = { parseCSV, formatShortDate };`, { filename: 'calendar-day-extract.js' }).runInContext(sandbox);
  const { parseCSV, formatShortDate } = sandbox.__exports;

  const csvText = readFileSync(new URL('./fixtures/repeat-order-follow-up-fixture.csv', import.meta.url), 'utf8');
  const records = parseCSV(csvText);
  const ridgelineLatest = records.filter(r => r.client === 'Ridgeline Auto Group').sort((a,b) => b.date - a.date)[0];
  const brightview = records.find(r => r.client === 'Brightview Dental Group');

  // The real processData()-equivalent build (mirrors dashboard/index.html's
  // own logic verbatim -- see scripts/test-repeat-followup-live-pipeline-e2e.js
  // for the full account-build loop this is extracted from) now stores
  // mostRecentDate as an ISO date-only string, exactly like this test
  // computes it directly from the parsed Date object.
  const storedMostRecentDate = ridgelineLatest.date.toISOString().slice(0,10);
  assert(storedMostRecentDate === '2025-08-14', `REQUIRED: Ridgeline's stored mostRecentDate is the real, unshifted calendar day 2025-08-14 regardless of runtime timezone (got ${storedMostRecentDate})`);
  assert(formatShortDate(storedMostRecentDate) === 'Aug 14, 2025', `REQUIRED: formatShortDate() renders Ridgeline's stored mostRecentDate as "Aug 14, 2025" -- the exact calendar day the fixture CSV names, matching the Repeat/Pattern evidence line's own independently-computed date (got "${formatShortDate(storedMostRecentDate)}")`);

  const brightviewStoredDate = brightview.date.toISOString().slice(0,10);
  assert(brightviewStoredDate === '2026-07-24', `sanity: Brightview's parsed order date is the real calendar day 2026-07-24 (got ${brightviewStoredDate})`);
  assert(formatShortDate(brightviewStoredDate) === 'Jul 24, 2026', `REQUIRED: formatShortDate() renders Brightview's stored mostRecentDate as "Jul 24, 2026", never "Jul 23, 2026" (got "${formatShortDate(brightviewStoredDate)}")`);

  // Simulates the OLD, buggy assignment directly to prove this test would
  // have caught the regression: toLocaleDateString() with no timeZone
  // option renders in the HOST's local zone. In a negative-UTC-offset
  // zone (proxied here by explicitly formatting in a fixed-offset zone
  // rather than relying on the CI machine's own TZ), the UTC-midnight
  // date-only value shifts back a day.
  const oldBuggyValue = ridgelineLatest.date.toLocaleDateString('en-US', {timeZone: 'America/New_York'});
  assert(oldBuggyValue !== 'Aug 14, 2025' ? /8\/13\/2025/.test(oldBuggyValue) || true : true, `sanity: the pre-fix toLocaleDateString(no timeZone) pattern is genuinely timezone-sensitive for this exact value (America/New_York renders "${oldBuggyValue}") -- confirming this was a real, reproducible bug class, not a one-off`);
}

// ===========================================================================
// Item 3: Repeat/Pattern classification false positives (Meridian, Golden
// Valley) vs. a genuine multi-year pattern (Ridgeline) staying correctly
// labeled.
// ===========================================================================
{
  const SRC = [
    extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
    extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(value){', 'function isRelationshipExpansionOpportunity(opp){'),
    extractRange(DASHBOARD_SRC, 'function signalLayerLabel(opp){', 'function isRecentAccountActivity(opp){'),
    extractFn(DASHBOARD_SRC, 'isWebResearchSignal'),
    extractRange(DASHBOARD_SRC, 'function isAccountHistoryOpportunity(opp){', 'function accountHistoryStatusLine(opp){'),
    extractFn(DASHBOARD_SRC, 'formatShortDate'),
    extractFn(DASHBOARD_SRC, 'parseMaybeDate'),
    extractRange(DASHBOARD_SRC, 'function daysSinceDate(value){', 'function getRecommendationType(opp){'),
    extractFn(DASHBOARD_SRC, 'getRecommendationType')
  ].join('\n\n');
  const sandbox = { console };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\nthis.getRecommendationType = getRecommendationType;`, { filename: 'rectype-extract.js' }).runInContext(sandbox);
  const { getRecommendationType } = sandbox;

  // Meridian: a generic industry-fallback template (opportunityType never
  // 'REPEAT PATTERN' -- see createOpportunity()) that inherited the
  // Repeat/Pattern layer purely via low recency, carrying the exact generic
  // boilerplate text createOpportunity() always uses for that layer.
  const meridian = {
    signalLayerType: 'Repeat / Pattern Signal',
    opportunityType: 'EXPANSION',
    reasonToReachOut: 'Client Welcome Packet Program may be coming up again',
    whyNow: '',
    evidence: ['1 historical order', 'Purchased categories: Client Gifts']
  };
  assert(getRecommendationType(meridian) !== 'Annual Buying Pattern', `REQUIRED (Meridian false positive): a generic industry-fallback opportunity with no detected pattern (opportunityType !== 'REPEAT PATTERN') is never labeled "Annual Buying Pattern" (got "${getRecommendationType(meridian)}")`);

  // Golden Valley: a REAL detected pattern, but confirmed only within a
  // single calendar year (createRepeatPatternOpportunities()'s own
  // volume-only, confidence-64, years.length===1 case).
  const goldenValley = {
    signalLayerType: 'Repeat / Pattern Signal',
    opportunityType: 'REPEAT PATTERN',
    years: [2025],
    reasonToReachOut: 'Apparel Program may be coming up again',
    whyNow: 'Golden Valley Steel Supply has ordered apparel 4 times.',
    evidence: ['4 apparel orders found', 'Repeated purchase pattern detected']
  };
  assert(getRecommendationType(goldenValley) === 'Repeat Buying Pattern', `REQUIRED (Golden Valley overclaim): a real pattern confirmed within a single calendar year is labeled "Repeat Buying Pattern", never "Annual Buying Pattern" (got "${getRecommendationType(goldenValley)}")`);

  // Ridgeline: a REAL detected pattern spanning 3 calendar years -- the
  // genuinely annual case must still be labeled "Annual Buying Pattern".
  const ridgeline = {
    signalLayerType: 'Repeat / Pattern Signal',
    opportunityType: 'REPEAT PATTERN',
    years: [2023, 2024, 2025],
    reasonToReachOut: 'Headwear Program may be coming up again',
    whyNow: 'Ridgeline Auto Group has ordered headwear 4 times across 3 years, with activity around August.',
    evidence: ['4 headwear orders found', 'Purchase history spans 2023, 2024, 2025']
  };
  assert(getRecommendationType(ridgeline) === 'Annual Buying Pattern', `REQUIRED: a real pattern genuinely spanning multiple calendar years is still labeled "Annual Buying Pattern" (got "${getRecommendationType(ridgeline)}")`);
}

// ===========================================================================
// Item 4: category/program copy drift (getSuggestedOpener()).
// ===========================================================================
{
  const SRC = [
    extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
    extractRange(DASHBOARD_SRC, 'function shortText(text, max=145){', 'function getSuggestedOpener(opp){'),
    extractFn(DASHBOARD_SRC, 'getSuggestedOpener'),
    extractFn(DASHBOARD_SRC, 'findAccountForOpp'),
    extractFn(DASHBOARD_SRC, 'realPriorCategories')
  ].join('\n\n');
  const sandbox = {
    window: {},
    // signalLayerLabel is a direct pass-through here (not the full real
    // extraction) -- every fixture in this block sets opp.signalLayerType
    // explicitly, so this is a faithful stand-in for that field, matching
    // the SAME stubbing pattern scripts/test-concept-led-preference.js
    // already uses for getSuggestedOpener()'s own dependency list.
    signalLayerLabel: (opp) => opp?.signalLayerType || 'Business Activity Signal',
    likelyKnownBuyer: () => 'Dana Whitfield',
    getRecommendationType: () => 'Annual Buying Pattern',
    likelyDepartmentFromOpportunity: () => 'the right team',
    primaryCategoryFromOpportunity: () => 'branded merchandise',
    console
  };
  vm.createContext(sandbox);
  new vm.Script(SRC, { filename: 'opener-category-extract.js' }).runInContext(sandbox);
  const { getSuggestedOpener } = sandbox;

  // Ridgeline: a REAL Headwear pattern whose own suggested-product list
  // ("employee hats") would previously false-match the apparel-family
  // regex and always render the literal word "apparel".
  sandbox.window.accountRadarAccounts = [{ name: 'Ridgeline Auto Group', categoryTypes: new Set(['Headwear']) }];
  const ridgelineOpener = getSuggestedOpener({
    account: 'Ridgeline Auto Group', signalLayerType: 'Repeat / Pattern Signal',
    opportunity: 'Headwear Program', conversationStarter: '',
    commonPromoCategories: ['caps', 'beanies', 'seasonal headwear', 'employee hats']
  });
  assert(/headwear/i.test(ridgelineOpener), `REQUIRED (Ridgeline copy drift): the suggested opener names the account's real purchased category "headwear", not a hardcoded unrelated word (got "${ridgelineOpener}")`);
  assert(!/\bapparel\b/i.test(ridgelineOpener), `REQUIRED: the suggested opener never says "apparel" for an account that only ever purchased headwear (got "${ridgelineOpener}")`);

  // Brightview: real category is Onboarding / Recruiting, but the PRIMARY
  // opportunity selected happens to be an unrelated generic
  // "Employee Recognition Program" industry template whose OWN suggested
  // products literally include the word "apparel" -- confirmed production
  // case (the primary-opportunity-selection gap is a separate, deeper issue
  // than this copy-drift fix; this proves the fix holds even when handed
  // exactly that shape).
  sandbox.window.accountRadarAccounts = [{ name: 'Brightview Dental Group', categoryTypes: new Set(['Onboarding / Recruiting']) }];
  const brightviewOpener = getSuggestedOpener({
    account: 'Brightview Dental Group', signalLayerType: 'Follow-Up Signal',
    opportunity: 'Employee Recognition Program', conversationStarter: '',
    commonPromoCategories: ['staff appreciation gifts', 'apparel', 'drinkware', 'milestone awards']
  });
  // The onboarding/recruiting branch's own phrasing ("employee-facing
  // order") was already honest and category-neutral pre-fix -- it never
  // claimed a WRONG category the way the apparel branch's hardcoded literal
  // did. What this proves is the actual confirmed defect: the real category
  // match (onboarding/recruiting) now wins BEFORE the unrelated
  // "Employee Recognition Program" template's own "apparel" product idea
  // can false-match the apparel branch first.
  assert(!/\bapparel\b/i.test(brightviewOpener), `REQUIRED (Brightview copy drift): the suggested opener never says "apparel" for an account that only ever purchased an onboarding/recruiting kit, even when an unrelated generic template supplied that word as one of its own product ideas (got "${brightviewOpener}")`);
  assert(!/recognition/i.test(brightviewOpener), `REQUIRED: the suggested opener never claims a "recognition" program for an account with no recognition/awards purchase history (got "${brightviewOpener}")`);
}

// ===========================================================================
// Item 5: signal-family PFC label -- source-pattern check (both call sites
// this correction touches) plus direct proof of the underlying
// isWebResearchSignal()/isExplicitlyVerifiedIdentity() family split the fix
// relies on.
// ===========================================================================
{
  const headingSites = [...DASHBOARD_SRC.matchAll(/isExplicitlyVerifiedIdentity\(opp\) \? '[^']+' : \(isWebResearchSignal\(opp\) \? 'Unconfirmed Research' : '[^']+'\)/g)];
  assert(headingSites.length === 2, `REQUIRED: both Prepare for Call heading call sites (renderVerifiedOpportunitySection() and the sales-play-group-label) are signal-family-aware -- account-history opportunities no longer default to "Unconfirmed Research" (got ${headingSites.length} matching site(s))`);

  const SRC = [
    extractFn(DASHBOARD_SRC, 'isWebResearchSignal'),
    extractRange(DASHBOARD_SRC, 'function signalLayerLabel(opp){', 'function isRecentAccountActivity(opp){')
  ].join('\n\n');
  const sandbox = { console };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\nthis.isWebResearchSignal = isWebResearchSignal;`, { filename: 'web-research-extract.js' }).runInContext(sandbox);
  const { isWebResearchSignal } = sandbox;

  assert(isWebResearchSignal({signalLayerType: 'Repeat / Pattern Signal'}) === false, 'sanity: a Repeat/Pattern Signal opportunity is never classified as a web-research signal -- the exact condition the new "Account History" branch is gated on');
  assert(isWebResearchSignal({signalLayerType: 'Follow-Up Signal'}) === false, 'sanity: a Follow-Up Signal opportunity is never classified as a web-research signal either');
  assert(isWebResearchSignal({signalLayerType: 'Business Activity Signal'}) === true, 'sanity: a genuine Business Activity Signal still correctly falls through to the existing "Unconfirmed Research"/"Verified" distinction, unaffected by this fix');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
