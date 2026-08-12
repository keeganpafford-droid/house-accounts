// Final bounded Beta correction (seller-copy classification-drift fix):
// proves salesReadyWhy()/salesReadyOpener()/contextToOpener()/
// promoCategoriesForMoment()/inferRecommendedBuyingTeam() now select their
// SPECIFIC seller-facing claim (facility expansion, hiring, award, launch,
// etc.) ONLY from the already-computed canonical eventType/signal-family
// label -- never independently re-derived from loose free-text keyword
// matching against trigger/context text.
//
// Reproduced production case (BerryDunn QA): a thought-leadership /
// practice-area spotlight article ("Trailblazers in Veterinary Accounting
// and Consulting") used the word "expanding" to describe a PRACTICE AREA,
// never a physical facility -- the canonical classifier correctly declines
// to call this a facility/location event (falls to the generic 'Business
// Activity' label), but the OLD deterministic fallback templates
// independently re-scanned the free text with a much looser regex and
// rendered "Facility launches usually create needs around... opening-day
// gifts" -- a specific claim the evidence never supported.
//
// Fictional archetype below (never the real BerryDunn text) proves the fix
// at the actual function boundary. Companion cases prove the preserved
// "good controls" the founder named (HQ relocation, hiring, opening) still
// render their correct specific copy.
//
// Usage: node scripts/test-seller-copy-canonical-classification-correction.js
import { salesReadyWhy, salesReadyOpener, canonicalTemplateFamily, promoCategoriesForMoment, inferRecommendedBuyingTeam } from '../api/research-batch.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// The bug itself: thought-leadership/practice-area content mentioning
// "expanding"/"locations" must never render facility/location seller copy
// when the canonical event type does not itself support that family.
// ===========================================================================
{
  // Fictional BerryDunn-shaped archetype: a professional-services practice-
  // area spotlight article. The canonical classifier (resolveEventType() /
  // classifySignalFamily(), exercised earlier in the real pipeline) would
  // find no facility-specific phrase here (no "new facility"/"new office"/
  // "relocat"/"ribbon cutting"/etc.) and fall to the generic 'Business
  // Activity' label -- exactly the type value passed here.
  const trigger = 'Trailblazers in Specialty Veterinary Accounting and Consulting';
  const context = 'The firm highlights its growing specialty practice, expanding its veterinary accounting and consulting expertise to serve clients in every location nationwide.';
  const type = 'Business Activity';
  assert(canonicalTemplateFamily(type) === null, 'sanity: the generic "Business Activity" canonical label maps to no specific template family');
  const why = salesReadyWhy(trigger, context, '', type, { accountName: 'Meridian Advisory Group' });
  assert(!/Facility launches usually create/i.test(why), `REQUIRED -- a thought-leadership piece that merely mentions "expanding"/"location" must not render facility/location seller copy when the canonical type does not support it (got: "${why}")`);
  const opener = salesReadyOpener(trigger, context, '', type, { accountName: 'Meridian Advisory Group', actionability: { status: 'unknown-date' } });
  assert(!/expansion activity|site launches/i.test(opener), `REQUIRED -- the opener template must not manufacture a facility/expansion claim either (got: "${opener}")`);
  const categories = promoCategoriesForMoment('', type, context);
  assert(!(categories.includes('Safety Items') && categories.includes('Opening-Day Gifts')), `REQUIRED -- the promo-category selector must not select the facility-specific bucket either (got: ${JSON.stringify(categories)})`);
  const team = inferRecommendedBuyingTeam(type, context, '', {});
  assert(!(team.includes('Operations') && team.length === 2 && team[0] === 'Operations'), `REQUIRED -- the buying-team selector must not select the facility-specific (Operations) bucket either (got: ${JSON.stringify(team)})`);
}

// ===========================================================================
// Preserve: good controls named by the founder must keep their correct,
// specific copy.
// ===========================================================================

// BerryDunn HQ relocation -- location/facility copy remains valid (the
// canonical type genuinely IS a location/facility event here).
{
  const why = salesReadyWhy('headquarters relocation to a new downtown office', 'The firm is relocating its headquarters to a larger downtown office to support continued growth.', '', 'New Location', { accountName: 'Meridian Advisory Group' });
  assert(/Facility launches usually create/i.test(why), `REQUIRED -- a genuine location/facility event (canonical type "New Location") still renders the facility-specific copy (got: "${why}")`);
}

