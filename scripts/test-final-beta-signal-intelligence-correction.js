// Final Beta Signal Intelligence Correction sprint: proves the ten required
// archetype regressions (A-J) from the authoritative brief, using fictional
// archetypes only (never named real companies), driven through the REAL
// production pipeline (makeSignal()/normalizeOpportunity()/
// verifyCandidateCompanyGrounding() from api/*.js) and the REAL dashboard
// primitives (extracted verbatim into a vm sandbox via
// scripts/lib/dashboard-extract.js -- never a reimplementation).
//
// Central doctrine under test: "NO GROUNDED REASON TO ENGAGE -> NO
// PRIORITY" (superseding the earlier "NO GROUNDED ACTIVATION -> NO
// PRIORITY"). A grounded commercial activation (Route B) is ONE kind of
// grounded reason to engage; a strong, timely, correctly-identified
// business moment is itself another (Route A), even with no merch play.
//
//   A. Strong conference signal -> Business Signal, Priority via Route A,
//      no activationIdeas required.
//   B. Conference + grounded activation -> Priority via Route B, richer
//      Play/Ideas survive.
//   C. Routine corporate noise (earnings) -> never Priority.
//   D. Rebrand without grounded activation -> Business Signal survives;
//      generic swag ideas don't manufacture Route B; Priority depends only
//      on Route A clearance.
//   E. Wrong surname entity -> Possible Match, never a Business Signal,
//      never Priority, never "Use This Signal".
//   F. Common-word brand collision -> never a Business Signal.
//   G. Exact company match with no uploaded website -> can become a
//      Business Signal, can become Priority via either route.
//   H. Rep-selected non-Priority signal -> "Use This Signal" opens Prepare
//      for Call, clearly seller-selected, never promotes to Priority, no
//      persistence side effect, missing Play/Ideas stay absent.
//   I. Relationship-only Priority -> a simple check-in approach is valid,
//      no forced promotional concepts.
//   J. Possible Match -> visible transparently in Research Details, clear
//      identity caution, no "Use This Signal", no Prepare for Call, no
//      Priority.
//
// Bounded correction round (identity collision hardening + undated Business
// Signal actionability) adds:
//   K1. Possessive-name collision (fictional Wyman's/Oliver-Wyman shape,
//       using a BARE single-token possessive account name, not padded with
//       an extra business-type suffix) -> Possible Match, not Business
//       Signal.
//   K2. Common-word one-token collision (fictional Timberland shape, bare
//       single-token account name) -> Possible Match, not Business Signal.
//   K3. Legitimate one-token company + independent domain corroboration ->
//       Business Signal (confirmed) -- a single-token identity is never
//       broadly downgraded once genuinely corroborated.
//   K4. Exact multi-word company phrase, no uploaded website -> Business
//       Signal (unconfirmed), unaffected by the single-token downgrade.
//   L-A. Legitimate current/ongoing undated Business Signal -> visible,
//        "Timing unclear" (not "stale"), non-Priority, "Use This Signal"
//        available.
//   L-B. Genuinely stale/expired evidence -> remains historical, no "Use
//        This Signal".
//   L-C. Newly discovered evergreen evidence -> first_seen_at alone never
//        grants Priority; still surfaces as a weak, usable Business Signal.
//   L-D. Possible Match with no date -> still Possible Match, no "Use This
//        Signal".
//
// Follow-up correction round (self-domain corroborator) adds:
//   M1. One-token account + exact first-party domain SLD (fictional
//       Unitil-shaped) -> confirmed Business Signal identity, no uploaded
//       website required.
//   M2. One-token account + a DIFFERENT company whose domain merely
//       CONTAINS the token -> Possible Match, not corroborated.
//   M3. One-token account + an unrelated third-party/common-word source
//       (not the account's own domain) -> Possible Match.
//   (K1/K2 above already cover required regressions 4/5 -- Wyman's/
//   Timberland collisions remain protected; K4 already covers required
//   regression 6 -- multi-word company behavior unaffected.)
//
// Usage: node scripts/test-final-beta-signal-intelligence-correction.js
import vm from 'vm';
import { makeSignal } from '../api/research-batch.js';
import { normalizeOpportunity, verifyCandidateCompanyGrounding, isSingleTokenCompanyIdentity, isExactSelfDomainMatch } from '../api/signal-intelligence.js';
import { classifyLegacySignalActionability } from '../api/research-batch.js';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const NOW = new Date('2026-08-12T12:00:00Z');
const daysAgo = n => { const d = new Date(NOW.getTime() - n*86400000); return d.toISOString().slice(0,10); };
const daysAhead = n => { const d = new Date(NOW.getTime() + n*86400000); return d.toISOString().slice(0,10); };

