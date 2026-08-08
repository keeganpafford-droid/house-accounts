// product/commercial-opportunity-intelligence, QA correction round 4
// (Product Finding 1 -- Impiricus finding): "This could lead to a need for
// promotional products to support brand initiatives, such as branded
// materials for outreach and events" technically filled commercialPlay but
// was commercially useless. isGenericCommercialPlay() (api/signal-intelligence.js)
// is a narrow structural gate -- a short hedge-phrase pattern plus a short
// generic-merch-noun pattern, with a stopword-style filter proving nothing
// else survives -- wired into normalizeCommercialIntelligence() so a
// generic non-answer normalizes to null (absence) rather than displaying
// filler, exactly like an empty/missing narrative already does.
//
// Usage: node scripts/test-commercial-play-quality-gate.js
import { isGenericCommercialPlay, normalizeCommercialIntelligence } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

for (const fn of [isGenericCommercialPlay, normalizeCommercialIntelligence]) {
  assert(typeof fn === 'function', `import produced a real function (${fn && fn.name})`);
}

// ===========================================================================
// Required test 2: generic "opportunity for promotional products"
// commercialPlay is rejected/null, including the exact confirmed production
// case (Impiricus, "Hiring VP of Marketing & Brand Growth").
// ===========================================================================
const CONFIRMED_PRODUCTION_CASE = 'This could lead to a need for promotional products to support brand initiatives, such as branded materials for outreach and events.';
const FOUNDER_NON_ANSWERS = [
  'This creates an opportunity for promotional products.',
  'could create a need for promotional products',
  'branded materials may be useful',
  'merchandise could support this initiative',
  'consider branded merchandise'
];

assert(isGenericCommercialPlay(CONFIRMED_PRODUCTION_CASE) === true, 'required test 2: the confirmed Impiricus production case is detected as generic');
for (const phrase of FOUNDER_NON_ANSWERS) {
  assert(isGenericCommercialPlay(phrase) === true, `required test 2: founder-identified non-answer is detected as generic ("${phrase}")`);
}

{
  const result = normalizeCommercialIntelligence({ commercialPlay: { concept: 'Brand Growth', narrative: CONFIRMED_PRODUCTION_CASE } });
  assert(result.commercialPlay === null, 'required test 2: normalizeCommercialIntelligence() nulls out a generic commercialPlay narrative -- absence over filler, matching the existing empty-narrative rule');
}
{
  // A genuinely empty/missing narrative already normalized to null before
  // this round -- unchanged.
  const result = normalizeCommercialIntelligence({});
  assert(result.commercialPlay === null, 'sanity: absence of any commercialPlay is still null (unchanged prior behavior)');
}

// ===========================================================================
// Required test 3: a specific, credible commercialPlay survives
// normalization unchanged -- the gate never fires on real specificity.
// ===========================================================================
const SPECIFIC_PLAYS = [
  'Use the 50th anniversary to build a limited collection celebrating 50 summers of backyard memories.',
  'A ribbon-cutting is a natural moment for opening-day branded gear.',
  'A newly hired VP of Marketing likely wants an early, visible internal win -- an employee culture refresh or onboarding-kit relaunch gives them a fast, tangible first move.',
  'Recognize the store associates who turn the community-impact numbers into local action with an earned patch and milestone crew kit.',
  'Consider offering a $500 milestone grant program tied to the anniversary.'
];
for (const narrative of SPECIFIC_PLAYS) {
  assert(isGenericCommercialPlay(narrative) === false, `required test 3: a specific, credible narrative is never flagged generic ("${narrative.slice(0, 50)}...")`);
  const result = normalizeCommercialIntelligence({ commercialPlay: { concept: 'Real Concept', narrative } });
  assert(result.commercialPlay !== null && result.commercialPlay.narrative === narrative, `required test 3: a specific commercialPlay survives normalization unchanged ("${narrative.slice(0, 50)}...")`);
}

// ===========================================================================
// Required test 5: a weak/generic signal with no real commercial play still
// normalizes cleanly to null (never invents specificity to survive the
// gate) -- the underlying "absence is a valid outcome" guarantee is
// unaffected by this round's stricter gate.
// ===========================================================================
{
  const result = normalizeCommercialIntelligence({});
  assert(result.commercialPlay === null && Array.isArray(result.activationIdeas) && result.activationIdeas.length === 0 && result.expansionPotential === null, 'required test 5: a weak/no-play signal normalizes to null/empty across all three fields, never fabricated');
}
{
  // A narrative that hedges but does NOT land on a generic merch noun (a
  // real, specific idea) is never caught by this gate -- the hedge alone is
  // never disqualifying, only hedge + generic noun + nothing else.
  const result = normalizeCommercialIntelligence({ commercialPlay: { narrative: 'This could create demand for a dedicated volunteer recognition program tied to the community-impact numbers.' } });
  assert(result.commercialPlay !== null, 'required test 5: a hedging-but-specific narrative (real activation, not a generic noun) still survives -- the gate targets the COMBINATION, not the hedge alone');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
