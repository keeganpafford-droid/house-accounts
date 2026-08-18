// product/commercial-opportunity-intelligence -- Commit 2 (primary card /
// Prepare for Call UX) regression coverage.
//
// Extracts the REAL, verbatim card-rendering functions from
// dashboard/index.html into a vm sandbox (same large contiguous blocks
// scripts/test-preview-qa-round7-live-render.js already extracts and
// verifies work end-to-end) and calls renderRepOpportunityCard()/the new
// commercial-intelligence helpers directly -- both are pure string-building
// functions with no DOM side effects, so no document stubbing beyond what
// the existing convention already provides.
//
// Covers: the Why Now -> Status -> The Play -> Ideas to Send -> Recommended
// contact -> How to Approach card hierarchy; hidden-when-empty behavior for
// the optional sections; the primary card's strongest-~2-ideas cap vs.
// Prepare for Call's full list; old-signal backward compatibility
// (Opportunity falls back through legacy fields, Activation Ideas stay
// hidden); and Prepare for Call's demotion of Best Next Move/Email/Call
// Script/Success Looks Like into a collapsed Outreach section.
//
// Compact Business Signal / Opportunity Cards sprint: the Dashboard card no
// longer renders Why It Could Grow at all (renderWhyItCouldMatterSection()
// is no longer called from renderRepOpportunityCard()) -- it remains a
// Prepare for Call-only detail, via renderWhyItCouldGrowSection(). The
// function/data are untouched; only the primary card's render call was
// removed. Activation Ideas on the card dropped from a cap of 3 to 2.
//
// Usage: node scripts/test-commercial-intelligence-card-ux.js
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();


