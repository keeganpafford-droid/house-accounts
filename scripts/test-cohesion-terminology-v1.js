// Product Cohesion Round 3 -- smallest simplification slice, deterministic
// coverage for the one change not already proven end-to-end by
// scripts/test-cohesion-navigation-live.js: recommendationBadgeMeta()'s
// "Relationship Expansion" -> "Category Expansion" display-label rename.
//
// Doctrine under test: this is a DISPLAY LABEL rename only. The map KEY
// (the internal classification identity getRecommendationType() and
// isRelationshipExpansionOpportunity() etc. match against) is completely
// unchanged, so an opportunity's real classification, its CSS slug, and
// every downstream piece of logic keyed off "Relationship Expansion" stay
// exactly as they were -- only the string a rep actually reads changed.
// getRecommendationType() itself is stubbed here (returns the type
// directly) since its own classification logic is untouched by this round
// and is covered by its own, pre-existing tests -- this file's only job is
// proving the map's label/type separation.
//
// Usage: node scripts/test-cohesion-terminology-v1.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

const SRC = [
  extractFn(DASHBOARD_SRC, 'recommendationSlug'),
  extractFn(DASHBOARD_SRC, 'recommendationBadgeMeta')
].join('\n\n');

const EXPORT_NAMES = ['recommendationBadgeMeta', 'recommendationSlug'];

function makeSandbox(stubType){
  const sandbox = {
    console,
    getRecommendationType: () => stubType
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'cohesion-terminology-extract.js' }).runInContext(sandbox);
  return sandbox.__exports;
}

// ===========================================================================
// 1) "Relationship Expansion" (the internal classification identity) now
//    displays as "Category Expansion" -- the rename the founder approved,
//    removing the collision with "Relationship" (now reserved exclusively
//    for Buying Center access/footprint).
// ===========================================================================
{
  const dash = makeSandbox('Relationship Expansion');
  const meta = dash.recommendationBadgeMeta({});
  assert(meta.label === 'Category Expansion', `1) REQUIRED: the user-facing label reads "Category Expansion" (got "${meta.label}")`);
  assert(meta.label !== 'Relationship Expansion', '1) REQUIRED: the old "Relationship Expansion" label no longer reaches a rep');
}

// ===========================================================================
// 2) The rename is presentation-only: the classification identity itself
//    (meta.type, and the CSS slug derived from it) is completely
//    unchanged, so nothing that keys off "Relationship Expansion"
//    internally -- filtering, styling, analytics, the pre-existing Slice 3
//    backlog question about this opportunity type's evidence bar -- is
//    affected by this round.
// ===========================================================================
{
  const dash = makeSandbox('Relationship Expansion');
  const meta = dash.recommendationBadgeMeta({});
  assert(meta.type === 'Relationship Expansion', `2) REQUIRED: the internal classification identity (meta.type) is untouched (got "${meta.type}")`);
  assert(meta.cls === dash.recommendationSlug('Relationship Expansion'), '2) REQUIRED: the CSS slug is still derived from the real internal type, not the renamed display label');
  assert(meta.cls === 'relationship-expansion', `2) sanity: the slug itself is also unchanged (got "${meta.cls}")`);
}

// ===========================================================================
// 3) Every other badge type in the map is untouched by this round -- the
//    rename is scoped to exactly one entry.
// ===========================================================================
{
  const dash = makeSandbox('Reorder Due');
  assert(dash.recommendationBadgeMeta({}).label === 'Reorder Due', '3) sanity: an unrelated badge type is unaffected');
  const dash2 = makeSandbox('Business Trigger');
  assert(dash2.recommendationBadgeMeta({}).label === 'Business Trigger', '3) sanity: Business Trigger (Signal-driven) keeps its own distinct label, never conflated with Category Expansion or Reason To Reach Out');
}

// ===========================================================================
// 4) "Reason To Reach Out" -- the umbrella fallback label -- is itself
//    untouched, so the terminology decision's core distinction (Signal /
//    Reason to Reach Out / Priority stay separate, related concepts) holds
//    at the badge-vocabulary level too.
// ===========================================================================
{
  const dash = makeSandbox('Reason To Reach Out');
  assert(dash.recommendationBadgeMeta({}).label === 'Reason To Reach Out', '4) sanity: the umbrella "Reason To Reach Out" label is unchanged by this round');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
