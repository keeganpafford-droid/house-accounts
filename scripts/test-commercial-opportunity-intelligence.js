// product/commercial-opportunity-intelligence -- Commit 1 (schema + synthesis)
// regression coverage.
//
// House Accounts' core job is the research and commercial thinking a
// salesperson doesn't have time to do, not writing their email for them.
// This sprint adds three new, optional commercial-interpretation fields
// (commercialPlay, activationIdeas, expansionPotential) to the signal/
// opportunity shape both live research endpoints produce, while keeping
// WHY NOW (factual) and BEST NEXT QUESTION (conversationStarter/
// suggestedOpener) on their existing, already-trusted fields.
//
// Tests real, exported production functions -- no vm/line-range extraction
// needed, since normalizeCommercialIntelligence()/validateOpportunity()/
// eventFingerprint() (signal-intelligence.js) and makeSignal()
// (research-batch.js) were already exported, and makeAISignal()
// (research-account.js) gained a new named export solely for this purpose,
// mirroring research-batch.js's own existing pattern for makeSignal().
//
// Usage: node scripts/test-commercial-opportunity-intelligence.js
import {
  normalizeCommercialIntelligence,
  validateOpportunity,
  normalizeOpportunity,
  eventFingerprint,
  isGenericActivationIdea,
  EXPANSION_POTENTIAL_TAGS
} from '../api/signal-intelligence.js';
import { makeSignal } from '../api/research-batch.js';
import { makeAISignal } from '../api/research-account.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

for (const fn of [normalizeCommercialIntelligence, validateOpportunity, normalizeOpportunity, eventFingerprint, isGenericActivationIdea, makeSignal, makeAISignal]) {
  assert(typeof fn === 'function', `extraction/import produced a real function (${fn && fn.name})`);
}

// ===========================================================================
// normalizeCommercialIntelligence(): the shared reconciler both endpoints
// funnel their raw LLM output through.
// ===========================================================================

// Absence is a valid, expected outcome -- never manufactured.
{
  const result = normalizeCommercialIntelligence({});
  assert(result.commercialPlay === null, 'no commercialPlay in raw input -> null, never fabricated');
  assert(Array.isArray(result.activationIdeas) && result.activationIdeas.length === 0, 'no activationIdeas in raw input -> empty array, never fabricated');
  assert(result.expansionPotential === null, 'no expansionPotential in raw input -> null, never fabricated');
}

// A real, well-formed commercial play (camelCase -- research-account.js's convention).
{
  const result = normalizeCommercialIntelligence({
    commercialPlay: { concept: '50 Summers', narrative: 'Use the 50th anniversary to build a limited collection celebrating 50 summers of backyard memories.' },
    activationIdeas: ['Premium pool/beach towels', 'Installer/team workwear', 'Heritage hats'],
    expansionPotential: { narrative: 'Field apparel and seasonal hiring needs could recur beyond this one order.', tags: ['recurring-program', 'seasonal-repeat'] }
  });
  assert(result.commercialPlay && result.commercialPlay.concept === '50 Summers', 'a genuine concept is preserved (camelCase input)');
  assert(result.commercialPlay.narrative.includes('50 summers'), 'the narrative is preserved');
  assert(result.activationIdeas.length === 3 && result.activationIdeas[0] === 'Premium pool/beach towels', 'specific activation ideas are preserved in order');
  assert(result.expansionPotential && result.expansionPotential.tags.length === 2, 'expansion tags are preserved');
}

// Same shape, snake_case (research-batch.js's dual-cased convention) --
// proves the reconciliation happens in ONE shared place, not per-endpoint.
{
  const result = normalizeCommercialIntelligence({
    commercial_play: { concept: 'Ribbon & Roots', narrative: 'A ribbon-cutting is a natural moment for opening-day branded gear.' },
    activation_ideas: ['Opening-day tote bags', 'Ribbon-cutting signage'],
    expansion_potential: { narrative: 'A new location often means a second round of onboarding needs.', tags: ['account-expansion'] }
  });
  assert(result.commercialPlay && result.commercialPlay.concept === 'Ribbon & Roots', 'snake_case commercial_play is reconciled to the same camelCase shape');
  assert(result.activationIdeas.length === 2, 'snake_case activation_ideas is reconciled');
  assert(result.expansionPotential && result.expansionPotential.tags[0] === 'account-expansion', 'snake_case expansion_potential is reconciled');
}