// Same verified-working ranges as scripts/test-preview-qa-round7-live-render.js.
const TIMEBOX_CONFIG_SRC = extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG');
const IS_RELATIONSHIP_EXPANSION_SRC = extractFn(DASHBOARD_SRC, 'isRelationshipExpansionOpportunity');
const DEDUPE_AND_IDENTITY_BLOCK = extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(', 'function isWebResearchSignal(opp){');
const CARD_AND_MODAL_BLOCK = extractRange(DASHBOARD_SRC, 'function confidenceLabel(', 'function addSignalDerivedOpportunities(');
const OPPORTUNITY_GENERATION_BLOCK = extractRange(DASHBOARD_SRC, 'function estimateFutureValue(account, opportunityType){', 'function getPriorityTier(');
const SALES_PLAY_BLOCK = extractRange(DASHBOARD_SRC, 'function salesPlayModeFromOpp(', 'function renderPipelineTable(');
const SCORING_AND_TIMEBOX_BLOCK = extractRange(DASHBOARD_SRC, 'function normalizeSignalLayerType(', 'function feedSummary(');
const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
const FMT_MONEY_SRC = extractFn(DASHBOARD_SRC, 'fmtMoney');
const CLAMP_SCORE_SRC = extractFn(DASHBOARD_SRC, 'clampScore');
const REASON_AND_STARTER_BLOCK = extractRange(DASHBOARD_SRC, 'function getReasonToReachOutTitle(opp){', 'function getConversationStarterText(');
// Signal feedback / organizational-learning foundation: renderSingleVerifiedSignal()/
// useSignalAsRepSelected()/createSalesPlayPanel() -- all inside
// CARD_AND_MODAL_BLOCK/SALES_PLAY_BLOCK below -- now call these. Pure
// fire-and-forget event logging / best-effort DOM hydration, with no
// bearing on this file's card/modal markup assertions, so they're
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
  // QA correction 1: document.body.insertAdjacentHTML/lastElementChild are
  // stubbed (capturing the rendered HTML into sandbox.__lastSalesPlayHtml)
  // so window.createSalesPlayPanel(opp) -- otherwise untestable without a
  // real DOM -- can be called directly and its actual rendered output
  // inspected, the same way renderRepOpportunityCard()'s return value
  // already is. Harmless for every other test block in this file, which
  // doesn't call createSalesPlayPanel().
  const fakeModal = { querySelector: () => ({ focus(){} }), querySelectorAll: () => [] };
  const sandbox = {
    console,
    window: { accountRadarAccounts: [], HouseAccountsHeader: { beginOverlay(){} } },
    document: {
      getElementById: () => ({ textContent: '', innerHTML: '', style: {} }),
      querySelectorAll: () => [],
      addEventListener(){},
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
    OPPORTUNITY_GENERATION_BLOCK,
    REASON_AND_STARTER_BLOCK,
    SALES_PLAY_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK,
    // Placed LAST, deliberately: CARD_AND_MODAL_BLOCK/SALES_PLAY_BLOCK's
    // wide contiguous ranges already include the REAL wireOutreachRow()/
    // hydrateOutreachRow() declarations (they live immediately before
    // createSalesPlayPanel() in the real file). A later `function name(){}`
    // declaration in the same scope overwrites an earlier one of the same
    // name, so this stub block must come after those ranges to take effect.
    SIGNAL_EVENTS_STUB_SOURCE
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'commercial-intelligence-card-ux-extract.js' }).runInContext(sandbox);
  return sandbox;
}

function baseOpp(overrides = {}){
  return {
    account: 'Northern Pool & Spa',
    accountName: 'Northern Pool & Spa',
    uploadId: 'upload-1',
    signalLayerType: 'Business Activity Signal',
    canonicalEventType: 'EVENT_AWARD',
    signalTitle: 'Northern Pool & Spa 50th Anniversary',
    signalDetail: 'Northern Pool & Spa was founded in 1976, making 2026 its 50th anniversary.',
    whatChanged: 'Northern Pool & Spa was founded in 1976, making 2026 its 50th anniversary.',
    eventDate: '2026-06-01',
    eventDateConfidence: 'exact',
    actionabilityStatus: { status: 'ongoing', tense: 'present' },
    sourceUrl: 'https://example.com/northern-pool-50th',
    cleanSourceName: 'Example Wire',
    conversationStarter: 'Are merchandise and employee gear still handled here, or has any of that moved to Azureon?',
    confidence: 0.9,
    isVerifiedSignalOpportunity: false,
    ...overrides
  };
}

const sandbox = makeSandbox();
for (const fn of [sandbox.renderRepOpportunityCard, sandbox.renderOpportunitySection, sandbox.renderActivationIdeasSection, sandbox.renderWhyItCouldMatterSection, sandbox.getCommercialPlayNarrative, sandbox.isCommercialIntelligenceSignal, sandbox.renderThePlaySection, sandbox.renderIdeasToSendSection, sandbox.renderWhyItCouldGrowSection]){
  assert(typeof fn === 'function', `extraction produced a real function (${fn && fn.name})`);
}

// ===========================================================================
// New-schema signal, full commercial intelligence: the Dashboard card's
// remaining sections render in the approved order, with real content.
//
// QA correction 4 (Product Finding 2 -- UX simplification): labels renamed
// toward one consistent mental model -- Why Now / The Play / Ideas to Send
// / How to Approach (previously The Opportunity / Activation Ideas / Best
// Next Question). Same underlying fields, same hide-when-empty rules.
//
// Compact Business Signal / Opportunity Cards sprint: Why It Could Grow is
// no longer part of this order at all -- it is REQUIRED to be entirely
// absent from the Dashboard card now, even when a real expansionPotential
// narrative exists (proving the removal is unconditional, not merely
// "still hidden because this fixture happens to have none" the way the
// existing absence tests further down already prove for the *empty* case).
// It must still render via Prepare for Call's own
// renderWhyItCouldGrowSection(), proving the underlying data/function are
// untouched -- only the card's render call was removed.
// ===========================================================================
{
  const opp = baseOpp({
    commercialPlay: { concept: '50 Summers', narrative: 'Build a limited collection celebrating 50 summers of backyard memories.' },
    activationIdeas: ['Premium pool/beach towels', 'Heritage hats', 'Installer/team workwear', 'Customer cooler kits'],
    expansionPotential: { narrative: 'Field apparel, seasonal hiring, and the Azureon relationship could all recur beyond this one order.', tags: ['recurring-program', 'parent-org-route'] },
    isVerifiedSignalOpportunity: true
  });
  const html = sandbox.renderRepOpportunityCard(opp);
  // Scoped to the visible header only for every "must NOT appear" check --
  // opp-card-actions' "Prepare for Call" button embeds the FULL opp object
  // (every activation idea, the complete expansion-potential narrative,
  // etc.) as a JSON payload for its onclick handler, which is necessary
  // (Prepare for Call needs the complete data) but would otherwise make a
  // whole-card substring check see text that is not actually visibly
  // rendered. Same convention the activation-ideas-cap test below already
  // uses.
  const visibleHeader = html.split('opp-card-actions')[0];
  const whyNowIdx = html.indexOf('Why Now');
  const statusIdx = html.indexOf('Status');
  const playIdx = html.indexOf('The Play');
  const ideasIdx = html.indexOf('Ideas to Send');
  const contactIdx = html.indexOf('Recommended contact');
  const approachIdx = html.indexOf('How to Approach');
  const indices = { whyNowIdx, statusIdx, playIdx, ideasIdx, contactIdx, approachIdx };
  assert(Object.values(indices).every(i => i !== -1), `all six section labels are present (got ${JSON.stringify(indices)})`);
  assert(whyNowIdx < statusIdx && statusIdx < playIdx && playIdx < ideasIdx && ideasIdx < contactIdx && contactIdx < approachIdx, `REQUIRED: the Dashboard card sections render in the approved order: Why Now -> Status (timing) -> The Play -> Ideas to Send -> Recommended contact -> How to Approach (got ${JSON.stringify(indices)})`);
  assert(html.includes('50 Summers'), 'the commercial play concept renders on the card');
  assert(html.includes('50 summers of backyard memories'), 'the commercial play narrative renders on the card');
  assert(visibleHeader.includes('Premium pool/beach towels') && visibleHeader.includes('Heritage hats'), 'specific activation ideas render as chips');
  assert(!visibleHeader.includes('Installer/team workwear') && !visibleHeader.includes('Customer cooler kits'), 'the Dashboard card does not visibly show ideas beyond the strongest ~2, even though the underlying data has four');
  assert(!html.includes('Why it matters'), 'the old generic "Why it matters" label is gone, replaced by "The Play"');
  assert(!html.includes('>Conversation starter<'), 'the old "Conversation starter" label is gone, replaced by "How to Approach"');

  // REQUIRED: Why It Could Grow is unconditionally absent from the
  // Dashboard card -- this fixture has a real, non-empty expansionPotential
  // narrative, so the only reason it can be missing is the sprint's
  // intentional removal, not the pre-existing hide-when-empty rule.
  assert(!visibleHeader.includes('Why It Could Grow'), 'REQUIRED: the Dashboard card never renders Why It Could Grow, even when a real expansion-potential narrative exists');
  assert(!visibleHeader.includes('Field apparel, seasonal hiring'), 'REQUIRED: the expansion-potential narrative text itself never leaks onto the visible Dashboard card');

  // REQUIRED: Prepare for Call can still render Why It Could Grow for the
  // exact same opportunity -- the underlying function/data are untouched,
  // only the Dashboard card's call to them was removed.
  const growHtml = sandbox.renderWhyItCouldGrowSection(opp);
  assert(growHtml.includes('Why It Could Grow'), 'REQUIRED: renderWhyItCouldGrowSection() (used by Prepare for Call) still renders Why It Could Grow for the same opportunity');
  assert(growHtml.includes('Field apparel, seasonal hiring, and the Azureon relationship'), 'REQUIRED: Prepare for Call still shows the real expansion-potential narrative text');
}

// ===========================================================================
// Compact Business Signal / Opportunity Cards sprint: the Dashboard card
// caps Activation Ideas at ~2 (was ~3); Prepare for Call's full detail
// helper is untouched and still shows the complete list. One strong idea
// still renders as one, never padded toward two.
// ===========================================================================
{
  const opp = baseOpp({ activationIdeas: ['Idea One', 'Idea Two', 'Idea Three', 'Idea Four', 'Idea Five', 'Idea Six'] });
  const cardHtml = sandbox.renderRepOpportunityCard(opp);
  // Scoped to the visible header only -- opp-card-actions' "Prepare for
  // Call" button embeds the FULL opp object (including all 6 ideas) as a
  // JSON payload for its onclick handler, which is necessary (Prepare for
  // Call needs the complete data) but would otherwise make a whole-card
  // substring check see ideas that are not actually visibly rendered.
  const cardVisibleHeader = cardHtml.split('opp-card-actions')[0];
  assert(cardVisibleHeader.includes('Idea One') && cardVisibleHeader.includes('Idea Two'), 'REQUIRED: the Dashboard card shows the first 2 activation ideas');
  assert(!cardVisibleHeader.includes('Idea Three') && !cardVisibleHeader.includes('Idea Four') && !cardVisibleHeader.includes('Idea Five') && !cardVisibleHeader.includes('Idea Six'), 'REQUIRED: the Dashboard card does NOT visibly show ideas beyond the strongest ~2 (cap dropped from 3 to 2)');
  const fullHtml = sandbox.renderIdeasToSendSection(opp);
  assert(fullHtml.includes('Idea Three') && fullHtml.includes('Idea Four') && fullHtml.includes('Idea Five') && fullHtml.includes('Idea Six'), 'Prepare for Call\'s Ideas to Send section is unaffected by the card\'s cap change -- still shows the complete (untruncated) activation-ideas list');

  const oneIdeaOpp = baseOpp({ activationIdeas: ['Only Idea One'] });
  const oneIdeaHtml = sandbox.renderRepOpportunityCard(oneIdeaOpp);
  const chipCount = (oneIdeaHtml.match(/opp-idea-chip/g) || []).length;
  assert(chipCount === 1, `exactly 1 idea renders as 1 chip, never padded toward 2 (got ${chipCount})`);
}

// ===========================================================================
// Absence is honored: a new-schema signal (activationIdeas present as an
// array, proving normalizeCommercialIntelligence() ran) with NO credible
// commercial play must hide The Opportunity entirely -- never fall back to
// generic why-this-matters filler dressed up as an opportunity.
// ===========================================================================
{
  const opp = baseOpp({ commercialPlay: null, activationIdeas: [], expansionPotential: null, whyThisMatters: 'Some generic legacy why text that must NOT appear as the Opportunity.' });
  assert(sandbox.isCommercialIntelligenceSignal(opp) === true, 'sanity: this is recognized as a new-schema signal (activationIdeas is a real array)');
  const html = sandbox.renderRepOpportunityCard(opp);
  const visibleHeader = html.split('opp-card-actions')[0];
  assert(!visibleHeader.includes('The Play'), 'a new-schema signal with no credible commercial play hides "The Play" section entirely');
  assert(!visibleHeader.includes('Ideas to Send'), 'Ideas to Send is hidden when the list is empty');
  assert(!visibleHeader.includes('Why It Could Grow'), 'Why It Could Grow is hidden when there is no expansion-potential narrative');
  assert(!visibleHeader.includes('Some generic legacy why text'), 'the legacy whyThisMatters text never leaks into a new-schema signal\'s hidden Play section');
  // Why Now and How to Approach are unaffected by the missing optional layer.
  assert(visibleHeader.includes('Why Now') && html.includes('How to Approach'), 'Why Now and How to Approach still render normally when the optional commercial layer is absent');
}

// ===========================================================================
// Backward compatibility: an OLD signal that predates this feature entirely
// (no commercialPlay/activationIdeas/expansionPotential keys at all) still
// renders a coherent card -- Opportunity falls back through the legacy
// narrative fields, Activation Ideas/Why It Could Matter stay hidden (never
// invented for old data).
// ===========================================================================
{
  const opp = baseOpp({ whyThisMatters: 'Recognition moments create a natural reason to discuss employee gifts and customer appreciation.' });
  delete opp.commercialPlay;
  delete opp.activationIdeas;
  delete opp.expansionPotential;
  assert(sandbox.isCommercialIntelligenceSignal(opp) === false, 'sanity: an old signal with none of the three new keys is correctly recognized as pre-dating this feature');
  const html = sandbox.renderRepOpportunityCard(opp);
  // Required test 7: old-signal compatibility still renders.
  assert(html.includes('The Play'), 'required test 7: an old signal still shows a Play section, via legacy fallback');
  assert(html.includes('Recognition moments create a natural reason'), 'required test 7: the Play section for an old signal falls back through the legacy whyThisMatters text');
  assert(!html.includes('Ideas to Send'), 'required test 7: Ideas to Send stays hidden for an old signal -- never invented retroactively');
  assert(!html.includes('Why It Could Grow'), 'required test 7: Why It Could Grow stays hidden for an old signal -- never invented retroactively');
  assert(html.includes('How to Approach'), 'required test 7: How to Approach still renders normally for an old signal (conversationStarter/suggestedOpener already existed)');
}

// ===========================================================================
// QA correction 1 (still true after the round 4 hierarchy simplification):
// Prepare for Call's FULL rendered output (createSalesPlayPanel(), executed
// for real) must not prominently manufacture a commercial play, and the
// secondary Outreach templates (Email/Call Script) must not masquerade the
// deterministic legacy fallback text as model-supported commercial
// intelligence, for a new-schema signal with no credible play.
// ===========================================================================
{
  const genericFallbackText = 'Facility launches usually create needs around employee apparel, onboarding materials, safety items, local PR giveaways, and opening-day gifts.';
  const opp = baseOpp({
    account: 'Thin Evidence Co', accountName: 'Thin Evidence Co',
    signalTitle: 'Hiring Warehouse Associates',
    signalDetail: 'Thin Evidence Co posted three warehouse associate job listings on its careers page this week.',
    whatChanged: 'Thin Evidence Co posted three warehouse associate job listings on its careers page this week.',
    conversationStarter: 'Is warehouse staffing centralized, or does each location handle its own hiring?',
    commercialPlay: null, activationIdeas: [], expansionPotential: null,
    // Exactly what makeSignal() actually produces for this scenario (see
    // scripts/test-commercial-intelligence-no-play-consistency.js item 1) --
    // the deterministic legacy fallback, present for validateOpportunity()/
    // old-consumer compatibility, NOT a real model-supported play.
    reasonToReachOut: genericFallbackText, whyNow: genericFallbackText, whyItMattersForPromo: genericFallbackText
  });
  sandbox.window.createSalesPlayPanel(opp);
  const salesPlayHtml = sandbox.__lastSalesPlayHtml || '';
  assert(salesPlayHtml.length > 0, 'sanity: createSalesPlayPanel() actually rendered a modal');
  assert(!salesPlayHtml.includes('sales-play-group-label">The Play<'), 'Prepare for Call does not render a "The Play" group at all for a no-play new-schema signal (an HTML comment naming the section is fine -- the rendered group itself must not appear)');
  assert(!salesPlayHtml.includes('employee apparel, onboarding materials'), 'Prepare for Call\'s full rendered output never surfaces the deterministic legacy fallback text as if it were a real commercial play');
}

// ===========================================================================
// Required test 8 + 9 (Product Finding 2 -- UX simplification): the
// simplified 8-item Prepare for Call hierarchy renders in the founder's
// approved order, and Best Next Move / Opportunity Summary / Success Looks
// Like -- which only ever restated The Play once it existed -- no longer
// compete with the primary intelligence anywhere in the rendered output
// (not even demoted into Outreach). buildConciseSalesPlay() itself is
// UNCHANGED (still computes these fields, reusable/tested elsewhere) --
// this is a rendering-hierarchy change, not a deletion of that logic.
// Structural (source-text) checks, matching this repo's convention for
// proving template STRUCTURE.
// ===========================================================================
{
  const opp = baseOpp({
    commercialPlay: { concept: '50 Summers', narrative: 'Build a limited collection celebrating 50 summers of backyard memories.' },
    activationIdeas: ['Premium pool/beach towels'],
    expansionPotential: { narrative: 'Field apparel could recur beyond this one order.', tags: ['recurring-program'] },
    isVerifiedSignalOpportunity: true
  });
  sandbox.window.createSalesPlayPanel(opp);
  const salesPlayHtml = sandbox.__lastSalesPlayHtml || '';

  // Required test 8: the 8-item hierarchy renders in order.
  const labels = ['Verified Signal / Evidence', 'The Play', 'Ideas to Send', 'Why It Could Grow', 'Recommended Contact', 'How to Approach', 'Account / Purchase Context', 'Research Details'];
  const indices = labels.map(l => salesPlayHtml.indexOf(l));
  assert(indices.every(i => i !== -1), `required test 8: all 8 hierarchy labels are present (got indices ${JSON.stringify(indices)} for ${JSON.stringify(labels)})`);
  assert(indices.every((idx, i) => i === 0 || idx > indices[i - 1]), `required test 8: the 8 groups render in the founder's approved order (got indices ${JSON.stringify(indices)})`);

  // Required test 9: Best Next Move / Opportunity Summary / Success Looks
  // Like no longer appear anywhere in the rendered output.
  assert(!/Best Next Move/.test(salesPlayHtml), 'required test 9: "Best Next Move" no longer renders anywhere in Prepare for Call');
  assert(!/Opportunity Summary/.test(salesPlayHtml), 'required test 9: "Opportunity Summary" no longer renders anywhere in Prepare for Call');
  assert(!/Success Looks Like/.test(salesPlayHtml), 'required test 9: "Success Looks Like" no longer renders anywhere in Prepare for Call');

  // Outreach still exists, collapsed, with Email/Call Script/Questions to
  // Ask -- nothing deleted from THOSE, only Best Next Move/Success Looks
  // Like removed.
  const outreachDetailsMatch = salesPlayHtml.match(/<details class="sales-play-group supporting">\s*<summary class="sales-play-group-label"[^>]*>Outreach<\/summary>[\s\S]*?<\/details>/);
  assert(!!outreachDetailsMatch, 'the Outreach section is still a collapsed <details> block');
  assert(/Email/.test(outreachDetailsMatch[0]) && /Call Script/.test(outreachDetailsMatch[0]) && /Questions to Ask/.test(outreachDetailsMatch[0]), 'Email, Call Script, and Questions to Ask still exist inside the collapsed Outreach block');

  // Research Details still exists, collapsed, but no longer contains
  // Opportunity Summary (only the additional-opportunities/supporting-
  // research/contact-meta detail survives there).
  const researchDetailsMatch = salesPlayHtml.match(/<details class="sales-play-group supporting">\s*<summary class="sales-play-group-label"[^>]*>Research Details<\/summary>[\s\S]*?<\/details>/);
  assert(!!researchDetailsMatch, 'Research Details is still a collapsed <details> block');
  assert(!/Opportunity Summary/.test(researchDetailsMatch[0]), 'Opportunity Summary no longer renders inside Research Details either');
}

// ===========================================================================
// Structural (source-text) checks on the extracted createSalesPlayPanel()
// source, matching this repo's convention for proving template STRUCTURE.
// Note: buildConciseSalesPlay() still computes play.bestNextMoveCombined/
// play.opportunitySummary/play.successLooksLike (unchanged, reusable,
// tested elsewhere -- e.g. scripts/test-paid-beta-sprint.js), and
// formatSalesPlayClipboard() (the separate "Copy All" clipboard utility,
// not part of the visible modal hierarchy) still legitimately reads them --
// so the source-text still names these fields. The functional assertions
// above (against the actual RENDERED modal HTML) are what prove they no
// longer appear as visible, competing sections.
// ===========================================================================
{
  const salesPlaySrc = SALES_PLAY_BLOCK;
  assert(/renderThePlaySection\(opp\)/.test(salesPlaySrc), 'createSalesPlayPanel() renders The Play via renderThePlaySection()');
  assert(/renderIdeasToSendSection\(opp\)/.test(salesPlaySrc), 'createSalesPlayPanel() renders Ideas to Send via renderIdeasToSendSection()');
  assert(/renderWhyItCouldGrowSection\(opp\)/.test(salesPlaySrc), 'createSalesPlayPanel() renders Why It Could Grow via renderWhyItCouldGrowSection()');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
