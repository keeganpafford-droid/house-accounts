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
// Covers: the new Why Now -> The Opportunity -> Activation Ideas -> Why It
// Could Matter -> Best Next Question card hierarchy; hidden-when-empty
// behavior for the three new optional sections; the primary card's
// strongest-~3-ideas cap vs. Prepare for Call's full list; old-signal
// backward compatibility (Opportunity falls back through legacy fields,
// Activation Ideas/Why It Could Matter stay hidden); and Prepare for Call's
// demotion of Best Next Move/Email/Call Script/Success Looks Like into a
// collapsed Outreach section.
//
// Usage: node scripts/test-commercial-intelligence-card-ux.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const DASHBOARD_SRC = readFileSync(DASHBOARD_PATH, 'utf8');
const LINES = DASHBOARD_SRC.split('\n');

function extractBlock(label, startLine, endLine, expectedPrefix){
  const slice = LINES.slice(startLine - 1, endLine).join('\n');
  if(!slice.startsWith(expectedPrefix)){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in this test.`);
  }
  const trimmed = slice.trimEnd();
  if(!trimmed.endsWith('}') && !trimmed.endsWith('};')){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${endLine} does not close as expected -- update the line range.`);
  }
  return slice;
}

// Same verified-working ranges as scripts/test-preview-qa-round7-live-render.js.
const TIMEBOX_CONFIG_SRC = extractBlock('TIMEBOX_CONFIG', 2774, 2779, 'const TIMEBOX_CONFIG = {');
const IS_RELATIONSHIP_EXPANSION_SRC = extractBlock('isRelationshipExpansionOpportunity', 3009, 3012, 'function isRelationshipExpansionOpportunity(');
const DEDUPE_AND_IDENTITY_BLOCK = extractBlock('dedupe-and-identity-helpers', 2927, 3373, 'function cleanOpportunityToken(');
const CARD_AND_MODAL_BLOCK = extractBlock('card-and-modal-helpers-plus-signal-derived', 4679, 6125, 'function confidenceLabel(');
const OPPORTUNITY_GENERATION_BLOCK = extractBlock('opportunity-generation', 8112, 8652, 'function estimateFutureValue(account, opportunityType){');
const SALES_PLAY_BLOCK = extractBlock('sales-play-grounding', 8249, 9556, 'function salesPlayModeFromOpp(');
const SCORING_AND_TIMEBOX_BLOCK = extractBlock('scoring-and-timebox-helpers', 9559, 10062, 'function normalizeSignalLayerType(');
const ESCAPE_HTML_SRC = extractBlock('escapeHtml', 10788, 10791, 'function escapeHtml(');
const FMT_MONEY_SRC = extractBlock('fmtMoney', 8164, 8166, 'function fmtMoney(');
const CLAMP_SCORE_SRC = extractBlock('clampScore', 8169, 8171, 'function clampScore(');
const REASON_AND_STARTER_BLOCK = extractBlock('reason-and-starter-helpers', 7567, 7605, 'function getReasonToReachOutTitle(opp){');

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
    SCORING_AND_TIMEBOX_BLOCK
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
for (const fn of [sandbox.renderRepOpportunityCard, sandbox.renderOpportunitySection, sandbox.renderActivationIdeasSection, sandbox.renderWhyItCouldMatterSection, sandbox.getCommercialPlayNarrative, sandbox.isCommercialIntelligenceSignal, sandbox.renderCommercialOpportunitySection]){
  assert(typeof fn === 'function', `extraction produced a real function (${fn && fn.name})`);
}

// ===========================================================================
// New-schema signal, full commercial intelligence: all five sections render,
// in the approved order, with real content.
// ===========================================================================
{
  const opp = baseOpp({
    commercialPlay: { concept: '50 Summers', narrative: 'Build a limited collection celebrating 50 summers of backyard memories.' },
    activationIdeas: ['Premium pool/beach towels', 'Heritage hats', 'Installer/team workwear', 'Customer cooler kits'],
    expansionPotential: { narrative: 'Field apparel, seasonal hiring, and the Azureon relationship could all recur beyond this one order.', tags: ['recurring-program', 'parent-org-route'] }
  });
  const html = sandbox.renderRepOpportunityCard(opp);
  const whyNowIdx = html.indexOf('Why Now');
  const opportunityIdx = html.indexOf('The Opportunity');
  const ideasIdx = html.indexOf('Activation Ideas');
  const mattersIdx = html.indexOf('Why It Could Matter');
  const questionIdx = html.indexOf('Best Next Question');
  assert([whyNowIdx, opportunityIdx, ideasIdx, mattersIdx, questionIdx].every(i => i !== -1), `all five section labels are present (got indices ${JSON.stringify([whyNowIdx, opportunityIdx, ideasIdx, mattersIdx, questionIdx])})`);
  assert(whyNowIdx < opportunityIdx && opportunityIdx < ideasIdx && ideasIdx < mattersIdx && mattersIdx < questionIdx, 'the five sections render in the approved order: Why Now -> The Opportunity -> Activation Ideas -> Why It Could Matter -> Best Next Question');
  assert(html.includes('50 Summers'), 'the commercial play concept renders on the card');
  assert(html.includes('50 summers of backyard memories'), 'the commercial play narrative renders on the card');
  assert(html.includes('Premium pool/beach towels') && html.includes('Heritage hats') && html.includes('Installer/team workwear'), 'specific activation ideas render as chips');
  assert(!html.includes('Why it matters'), 'the old generic "Why it matters" label is gone, replaced by "The Opportunity"');
  assert(!html.includes('>Conversation starter<'), 'the old "Conversation starter" label is gone, replaced by "Best Next Question"');
}

