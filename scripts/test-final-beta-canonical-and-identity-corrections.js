// Final bounded Beta trust correction (Round B): dedicated regression
// coverage for the three founder-specified items on top of
// product/global-business-trigger-intelligence.
//
//   1. Canonical event classification is authoritative across BOTH research
//      endpoints -- api/research-account.js's makeAISignal()/makeSignal()
//      and api/research-batch.js's classifyLegacySignalActionability() both
//      resolve their seller-facing copy from the SAME
//      resolveCanonicalEventType() -> canonicalTemplateFamily() ->
//      sellerCopyForTemplateFamily() pipeline, never an independent
//      free-text reinterpretation.
//   2. Single-token third-party promotion is scoped to the SAME
//      SENTENCE/LOCAL CLAUSE containing the company occurrence, not the
//      whole snippet -- an explicit contextual claim corroborates; bare
//      roster/list/breadcrumb membership does not.
//   3. isExactSelfSocialHandleMatch() -- exact compacted-name-vs-handle
//      equality is additive corroboration, never fuzzy/substring.
//
// Fictional archetypes below are shaped after the real founder-reported
// production cases (Cianbro, L.L.Bean, BerryDunn, Eastern Propane) without
// reusing their exact evidence text.
//
// Usage: node scripts/test-final-beta-canonical-and-identity-corrections.js
import vm from 'vm';
import { makeAISignal } from '../api/research-account.js';
import {
  resolveCanonicalEventType,
  canonicalTemplateFamily,
  classifyLegacySignalActionability
} from '../api/research-batch.js';
import {
  displayLabelForEventType,
  sellerCopyForTemplateFamily,
  isStandaloneSingleTokenMention,
  isExactSelfSocialHandleMatch,
  verifyCandidateCompanyGrounding
} from '../api/signal-intelligence.js';
import { loadDashboardSource, extractFn, extractRange } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Item 1: canonical event classification authoritative across both
// endpoints. Six shapes covering every required control.
// ===========================================================================

const CIANBRO_TITLE = 'Cianbro at Maine CTE Business Summit';
const CIANBRO_CTX = 'Cianbro joined the Maine CTE Business Summit to discuss career pathways for students.';
const LLBEAN_TITLE = 'L.L.Bean, Inc. Jobs | LiveAndWorkInMaine';
const LLBEAN_CTX = 'Explore open positions and job openings at L.L.Bean across Maine.';
const BERRYDUNN_THOUGHT_TITLE = 'Trailblazers in Veterinary Accounting and Consulting';
const BERRYDUNN_THOUGHT_CTX = 'BerryDunn continues expanding its specialty practice area, growing its expertise to serve clients in every location nationwide.';
const BERRYDUNN_HQ_TITLE = 'BerryDunn relocates headquarters to new downtown office';
const BERRYDUNN_HQ_CTX = 'BerryDunn is relocating its headquarters to a larger downtown office to support continued growth.';
const BERRYDUNN_AWARD_TITLE = 'BerryDunn wins Best Places to Work Award';
const BERRYDUNN_AWARD_CTX = 'BerryDunn was honored with the Best Places to Work Award this year for its outstanding culture.';
const EASTERN_PROPANE_TITLE = 'Eastern Propane now hiring seasonal delivery drivers';
const EASTERN_PROPANE_CTX = 'Eastern Propane is now hiring seasonal delivery drivers ahead of the winter season.';

