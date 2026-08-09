// Focused review follow-up: a prior report incorrectly implied the real
// Avidia Bank case (event dated June 23, 2026) would still read "launch-
// related ideas" when reviewed on August 5, 2026 (~43 days later). Direct
// forensic tracing (see the accompanying return report) proved the
// PRODUCTION CODE already computes this correctly -- the report's own
// worked example used a fixture relative to the machine's ambient clock at
// write time and mislabeled it as "Avidia's own case" without checking the
// real June 23 date against the review's stated August 5 "current date".
// This file locks in that proof with an INJECTED, FIXED clock (never the
// machine's ambient Date.now()) using the real production functions:
// computeActionability() (api/research-batch.js) and isWithinLaunchFollowupWindow()/
// ideaOfferPhrase()/buildConciseSalesPlay()/buildReplyFirstEmail()
// (dashboard/index.html, extracted verbatim into a vm sandbox whose Date
// global is replaced with a fixed-instant subclass).
//
// Usage: node scripts/test-avidia-date-fixed-clock-regression.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { computeActionability, signalEventCategory } from '../api/research-batch.js';

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
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-avidia-date-fixed-clock-regression.js.`);
  }
  const trimmed = slice.trimEnd();
  if(!trimmed.endsWith('}') && !trimmed.endsWith('};')){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${endLine} does not close as expected -- update the line range.`);
  }
  return slice;
}

const TIMEBOX_CONFIG_SRC = extractBlock('TIMEBOX_CONFIG', 2784, 2789, 'const TIMEBOX_CONFIG = {');
const IS_RELATIONSHIP_EXPANSION_SRC = extractBlock('isRelationshipExpansionOpportunity', 3019, 3022, 'function isRelationshipExpansionOpportunity(');
const DEDUPE_AND_IDENTITY_BLOCK = extractBlock('dedupe-and-identity-helpers', 2937, 3406, 'function cleanOpportunityToken(');
const CARD_AND_MODAL_BLOCK = extractBlock('card-and-modal-helpers', 4712, 6194, 'function confidenceLabel(');
const SALES_PLAY_BLOCK = extractBlock('sales-play-grounding', 8488, 9801, 'function salesPlayModeFromOpp(');
const SCORING_AND_TIMEBOX_BLOCK = extractBlock('scoring-and-timebox-helpers', 9804, 10332, 'function normalizeSignalLayerType(');

// Builds a fresh vm sandbox whose Date global is a fixed-instant subclass of
// the real Date -- every `new Date()`/`Date.now()` call inside the extracted
// production source (isWithinLaunchFollowupWindow, parseMaybeDate, etc.)
// resolves against this injected instant, never the machine's ambient clock.
// `new Date(dateString)`/instance methods are otherwise the real, unmodified
// Date implementation -- only "the current instant" is overridden.
function makeSandbox(fixedNowIso){
  const RealDate = Date;
  const fixedNowMs = new RealDate(fixedNowIso).getTime();
  class FixedDate extends RealDate {
    constructor(...args){
      if(args.length === 0) return new RealDate(fixedNowMs);
      return new RealDate(...args);
    }
    static now(){ return fixedNowMs; }
  }
  const domElements = {};
  const sandbox = {
    console,
    Date: FixedDate,
    window: { accountRadarAccounts: [] },
    document: {
      getElementById: (id) => { domElements[id] = domElements[id] || { textContent: '', innerHTML: '', style: {} }; return domElements[id]; },
      querySelectorAll: () => []
    },
    isWarmAccount: () => false,
    URL, Array, Object, String, Number, Math, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  const fullSource = [
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    CARD_AND_MODAL_BLOCK,
    SALES_PLAY_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'dashboard-fixed-clock-extract.js' }).runInContext(sandbox);
  return sandbox;
}

function ctxFor(eventDateIso, actionabilityTense, canonicalKind = 'expansion'){
  return { canonicalKind, actionabilityTense, eventDate: eventDateIso, isAccountHistory: false };
}