// ===========================================================================
// Primary card caps Activation Ideas at ~3; Prepare for Call's full detail
// helper shows the complete list. Two strong ideas are shown as two, never
// padded to three.
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
  assert(cardVisibleHeader.includes('Idea One') && cardVisibleHeader.includes('Idea Two') && cardVisibleHeader.includes('Idea Three'), 'the primary card shows the first 3 activation ideas');
  assert(!cardVisibleHeader.includes('Idea Four') && !cardVisibleHeader.includes('Idea Five') && !cardVisibleHeader.includes('Idea Six'), 'the primary card does NOT visibly show ideas beyond the strongest ~3');
  const fullHtml = sandbox.renderCommercialOpportunitySection(opp);
  assert(fullHtml.includes('Idea Four') && fullHtml.includes('Idea Five') && fullHtml.includes('Idea Six'), 'Prepare for Call\'s full commercial-opportunity detail shows the complete (untruncated) activation-ideas list');

  const twoIdeaOpp = baseOpp({ activationIdeas: ['Only Idea One', 'Only Idea Two'] });
  const twoIdeaHtml = sandbox.renderRepOpportunityCard(twoIdeaOpp);
  const chipCount = (twoIdeaHtml.match(/opp-idea-chip/g) || []).length;
  assert(chipCount === 2, `exactly 2 ideas render as 2 chips, never padded toward 3 (got ${chipCount})`);
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
  assert(!visibleHeader.includes('The Opportunity'), 'a new-schema signal with no credible commercial play hides "The Opportunity" section entirely');
  assert(!visibleHeader.includes('Activation Ideas'), 'Activation Ideas is hidden when the list is empty');
  assert(!visibleHeader.includes('Why It Could Matter'), 'Why It Could Matter is hidden when there is no expansion-potential narrative');
  assert(!visibleHeader.includes('Some generic legacy why text'), 'the legacy whyThisMatters text never leaks into a new-schema signal\'s hidden Opportunity section');
  // Why Now and Best Next Question are unaffected by the missing optional layer.
  assert(visibleHeader.includes('Why Now') && html.includes('Best Next Question'), 'Why Now and Best Next Question still render normally when the optional commercial layer is absent');
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
  assert(html.includes('The Opportunity'), 'an old signal still shows an Opportunity section, via legacy fallback');
  assert(html.includes('Recognition moments create a natural reason'), 'the Opportunity section for an old signal falls back through the legacy whyThisMatters text');
  assert(!html.includes('Activation Ideas'), 'Activation Ideas stays hidden for an old signal -- never invented retroactively');
  assert(!html.includes('Why It Could Matter'), 'Why It Could Matter stays hidden for an old signal -- never invented retroactively');
  assert(html.includes('Best Next Question'), 'Best Next Question still renders normally for an old signal (conversationStarter/suggestedOpener already existed)');
}

// ===========================================================================
// QA correction 1: Prepare for Call's FULL rendered output (createSalesPlayPanel(),
// executed for real -- not just renderCommercialOpportunitySection() in
// isolation) must not prominently manufacture a commercial play, and the
// secondary Outreach templates (Best Next Move/Email/Call Script) must not
// masquerade the deterministic legacy fallback text as model-supported
// commercial intelligence, for a new-schema signal with no credible play.
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
  assert(!/The Opportunity/.test(salesPlayHtml), 'Prepare for Call does not show a "The Opportunity" group at all for a no-play new-schema signal');
  assert(!salesPlayHtml.includes('employee apparel, onboarding materials'), 'Prepare for Call\'s full rendered output (including the demoted Outreach templates -- Best Next Move/Email/Call Script) never surfaces the deterministic legacy fallback text as if it were a real commercial play');
}

// ===========================================================================
// Prepare for Call: Best Next Move / Email / Call Script / Success Looks
// Like are demoted into a collapsed "Outreach" <details> block, separate
// from the prominent Call Plan group. Structural (source-text) checks,
// matching this repo's convention for proving template STRUCTURE.
// ===========================================================================
{
  const salesPlaySrc = SALES_PLAY_BLOCK;
  const callPlanMatch = salesPlaySrc.match(/sales-play-group-label">Call Plan<\/div>[\s\S]*?(?=<\/div>\s*<!-- product\/commercial-opportunity-intelligence: Email)/);
  assert(!!callPlanMatch, 'sanity: found the Call Plan group in the extracted createSalesPlayPanel() source');
  assert(!/Best Next Move/.test(callPlanMatch[0]), 'the Call Plan group no longer contains "Best Next Move" -- it has been demoted out of the prominent group');
  assert(/Best Next Question/.test(callPlanMatch[0]), 'the Call Plan group renders "Best Next Question" (the relabeled Conversation Starter)');

  const outreachDetailsMatch = salesPlaySrc.match(/<details class="sales-play-group supporting">\s*<summary class="sales-play-group-label"[^>]*>Outreach<\/summary>[\s\S]*?<\/details>/);
  assert(!!outreachDetailsMatch, 'the Outreach section is a collapsed <details> block (same pattern Research Details already uses), not an always-open group');
  assert(/Best Next Move/.test(outreachDetailsMatch[0]), 'Best Next Move is demoted INTO the collapsed Outreach block');
  assert(/Email/.test(outreachDetailsMatch[0]) && /Call Script/.test(outreachDetailsMatch[0]) && /Success Looks Like/.test(outreachDetailsMatch[0]), 'Email, Call Script, and Success Looks Like all still exist, inside the same collapsed Outreach block -- nothing was deleted, only demoted');

  assert(/renderCommercialOpportunitySection\(opp\)/.test(salesPlaySrc), 'createSalesPlayPanel() renders the full commercial-opportunity detail via renderCommercialOpportunitySection()');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