// 1a) resolveCanonicalEventType() itself -- the one shared classifier both
// endpoints call -- produces the required canonical types.
{
  const cianbro = resolveCanonicalEventType({ signalTitle: CIANBRO_TITLE, business_context: CIANBRO_CTX });
  assert(cianbro.eventType === 'EVENT_CONFERENCE', `REQUIRED: Cianbro's explicit Business Summit signal resolves to canonical Conference/Summit, not Hiring (got ${cianbro.eventType})`);

  const llbean = resolveCanonicalEventType({ signalTitle: LLBEAN_TITLE, business_context: LLBEAN_CTX });
  assert(llbean.eventType === 'HIRING_ACTIVITY', `REQUIRED: L.L.Bean's Jobs page resolves to canonical Hiring, not Public Event/Trade Show (got ${llbean.eventType})`);

  const berryDunnThought = resolveCanonicalEventType({ signalTitle: BERRYDUNN_THOUGHT_TITLE, business_context: BERRYDUNN_THOUGHT_CTX });
  assert(berryDunnThought.eventType === 'BUSINESS_ACTIVITY_UNKNOWN', `REQUIRED: BerryDunn's thought-leadership/practice-area article resolves to generic/unknown Business Activity, NOT Facility/Location Launch, despite mentioning "expanding"/"location" (got ${berryDunnThought.eventType})`);
  assert(canonicalTemplateFamily(displayLabelForEventType(berryDunnThought.eventType)) === null, 'REQUIRED: the generic BerryDunn classification maps to no specific template family (no facility rescue)');

  const berryDunnHq = resolveCanonicalEventType({ signalTitle: BERRYDUNN_HQ_TITLE, business_context: BERRYDUNN_HQ_CTX });
  assert(canonicalTemplateFamily(displayLabelForEventType(berryDunnHq.eventType)) === 'facility', `REQUIRED: BerryDunn's genuine HQ relocation still classifies into the facility family, guidance remains correct (got ${berryDunnHq.eventType})`);

  const berryDunnAward = resolveCanonicalEventType({ signalTitle: BERRYDUNN_AWARD_TITLE, business_context: BERRYDUNN_AWARD_CTX });
  assert(berryDunnAward.eventType === 'EVENT_AWARD', `REQUIRED: BerryDunn's award resolves to canonical Award/Recognition, NOT Hiring or Leadership (got ${berryDunnAward.eventType})`);

  const easternPropane = resolveCanonicalEventType({ signalTitle: EASTERN_PROPANE_TITLE, business_context: EASTERN_PROPANE_CTX });
  assert(easternPropane.eventType === 'HIRING_ACTIVITY', `REQUIRED: Eastern Propane hiring remains canonical Hiring (got ${easternPropane.eventType})`);
}