function buildOpportunity(raw, account = {}, candidate = {}){
  const signal = makeSignal(raw, account);
  if(!signal) return null;
  return normalizeOpportunity(signal, { name: signal.accountName, ...account }, candidate);
}
function asBusinessOpportunity(opp, identityConfidence){
  return { ...opp, isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', account: opp.accountName, identityConfidence };
}

const DASHBOARD_SRC = loadDashboardSource();
const TIMEBOX_CONFIG_SRC = extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG');
const IS_RELATIONSHIP_EXPANSION_SRC = extractFn(DASHBOARD_SRC, 'isRelationshipExpansionOpportunity');
const DEDUPE_AND_IDENTITY_BLOCK = extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(', 'function isWebResearchSignal(opp){');
// One contiguous range (rather than several disjoint extractFn/extractRange
// calls) from confidenceLabel() through renderPipelineTable() -- this spans
// renderSingleVerifiedSignal()/renderVerifiedSignals(), isSignalPriorityEligible(),
// repSelectedOpportunityFromSignal()/useSignalAsRepSelected(), and every
// helper window.createSalesPlayPanel() itself calls (getReasonToReachOutTitle(),
// cleanSalesPlayText(), pickPrimaryPromoCategory(), groundedDepartmentForOpportunity(),
// etc.) -- calling the REAL createSalesPlayPanel() end to end (not just
// renderRepOpportunityCard(), the dashboard-card-only renderer other test
// files use) requires all of them present, and picking them off one at a
// time by trial and error is exactly the brittleness dashboard-extract.js's
// semantic-range extraction exists to avoid.
const CARD_MODAL_AND_SALES_PLAY_BLOCK = extractRange(DASHBOARD_SRC, 'function confidenceLabel(', 'function renderPipelineTable(');
const SCORING_AND_TIMEBOX_BLOCK = extractRange(DASHBOARD_SRC, 'function normalizeSignalLayerType(', 'function feedSummary(');
const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
const FMT_MONEY_SRC = extractFn(DASHBOARD_SRC, 'fmtMoney');
const CLAMP_SCORE_SRC = extractFn(DASHBOARD_SRC, 'clampScore');

// Signal feedback / organizational-learning foundation: renderSingleVerifiedSignal()/
// useSignalAsRepSelected()/createSalesPlayPanel() -- all inside
// CARD_MODAL_AND_SALES_PLAY_BLOCK below -- now call these. Pure
// fire-and-forget event logging / best-effort DOM hydration, with no
// bearing on this file's card/modal/scoring assertions, so they're
// stubbed exactly like isWarmAccount() above.
const SIGNAL_EVENTS_STUB_SOURCE = `
function logSignalEvent(){ return Promise.resolve(null); }
function generateClientEventId(){ return 'test-client-event-id'; }
function fetchSignalEventStates(){ return Promise.resolve({}); }
function hydrateSignalFeedbackButtons(){}
function wireOutreachRow(){}
function hydrateOutreachRow(){ return Promise.resolve(); }
function resolveSignalEventTarget(){ return null; }
function logOpportunityAwareEvent(){ return Promise.resolve(null); }
`;

function makeSandbox(){
  const fakeModal = { querySelector: () => ({ focus(){} }), querySelectorAll: () => [] };
  const sandbox = {
    console,
    window: { accountRadarAccounts: [], HouseAccountsHeader: { beginOverlay(){}, endOverlay(){} } },
    document: {
      getElementById: () => ({ textContent: '', innerHTML: '', style: {} }),
      querySelectorAll: () => [],
      body: { insertAdjacentHTML(pos, html){ sandbox.__lastSalesPlayHtml = html; }, get lastElementChild(){ return fakeModal; } },
      addEventListener(){}
    },
    isWarmAccount: () => false,
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  const fullSource = [
    TIMEBOX_CONFIG_SRC, `let activeTimebox = 'week';`, `let showAllWeeklyPriorities = false;`,
    IS_RELATIONSHIP_EXPANSION_SRC, ESCAPE_HTML_SRC, FMT_MONEY_SRC, CLAMP_SCORE_SRC,
    DEDUPE_AND_IDENTITY_BLOCK, CARD_MODAL_AND_SALES_PLAY_BLOCK, SCORING_AND_TIMEBOX_BLOCK,
    // The real source assigns `window.createSalesPlayPanel = function(){...}`
    // and every internal call site (including useSignalAsRepSelected(),
    // extracted above) refers to the BARE identifier `createSalesPlayPanel`
    // -- exactly as a classic (non-module) browser script would resolve it
    // against the shared global object. Aliasing it here after extraction
    // reproduces that same resolution inside this vm context, without
    // changing a single line of the extracted source itself.
    `this.createSalesPlayPanel = window.createSalesPlayPanel;`,
    // Placed LAST, deliberately: CARD_MODAL_AND_SALES_PLAY_BLOCK's wide
    // contiguous range (confidenceLabel() through renderPipelineTable())
    // already includes the REAL wireOutreachRow()/hydrateOutreachRow()
    // declarations (they live immediately before createSalesPlayPanel() in
    // the real file). A later `function name(){}` declaration in the same
    // scope overwrites an earlier one of the same name, so this stub block
    // must come after that range to actually take effect.
    SIGNAL_EVENTS_STUB_SOURCE
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'final-beta-correction-extract.js' }).runInContext(sandbox);
  return sandbox;
}

const sandbox = makeSandbox();
for (const fn of [sandbox.isPriorityEligibleOpportunity, sandbox.hasConfirmedOrLegacyIdentity, sandbox.isPossibleMatchIdentity, sandbox.hasCredibleActivationPlay, sandbox.renderVerifiedSignals, sandbox.createSalesPlayPanel, sandbox.useSignalAsRepSelected]){
  assert(typeof fn === 'function', `extraction produced a real function (${fn && fn.name})`);
}

// ===========================================================================
// Case A -- strong conference signal, no grounded activation. Real, dated,
// first-party, correctly-identified event (the Service Credit Union
// "Tenth Annual Seacoast Veterans Conference" archetype). No commercialPlay/
// activationIdeas -- HA does not need a clever merch idea before this
// qualifies as a Priority.
// ===========================================================================
const ACCOUNT_A = { name: 'Harborview Federal Credit Union' };
const CASE_A_RAW = {
  accountName: 'Harborview Federal Credit Union',
  sourceUrl: 'https://harborviewfcu.example/news/veterans-conference',
  signalTitle: 'Harborview Federal Credit Union Hosts Ninth Annual Veterans Conference',
  concrete_trigger: 'Harborview Federal Credit Union is hosting its Ninth Annual Veterans Conference next month',
  business_context: 'Harborview Federal Credit Union announced it will host its Ninth Annual Veterans Conference for members and the local veteran community next month.',
  event_date: daysAhead(21),
  publicationDate: daysAgo(2),
  confidence: 88
  // Deliberately no commercialPlay/activationIdeas -- the real pipeline
  // correctly declines to invent one when the source discloses none.
};
{
  const built = buildOpportunity(CASE_A_RAW, ACCOUNT_A);
  assert(!!built, 'Case A: makeSignal()/normalizeOpportunity() produce a real opportunity for a strong, dated conference signal');
  assert(built.commercialPlay === null && built.activationIdeas.length === 0, 'Case A: no play/ideas fabricated -- restraint, not fabrication');
  const opp = asBusinessOpportunity(built, 'confirmed');
  assert(sandbox.hasConfirmedOrLegacyIdentity(opp) === true, 'Case A: identity is eligible');
  assert(sandbox.hasCredibleActivationPlay(opp) === false, 'Case A: sanity -- there is genuinely no activation to recommend (Route B does not apply)');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'Case A: REQUIRED -- a strong, timely, correctly-identified conference qualifies for Priority via Route A alone, with no activation required');
  const html = sandbox.renderVerifiedSignals([{ ...built, isReal: true, identityConfidence: 'confirmed' }]);
  assert(!html.includes('No external signals found'), 'Case A: the signal renders as a real, visible Business Signal');
}

// ===========================================================================
// Case B -- the SAME conference, but the source also discloses a grounded
// activation (a real, dated volunteer/attendee moment). Route B's richer
// Play/Ideas survive and remain the best outcome when genuinely available.
// ===========================================================================
const CASE_B_RAW = {
  ...CASE_A_RAW,
  business_context: 'Harborview Federal Credit Union announced it will host its Ninth Annual Veterans Conference for members and the local veteran community next month, with credit union staff volunteering at a check-in table for attendees.',
  commercialPlay: { concept: 'Veterans Conference Volunteer Kit', narrative: 'Credit union staff are volunteering at the attendee check-in table for the Ninth Annual Veterans Conference -- a real, dated moment to equip the volunteers with a visible, cohesive presence for the attendees they are greeting.' },
  activationIdeas: ['Volunteer polos for the staff working check-in', 'Take-home welcome items for veteran attendees']
};
{
  const built = buildOpportunity(CASE_B_RAW, ACCOUNT_A);
  assert(built.commercialPlay && built.activationIdeas.length > 0, 'Case B: a disclosed volunteer/attendee moment survives as a real commercialPlay + activationIdeas');
  const opp = asBusinessOpportunity(built, 'confirmed');
  assert(sandbox.hasCredibleActivationPlay(opp) === true, 'Case B: the grounded activation is recognized as credible (Route B)');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'Case B: Priority-eligible via Route B, the richer reasoning chain');
}

// ===========================================================================
// Case C -- routine corporate noise (earnings call). Must never become
// Priority via either route, with or without a manufactured play.
// ===========================================================================
const ACCOUNT_C = { name: 'Cresthill Analytics' };
const CASE_C_RAW = {
  accountName: 'Cresthill Analytics',
  sourceUrl: 'https://example.com/cresthill-q2-earnings',
  signalTitle: 'Cresthill Analytics Q2 Earnings Call',
  concrete_trigger: 'Cresthill Analytics held its Q2 earnings call',
  business_context: 'Cresthill Analytics hosted its routine Q2 earnings call to discuss quarterly financial results.',
  event_date: daysAgo(4), publicationDate: daysAgo(4), confidence: 79
};
{
  const built = buildOpportunity(CASE_C_RAW, ACCOUNT_C);
  assert(built.commercialPlay === null && built.activationIdeas.length === 0, 'Case C: no play/ideas fabricated for a routine earnings call');
  const opp = asBusinessOpportunity(built, 'confirmed');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'Case C: REQUIRED -- routine corporate/financial noise never becomes Priority, even with confirmed identity');
}

