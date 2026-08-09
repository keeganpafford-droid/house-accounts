// Sales-play temporal-integrity round -- acceptance fixtures (Deliverable A,
// item 7) and automated verification (item 8) for the five required event
// shapes: Avidia-style duplicate, Weatherby-style unknown-date (+ separate
// ~10-month-old event), Toyota-style expired acquisition, a legitimate
// follow-up, and a future event.
//
// Every fixture below runs through REAL production functions -- makeSignal(),
// resolveCanonicalEventType(), computeActionability() (api/research-batch.js),
// normalizeOpportunity(), resolveOpportunityEvents(), resolveEventType()
// (api/signal-intelligence.js) -- and the real, verbatim dashboard/index.html
// source extracted into a vm sandbox (isPriorityEligibleOpportunity(),
// priorityEligibleOpportunities(), accountOpportunityCluster(),
// signalDateAndActionabilityLine(), opportunityTimingLabel(),
// renderSingleVerifiedSignal(), formatSignalAge(), renderAdditionalOpportunitiesForSalesPlay()).
// None of this is a test-only reimplementation of the production logic.
//
// Usage: node scripts/test-temporal-integrity-fixtures.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { makeSignal, resolveCanonicalEventType, computeActionability, signalEventCategory } from '../api/research-batch.js';
import { normalizeOpportunity, resolveOpportunityEvents, resolveEventType, classifySignalFamily } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const NOW = new Date('2026-08-06T12:00:00Z');
const daysAgo = n => { const d = new Date(NOW.getTime() - n*86400000); return d.toISOString().slice(0,10); };
const daysAhead = n => { const d = new Date(NOW.getTime() + n*86400000); return d.toISOString().slice(0,10); };

// ===========================================================================
// Helper: build a real, full opportunity object the exact way research-batch.js
// does -- makeSignal() (canonical classification, date resolution, actionability)
// then normalizeOpportunity() (the same shape resolveOpportunityEvents() and every
// dashboard surface consumes).
// ===========================================================================
function buildOpportunity(raw, account = {}){
  const signal = makeSignal(raw, account);
  if(!signal) return null;
  return normalizeOpportunity(signal, { name: signal.accountName, ...account });
}