// 1b) api/research-account.js's makeAISignal() persists the SAME canonical
// classification and derives its seller-facing copy exclusively from it --
// never an independently re-derived, conflicting family.
{
  const cianbroSignal = makeAISignal(
    { signalTitle: CIANBRO_TITLE, whatChanged: CIANBRO_CTX },
    { title: CIANBRO_TITLE, snippet: CIANBRO_CTX, url: 'https://news.example.com/cianbro-summit' },
    'Cianbro', '', false
  );
  assert(cianbroSignal.canonicalEventType === 'EVENT_CONFERENCE', `REQUIRED: research-account.js persists canonicalEventType EVENT_CONFERENCE for Cianbro (got ${cianbroSignal.canonicalEventType})`);
  assert(cianbroSignal.signalType === 'Conference / Summit', `REQUIRED: Cianbro's persisted signalType is Conference / Summit, not Hiring (got "${cianbroSignal.signalType}")`);
  assert(!/hiring|onboarding|recruit/i.test(cianbroSignal.reasonToReachOut), `REQUIRED: Cianbro's reasonToReachOut carries no Hiring-family claim (got "${cianbroSignal.reasonToReachOut}")`);
  assert(cianbroSignal.affectedDepartment !== 'HR / People', `REQUIRED: Cianbro's buying team is not HR / People (got "${cianbroSignal.affectedDepartment}")`);

  const llbeanSignal = makeAISignal(
    { signalTitle: LLBEAN_TITLE, whatChanged: LLBEAN_CTX },
    { title: LLBEAN_TITLE, snippet: LLBEAN_CTX, url: 'https://liveandworkinmaine.com/llbean-jobs' },
    'L.L.Bean', '', false
  );
  assert(llbeanSignal.canonicalEventType === 'HIRING_ACTIVITY', `REQUIRED: research-account.js persists canonicalEventType HIRING_ACTIVITY for L.L.Bean Jobs (got ${llbeanSignal.canonicalEventType})`);
  assert(llbeanSignal.signalType === 'Hiring Activity', `REQUIRED: L.L.Bean's persisted signalType is Hiring Activity, not a public-event label (got "${llbeanSignal.signalType}")`);
  assert(!/public event|trade show/i.test(llbeanSignal.reasonToReachOut), `REQUIRED: L.L.Bean's reasonToReachOut carries no Public Event/Trade Show claim (got "${llbeanSignal.reasonToReachOut}")`);
  assert(llbeanSignal.affectedDepartment !== 'Marketing / Events', `REQUIRED: L.L.Bean's buying team is not Marketing / Events (got "${llbeanSignal.affectedDepartment}")`);

  const berryDunnThoughtSignal = makeAISignal(
    { signalTitle: BERRYDUNN_THOUGHT_TITLE, whatChanged: BERRYDUNN_THOUGHT_CTX },
    { title: BERRYDUNN_THOUGHT_TITLE, snippet: BERRYDUNN_THOUGHT_CTX, url: 'https://industrypub.example.com/berrydunn-trailblazers' },
    'BerryDunn', '', false
  );
  assert(berryDunnThoughtSignal.canonicalEventType === 'BUSINESS_ACTIVITY_UNKNOWN', `REQUIRED: research-account.js persists the generic canonicalEventType for BerryDunn's thought-leadership piece (got ${berryDunnThoughtSignal.canonicalEventType})`);
  assert(!/facility|location launch|opening-day/i.test(berryDunnThoughtSignal.reasonToReachOut), `REQUIRED: BerryDunn's thought-leadership reasonToReachOut never claims a Facility/Location Launch (got "${berryDunnThoughtSignal.reasonToReachOut}")`);

  const berryDunnHqSignal = makeAISignal(
    { signalTitle: BERRYDUNN_HQ_TITLE, whatChanged: BERRYDUNN_HQ_CTX },
    { title: BERRYDUNN_HQ_TITLE, snippet: BERRYDUNN_HQ_CTX, url: 'https://news.example.com/berrydunn-hq' },
    'BerryDunn', '', false
  );
  assert(canonicalTemplateFamily(displayLabelForEventType(berryDunnHqSignal.canonicalEventType)) === 'facility', `REQUIRED: BerryDunn's genuine HQ relocation persists a facility-family canonicalEventType (got ${berryDunnHqSignal.canonicalEventType})`);
  assert(berryDunnHqSignal.reasonToReachOut === sellerCopyForTemplateFamily('facility').reasonToReachOut, `REQUIRED: BerryDunn's HQ relocation still renders the facility-family guidance, location/facility copy remains correct (got "${berryDunnHqSignal.reasonToReachOut}")`);

  const berryDunnAwardSignal = makeAISignal(
    { signalTitle: BERRYDUNN_AWARD_TITLE, whatChanged: BERRYDUNN_AWARD_CTX },
    { title: BERRYDUNN_AWARD_TITLE, snippet: BERRYDUNN_AWARD_CTX, url: 'https://news.example.com/berrydunn-award' },
    'BerryDunn', '', false
  );
  assert(berryDunnAwardSignal.canonicalEventType === 'EVENT_AWARD', `REQUIRED: BerryDunn's award persists canonicalEventType EVENT_AWARD (got ${berryDunnAwardSignal.canonicalEventType})`);
  assert(!/hiring|onboarding|recruit|leadership change/i.test(berryDunnAwardSignal.reasonToReachOut), `REQUIRED: BerryDunn's award reasonToReachOut never claims Hiring or Leadership (got "${berryDunnAwardSignal.reasonToReachOut}")`);

  const easternPropaneSignal = makeAISignal(
    { signalTitle: EASTERN_PROPANE_TITLE, whatChanged: EASTERN_PROPANE_CTX },
    { title: EASTERN_PROPANE_TITLE, snippet: EASTERN_PROPANE_CTX, url: 'https://news.example.com/eastern-propane-hiring' },
    'Eastern Propane', '', false
  );
  assert(easternPropaneSignal.canonicalEventType === 'HIRING_ACTIVITY', `REQUIRED: Eastern Propane hiring guidance remains correct (got ${easternPropaneSignal.canonicalEventType})`);
  assert(/hiring|onboarding/i.test(easternPropaneSignal.reasonToReachOut), `REQUIRED: Eastern Propane's reasonToReachOut still renders hiring guidance (got "${easternPropaneSignal.reasonToReachOut}")`);
}