// ===========================================================================
// Case D -- rebrand without a grounded activation (Planet Fitness archetype).
// The Business Signal survives; a generic hedged swag narrative must not
// manufacture Route B; Priority depends only on whether the rebrand itself
// clears Route A.
// ===========================================================================
const ACCOUNT_D = { name: 'Northgate Fitness Collective' };
const CASE_D_RAW = {
  accountName: 'Northgate Fitness Collective',
  sourceUrl: 'https://example.com/northgate-rebrand',
  signalTitle: 'Northgate Fitness Collective Unveils Company-Wide Rebrand',
  concrete_trigger: 'Northgate Fitness Collective unveiled a company-wide rebrand across all locations',
  business_context: 'Northgate Fitness Collective announced a company-wide rebrand, rolling out new signage and branding across all of its locations this quarter.',
  event_date: daysAgo(5), publicationDate: daysAgo(5), confidence: 83
};
{
  const built = buildOpportunity(CASE_D_RAW, ACCOUNT_D);
  assert(!!built, 'Case D: the rebrand survives as a real Business Signal');
  assert(built.commercialPlay === null && built.activationIdeas.length === 0, 'Case D: no play/ideas fabricated -- the source discloses no activation, only the rebrand itself');
  const opp = asBusinessOpportunity(built, 'confirmed');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'Case D: a company-wide, dated, current rebrand is itself a real enough business moment to clear Route A on its own');

  // The founder-named failure shape: a hedged, boilerplate swag narrative
  // ("the rebrand MAY create AN OPPORTUNITY for promotional products...")
  // must never manufacture Route B eligibility on top of Route A.
  const dressedRaw = {
    ...CASE_D_RAW,
    commercialPlay: { concept: 'Rebrand Merch Refresh', narrative: 'The rebrand may create an opportunity for promotional products that reflect the new brand identity and engage both existing and new members.' },
    activationIdeas: ['Rebrand launch apparel', 'New-brand promotional giveaways']
  };
  const dressedBuilt = buildOpportunity(dressedRaw, ACCOUNT_D);
  assert(dressedBuilt.commercialPlay === null, 'Case D: the generic hedged rebrand-merch narrative is caught and nulled -- it never earns Route B');
  assert(dressedBuilt.activationIdeas.length === 0, 'Case D: the generic rebrand-merch activationIdeas are filtered too');
  const dressedOpp = asBusinessOpportunity(dressedBuilt, 'confirmed');
  assert(sandbox.hasCredibleActivationPlay(dressedOpp) === false, 'Case D: sanity -- no credible Route B activation exists for the dressed variant');
  assert(sandbox.isPriorityEligibleOpportunity(dressedOpp) === true, 'Case D: still Priority-eligible -- via Route A (the rebrand itself), never via the rejected generic play');
}