// ===========================================================================
// Scenario 1 -- the REAL Avidia case: event June 23, 2026, reviewed on the
// real stated current date, August 5, 2026. ~43 days old.
// ===========================================================================
{
  const sandbox = makeSandbox('2026-08-05T12:00:00Z');
  const now = new Date('2026-08-05T12:00:00Z');
  const eventDate = new Date('2026-06-23');
  const ageDays = Math.floor((now.getTime() - eventDate.getTime()) / 86400000);
  assert(ageDays === 43, `scenario 1: the real Avidia event (June 23, 2026) reviewed on August 5, 2026 is exactly 43 days old (got ${ageDays})`);

  // computeActionability() is the REAL, exported api/research-batch.js
  // function, called with an explicit `now` (its own documented injection
  // point) so this proof never depends on the machine's ambient clock.
  const actionability = computeActionability({
    eventCategory: signalEventCategory('RENOVATION_COMPLETION'),
    eventDate: '2026-06-23',
    dateConfidence: 'exact',
    now
  });
  assert(actionability.status === 'recent-past', `scenario 1: at 43 days old (inside the real 45-day FOLLOW_UP_WINDOW_DAYS), the real computeActionability() still classifies this as "recent-past" -- eligible only as a follow-up (got ${actionability.status})`);
  assert(actionability.isPriorityEligible === true, 'scenario 1: the 43-day-old event remains priority-eligible (still inside the eligibility window)');
  assert(actionability.tense === 'past', 'scenario 1: outreach tense is explicitly past/follow-up, never present or future');

  const ctx = ctxFor('2026-06-23', 'past');
  assert(sandbox.isWithinLaunchFollowupWindow(ctx) === false, 'scenario 1: 43 days is NOT within the 14-day launch-follow-up window');
  const offer = sandbox.ideaOfferPhrase(ctx);
  assert(offer === 'a few post-event follow-up ideas', `scenario 1: ideaOfferPhrase() returns durable post-event wording, not "launch-related ideas" (got "${offer}")`);
  assert(!/launch-related/.test(offer), 'scenario 1: the offer text never says "launch-related"');
  assert(!/upcoming/i.test(offer), 'scenario 1: the offer text never implies the event is still upcoming');

  // Full outreach-copy trace (item 9 of the required forensic trace): the
  // real buildConciseSalesPlay()/buildReplyFirstEmail() pipeline, fed the
  // same ctx shape createSalesPlayPanel() builds from a real opportunity.
  const play = sandbox.buildConciseSalesPlay({
    account: 'Avidia Bank', firstName: 'Sam', mode: 'Cold',
    canonicalKind: 'expansion', actionabilityTense: 'past', isUpcoming: false,
    eventDate: '2026-06-23', hasKnownContact: false, isAccountHistory: false,
    layer: 'Business Activity Signal',
    department: 'Marketing'
  });
  assert(!/launch-related ideas/.test(play.outreachEmail), `scenario 1: the real generated outreach email never says "launch-related ideas" for the 43-day-old event (got: "${play.outreachEmail}")`);
  assert(/post-event follow-up ideas/.test(play.outreachEmail), `scenario 1: the real generated outreach email uses "post-event follow-up ideas" (got: "${play.outreachEmail}")`);
  assert(!/is investing|is hosting|is opening|coming up/i.test(play.outreachEmail), 'scenario 1: the email never uses present/future-tense launch language for a 43-day-old completed event');
}

// ===========================================================================
// Scenario 2 -- a genuinely 3-day-old launch event: launch wording remains
// valid.
// ===========================================================================
{
  const FIXED_NOW = '2026-06-26T12:00:00Z'; // exactly 3 days after 2026-06-23
  const sandbox = makeSandbox(FIXED_NOW);
  const now = new Date(FIXED_NOW);
  const actionability = computeActionability({
    eventCategory: signalEventCategory('RENOVATION_COMPLETION'),
    eventDate: '2026-06-23', dateConfidence: 'exact', now
  });
  assert(actionability.status === 'recent-past' && actionability.isPriorityEligible === true, 'scenario 2: a genuinely 3-day-old event remains eligible');
  const ctx = ctxFor('2026-06-23', 'past');
  assert(sandbox.isWithinLaunchFollowupWindow(ctx) === true, 'scenario 2: 3 days is within the 14-day launch-follow-up window');
  assert(sandbox.ideaOfferPhrase(ctx) === 'a few launch-related ideas', `scenario 2: a genuinely 3-day-old launch event still offers "launch-related ideas" (got "${sandbox.ideaOfferPhrase(ctx)}")`);
}