// 1c) api/research-batch.js's classifyLegacySignalActionability() -- the
// single canonical read boundary -- self-heals a row persisted with NO
// canonicalEventType (the pre-correction research-account.js shape) to the
// SAME classification and seller copy makeAISignal() now persists going
// forward, proving cross-endpoint agreement rather than two independently
// tuned tables.
{
  const legacyCianbroRow = { title: CIANBRO_TITLE, businessContext: CIANBRO_CTX }; // no canonicalEventType field at all
  const healed = classifyLegacySignalActionability(legacyCianbroRow);
  assert(healed.canonicalEventType === 'EVENT_CONFERENCE', `REQUIRED: a legacy Cianbro row with no canonicalEventType self-heals to EVENT_CONFERENCE at read time (got ${healed.canonicalEventType})`);
  assert(!/hiring|onboarding/i.test(healed.reasonToReachOut), `REQUIRED: the self-healed legacy Cianbro row's reasonToReachOut carries no Hiring claim (got "${healed.reasonToReachOut}")`);
  assert(healed.reasonToReachOut === sellerCopyForTemplateFamily('events').reasonToReachOut, 'REQUIRED: the self-healed copy is the SAME shared events-family copy makeAISignal() would have persisted -- one table, not two');

  const legacyBerryDunnThoughtRow = { title: BERRYDUNN_THOUGHT_TITLE, businessContext: BERRYDUNN_THOUGHT_CTX };
  const healedBerryDunn = classifyLegacySignalActionability(legacyBerryDunnThoughtRow);
  assert(healedBerryDunn.canonicalEventType === 'BUSINESS_ACTIVITY_UNKNOWN', `REQUIRED: a legacy BerryDunn thought-leadership row self-heals to the generic classification, not Facility (got ${healedBerryDunn.canonicalEventType})`);
  assert(!/facility|location launch/i.test(healedBerryDunn.reasonToReachOut), `REQUIRED: the self-healed BerryDunn row never claims Facility/Location Launch (got "${healedBerryDunn.reasonToReachOut}")`);

  // A row that ALREADY carries a real canonicalEventType (persisted by an
  // already-fixed endpoint) is trusted as-is -- the self-heal never
  // overwrites richer, grounded copy that already agrees.
  const freshRow = { title: CIANBRO_TITLE, businessContext: CIANBRO_CTX, canonicalEventType: 'EVENT_CONFERENCE', reasonToReachOut: 'A custom, grounded reason already computed at persist time.' };
  const notHealed = classifyLegacySignalActionability(freshRow);
  assert(notHealed.reasonToReachOut === undefined, 'sanity: a row that already carries canonicalEventType is left untouched by the self-heal (no reasonToReachOut override added)');
}

// ===========================================================================
// Item 2: single-token third-party promotion scoped to the local
// sentence/clause, not the whole snippet. The actual reproduced bug shape
// (roster/breadcrumb membership) plus the required regressions.
// ===========================================================================

// 2a) REQUIRED bug fix: bare roster/list/breadcrumb membership -- the
// company appears only as a structurally-delimited list entry with no
// grammatically-attached local clause at all -- must NOT promote, even
// though the page is saturated with genuine event vocabulary elsewhere.
{
  const snippet = 'ABC Convention > Past Events > 2026 > Schedule\nCianbro\nAcme Industrial\nNorthfield Supply';
  assert(isStandaloneSingleTokenMention('Cianbro', snippet) === false, 'REQUIRED (the actual reproduced bug): bare roster/breadcrumb membership does not promote a single-token mention, even on an event-vocabulary-saturated page');
  const grounding = verifyCandidateCompanyGrounding({
    title: 'ABC Convention Past Exhibitors',
    snippet,
    url: 'https://abcconvention.example.com/past-events/2026/schedule'
  }, { name: 'Cianbro' });
  assert(grounding.identityConfidence === 'possible', `REQUIRED: the generic roster/archive page remains a Possible Match, not a Business Signal (got '${grounding.identityConfidence}')`);
}

