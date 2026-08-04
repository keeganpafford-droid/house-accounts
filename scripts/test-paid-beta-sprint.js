// Paid-beta trust-and-usability sprint — automated coverage for Priorities
// 1-5 (Priority 6/weekly-digest coverage lives in
// scripts/test-weekly-scan-reliability.js, alongside the rest of
// api/weekly-scan.js's existing test suite).
//
// Section A imports the REAL exported functions from api/research-batch.js
// (signal-date-truth machinery + grounded-outreach fallback templates).
// Section B extracts the REAL, verbatim source of the dashboard-side
// functions from dashboard/index.html (two large contiguous blocks, each
// self-verified against an exact line range) and runs them in a vm sandbox
// -- nothing here is a reimplementation of the production logic.
//
// Usage: node scripts/test-paid-beta-sprint.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  signalEventCategory, resolveSignalEventDate, computeActionability,
  oneHistoricalOrderFact, salesReadyOpener, salesReadyWhy, makeSignal, EVENT_LIKE_TYPES
} from '../api/research-batch.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Section A — Priority 1: signal-date truth (real research-batch.js exports)
// ===========================================================================

const NOW = new Date('2026-08-04T00:00:00Z');

{
  // Required test 1: Natural Products Expo West 2023 discovered in 2026 --
  // excluded from current priorities.
  const cat = signalEventCategory('EVENT_TRADE_SHOW');
  const resolved = resolveSignalEventDate(
    {}, 'Natural Products Expo West 2023 exhibitor booth', 'Natural Products Expo West 2023', 'New Hope Network exhibitor list', cat
  );
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(cat === 'event-like', 'a trade show is classified as an event-like signal');
  assert(resolved.eventDate === '2023-06-15' && resolved.dateConfidence === 'approximate', 'the bare year embedded in "Expo West 2023" resolves to an approximate 2023 date, not left unknown');
  assert(actionability.status === 'stale' && actionability.excludeFromPriorities === true, 'required test 1: a trade show whose name embeds year 2023, evaluated in 2026, is excluded from current priorities');

  // The full makeSignal() pipeline discards it entirely -- proven via a
  // real raw AI-signal shape through the actual production function.
  const raw = { accountName: 'New Hope Network', signalTitle: 'Natural Products Expo West 2023', concrete_trigger: 'Natural Products Expo West 2023 exhibitor booth', business_context: 'New Hope Network exhibited at Natural Products Expo West 2023.', sourceUrl: 'https://example.com/expo-west-2023', confidence: 85 };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal === null, 'required test 1 (end-to-end): makeSignal() itself returns null for the stale Expo West 2023 signal -- it never becomes a displayable priority');
}

{
  // Required test 2: a future webinar with an explicit date -- eligible and
  // labeled upcoming.
  const cat = signalEventCategory('EVENT_CONFERENCE');
  const resolved = resolveSignalEventDate({ event_date: '2026-09-15' }, 'HRCe product webinar', 'HRCe product webinar', '', cat);
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(resolved.dateConfidence === 'exact', 'an explicit ISO event_date is parsed with exact confidence');
  assert(actionability.status === 'upcoming' && actionability.isPriorityEligible === true && actionability.excludeFromPriorities === false, 'required test 2: a future, confidently-dated webinar is eligible and labeled upcoming');
}