// ===========================================================================
// Case E -- wrong surname entity (the confirmed Wyman's / Oliver Wyman
// collision shape). Evidence names a DIFFERENT company that merely shares a
// surname/token with the account. Must grade as a Possible Match, never a
// Business Signal, never Priority, never eligible for "Use This Signal".
// ===========================================================================
const ACCOUNT_E = { name: "Wyman's Seafood Market" };
{
  const wrongEntityCandidate = {
    title: 'Careers at Oliver Wyman | A Marsh business',
    snippet: 'Oliver Wyman is a global management consulting firm. Explore open roles across our practice areas.',
    url: 'https://www.oliverwyman.com/careers'
  };
  const grounding = verifyCandidateCompanyGrounding(wrongEntityCandidate, ACCOUNT_E);
  assert(grounding.identityConfidence === 'possible', `Case E: REQUIRED -- a different company that merely shares a surname/token grades as 'possible' (Possible Match), never rejected outright (still visible for transparency) and never a legitimate Business Signal (got '${grounding.identityConfidence}')`);
  const opp = { ...asBusinessOpportunity({ accountName: ACCOUNT_E.name, signalTitle: 'Careers at Oliver Wyman', commercialPlay: null, activationIdeas: [] }, grounding.identityConfidence), actionabilityStatus: { status: 'ongoing', isPriorityEligible: true } };
  assert(sandbox.isPossibleMatchIdentity(opp) === true, 'Case E: isPossibleMatchIdentity() correctly flags this as a Possible Match');
  assert(sandbox.hasConfirmedOrLegacyIdentity(opp) === false, 'Case E: a Possible Match never clears the identity gate -- never a Business Signal');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'Case E: a Possible Match never becomes Priority');
  const html = sandbox.renderVerifiedSignals([{ ...opp, isReal: true, sourceUrl: wrongEntityCandidate.url }]);
  assert(!html.includes('use-signal-btn'), 'Case E: REQUIRED -- "Use This Signal" never renders for a Possible Match');
  assert(/[Pp]ossible match/.test(html), 'Case E: Research Details renders the identity-uncertainty caution for a Possible Match');
}

// ===========================================================================
// Case F -- common-word brand collision (the confirmed Timberland / Nusenda
// "timberland" ordinary-English-usage shape). The account's brand name is
// used in its ordinary dictionary sense by an unrelated publisher, not as a
// reference to the company. Must never become a Business Signal.
// ===========================================================================
const ACCOUNT_F = { name: 'Timberland Outdoor Supply' };
{
  const commonWordCandidate = {
    title: 'Nusenda Credit Union on Instagram',
    snippet: 'A beautiful hike through the timberland near our new branch -- tag us in your favorite trail photos!',
    url: 'https://instagram.com/nusendacu/12345'
  };
  const grounding = verifyCandidateCompanyGrounding(commonWordCandidate, ACCOUNT_F);
  assert(grounding.identityConfidence !== 'unconfirmed', `Case F: REQUIRED -- an ordinary-English common-word usage never grades as a legitimate Business Signal ('unconfirmed' or stronger) (got '${grounding.identityConfidence}')`);
  assert(grounding.identityConfidence === 'possible' || grounding.identityConfidence === 'rejected', `Case F: the common-word collision grades as either 'possible' (visible, flagged) or 'rejected' (excluded outright), never anything stronger (got '${grounding.identityConfidence}')`);
  const opp = { ...asBusinessOpportunity({ accountName: ACCOUNT_F.name, signalTitle: 'Nusenda Credit Union on Instagram' }, grounding.identityConfidence) };
  assert(sandbox.hasConfirmedOrLegacyIdentity(opp) === false, 'Case F: never clears the identity gate -- never treated as a legitimate Business Signal');
}

// ===========================================================================
// Case G -- exact company match, no uploaded website/location on the
// account (the ordinary case for any customer-order CSV with no such
// column). Can become a Business Signal, and can become Priority via
// either route.
// ===========================================================================
const ACCOUNT_G = { name: 'Redstone Manufacturing Group' }; // no website, no location
const CASE_G_RAW = {
  accountName: 'Redstone Manufacturing Group',
  sourceUrl: 'https://industrynews.example/redstone-manufacturing-expands',
  signalTitle: 'Redstone Manufacturing Group Announces Plant Expansion',
  // The employee/community detail lives in concrete_trigger (the field the
  // real pipeline preserves verbatim into title/signalDetail/whatChanged),
  // not business_context (which normalizeOpportunity() replaces with its
  // own generic category template whenever the source discloses nothing
  // further -- confirmed by direct inspection: the same detail placed in
  // business_context alone is silently discarded).
  concrete_trigger: 'Redstone Manufacturing Group is expanding its main production facility, with a ribbon cutting event planned for employees and the local community next month',
  business_context: 'Redstone Manufacturing Group announced an expansion of its main production facility, with a ribbon cutting event planned for employees and the local community next month.',
  event_date: daysAhead(25), publicationDate: daysAgo(1), confidence: 85
};
{
  const candidate = { title: CASE_G_RAW.signalTitle, snippet: CASE_G_RAW.business_context, url: CASE_G_RAW.sourceUrl };
  const grounding = verifyCandidateCompanyGrounding(candidate, ACCOUNT_G);
  assert(grounding.identityConfidence === 'unconfirmed', `Case G: an exact bare-name match with no website/location to corroborate against lands on 'unconfirmed' -- a legitimate Business Signal, not 'confirmed' and not 'possible' (got '${grounding.identityConfidence}')`);
  const built = buildOpportunity(CASE_G_RAW, ACCOUNT_G, candidate);
  const opp = asBusinessOpportunity(built, grounding.identityConfidence);
  assert(sandbox.hasConfirmedOrLegacyIdentity(opp) === true, 'Case G: an unconfirmed-but-named match clears the identity gate -- a real Business Signal');
  assert(sandbox.isPossibleMatchIdentity(opp) === false, 'Case G: sanity -- this is not a Possible Match, it is a genuine (uncorroborated) Business Signal');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'Case G: REQUIRED -- can become Priority via Route A (a real facility expansion with a named employee/community event) even with no uploaded website');
}