// 2b) REQUIRED: an explicit contextual claim in the SAME sentence/local
// clause corroborates -- "Mark Brooks represented Cianbro at the Maine CTE
// Business Summit" shape.
{
  const snippet = 'Mark Brooks represented Cianbro at the Maine CTE Business Summit this week.';
  assert(isStandaloneSingleTokenMention('Cianbro', snippet) === true, 'REQUIRED: an explicit same-sentence event claim promotes the single-token mention');
  const grounding = verifyCandidateCompanyGrounding({
    title: 'Community Business Roundup',
    snippet,
    url: 'https://localnews.example.com/cianbro-summit-roundup'
  }, { name: 'Cianbro' });
  assert(grounding.grounded === true && grounding.identityConfidence === 'unconfirmed', `REQUIRED: an explicit same-sentence claim reaches a legitimate (uncorroborated) Business Signal (got '${grounding.identityConfidence}')`);
}

// 2c) REQUIRED: an explicit same-sentence AWARD claim also corroborates.
{
  const snippet = 'Cianbro received the Regional Safety Excellence Award this quarter for its outstanding record.';
  assert(isStandaloneSingleTokenMention('Cianbro', snippet) === true, 'REQUIRED: an explicit same-sentence award claim promotes the single-token mention');
}

// 2d) REQUIRED preserve: sentence-initial common-noun coincidence still
// excluded (no business-activity family in the local clause).
{
  const snippet = 'Timberland covers thousands of acres of forest along the northern ridge.';
  assert(isStandaloneSingleTokenMention('Timberland', snippet) === false, 'REQUIRED preserve: "Timberland covers thousands of acres" remains excluded -- no business-activity claim in the local clause');
}

// 2e) REQUIRED: a different, larger company/entity in the same local clause
// stays a Possible Match -- the local-clause scoping must not accidentally
// widen promotion to a different named entity that merely shares the token.
{
  const snippet = 'Cianbro Logistics Group, a separate regional carrier, announced a new fleet expansion today.';
  assert(isStandaloneSingleTokenMention('Cianbro', snippet) === false, 'REQUIRED: "Cianbro Logistics Group" (a different, larger entity) is not a standalone mention of the "Cianbro" account -- the capitalized neighbor "Logistics" blocks promotion');
}

// ===========================================================================
// Item 3: exact self-social-handle corroboration.
// ===========================================================================

// 3a) REQUIRED: multi-word/punctuated company + exact compacted social
// handle -> corroborated. The founder's own headline example.
{
  assert(isExactSelfSocialHandleMatch('L.L.Bean', 'https://www.instagram.com/llbean') === true, 'REQUIRED: L.L.Bean -> @llbean is an exact compacted match');
  const grounding = verifyCandidateCompanyGrounding({
    title: 'L.L.Bean celebrates grand opening',
    snippet: 'We are so excited for our newest store opening this weekend!',
    url: 'https://www.instagram.com/llbean'
  }, { name: 'L.L.Bean' });
  assert(grounding.identityConfidence === 'confirmed', `REQUIRED: L.L.Bean's exact @llbean handle match confirms identity (got '${grounding.identityConfidence}')`);
}

// 3b) REQUIRED: near-match/different handle -> not corroborated.
{
  assert(isExactSelfSocialHandleMatch('L.L.Bean', 'https://www.instagram.com/llbeanoutlet') === false, 'REQUIRED: a near-match handle ("llbeanoutlet") does not exactly equal the compacted company name');
  assert(isExactSelfSocialHandleMatch('L.L.Bean', 'https://www.instagram.com/llbean_maine') === false, 'REQUIRED: a suffixed near-match handle does not exactly equal the compacted company name');
}

// 3c) REQUIRED: an unrelated social post merely mentioning a common word ->
// not corroborated (no exact handle equality at all).
{
  assert(isExactSelfSocialHandleMatch('L.L.Bean', 'https://www.instagram.com/mainehikingclub') === false, 'REQUIRED: an unrelated handle sharing no exact compacted form with the company name does not corroborate');
}

