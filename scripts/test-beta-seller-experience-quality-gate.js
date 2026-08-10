// Beta Seller Experience -- Sprint 1: seller-quality policy evaluation.
//
// This is NOT a test of new UI. The founder's brief's product hierarchy
// (Why Now -> The Play -> Ideas to Send -> Why It Could Grow -> Recommended
// Contact -> How to Approach) and the redundant-field cleanup (Best Next
// Move / Opportunity Summary / Success Looks Like) were already implemented
// in a prior round and are already locked in by
// scripts/test-commercial-intelligence-card-ux.js. The gap this sprint
// found and closed is one layer deeper: nothing previously stopped a real,
// identity-confirmed, dated Business Activity Signal from taking a priority
// slot when commercial-intelligence generation correctly produced NO
// credible play (null commercialPlay, empty activationIdeas) for it -- a
// technically-real signal is not automatically a seller-worthy one. See
// hasCredibleActivationPlay() and its call site inside
// isPriorityEligibleOpportunity() (dashboard/index.html).
//
// This file proves the seller-quality PROPERTIES the founder's brief asked
// for, using the real production pipeline end to end (makeSignal() ->
// normalizeOpportunity() -> the real, verbatim dashboard/index.html
// eligibility/rendering/approach functions in a vm sandbox) -- not brittle
// string-matching on model prose:
//
//   1. Strong, specific plays (Northern Pool 50th anniversary, Dover Honda
//      parade sponsorship, Hannaford community giving, Impiricus new VP)
//      remain fully priority-eligible and render the full hierarchy.
//   2. Weak signals for which the real pipeline produces no credible play
//      (generic conference call, routine financial results, generic
//      corporate update -- the Gallagher/Kiniksa/Amoskeag-shaped cases the
//      founder named) are excluded from priority eligibility, not rescued
//      with fabricated generic merch language.
//   3. Follow-Up / Repeat-Pattern / Account-History opportunities (Dispatch
//      Goods and the existing temporal-integrity follow-up fixture) are
//      completely unaffected -- they were never gated on commercialPlay/
//      activationIdeas and still are not.
//   4. The "How to Approach" text for an eligible, upcoming, concept-led
//      opportunity is a concise, permission-based ask that references the
//      real play -- never a product pitch, never a generic "creating any
//      internal or customer-facing needs" non-answer.
//
// Usage: node scripts/test-beta-seller-experience-quality-gate.js
import { makeSignal } from '../api/research-batch.js';
import { normalizeOpportunity, normalizeCommercialIntelligence, isGenericCommercialPlay } from '../api/signal-intelligence.js';
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const NOW = new Date('2026-08-10T12:00:00Z');
const daysAgo = n => { const d = new Date(NOW.getTime() - n*86400000); return d.toISOString().slice(0,10); };
const daysAhead = n => { const d = new Date(NOW.getTime() + n*86400000); return d.toISOString().slice(0,10); };