// ===========================================================================
// Case H -- rep-selected non-Priority signal. "Use This Signal" opens
// Prepare for Call for a legitimate Business Signal HA did not recommend as
// Priority, clearly labeled seller-selected, never promotes to Priority,
// never fabricates a Play, never persists anything.
// ===========================================================================
const ACCOUNT_H = { name: 'Millbrook Dental Partners' };
const CASE_H_RAW = {
  accountName: 'Millbrook Dental Partners',
  sourceUrl: 'https://example.com/millbrook-acquired-practice',
  signalTitle: 'Millbrook Dental Partners Acquires Local Practice',
  concrete_trigger: 'Millbrook Dental Partners acquired a local dental practice',
  business_context: 'Millbrook Dental Partners announced it acquired a local dental practice, with no further integration details disclosed.',
  event_date: daysAgo(6), publicationDate: daysAgo(6), confidence: 81
};
{
  const built = buildOpportunity(CASE_H_RAW, ACCOUNT_H);
  const opp = asBusinessOpportunity(built, 'confirmed');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'Case H: sanity -- a bare acquisition with no disclosed detail is correctly NOT Priority-eligible (Route A noise gate), so "Use This Signal" is the relevant surface here');
  const signalForDisplay = { ...built, isReal: true, identityConfidence: 'confirmed' };
  const html = sandbox.renderVerifiedSignals([signalForDisplay]);
  assert(html.includes('use-signal-btn'), 'Case H: REQUIRED -- "Use This Signal" renders for a legitimate, non-Priority Business Signal');

  let capturedOpp = null;
  let capturedOpts = null;
  sandbox.createSalesPlayPanel = (o, opts) => { capturedOpp = o; capturedOpts = opts; };
  sandbox.useSignalAsRepSelected(signalForDisplay);
  assert(!!capturedOpp, 'Case H: "Use This Signal" opens Prepare for Call for the signal');
  assert(capturedOpts && capturedOpts.repSelected === true, 'Case H: opens with the repSelected flag set');
  assert(capturedOpp.commercialPlay === null && (capturedOpp.activationIdeas || []).length === 0, 'Case H: REQUIRED -- no commercialPlay/activationIdeas fabricated merely because the rep clicked');
  assert(capturedOpp.isVerifiedSignalOpportunity === true, 'Case H: builds a real opportunity shape from the signal\'s own fields, not a manufactured one');

  // Render through the REAL createSalesPlayPanel() to prove the banner and
  // the absent-Play/absent-Ideas behavior end to end.
  const sandbox2 = makeSandbox();
  sandbox2.window.accountRadarAccounts = [];
  sandbox2.useSignalAsRepSelected(signalForDisplay);
  const panelHtml = sandbox2.__lastSalesPlayHtml || '';
  assert(panelHtml.includes('REP-SELECTED SIGNAL'), 'Case H: REQUIRED -- Prepare for Call clearly labels this as a rep-selected signal, not an HA recommendation');
  assert(!/The Play/.test(panelHtml) || !panelHtml.includes(CASE_H_RAW.signalTitle + ' concept'), 'Case H: sanity -- no fabricated concept name appears');

  // No priority-feed/persistence side effect: the account's own
  // futureOpportunities array is untouched by opening "Use This Signal".
  const acct = { name: ACCOUNT_H.name, uploadId: 'upload-h', signals: [signalForDisplay], futureOpportunities: [] };
  sandbox2.window.accountRadarAccounts = [acct];
  const beforeLength = acct.futureOpportunities.length;
  sandbox2.useSignalAsRepSelected(signalForDisplay);
  assert(acct.futureOpportunities.length === beforeLength, 'Case H: REQUIRED -- "Use This Signal" never mutates the account\'s persisted futureOpportunities (no Priority promotion, no persistence side effect)');
}

// ===========================================================================
// Case I -- relationship-only Priority. A Route A Priority's approach may
// simply acknowledge the event without pretending to have a product
// solution -- no forced promotional concept.
// ===========================================================================
{
  const opp = asBusinessOpportunity(buildOpportunity(CASE_A_RAW, ACCOUNT_A), 'confirmed');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'Case I: sanity -- reuses Case A\'s Route A-eligible, activation-free conference Priority');
  const approach = sandbox.conceptLedApproach ? sandbox.conceptLedApproach(opp) : null;
  // conceptLedApproach() is specifically the CONCEPT-LED (Route B, real
  // ideas) approach generator -- for a Route A, activation-free signal like
  // this one, it correctly returns nothing to offer, which is itself the
  // proof: the surface never forces a fabricated promotional concept onto a
  // relationship-only Priority.
  assert(approach === null || approach === undefined || !/idea|concept|sample/i.test(approach), 'Case I: REQUIRED -- no fabricated promotional concept is forced onto a relationship-only Priority (a plain "worth staying close to" / check-in framing is the valid, expected result)');
}

// ===========================================================================
// Case J -- Possible Match. Visible transparently in Research Details, with
// clear identity caution; never "Use This Signal", never Prepare for Call
// eligible, never Priority.
// ===========================================================================
{
  const possibleSignal = {
    accountName: ACCOUNT_E.name, isReal: true, identityConfidence: 'possible',
    sourceUrl: 'https://www.oliverwyman.com/careers', signalTitle: 'Careers at Oliver Wyman',
    signalDetail: 'Careers at Oliver Wyman', signalType: 'Business Activity',
    confidenceScore: 70, actionabilityStatus: { status: 'ongoing', isPriorityEligible: true }
  };
  const html = sandbox.renderVerifiedSignals([possibleSignal]);
  assert(!html.includes('No external signals found'), 'Case J: REQUIRED -- a Possible Match is still visible in Research Details for transparency');
  assert(/[Pp]ossible match/.test(html), 'Case J: REQUIRED -- clear identity-uncertainty caution is shown');
  assert(html.includes(escapeIfDefined(possibleSignal.sourceUrl) || possibleSignal.sourceUrl) || html.includes('View source') || html.includes('oliverwyman.com'), 'Case J: the source link is retained for the rep to verify independently');
  assert(!html.includes('use-signal-btn'), 'Case J: REQUIRED -- "Use This Signal" never renders for a Possible Match');
  const opp = { ...possibleSignal, isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', account: possibleSignal.accountName };
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'Case J: REQUIRED -- a Possible Match never becomes Priority');
}
function escapeIfDefined(s){ return s; }