// 3d) Preserve: existing self-domain behavior unchanged (single-token only,
// exact SLD equality).
{
  assert(isExactSelfSocialHandleMatch('', '') === false, 'sanity: empty inputs never corroborate');
  const grounding = verifyCandidateCompanyGrounding({
    title: 'Unitil announces rate update',
    snippet: 'Unitil customers will see updated rates next quarter.',
    url: 'https://unitil.com/news/rate-update'
  }, { name: 'Unitil' });
  assert(grounding.identityConfidence === 'confirmed', 'preserve: existing exact self-DOMAIN corroboration is unaffected by the new social-handle check');
}

// 3e) Preserve: Wyman's/Timberland/Albany collision protections untouched
// by the new corroborator (none of these involve a social handle at all).
{
  const wymans = verifyCandidateCompanyGrounding({
    title: 'Careers at Oliver Wyman | A Marsh business',
    snippet: 'Oliver Wyman is hiring for several consulting roles this quarter.',
    url: 'https://careers.oliverwyman.example.com/roles'
  }, { name: "Wyman's" });
  assert(wymans.identityConfidence !== 'confirmed', `preserve: Oliver Wyman / Wyman's collision is unaffected by Item 3 -- never auto-confirms (got '${wymans.identityConfidence}')`);
}

// ===========================================================================
// Dashboard-side consistency: getReasonToReachOutTitle() (Prepare for Call
// header) reads the SAME canonicalSignalKind() for event/recognition/
// expansion kinds, not just hiring (already covered by
// test-live-qa-round3-corrections.js).
// ===========================================================================
{
  const DASHBOARD_SRC = loadDashboardSource();
  const SRC = [
    extractFn(DASHBOARD_SRC, 'findAccountForOpp'),
    extractFn(DASHBOARD_SRC, 'realPriorCategories'),
    extractRange(DASHBOARD_SRC, 'const CANONICAL_KIND_BY_EVENT_TYPE = {', 'function canonicalSignalKind(opp){'),
    extractFn(DASHBOARD_SRC, 'getReasonToReachOutTitle')
  ].join('\n\n');
  const sandbox = { accounts: [], console };
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\nthis.getReasonToReachOutTitle = getReasonToReachOutTitle;`, sandbox);
  const { getReasonToReachOutTitle } = sandbox;

  const conferenceTitle = getReasonToReachOutTitle({ canonicalEventType: 'EVENT_CONFERENCE', sourceUrl: 'https://example.com/cianbro-summit', isVerifiedSignalOpportunity: true });
  assert(conferenceTitle === 'Event activity creates a timely reason to check in', `REQUIRED: a canonical Conference/Summit opportunity's Prepare-for-Call header reads Event activity, not Hiring (got "${conferenceTitle}")`);

  const awardTitle = getReasonToReachOutTitle({ canonicalEventType: 'EVENT_AWARD', sourceUrl: 'https://example.com/berrydunn-award', isVerifiedSignalOpportunity: true });
  assert(awardTitle === 'Recognition creates a timely reason to check in', `REQUIRED: a canonical Award opportunity's Prepare-for-Call header reads Recognition, not Hiring or Leadership (got "${awardTitle}")`);

  const expansionTitle = getReasonToReachOutTitle({ canonicalEventType: 'NEW_LOCATION_OPENING', sourceUrl: 'https://example.com/berrydunn-hq', isVerifiedSignalOpportunity: true });
  assert(expansionTitle === 'Growth activity creates a timely reason to check in', `REQUIRED: BerryDunn's genuine HQ relocation still reads a Growth/expansion header (got "${expansionTitle}")`);

  const genericTitle = getReasonToReachOutTitle({ canonicalEventType: 'BUSINESS_ACTIVITY_UNKNOWN', sourceUrl: 'https://example.com/berrydunn-trailblazers', isVerifiedSignalOpportunity: true });
  assert(genericTitle === 'Business signal creates a reason to reach out', `REQUIRED: BerryDunn's generic thought-leadership piece falls to the generic header, never a mismatched specific claim (got "${genericTitle}")`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