{
  // Required test 3 (explicit "future events remain eligible", distinct
  // fixture from test 2): a facility ribbon cutting scheduled next month.
  const cat = signalEventCategory('LOCATION_EVENT_UNSPECIFIED');
  const futureDate = new Date(NOW.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const resolved = resolveSignalEventDate({ event_date: futureDate }, 'ribbon cutting for new distribution center', 'Ribbon Cutting', '', cat);
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(actionability.status === 'upcoming', 'required test 3: a ribbon cutting 30 days in the future remains eligible as upcoming');
}

{
  // Required test 4: a ribbon cutting 20 days ago -- eligible as a
  // follow-up, using past tense.
  const cat = signalEventCategory('LOCATION_EVENT_UNSPECIFIED');
  const pastDate = new Date(NOW.getTime() - 20 * 86400000).toISOString().slice(0, 10);
  const resolved = resolveSignalEventDate({ event_date: pastDate }, 'ribbon cutting ceremony', 'ribbon cutting ceremony', '', cat);
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(actionability.status === 'recent-past' && actionability.tense === 'past' && actionability.isPriorityEligible === true, 'required test 4: a ribbon cutting 20 days in the past is eligible as a follow-up');

  const opener = salesReadyOpener('ribbon cutting ceremony', 'Acme Manufacturing held a ribbon cutting.', '', 'New Location', { accountName: 'Acme Manufacturing', actionability });
  assert(/recently had/i.test(opener), `required test 4: the generated opener uses past tense ("recently had") for a recent-past event, not present/future tense (got: "${opener}")`);
  assert(!/coming up|will host|is hosting/i.test(opener), 'required test 4: the opener for a recent-past event does not use future-tense phrasing');
}

{
  // Required test 5: a webinar with no date -- not labeled upcoming.
  const cat = signalEventCategory('EVENT_CONFERENCE');
  const resolved = resolveSignalEventDate({}, 'HPGR HRCe product webinar', 'HPGR HRCe product webinar', 'HPGR is promoting a product webinar, no date visible on the page.', cat);
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(resolved.dateConfidence === 'unknown', 'a webinar with no parseable date anywhere in its text stays dateConfidence:unknown');
  assert(actionability.status === 'unknown-date' && actionability.isPriorityEligible === false, 'required test 5: an undated webinar is not priority-eligible');
  assert(actionability.label !== 'Upcoming' && actionability.status !== 'upcoming', 'required test 5: an undated webinar is never labeled upcoming');

  const opener = salesReadyOpener('HRCe product webinar', 'HPGR is promoting a product webinar.', '', 'Webinar', { accountName: 'HPGR', actionability, recommendedBuyingTeam: ['Marketing'] });
  assert(!/\bupcoming\b/i.test(opener), `required test 5: the generated opener for an undated webinar never says "upcoming" (got: "${opener}")`);
}

{
  // Required test 6: a recent hiring announcement with no separate event
  // date -- may remain actionable using publication recency.
  const cat = signalEventCategory('HIRING_ACTIVITY');
  assert(cat === 'ongoing', 'hiring is classified as an ongoing business-change signal, not event-like');
  const resolved = resolveSignalEventDate({}, 'hiring initiative for field marketing coordinators', 'Acme is hiring', '', cat);
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(actionability.status === 'ongoing' && actionability.isPriorityEligible === true, 'required test 6: a hiring signal with no event date remains actionable');
  assert(actionability.usesPublicationDate === true, 'required test 6: an ongoing signal is explicitly flagged as using publication-date recency, not an event date, so the UI never mislabels it');

  // Full makeSignal() pipeline: a recent hiring announcement is NOT
  // discarded by the actionability gate (only event-like/stale signals are).
  const raw = { accountName: 'Acme Corp', signalTitle: 'Acme is hiring field marketing coordinators', concrete_trigger: 'hiring field marketing coordinators', business_context: 'Acme is actively hiring for its marketing team.', sourceUrl: 'https://example.com/acme-hiring', confidence: 80, publicationDate: new Date(NOW.getTime() - 5 * 86400000).toISOString() };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'required test 6 (end-to-end): a recent hiring signal survives makeSignal() -- ongoing signals are never excluded for lacking an event date');
  assert(madeSignal.eventCategory === 'ongoing' && madeSignal.actionabilityStatus.status === 'ongoing', 'required test 6 (end-to-end): the persisted signal carries eventCategory:ongoing and actionabilityStatus.status:ongoing');
}

{
  // Distinct-concepts test: event_date must never silently become the
  // publication date merely because the true event date is absent.
  const raw = { accountName: 'Acme Corp', signalTitle: 'Acme wins major contract', concrete_trigger: 'wins major contract', business_context: 'Acme announced a new customer contract.', sourceUrl: 'https://example.com/acme-contract', confidence: 80, publicationDate: '2026-07-01' };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'sanity: the contract-win signal is not discarded');
  assert(madeSignal.publishedDate === '2026-07-01' && madeSignal.publicationDate === '2026-07-01', 'the publication date is preserved on the signal');
  assert(madeSignal.eventDate === '' || madeSignal.eventDate !== madeSignal.publishedDate, 'event date is never silently set to the publication date merely because no real event date exists -- the two remain genuinely distinct fields');
}

