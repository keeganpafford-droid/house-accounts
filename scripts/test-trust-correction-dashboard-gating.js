// Trust correction (entity-disambiguation) regression tests, part 3: the
// dashboard-side primary-opportunity eligibility gate and the "Verified
// Opportunity" label guard. Runs the REAL, verbatim dashboard/index.html
// source extracted into a vm sandbox (same convention as
// scripts/test-avidia-date-fixed-clock-regression.js and siblings) -- nothing
// here is a reimplementation of production logic.
//
// Covers items 10-12 of the trust-correction test list:
//   10) a confirmed opportunity can become primary
//   11) an unconfirmed opportunity can never displace a confirmed opportunity
//       for the same account, regardless of freshness/raw confidence
//   12) an unconfirmed opportunity is never rendered with "Verified
//       Opportunity" language
// Legacy-compatibility behavior (identityConfidence field absent) is also
// covered here, since it is the other half of the same gate.
//
// Usage: node scripts/test-trust-correction-dashboard-gating.js
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
  return slice;
}

// Same named blocks scripts/test-avidia-date-fixed-clock-regression.js
// already extracts (dedupe/identity helpers, card/modal render helpers,
// sales-play grounding template, scoring/timebox helpers) -- together they
// contain everything this file drives: dedupeOpportunities(),
// mergeBusinessSignalInitiatives(), accountOpportunityCluster(),
// additionalOpportunitiesFor(), renderVerifiedOpportunitySection(),
// isPriorityEligibleOpportunity()/hasConfirmedOrLegacyIdentity(),
// priorityEligibleOpportunities(), sortDailyReasons(), calculateOpportunityScore().
const TIMEBOX_CONFIG_SRC = extractBlock('TIMEBOX_CONFIG', 2784, 2789, 'const TIMEBOX_CONFIG = {');
const IS_RELATIONSHIP_EXPANSION_SRC = extractBlock('isRelationshipExpansionOpportunity', 3019, 3022, 'function isRelationshipExpansionOpportunity(');
const DEDUPE_AND_IDENTITY_BLOCK = extractBlock('dedupe-and-identity-helpers', 2937, 3417, 'function cleanOpportunityToken(');
const CARD_AND_MODAL_BLOCK = extractBlock('card-and-modal-helpers', 4723, 6219, 'function confidenceLabel(');
const SALES_PLAY_BLOCK = extractBlock('sales-play-grounding', 8533, 9851, 'function salesPlayModeFromOpp(');
const SCORING_AND_TIMEBOX_BLOCK = extractBlock('scoring-and-timebox-helpers', 9854, 10424, 'function normalizeSignalLayerType(');
const ESCAPE_HTML_SRC = extractBlock('escapeHtml', 11175, 11178, 'function escapeHtml(');
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
    ESCAPE_HTML_SRC,
    CLAMP_SCORE_SRC,
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    CARD_AND_MODAL_BLOCK,
    SALES_PLAY_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'dashboard-trust-correction-extract.js' }).runInContext(sandbox);
  return sandbox;
}

const sandbox = makeSandbox();

// A realistic Business Activity Signal opportunity shape, matching what
// resolveOpportunityEvents()/normalizeOpportunity() actually produce.
function businessOpp(overrides = {}){
  const now = new Date();
  return {
    account: 'Dover Honda',
    isReal: true,
    signalLayerType: 'Business Activity Signal',
    opportunityType: 'REBRAND',
    signalTitle: 'Major Rebrand for 2028',
    sourceUrl: 'https://www.instagram.com/edmartinhonda',
    confidence: 74,
    confidenceScore: 74,
    signalDate: now.toISOString().slice(0, 10),
    eventDate: now.toISOString().slice(0, 10),
    actionabilityStatus: { status: 'recent-past', isPriorityEligible: true },
    reasonToReachOut: 'Timely reason to reach out',
    evidence: ['A rebrand was announced'],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 10) a confirmed opportunity can become primary.
// ---------------------------------------------------------------------------
const confirmedOnly = [businessOpp({ identityConfidence: 'confirmed' })];
const clusterConfirmedOnly = sandbox.accountOpportunityCluster(confirmedOnly[0]);
assert(
  sandbox.priorityEligibleOpportunities(confirmedOnly).length === 1,
  '10) a confirmed opportunity survives the priority-eligibility gate and can become primary'
);

// ---------------------------------------------------------------------------
// 11) an unconfirmed opportunity can never displace a confirmed opportunity,
// regardless of freshness/raw confidence -- give the UNCONFIRMED item a much
// higher confidence and a fresher date than the confirmed one.
// ---------------------------------------------------------------------------
const confirmedParade = businessOpp({
  signalTitle: 'Dover Holiday Parade Platinum Sponsorship',
  sourceUrl: 'https://doverhonda.com/news/parade-2026',
  identityConfidence: 'confirmed',
  confidence: 55,
  confidenceScore: 55,
  eventDate: new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10)
});
const unconfirmedRebrand = businessOpp({
  signalTitle: 'Major Rebrand for 2028',
  sourceUrl: 'https://www.instagram.com/edmartinhonda',
  identityConfidence: 'unconfirmed',
  confidence: 95,
  confidenceScore: 95,
  eventDate: new Date().toISOString().slice(0, 10)
});
const mixedEligible = sandbox.priorityEligibleOpportunities([confirmedParade, unconfirmedRebrand]);
assert(
  mixedEligible.length === 1 && mixedEligible[0].identityConfidence === 'confirmed',
  '11a) the unconfirmed (higher-confidence, fresher) signal is excluded entirely -- only the confirmed one survives priority eligibility'
);
const rankedMixed = sandbox.sortDailyReasons(mixedEligible);
assert(
  rankedMixed[0]?.identityConfidence === 'confirmed',
  '11b) after eligibility + ranking, the confirmed signal is first (the unconfirmed one never even reaches ranking)'
);