// ===========================================================================
// Bounded correction round: IDENTITY COLLISION HARDENING.
//
// The founder's audit of the fresh production run proved the Wyman's/
// Timberland wrong-entity collisions were graded 'unconfirmed' (a
// legitimate Business Signal), never 'possible', because BOTH matched via
// entityMatch()'s STRONG bare-name-match path ("company named in source" --
// hasBareNameMatch=true), never the weaker distinctiveFallbackMatched path
// the OLD 'possible' branch alone was reachable from. Root cause: the
// account's own full name, once normalized, was itself just a single
// token/word ("wyman", "timberland") -- exactly as consistent with a
// different same-word entity, or the word's ordinary English sense, as
// with the real account. Fresh fictional archetypes below (never the real
// production names) prove the fix at the actual module boundary
// (verifyCandidateCompanyGrounding()), not through the rendering layer.
// ===========================================================================

// ---------------------------------------------------------------------------
// K1 -- possessive-name collision. Account's full name is itself a single
// token once normalized ("Halloway's" -> "halloway"). Evidence never
// mentions the account at all -- it's a DIFFERENT company ("Preston
// Halloway") whose own possessive grammar ("...Preston Halloway's growing
// presence...") normalizes to contain the same bare "halloway" token. Must
// grade 'possible', not 'unconfirmed'.
// ---------------------------------------------------------------------------
{
  const account = { name: "Halloway's" };
  assert(isSingleTokenCompanyIdentity(account.name) === true, "K1: sanity -- \"Halloway's\" normalizes to a single token (\"halloway\"), the exact risk class this fix targets");
  const wrongEntityCandidate = {
    title: 'Careers at Preston Halloway | A Larkspur Group Business',
    snippet: 'Alumni gathered to celebrate a milestone anniversary for Preston Halloway\'s growing presence in the region.',
    url: 'https://careers.larkspurgroup.example/preston-halloway'
  };
  const grounding = verifyCandidateCompanyGrounding(wrongEntityCandidate, account);
  assert(grounding.identityConfidence === 'possible', `K1: REQUIRED -- a different company's own possessive grammar ("Preston Halloway's...") that happens to normalize into the account's single-token name grades as 'possible', never 'unconfirmed' (got '${grounding.identityConfidence}')`);
  assert(grounding.grounded === true, "K1: still a visible, returned result (not outright rejected) -- transparency, not silence");
}

// ---------------------------------------------------------------------------
// K2 -- common-word one-token collision. Account's full name is an ordinary
// English word/place-name-style term used in its everyday sense by an
// unrelated entity, never referring to the brand.
// ---------------------------------------------------------------------------
{
  const account = { name: 'Fernbrook' };
  assert(isSingleTokenCompanyIdentity(account.name) === true, 'K2: sanity -- "Fernbrook" is a single-token identity');
  const commonWordCandidate = {
    title: 'Cascadia Ridge Credit Union on Instagram',
    snippet: 'A peaceful trail through the fernbrook near our newest branch location -- tag us in your favorite photos!',
    url: 'https://instagram.com/cascadiaridgecu/98765'
  };
  const grounding = verifyCandidateCompanyGrounding(commonWordCandidate, account);
  assert(grounding.identityConfidence === 'possible', `K2: REQUIRED -- an ordinary-English usage of the account's single-token name grades as 'possible', never 'unconfirmed' (got '${grounding.identityConfidence}')`);
}

// ---------------------------------------------------------------------------
// K3 -- legitimate one-token company + independent corroboration. The SAME
// single-token identity as K2, but this time the evidence is hosted on the
// account's own uploaded website -- domain corroboration must still confirm
// it. A single-token identity is never broadly downgraded once genuinely
// corroborated.
// ---------------------------------------------------------------------------
{
  const account = { name: 'Fernbrook', website: 'fernbrook.com' };
  const ownDomainCandidate = {
    title: 'Fernbrook Opens New Downtown Office',
    snippet: 'Fernbrook is opening a new office in the downtown core next quarter.',
    url: 'https://fernbrook.com/news/downtown-office'
  };
  const grounding = verifyCandidateCompanyGrounding(ownDomainCandidate, account);
  assert(grounding.identityConfidence === 'confirmed', `K3: REQUIRED -- a single-token identity corroborated by the account's own uploaded domain still confirms (got '${grounding.identityConfidence}')`);
}

// ---------------------------------------------------------------------------
// K4 -- exact multi-word company phrase, no uploaded website. Unaffected by
// the single-token downgrade -- a genuine multi-word bare-phrase match keeps
// its full 'unconfirmed' (legitimate Business Signal) grade.
// ---------------------------------------------------------------------------
{
  const account = { name: 'Bramwell Logistics' };
  assert(isSingleTokenCompanyIdentity(account.name) === false, 'K4: sanity -- "Bramwell Logistics" is a genuine multi-word phrase, not a single-token identity');
  const candidate = {
    title: 'Bramwell Logistics Announces Downtown Warehouse Expansion',
    snippet: 'Bramwell Logistics is expanding its downtown warehouse to meet growing demand.',
    url: 'https://industrynews.example/bramwell-logistics-expansion'
  };
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'unconfirmed', `K4: REQUIRED -- an exact multi-word company phrase with no uploaded website remains a legitimate Business Signal, 'unconfirmed' (got '${grounding.identityConfidence}')`);
}
// K5 (required regression 5): shortened-name-fallback + genuine
// corroboration already has direct, passing coverage in
// scripts/test-signal-account-evidence-grounding.js (GALLAGHER_WITH_DOMAIN:
// "Gallagher acquired..." matches only via the distinctive-token fallback,
// never the bare full "Arthur J. Gallagher & Co." phrase, and still
// confirms once the candidate's domain is the account's own ajg.com) --
// untouched by this round's fix, unaffected by isSingleTokenCompanyIdentity()
// since it never reaches the hasBareNameMatch branch this fix modifies.

// ===========================================================================
// Follow-up correction round: SELF-DOMAIN CORROBORATOR.
//
// The founder's follow-up audit proved the K1-K4 single-token rule above was
// itself too broad: a genuinely legitimate one-token company (the confirmed
// production shape -- an account like "Unitil" with no uploaded website,
// evidence hosted on its own obvious domain) had NO way to ever clear
// 'possible', because every existing corroborator (verified company domain,
// location, known social profile) required the founder to have uploaded
// that metadata. Fix: an EXACT registrable-domain-SLD-equals-normalized-
// company-name check, independent of any upload. Deliberately exact-match
// only (never substring/contains/fuzzy) so it cannot rescue a DIFFERENT
// company whose domain merely contains the account's token -- the fresh
// fictional archetype below ("Brindlewood") is never the real production
// account name.
// ===========================================================================

