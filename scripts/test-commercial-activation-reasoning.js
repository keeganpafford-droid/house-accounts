// Beta Seller Experience -- Sprint 2: Commercial Activation Reasoning.
//
// Sprint 1 proved the QUALIFICATION layer: a real signal with no credible
// play no longer takes a priority slot. Preview QA then confirmed the
// remaining problem is upstream of qualification -- the commercial-
// intelligence GENERATION itself too often produces "this may create a
// need for promotional products" (a merchandise justification) instead of a
// real activation thesis (signal -> audience -> objective -> moment ->
// activation -> ideas -> expansion -> contact fit -> permission ask).
//
// This sprint deliberately does NOT bolt nine new persisted fields onto the
// schema. Audience/Objective/Moment/Fact-vs-Inference are SILENT reasoning
// steps inside the existing prompt (api/signal-intelligence.js's
// COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT, spliced into both
// api/research-account.js and api/research-batch.js) -- commercialPlay/
// activationIdeas/expansionPotential remain the only persisted commercial-
// intelligence fields, unchanged in shape.
//
// This file cannot call a live model, so it proves two different things
// honestly, not one thing dishonestly:
//   1. STRUCTURAL: the actual, live prompt text the model receives now
//      contains the activation-first framing and each reasoning-discipline
//      element the brief requires (not exact wording -- structural
//      presence of the discipline).
//   2. PIPELINE: gold-standard fixtures shaped like what a model correctly
//      following this discipline would produce, run through the REAL
//      downstream pipeline end to end (normalizeCommercialIntelligence(),
//      makeSignal(), normalizeOpportunity(), isPriorityEligibleOpportunity(),
//      renderRepOpportunityCard(), conceptLedApproach()) -- proving the
//      system correctly rewards a good activation thesis and correctly
//      declines a no-play signal, for all 13 named fixtures.
//
// Usage: node scripts/test-commercial-activation-reasoning.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { makeSignal } from '../api/research-batch.js';
import { normalizeOpportunity, normalizeCommercialIntelligence, isGenericCommercialPlay, COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT } from '../api/signal-intelligence.js';
import { signalToOpportunity } from '../api/get-dashboard.js';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const NOW = new Date('2026-08-10T12:00:00Z');
const daysAgo = n => { const d = new Date(NOW.getTime() - n*86400000); return d.toISOString().slice(0,10); };
const daysAhead = n => { const d = new Date(NOW.getTime() + n*86400000); return d.toISOString().slice(0,10); };

const RESEARCH_ACCOUNT_SRC = readFileSync(new URL('../api/research-account.js', import.meta.url), 'utf8');
const RESEARCH_BATCH_SRC = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');

// ===========================================================================
// SECTION A -- STRUCTURAL: the live prompt text actually contains the
// activation-first framing and each named reasoning-discipline element.
// ===========================================================================

// A1. The old "if I sold promotional products... is there a reason to
// reach out" / "senior promotional products account executive... buying
// moment... promotional products demand" framing anchored the WHOLE task to
// merchandise before the more careful audience/objective reasoning ever got
// a chance -- this is the diagnosed root cause. Both must be gone.
assert(!/if i sold promotional products/i.test(RESEARCH_ACCOUNT_SRC), 'research-account.js: the old merchandise-first persona question ("if I sold promotional products...") is gone');
assert(!/senior promotional products account executive/i.test(RESEARCH_BATCH_SRC), 'research-batch.js: the old "senior promotional products account executive" persona is gone');
assert(!/may create promotional products demand/i.test(RESEARCH_BATCH_SRC), 'research-batch.js: "a buying moment is a concrete event that may create promotional products demand" framing is gone');
assert(/real human moment/i.test(RESEARCH_ACCOUNT_SRC), 'research-account.js: the persona now centers on a real human moment before commercial translation');
assert(/real,? identifiable human moment/i.test(RESEARCH_BATCH_SRC), 'research-batch.js: the persona now centers on a real human moment before commercial translation');