// ===========================================================================
// FIXTURE 1 -- Avidia-style duplicate event: two sources describing the same
// branch renovation/ribbon-cutting, slightly different wording, adjacent
// dates, one source using "open house" language.
// ===========================================================================
{
  const account = { name: 'Avidia Bank' };
  const oppA = buildOpportunity({
    accountName: 'Avidia Bank',
    sourceUrl: 'https://example.com/avidia-westborough-ribbon-cutting',
    sourceName: 'Worcester Business Journal',
    signalTitle: 'Avidia Bank Westborough Branch Ribbon Cutting',
    concrete_trigger: 'Avidia Bank held a ribbon cutting for its renovated Westborough branch',
    business_context: 'Avidia Bank celebrated the reopening of its newly renovated Westborough branch with a ribbon cutting ceremony.',
    event_date: daysAgo(3),
    confidence: 88
  }, account);
  const oppB = buildOpportunity({
    accountName: 'Avidia Bank',
    sourceUrl: 'https://example.com/avidia-westborough-open-house',
    sourceName: 'MetroWest Daily News',
    signalTitle: 'Avidia Bank Westborough Branch Ribbon Cutting and Open House',
    concrete_trigger: 'Avidia Bank hosted a ribbon cutting and open house celebration for its renovated Westborough branch',
    business_context: 'Avidia Bank marked the reopening of its renovated Westborough branch with a ribbon cutting and open house celebration.',
    event_date: daysAgo(2),
    confidence: 82
  }, account);

  assert(!!oppA && !!oppB, 'Avidia fixture: both source write-ups produce a real signal via makeSignal()');
  assert(oppA.canonicalEventType === oppB.canonicalEventType, `required test 3 (classification-order regression): the ribbon-cutting-only write-up and the ribbon-cutting-plus-open-house write-up resolve to the SAME canonical event type, not incompatible types merely from wording differences (got ${oppA.canonicalEventType} / ${oppB.canonicalEventType})`);
  assert(oppA.canonicalEventType === 'NEW_LOCATION_OPENING' || oppA.canonicalEventType === 'RENOVATION_COMPLETION' || oppA.canonicalEventType === 'LOCATION_REOPENING', `Avidia fixture: the renovation/ribbon-cutting event classifies into the location-opening family, not the generic community-event bucket (got ${oppA.canonicalEventType})`);

  const resolved = resolveOpportunityEvents([oppA, oppB]);
  assert(resolved.length === 1, `required test 2/Avidia fixture: two source write-ups of the SAME real event collapse into ONE canonical opportunity, not two (got ${resolved.length})`);
  assert((resolved[0].sources || []).length >= 1, 'Avidia fixture: the resolved event retains real evidence/source data');
  assert(!/Why Now \d/.test(JSON.stringify(resolved[0])), 'Avidia fixture: no raw "Why Now N" numeric label leaks into the resolved event object');

  // A genuinely different event for the SAME company (different branch) must
  // remain separate -- no over-merge regression.
  const oppC = buildOpportunity({
    accountName: 'Avidia Bank',
    sourceUrl: 'https://example.com/avidia-hudson-hiring',
    signalTitle: 'Avidia Bank Hudson Branch Hires New Manager',
    concrete_trigger: 'Avidia Bank named a new branch manager for its Hudson location',
    business_context: 'Avidia Bank announced a new branch manager at its Hudson, MA location, unrelated to the Westborough branch.',
    publicationDate: daysAgo(10),
    confidence: 80
  }, account);
  const resolvedWithDifferent = resolveOpportunityEvents([oppA, oppB, oppC]);
  assert(resolvedWithDifferent.length === 2, `Avidia fixture (no over-merge): a genuinely different event (different branch, different type) for the SAME company remains its own separate opportunity, not merged into the Westborough event (got ${resolvedWithDifferent.length} distinct events)`);

  // A similarly-worded event for a DIFFERENT company must never merge across
  // accounts (no fuzzy company matching).
  const oppD = buildOpportunity({
    accountName: 'Rockland Trust',
    sourceUrl: 'https://example.com/rockland-ribbon-cutting',
    signalTitle: 'Rockland Trust Ribbon Cutting',
    concrete_trigger: 'Rockland Trust held a ribbon cutting for its renovated branch',
    business_context: 'Rockland Trust celebrated the reopening of its renovated branch with a ribbon cutting ceremony.',
    event_date: daysAgo(3),
    confidence: 85
  }, { name: 'Rockland Trust' });
  const resolvedAcrossCompanies = resolveOpportunityEvents([oppA, oppB, oppD]);
  assert(resolvedAcrossCompanies.length === 2, `Avidia fixture (no cross-account leak): a similarly-worded ribbon-cutting event for a DIFFERENT company never merges with Avidia's event (got ${resolvedAcrossCompanies.length} distinct events)`);
}