// commercialPlay.concept is genuinely optional.
{
  const result = normalizeCommercialIntelligence({ commercialPlay: { narrative: 'A narrative with no concept name at all.' } });
  assert(result.commercialPlay && !('concept' in result.commercialPlay), 'commercialPlay.concept is omitted, not forced to an empty string, when the model provides none');
}

// An empty/whitespace narrative means "no real play," not "an empty play object."
{
  const result = normalizeCommercialIntelligence({ commercialPlay: { concept: 'Cute Name', narrative: '   ' } });
  assert(result.commercialPlay === null, 'a commercialPlay with no real narrative text normalizes to null, not an empty-but-present object');
}

// Generic filler activation ideas are removed; specific ones survive.
{
  const result = normalizeCommercialIntelligence({ activationIdeas: ['Apparel', 'Drinkware', 'Giveaways', 'Premium pool/beach towels', '', 'promotional products'] });
  assert(result.activationIdeas.length === 1 && result.activationIdeas[0] === 'Premium pool/beach towels', `bare generic category words are filtered out, specific ideas survive (got ${JSON.stringify(result.activationIdeas)})`);
}
{
  // Founder's own example set.
  assert(isGenericActivationIdea('Apparel') === true, 'isGenericActivationIdea rejects "Apparel"');
  assert(isGenericActivationIdea('Drinkware') === true, 'isGenericActivationIdea rejects "Drinkware"');
  assert(isGenericActivationIdea('Giveaways') === true, 'isGenericActivationIdea rejects "Giveaways"');
  assert(isGenericActivationIdea('Premium pool/beach towels') === false, 'isGenericActivationIdea keeps a specific, qualified idea');
  assert(isGenericActivationIdea('Heritage hats') === false, 'isGenericActivationIdea keeps another specific idea');
}

// Activation ideas are capped at 6, even when the model returns more.
{
  const manyIdeas = Array.from({ length: 10 }, (_, i) => `Specific idea number ${i}`);
  const result = normalizeCommercialIntelligence({ activationIdeas: manyIdeas });
  assert(result.activationIdeas.length === 6, `activation ideas are capped at 6 (got ${result.activationIdeas.length})`);
}

// Two strong ideas beat padding to a target count -- normalization never adds.
{
  const result = normalizeCommercialIntelligence({ activationIdeas: ['Premium pool/beach towels', 'Installer/team workwear'] });
  assert(result.activationIdeas.length === 2, 'exactly as many ideas as the model gave survive -- normalization never pads toward 3 or 6');
}

// Expansion tags: invalid tags are dropped, valid ones capped at 3, deduped.
{
  const result = normalizeCommercialIntelligence({
    expansionPotential: { narrative: 'Real commercial upside text.', tags: ['recurring-program', 'not-a-real-tag', 'seasonal-repeat', 'account-expansion', 'employee-program', 'recurring-program'] }
  });
  assert(result.expansionPotential.tags.length === 3, `expansion tags are capped at 3, deduped (got ${JSON.stringify(result.expansionPotential.tags)})`);
  assert(!result.expansionPotential.tags.includes('not-a-real-tag'), 'an invalid tag outside the fixed vocabulary is dropped');
  assert([...result.expansionPotential.tags].every(t => EXPANSION_POTENTIAL_TAGS.has(t)), 'every surviving tag is a real, fixed-vocabulary tag');
}

// expansionPotential with tags but no narrative still normalizes to null --
// the narrative is required, tags alone are not a valid expansionPotential.
{
  const result = normalizeCommercialIntelligence({ expansionPotential: { tags: ['recurring-program'] } });
  assert(result.expansionPotential === null, 'expansionPotential with no narrative normalizes to null even if tags are present');
}

