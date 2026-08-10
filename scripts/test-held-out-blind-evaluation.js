// Beta Seller Experience -- Sprint 2, final validation round: HELD-OUT
// BLIND EVALUATION.
//
// Purpose: prove the commercial-activation reasoning contract generalizes
// to companies and scenarios that have NEVER appeared anywhere in the
// production prompt (COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT in
// api/signal-intelligence.js) or in any prior Sprint 1/2 fixture file --
// not a renamed Dover Honda/Hannaford, but genuinely new fictional
// companies and scenarios. Confirmed by direct repo-wide grep (see the
// companies below): none of these names appear in api/*.js or
// dashboard/index.html outside this file.
//
// This file cannot call a live model (see
// test-commercial-activation-reasoning.js's header for why), so exactly
// like that file, it proves two different things honestly:
//   1. The deterministic QUALITY GATES (isGenericCommercialPlay(),
//      isGenericActivationIdea(), hasCredibleActivationPlay(),
//      conceptLedApproach()) are CONTENT-based, not name-based -- they
//      correctly classify specific vs. generic text for companies they
//      have never seen, which is real, direct evidence against overfitting
//      (a name-memorizing system would have no basis to judge unseen names
//      at all; a content-based one judges every name identically).
//   2. Gold-standard fixtures (hand-authored, representing what a model
//      correctly following the reasoning discipline would produce) survive
//      the full real pipeline end to end for unseen companies exactly as
//      they do for the named development examples.
//
// Usage: node scripts/test-held-out-blind-evaluation.js
import vm from 'vm';
import { makeSignal } from '../api/research-batch.js';
import { normalizeOpportunity, normalizeCommercialIntelligence, isGenericCommercialPlay } from '../api/signal-intelligence.js';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const NOW = new Date('2026-08-10T12:00:00Z');
const daysAgo = n => { const d = new Date(NOW.getTime() - n*86400000); return d.toISOString().slice(0,10); };
const daysAhead = n => { const d = new Date(NOW.getTime() + n*86400000); return d.toISOString().slice(0,10); };

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
  new vm.Script(fullSource, { filename: 'held-out-blind-evaluation-extract.js' }).runInContext(sandbox);
  return sandbox;
}
const sandbox = makeSandbox();