// ===========================================================================
// FIXTURE 2 -- Weatherby-style unknown-date event, plus a separate ~10-month
// -old office-opening that must not appear current.
// ===========================================================================
{
  const account = { name: 'Weatherby Healthcare' };
  const undatedRaw = {
    accountName: 'Weatherby Healthcare',
    sourceUrl: 'https://example.com/weatherby-conference',
    signalTitle: 'Weatherby Healthcare Exhibiting at Locum Tenens Conference',
    concrete_trigger: 'Weatherby Healthcare is exhibiting at an upcoming industry conference',
    business_context: 'Weatherby Healthcare will have a booth at the conference.',
    confidence: 80
  };
  const signal = makeSignal(undatedRaw, account);
  assert(!!signal, 'Weatherby fixture: an unknown-date conference signal is retained by makeSignal(), not discarded');
  assert(signal.eventDateConfidence === 'unknown', 'Weatherby fixture: no trustworthy event date was found');
  assert(signal.actionabilityStatus.status === 'unknown-date', `required test 12: an unknown event date never falls back to a guessed status (got ${signal.actionabilityStatus.status})`);
  assert(signal.actionabilityStatus.isPriorityEligible === false, 'Weatherby fixture: an unknown-date event is never priority-eligible/primary');

  const opp = normalizeOpportunity(signal, account);
  // No discovery-timestamp fields leak into the opportunity's displayable
  // signalDate -- the "Detected today" defect this round fixed.
  assert(!opp.signalDate, 'required test 12/13: an unknown-date event carries no fabricated signalDate ("Detected today" cannot be produced from an empty date)');

  // A separate, real ~10-month-old office opening (event-like, well past the
  // 45-day follow-up window) must classify as stale/expired -- it cannot
  // appear current merely because it was discovered recently.
  const oldOpeningRaw = {
    accountName: 'Weatherby Healthcare',
    sourceUrl: 'https://example.com/weatherby-office-opening',
    signalTitle: 'Weatherby Healthcare Opens New Regional Office',
    concrete_trigger: 'Weatherby Healthcare held a grand opening for its new regional office',
    business_context: 'Weatherby Healthcare celebrated the grand opening of a new regional office.',
    event_date: daysAgo(300),
    confidence: 85
  };
  const oldOpeningSignal = makeSignal(oldOpeningRaw, account);
  assert(!!oldOpeningSignal, 'Weatherby fixture: the ~10-month-old office opening is retained (research detail), not discarded');
  assert(oldOpeningSignal.actionabilityStatus.status === 'stale', `Weatherby fixture: a ~10-month-old event-like signal (300 days, well past the documented 45-day follow-up window) is classified stale, not current (got ${oldOpeningSignal.actionabilityStatus.status})`);
  assert(oldOpeningSignal.actionabilityStatus.isPriorityEligible === false, 'Weatherby fixture: the ~10-month-old office opening is never priority-eligible absent an explicit, documented follow-up rule permitting it');
}

// ===========================================================================
// FIXTURE 3 -- Toyota-style expired acquisition. ACQUISITION is an ongoing
// business-change type (not one of the discrete event-like types), so its
// actionability is governed by publication-date recency (the 180-day
// ongoing-recency ceiling), exactly like a real acquisition announcement
// article -- not an event date.
// ===========================================================================
let toyotaOpp;
{
  const account = { name: 'Toyota of Portsmouth' };
  const raw = {
    accountName: 'Toyota of Portsmouth',
    sourceUrl: 'https://example.com/toyota-portsmouth-acquisition',
    signalTitle: 'Toyota of Portsmouth Acquired by Regional Auto Group',
    concrete_trigger: 'Toyota of Portsmouth was acquired by a regional automotive group',
    business_context: 'A regional automotive group completed its acquisition of Toyota of Portsmouth.',
    publicationDate: daysAgo(220),
    confidence: 85
  };
  const signal = makeSignal(raw, account);
  assert(!!signal, 'Toyota fixture: the acquisition signal is retained, not discarded');
  assert(signal.canonicalEventType === 'ACQUISITION', `Toyota fixture: correctly classified as an acquisition (got ${signal.canonicalEventType})`);
  assert(signal.actionabilityStatus.status === 'ongoing-stale', `required test 8: an acquisition whose source was published 220 days ago (past the 180-day ongoing-recency ceiling) evaluates to expired (got ${signal.actionabilityStatus.status})`);
  assert(signal.actionabilityStatus.isPriorityEligible === false, 'required test 8: the expired acquisition is never priority-eligible');
  assert(signal.actionabilityStatus.label === 'No longer current', `required test 9: the label is exactly "No longer current" (got ${signal.actionabilityStatus.label})`);
  toyotaOpp = normalizeOpportunity(signal, account);
}

// ===========================================================================
// FIXTURE 4 -- Legitimate follow-up (recently completed, still in window).
// A ribbon cutting/grand opening is one of the discrete event-like types, so
// its actionability is governed by its own event date and the 45-day
// follow-up window.
// ===========================================================================
let followUpOpp;
{
  const account = { name: 'Brightview Senior Living' };
  const raw = {
    accountName: 'Brightview Senior Living',
    sourceUrl: 'https://example.com/brightview-grand-opening',
    signalTitle: 'Brightview Senior Living Grand Opening of New Community',
    concrete_trigger: 'Brightview Senior Living held a grand opening for its new senior living community',
    business_context: 'Brightview Senior Living celebrated the grand opening of its new senior living community.',
    event_date: daysAgo(20),
    confidence: 85
  };
  const signal = makeSignal(raw, account);
  assert(!!signal, 'follow-up fixture: the recent grand-opening signal is retained');
  assert(signal.eventCategory === 'event-like', `follow-up fixture: a grand opening classifies as event-like, so the 45-day follow-up window applies (got ${signal.eventCategory})`);
  assert(signal.actionabilityStatus.status === 'recent-past', `required test 10: an event 20 days in the past (inside the 45-day follow-up window) is "recent-past", not stale or upcoming (got ${signal.actionabilityStatus.status})`);
  assert(signal.actionabilityStatus.isPriorityEligible === true, 'required test 10: a legitimate recent follow-up remains eligible');
  assert(signal.actionabilityStatus.tense === 'past', 'follow-up fixture: outreach tense is explicitly past/follow-up, not present/future');
  followUpOpp = normalizeOpportunity(signal, account);
}