// ===========================================================================
// Section A2 — Priority 2: grounded outreach (real research-batch.js exports)
// ===========================================================================

{
  // Deterministic fallback contains the exact signal (required coverage
  // item 8), and grounds in company name / department / historical fact
  // when supplied.
  const account = { orderCount: 3, categories: ['Apparel'] };
  const historicalFact = oneHistoricalOrderFact(account);
  assert(historicalFact === "you've ordered Apparel for them before (3 orders on file)", `oneHistoricalOrderFact() produces a real, specific fact from real order data (got: "${historicalFact}")`);
  assert(oneHistoricalOrderFact({}) === '', 'oneHistoricalOrderFact() returns nothing invented when the account has no real order history');

  const opener = salesReadyOpener('HRCe product webinar', 'HPGR is promoting a product webinar.', '', 'Webinar', {
    accountName: 'HPGR', actionability: { status: 'unknown-date', tense: 'unknown' }, recommendedBuyingTeam: ['Marketing'], historicalFact
  });
  assert(opener.includes('HPGR') && opener.includes('HRCe product webinar'), `the fallback opener references the exact company and exact signal trigger, not a generic category phrase (got: "${opener}")`);
  assert(opener.includes(historicalFact), 'the fallback opener incorporates the real historical-order fact when one is available');
  assert(!/anything coming up where it would help to think through merch/i.test(opener), 'the exact ungrounded legacy phrase from the review is not produced by the fixed fallback');
}

{
  // Two different companies, two different real signals, in the SAME
  // category, must not receive the same generic outreach text.
  const openerA = salesReadyOpener('HRCe product webinar', 'HPGR is promoting a webinar.', '', 'Webinar', { accountName: 'HPGR', actionability: { status: 'unknown-date' } });
  const openerB = salesReadyOpener('annual distributor summit', 'Acme Distributors is hosting its annual summit.', '', 'Conference / Summit', { accountName: 'Acme Distributors', actionability: { status: 'unknown-date' } });
  assert(openerA !== openerB, 'two different companies with two different signals in the same category (events) receive genuinely different outreach text');
  assert(openerA.includes('HPGR') && !openerA.includes('Acme Distributors'), 'company A\'s opener names company A, not company B');
  assert(openerB.includes('Acme Distributors') && !openerB.includes('HPGR'), 'company B\'s opener names company B, not company A');
}

