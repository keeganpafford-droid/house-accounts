// product/commercial-opportunity-intelligence -- QA correction round 3
// regression coverage (Preview QA findings 1-3: Dover Honda permission-ask
// policy, Sandwich Stampede purchase-context tiers, Catalyst Investment
// Partners stakeholder-audience reasoning).
//
// The Best Next Question policy-gate regex tests (findings 1's
// isGroundedOpener()/isPermissionBasedConceptOffer() work) live in
// scripts/test-conversation-starter-policy-gate.js. This file covers the
// remaining required tests: the deterministic-fallback tier logic for
// upcoming/recent-past events (salesReadyOpener/salesReadyWhy), the shared
// stakeholder-reasoning prompt fragment, and a fingerprint-purity check
// confirming the new recentPurchases/relatedPurchase context never leaks
// into event identity.
//
// Tests real, exported production functions -- no vm/line-range extraction.
//
// Usage: node scripts/test-historical-event-purchase-context.js
import {
  COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT,
  findLikelyRelatedPurchase,
  eventFingerprint
} from '../api/signal-intelligence.js';
import { salesReadyOpener, salesReadyWhy, computeActionability } from '../api/research-batch.js';
import { readFileSync } from 'fs';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

for (const fn of [findLikelyRelatedPurchase, salesReadyOpener, salesReadyWhy, computeActionability]) {
  assert(typeof fn === 'function', `import produced a real function (${fn && fn.name})`);
}
assert(typeof COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT === 'string' && COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT.length > 0, 'COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT is a real, non-empty string');