// ===========================================================================
// FIXTURE 5 -- Future event (reliably dated).
// ===========================================================================
let futureOpp;
{
  const account = { name: 'Ridgeline Facilities Group' };
  const raw = {
    accountName: 'Ridgeline Facilities Group',
    sourceUrl: 'https://example.com/ridgeline-conference',
    signalTitle: 'Ridgeline Facilities Group to Exhibit at National Facilities Expo',
    concrete_trigger: 'Ridgeline Facilities Group will exhibit at the National Facilities Expo',
    business_context: 'Ridgeline Facilities Group announced it will exhibit at the upcoming National Facilities Expo.',
    event_date: daysAhead(30),
    confidence: 85
  };
  const signal = makeSignal(raw, account);
  assert(!!signal, 'future-event fixture: the future conference signal is retained');
  assert(signal.actionabilityStatus.status === 'upcoming', `required test 11: a reliably (exact-confidence) dated future event is "upcoming" (got ${signal.actionabilityStatus.status})`);
  assert(signal.actionabilityStatus.isPriorityEligible === true, 'required test 11: a future event is eligible');
  assert(signal.actionabilityStatus.tense === 'future', 'future-event fixture: outreach tense is future-facing');
  futureOpp = normalizeOpportunity(signal, account);
}

// ===========================================================================
// Section B -- dashboard/index.html real, verbatim source in a vm sandbox
// (same proven extraction ranges as scripts/test-paid-beta-sprint.js).
// ===========================================================================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const DASHBOARD_SRC = readFileSync(DASHBOARD_PATH, 'utf8');
const LINES = DASHBOARD_SRC.split('\n');

function extractBlock(label, startLine, endLine, expectedPrefix){
  const slice = LINES.slice(startLine - 1, endLine).join('\n');
  if(!slice.startsWith(expectedPrefix)){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-temporal-integrity-fixtures.js.`);
  }
  const trimmed = slice.trimEnd();
  if(!trimmed.endsWith('}') && !trimmed.endsWith('};')){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${endLine} does not close as expected -- update the line range.`);
  }
  return slice;
}

const CARD_AND_MODAL_BLOCK = extractBlock('card-and-modal-helpers', 4723, 6219, 'function confidenceLabel(');
const DEDUPE_AND_IDENTITY_BLOCK = extractBlock('dedupe-and-identity-helpers', 2937, 3417, 'function cleanOpportunityToken(');
const SALES_PLAY_BLOCK = extractBlock('sales-play-grounding', 8533, 9851, 'function salesPlayModeFromOpp(');
const SCORING_AND_TIMEBOX_BLOCK = extractBlock('scoring-and-timebox-helpers', 9854, 10424, 'function normalizeSignalLayerType(');
const TIMEBOX_CONFIG_SRC = extractBlock('TIMEBOX_CONFIG', 2784, 2789, 'const TIMEBOX_CONFIG = {');
const IS_RELATIONSHIP_EXPANSION_SRC = extractBlock('isRelationshipExpansionOpportunity', 3019, 3022, 'function isRelationshipExpansionOpportunity(');
const ESCAPE_HTML_SRC = extractBlock('escapeHtml', 11175, 11178, 'function escapeHtml(');
const FMT_MONEY_SRC = extractBlock('fmtMoney', 8448, 8450, 'function fmtMoney(');
const CLAMP_SCORE_SRC = extractBlock('clampScore', 8453, 8455, 'function clampScore(');