// ===========================================================================
// makeSignal() (api/research-batch.js): the new fields flow through, and a
// real commercial play becomes the source of the legacy whyThisMatters
// compatibility fields -- one model thought, one canonical field, legacy
// alias derived from it.
// ===========================================================================
{
  const raw = {
    accountName: 'Northern Pool & Spa',
    signal_type: 'Award / Recognition',
    concrete_trigger: '50th anniversary',
    business_context: 'Founded in 1976, making 2026 the 50th anniversary.',
    commercialPlay: { concept: '50 Summers', narrative: 'Build a limited collection celebrating 50 summers of backyard memories.' },
    activationIdeas: ['Premium pool/beach towels', 'Heritage hats'],
    expansionPotential: { narrative: 'Field apparel and seasonal hiring needs could recur.', tags: ['recurring-program'] },
    source_url: 'https://example.com/northern-pool-50th',
    confidence: 90
  };
  const signal = makeSignal(raw, { name: 'Northern Pool & Spa' }, {});
  assert(signal !== null, 'sanity: a well-formed signal is not discarded');
  assert(signal.commercialPlay && signal.commercialPlay.concept === '50 Summers', 'makeSignal() carries the real commercialPlay through');
  assert(Array.isArray(signal.activationIdeas) && signal.activationIdeas.length === 2, 'makeSignal() carries activationIdeas through');
  assert(signal.expansionPotential && signal.expansionPotential.tags.includes('recurring-program'), 'makeSignal() carries expansionPotential through');
  assert(signal.whyItMattersForPromo.includes('50 summers'), `legacy whyItMattersForPromo is deterministically derived FROM commercialPlay.narrative, not a second independent model paraphrase (got "${signal.whyItMattersForPromo}")`);
  assert(signal.whyNow === signal.whyItMattersForPromo && signal.reasonToReachOut === signal.whyItMattersForPromo, 'all legacy why-aliases agree with each other and with commercialPlay.narrative');
}

// A grounded signal with NO credible commercial play is never rejected, and
// its legacy why-field still gets a real (deterministic, not model-authored)
// value -- absence of the optional layer never breaks existing consumers.
{
  const raw = {
    accountName: 'Thin Evidence Co',
    signal_type: 'Hiring',
    concrete_trigger: 'Posted two open roles',
    business_context: 'A small local business posted two job listings.',
    source_url: 'https://example.com/thin-evidence-jobs',
    confidence: 60
    // no commercialPlay / activationIdeas / expansionPotential at all
  };
  const signal = makeSignal(raw, { name: 'Thin Evidence Co' }, {});
  assert(signal !== null, 'a signal with no credible commercial play is still persisted -- the underlying factual signal is not rejected');
  assert(signal.commercialPlay === null, 'commercialPlay is null, not a fabricated play');
  assert(Array.isArray(signal.activationIdeas) && signal.activationIdeas.length === 0, 'activationIdeas is an empty array, not fabricated filler');
  assert(signal.expansionPotential === null, 'expansionPotential is null, not fabricated');
  assert(typeof signal.whyItMattersForPromo === 'string' && signal.whyItMattersForPromo.length > 0, 'the legacy whyItMattersForPromo compatibility field is still populated (via the existing deterministic template), so old consumers never see an empty required field');
}