// ===========================================================================
// 1. SPONSORSHIP / COMMUNITY EVENT (strong) -- Briarwood Credit Union,
//    title sponsor of the Meadowbrook Turkey Trot 5K.
// ===========================================================================
const STRONG_HELDOUT = [
  {
    label: '1. Briarwood Credit Union -- Meadowbrook Turkey Trot title sponsorship',
    account: { name: 'Briarwood Credit Union' },
    raw: {
      accountName: 'Briarwood Credit Union', sourceUrl: 'https://example.com/briarwood-turkey-trot',
      signalTitle: 'Briarwood Credit Union Named Title Sponsor of Meadowbrook Turkey Trot',
      concrete_trigger: 'the Turkey Trot sponsorship',
      business_context: 'Briarwood Credit Union announced it is the title sponsor of the annual Meadowbrook Turkey Trot 5K.',
      event_date: daysAhead(30), publicationDate: daysAgo(2), confidence: 87,
      commercialPlay: { concept: 'Turkey Trot Finish Line Crew', narrative: 'Turn the title sponsorship into a visible finish-line presence for the volunteers and runners crossing the line, not just a banner with the credit union\'s name on it.' },
      activationIdeas: ['Finish-line volunteer vests', 'Runner take-home medals']
    }
  },
  {
    label: '2. Vantage Fleet Solutions -- Ridgeline Logistics acquisition',
    account: { name: 'Vantage Fleet Solutions' },
    raw: {
      accountName: 'Vantage Fleet Solutions', sourceUrl: 'https://example.com/vantage-ridgeline-acquisition',
      signalTitle: 'Vantage Fleet Solutions Acquires Ridgeline Logistics',
      concrete_trigger: 'the Ridgeline Logistics acquisition',
      business_context: 'Vantage Fleet Solutions announced the acquisition of Ridgeline Logistics.',
      event_date: daysAgo(5), publicationDate: daysAgo(5), confidence: 88,
      commercialPlay: { concept: 'Fleet Welcome Integration', narrative: 'Create a welcome/integration moment for the incoming Ridgeline Logistics drivers and dispatch staff as they join Vantage\'s fleet operations.' },
      activationIdeas: ['Welcome kit for new drivers', 'Team orientation-day gear']
    }
  },
  {
    label: '3. Solaris Orthodontics -- new office relocation',
    account: { name: 'Solaris Orthodontics' },
    raw: {
      accountName: 'Solaris Orthodontics', sourceUrl: 'https://example.com/solaris-new-office',
      signalTitle: 'Solaris Orthodontics Relocates to Larger Office',
      concrete_trigger: 'the new office relocation',
      business_context: 'Solaris Orthodontics announced its relocation to a larger office to serve more patients.',
      event_date: daysAhead(15), publicationDate: daysAgo(3), confidence: 84,
      commercialPlay: { concept: 'New Office Opening Day', narrative: 'Use the move to a larger office as a reason to create an opening-day moment for staff and the patients visiting the new location for the first time.' },
      activationIdeas: ['Staff opening-day polos', 'Patient welcome gift']
    }
  },
  {
    label: '4. Cobalt Brew Co. -- canned cocktail launch event',
    account: { name: 'Cobalt Brew Co.' },
    raw: {
      accountName: 'Cobalt Brew Co.', sourceUrl: 'https://example.com/cobalt-cocktail-launch',
      signalTitle: 'Cobalt Brew Co. Launches New Canned Cocktail Line',
      concrete_trigger: 'the canned cocktail launch event',
      business_context: 'Cobalt Brew Co. is holding a launch event for its new canned cocktail line.',
      event_date: daysAhead(10), publicationDate: daysAgo(1), confidence: 86,
      commercialPlay: { concept: 'Launch Night Crew', narrative: 'Build a coordinated launch-night experience for the bartenders and guests sampling the new canned cocktail line for the first time.' },
      activationIdeas: ['Launch-night staff aprons', 'Guest take-home sampler']
    }
  },
  {
    label: '5. Meridian Wealth Partners -- new Chief Growth Officer',
    account: { name: 'Meridian Wealth Partners' },
    raw: {
      accountName: 'Meridian Wealth Partners', sourceUrl: 'https://example.com/meridian-new-cgo',
      signalTitle: 'Meridian Wealth Partners Hires Chief Growth Officer',
      concrete_trigger: 'the new Chief Growth Officer hire',
      business_context: 'Meridian Wealth Partners announced the hire of a new Chief Growth Officer to lead its expansion.',
      event_date: daysAgo(6), publicationDate: daysAgo(6), confidence: 83,
      // Deliberately does NOT assert a specific rebrand/reorg plan exists
      // (unsupported assumption) -- only the inference that a new leader
      // likely wants an early, visible internal win. Proves the fact-vs-
      // inference discipline is a general instruction, not something tied
      // to the Impiricus wording it was originally illustrated with.
      commercialPlay: { concept: 'New Growth Leader Momentum', narrative: 'A newly hired Chief Growth Officer likely wants an early, visible internal win -- a team culture refresh or client-facing rollout gives them a fast, tangible first move.' },
      activationIdeas: ['Team culture refresh kit', 'Client-facing welcome piece']
    }
  }
];

for (const c of STRONG_HELDOUT){
  const built = buildOpportunity(c.raw, c.account);
  assert(!!built, `${c.label}: makeSignal()/normalizeOpportunity() produce a real opportunity`);
  assert(isGenericCommercialPlay(c.raw.commercialPlay.narrative) === false, `${c.label}: sanity -- the gold commercialPlay narrative is never flagged generic (content-based check, never saw this company name before)`);
  const opp = asBusinessOpportunity(built);
  const statusLine = sandbox.signalDateAndActionabilityLine(opp);
  assert(statusLine !== 'Date unavailable' && statusLine !== 'No longer current', `${c.label}: sanity -- the fixture's date is resolvable and current (got "${statusLine}")`);
  assert(sandbox.hasCredibleActivationPlay(opp) === true, `${c.label}: hasCredibleActivationPlay() recognizes the real activation thesis for an unseen company`);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, `${c.label}: remains priority-eligible`);
  const cardHtml = sandbox.renderRepOpportunityCard(opp);
  assert(cardHtml.indexOf('The Play') !== -1 && cardHtml.indexOf(c.raw.commercialPlay.concept) !== -1, `${c.label}: the priority card surfaces The Play with its real concept ("${c.raw.commercialPlay.concept}")`);
  assert(cardHtml.indexOf('Ideas to Send') !== -1, `${c.label}: the priority card surfaces Ideas to Send`);
}