// A2. FACT vs REASONABLE INFERENCE vs UNSUPPORTED ASSUMPTION discipline,
// using the founder's own Impiricus example verbatim as the concrete
// illustration a model can pattern-match against.
assert(/REASONABLE COMMERCIAL INFERENCE/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the shared fragment names "reasonable commercial inference" as a distinct, allowed category');
assert(/UNSUPPORTED ASSUMPTION/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the shared fragment names "unsupported assumption" as a distinct, prohibited category');
assert(/comprehensive rebrand/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment uses the founder\'s own confirmed example (Impiricus/"comprehensive rebrand") to illustrate the prohibited category concretely');

// A3. Four silent reasoning questions -- Audience, Objective, Moment,
// Activation (the brief's steps 2-5) -- in order, not just three.
assert(/1\.\s*AUDIENCE/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment labels reasoning step 1 as AUDIENCE');
assert(/2\.\s*OBJECTIVE/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment labels reasoning step 2 as OBJECTIVE');
assert(/3\.\s*MOMENT/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment labels reasoning step 3 as MOMENT -- new this sprint, was previously missing entirely');
assert(/4\.\s*ACTIVATION/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment labels reasoning step 4 as ACTIVATION');
assert(/who are the relevant audiences/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'sanity: the pre-existing audience-diversity instruction (Catalyst Investment Partners finding) survives unchanged');

// A4. The generic counterfactual test -- the brief's own sharpest,
// most model-actionable self-check.
assert(/every reference to promotional products.*disappeared/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment includes the founder\'s counterfactual genericness test ("if every reference to promotional products disappeared...")');

// A5. Named FUNDING/EARNINGS no-play discipline, upstream in the generation
// prompt itself -- not just downstream normalization filtering.
assert(/FUNDING AND EARNINGS.*SPECIFICALLY/is.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment calls out funding and earnings/financial-results signals BY NAME as weak-by-default categories');
assert(/\$20M raised/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment uses the founder\'s own "$20M raised is not itself a reason" framing');

// A6. Broadened non-answer phrase list includes the newly-named warning
// phrases, not just the original Impiricus-shaped ones.
assert(/increase brand visibility/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment\'s non-answer example list now includes "increase brand visibility"');
assert(/support marketing efforts/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment\'s non-answer example list now includes "support marketing efforts"');

// A7. Contact fit tied to the identified activation, reusing the existing
// recommendedBuyingTeam/likelyBuyers architecture rather than a new field.
assert(/own the activation/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment ties buying-team recommendation to actually owning the identified activation, not a generic department guess');

// A8. How to Approach: the concept-led permission-ask branch now also
// covers a genuinely recent-past follow-through moment (the Gallagher
// acquisition-integration case), not upcoming-only.
assert(/RECENT PAST event where a real follow-through moment/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment\'s permission-ask guidance now also covers a recent-past follow-through moment (e.g. a just-completed acquisition), not upcoming-only');

// A9. Live-QA round 2 -- "NO IDEA, NO PLAY" coupling instruction, explicit
// in the generation prompt itself (upstream of the downstream eligibility
// gate), directly targeting the confirmed Neural Trust/Black Hat failure
// mode: a real, specific-sounding commercialPlay paragraph with zero real
// activationIdeas.
assert(/NO IDEA, NO PLAY/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment explicitly couples commercialPlay to requiring at least one real activationIdea ("NO IDEA, NO PLAY")');
assert(/leave BOTH commercialPlay and activationIdeas empty/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment instructs leaving both fields empty together rather than submitting a play with nothing concrete behind it');

// A10. Live-QA round 2 -- the discovery-question anti-pattern the founder
// confirmed in production ("What promotional strategies are you
// considering...?", "How do you plan to engage...?") is now explicitly
// named and prohibited, not just implicitly discouraged.
assert(/outsources the thinking back to the buyer/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment explicitly names and prohibits the "ask the buyer what they are planning" discovery-question anti-pattern');
assert(/What promotional strategies are you considering/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment uses the founder\'s own confirmed Neural Trust production example of the prohibited question shape');

console.log('');

// ===========================================================================
// SECTION B -- NORMALIZATION: the broadened genericness gate catches the
// newly-named warning-phrase families without regressing on real
// specificity (defense in depth -- this is the SAME normalization layer
// Sprint 1 already exercised, now extended for this sprint's new phrases).
// ===========================================================================
const NEW_NON_ANSWERS = [
  'This could increase brand visibility.',
  'Branded materials may be needed for this.',
  'This could lead to a need for promotional products to support brand initiatives, such as branded materials for outreach and events.' // Sprint 1's confirmed Impiricus case, still caught
];
for (const phrase of NEW_NON_ANSWERS){
  assert(isGenericCommercialPlay(phrase) === true, `required: newly-named non-answer phrase is caught ("${phrase}")`);
}
const STRONGER_REWRITES = [
  // The brief's own weak -> stronger pairs. Only the STRONGER halves are
  // asserted here (never generic) -- the weak halves are exactly the
  // NEW_NON_ANSWERS-style phrases above.
  'Turn the new-location opening into a coordinated employee-and-customer launch moment.',
  'Turn the parade sponsorship into a tangible community activation for families and the Dover Honda team.',
  'Create a thoughtful welcome/integration moment for the acquired team as they join the Gallagher organization.',
  'A newly hired VP of Marketing likely wants an early, visible internal win -- an employee culture refresh or onboarding-kit relaunch gives them a fast, tangible first move.'
];
for (const narrative of STRONGER_REWRITES){
  assert(isGenericCommercialPlay(narrative) === false, `required: the brief's own "stronger" rewrite is never flagged generic ("${narrative.slice(0,60)}...")`);
  const result = normalizeCommercialIntelligence({ commercialPlay: { narrative } });
  assert(result.commercialPlay !== null && result.commercialPlay.narrative === narrative, `required: a specific activation-thesis narrative survives normalization unchanged ("${narrative.slice(0,60)}...")`);
}

console.log('');

// ===========================================================================
// SECTION C -- PIPELINE: gold-standard fixtures for the 13 named accounts,
// run through the real makeSignal()/normalizeOpportunity() pipeline. Each
// fixture represents what a model correctly following the activation-
// reasoning discipline would produce (this file cannot call a live model --
// see the file header). Strong fixtures must survive end to end with the
// full hierarchy; no-play fixtures must be excluded, never rescued.
// ===========================================================================
function buildOpportunity(raw, account = {}){
  const signal = makeSignal(raw, account);
  if(!signal) return null;
  return normalizeOpportunity(signal, { name: signal.accountName, ...account });
}
function asBusinessOpportunity(opp){
  return { ...opp, isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', account: opp.accountName };
}

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
      body: { insertAdjacentHTML(pos, html){ sandbox.__lastSalesPlayHtml = html; }, get lastElementChild(){ return fakeModal; } }
    },
    isWarmAccount: () => false,
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  const fullSource = [
    TIMEBOX_CONFIG_SRC, `let activeTimebox = 'week';`, `let showAllWeeklyPriorities = false;`,
    IS_RELATIONSHIP_EXPANSION_SRC, ESCAPE_HTML_SRC, FMT_MONEY_SRC, CLAMP_SCORE_SRC,
    DEDUPE_AND_IDENTITY_BLOCK, CARD_AND_MODAL_BLOCK, SALES_PLAY_BLOCK, SCORING_AND_TIMEBOX_BLOCK
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'commercial-activation-reasoning-extract.js' }).runInContext(sandbox);
  return sandbox;
}
const sandbox = makeSandbox();

// ---------------------------------------------------------------------------
// STRONG fixtures -- should survive end to end with the full hierarchy.
// ---------------------------------------------------------------------------
const STRONG_FIXTURES = [
  {
    label: '1. Northern Pool & Spa -- 50th Anniversary',
    account: { name: 'Northern Pool & Spa' },
    raw: {
      accountName: 'Northern Pool & Spa', sourceUrl: 'https://example.com/northern-pool-50th',
      signalTitle: 'Northern Pool & Spa 50th Anniversary',
      concrete_trigger: 'Northern Pool & Spa is celebrating its 50th anniversary in 2026',
      business_context: 'Northern Pool & Spa was founded in 1976, making 2026 its 50th anniversary.',
      event_date: daysAgo(5), publicationDate: daysAgo(5), confidence: 88,
      commercialPlay: { concept: '50 Summers', narrative: 'Use the anniversary as a reason to create a limited collection celebrating 50 summers of backyard memories, for employees, customers, and the community who have been part of the story.' },
      activationIdeas: ['Premium pool/beach towels', 'Heritage hats', 'Installer/team workwear']
    }
  },
  {
    label: '2. Dover Honda -- Holiday Parade sponsorship',
    account: { name: 'Dover Honda' },
    raw: {
      accountName: 'Dover Honda', sourceUrl: 'https://example.com/dover-honda-parade',
      signalTitle: 'Dover Honda Sponsors 2026 Dover Holiday Parade',
      concrete_trigger: 'the 2026 Holiday Parade sponsorship',
      business_context: 'Dover Honda announced it is the lead Platinum Sponsor for the 2026 Dover Holiday Parade.',
      event_date: daysAhead(45), publicationDate: daysAgo(2), confidence: 90,
      commercialPlay: { concept: 'Holiday Parade Sponsorship', narrative: 'Turn the parade sponsorship into a tangible community activation for families along the route and for the Dover Honda team representing the dealership.' },
      activationIdeas: ['Family take-home piece for the parade route', 'Team jackets for the sponsor tent']
    }
  },
  {
    label: '3. Hannaford -- Community Giving',
    account: { name: 'Hannaford' },
    raw: {
      accountName: 'Hannaford', sourceUrl: 'https://example.com/hannaford-community-giving',
      signalTitle: 'Hannaford Expands Community Giving Program',
      concrete_trigger: 'an expanded community giving program recognizing local store associates',
      business_context: 'Hannaford announced an expanded community giving program recognizing local store associates and community partners.',
      event_date: daysAgo(10), publicationDate: daysAgo(10), confidence: 85,
      commercialPlay: { concept: 'Good Neighbor Crew', narrative: 'Recognize the store associates who turn the community-giving program into local action with an earned patch and milestone crew kit.' },
      activationIdeas: ['Good Neighbor Crew patches', 'Volunteer-day team shirts']
    }
  },
  {
    label: '4. Impiricus -- VP Marketing & Brand Growth',
    account: { name: 'Impiricus' },
    raw: {
      accountName: 'Impiricus', sourceUrl: 'https://example.com/impiricus-new-vp',
      signalTitle: 'Impiricus Hires VP of Marketing & Brand Growth',
      concrete_trigger: 'the hire of a new VP of Marketing & Brand Growth',
      business_context: 'Impiricus announced the hire of a new VP of Marketing & Brand Growth.',
      event_date: daysAgo(7), publicationDate: daysAgo(7), confidence: 82,
      // Deliberately does NOT assert a rebrand exists (unsupported
      // assumption) -- only the inference that a new leader likely wants an
      // early, visible internal win.
      commercialPlay: { concept: 'Brand Growth Momentum', narrative: 'A newly hired VP of Marketing likely wants an early, visible internal win -- an employee culture refresh or onboarding-kit relaunch gives them a fast, tangible first move.' },
      activationIdeas: ['Employee onboarding kit refresh', 'New-hire culture welcome piece']
    }
  },
  {
    label: '5. Gallagher -- Wilson M. Beck acquisition',
    account: { name: 'Arthur J. Gallagher & Co.' },
    raw: {
      accountName: 'Arthur J. Gallagher & Co.', sourceUrl: 'https://example.com/gallagher-wilson-beck-acquisition',
      signalTitle: 'Gallagher Acquires Wilson M. Beck Insurance Agency',
      concrete_trigger: 'the Wilson M. Beck acquisition',
      business_context: 'Gallagher announced the acquisition of Wilson M. Beck Insurance Agency.',
      event_date: daysAgo(6), publicationDate: daysAgo(6), confidence: 88,
      commercialPlay: { concept: 'Welcome Integration Moment', narrative: 'Create a thoughtful welcome/integration moment for the incoming Wilson M. Beck team as they join the Gallagher organization.' },
      activationIdeas: ['Incoming-team welcome kit', 'Joint welcome event piece']
    }
  },
  {
    label: '8. Cirrus Systems -- product launch + community giveaway',
    account: { name: 'Cirrus Systems' },
    raw: {
      accountName: 'Cirrus Systems', sourceUrl: 'https://example.com/cirrus-solo-ice-launch',
      signalTitle: 'Cirrus Systems Launches Solo ICE System with Community Giveaway',
      concrete_trigger: 'the launch of the Solo ICE System paired with a community giveaway event',
      business_context: 'Cirrus Systems launched its Solo ICE System with a community giveaway event.',
      event_date: daysAgo(3), publicationDate: daysAgo(3), confidence: 90,
      commercialPlay: { concept: 'Solo ICE Launch Moment', narrative: 'The Solo ICE System launch paired with a community giveaway is a natural moment for a branded unveiling kit tied to the launch event and the attendees who showed up for it.' },
      activationIdeas: ['Launch-day attendee take-home piece', 'Team polos for the unveiling event']
    }
  },
  {
    label: '9. Sandwich Stampede -- festival',
    account: { name: 'Sandwich Stampede' },
    raw: {
      accountName: 'Sandwich Stampede', sourceUrl: 'https://example.com/sandwich-stampede-2026',
      signalTitle: 'Sandwich Stampede Festival',
      concrete_trigger: 'the annual Sandwich Stampede festival',
      business_context: 'The Sandwich Stampede festival drew thousands of attendees this year.',
      event_date: daysAgo(4), publicationDate: daysAgo(4), confidence: 80,
      commercialPlay: { concept: 'Stampede Team Experience', narrative: 'Build a coordinated experience for the volunteer team and VIP attendees who make the Sandwich Stampede run every year, not just a generic vendor tent.' },
      activationIdeas: ['Volunteer-team event shirts', 'VIP attendee take-home piece']
    }
  }
];

for (const c of STRONG_FIXTURES){
  const built = buildOpportunity(c.raw, c.account);
  assert(!!built, `${c.label}: makeSignal()/normalizeOpportunity() produce a real opportunity`);
  assert(isGenericCommercialPlay(c.raw.commercialPlay.narrative) === false, `${c.label}: sanity -- the gold commercialPlay narrative is never flagged generic`);
  const opp = asBusinessOpportunity(built);
  const statusLine = sandbox.signalDateAndActionabilityLine(opp);
  assert(statusLine !== 'Date unavailable' && statusLine !== 'No longer current', `${c.label}: sanity -- the fixture's date is resolvable and current (got "${statusLine}")`);
  assert(sandbox.hasCredibleActivationPlay(opp) === true, `${c.label}: hasCredibleActivationPlay() recognizes the real activation thesis`);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, `${c.label}: a real activation thesis keeps the opportunity priority-eligible`);
  const cardHtml = sandbox.renderRepOpportunityCard(opp);
  assert(cardHtml.indexOf('The Play') !== -1 && cardHtml.indexOf(c.raw.commercialPlay.concept) !== -1, `${c.label}: the priority card surfaces The Play with its real concept ("${c.raw.commercialPlay.concept}")`);
  assert(cardHtml.indexOf('Ideas to Send') !== -1, `${c.label}: the priority card surfaces Ideas to Send`);
}

// Gallagher acquisition specifically exercises this sprint's recent-past
// widening of conceptLedApproach() -- an already-happened event, not an
// upcoming one, still gets a concept-led permission ask.
{
  const gallagher = STRONG_FIXTURES.find(c => c.label.startsWith('5.'));
  const built = buildOpportunity(gallagher.raw, gallagher.account);
  const opp = asBusinessOpportunity(built);
  // ACQUISITION is not in EVENT_LIKE_TYPES (frozen classification), so it
  // resolves to 'ongoing', never 'upcoming'/'recent-past' -- this IS the
  // real-world case the widening needs to cover, not a fixture error.
  assert(opp.actionabilityStatus?.status === 'ongoing', `Gallagher fixture: sanity -- an acquisition resolves to 'ongoing' under the frozen classification system (not 'recent-past'), exercising this sprint's widened conceptLedApproach() branch (got "${opp.actionabilityStatus?.status}")`);
  const approach = sandbox.conceptLedApproach(opp);
  assert(!!approach, 'Gallagher: conceptLedApproach() now produces a concept-led approach for a recent-past acquisition, not just upcoming events');
  assert(/\?/.test(approach), `Gallagher: the approach ends on a real permission-based question (got "${approach}")`);
  assert(!/coming up/i.test(approach), `Gallagher: the approach never uses future-facing "coming up" phrasing for an already-completed acquisition (got "${approach}")`);
  assert(/Gallagher|Wilson M\. Beck|acquisition/i.test(approach), `Gallagher: the approach references the real signal (got "${approach}")`);
  assert(sandbox.isPermissionBasedConceptOffer(approach, opp) === true, `Gallagher: the approach is recognized as a grounded, permission-based concept offer (got "${approach}")`);
}

console.log('');

// ---------------------------------------------------------------------------
// NO-PLAY fixtures -- funding/earnings/financial-results alone. Built via
// the real makeSignal() pathway with NO commercialPlay/activationIdeas in
// `raw` -- exactly the correct output for a model that follows this
// sprint's named funding/earnings no-play discipline.
// ---------------------------------------------------------------------------
const NO_PLAY_FIXTURES = [
  {
    label: '10. Neural Trust -- $20M Seed Round (funding only)',
    account: { name: 'Neural Trust' },
    raw: {
      accountName: 'Neural Trust', sourceUrl: 'https://example.com/neural-trust-seed',
      signalTitle: 'Neural Trust Raises $20M Seed Round',
      concrete_trigger: 'Neural Trust raised a $20M seed round',
      business_context: 'Neural Trust announced it raised a $20M seed round led by its investors.',
      event_date: daysAgo(5), publicationDate: daysAgo(5), confidence: 85
    }
  },
  {
    label: '11. Catalyst Investment Partners -- financing only',
    account: { name: 'Catalyst Investment Partners' },
    raw: {
      accountName: 'Catalyst Investment Partners', sourceUrl: 'https://example.com/catalyst-financing',
      signalTitle: 'Catalyst Investment Partners Announces New Financing',
      concrete_trigger: 'Catalyst Investment Partners announced new financing',
      business_context: 'Catalyst Investment Partners announced a new round of financing for its portfolio.',
      event_date: daysAgo(6), publicationDate: daysAgo(6), confidence: 80
    }
  },
  {
    label: '12. Gallagher earnings call (routine)',
    account: { name: 'Arthur J. Gallagher & Co.' },
    raw: {
      accountName: 'Arthur J. Gallagher & Co.', sourceUrl: 'https://example.com/gallagher-2q-earnings',
      signalTitle: '2Q 2026 Earnings Conference Call',
      concrete_trigger: 'Gallagher held its regularly scheduled quarterly earnings conference call',
      business_context: 'Gallagher hosted its routine quarterly earnings conference call to discuss financial results.',
      event_date: daysAgo(4), publicationDate: daysAgo(4), confidence: 80
    }
  },
  {
    label: '13. Kiniksa financial-results call (routine)',
    account: { name: 'Kiniksa Pharmaceuticals' },
    raw: {
      accountName: 'Kiniksa Pharmaceuticals', sourceUrl: 'https://example.com/kiniksa-q2',
      signalTitle: 'Kiniksa Pharmaceuticals Q2 Financial Results Call',
      concrete_trigger: 'Kiniksa Pharmaceuticals reported its Q2 financial results',
      business_context: 'Kiniksa Pharmaceuticals held a call to report its Q2 financial results to investors.',
      event_date: daysAgo(6), publicationDate: daysAgo(6), confidence: 82
    }
  }
];
for (const c of NO_PLAY_FIXTURES){
  const built = buildOpportunity(c.raw, c.account);
  assert(!!built, `${c.label}: makeSignal()/normalizeOpportunity() still produce a real opportunity -- a real, dated signal, just without a credible activation`);
  assert(built.commercialPlay === null && Array.isArray(built.activationIdeas) && built.activationIdeas.length === 0, `${c.label}: no play/ideas were fabricated for a funding/earnings-only signal`);
  const opp = asBusinessOpportunity(built);
  const statusLine = sandbox.signalDateAndActionabilityLine(opp);
  assert(statusLine !== 'Date unavailable' && statusLine !== 'No longer current', `${c.label}: sanity -- exclusion is not a side effect of a date problem (got "${statusLine}")`);
  assert(sandbox.hasCredibleActivationPlay(opp) === false, `${c.label}: hasCredibleActivationPlay() correctly finds no credible activation`);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, `required property (NO-PLAY discipline): funding/earnings alone does not consume a priority slot ("${c.label}")`);
}

// Counter-proof required by the brief: funding is weak "by itself", but a
// funding signal that ALSO discloses a concrete downstream initiative
// (a stated hiring push) should be reasoned from that initiative, not
// blanket-rejected merely because "funding" appears in the text.
{
  const fundingWithHiringPush = buildOpportunity({
    accountName: 'Neural Trust', sourceUrl: 'https://example.com/neural-trust-seed-hiring',
    signalTitle: 'Neural Trust Raises $20M Seed Round to Fund Engineering Hiring Push',
    concrete_trigger: 'Neural Trust raised a $20M seed round earmarked for a stated engineering hiring push',
    business_context: 'Neural Trust announced a $20M seed round and a stated plan to hire 15 new engineers this quarter.',
    event_date: daysAgo(5), publicationDate: daysAgo(5), confidence: 85,
    commercialPlay: { concept: 'New Team Welcome Wave', narrative: 'The stated engineering hiring push behind this raise is a reason to build a coordinated welcome/onboarding moment for the wave of new hires arriving this quarter.' },
    activationIdeas: ['New-hire welcome kit', 'Team onboarding-day piece']
  }, { name: 'Neural Trust' });
  const opp = asBusinessOpportunity(fundingWithHiringPush);
  assert(sandbox.hasCredibleActivationPlay(opp) === true, 'required property: funding WITH a disclosed concrete initiative (a stated hiring push) can carry a real activation -- the no-play rule is about funding/earnings ALONE, not a blanket ban on the word "funding"');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'required property: the funding-plus-disclosed-initiative fixture remains priority-eligible');
}

console.log('');

// ===========================================================================
// SECTION D -- Live-QA round 2 corrections.
// ===========================================================================

// D1. HYDRATION REGRESSION (the confirmed root cause of "fresh signals lack
// activationIdeas in Prepare for Call"): api/get-dashboard.js's
// signalToOpportunity() previously built its return object from an explicit
// field list that never included commercialPlay/activationIdeas/
// expansionPotential, even though rowToSignal() (which it calls) already
// exposed them correctly via {...payload}. Proven directly against the
// real, exported signalToOpportunity() -- not a reimplementation.
{
  const freshRow = {
    account_name: 'Neural Trust', upload_id: 'upload-1', source_url: 'https://example.com/neural-trust-blackhat',
    source_domain: 'example.com', title: 'Neural Trust Participation at Black Hat USA 2026',
    signal_type: 'Trade Show', confidence: 85, published_at: daysAgo(3), first_seen_at: daysAgo(3), last_seen_at: daysAgo(3),
    payload: {
      accountName: 'Neural Trust', signalTitle: 'Neural Trust Participation at Black Hat USA 2026',
      sourceUrl: 'https://example.com/neural-trust-blackhat', publicationDate: daysAgo(3),
      actionabilityStatus: { status: 'ongoing' },
      commercialPlay: { concept: 'Black Hat Follow-Up Moment', narrative: 'Use the Black Hat presence as a reason to build a differentiated follow-up piece for the security researchers and prospects who stop by the booth.' },
      activationIdeas: ['Booth follow-up piece for attendees', 'Team gear for the booth staff'],
      expansionPotential: { narrative: 'A strong showing here could become a recurring annual conference-presence program.', tags: ['recurring-program'] }
    }
  };
  const opp = signalToOpportunity(freshRow);
  assert(opp.commercialPlay && opp.commercialPlay.concept === 'Black Hat Follow-Up Moment', 'required fix: signalToOpportunity() now carries a fresh row\'s real commercialPlay through onto the top-level opportunity object');
  assert(Array.isArray(opp.activationIdeas) && opp.activationIdeas.length === 2, 'required fix: signalToOpportunity() now carries a fresh row\'s real activationIdeas through (previously always silently dropped)');
  assert(opp.expansionPotential && opp.expansionPotential.narrative, 'required fix: signalToOpportunity() now carries a fresh row\'s real expansionPotential through');
  assert(sandbox.isCommercialIntelligenceSignal(opp) === true, 'required fix: a freshly-hydrated signal with real commercial intelligence is correctly classified as a new-schema signal, not misclassified as legacy');
}
// Legacy-absence must still be preserved -- a truly pre-feature row (no
// commercialPlay/activationIdeas/expansionPotential keys at all in its
// payload) must NOT be coerced into looking like a fresh, idea-less signal
// (which would wrongly subject it to the stricter fresh-schema bar instead
// of its own legacy-narrative bar). This is the regression this fix's first
// attempt actually caused (caught by the full suite) before activationIdeas'
// mapping was corrected to preserve `undefined`, not coerce to [].
{
  const legacyRow = {
    account_name: 'Dispatch Goods', upload_id: 'upload-1', source_url: 'https://santacruzworks.org/articles/dispatch-goods-follow-on',
    source_domain: 'santacruzworks.org', title: 'Follow-on Investment from Santa Cruz Ventures',
    signal_type: 'Funding', confidence: 78, published_at: daysAgo(20), first_seen_at: daysAgo(20), last_seen_at: daysAgo(20),
    payload: {
      accountName: 'Dispatch Goods', signalTitle: 'Follow-on Investment from Santa Cruz Ventures',
      sourceUrl: 'https://santacruzworks.org/articles/dispatch-goods-follow-on',
      signalSummary: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods, indicating confidence in their business model.',
      publicationDate: daysAgo(20), actionabilityStatus: { status: 'ongoing' }
      // Deliberately no commercialPlay/activationIdeas/expansionPotential --
      // a genuinely pre-feature row.
    }
  };
  const opp = signalToOpportunity(legacyRow);
  assert(opp.commercialPlay === null, 'required property: a truly legacy row\'s commercialPlay stays null (never fabricated)');
  assert(!Array.isArray(opp.activationIdeas), 'required property: a truly legacy row\'s activationIdeas stays non-array (undefined), never coerced to [] -- preserves the legacy/fresh-idea-less distinction isCommercialIntelligenceSignal() depends on');
  assert(sandbox.isCommercialIntelligenceSignal(opp) === false, 'required property: a truly legacy row is still correctly classified as legacy, not as a fresh signal with zero ideas');
}

// D2. "NO IDEA, NO PRIORITY" pipeline proof -- the exact Neural Trust/Black
// Hat live-QA failure mode: a real, specific commercialPlay narrative with
// ZERO real activationIdeas must now be excluded from priority, never
// rescued by falling back to a generic "what are you planning" question.
{
  const playNoIdeas = buildOpportunity({
    accountName: 'Neural Trust', sourceUrl: 'https://example.com/neural-trust-blackhat-weak',
    signalTitle: 'Neural Trust Participation at Black Hat USA 2026',
    concrete_trigger: 'Neural Trust is participating in Black Hat USA 2026',
    business_context: 'Neural Trust announced its participation in Black Hat USA 2026.',
    event_date: daysAgo(3), publicationDate: daysAgo(3), confidence: 85,
    // Exactly the live-QA failure shape: a plausible-sounding play, but no
    // real ideas behind it.
    commercialPlay: { narrative: 'With the presence at Black Hat, Neural Trust may be looking to create a strong brand impression and could consider an event engagement strategy.' },
    activationIdeas: []
  }, { name: 'Neural Trust' });
  assert(playNoIdeas.commercialPlay !== null, 'sanity: this fixture\'s narrative is specific enough to survive normalization (not caught by the generic-phrase gate) -- isolating the NO IDEA property, not re-testing genericness');
  const opp = asBusinessOpportunity(playNoIdeas);
  const statusLine = sandbox.signalDateAndActionabilityLine(opp);
  assert(statusLine !== 'Date unavailable' && statusLine !== 'No longer current', `Black Hat no-ideas fixture: sanity -- exclusion is not a side effect of a date problem (got "${statusLine}")`);
  assert(sandbox.hasCredibleActivationPlay(opp) === false, 'required property (NO IDEA, NO PRIORITY): a real commercialPlay narrative with zero activationIdeas is NOT credible');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'required property (NO IDEA, NO PRIORITY): this signal does not consume a priority slot despite having a plausible-sounding play');
  assert(sandbox.conceptLedApproach(opp) === null, 'required property: conceptLedApproach() never fires with zero real ideas, regardless of how specific the play narrative reads');
}
// Contrast: real ideas present, but commercialPlay itself is null (e.g.
// filtered as generic, or simply omitted) -- this must NOW succeed, closing
// the gap the stricter idea-only rule was designed to close.
{
  const ideasNoPlay = buildOpportunity({
    accountName: 'Neural Trust', sourceUrl: 'https://example.com/neural-trust-blackhat-strong',
    signalTitle: 'Neural Trust Participation at Black Hat USA 2026',
    concrete_trigger: 'Neural Trust participation at Black Hat USA 2026',
    business_context: 'Neural Trust announced its participation in Black Hat USA 2026.',
    event_date: daysAgo(3), publicationDate: daysAgo(3), confidence: 85,
    commercialPlay: null,
    activationIdeas: ['Booth follow-up piece for security researchers who visit', 'Team polos for booth staff']
  }, { name: 'Neural Trust' });
  const opp = asBusinessOpportunity(ideasNoPlay);
  assert(sandbox.hasCredibleActivationPlay(opp) === true, 'required property: real activationIdeas alone are sufficient for credibility, even with a null commercialPlay');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'required property: this signal is priority-eligible on its real ideas alone');
  const approach = sandbox.conceptLedApproach(opp);
  assert(!!approach, 'required property: conceptLedApproach() now produces a real approach from real ideas even when commercialPlay is null');
  assert(/Booth follow-up piece/.test(approach), `conceptLedApproach() names the real idea (got "${approach}")`);

  // D3. Founder confirmation round: does EITHER surface fall back to a
  // generic legacy/promo narrative for this exact ideas-only fresh state?
  // "The Play" (both the priority card's renderOpportunitySection() and
  // Prepare for Call's renderThePlaySection()) is gated on
  // getCommercialPlayNarrative(), which for a signal correctly classified
  // isCommercialIntelligenceSignal()===true ONLY ever reads
  // opp.commercialPlay.narrative -- it never falls through to legacy
  // whyNow/reasonToReachOut fields in that branch. Proven directly: both
  // sections render nothing (hidden), not a generic substitute.
  const cardPlayHtml = sandbox.renderOpportunitySection(opp);
  const prepareCallPlayHtml = sandbox.renderThePlaySection(opp);
  assert(cardPlayHtml === '', `required property: the priority card's The Play section renders NOTHING (hidden) for an ideas-only signal, never a fallback to generic legacy text (got "${cardPlayHtml}")`);
  assert(prepareCallPlayHtml === '', `required property: Prepare for Call's The Play section renders NOTHING (hidden) for an ideas-only signal, never a fallback to generic legacy text (got "${prepareCallPlayHtml}")`);
  // Confirmed real gap (found while answering this question, now fixed):
  // Research Details' separate "Why it matters" row is NOT gated the same
  // way -- it reads signal.whyNow/reasonToReachOut directly, which resolve
  // server-side (research-batch.js's meaningfulWhyThisMatters() ->
  // salesReadyWhy()) to a generic category-template sentence
  // ("...usually create needs around...") whenever no real narrative was
  // ever supplied -- exactly the catalog-dump pattern this sprint targets,
  // just surfacing under a different label. Fixed to prefer the real,
  // specific activationIdeas over that generic template.
  const researchDetailsHtml = sandbox.renderSingleVerifiedSignal(opp);
  assert(/We have specific ideas for this/.test(researchDetailsHtml), `required fix: Research Details' "Why it matters" line now prefers the real activationIdeas over a generic template for an ideas-only signal (got relevant excerpt: "${(researchDetailsHtml.match(/Why it matters:.*?<\/div>/s) || [''])[0]}")`);
  assert(!/usually (create|require|need)/i.test(researchDetailsHtml), `required fix: Research Details never surfaces the generic salesReadyWhy()-style catalog template for an ideas-only signal (got "${(researchDetailsHtml.match(/Why it matters:.*?<\/div>/s) || [''])[0]}")`);
}

// D4. "NO GROUNDED ACTIVATION, NO PRIORITY" -- the founder's live-QA
// correction to "NO IDEA, NO PRIORITY": the model can satisfy "produce a
// real activationIdea" by manufacturing one for the funding/financial event
// ITSELF, confidently phrased (no hedge word), which defeats the original
// hedge-based genericness check. Confirmed real production case: Neural
// Trust's $20M seed round still showing a "Brand Visibility Campaign" play
// with a "funding-announcement launch kit" idea. Run through the REAL
// pipeline end to end (not just isGenericCommercialPlay() in isolation).
{
  const fundingDressedUp = buildOpportunity({
    accountName: 'Neural Trust', sourceUrl: 'https://example.com/neural-trust-seed-live',
    signalTitle: 'Neural Trust Secures $20M Seed Round',
    concrete_trigger: 'Neural Trust secured a $20M seed round',
    business_context: 'Neural Trust announced it secured a $20M seed round.',
    event_date: daysAgo(4), publicationDate: daysAgo(4), confidence: 85,
    commercialPlay: { concept: 'Brand Visibility Campaign', narrative: 'Neural Trust just secured a $20M seed round, which is a great opportunity to run a brand visibility campaign celebrating the milestone.' },
    activationIdeas: ['Funding announcement launch kit', 'Social media campaign for the seed round']
  }, { name: 'Neural Trust' });
  assert(fundingDressedUp.commercialPlay === null, 'required fix: normalizeCommercialIntelligence() now nulls out a confidently-phrased (non-hedged) funding-event-dressed-as-activation commercialPlay narrative, not just hedged non-answers');
  assert(Array.isArray(fundingDressedUp.activationIdeas) && fundingDressedUp.activationIdeas.length === 0, 'required fix: normalizeCommercialIntelligence() filters out funding-event-dressed activationIdeas ("funding announcement launch kit", "social media campaign for the seed round"), not just bare category words');
  const opp = asBusinessOpportunity(fundingDressedUp);
  const statusLine = sandbox.signalDateAndActionabilityLine(opp);
  assert(statusLine !== 'Date unavailable' && statusLine !== 'No longer current', `Neural Trust funding-dressed fixture: sanity -- exclusion is not a side effect of a date problem (got "${statusLine}")`);
  assert(sandbox.hasCredibleActivationPlay(opp) === false, 'required property (NO GROUNDED ACTIVATION, NO PRIORITY): a manufactured funding-announcement activation is not credible, even though the model technically populated both commercialPlay and activationIdeas');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'required property (NO GROUNDED ACTIVATION, NO PRIORITY): the exact confirmed Neural Trust production case no longer consumes a priority slot');
}
// Contrast: the SAME funding signal, but the evidence discloses a real
// downstream initiative and the play/ideas reference it (not the funding
// event itself) -- must still succeed. Proves the fix targets the
// funding-event-as-moment pattern specifically, not funding-adjacent
// language in general.
{
  const fundingWithRealInitiative = buildOpportunity({
    accountName: 'Neural Trust', sourceUrl: 'https://example.com/neural-trust-seed-hiring-2',
    signalTitle: 'Neural Trust Raises $20M to Fund Security Conference Push',
    concrete_trigger: 'Neural Trust raised $20M earmarked for an expanded security conference presence',
    business_context: 'Neural Trust announced a $20M raise earmarked for expanding its presence at security conferences this year.',
    event_date: daysAgo(4), publicationDate: daysAgo(4), confidence: 85,
    commercialPlay: { concept: 'Conference Push Kickoff', narrative: 'The funding round positions Neural Trust to expand its security conference presence -- worth building a coordinated booth and follow-up experience for the attendees who stop by.' },
    activationIdeas: ['Booth follow-up piece for conference attendees', 'Team gear for the booth staff']
  }, { name: 'Neural Trust' });
  assert(fundingWithRealInitiative.commercialPlay !== null, 'required property: a funding signal whose evidence discloses a real downstream initiative (conference push) and whose play references the real audience (attendees) still survives -- the fix targets funding-as-the-moment-itself, not funding-adjacent language generally');
  const opp = asBusinessOpportunity(fundingWithRealInitiative);
  assert(sandbox.hasCredibleActivationPlay(opp) === true, 'required property: this grounded funding-plus-initiative signal remains credible');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'required property: this grounded funding-plus-initiative signal remains priority-eligible');
}

console.log('');

// ---------------------------------------------------------------------------
// REGRESSION -- Follow-Up/Account-History opportunities (Dispatch Goods,
// Sprint 1's own regression fixture) remain completely unaffected.
// ---------------------------------------------------------------------------
{
  const dispatchGoodsLike = {
    account: 'Dispatch Goods', accountName: 'Dispatch Goods', signalLayerType: 'Account History',
    isVerifiedSignalOpportunity: false, opportunityType: 'expansion', sourceUrl: null,
    eventDate: daysAgo(30), actionabilityStatus: { status: 'ongoing', isPriorityEligible: true }
  };
  assert(sandbox.isWebResearchSignal(dispatchGoodsLike) === false, 'Dispatch Goods-style fixture: sanity -- an Account History opportunity is never classified as a web-research signal');
  assert(sandbox.isPriorityEligibleOpportunity(dispatchGoodsLike) === true, 'required regression: Follow-Up/Account-History opportunities remain fully priority-eligible, unaffected by this sprint');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