// BerryDunn refreshed brand -- appropriate rebrand/generic copy (REBRAND has
// no dedicated bucket in this template family, same as before this
// correction -- falls to the topic-neutral generic fallback, never a
// mismatched specific claim).
{
  const why = salesReadyWhy('unveils refreshed brand identity and new logo', 'The firm unveiled a refreshed brand identity and new logo as part of its ongoing evolution.', '', 'Rebrand', { accountName: 'Meridian Advisory Group' });
  assert(!/Facility launches usually create|Events usually require|Hiring and onboarding create|Launches often need|Recognition moments create|Major wins can create|Community programs often need/i.test(why), `REQUIRED -- a rebrand/logo-refresh event renders topic-neutral generic copy, never a mismatched specific claim (got: "${why}")`);
}

// Eastern Propane hiring -- hiring copy.
{
  const why = salesReadyWhy('now hiring seasonal delivery drivers', 'Eastern Propane is now hiring seasonal delivery drivers ahead of the winter season.', '', 'Hiring Activity', { accountName: 'Eastern Propane' });
  assert(/Hiring and onboarding create/i.test(why), `REQUIRED -- a genuine hiring event (canonical type "Hiring Activity") still renders the hiring-specific copy (got: "${why}")`);
  const team = inferRecommendedBuyingTeam('Hiring Activity', 'now hiring seasonal delivery drivers', '', {});
  assert(team.includes('HR / People') && team.includes('Talent Acquisition'), `REQUIRED -- a genuine hiring event still selects the HR / People + Talent Acquisition buying team (got: ${JSON.stringify(team)})`);
}

// L.L.Bean grand opening -- location/opening copy.
{
  const why = salesReadyWhy('grand opening of its newest retail location', 'L.L.Bean celebrated the grand opening of its newest retail location this weekend.', '', 'New Location', { accountName: 'L.L.Bean' });
  assert(/Facility launches usually create/i.test(why), `REQUIRED -- a genuine grand-opening event (canonical type "New Location") still renders the facility-specific copy (got: "${why}")`);
}

// L.L.Bean careers -- hiring copy.
{
  const why = salesReadyWhy('posts new seasonal career openings', 'L.L.Bean posted new seasonal career openings across several departments.', '', 'Hiring Activity', { accountName: 'L.L.Bean' });
  assert(/Hiring and onboarding create/i.test(why), `REQUIRED -- a genuine careers/hiring event still renders the hiring-specific copy (got: "${why}")`);
}

// ===========================================================================
// canonicalTemplateFamily() direct coverage -- every label the real
// pipeline can actually produce (EVENT_TYPE_DISPLAY_LABELS / SIGNAL_FAMILIES
// labels in signal-intelligence.js) maps to the expected bucket (or null
// for a genuinely generic label).
// ===========================================================================
{
  const expectations = [
    ['Community Event', 'community'],
    ['Community / CSR', 'community'],
    ['Facility Expansion', 'facility'],
    ['New Location', 'facility'],
    ['Location Reopening', 'facility'],
    ['Renovation Completed', 'facility'],
    ['Location Event', 'facility'],
    ['Growth / Expansion', 'facility'],
    ['Trade Show Participation', 'events'],
    ['Conference / Summit', 'events'],
    ['Events / Marketing', 'events'],
    ['Hiring Activity', 'hiring'],
    ['Hiring / Workforce', 'hiring'],
    ['Product Launch', 'launch'],
    ['Product / Service', 'launch'],
    ['Award / Recognition', 'award'],
    ['Award / Milestone', 'award'],
    ['Partnership / Contract', 'partnership'],
    ['Acquisition', null],
    ['Leadership Change', null],
    ['Leadership / Relationship', null],
    ['Rebrand', null],
    ['Acquisition / Financial', null],
    ['Business Activity', null]
  ];
  for (const [label, expected] of expectations) {
    assert(canonicalTemplateFamily(label) === expected, `canonicalTemplateFamily('${label}') === ${JSON.stringify(expected)} (got ${JSON.stringify(canonicalTemplateFamily(label))})`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