{
  // Do not invent a merch program or claim it is already planned.
  const opener = salesReadyOpener('HRCe product webinar', 'HPGR is promoting a product webinar.', '', 'Webinar', { accountName: 'HPGR', actionability: { status: 'unknown-date' }, recommendedBuyingTeam: ['Marketing'] });
  assert(!/we('| a)?re already (working on|planning|preparing)/i.test(opener), 'the opener never claims a merch program is already planned');
  assert(!/we have (already )?sent|we shipped/i.test(opener), 'the opener never claims work has already happened');
}

console.log(`\nSection A/A2 (research-batch.js): ${failures === 0 ? 'ALL PASS SO FAR' : `${failures} FAILURE(S) SO FAR`}`);

// ===========================================================================
// Section B — dashboard/index.html, real verbatim source extracted into a vm
// sandbox. Two large contiguous blocks cover everything needed below; each
// is verified to still start with its expected first line before use, so a
// source reshuffle fails loudly here instead of silently testing stale text.
// ===========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const DASHBOARD_SRC = readFileSync(DASHBOARD_PATH, 'utf8');
const LINES = DASHBOARD_SRC.split('\n');

function extractBlock(label, startLine, endLine, expectedPrefix){
  const slice = LINES.slice(startLine - 1, endLine).join('\n');
  if(!slice.startsWith(expectedPrefix)){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-paid-beta-sprint.js.`);
  }
  const trimmed = slice.trimEnd();
  if(!trimmed.endsWith('}') && !trimmed.endsWith('};')){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${endLine} does not close as expected -- update the line range.`);
  }
  return slice;
}

// Covers: signalLayerLabel, isRecentAccountActivity, sourceDomain, shortText,
// parseMaybeDate, formatSignalAge, cleanBusinessText, businessSignalKind,
// businessSuggestedOpener, getRepFriendlyWhy, isGroundedOpener,
// getSuggestedOpener, mailtoHref, opportunityHeadline, whyThisMattersText,
// extractHistoricalOrderCount, evidenceSourceLabel, findAccountForOpp,
// realPriorCategories, structuredEvidenceRows, formatShortDate,
// signalDateAndActionabilityLine, renderSuggestedContactCompact/Primary/Meta,
// renderVerifiedOpportunitySection, renderAccountContextSection,
// renderSupportingResearchDetails, renderRepOpportunityCard.
const CARD_AND_MODAL_BLOCK = extractBlock('card-and-modal-helpers', 3301, 3866, 'function signalLayerLabel(');

// Covers: normalizeSignalLayerType, signalTypePriority, daysSinceDate,
// scoreFromFreshness, normalizedConfidenceValue, evidenceCount,
// getRecommendationType, recommendationSlug/BadgeMeta/OneLine,
// calculateOpportunityScore, assignOpportunityScore, getOpportunityScore,
// sortDailyReasons, collapseDuplicateFollowUps, limitReasonsPerAccount,
// getOpportunityPlanningWindow, opportunityMatchesTimebox,
// prepareTimeboxReasons, prepareAllOpportunities, pluralize, feedSummary,
// renderWeeklyPrioritiesFeed.
const SCORING_AND_TIMEBOX_BLOCK = extractBlock('scoring-and-timebox-helpers', 6068, 6494, 'function normalizeSignalLayerType(');

const TIMEBOX_CONFIG_SRC = extractBlock('TIMEBOX_CONFIG', 2370, 2375, 'const TIMEBOX_CONFIG = {');
const IS_RELATIONSHIP_EXPANSION_SRC = extractBlock('isRelationshipExpansionOpportunity', 2593, 2596, 'function isRelationshipExpansionOpportunity(');
const ESCAPE_HTML_SRC = extractBlock('escapeHtml', 7062, 7065, 'function escapeHtml(');
const FMT_MONEY_SRC = extractBlock('fmtMoney', 5187, 5189, 'function fmtMoney(');
const CLAMP_SCORE_SRC = extractBlock('clampScore', 5192, 5194, 'function clampScore(');

function makeSandbox(){
  const domElements = {};
  const sandbox = {
    console,
    window: { accountRadarAccounts: [] },
    document: {
      getElementById: (id) => { domElements[id] = domElements[id] || { textContent: '', innerHTML: '' }; return domElements[id]; },
      querySelectorAll: () => []
    },
    // isWarmAccount is only reached by renderAccountContextSection's
    // no-order-history fallback branch, which none of the fixtures below
    // exercise (each gives the account real order history) -- stubbed
    // defensively rather than left undefined.
    isWarmAccount: () => false,
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  // Node's vm module does not attach top-level const/let bindings to the
  // context object (only function declarations and `var` do) -- these three
  // tiny getter/setter functions are test-only scaffolding (not part of the
  // extracted dashboard source) that let this file read/drive the real
  // TIMEBOX_CONFIG/activeTimebox/showAllWeeklyPriorities module state that
  // renderWeeklyPrioritiesFeed() and friends close over, exactly as the
  // browser's own module scope would.
  const fullSource = [
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    `function __setActiveTimebox(v){ activeTimebox = v; }`,
    `function __setShowAllWeeklyPriorities(v){ showAllWeeklyPriorities = v; }`,
    `function __getTimeboxConfig(){ return TIMEBOX_CONFIG; }`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    ESCAPE_HTML_SRC,
    FMT_MONEY_SRC,
    CLAMP_SCORE_SRC,
    CARD_AND_MODAL_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'dashboard-paid-beta-extract.js' }).runInContext(sandbox);
  sandbox.__domElements = domElements;
  return sandbox;
}

// ---------------------------------------------------------------------------
// Required test 7: Conversation Starter uses the persisted generated field.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const grounded = 'Saw HPGR has HRCe product webinar coming up. Is Marketing the right team to ask about that?';
  const opp = { conversationStarter: grounded, account: 'HPGR', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com' };
  assert(sandbox.getSuggestedOpener(opp) === grounded, 'getSuggestedOpener() returns opp.conversationStarter verbatim when it is present and grounded, instead of silently regenerating a separate opener');
}
{
  const sandbox = makeSandbox();
  const legacy = 'noticed some event or community activity on your end. Is there anything coming up where it would help to think through merch, attendee gifts, or staff gear?';
  assert(sandbox.isGroundedOpener(legacy) === false, 'the exact pre-fix ungrounded legacy string is correctly identified as NOT grounded (protects already-persisted old signals from being treated as if they were fixed)');
  assert(sandbox.isGroundedOpener('') === false && sandbox.isGroundedOpener(null) === false, 'an empty/missing conversationStarter is never treated as grounded');
  assert(sandbox.isGroundedOpener('Saw Acme Corp has a trade show coming up.') === true, 'a real, specific opener is correctly identified as grounded');
}

// ---------------------------------------------------------------------------
// Required test 8 (client-side half): deterministic fallback contains the
// exact signal.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const opener = sandbox.businessSuggestedOpener({ account: 'Acme Manufacturing', signalTitle: 'Acme Manufacturing opens new Richmond distribution center', contact: 'Jordan Lee' });
  assert(opener.includes('Acme Manufacturing opens new Richmond distribution center'), `the client-side fallback references the exact signal title, not a generic phrase (got: "${opener}")`);
  assert(!/noticed some event or community activity/i.test(opener), 'the client-side fallback no longer produces the exact ungrounded legacy phrase');
}
{
  // Transparent limited state when there truly is no signal detail.
  const sandbox = makeSandbox();
  const opener = sandbox.businessSuggestedOpener({ account: 'Acme Manufacturing', contact: 'Jordan Lee' });
  assert(/not enough detail yet/i.test(opener), 'when there is no real signal detail, the fallback states that plainly instead of inventing a specific-sounding reason');
}