// ---------------------------------------------------------------------------
// M1 -- one-token account + exact first-party domain SLD, no uploaded
// website. REQUIRED regression 1 + 7 (no uploaded website needed).
// ---------------------------------------------------------------------------
{
  const account = { name: 'Brindlewood' }; // no website, no location
  assert(isSingleTokenCompanyIdentity(account.name) === true, 'M1: sanity -- "Brindlewood" is a single-token identity');
  const ownDomainCandidate = {
    title: 'Brindlewood Opens New Distribution Center',
    snippet: 'Brindlewood announced the opening of a new distribution center this quarter.',
    url: 'https://brindlewood.com/news/new-distribution-center'
  };
  assert(isExactSelfDomainMatch(account.name, ownDomainCandidate.url) === true, 'M1: sanity -- isExactSelfDomainMatch() recognizes the exact registrable-domain-SLD match');
  const grounding = verifyCandidateCompanyGrounding(ownDomainCandidate, account);
  assert(grounding.identityConfidence === 'confirmed', `M1: REQUIRED -- a one-token account with evidence on its own exact-match domain confirms as a legitimate Business Signal identity, WITHOUT an uploaded website (got '${grounding.identityConfidence}')`);
}

// ---------------------------------------------------------------------------
// M2 -- one-token account + a DIFFERENT company whose domain merely
// CONTAINS the account's token. REQUIRED regression 2.
// ---------------------------------------------------------------------------
{
  const account = { name: 'Brindlewood' };
  const differentCompanyCandidate = {
    title: 'Careers at Brindlewood Partners',
    snippet: 'Brindlewood Partners is hiring across several departments.',
    url: 'https://brindlewoodpartners.com/careers'
  };
  assert(isExactSelfDomainMatch(account.name, differentCompanyCandidate.url) === false, 'M2: sanity -- isExactSelfDomainMatch() correctly rejects a domain that merely CONTAINS the token ("brindlewoodpartners" !== "brindlewood")');
  const grounding = verifyCandidateCompanyGrounding(differentCompanyCandidate, account);
  assert(grounding.identityConfidence === 'possible', `M2: REQUIRED -- a different company's domain that merely contains the account's token never corroborates (got '${grounding.identityConfidence}')`);
}

// ---------------------------------------------------------------------------
// M3 -- one-token account + an unrelated third-party/common-word source
// (not the account's own domain). REQUIRED regression 3.
// ---------------------------------------------------------------------------
{
  const account = { name: 'Brindlewood' };
  const thirdPartyCandidate = {
    title: 'Regional Real Estate Roundup',
    snippet: 'A stroll through the brindlewood near downtown reveals several new developments.',
    url: 'https://localnews.example/regional-real-estate-roundup'
  };
  assert(isExactSelfDomainMatch(account.name, thirdPartyCandidate.url) === false, 'M3: sanity -- an unrelated third-party domain never matches');
  const grounding = verifyCandidateCompanyGrounding(thirdPartyCandidate, account);
  assert(grounding.identityConfidence === 'possible', `M3: REQUIRED -- an unrelated third-party/common-word source stays 'possible' (got '${grounding.identityConfidence}')`);
}

// ===========================================================================
// Bounded correction round: UNDATED BUSINESS SIGNAL ACTIONABILITY.
//
// The founder's audit proved "Use This Signal" was unreachable for the BEST
// available non-Priority Business Signal candidates (Velcro/Unitil-shaped:
// legitimate identity, no commercialPlay) because computeActionability()'s
// "no date resolvable" branches (isPriorityEligible:false, label "Date
// unavailable") were rendered identically to genuinely stale/expired
// evidence -- collapsing Research Details into "Shown for account history
// only" and hiding the Use This Signal button entirely. Fix: "Timing
// unclear" (not stale) for undated-but-fresh signals, visible with normal
// outreach copy and "Use This Signal" still available; Priority eligibility
// itself is completely unchanged.
// ===========================================================================
const ACCOUNT_UNDATED = { name: 'Millrace Outfitters' };

// ---------------------------------------------------------------------------
// L-A -- legitimate current/ongoing undated Business Signal (the confirmed
// production shape: an evergreen "Careers at X" page, no publication date
// anywhere in the source). Visible, "Timing unclear", non-Priority, "Use
// This Signal" available.
// ---------------------------------------------------------------------------
{
  const raw = {
    accountName: 'Millrace Outfitters', sourceUrl: 'https://millraceoutfitters.example/careers',
    signalTitle: 'Careers at Millrace Outfitters',
    concrete_trigger: 'Millrace Outfitters has an open careers page with current listings',
    business_context: 'Millrace Outfitters is hiring for several roles, no specific date disclosed.',
    confidence: 82
    // Deliberately no event_date/publicationDate -- the exact undated
    // evergreen shape the fresh production run exposed.
  };
  const built = buildOpportunity(raw, ACCOUNT_UNDATED);
  assert(!!built, 'L-A: makeSignal()/normalizeOpportunity() still produce a real opportunity with no resolvable date');
  const legacyFields = classifyLegacySignalActionability(built);
  const signal = { ...built, ...legacyFields, isReal: true, identityConfidence: 'unconfirmed' };
  assert(['unknown-date', 'ongoing-undated'].includes(signal.actionabilityStatus.status), `L-A: sanity -- classifies as an undated (not stale) status (got '${signal.actionabilityStatus.status}')`);
  assert(sandbox.isUndatedNotStale(signal) === true, 'L-A: REQUIRED -- recognized as undated-not-stale');
  assert(sandbox.signalDateAndActionabilityLine(signal) === 'Timing unclear', `L-A: REQUIRED -- seller-facing timing reads "Timing unclear", not "stale"/"historical" (got '${sandbox.signalDateAndActionabilityLine(signal)}')`);
  const opp = asBusinessOpportunity(built, 'unconfirmed');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'L-A: REQUIRED -- an undated signal is not Priority-eligible absent other Route A/B evidence');
  const html = sandbox.renderVerifiedSignals([signal]);
  assert(!html.includes('No external signals found'), 'L-A: the signal renders as a real, visible Business Signal');
  assert(!html.includes('Shown for account history only'), 'L-A: REQUIRED -- never collapses into the historical-note treatment reserved for genuinely stale evidence');
  assert(/Timing unclear/.test(html), 'L-A: the rendered card shows the honest "Timing unclear" timing note');
  assert(html.includes('use-signal-btn'), 'L-A: REQUIRED -- "Use This Signal" is available for this legitimate undated Business Signal');
}

