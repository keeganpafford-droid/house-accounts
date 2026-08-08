// product/commercial-opportunity-intelligence -- QA correction 1:
// semantic-consistency fix between "new-schema, no credible commercial
// play" and legacy why-this-matters compatibility.
//
// Root cause this file proves is fixed: normalizeCommercialIntelligence()
// correctly leaves commercialPlay/activationIdeas/expansionPotential
// null/empty when the model declines to produce a play, but the legacy
// compatibility fields (whyThisMatters/whyItMattersForPromo/reasonToReachOut)
// are STILL populated with generic, category-template text (via the
// existing, unchanged salesReadyWhy()/buildSignalIntelligence() deterministic
// fallback) -- required so validateOpportunity() and other legacy
// consumers never see an empty field. The primary card and Prepare for
// Call (dashboard/index.html) already read the new fields directly and
// correctly hide the Opportunity section (proven in
// scripts/test-commercial-intelligence-card-ux.js). The ONE confirmed leak
// was api/weekly-scan.js's whyItMatters(), which read signal.why_reach_out
// (the persisted column carrying that same generic fallback text)
// unconditionally -- silently resurrecting a "reason to reach out" the
// model explicitly declined to produce. Fixed via the shared
// isCommercialIntelligenceSignal() predicate (api/signal-intelligence.js).
//
// Usage: node scripts/test-commercial-intelligence-no-play-consistency.js
import { makeSignal } from '../api/research-batch.js';
import { makeAISignal } from '../api/research-account.js';
import { normalizeOpportunity, validateOpportunity, isCommercialIntelligenceSignal } from '../api/signal-intelligence.js';
import { opportunityCardHtml } from '../api/weekly-scan.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

for (const fn of [isCommercialIntelligenceSignal, opportunityCardHtml, makeSignal, makeAISignal]) {
  assert(typeof fn === 'function', `import produced a real function (${fn && fn.name})`);
}

// A realistic raw signal where the model legitimately found real, sourced
// evidence but declined to propose a commercial play -- exactly the
// scenario this QA correction is about (thin-but-real hiring evidence, no
// concrete play, no specific activation ideas).
const NO_PLAY_RAW = {
  accountName: 'Thin Evidence Co',
  signal_type: 'Hiring',
  concrete_trigger: 'Hiring Warehouse Associates',
  whatChanged: 'Thin Evidence Co posted three warehouse associate job listings on its careers page this week.',
  business_context: 'The company appears to be growing its warehouse team ahead of the holiday season.',
  source_url: 'https://example.com/thin-evidence-jobs',
  sources: [{ name: 'Example Careers', url: 'https://example.com/thin-evidence-jobs' }],
  confidence: 60
  // no commercialPlay / activationIdeas / expansionPotential
};

// ===========================================================================
// 1. Exact current no-play behavior across downstream surfaces (research-
//    batch.js path).
// ===========================================================================
{
  const sig = makeSignal(NO_PLAY_RAW, { name: 'Thin Evidence Co' }, {});
  assert(sig.commercialPlay === null, '1) makeSignal(): commercialPlay is null when the model provides none');
  assert(Array.isArray(sig.activationIdeas) && sig.activationIdeas.length === 0, '1) makeSignal(): activationIdeas is an empty array');
  assert(sig.expansionPotential === null, '1) makeSignal(): expansionPotential is null');
  assert(typeof sig.whyItMattersForPromo === 'string' && sig.whyItMattersForPromo.length > 0, '1) makeSignal(): the legacy whyItMattersForPromo compatibility field is still populated (required for old consumers/validateOpportunity())');
  assert(sig.whyItMattersForPromo === sig.reasonToReachOut && sig.reasonToReachOut === sig.whyNow, '1) makeSignal(): whyItMattersForPromo/reasonToReachOut/whyNow all agree (same deterministic fallback text)');

  const candidate = { url: 'https://example.com/thin-evidence-jobs', title: 'Careers', snippet: 'Hiring warehouse associates' };
  const normalized = normalizeOpportunity(sig, { name: 'Thin Evidence Co' }, candidate);
  assert(normalized.whyThisMatters === sig.whyItMattersForPromo, '1) normalizeOpportunity(): whyThisMatters carries the same deterministic legacy text through');
  assert(normalized.commercialPlay === null && normalized.activationIdeas.length === 0 && normalized.expansionPotential === null, '1) normalizeOpportunity(): the new fields remain null/empty after normalization');

  const validation = validateOpportunity(normalized);
  assert(validation.valid === true, `1) validateOpportunity(): a no-play new-schema signal still validates (commercialPlay is never required) -- reasons: ${JSON.stringify(validation.reasons)}`);
}