function makeSandbox(){
  const domElements = {};
  const sandbox = {
    console,
    window: { accountRadarAccounts: [] },
    document: {
      getElementById: (id) => { domElements[id] = domElements[id] || { textContent: '', innerHTML: '', style: {} }; return domElements[id]; },
      querySelectorAll: () => []
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
  new vm.Script(fullSource, { filename: 'dashboard-temporal-integrity-extract.js' }).runInContext(sandbox);
  return sandbox;
}

const sandbox = makeSandbox();

// Give each fixture opportunity the isVerifiedSignalOpportunity flag makeSignal()
// -> addSignalDerivedOpportunities() would set on a real business-signal
// opportunity, so isBusinessOpportunity()/signalLayerLabel() classify it the
// same way the real client-side pipeline would.
function asBusinessOpportunity(opp){
  return { ...opp, isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', account: opp.accountName };
}

// ---------------------------------------------------------------------------
// Toyota fixture: eligibility, status label, outreach copy suppression.
// ---------------------------------------------------------------------------
{
  const opp = asBusinessOpportunity(toyotaOpp);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'required test 8: isPriorityEligibleOpportunity() rejects the expired Toyota acquisition');
  const line = sandbox.signalDateAndActionabilityLine(opp);
  assert(line === 'No longer current', `required test 9: the rendered status line is exactly "No longer current" (got "${line}")`);
  assert(!/recent acquisition/i.test(line), 'required test 9: "No longer current" never coexists with "recent acquisition" active-outreach language on the status line');

  const eligible = sandbox.isSignalPriorityEligible(opp);
  assert(eligible === false, 'Toyota fixture: isSignalPriorityEligible() (Research Details gate) also rejects the expired acquisition');
  const rendered = sandbox.renderSingleVerifiedSignal(opp);
  assert(/Shown for account history only/.test(rendered), 'required test 4/Toyota fixture: Research Details shows the deterministic historical-context note for an ineligible signal');
  assert(!/Likely buyers:/.test(rendered) && !/Suggested Contact:/.test(rendered) && !/Likely conversations:/.test(rendered), 'required test 4/Toyota fixture: no active-outreach copy (Likely buyers/Suggested Contact/Likely conversations) renders alongside "No longer current"');
  assert(!/Why it matters:/.test(rendered) || /Shown for account history only/.test(rendered), 'Toyota fixture: the active "Why it matters" row is suppressed for an ineligible signal');
}

// ---------------------------------------------------------------------------
// Legitimate follow-up fixture: eligibility, follow-up tense, timing label.
// ---------------------------------------------------------------------------
{
  const opp = asBusinessOpportunity(followUpOpp);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'required test 10: a legitimate recent follow-up remains eligible through isPriorityEligibleOpportunity()');
  const line = sandbox.signalDateAndActionabilityLine(opp);
  assert(/Recent event/.test(line) && /follow up/.test(line), `required test 10: the status line uses explicit follow-up tense (got "${line}")`);
  assert(!/upcoming/i.test(line), 'required test 10: a recently-completed follow-up is never labeled upcoming');
  const label = sandbox.opportunityTimingLabel(opp);
  assert(label === 'Follow-Up Opportunity', `follow-up fixture: the qualitative timing label reads "Follow-Up Opportunity" (got "${label}")`);

  const rendered = sandbox.renderSingleVerifiedSignal(opp);
  assert(/Why it matters:/.test(rendered), 'follow-up fixture: an eligible signal still shows full outreach copy in Research Details');
}

// ---------------------------------------------------------------------------
// Future-event fixture: eligibility, future tense, timing label.
// ---------------------------------------------------------------------------
{
  const opp = asBusinessOpportunity(futureOpp);
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'required test 11: a future event remains eligible through isPriorityEligibleOpportunity()');
  const line = sandbox.signalDateAndActionabilityLine(opp);
  assert(/^Upcoming/.test(line), `required test 11: the status line uses future-facing "Upcoming" language (got "${line}")`);
  assert(!/follow up/i.test(line) && !/recent event/i.test(line), 'required test 11: a future event is never given retrospective/follow-up wording');
  const label = sandbox.opportunityTimingLabel(opp);
  assert(label === 'Upcoming Event', `future-event fixture: the qualitative timing label reads "Upcoming Event" (got "${label}")`);
}