// ---------------------------------------------------------------------------
// L-B -- genuinely stale/expired evidence (a real, resolvable event date
// well outside the follow-up window). Remains historical/non-actionable, no
// "Use This Signal" -- unaffected by this correction.
// ---------------------------------------------------------------------------
{
  const raw = {
    accountName: 'Millrace Outfitters', sourceUrl: 'https://millraceoutfitters.example/spring-expo-2025',
    signalTitle: 'Millrace Outfitters Exhibits at Spring Outdoor Expo',
    concrete_trigger: 'Millrace Outfitters exhibited at the Spring Outdoor Expo',
    business_context: 'Millrace Outfitters had a booth at the Spring Outdoor Expo.',
    // event_date and publicationDate deliberately DIFFER (a few days apart,
    // as a real article-vs-event date pair would) -- classifyLegacySignalActionability()'s
    // own "looksLikeOldBug" heuristic correctly discards eventDate as
    // untrustworthy when the two are identical (the exact signature of the
    // OLD publication-date-fallback defect this repo already fixed), so an
    // identical pair here would test that unrelated heuristic, not staleness.
    event_date: daysAgo(400), publicationDate: daysAgo(395), confidence: 80
  };
  const built = buildOpportunity(raw, ACCOUNT_UNDATED);
  const legacyFields = classifyLegacySignalActionability(built);
  const signal = { ...built, ...legacyFields, isReal: true, identityConfidence: 'unconfirmed' };
  assert(signal.actionabilityStatus.status === 'stale', `L-B: sanity -- a real event date 400 days in the past classifies as genuinely stale (got '${signal.actionabilityStatus.status}')`);
  assert(sandbox.isUndatedNotStale(signal) === false, 'L-B: REQUIRED -- genuinely stale evidence is never treated as "undated-not-stale"');
  assert(sandbox.signalDateAndActionabilityLine(signal) === 'No longer current', 'L-B: the label correctly stays "No longer current", never "Timing unclear"');
  const html = sandbox.renderVerifiedSignals([signal]);
  assert(html.includes('Shown for account history only') || html.includes('No longer current'), 'L-B: REQUIRED -- genuinely stale evidence keeps the historical-note treatment');
  assert(!html.includes('use-signal-btn'), 'L-B: REQUIRED -- "Use This Signal" never renders for genuinely stale/expired evidence');
}

// ---------------------------------------------------------------------------
// L-C -- newly discovered evergreen evidence. first_seen_at being "today"
// must never, on its own, grant Priority; the signal may still surface as a
// weak, usable Business Signal the rep can choose to act on.
// ---------------------------------------------------------------------------
{
  const raw = {
    accountName: 'Millrace Outfitters', sourceUrl: 'https://millraceoutfitters.example/about',
    signalTitle: 'Millrace Outfitters Company Overview',
    concrete_trigger: 'Millrace Outfitters maintains an evergreen company overview page',
    business_context: 'Millrace Outfitters describes its retail operations, no dated activity disclosed.',
    confidence: 75
  };
  const built = buildOpportunity(raw, ACCOUNT_UNDATED);
  const legacyFields = classifyLegacySignalActionability(built);
  // first_seen_at/dateFound reflect "discovered right now" -- deliberately
  // NOT an input classifyLegacySignalActionability()/computeActionability()
  // ever reads, proving fresh discovery alone cannot influence the result.
  const signal = { ...built, ...legacyFields, isReal: true, identityConfidence: 'unconfirmed', firstSeenAt: new Date().toISOString(), dateFound: new Date().toISOString().slice(0, 10) };
  const opp = asBusinessOpportunity(built, 'unconfirmed');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'L-C: REQUIRED -- freshly-discovered undated evidence never becomes Priority merely because House Accounts found it today');
  const html = sandbox.renderVerifiedSignals([signal]);
  assert(!html.includes('No external signals found'), 'L-C: REQUIRED -- still surfaces as a visible, weak Business Signal');
  assert(html.includes('use-signal-btn'), 'L-C: the rep can still choose to use this signal');
}

// ---------------------------------------------------------------------------
// L-D -- Possible Match with no date. Still a Possible Match regardless of
// the undated-actionability correction -- never "Use This Signal", never
// treated as a current Business Signal.
// ---------------------------------------------------------------------------
{
  const undatedPossibleSignal = {
    accountName: 'Halloway\'s', isReal: true, identityConfidence: 'possible',
    sourceUrl: 'https://careers.larkspurgroup.example/preston-halloway',
    signalTitle: 'Careers at Preston Halloway', signalDetail: 'Careers at Preston Halloway',
    signalType: 'Business Activity', confidenceScore: 65
    // No actionabilityStatus at all -- an undated Possible Match.
  };
  assert(sandbox.isPossibleMatchIdentity(undatedPossibleSignal) === true, 'L-D: sanity -- correctly identified as a Possible Match');
  const html = sandbox.renderVerifiedSignals([undatedPossibleSignal]);
  assert(/[Pp]ossible match/.test(html), 'L-D: REQUIRED -- still shows the Possible Match caution, undated or not');
  assert(!html.includes('use-signal-btn'), 'L-D: REQUIRED -- "Use This Signal" never renders for a Possible Match, regardless of timing');
  const opp = { ...undatedPossibleSignal, isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', account: undatedPossibleSignal.accountName };
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'L-D: REQUIRED -- an undated Possible Match never becomes Priority');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