// ===========================================================================
// 2. isCommercialIntelligenceSignal(): the shared new-schema marker used to
//    decide whether legacy why-fields are trustworthy.
// ===========================================================================
{
  assert(isCommercialIntelligenceSignal({ activationIdeas: [] }) === true, '2) a signal with activationIdeas: [] (even empty) is recognized as new-schema');
  assert(isCommercialIntelligenceSignal({ commercialPlay: { narrative: 'x' } }) === true, '2) a signal with a real commercialPlay is recognized as new-schema');
  assert(isCommercialIntelligenceSignal({}) === false, '2) a signal with none of the three keys at all is recognized as old-schema (predates this feature)');
  assert(isCommercialIntelligenceSignal({ whyThisMatters: 'legacy text only' }) === false, '2) a signal carrying only legacy why-fields, no new-schema keys, is old-schema');
}

// ===========================================================================
// 3/6. Weekly digest (api/weekly-scan.js, via the real exported
// opportunityCardHtml()): a new-schema, no-play signal must NOT show the
// generic deterministic fallback text as "why it matters" -- that would be
// exactly the resurrected recommendation this correction prohibits.
// ===========================================================================
{
  const genericFallbackText = 'Facility launches usually create needs around employee apparel, onboarding materials, safety items, local PR giveaways, and opening-day gifts. HR / People is the most likely owner of a need like this.';
  const noPlaySignal = {
    account_name: 'Thin Evidence Co',
    signal_type: 'Hiring',
    title: 'Thin Evidence Co Business Update',
    why_reach_out: genericFallbackText, // exactly what api/save-upload.js persists from whyItMattersForPromo
    payload: {
      signalTitle: 'Hiring Warehouse Associates',
      whyItMattersForPromo: genericFallbackText,
      whyItMatters: genericFallbackText,
      activationIdeas: [], // new-schema marker: normalizeCommercialIntelligence() ran
      commercialPlay: null,
      expansionPotential: null,
      suggestedOpener: 'Is warehouse staffing centralized, or does each location handle its own hiring?'
    }
  };
  const html = opportunityCardHtml(noPlaySignal);
  assert(!html.includes('employee apparel, onboarding materials'), '3/6) the weekly digest does NOT surface the generic deterministic fallback text as "why it matters" for a new-schema signal with no credible play');
  assert(html.includes('Hiring Warehouse Associates'), '3/6) the digest instead shows a purely factual line (the signal title) for a no-play new-schema signal');
}

// ===========================================================================
// Old-signal regression: a signal predating this feature (no new-schema
// keys at all) must continue using the full legacy fallback chain
// unchanged -- this correction must not make old digests worse.
// ===========================================================================
{
  const legacyWhy = 'Recognition moments create a natural reason to discuss employee gifts and customer appreciation.';
  const oldSignal = {
    account_name: 'Legacy Co',
    signal_type: 'Award / Recognition',
    title: 'Legacy Co Anniversary',
    why_reach_out: legacyWhy,
    payload: { signalTitle: 'Legacy Co Anniversary', whyItMattersForPromo: legacyWhy, suggestedOpener: 'Is this still an active program?' }
    // no activationIdeas/commercialPlay/expansionPotential keys at all
  };
  const html = opportunityCardHtml(oldSignal);
  assert(html.includes(legacyWhy), 'old-signal regression: an old signal (no new-schema keys) still shows its legacy why_reach_out text in the digest, exactly as before this correction');
}

// ===========================================================================
// New-schema WITH a real play: the digest must prefer the richer
// commercialPlay.narrative directly, not the legacy field it was derived
// from -- "continue feeding richer downstream copy."
// ===========================================================================
{
  const realPlaySignal = {
    account_name: 'Northern Pool & Spa',
    signal_type: 'Award / Recognition',
    title: 'Northern Pool & Spa 50th Anniversary',
    why_reach_out: 'Recognition moments create a natural reason to discuss employee gifts.', // the legacy-derived value, less rich
    payload: {
      signalTitle: 'Northern Pool & Spa 50th Anniversary',
      commercialPlay: { concept: '50 Summers', narrative: 'Build a limited collection celebrating 50 summers of backyard memories.' },
      activationIdeas: ['Premium pool/beach towels'],
      expansionPotential: { narrative: 'Recurring field apparel and a possible Azureon route.', tags: ['recurring-program'] },
      suggestedOpener: 'Are merchandise and employee gear still handled here, or has any of that moved to Azureon?'
    }
  };
  const html = opportunityCardHtml(realPlaySignal);
  assert(html.includes('50 summers of backyard memories'), 'new-schema-with-real-play: the digest prefers the real commercialPlay.narrative directly, richer than the legacy-derived why_reach_out value it was itself built from');
}

// ===========================================================================
// 4/5. Primary card / Prepare for Call already handle this correctly
// (verified in scripts/test-commercial-intelligence-card-ux.js's "absence
// is honored" and "old-signal backward compatibility" blocks) -- this file
// does not duplicate that dashboard-side coverage, only confirms no
// server-side regression was introduced by touching weekly-scan.js.
// ===========================================================================

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
