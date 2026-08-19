// Repeat/Pattern copy truthfulness correction (founder decision, 2026-08-19,
// Warner Bros. Discovery real-account trace). Extracts the REAL, verbatim
// source of getRepFriendlyWhy()/buyingConversationLabel() plus their real
// dependencies via the shared semantic extractor and runs them in a vm
// sandbox -- same established pattern as scripts/test-active-expansion-plays.js.
//
// Bug proved on real production data: a Repeat/Pattern opportunity's
// visible "why now" copy and title were derived by keyword-matching
// commonPromoCategories/suggestedProducts (a cross-sell PRODUCT SUGGESTION
// list) and buyingCategory (a cosmetic classification field) -- NOT the
// real opp.category the repeat pattern was actually detected in. Warner
// Bros. Discovery's real qualifying repeat categories were Event / Giveaway
// and Print / Stationery; Apparel never qualified at all; yet the visible
// copy said "Past apparel buying suggests..." because the cross-sell
// suggestion list for that pattern happened to include the word "apparel."
//
// Correction: for a Repeat/Pattern Signal opportunity, when opp.category is
// a real whitespace-taxonomy category, use it directly -- both in the "why"
// text (getRepFriendlyWhy) and in the visible title (buyingConversationLabel).
// The old keyword-matching logic remains only as a fallback for legacy
// opportunities persisted before opp.category existed on this signal layer.
//
// Usage: node scripts/test-repeat-pattern-category-truthfulness.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

const SRC = [
  extractFn(DASHBOARD_SRC, 'WHITESPACE_CATEGORIES'),
  extractFn(DASHBOARD_SRC, 'shortText'),
  extractFn(DASHBOARD_SRC, 'departmentFromText'),
  extractFn(DASHBOARD_SRC, 'primaryCategoryFromOpportunity'),
  extractFn(DASHBOARD_SRC, 'likelyDepartmentFromOpportunity'),
  extractFn(DASHBOARD_SRC, 'isGenericContactLabel'),
  extractFn(DASHBOARD_SRC, 'likelyKnownBuyer'),
  extractFn(DASHBOARD_SRC, 'likelySuggestedContact'),
  extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
  extractFn(DASHBOARD_SRC, 'signalLayerLabel'),
  extractFn(DASHBOARD_SRC, 'getRepFriendlyWhy'),
  extractFn(DASHBOARD_SRC, 'buyingConversationLabel'),
  // Stub: getRecommendationType() has its own large, unrelated dependency
  // graph (evidence-text classification across every opportunity type).
  // None of the fixtures below are Relationship Expansion opportunities, so
  // a fixed non-matching return is sufficient and keeps this file scoped to
  // Repeat/Pattern copy truthfulness only.
  'function getRecommendationType(opp){ return "Repeat Opportunity"; }'
].join('\n\n');

const EXPORT_NAMES = ['WHITESPACE_CATEGORIES', 'getRepFriendlyWhy', 'buyingConversationLabel', 'signalLayerLabel'];

function makeSandbox(){
  const sandbox = { console };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'repeat-pattern-category-truthfulness-extract.js' }).runInContext(sandbox);
  return sandbox.__exports;
}

const dash = makeSandbox();

// ===========================================================================
// Fixture modeled directly on the real Warner Bros. Discovery production
// case: a real Print / Stationery repeat pattern whose cross-sell
// suggestion list and cosmetic buyingCategory both point at unrelated
// categories that happen to contain the word "apparel" / a different
// taxonomy category entirely.
// ===========================================================================
const warnerStyleOpp = {
  signalLayerType: 'Repeat / Pattern Signal',
  category: 'Print / Stationery',
  buyingCategory: 'Recognition / Awards',
  commonPromoCategories: ['staff apparel', 'booth giveaways', 'recognition gifts'],
  suggestedProducts: ['apparel bundle', 'event kits'],
  opportunity: 'Repeat buying pattern detected',
  contactTitle: 'HR Manager'
};

{
  const why = dash.getRepFriendlyWhy(warnerStyleOpp);
  assert(/print \/ stationery/i.test(why), `getRepFriendlyWhy() names the REAL repeat category (Print / Stationery), got: "${why}"`);
  assert(!/apparel/i.test(why), `getRepFriendlyWhy() does not name the unrelated cross-sell-suggested category "apparel", got: "${why}"`);
}

{
  const label = dash.buyingConversationLabel(warnerStyleOpp);
  assert(label.includes('Print / Stationery'), `buyingConversationLabel() title shows the REAL repeat category (Print / Stationery), got: "${label}"`);
  assert(!label.includes('Recognition / Awards'), `buyingConversationLabel() title does not show the unrelated cosmetic buyingCategory "Recognition / Awards", got: "${label}"`);
}

// ===========================================================================
// A second real category from the same Warner Bros. Discovery trace:
// Event / Giveaway, to prove this is not narrowly special-cased to one
// category string.
// ===========================================================================
const eventGiveawayOpp = {
  signalLayerType: 'Repeat / Pattern Signal',
  category: 'Event / Giveaway',
  buyingCategory: 'Onboarding / Recruiting',
  commonPromoCategories: ['staff apparel'],
  opportunity: 'Repeat buying pattern detected'
};

{
  const why = dash.getRepFriendlyWhy(eventGiveawayOpp);
  assert(/event \/ giveaway/i.test(why), `getRepFriendlyWhy() names the REAL repeat category (Event / Giveaway), got: "${why}"`);

  const label = dash.buyingConversationLabel(eventGiveawayOpp);
  assert(label.includes('Event / Giveaway'), `buyingConversationLabel() title shows the REAL repeat category (Event / Giveaway), got: "${label}"`);
}

// ===========================================================================
// Legacy-data fallback: an opportunity persisted before opp.category
// existed on this signal layer (no category field, or a category outside
// the whitespace taxonomy) must still fall back to the OLD keyword-matching
// behavior rather than throwing or producing empty copy.
// ===========================================================================
const legacyApparelOpp = {
  signalLayerType: 'Repeat / Pattern Signal',
  commonPromoCategories: ['staff apparel', 'polos'],
  opportunity: 'Repeat buying pattern detected'
};

{
  const why = dash.getRepFriendlyWhy(legacyApparelOpp);
  assert(/apparel/i.test(why), `getRepFriendlyWhy() falls back to keyword-matching when opp.category is absent (legacy data), got: "${why}"`);
}

{
  const label = dash.buyingConversationLabel(legacyApparelOpp);
  assert(!/undefined|null/i.test(label), `buyingConversationLabel() falls back cleanly (no undefined/null) when opp.category is absent, got: "${label}"`);
}

// ===========================================================================
// A non-whitespace-taxonomy category value on opp.category (defensive:
// should not be trusted blindly -- only a real WHITESPACE_CATEGORIES member
// is used directly, everything else still falls back).
// ===========================================================================
const bogusCategoryOpp = {
  signalLayerType: 'Repeat / Pattern Signal',
  category: 'Not A Real Taxonomy Category',
  commonPromoCategories: ['staff apparel'],
  opportunity: 'Repeat buying pattern detected'
};

{
  const why = dash.getRepFriendlyWhy(bogusCategoryOpp);
  assert(!/not a real taxonomy category/i.test(why), `getRepFriendlyWhy() ignores an opp.category value outside WHITESPACE_CATEGORIES, got: "${why}"`);
  assert(/apparel/i.test(why), `getRepFriendlyWhy() falls back to keyword-matching when opp.category is not a real taxonomy category, got: "${why}"`);
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