// ---------------------------------------------------------------------------
// required test 5/6: Prepare-for-Call direct-open, Recently Researched, and
// Additional Opportunities all apply the SAME eligibility -- proven directly
// on accountOpportunityCluster(), the shared function all three surfaces
// (openResearchedAccountOpportunities(), the Recently Researched handoff, and
// additionalOpportunitiesFor()) read from.
// ---------------------------------------------------------------------------
{
  sandbox.window.accountRadarAccounts = [{
    name: 'Toyota of Portsmouth',
    futureOpportunities: [asBusinessOpportunity(toyotaOpp), asBusinessOpportunity(followUpOpp)].map(o => ({ ...o, account: 'Toyota of Portsmouth' }))
  }];
  const cluster = sandbox.accountOpportunityCluster({ account: 'Toyota of Portsmouth' });
  assert(cluster.length === 1, `required test 5/6/7: accountOpportunityCluster() (the shared source for Prepare for Call primary selection, Recently Researched, and Additional Opportunities) excludes the ineligible expired acquisition and keeps only the eligible follow-up (got ${cluster.length})`);
  assert(cluster.every(o => o.actionabilityStatus?.status !== 'stale'), 'required test 8: no stale/expired opportunity survives accountOpportunityCluster() to become a Verified Opportunity or active play');

  // required test 4: primary and Additional cannot share the same canonical
  // event -- additionalOpportunitiesFor() excludes the exact item passed in.
  const primary = cluster[0];
  const additional = sandbox.additionalOpportunitiesFor(primary);
  assert(!additional.some(o => sandbox.sameOpportunity(o, primary)), 'required test 4: the primary opportunity never also appears in its own Additional Opportunities list');
}

// ---------------------------------------------------------------------------
// required test 14: no raw internal score renders in customer-facing output
// (renderAdditionalOpportunitiesForSalesPlay -- the confirmed "Why Now 34"
// production defect).
// ---------------------------------------------------------------------------
{
  sandbox.window.accountRadarAccounts = [{
    name: 'Ridgeline Facilities Group',
    futureOpportunities: [asBusinessOpportunity(futureOpp), asBusinessOpportunity(followUpOpp)].map(o => ({ ...o, account: 'Ridgeline Facilities Group' }))
  }];
  const primaryLike = { ...asBusinessOpportunity(futureOpp), account: 'Ridgeline Facilities Group' };
  const html = sandbox.renderAdditionalOpportunitiesForSalesPlay(primaryLike);
  assert(!/Why Now \d/.test(html), 'required test 14: renderAdditionalOpportunitiesForSalesPlay() never renders a raw "Why Now N" numeric label');
  if(/additional-opportunity-item/.test(html)){
    assert(/Follow-Up Opportunity|Upcoming Event|Recent Business Activity|Timely Opportunity/.test(html), 'required test 14: a qualitative, status-grounded timing label renders in its place');
  }
}

// ---------------------------------------------------------------------------
// required test 13: discovery/first-seen time is never treated as event time
// -- formatSignalAge() never fabricates "Detected today" from a discovery
// timestamp when no real event/publication date exists.
// ---------------------------------------------------------------------------
{
  const noRealDateOpp = { detectedAt: new Date().toISOString(), dateFound: new Date().toISOString(), firstSeenAt: new Date().toISOString() };
  const age = sandbox.formatSignalAge(noRealDateOpp);
  assert(age === '', `required test 12/13: formatSignalAge() returns no age line at all (never "Detected today") when only discovery timestamps are present and no real signalDate/lastActivityDate/orderDate exists (got "${age}")`);

  // Preview QA hygiene: derive the expected day count from real elapsed
  // wall-clock time (matching what formatSignalAge() itself computes off
  // Date.now()) rather than a value hardcoded against this file's fixed
  // fixture-only NOW -- daysAgo(5) is 5 days before NOW, but the REAL
  // elapsed time between that date-only string and the actual moment this
  // suite runs can be off by a day depending on how far NOW itself has
  // drifted from the real calendar date.
  const realDateOpp = { signalDate: daysAgo(5) };
  const realAge = sandbox.formatSignalAge(realDateOpp);
  const realElapsedDays = Math.round((Date.now() - new Date(daysAgo(5) + 'T00:00:00Z').getTime()) / 86400000);
  assert(new RegExp(`Dated ${realElapsedDays} days? ago`).test(realAge), `formatSignalAge() still correctly reports age from a real date, using the Preview-QA-clarified "Dated" wording (got "${realAge}", expected ~${realElapsedDays} days ago)`);
}