console.log('');

// Concept-led permission ask -- properties, not exact prose: references the
// real signal, names a real idea, asks permission, never a scheduling
// close or generic discovery question.
for (const c of STRONG_HELDOUT){
  const built = buildOpportunity(c.raw, c.account);
  const opp = asBusinessOpportunity(built);
  const approach = sandbox.conceptLedApproach(opp);
  if(!approach){
    // Only 'upcoming'/'recent-past'/'ongoing' qualify -- confirm this
    // fixture's own status before treating a null approach as a failure.
    assert(['upcoming','recent-past','ongoing'].indexOf(opp.actionabilityStatus?.status) === -1, `${c.label}: conceptLedApproach() returned null only because this fixture's status genuinely doesn't qualify (got "${opp.actionabilityStatus?.status}")`);
    continue;
  }
  assert(/\?/.test(approach), `${c.label}: the approach ends on a real question (got "${approach}")`);
  assert(!sandbox.isDirectSchedulingClose(approach), `${c.label}: the approach never closes with a scheduling ask (got "${approach}")`);
  assert(sandbox.isPermissionBasedConceptOffer(approach, opp) === true, `${c.label}: the approach is recognized as a grounded, permission-based concept offer (got "${approach}")`);
}

console.log('');

// ===========================================================================
// 6. FUNDING-ONLY (weak, no play) -- Lumen Robotics Series A, no disclosed
//    downstream initiative.
// ===========================================================================
{
  const built = buildOpportunity({
    accountName: 'Lumen Robotics', sourceUrl: 'https://example.com/lumen-series-a',
    signalTitle: 'Lumen Robotics Raises $12M Series A',
    concrete_trigger: 'Lumen Robotics raised a $12M Series A',
    business_context: 'Lumen Robotics announced it raised a $12M Series A round.',
    event_date: daysAgo(5), publicationDate: daysAgo(5), confidence: 82
  }, { name: 'Lumen Robotics' });
  assert(!!built, '6. Lumen Robotics (funding-only): makeSignal()/normalizeOpportunity() still produce a real opportunity');
  assert(built.commercialPlay === null && built.activationIdeas.length === 0, '6. Lumen Robotics: no play/ideas fabricated for a funding-only signal with no disclosed initiative');
  const opp = asBusinessOpportunity(built);
  const statusLine = sandbox.signalDateAndActionabilityLine(opp);
  assert(statusLine !== 'Date unavailable' && statusLine !== 'No longer current', `6. Lumen Robotics: sanity -- exclusion is not a side effect of a date problem (got "${statusLine}")`);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'required property (NO-PLAY discipline, unseen company): a funding-only signal with no disclosed initiative does not consume a priority slot');
}
// Manufactured-activation variant -- proves the NEW "NO GROUNDED ACTIVATION"
// gate generalizes to an unseen company's funding-dressed play, not just
// the confirmed Neural Trust case.
{
  const built = buildOpportunity({
    accountName: 'Lumen Robotics', sourceUrl: 'https://example.com/lumen-series-a-dressed',
    signalTitle: 'Lumen Robotics Raises $12M Series A',
    concrete_trigger: 'Lumen Robotics raised a $12M Series A',
    business_context: 'Lumen Robotics announced it raised a $12M Series A round.',
    event_date: daysAgo(5), publicationDate: daysAgo(5), confidence: 82,
    commercialPlay: { concept: 'Series A Momentum Campaign', narrative: 'Lumen Robotics just closed a $12M Series A, which is a great opportunity to run a brand awareness campaign celebrating the milestone.' },
    activationIdeas: ['Funding announcement social media campaign', 'Series A celebration launch kit']
  }, { name: 'Lumen Robotics' });
  assert(built.commercialPlay === null, 'required property (unseen company): a confidently-phrased funding-event-dressed commercialPlay is still caught for a company never seen in the prompt or any prior fixture');
  assert(built.activationIdeas.length === 0, 'required property (unseen company): funding-event-dressed activationIdeas are still filtered for an unseen company');
  const opp = asBusinessOpportunity(built);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'required property (unseen company): the manufactured Series A campaign does not consume a priority slot');
}