// ===========================================================================
// Required test 8: the stakeholder-audience reasoning instruction is a
// SINGLE shared fragment spliced into both live-research endpoints' prompts
// -- not two independently-maintained copies that could drift.
// ===========================================================================
{
  const batchSrc = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
  const accountSrc = readFileSync(new URL('../api/research-account.js', import.meta.url), 'utf8');
  assert(batchSrc.includes('COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT'), 'api/research-batch.js splices in the shared COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT');
  assert(accountSrc.includes('COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT'), 'api/research-account.js splices in the same shared COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT');
  assert(/who are the relevant audiences/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the shared fragment contains the stakeholder-audience reasoning instruction (Catalyst Investment Partners finding)');
  assert(/investors?\s*\/?\s*lps?|investor/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the shared fragment names investors/LPs as a candidate audience, alongside employees/customers/etc -- not hard-coded to "financing = investor gifts," just listed as one candidate audience type among many');
  assert(!/financing\s*=\s*investor/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'the fragment does not hard-code a "financing = investor gifts" rule -- it is a general reasoning instruction, not a keyword mapping');
}

// ===========================================================================
// Required test 5: upcoming-event deterministic fallback leads with the
// signal's own real, generated activationIdeas and asks permission to send
// concepts -- never a generic "anything coming up?" question, and never an
// invented idea (the deterministic fallback only ever has real ideas to
// draw from, since it's handed the already-normalized activationIdeas array).
// ===========================================================================
{
  const ground = { accountName: 'Dover Honda', actionability: { status: 'upcoming' } };
  const opener = salesReadyOpener('2026 Dover Holiday Parade', 'Dover Honda is the lead Platinum Sponsor.', '', 'Community / Sponsorship', ground, ['Parade-day team kit', 'Family-focused giveaway bags']);
  assert(opener.includes('Parade-day team kit'), `upcoming-event opener leads with the real, generated activation idea (got "${opener}")`);
  assert(/would it be okay if i sent/i.test(opener), 'upcoming-event opener asks permission to send concepts, not a generic "anything coming up?" question');
  assert(!/anything coming up/i.test(opener), 'the old generic upcoming-event fallback question is not used when real activation ideas exist');
}
{
  // No activationIdeas at all -> falls through to the existing topic-based
  // templates unchanged, never invents an idea to lead with.
  const ground = { accountName: 'Some Co', actionability: { status: 'upcoming' } };
  const opener = salesReadyOpener('a community festival', 'Some Co is sponsoring a community festival.', '', 'Community', ground, []);
  assert(!/would it be okay if i sent/i.test(opener), 'with no real activationIdeas, the upcoming-event permission-ask override never fires -- no invented idea is ever substituted');
}

// ===========================================================================
// Required test 6: recent-past event + a confidently-matching uploaded
// purchase -- both salesReadyWhy() and salesReadyOpener() reference the
// actual purchased category, never a generic template, and never claim more
// than the purchase record supports.
// ===========================================================================
{
  const purchases = [{ project: 'Sandwich Stampede bandanas', category: 'Bandanas', dateStr: '2026-07-10' }];
  const related = findLikelyRelatedPurchase(purchases, '2026-07-18', 'Sandwich Stampede Rodeo & Festival');
  assert(related.confidence === 'confident', `a single purchase 8 days from the event date, whose own project text names the event, is a confident match (got "${related.confidence}")`);
  assert(related.purchase.category === 'Bandanas', 'the confident match carries the real purchased category through');

  const ground = { accountName: 'Sandwich Stampede', actionability: { status: 'recent-past' }, relatedPurchase: related };
  const why = salesReadyWhy('Sandwich Stampede Rodeo & Festival', '', '', '', ground);
  assert(why.includes('Bandanas'), `salesReadyWhy() references the actual purchased category for a confident match (got "${why}")`);

  const opener = salesReadyOpener('the Sandwich Stampede Rodeo & Festival', '', '', '', ground, []);
  assert(opener.includes('Bandanas'), `salesReadyOpener() references the actual purchased category for a confident match (got "${opener}")`);
  assert(/what's next|next on the calendar/i.test(opener), 'the confident-match opener still pivots forward to what\'s next, per the founder\'s own real example');
}

// ===========================================================================
// Required test 7: recent-past event with NO matching purchase, or an
// AMBIGUOUS one, never invents prior fulfillment -- neutral posture only.
// ===========================================================================
{
  // No purchases uploaded at all.
  const none = findLikelyRelatedPurchase([], '2026-07-18');
  assert(none.confidence === 'none' && none.purchase === null, 'no purchases at all -> confidence "none", no purchase claimed');

  const groundNone = { accountName: 'Sandwich Stampede', actionability: { status: 'recent-past' }, relatedPurchase: none };
  const openerNone = salesReadyOpener('the Sandwich Stampede Rodeo & Festival', '', '', '', groundNone, []);
  assert(!/we supplied/i.test(openerNone), 'with no matching purchase, the opener never claims "we supplied" anything');
  assert(/wrapped up/i.test(openerNone), `the "no matching purchase" opener uses the neutral wrapped-up posture (got "${openerNone}")`);

  const whyNone = salesReadyWhy('Sandwich Stampede Rodeo & Festival', '', '', '', groundNone);
  assert(!/we supplied/i.test(whyNone), 'with no matching purchase, salesReadyWhy() never claims "we supplied" anything either');
}
{
  // Two candidate purchases both within the wider (but not tight) window --
  // ambiguous, not confident, so still no claimed fulfillment.
  const purchases = [
    { category: 'Bandanas', dateStr: '2026-06-05' },
    { category: 'Tote bags', dateStr: '2026-06-20' }
  ];
  const ambiguous = findLikelyRelatedPurchase(purchases, '2026-07-18');
  assert(ambiguous.confidence === 'ambiguous' && ambiguous.purchase === null, `multiple candidates in the wider window are ambiguous, not confident, and never pick a purchase to claim (got confidence="${ambiguous.confidence}")`);

  const groundAmbiguous = { accountName: 'Sandwich Stampede', actionability: { status: 'recent-past' }, relatedPurchase: ambiguous };
  const openerAmbiguous = salesReadyOpener('the Sandwich Stampede Rodeo & Festival', '', '', '', groundAmbiguous, []);
  assert(!/we supplied/i.test(openerAmbiguous), 'an ambiguous match never claims "we supplied" anything -- uncertainty is preserved, not resolved by guessing');
}
{
  // A purchase that's much too far away in time (outside even the wider
  // ambiguous window) is correctly ignored -- proximity, not existence, is
  // what counts as evidence.
  const purchases = [{ category: 'Winter apparel', dateStr: '2026-01-15' }];
  const farAway = findLikelyRelatedPurchase(purchases, '2026-07-18', 'Sandwich Stampede Rodeo & Festival');
  assert(farAway.confidence === 'none', 'a purchase from 6 months earlier is not treated as evidence of fulfillment for this event, regardless of the account having ANY purchase history');
}

// ===========================================================================
// Required test 11 (Preview QA correction round 4, explicit false-positive
// finding): an UNRELATED purchase that merely happens to land near the same
// event date must NOT be treated as event fulfillment merely because the
// dates are close. Purchase similarity requires more than temporal
// proximity -- findLikelyRelatedPurchase() now additionally requires the
// purchase's own project/category text to share a distinctive word with the
// event's own context text before it will ever return 'confident'.
// ===========================================================================
{
  // Same tight date window as the genuine Sandwich Stampede match above (8
  // days out), but the purchase itself is completely unrelated -- an office
  // furniture order that coincidentally landed in the same window.
  const purchases = [{ project: 'Q3 office furniture restock', category: 'Office furniture', dateStr: '2026-07-10' }];
  const falsePositive = findLikelyRelatedPurchase(purchases, '2026-07-18', 'Sandwich Stampede Rodeo & Festival');
  assert(falsePositive.confidence !== 'confident', `required test 11: an unrelated purchase within the tight date window is NOT promoted to "confident" merely because the dates are close (got confidence="${falsePositive.confidence}")`);
  assert(falsePositive.purchase === null, 'required test 11: no purchase is claimed as the fulfillment source when there is no textual connection to the event, regardless of date proximity');

  const groundFalsePositive = { accountName: 'Sandwich Stampede', actionability: { status: 'recent-past' }, relatedPurchase: falsePositive };
  const openerFalsePositive = salesReadyOpener('the Sandwich Stampede Rodeo & Festival', '', '', '', groundFalsePositive, []);
  assert(!/we supplied/i.test(openerFalsePositive), 'required test 11: the opener never claims "we supplied" the unrelated office-furniture purchase for this event');
  assert(!/office furniture/i.test(openerFalsePositive), 'required test 11: the opener never names the unrelated purchase category at all');

  // Sanity: with NO event context text supplied at all, the confident tier
  // can never fire, even for the genuinely-matching Sandwich Stampede
  // purchase from the earlier test -- callers that don't supply context
  // degrade safely to "ambiguous," never to a wrongly promoted "confident."
  const noContext = findLikelyRelatedPurchase([{ project: 'Sandwich Stampede bandanas', category: 'Bandanas', dateStr: '2026-07-10' }], '2026-07-18');
  assert(noContext.confidence === 'ambiguous', `required test 11: with no eventContextText supplied, even a genuinely matching purchase degrades to "ambiguous," never silently promoted to "confident" (got "${noContext.confidence}")`);
}

// ===========================================================================
// Required test 9: existing grounding/fingerprint behavior is unchanged --
// the new relatedPurchase/recentPurchases context never enters event
// identity/dedup, mirroring the existing commercialPlay/activationIdeas/
// expansionPotential fingerprint-purity guarantee from commit 1.
// ===========================================================================
{
  const evidenceOnly = { companyName: 'Fingerprint Co', title: 'Annual Festival', snippet: 'The festival wrapped up last weekend.', eventDate: '2026-07-18' };
  const fpBase = eventFingerprint(evidenceOnly);
  const withRelatedPurchase = eventFingerprint({ ...evidenceOnly, relatedPurchase: { confidence: 'confident', purchase: { category: 'Bandanas' } } });
  const withRecentPurchases = eventFingerprint({ ...evidenceOnly, recentPurchases: [{ category: 'Bandanas', project: 'X', dateStr: '2026-07-10' }] });
  assert(fpBase === withRelatedPurchase, 'adding a relatedPurchase does not change the event fingerprint');
  assert(fpBase === withRecentPurchases, 'adding recentPurchases does not change the event fingerprint');
}

// computeActionability() itself is untouched by this sprint -- sanity check
// that upcoming/recent-past classification still works as the tier logic
// above assumes, using a fixed reference "now."
{
  const now = new Date('2026-08-08T00:00:00Z');
  const upcoming = computeActionability({ eventCategory: 'event-like', eventDate: '2026-12-05', dateConfidence: 'exact', now });
  assert(upcoming.status === 'upcoming', `sanity: a December event relative to an August "now" is classified upcoming (got "${upcoming.status}")`);
  const recentPast = computeActionability({ eventCategory: 'event-like', eventDate: '2026-07-18', dateConfidence: 'exact', now });
  assert(recentPast.status === 'recent-past', `sanity: a mid-July event relative to an August "now" is classified recent-past (got "${recentPast.status}")`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