// ---------------------------------------------------------------------------
// Required test 9: dashboard timeframe counts cannot produce "21 of 7".
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // Reproduces the exact structural mismatch: 3 accounts, each with TWO
  // opportunities -- a high-scoring one that does NOT match "week", and a
  // lower-scoring one that DOES match "week". Under the OLD dedup-then-filter
  // vs filter-then-dedup mismatch, allOpportunities (computed dedup-first)
  // would keep only each account's #1 globally-ranked item, filtered by
  // timebox afterward -- losing accounts whose top item isn't this week's
  // even though a lower-ranked item of theirs is. priorityOpportunities
  // (filter-first) would keep all three. That is the exact shape that could
  // render as "3 of 0" or any other non-nested pairing.
  const opportunities = [];
  for(let i = 1; i <= 3; i++){
    const account = `Account ${i}`;
    opportunities.push({
      account, isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/high',
      confidenceScore: 95, evidence: ['high-confidence, but not this week'],
      publishedDate: new Date(NOW.getTime() - 200 * 86400000).toISOString(), // old -> planning window = month, not week
      signalDate: new Date(NOW.getTime() - 200 * 86400000).toISOString()
    });
    opportunities.push({
      account, isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/low',
      confidenceScore: 40, evidence: ['lower-confidence, but genuinely this week'],
      publishedDate: new Date(NOW.getTime() - 2 * 86400000).toISOString(), // recent -> planning window = week
      signalDate: new Date(NOW.getTime() - 2 * 86400000).toISOString()
    });
  }
  sandbox.__setActiveTimebox('week');
  sandbox.__setShowAllWeeklyPriorities(false);
  const grid = sandbox.document.getElementById('opportunitiesGrid');
  const resultCount = sandbox.document.getElementById('resultCount');
  sandbox.renderWeeklyPrioritiesFeed(opportunities, [{ name: 'Account 1' }, { name: 'Account 2' }, { name: 'Account 3' }]);
  const label = resultCount.innerHTML;
  assert(!/\d+ of \d+/.test(label), `required test 9: the rendered summary never uses an "X of Y" comparison that could produce a false subset claim like "21 of 7" (got: "${label}")`);
  assert(/accounts? worth reviewing/i.test(label), `required test 9: the summary uses the preferred "N accounts worth reviewing <timeframe>" phrasing (got: "${label}")`);
}