// Legacy compatibility: a signal with NO identityConfidence field at all
// (persisted before the tri-state verifier existed) must keep its prior,
// unchanged eligibility -- it must not vanish from the feed overnight.
const legacyOnly = [businessOpp({ identityConfidence: undefined })];
delete legacyOnly[0].identityConfidence;
assert(
  sandbox.priorityEligibleOpportunities(legacyOnly).length === 1,
  '11c) a legacy opportunity with no identityConfidence field at all remains eligible (backward compatible, not silently hidden)'
);
// But a legacy signal must not be able to OUTRANK a confirmed one just
// because dedupeOpportunities()'s identity tiering treats legacy as neutral,
// not equal-to-confirmed.
const rejectedNewSignal = businessOpp({ identityConfidence: 'rejected' });
assert(
  sandbox.priorityEligibleOpportunities([rejectedNewSignal]).length === 0,
  '11d) a signal explicitly graded rejected is excluded from priority eligibility (defense in depth -- these should not be persisted at all, but this proves the gate does not silently admit them)'
);

// ---------------------------------------------------------------------------
// 12) an unconfirmed opportunity is never rendered with "Verified
// Opportunity" language.
// ---------------------------------------------------------------------------
const confirmedHtml = sandbox.renderVerifiedOpportunitySection(businessOpp({ identityConfidence: 'confirmed' }));
const unconfirmedHtml = sandbox.renderVerifiedOpportunitySection(businessOpp({ identityConfidence: 'unconfirmed' }));
const legacyHtml = sandbox.renderVerifiedOpportunitySection((() => { const o = businessOpp({}); delete o.identityConfidence; return o; })());
assert(
  confirmedHtml.includes('Verified Opportunity'),
  '12a) a confirmed opportunity still renders the "Verified Opportunity" heading'
);
assert(
  !unconfirmedHtml.includes('Verified Opportunity') && unconfirmedHtml.includes('Unconfirmed Research'),
  '12b) an unconfirmed opportunity never renders "Verified Opportunity" -- it renders an explicit "Unconfirmed Research" label instead'
);
// Verified-terminology sprint: this assertion is DELIBERATELY inverted from
// its prior form. The old heading logic defaulted to "Verified Opportunity"
// for anything that wasn't explicitly 'unconfirmed'/'rejected', which
// silently included a legacy row with identityConfidence missing entirely
// -- confirmed production defect (Dover Honda's "Major Rebrand for 2028").
// Eligibility (11c above, hasConfirmedOrLegacyIdentity()) is a SEPARATE
// question and remains unchanged: a legacy row can still win a priority
// slot. Whether it may be LABELED "verified" is this different question,
// and per the product invariant only an explicit 'confirmed' grade
// qualifies -- isExplicitlyVerifiedIdentity() is a positive, 'confirmed'-
// only check, so a legacy row now correctly reads "Unconfirmed Research."
assert(
  !legacyHtml.includes('Verified Opportunity') && legacyHtml.includes('Unconfirmed Research'),
  '12c) a legacy opportunity (no identityConfidence field) never renders "Verified Opportunity" -- it renders "Unconfirmed Research," since it was never actually run through the tri-state grounding verifier'
);

// ---------------------------------------------------------------------------
// 9 (dashboard half): dedupeOpportunities()/mergeBusinessSignalInitiatives()
// must not let an unconfirmed-but-higher-source-strength variant of what the
// app believes is the SAME initiative silently downgrade a confirmed one --
// a confirmed variant anywhere in the merged group must win the group's
// identityConfidence, even if it does not win the source-strength rank.
// ---------------------------------------------------------------------------
const sameInitiativeConfirmed = businessOpp({
  signalTitle: 'Dover Honda Rebrand Announcement',
  opportunityType: 'REBRAND',
  sourceUrl: 'https://doverhonda.com/news/rebrand',
  identityConfidence: 'confirmed',
  eventDate: '2026-06-01',
  event_date: '2026-06-01'
});
const sameInitiativeUnconfirmedStrongerSource = businessOpp({
  signalTitle: 'Dover Honda Rebrand Announcement',
  opportunityType: 'REBRAND',
  sourceUrl: 'https://reuters.com/dover-honda-rebrand',
  identityConfidence: 'unconfirmed',
  eventDate: '2026-06-01',
  event_date: '2026-06-01'
});
const merged = sandbox.dedupeOpportunities([sameInitiativeUnconfirmedStrongerSource, sameInitiativeConfirmed]);
assert(
  merged.length === 1 && merged[0].identityConfidence === 'confirmed',
  '9) merging two representations of the same initiative keeps identityConfidence=confirmed even when the higher-source-strength variant was only unconfirmed'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
