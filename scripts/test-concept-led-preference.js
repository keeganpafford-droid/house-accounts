// product/commercial-opportunity-intelligence, QA correction round 4
// (Product Finding 3 -- Dover Honda "concept-led must be preferred, not
// merely allowed" finding): the prior correction round made a concept-led
// permission ask LEGAL under isGroundedOpener(), but getSuggestedOpener()
// still preferred a stored, valid-but-generic discovery question ("anything
// coming up that your team is already planning around?") whenever one was
// present, simply because it passed the safety gate. This round adds a
// QUALITY preference: conceptLedApproach() (dashboard/index.html) generates
// a concept-led permission ask directly from the opportunity's own real
// activationIdeas whenever the signal is upcoming, has a credible
// commercialPlay, and has real ideas to draw from -- and getSuggestedOpener()
// now prefers it over a merely-valid-but-generic stored opener, UNLESS the
// stored opener is ALREADY concept-led itself (in which case the model's
// own, presumably more specific, version wins).
//
// Extracts the REAL, verbatim production functions (dashboard/index.html)
// and runs them for real in a vm sandbox -- proving actual selection
// behavior, not source-text pattern matching. Functions needed only by
// getSuggestedOpener()'s deep fallback branches (reached only when NEITHER
// a concept-led approach NOR a valid stored opener exists) are stubbed --
// required test 5 exercises that fallback path deliberately, so the stubs
// must still produce a real, plausible question, not throw.
//
// Usage: node scripts/test-concept-led-preference.js
import vm from 'vm';
import { extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// shortText() through getSuggestedOpener() -- one contiguous block covering
// conceptLedApproach() and every function getSuggestedOpener() itself calls
// directly (isGroundedOpener/repairDanglingOpener/isPermissionBasedConceptOffer/
// businessSuggestedOpener and its own dependency chain).
const OPENER_SRC = extractRange(loadDashboardSource(), 'function shortText(text, max=145){', 'function getSuggestedOpener(opp){');

const sandbox = {
  // Stubs: only reached by getSuggestedOpener()'s deep fallback branches
  // (Relationship Expansion / Follow-Up / Repeat-Pattern layer dispatch and
  // likelyKnownBuyer()'s own greeting-name lookup), never by the concept-led
  // preference logic itself. Kept intentionally trivial.
  likelyKnownBuyer: () => '',
  signalLayerLabel: () => 'Business Activity Signal',
  getRecommendationType: () => '',
  likelyDepartmentFromOpportunity: () => 'the right team',
  primaryCategoryFromOpportunity: () => 'branded merchandise',
  console
};
vm.createContext(sandbox);
vm.runInContext(OPENER_SRC, sandbox);
const { conceptLedApproach, getSuggestedOpener, isPermissionBasedConceptOffer, isGroundedOpener } = sandbox;
for (const fn of [conceptLedApproach, getSuggestedOpener, isPermissionBasedConceptOffer, isGroundedOpener]) {
  assert(typeof fn === 'function', `extraction produced a real function (${fn && fn.name})`);
}

// ===========================================================================
// conceptLedApproach() in isolation.
// ===========================================================================
const DOVER_OPP = {
  account: 'Dover Honda',
  signalTitle: '2026 Dover Holiday Parade',
  actionabilityStatus: { status: 'upcoming' },
  commercialPlay: { concept: 'Holiday Parade Sponsorship', narrative: 'Dover Honda is the lead Platinum Sponsor for the 2026 Dover Holiday Parade.' },
  activationIdeas: ['Parade-day team kit', 'Family-focused giveaway bags']
};
{
  const result = conceptLedApproach(DOVER_OPP);
  assert(typeof result === 'string' && result.length > 0, 'conceptLedApproach() produces a real approach for a qualifying upcoming opportunity');
  assert(result.includes('Parade-day team kit'), `conceptLedApproach() names a real, generated activation idea (got "${result}")`);
  assert(/would it be okay if i sent/i.test(result), 'conceptLedApproach() asks permission to send concepts');
}
{
  // Commercial Activation Reasoning sprint: recent-past now ALSO qualifies
  // (the founder's own Gallagher/Wilson M. Beck acquisition example is a
  // recent-past event that still deserves a concept-led permission ask) --
  // uses the past-tense-safe em-dash lead, not "has ... coming up".
  const result = conceptLedApproach({ ...DOVER_OPP, actionabilityStatus: { status: 'recent-past' } });
  assert(typeof result === 'string' && result.length > 0, 'conceptLedApproach() also produces a real approach for a qualifying recent-past opportunity');
  assert(result.includes('Parade-day team kit'), `conceptLedApproach() names a real activation idea for a recent-past opportunity too (got "${result}")`);
  assert(/would it be okay if i sent/i.test(result), 'conceptLedApproach() asks permission to send concepts for a recent-past opportunity too');
  assert(!/coming up/i.test(result), `conceptLedApproach() never uses future-facing "coming up" phrasing for a recent-past event (got "${result}")`);
}
{
  // Commercial Activation Reasoning sprint: 'ongoing' now ALSO qualifies
  // (an acquisition/leadership-change/funding signal is never classified
  // 'upcoming'/'recent-past' -- ACQUISITION is not in EVENT_LIKE_TYPES, so
  // 'ongoing' is the only "currently valid" status it can ever have; see
  // the Gallagher/Wilson M. Beck fixture in
  // scripts/test-commercial-activation-reasoning.js). Genuinely
  // non-qualifying (stale/unknown) statuses still return null.
  const ongoingResult = conceptLedApproach({ ...DOVER_OPP, actionabilityStatus: { status: 'ongoing' } });
  assert(typeof ongoingResult === 'string' && ongoingResult.length > 0, 'conceptLedApproach() also produces a real approach for a qualifying ongoing opportunity (e.g. an acquisition, which never resolves to upcoming/recent-past)');
  assert(!/coming up/i.test(ongoingResult), `conceptLedApproach() never uses future-facing "coming up" phrasing for an ongoing signal (got "${ongoingResult}")`);
  assert(conceptLedApproach({ ...DOVER_OPP, actionabilityStatus: { status: 'ongoing-stale' } }) === null, 'conceptLedApproach() returns null for a stale (no longer current) signal');
  assert(conceptLedApproach({ ...DOVER_OPP, actionabilityStatus: { status: 'unknown-date' } }) === null, 'conceptLedApproach() returns null for an unknown-date signal');
}
{
  // Commercial Activation Reasoning sprint, live-QA "NO IDEA, NO PRIORITY"
  // correction: activationIdeas are what this function actually turns into
  // text -- commercialPlay's own narrative was only ever a gate, never used
  // in the output. A real idea list with a null/filtered-out commercialPlay
  // now still produces a real approach (closes a gap where a genuinely good
  // idea list was blocked from ever becoming a concept-led ask merely
  // because the play narrative itself got filtered as generic).
  const result = conceptLedApproach({ ...DOVER_OPP, commercialPlay: null });
  assert(typeof result === 'string' && result.length > 0, 'conceptLedApproach() now produces a real approach from real activationIdeas even with no commercialPlay narrative');
  assert(result.includes('Parade-day team kit'), `conceptLedApproach() still names the real idea when commercialPlay is null (got "${result}")`);
}
{
  // No activationIdeas -> null.
  assert(conceptLedApproach({ ...DOVER_OPP, activationIdeas: [] }) === null, 'conceptLedApproach() returns null with no real activationIdeas -- never invents one');
}

// ===========================================================================
// Required test 4: upcoming + credible commercialPlay + strong
// activationIdeas prefers the concept-led permission ask over a stored,
// valid-but-generic discovery question -- the exact Dover Honda finding.
// ===========================================================================
{
  const oppWithGenericStored = { ...DOVER_OPP, conversationStarter: 'Anything coming up that your team is already planning around?' };
  // Sanity: the stored text is itself valid/grounded (passes the safety
  // gate) -- proving the preference logic, not merely a validity check.
  assert(isGroundedOpener(oppWithGenericStored.conversationStarter, oppWithGenericStored) === true, 'sanity: the generic stored discovery question is itself grounded/valid -- this is a quality preference test, not a validity test');
  const chosen = getSuggestedOpener(oppWithGenericStored);
  assert(chosen.includes('Parade-day team kit'), `required test 4: getSuggestedOpener() prefers the concept-led approach over a merely-valid-but-generic stored opener (got "${chosen}")`);
  assert(!/anything coming up/i.test(chosen), 'required test 4: the generic "anything coming up?" question does not win merely because it passed the safety gate');
}
{
  // If the model's OWN stored text is already concept-led, it wins over the
  // deterministic template (presumably more specific/natural).
  const oppWithConceptLedStored = { ...DOVER_OPP, conversationStarter: 'We had an idea around a family-focused giveaway for the parade. Would it be useful if I sent a few concepts?' };
  const chosen = getSuggestedOpener(oppWithConceptLedStored);
  assert(chosen === oppWithConceptLedStored.conversationStarter, `required test 4: an already concept-led stored opener wins over the deterministic template (got "${chosen}")`);
}
{
  // No stored conversationStarter at all -- the concept-led template still
  // fires (the qualifying conditions alone are sufficient).
  const chosen = getSuggestedOpener({ ...DOVER_OPP, conversationStarter: '' });
  assert(chosen.includes('Parade-day team kit'), 'required test 4: the concept-led approach fires even with no stored conversationStarter at all');
}

// ===========================================================================
// Required test 5: a weak/no-play signal can still use neutral discovery --
// the preference logic never forces a concept-led approach when the
// opportunity doesn't qualify, and the deterministic fallback chain still
// produces a real, sensible question.
// ===========================================================================
{
  const weakOpp = { account: 'Thin Evidence Co', signalTitle: 'Posted two open roles', actionabilityStatus: { status: 'ongoing' } };
  const chosen = getSuggestedOpener(weakOpp);
  assert(typeof chosen === 'string' && chosen.length > 0, 'required test 5: a weak/no-play signal still produces a real fallback question, never a blank/thrown error');
  assert(!/parade-day team kit|would it be okay if i sent/i.test(chosen), 'required test 5: no concept-led language leaks in when the opportunity has no real activationIdeas to draw from');
}
{
  // Upcoming but no commercialPlay/activationIdeas at all -- still falls
  // through to neutral discovery, never invents a play to justify a
  // concept-led approach.
  const upcomingNoPlay = { account: 'Some Co', signalTitle: 'a community festival', actionabilityStatus: { status: 'upcoming' } };
  const chosen = getSuggestedOpener(upcomingNoPlay);
  assert(!/would it be okay if i sent/i.test(chosen), 'required test 5: an upcoming signal with no credible commercialPlay/activationIdeas never fabricates a concept-led permission ask');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