// ===========================================================================
// makeAISignal() (api/research-account.js): same contract.
// ===========================================================================
{
  const aiSignal = {
    signalType: 'Award / Recognition',
    signalTitle: '50th anniversary',
    whatChanged: 'Founded in 1976, making 2026 the 50th anniversary.',
    commercialPlay: { concept: '50 Summers', narrative: 'Build a limited collection celebrating 50 summers of backyard memories.' },
    activationIdeas: ['Premium pool/beach towels', 'Heritage hats'],
    expansionPotential: { narrative: 'Field apparel and seasonal hiring needs could recur.', tags: ['recurring-program'] },
    confidence: 90
  };
  const candidate = { url: 'https://example.com/northern-pool-50th', title: '50th anniversary', snippet: 'Founded in 1976.' };
  const signal = makeAISignal(aiSignal, candidate, 'Northern Pool & Spa', 'Pool & Spa', false);
  assert(signal.commercialPlay && signal.commercialPlay.concept === '50 Summers', 'makeAISignal() carries the real commercialPlay through');
  assert(signal.activationIdeas.length === 2, 'makeAISignal() carries activationIdeas through');
  assert(signal.expansionPotential && signal.expansionPotential.tags.includes('recurring-program'), 'makeAISignal() carries expansionPotential through');
  assert(signal.whyNow.includes('50 summers'), `legacy whyNow/reasonToReachOut is deterministically derived FROM commercialPlay.narrative here too (got "${signal.whyNow}")`);
}
{
  const aiSignal = { signalType: 'Hiring', signalTitle: 'Posted two open roles', whatChanged: 'A small local business posted two job listings.', confidence: 60 };
  const candidate = { url: 'https://example.com/thin-evidence-jobs', title: 'Posted two open roles', snippet: 'Two open roles.' };
  const signal = makeAISignal(aiSignal, candidate, 'Thin Evidence Co', 'Unknown', false);
  assert(signal.commercialPlay === null, 'makeAISignal(): commercialPlay is null, not fabricated, when the model provides none');
  assert(Array.isArray(signal.activationIdeas) && signal.activationIdeas.length === 0, 'makeAISignal(): activationIdeas is empty, not fabricated');
  assert(signal.expansionPotential === null, 'makeAISignal(): expansionPotential is null, not fabricated');
  assert(typeof signal.whyNow === 'string' && signal.whyNow.length > 0, 'makeAISignal(): the legacy whyNow field is still populated via its own existing fallback chain');
}

// ===========================================================================
// Required proof: both endpoint families normalize to the SAME
// commercial-intelligence shape (same field names, same value shapes) even
// though their raw prompt casing conventions differ.
// ===========================================================================
{
  const batchSignal = makeSignal({
    accountName: 'Shape Co', signal_type: 'Expansion', concrete_trigger: 'New facility',
    business_context: 'Opened a new facility.', source_url: 'https://example.com/shape-co',
    commercial_play: { concept: 'Grand Open', narrative: 'A facility opening is a natural moment for opening-day branded gear.' },
    activation_ideas: ['Opening-day gift bags'],
    expansion_potential: { narrative: 'A new facility often needs a second onboarding wave.', tags: ['account-expansion'] },
    confidence: 85
  }, { name: 'Shape Co' }, {});
  const accountSignal = makeAISignal({
    signalType: 'Expansion', signalTitle: 'New facility', whatChanged: 'Opened a new facility.',
    commercialPlay: { concept: 'Grand Open', narrative: 'A facility opening is a natural moment for opening-day branded gear.' },
    activationIdeas: ['Opening-day gift bags'],
    expansionPotential: { narrative: 'A new facility often needs a second onboarding wave.', tags: ['account-expansion'] },
    confidence: 85
  }, { url: 'https://example.com/shape-co-2', title: 'New facility', snippet: 'Opened.' }, 'Shape Co', 'Manufacturing', false);

  assert(JSON.stringify(Object.keys(batchSignal.commercialPlay).sort()) === JSON.stringify(Object.keys(accountSignal.commercialPlay).sort()), 'both endpoints\' commercialPlay objects have identical key shapes');
  assert(batchSignal.commercialPlay.concept === accountSignal.commercialPlay.concept && batchSignal.commercialPlay.narrative === accountSignal.commercialPlay.narrative, 'both endpoints normalize equivalent raw input to the identical commercialPlay content');
  assert(Array.isArray(batchSignal.activationIdeas) && Array.isArray(accountSignal.activationIdeas) && batchSignal.activationIdeas.join('|') === accountSignal.activationIdeas.join('|'), 'both endpoints produce identical activationIdeas arrays from equivalent input');
  assert(JSON.stringify(Object.keys(batchSignal.expansionPotential).sort()) === JSON.stringify(Object.keys(accountSignal.expansionPotential).sort()), 'both endpoints\' expansionPotential objects have identical key shapes');
  assert(JSON.stringify(batchSignal.expansionPotential.tags) === JSON.stringify(accountSignal.expansionPotential.tags), 'both endpoints produce identical expansionPotential tags from equivalent input');
}