// ===========================================================================
// 7. ROUTINE FINANCIAL ANNOUNCEMENT (weak, no play) -- Ashford Industrial
//    Supply Q3 earnings call.
// ===========================================================================
{
  const built = buildOpportunity({
    accountName: 'Ashford Industrial Supply', sourceUrl: 'https://example.com/ashford-q3-earnings',
    signalTitle: 'Ashford Industrial Supply Q3 Earnings Call',
    concrete_trigger: 'Ashford Industrial Supply held its Q3 earnings call',
    business_context: 'Ashford Industrial Supply hosted its routine Q3 earnings call to discuss financial results.',
    event_date: daysAgo(4), publicationDate: daysAgo(4), confidence: 80
  }, { name: 'Ashford Industrial Supply' });
  assert(built.commercialPlay === null && built.activationIdeas.length === 0, '7. Ashford Industrial Supply: no play/ideas fabricated for a routine earnings call');
  const opp = asBusinessOpportunity(built);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'required property (unseen company): a routine earnings call does not consume a priority slot');
}

// ===========================================================================
// 8. AMBIGUOUS SIGNAL -- NO PLAY is the acceptable, correct result. Thornton
//    & Vale LLP mentioned only in a generic industry-trends roundup, no
//    identifiable audience/objective/moment of its own.
// ===========================================================================
{
  const built = buildOpportunity({
    accountName: 'Thornton & Vale LLP', sourceUrl: 'https://example.com/law-firm-trends-roundup',
    signalTitle: 'Thornton & Vale LLP Mentioned in Law Firm Growth Trends Roundup',
    concrete_trigger: 'Thornton & Vale LLP was mentioned in a general roundup about law firm growth trends',
    business_context: 'A trade publication mentioned Thornton & Vale LLP briefly in a general roundup about law firm growth trends, with no specific event or initiative described.',
    event_date: daysAgo(10), publicationDate: daysAgo(10), confidence: 60
  }, { name: 'Thornton & Vale LLP' });
  assert(!!built, '8. Thornton & Vale LLP (ambiguous): still produces a real opportunity object -- retained as research, not discarded');
  assert(built.commercialPlay === null && built.activationIdeas.length === 0, '8. Thornton & Vale LLP: no play/ideas fabricated for a vague, audience-less, moment-less mention -- NO PLAY is the correct, expected result');
  const opp = asBusinessOpportunity(built);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'required property (unseen company, ambiguous signal): a signal with no identifiable audience/objective/moment does not consume a priority slot, and is never rescued with a fabricated one');
}

console.log('');

// ===========================================================================
// GLOBAL-VS-ACCOUNT-SPECIFIC PROOF: confirm none of these held-out company
// names appear anywhere in production code (prompts, gates, rendering) --
// if the system were overfit to named development examples, these
// companies would either be silently ignored by some special-case branch
// or would need to be added to the prompt to work. Neither is true: they
// pass through the exact same, unmodified, content-based pipeline.
// ===========================================================================
{
  const fs = await import('fs');
  const productionFiles = [
    'api/signal-intelligence.js', 'api/research-account.js', 'api/research-batch.js',
    'api/get-dashboard.js', 'api/save-upload.js', 'dashboard/index.html'
  ];
  const heldOutNames = ['Briarwood Credit Union', 'Vantage Fleet Solutions', 'Ridgeline Logistics', 'Solaris Orthodontics', 'Cobalt Brew Co.', 'Meridian Wealth Partners', 'Lumen Robotics', 'Ashford Industrial Supply', 'Thornton & Vale LLP'];
  let leaked = [];
  for (const file of productionFiles){
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const name of heldOutNames){
      if (src.includes(name)) leaked.push(`${name} in ${file}`);
    }
  }
  assert(leaked.length === 0, `required property: none of these held-out company names appear anywhere in production code -- the system has no way to have special-cased them (leaked: ${leaked.join(', ') || 'none'})`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