// ===========================================================================
// Section A -- real production pipeline (makeSignal/normalizeOpportunity),
// same convention as scripts/test-temporal-integrity-fixtures.js.
// ===========================================================================
function buildOpportunity(raw, account = {}){
  const signal = makeSignal(raw, account);
  if(!signal) return null;
  return normalizeOpportunity(signal, { name: signal.accountName, ...account });
}
function asBusinessOpportunity(opp){
  return { ...opp, isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', account: opp.accountName };
}

// ===========================================================================
// Section B -- dashboard/index.html real, verbatim source in a vm sandbox
// (same proven extraction ranges as scripts/test-temporal-integrity-fixtures.js
// and scripts/test-commercial-intelligence-card-ux.js).
// ===========================================================================
const DASHBOARD_SRC = loadDashboardSource();
const TIMEBOX_CONFIG_SRC = extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG');
const IS_RELATIONSHIP_EXPANSION_SRC = extractFn(DASHBOARD_SRC, 'isRelationshipExpansionOpportunity');
const DEDUPE_AND_IDENTITY_BLOCK = extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(', 'function isWebResearchSignal(opp){');
const CARD_AND_MODAL_BLOCK = extractRange(DASHBOARD_SRC, 'function confidenceLabel(', 'function isSignalPriorityEligible(');
const SALES_PLAY_BLOCK = extractRange(DASHBOARD_SRC, 'function salesPlayModeFromOpp(', 'function renderPipelineTable(');
const SCORING_AND_TIMEBOX_BLOCK = extractRange(DASHBOARD_SRC, 'function normalizeSignalLayerType(', 'function feedSummary(');
const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
const FMT_MONEY_SRC = extractFn(DASHBOARD_SRC, 'fmtMoney');
const CLAMP_SCORE_SRC = extractFn(DASHBOARD_SRC, 'clampScore');

function makeSandbox(){
  const fakeModal = { querySelector: () => ({ focus(){} }), querySelectorAll: () => [] };
  const sandbox = {
    console,
    window: { accountRadarAccounts: [], HouseAccountsHeader: { beginOverlay(){} } },
    document: {
      getElementById: () => ({ textContent: '', innerHTML: '', style: {} }),
      querySelectorAll: () => [],
      body: {
        insertAdjacentHTML(pos, html){ sandbox.__lastSalesPlayHtml = html; },
        get lastElementChild(){ return fakeModal; }
      }
    },
    isWarmAccount: () => false,
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  const fullSource = [
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    ESCAPE_HTML_SRC,
    FMT_MONEY_SRC,
    CLAMP_SCORE_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    CARD_AND_MODAL_BLOCK,
    SALES_PLAY_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'beta-seller-experience-extract.js' }).runInContext(sandbox);
  return sandbox;
}
const sandbox = makeSandbox();

for (const fn of [sandbox.isPriorityEligibleOpportunity, sandbox.hasCredibleActivationPlay, sandbox.getSuggestedOpener, sandbox.conceptLedApproach, sandbox.renderRepOpportunityCard]){
  assert(typeof fn === 'function', `extraction produced a real function (${fn && fn.name})`);
}

// ===========================================================================
// STRONG EXAMPLES -- Route 236-shaped signals for which a real research pass
// plausibly produces a specific, credible play. Each stays priority-eligible
// and its card/approach text reflects the play, not a generic non-answer.
// ===========================================================================
const STRONG_CASES = [
  {
    label: 'Northern Pool & Spa (50th anniversary)',
    account: { name: 'Northern Pool & Spa' },
    raw: {
      accountName: 'Northern Pool & Spa',
      sourceUrl: 'https://example.com/northern-pool-50th',
      signalTitle: 'Northern Pool & Spa 50th Anniversary',
      concrete_trigger: 'Northern Pool & Spa is celebrating its 50th anniversary in 2026',
      business_context: 'Northern Pool & Spa was founded in 1976, making 2026 its 50th anniversary, and it recently became connected with the larger Azureon organization.',
      event_date: daysAgo(5),
      publicationDate: daysAgo(5),
      confidence: 88,
      commercialPlay: { concept: '50 Summers', narrative: 'Use the anniversary as a reason to create a limited collection celebrating 50 summers of backyard memories.' },
      activationIdeas: ['Premium pool/beach towels', 'Heritage hats', 'Installer/team workwear', 'Customer cooler kits']
    }
  },
  {
    label: 'Dover Honda (Holiday Parade sponsorship, upcoming)',
    account: { name: 'Dover Honda' },
    raw: {
      accountName: 'Dover Honda',
      sourceUrl: 'https://example.com/dover-honda-parade',
      signalTitle: 'Dover Honda Sponsors 2026 Dover Holiday Parade',
      concrete_trigger: 'the 2026 Holiday Parade sponsorship',
      business_context: 'Dover Honda announced it is the lead Platinum Sponsor for the 2026 Dover Holiday Parade.',
      event_date: daysAhead(45),
      publicationDate: daysAgo(2),
      confidence: 90,
      commercialPlay: { concept: 'Holiday Parade Sponsorship', narrative: 'Dover Honda is the lead Platinum Sponsor for the 2026 Dover Holiday Parade.' },
      activationIdeas: ['Take-home parade giveaways', 'Family winter hats', 'Staff sponsor-tent jackets']
    }
  },
  {
    label: 'Hannaford (community giving -> Good Neighbor Crew)',
    account: { name: 'Hannaford' },
    raw: {
      accountName: 'Hannaford',
      sourceUrl: 'https://example.com/hannaford-community-giving',
      signalTitle: 'Hannaford Expands Community Giving Program',
      concrete_trigger: 'Hannaford expanded its community giving program across its store network',
      business_context: 'Hannaford announced an expanded community giving program recognizing local store associates and community partners.',
      event_date: daysAgo(10),
      publicationDate: daysAgo(10),
      confidence: 85,
      commercialPlay: { concept: 'Good Neighbor Crew', narrative: 'Recognize the store associates who turn the community-giving program into local action with an earned patch and milestone crew kit.' },
      activationIdeas: ['Good Neighbor Crew patches', 'Milestone recognition pins', 'Volunteer-day team shirts']
    }
  },
  {
    label: 'Impiricus (new VP Marketing & Brand Growth)',
    account: { name: 'Impiricus' },
    raw: {
      accountName: 'Impiricus',
      sourceUrl: 'https://example.com/impiricus-new-vp',
      signalTitle: 'Impiricus Hires VP of Marketing & Brand Growth',
      concrete_trigger: 'Impiricus hired a new VP of Marketing & Brand Growth',
      business_context: 'Impiricus announced the hire of a new VP of Marketing & Brand Growth to lead its brand rollout.',
      event_date: daysAgo(7),
      publicationDate: daysAgo(7),
      confidence: 82,
      commercialPlay: { concept: 'Brand Growth Momentum', narrative: 'A newly hired VP of Marketing likely wants an early, visible internal win -- an employee culture refresh or onboarding-kit relaunch gives them a fast, tangible first move.' },
      activationIdeas: ['Employee onboarding kit refresh', 'New team culture apparel', 'Internal brand-launch swag for the rollout event']
    }
  }
];

for (const c of STRONG_CASES){
  const built = buildOpportunity(c.raw, c.account);
  assert(!!built, `${c.label}: makeSignal()/normalizeOpportunity() produce a real opportunity`);
  const opp = asBusinessOpportunity(built);

  const statusLine = sandbox.signalDateAndActionabilityLine(opp);
  assert(statusLine !== 'Date unavailable' && statusLine !== 'No longer current', `${c.label}: sanity -- the fixture's date is resolvable and current (got "${statusLine}")`);

  assert(sandbox.hasCredibleActivationPlay(opp) === true, `${c.label}: hasCredibleActivationPlay() recognizes the real, specific play`);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, `${c.label}: a specific, credible play keeps the opportunity priority-eligible`);

  const cardHtml = sandbox.renderRepOpportunityCard(opp);
  assert(cardHtml.indexOf('The Play') !== -1 && cardHtml.indexOf(c.raw.commercialPlay.concept) !== -1, `${c.label}: the priority card surfaces The Play with its real concept ("${c.raw.commercialPlay.concept}")`);
  assert(cardHtml.indexOf('Ideas to Send') !== -1, `${c.label}: the priority card surfaces Ideas to Send`);
}

// Dover Honda specifically: an upcoming, concept-led opportunity should get
// the Route 236-style permission-based approach text, not a generic
// non-answer -- this is the founder's own worked example. Preview QA round
// 2 policy correction: naming a concrete idea (even one containing a
// product-ish noun like "giveaways") INSIDE this permission-based template
// is the desired, sanctioned behavior -- isPermissionBasedConceptOffer() is
// the gate that actually distinguishes a grounded concept reference from a
// raw pitch, not mentionsProductOrMerchOffer() (which exists to catch an
// unprompted, unpermissioned pitch statement, a different shape entirely).
{
  const dover = STRONG_CASES.find(c => c.label.startsWith('Dover Honda'));
  const built = buildOpportunity(dover.raw, dover.account);
  const opp = asBusinessOpportunity(built);
  assert(opp.actionabilityStatus?.status === 'upcoming', 'Dover Honda fixture: sanity -- the parade sponsorship is upcoming, the branch conceptLedApproach() requires');
  const approach = sandbox.conceptLedApproach(opp);
  assert(!!approach, 'Dover Honda: conceptLedApproach() produces real permission-based text for an upcoming, concept-led opportunity');
  assert(/\?/.test(approach), `Dover Honda: the approach ends on a real permission-based question (got "${approach}")`);
  assert(/Dover Honda|parade|Parade/i.test(approach), `Dover Honda: the approach references the real signal, not a generic template (got "${approach}")`);
  // required policy correction: a concrete activation idea from this
  // fixture ("Take-home parade giveaways") is named directly, not filtered
  // out merely because it contains a product-ish word.
  assert(/giveaways/i.test(approach), `Dover Honda: the approach names the real, concrete activation idea directly rather than sterilizing it (got "${approach}")`);
  assert(sandbox.isPermissionBasedConceptOffer(approach, opp) === true, `Dover Honda: the assembled approach is recognized as a grounded, permission-based concept offer -- the correct gate for this shape (got "${approach}")`);
}

// ===========================================================================
// WEAK EXAMPLES -- Gallagher/Kiniksa/Amoskeag-shaped signals for which a
// real research pass produces NO credible play (the founder's confirmed
// production cases). Built via the real makeSignal() pathway with no
// commercialPlay/activationIdeas in `raw` -- exactly what the real pipeline
// produces for a signal it correctly declines to force a play onto.
// ===========================================================================
const WEAK_CASES = [
  {
    label: 'Generic routine conference call (Gallagher-shaped)',
    account: { name: 'Gallagher' },
    raw: {
      accountName: 'Gallagher',
      sourceUrl: 'https://example.com/gallagher-conference-call',
      signalTitle: 'Gallagher Holds Quarterly Investor Conference Call',
      concrete_trigger: 'Gallagher held its regularly scheduled quarterly investor conference call',
      business_context: 'Gallagher hosted its routine quarterly investor conference call to discuss financial results.',
      event_date: daysAgo(4),
      publicationDate: daysAgo(4),
      confidence: 80
    }
  },
  {
    label: 'Routine financial results announcement (Kiniksa-shaped)',
    account: { name: 'Kiniksa Pharmaceuticals' },
    raw: {
      accountName: 'Kiniksa Pharmaceuticals',
      sourceUrl: 'https://example.com/kiniksa-q2',
      signalTitle: 'Kiniksa Pharmaceuticals Q2 Financial Results Call',
      concrete_trigger: 'Kiniksa Pharmaceuticals reported its Q2 financial results',
      business_context: 'Kiniksa Pharmaceuticals held a call to report its Q2 financial results to investors.',
      event_date: daysAgo(6),
      publicationDate: daysAgo(6),
      confidence: 82
    }
  },
  {
    label: 'Generic corporate update, no clear audience/activation (Amoskeag-shaped)',
    account: { name: 'Amoskeag' },
    raw: {
      accountName: 'Amoskeag',
      sourceUrl: 'https://example.com/amoskeag-update',
      signalTitle: 'Amoskeag Provides Corporate Update',
      concrete_trigger: 'Amoskeag issued a general corporate update to shareholders',
      business_context: 'Amoskeag issued a general corporate update covering routine business matters.',
      event_date: daysAgo(8),
      publicationDate: daysAgo(8),
      confidence: 78
    }
  }
];

for (const c of WEAK_CASES){
  const built = buildOpportunity(c.raw, c.account);
  assert(!!built, `${c.label}: makeSignal()/normalizeOpportunity() still produce a real opportunity (a real, dated signal, just without a credible play)`);
  assert(built.commercialPlay === null && Array.isArray(built.activationIdeas) && built.activationIdeas.length === 0, `${c.label}: the real pipeline correctly produced no play/ideas for this signal (never fabricated)`);
  const opp = asBusinessOpportunity(built);

  const statusLine = sandbox.signalDateAndActionabilityLine(opp);
  assert(statusLine !== 'Date unavailable' && statusLine !== 'No longer current', `${c.label}: sanity -- exclusion is NOT a side effect of a date problem (got "${statusLine}")`);

  assert(sandbox.hasCredibleActivationPlay(opp) === false, `${c.label}: hasCredibleActivationPlay() correctly finds no credible play`);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, `required property: a technically real signal with no credible commercial play does not compete for a priority slot ("${c.label}")`);
}

// ===========================================================================
// NO-FABRICATION PROPERTY -- weak signals are never rescued by inventing
// generic merch language at the normalization layer itself.
// ===========================================================================
for (const c of WEAK_CASES){
  const normalized = normalizeCommercialIntelligence(c.raw);
  assert(normalized.commercialPlay === null, `${c.label}: normalizeCommercialIntelligence() itself never fabricates a commercialPlay for a signal that didn't produce one`);
  assert(Array.isArray(normalized.activationIdeas) && normalized.activationIdeas.length === 0, `${c.label}: normalizeCommercialIntelligence() itself never fabricates activationIdeas for a signal that didn't produce one`);
}
// And the inverse: if a generic non-answer WERE produced, the existing
// genericness gate (proven separately in test-commercial-play-quality-gate.js)
// still catches it -- confirms this sprint's new eligibility gate is a
// second, independent line of defense, not a replacement for the first.
{
  const genericAttempt = 'This could lead to a need for promotional products to support brand initiatives, such as branded materials for outreach and events.';
  assert(isGenericCommercialPlay(genericAttempt) === true, 'defense in depth: the existing genericness gate still rejects a generic non-answer narrative if the model produced one');
  const normalized = normalizeCommercialIntelligence({ commercialPlay: { narrative: genericAttempt } });
  assert(normalized.commercialPlay === null, 'defense in depth: a generic narrative normalizes to null, so hasCredibleActivationPlay() would correctly find nothing credible either way');
}

// ===========================================================================
// LEGACY GRANDFATHER POLICY (Preview QA round 2) -- a signal that predates
// commercial-intelligence generation entirely (isCommercialIntelligenceSignal()
// false: no commercialPlay/activationIdeas/expansionPotential keys at all,
// only an old narrative field like whyItMattersForPromo) is no longer
// automatically priority-eligible. These fixtures are hand-built to match
// the REAL shape a legacy DB row presents once loaded (a resolved
// actionabilityStatus/eventDate already on the object, no commercialPlay/
// activationIdeas keys at all) -- deliberately NOT run through makeSignal(),
// since makeSignal() always attaches those three keys and would misrepresent
// what a genuinely old, pre-feature row actually looks like.
// ===========================================================================
const LEGACY_WEAK_CASES = [
  {
    label: 'Gallagher (real confirmed production text, legacy shape)',
    opp: {
      account: 'Arthur J. Gallagher & Co.', accountName: 'Arthur J. Gallagher & Co.',
      isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal',
      signalTitle: '2Q 2026 Earnings Conference Call',
      sourceUrl: 'https://example.com/gallagher-2q-earnings',
      publicationDate: daysAgo(5),
      actionabilityStatus: { status: 'ongoing', isPriorityEligible: true },
      whyItMattersForPromo: 'This event may lead to promotional needs for materials to support the call and subsequent marketing efforts.'
    }
  },
  {
    label: 'Kiniksa (real confirmed production text, legacy shape)',
    opp: {
      account: 'Kiniksa Pharmaceuticals', accountName: 'Kiniksa Pharmaceuticals',
      isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal',
      signalTitle: 'Q2 2026 Financial Results Call',
      sourceUrl: 'https://example.com/kiniksa-q2-financial-results',
      publicationDate: daysAgo(6),
      actionabilityStatus: { status: 'ongoing', isPriorityEligible: true },
      whyItMattersForPromo: 'This is an opportunity for promotional products related to the event, such as branded materials for the webcast or investor relations kits.'
    }
  }
];
for (const c of LEGACY_WEAK_CASES){
  assert(sandbox.isCommercialIntelligenceSignal(c.opp) === false, `${c.label}: sanity -- this fixture is genuinely legacy-shaped (no commercialPlay/activationIdeas/expansionPotential keys at all)`);
  const line = sandbox.signalDateAndActionabilityLine(c.opp);
  assert(line !== 'Date unavailable' && line !== 'No longer current', `${c.label}: sanity -- exclusion is NOT a side effect of a date problem (got "${line}")`);
  assert(sandbox.hasCredibleActivationPlay(c.opp) === false, `${c.label}: hasCredibleActivationPlay() evaluates the legacy narrative itself rather than blanket-grandfathering it, and finds it generic`);
  assert(sandbox.isPriorityEligibleOpportunity(c.opp) === false, `required fix: a legacy Business Activity signal whose only narrative is a confirmed generic non-answer does not consume a priority slot ("${c.label}")`);
}

// Counter-proof: a legacy-shaped signal (same missing-keys shape as above)
// whose existing narrative describes a genuinely specific activation is NOT
// suppressed merely for being old -- "does not suppress strong legacy
// signals unnecessarily" is a real, tested property, not just a claim.
{
  const strongLegacy = {
    account: 'Northern Pool & Spa', accountName: 'Northern Pool & Spa',
    isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal',
    signalTitle: 'Northern Pool & Spa 50th Anniversary',
    sourceUrl: 'https://example.com/northern-pool-50th-legacy',
    publicationDate: daysAgo(4),
    actionabilityStatus: { status: 'ongoing', isPriorityEligible: true },
    whyItMattersForPromo: 'Use the 50th anniversary to build a limited "50 Summers" collection celebrating five decades of backyard memories, from heritage hats to installer team workwear.'
  };
  assert(sandbox.isCommercialIntelligenceSignal(strongLegacy) === false, 'strong-legacy fixture: sanity -- also genuinely legacy-shaped');
  assert(sandbox.hasCredibleActivationPlay(strongLegacy) === true, 'required property: a legacy narrative describing a real, specific activation is recognized as credible, not penalized for its old object shape');
  assert(sandbox.isPriorityEligibleOpportunity(strongLegacy) === true, 'required property: a strong legacy signal remains priority-eligible -- old schema shape alone never suppresses a genuinely good historical signal');
}

// ===========================================================================
// REGRESSION -- Follow-Up / Repeat-Pattern / Account-History opportunities
// (Dispatch Goods-style) are grounded in purchase history, not
// commercialPlay/activationIdeas, and are completely unaffected by the new
// gate: they are never classified as isWebResearchSignal(), so
// hasCredibleActivationPlay() is never consulted for them.
// ===========================================================================
{
  const dispatchGoodsLike = {
    account: 'Dispatch Goods',
    accountName: 'Dispatch Goods',
    signalLayerType: 'Account History',
    isVerifiedSignalOpportunity: false,
    opportunityType: 'expansion',
    sourceUrl: null,
    eventDate: daysAgo(30),
    actionabilityStatus: { status: 'ongoing', isPriorityEligible: true }
    // Deliberately no commercialPlay/activationIdeas/expansionPotential --
    // matches the real fixture in
    // scripts/test-preview-qa-round5-hydration-integration.js.
  };
  assert(sandbox.isWebResearchSignal(dispatchGoodsLike) === false, 'Dispatch Goods-style fixture: sanity -- an Account History opportunity is never classified as a web-research signal');
  assert(sandbox.isPriorityEligibleOpportunity(dispatchGoodsLike) === true, 'required regression: a Follow-Up/Account-History opportunity with no commercialPlay/activationIdeas remains fully priority-eligible -- the new gate never applies to it');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