// ---------------------------------------------------------------------------
// Required test 10: proper singular/plural and timeframe empty states.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  assert(sandbox.pluralize(1, 'business trigger') === '1 business trigger', 'pluralize(1, ...) is singular');
  assert(sandbox.pluralize(21, 'business trigger') === '21 business triggers', 'pluralize(21, ...) is plural');
  assert(sandbox.pluralize(0, 'business trigger') === '0 business triggers', 'pluralize(0, ...) is plural (zero is not singular)');
  assert(sandbox.pluralize(1, 'reorder opportunity', 'reorder opportunities') === '1 reorder opportunity', 'pluralize with an explicit irregular plural is correct at 1');
  assert(sandbox.pluralize(2, 'reorder opportunity', 'reorder opportunities') === '2 reorder opportunities', 'pluralize with an explicit irregular plural is correct at 2+');

  const summary = sandbox.feedSummary([
    { isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/1' },
    { evidence: ['recent order'] },
    {}
  ]);
  assert(/\d+ business triggers?/.test(summary) && /\d+ reorder opportunit(y|ies)/.test(summary) && /\d+ follow-ups?/.test(summary), `feedSummary() uses the preferred category labels with correct pluralization (got: "${summary}")`);
}
for(const timebox of ['week', 'month', 'quarter', 'annual']){
  const sandbox = makeSandbox();
  sandbox.__setActiveTimebox(timebox);
  sandbox.__setShowAllWeeklyPriorities(false);
  const grid = sandbox.document.getElementById('opportunitiesGrid');
  sandbox.renderWeeklyPrioritiesFeed([], []);
  const label = sandbox.__getTimeboxConfig()[timebox].label.toLowerCase();
  assert(grid.innerHTML.includes(label), `required test 10: the empty-state message for the "${timebox}" tab reflects that specific timeframe ("${label}"), not a hardcoded "this week" (got: "${grid.innerHTML}")`);
  assert(!/nothing urgent this week/i.test(grid.innerHTML) || timebox === 'week', `required test 10: the "${timebox}" tab's empty state is not the old hardcoded "this week" text when the active tab isn't week`);
}

// ---------------------------------------------------------------------------
// Required test 11: dormant-account logic uses the correct scale.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // A genuinely ACTIVE account (ordered 30 days ago -> recency close to 1,
  // the "just ordered" end of the 0-1 scale) with revenue and orders must
  // NOT be classified Dormant under the fixed threshold.
  const activeOpp = { account: 'Acme Corp', accountRevenue: 20000, accountOrderCount: 5, accountRecencyScore: 0.92, evidence: [] };
  assert(sandbox.getRecommendationType(activeOpp) !== 'Dormant High-Value Account', 'required test 11: a recently-active, high-revenue account is NOT classified Dormant (the pre-fix bug classified it as Dormant regardless of recency)');

  // A genuinely STALE account (recency near 0 -> no order in ~a year) with
  // revenue and orders SHOULD be classified Dormant.
  const staleOpp = { account: 'Harborline Logistics', accountRevenue: 20000, accountOrderCount: 5, accountRecencyScore: 0.05, evidence: [] };
  assert(sandbox.getRecommendationType(staleOpp) === 'Dormant High-Value Account', 'required test 11: a genuinely stale, high-revenue account IS correctly classified Dormant on the fixed 0-1 scale');
}