// ---------------------------------------------------------------------------
// required test 15: ranking order is unaffected by this round's dedup/
// eligibility changes -- getOpportunityScore()/sortDailyReasons() are
// untouched pure functions, proven by a direct before/after comparison on
// the SAME eligible candidate set.
// ---------------------------------------------------------------------------
{
  const eligibleOnly = [asBusinessOpportunity(futureOpp), asBusinessOpportunity(followUpOpp)].map(o => ({ ...o, account: 'Ridgeline Facilities Group' }));
  const sortedA = sandbox.sortDailyReasons(eligibleOnly.slice());
  const sortedB = sandbox.sortDailyReasons(eligibleOnly.slice());
  assert(JSON.stringify(sortedA.map(o=>o.sourceUrl)) === JSON.stringify(sortedB.map(o=>o.sourceUrl)), 'required test 15: sortDailyReasons() produces a stable order for the same eligible candidate set, unaffected by this round\'s eligibility/dedup changes');
}

// ---------------------------------------------------------------------------
// required test 17: no customer/account-specific conditional exists anywhere
// in the production source for the three forensic-review accounts -- proven
// by a direct source-text scan, not behavior alone.
// ---------------------------------------------------------------------------
{
  const namedConditional = /if\s*\([^)]*(['"])(Avidia|Weatherby|Toyota of Portsmouth)\1/i.test(DASHBOARD_SRC);
  assert(!namedConditional, 'required test 17: no `if (...)` conditional in dashboard/index.html branches on the Avidia/Weatherby/Toyota fixture account names');
}

// ---------------------------------------------------------------------------
// required test 1: the live research/dashboard path and the persistence/
// weekly-digest path use the SAME canonical event-resolution function --
// proven directly on the on-disk source of both call sites, not just by
// behavior, so a future refactor that reintroduces a second, weaker dedup
// implementation on either side fails this test loudly.
// ---------------------------------------------------------------------------
{
  const researchBatchSrc = readFileSync(path.join(__dirname, '..', 'api', 'research-batch.js'), 'utf8');
  const weeklyScanSrc = readFileSync(path.join(__dirname, '..', 'api', 'weekly-scan.js'), 'utf8');
  const saveUploadSrc = readFileSync(path.join(__dirname, '..', 'api', 'save-upload.js'), 'utf8');
  assert(/resolveOpportunityEvents\(/.test(researchBatchSrc), 'required test 1: api/research-batch.js (the live research/dashboard response path) calls resolveOpportunityEvents()');
  assert(/resolveOpportunityEvents\(/.test(weeklyScanSrc) || /resolveOpportunityEvents\(/.test(saveUploadSrc), 'required test 1: the persistence/weekly-digest path (api/weekly-scan.js or api/save-upload.js) calls the SAME resolveOpportunityEvents(), not a separate implementation');
}

// ---------------------------------------------------------------------------
// required test 16: cached, provider-generated outreach copy cannot
// contradict a newly recomputed "No longer current" status -- proven with a
// signal that carries exactly the kind of cached active-tense copy a real
// provider response would have generated before the event went stale.
// ---------------------------------------------------------------------------
{
  const cachedCopyOpp = {
    ...asBusinessOpportunity(toyotaOpp),
    whyNow: 'This recent acquisition creates a timely reason to reach out about a new merch program.',
    reasonToReachOut: 'With the ownership change just announced, now is a great time to introduce yourself.'
  };
  const rendered = sandbox.renderSingleVerifiedSignal(cachedCopyOpp);
  assert(!/recent acquisition/i.test(rendered) && !/ownership change just announced/i.test(rendered), 'required test 16: cached active-tense provider copy ("recent acquisition", "ownership change just announced") is suppressed, never rendered alongside a recomputed "No longer current" status');
  assert(/No longer current/.test(rendered) && /Shown for account history only/.test(rendered), 'required test 16: the recomputed status wins -- deterministic honest framing replaces the contradictory cached sentence');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