// ===========================================================================
// Scenario 3 -- 20 days old: eligible follow-up, durable post-event wording.
// ===========================================================================
{
  const FIXED_NOW = '2026-07-13T12:00:00Z'; // exactly 20 days after 2026-06-23
  const sandbox = makeSandbox(FIXED_NOW);
  const now = new Date(FIXED_NOW);
  const actionability = computeActionability({
    eventCategory: signalEventCategory('RENOVATION_COMPLETION'),
    eventDate: '2026-06-23', dateConfidence: 'exact', now
  });
  assert(actionability.status === 'recent-past' && actionability.isPriorityEligible === true, 'scenario 3: a 20-day-old event remains eligible as a follow-up');
  const ctx = ctxFor('2026-06-23', 'past');
  assert(sandbox.isWithinLaunchFollowupWindow(ctx) === false, 'scenario 3: 20 days is past the 14-day launch-follow-up window');
  const offer = sandbox.ideaOfferPhrase(ctx);
  assert(offer === 'a few post-event follow-up ideas', `scenario 3: a 20-day-old event uses durable post-event wording (got "${offer}")`);
}

// ===========================================================================
// Scenario 4 -- beyond the complete 45-day eligibility window: inactive, no
// active outreach.
// ===========================================================================
{
  const FIXED_NOW = '2026-08-12T12:00:00Z'; // 50 days after 2026-06-23
  const sandbox = makeSandbox(FIXED_NOW);
  const now = new Date(FIXED_NOW);
  const actionability = computeActionability({
    eventCategory: signalEventCategory('RENOVATION_COMPLETION'),
    eventDate: '2026-06-23', dateConfidence: 'exact', now
  });
  assert(actionability.status === 'stale', `scenario 4: an event 50 days past its date (beyond the 45-day window) evaluates to stale (got ${actionability.status})`);
  assert(actionability.isPriorityEligible === false, 'scenario 4: the 50-day-old event is not priority-eligible');
  assert(actionability.label === 'No longer current', 'scenario 4: the label reads "No longer current"');

  const opp = {
    account: 'Avidia Bank', accountName: 'Avidia Bank',
    signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    canonicalEventType: 'RENOVATION_COMPLETION', opportunityType: 'RENOVATION_COMPLETION',
    eventDate: '2026-06-23', actionabilityStatus: actionability
  };
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'scenario 4: isPriorityEligibleOpportunity() rejects the 50-day-old event -- it cannot appear as an active sales play');
  assert(sandbox.signalDateAndActionabilityLine(opp) === 'No longer current', 'scenario 4: the rendered status line is "No longer current"');
}

// ===========================================================================
// Scenario 5 -- date-only values behave consistently regardless of the
// process's local timezone (new Date('YYYY-MM-DD') is always UTC-midnight
// per spec; this proves the day-count this file relies on is not silently
// timezone-dependent).
// ===========================================================================
{
  const originalTZ = process.env.TZ;
  const results = [];
  for(const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata']){
    process.env.TZ = tz;
    const now = new Date('2026-08-05T12:00:00Z');
    const eventDate = new Date('2026-06-23');
    const days = Math.floor((now.getTime() - eventDate.getTime()) / 86400000);
    results.push({ tz, days });
  }
  process.env.TZ = originalTZ;
  const allSame = results.every(r => r.days === results[0].days);
  assert(allSame, `scenario 5: date-only value parsing and day-count computation are identical across every tested timezone (got ${JSON.stringify(results)})`);
  assert(results[0].days === 43, 'scenario 5: the timezone-independent day count is the correct 43 days');
}

// ===========================================================================
// Scenario 6 -- cached provider copy cannot override the deterministic,
// age-based phrase. ideaOfferPhrase()/isWithinLaunchFollowupWindow() are
// pure functions of ctx (never read any cached/persisted free-text offer
// field), so there is structurally no cached value for them to defer to --
// proven by confirming the function signature and body never reference a
// cached offer/idea field.
// ===========================================================================
{
  assert(!/ctx\.(cachedOffer|offerText|ideaOffer|conversationStarter)/.test(SALES_PLAY_BLOCK.match(/function ideaOfferPhrase[\s\S]*?\n}/)[0]), 'scenario 6: ideaOfferPhrase() never reads a cached/persisted offer field -- its output is deterministically derived from ctx.canonicalKind/actionabilityTense/eventDate alone, so no cached provider copy can override it');
  // Direct proof: even if the ctx carries an unrelated cached field that
  // LOOKS like it might influence the offer, the deterministic function
  // ignores it entirely.
  const sandbox = makeSandbox('2026-08-05T12:00:00Z');
  const ctxWithCachedNoise = { ...ctxFor('2026-06-23', 'past'), conversationStarter: 'Some cached AI text about launch-related ideas being available now.' };
  assert(sandbox.ideaOfferPhrase(ctxWithCachedNoise) === 'a few post-event follow-up ideas', 'scenario 6: an unrelated cached conversationStarter field on the same ctx has zero effect on the deterministic offer phrase');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