// ===========================================================================
// validateOpportunity(): commercialPlay is never required; a malformed
// commercialPlay-without-a-narrative is caught defensively.
// ===========================================================================
{
  const base = { companyName: 'Acme', headline: 'Something happened', sourceUrl: 'https://example.com/x', signalFamily: 'growth', whyThisMatters: 'A real reason.' };
  const withNoPlay = validateOpportunity({ ...base, commercialPlay: null });
  assert(withNoPlay.valid === true, 'an otherwise-valid opportunity with commercialPlay: null still validates -- absence of the optional layer is never a validation failure');
  const withRealPlay = validateOpportunity({ ...base, commercialPlay: { narrative: 'The real play.' } });
  assert(withRealPlay.valid === true, 'an opportunity with a real commercialPlay validates');
  const withMalformedPlay = validateOpportunity({ ...base, commercialPlay: { concept: 'Oops' } });
  assert(withMalformedPlay.valid === false && withMalformedPlay.reasons.includes('commercialPlay present without a narrative'), 'a malformed commercialPlay object (present but no narrative) is caught defensively');
}

// ===========================================================================
// Evidence vs. interpretation boundary: commercialPlay/activationIdeas/
// expansionPotential must never affect the event fingerprint/dedup identity.
// ===========================================================================
{
  const evidenceOnly = { companyName: 'Fingerprint Co', title: 'New facility opening', snippet: 'Opened a new facility in Springfield.', eventDate: '2026-05-01' };
  const fpBase = eventFingerprint(evidenceOnly);
  const withCommercialPlay = eventFingerprint({ ...evidenceOnly, commercialPlay: { concept: 'Totally Different Concept Name', narrative: 'A completely different narrative that mentions unrelated products and programs.' } });
  const withActivationIdeas = eventFingerprint({ ...evidenceOnly, activationIdeas: ['Some product', 'Another product', 'A third product'] });
  const withExpansionPotential = eventFingerprint({ ...evidenceOnly, expansionPotential: { narrative: 'A totally different expansion narrative.', tags: ['parent-org-route'] } });
  assert(fpBase === withCommercialPlay, 'adding a commercialPlay (even with very different text) does not change the event fingerprint');
  assert(fpBase === withActivationIdeas, 'adding activationIdeas does not change the event fingerprint');
  assert(fpBase === withExpansionPotential, 'adding expansionPotential does not change the event fingerprint');

  // normalizeOpportunity() also must not let the interpretive fields leak
  // into the fingerprint it computes when none is already supplied.
  const normalized = normalizeOpportunity({ signalTitle: 'New facility opening', whatChanged: 'Opened a new facility in Springfield.', commercialPlay: { narrative: 'Totally unrelated commercial narrative text.' }, activationIdeas: ['X', 'Y'] }, { name: 'Fingerprint Co' }, {});
  const normalizedWithoutInterpretation = normalizeOpportunity({ signalTitle: 'New facility opening', whatChanged: 'Opened a new facility in Springfield.' }, { name: 'Fingerprint Co' }, {});
  assert(normalized.eventFingerprint === normalizedWithoutInterpretation.eventFingerprint, 'normalizeOpportunity() computes the identical eventFingerprint whether or not commercialPlay/activationIdeas are present');
  assert(normalized.commercialPlay && normalized.commercialPlay.narrative === 'Totally unrelated commercial narrative text.', 'normalizeOpportunity() still passes the new fields through unchanged (via its existing {...raw} spread)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