// ---------------------------------------------------------------------------
// Required test 12: Prior Categories never displays inferred categories.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  sandbox.window.accountRadarAccounts = [
    { name: 'Northfield Bank', categoryTypes: new Set(['Apparel', 'Drinkware']) }
  ];
  const opp = { account: 'Northfield Bank', commonPromoCategories: ['Launch Kits', 'Executive Gifts'] }; // AI-suggested, deliberately different from real history
  const priorCategories = sandbox.realPriorCategories(opp);
  assert(priorCategories.join(',') === 'Apparel,Drinkware', `required test 12: realPriorCategories() returns the REAL order-derived categories (Apparel, Drinkware), never the AI-suggested commonPromoCategories (got: ${JSON.stringify(priorCategories)})`);

  const rows = sandbox.structuredEvidenceRows(opp);
  const priorRow = rows.find(r => r.label.includes('Prior categories'));
  assert(priorRow && priorRow.value === 'Apparel, Drinkware', 'the Evidence "Prior categories" row uses the real order history, not the inferred/suggested list');

  // When there is no real order history, the row is hidden entirely --
  // never displays inferred categories as though they were purchase history.
  sandbox.window.accountRadarAccounts = [{ name: 'Brand New Prospect', categoryTypes: new Set() }];
  const noHistoryOpp = { account: 'Brand New Prospect', commonPromoCategories: ['Launch Kits'] };
  assert(sandbox.realPriorCategories(noHistoryOpp).length === 0, 'required test 12: with no real historical categories, realPriorCategories() returns empty rather than falling back to inferred ones');
  const noHistoryRows = sandbox.structuredEvidenceRows(noHistoryOpp);
  assert(!noHistoryRows.some(r => r.label.includes('Prior categories')), 'required test 12: the Prior Categories row is hidden entirely when no real order history exists, not shown with invented data');
}

// ---------------------------------------------------------------------------
// Required test 13: card detail moved into Prepare for Call without data
// loss.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  sandbox.window.accountRadarAccounts = [
    { name: 'Acme Corp', categoryTypes: new Set(['Apparel']), orderCount: 4, revenue: 12000, totalRevenue: 12000, mostRecentDate: '2026-02-01', contacts: [{ name: 'Jordan Lee', email: 'jordan@acme.test' }], notes: 'Prefers email outreach.' }
  ];
  const opp = {
    account: 'Acme Corp', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/acme-expansion',
    signalTitle: 'Acme Corp opens new Richmond distribution center', conversationStarter: 'Saw Acme Corp has a new Richmond distribution center opening up.',
    recommendedBuyingTeam: ['Operations'], commonPromoCategories: ['Launch Kits'],
    actionabilityStatus: { status: 'ongoing', usesPublicationDate: true }, publicationDate: '2026-07-20'
  };

  const cardHtml = sandbox.renderRepOpportunityCard(opp);
  assert(!/Evidence/.test(cardHtml), 'required test 13: the card no longer renders the Evidence block');
  assert(!/Recommended Buying Team/i.test(cardHtml), 'required test 13: the card no longer renders the Recommended Buying Team tags');
  assert(!/Common promo categories/i.test(cardHtml), 'required test 13: the card no longer renders Common/Suggested promo category tags');
  assert(!/Supporting research/i.test(cardHtml), 'required test 13: the card no longer renders the Supporting Research footer label');
  assert(cardHtml.includes('Acme Corp') && cardHtml.includes('Recommended contact'), 'the card still shows account and a compact recommended-contact line (per the new 7-item hierarchy)');

  // The same data is genuinely still reachable -- in Prepare for Call's
  // Research Details / Account Context, via real function calls, not just
  // "trust me it's still in the JS object."
  const evidenceHtml = sandbox.renderSupportingResearchDetails(opp);
  assert(evidenceHtml.includes('Operations') && evidenceHtml.includes('Launch Kits'), 'required test 13: buying team and suggested categories are still rendered, in Prepare for Call\'s Research Details, not deleted');

  const accountContextHtml = sandbox.renderAccountContextSection(opp);
  assert(accountContextHtml.includes('Apparel') && accountContextHtml.includes('4 orders') && accountContextHtml.includes('Jordan Lee'), `required test 13: real order history (categories, order count, uploaded contact) is preserved and shown in Account Context (got: "${accountContextHtml}")`);

  const verifiedHtml = sandbox.renderVerifiedOpportunitySection(opp);
  assert(verifiedHtml.includes('Acme Corp opens new Richmond distribution center'), 'required test 13: the exact signal is preserved and shown in Verified Opportunity');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
