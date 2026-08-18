// Organizational Learning V1B, Correction 1: the browser must never
// fabricate durable opportunity identity -- the server exposes the
// authoritative, currently-active ha_account_opportunities refs on each
// account's dashboard payload, and the CLIENT's opportunity-generation
// functions only ever COPY what the server already issued. This file
// proves both halves against the REAL, verbatim source:
//   - api/get-dashboard.js's buildAccountHistoryOpportunityRefs()/
//     stampAccountHistoryOpportunityRefs()/buildAccountsFromRows() --
//     server-side grouping and stamping of stored opportunities.
//   - dashboard/index.html's createRepeatPatternOpportunities()/
//     generateFutureOpportunities() (extracted verbatim, not
//     reimplemented) -- client-side copying of account.accountHistoryOpportunityRefs
//     onto freshly-generated opportunity objects, and the honest
//     degradation (no fabricated ref) when none is available yet.
//
// Usage: node scripts/test-account-opportunity-refs-propagation.js
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';
import { buildAccountHistoryOpportunityRefs, stampAccountHistoryOpportunityRefs, buildAccountsFromRows } from '../api/get-dashboard.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------
// Server side: buildAccountHistoryOpportunityRefs() / stampAccountHistoryOpportunityRefs().
// ---------------------------------------------------------------------
{
  const rows = [
    { id: 'opp-1', account_name: 'Acme Co', opportunity_type: 'repeat_pattern', category: 'Apparel', fingerprint: 'opp:repeat_pattern:v1:acme|apparel|last:2025-03-15' },
    { id: 'opp-2', account_name: 'Acme Co', opportunity_type: 'follow_up', category: null, fingerprint: 'opp:follow_up:v1:acme|last:2025-06-01' },
    { id: 'opp-3', account_name: 'Beta Inc', opportunity_type: 'repeat_pattern', category: 'Headwear', fingerprint: 'opp:repeat_pattern:v1:beta|headwear|last:2025-01-01' }
  ];
  const refs = buildAccountHistoryOpportunityRefs(rows);
  assert(refs.get('Acme Co').repeatPattern['Apparel'].id === 'opp-1', 'REQUIRED: repeat_pattern rows group by account_name AND category');
  assert(refs.get('Acme Co').followUp.id === 'opp-2', 'REQUIRED: follow_up rows group by account_name alone');
  assert(refs.get('Beta Inc').repeatPattern['Apparel'] === undefined, 'REQUIRED: a category ref never leaks across accounts');
  assert(refs.get('Beta Inc').followUp === null, 'an account with no follow_up row gets an explicit null, not undefined');
}
{
  const refs = new Map([['Acme Co', { followUp: { id: 'opp-followup', fingerprint: 'opp:follow_up:v1:acme|last:2025-06-01' }, repeatPattern: { Apparel: { id: 'opp-apparel', fingerprint: 'opp:repeat_pattern:v1:acme|apparel|last:2025-03-15' } } }]]);
  const stored = [
    { opportunity: 'Apparel Program', opportunityType: 'REPEAT PATTERN', category: 'Apparel' },
    { opportunity: 'Employee Recognition Program', opportunityType: 'QUICK WIN' },
    { opportunity: 'Headwear Program', opportunityType: 'REPEAT PATTERN', category: 'Headwear' }
  ];
  const stamped = stampAccountHistoryOpportunityRefs(stored, refs.get('Acme Co'));
  const apparelOpp = stamped.find(o => o.category === 'Apparel');
  const genericOpp = stamped.find(o => o.opportunityType === 'QUICK WIN');
  const headwearOpp = stamped.find(o => o.category === 'Headwear');
  assert(apparelOpp.accountOpportunityId === 'opp-apparel', 'REQUIRED: a genuine REPEAT PATTERN entry is stamped with its OWN category\'s ref');
  assert(genericOpp.accountOpportunityId === 'opp-followup', 'REQUIRED: a generic (non-REPEAT-PATTERN) entry is stamped with the account\'s follow_up ref');
  assert(headwearOpp.accountOpportunityId === undefined, 'REQUIRED: a REPEAT PATTERN entry whose own category has no ref stays honestly unstamped -- it never inherits the follow_up ref or another category\'s ref');
}
{
  // No refs available at all (a brand-new account never reconciled) --
  // never fabricates an id/fingerprint.
  const stored = [{ opportunity: 'Apparel Program', opportunityType: 'REPEAT PATTERN', category: 'Apparel' }];
  const stamped = stampAccountHistoryOpportunityRefs(stored, null);
  assert(stamped[0].accountOpportunityId === undefined, 'REQUIRED: with no persisted refs yet, nothing is fabricated -- the field stays genuinely absent');
}

// ---------------------------------------------------------------------
// Server side, end to end: buildAccountsFromRows() wires refs onto the
// account object AND stamps already-stored repeatPatterns entries -- the
// actual reload path (no client-side regeneration happens here).
// ---------------------------------------------------------------------
{
  const accountRows = [{
    account_name: 'Acme Co', upload_id: 'upload-1', industry: 'Retail',
    metrics: { orderCount: 5 },
    raw_data: {
      repeatPatterns: [{ opportunity: 'Apparel Program', opportunityType: 'REPEAT PATTERN', category: 'Apparel' }]
    }
  }];
  const accountOpportunityRows = [
    { id: 'opp-apparel', account_name: 'Acme Co', opportunity_type: 'repeat_pattern', category: 'Apparel', fingerprint: 'opp:repeat_pattern:v1:acme|apparel|last:2025-03-15' }
  ];
  const { accountList } = buildAccountsFromRows(accountRows, [], accountOpportunityRows);
  const acme = accountList.find(a => a.name === 'Acme Co');
  assert(acme.accountHistoryOpportunityRefs.repeatPattern['Apparel'].id === 'opp-apparel', 'REQUIRED: the account object itself carries the authoritative refs bag');
  const pattern = acme.futureOpportunities.find(o => o.category === 'Apparel');
  assert(pattern.accountOpportunityId === 'opp-apparel', 'REQUIRED: the ALREADY-STORED repeatPatterns entry (the real reload path) is stamped with the real persisted id, server-side, before it ever reaches the client');
}
{
  // An account with no persisted opportunities yet -- refs is null, stored
  // entries are returned unstamped, nothing fabricated.
  const accountRows = [{ account_name: 'Fresh Co', upload_id: 'upload-2', industry: 'Retail', metrics: { orderCount: 1 }, raw_data: {} }];
  const { accountList } = buildAccountsFromRows(accountRows, [], []);
  const fresh = accountList.find(a => a.name === 'Fresh Co');
  assert(fresh.accountHistoryOpportunityRefs === null, 'REQUIRED: an account with no reconciled opportunities yet gets an explicit null refs bag, never a fabricated one');
}

// ---------------------------------------------------------------------
// Client side: createRepeatPatternOpportunities()/generateFutureOpportunities()
// (dashboard/index.html, extracted verbatim) copy account.accountHistoryOpportunityRefs
// onto the opportunity objects they build.
// ---------------------------------------------------------------------
const DASHBOARD_SRC = loadDashboardSource();
const SRC = [
  extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG'),
  extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(value){', 'function isRelationshipExpansionOpportunity(opp){'),
  extractFn(DASHBOARD_SRC, 'isWebResearchSignal'),
  extractRange(DASHBOARD_SRC, 'function signalLayerLabel(opp){', 'function isRecentAccountActivity(opp){'),
  extractFn(DASHBOARD_SRC, 'formatShortDate'),
  extractFn(DASHBOARD_SRC, 'parseMaybeDate'),
  extractFn(DASHBOARD_SRC, 'reorderWindowStatus'),
  extractRange(DASHBOARD_SRC, 'function isAccountHistoryOpportunity(opp){', 'function accountHistoryStatusLine(opp){'),
  extractRange(DASHBOARD_SRC, 'function estimateFutureValue(account, opportunityType){', 'function getPriorityTier(opp){'),
  extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
  extractRange(DASHBOARD_SRC, 'function daysSinceDate(value){', 'function getRecommendationType(opp){'),
  extractFn(DASHBOARD_SRC, 'currentOrgPreferences'),
  extractFn(DASHBOARD_SRC, 'ORG_PREFERENCE_FAMILY_BY_SIGNAL_LAYER'),
  extractFn(DASHBOARD_SRC, 'getOrgPreferenceAdjustmentForOpportunity'),
  extractRange(DASHBOARD_SRC, 'function calculateOpportunityScore(opp){', 'function assignOpportunityScore(opp, account){'),
  extractRange(DASHBOARD_SRC, 'function monthIndexFromName(name){', 'function opportunityMatchesTimebox(opp, timebox){')
].join('\n\n');
const EXPORT_NAMES = [
  'findRepeatPatternGroups', 'createRepeatPatternOpportunities', 'categoryToPromoSuggestions',
  'generateFutureOpportunities', 'createOpportunity', 'signalLayerLabel', 'isWebResearchSignal'
];
const sandbox = { window: {}, document: { addEventListener(){} } };
vm.createContext(sandbox);
new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'ref-propagation-dashboard-extract.js' }).runInContext(sandbox);
const dash = sandbox.__exports;
for (const name of EXPORT_NAMES) {
  assert(typeof dash[name] === 'function', `sanity: dashboard/index.html export "${name}" extracted successfully`);
}

function d(dateStr) { return new Date(dateStr); }
function makeAccount(overrides = {}) {
  return {
    name: 'Acme Co', industry: 'Other', categoryTypes: new Set(['Apparel']),
    orderCount: 2, revenue: 4400, contactName: '', contactEmail: '',
    subscores: { revenue: 0.5, frequency: 0.5, recency: 0.5, diversity: 0.5 },
    purchases: [
      { category: 'Apparel', revenue: 2000, date: d('2024-03-10') },
      { category: 'Apparel', revenue: 2400, date: d('2025-03-15') }
    ],
    mostRecentDate: 'Unknown',
    ...overrides
  };
}

{
  // No refs on the account (never reconciled server-side) -- honest
  // degradation, no fabricated id/fingerprint anywhere.
  const account = makeAccount();
  const patterns = dash.createRepeatPatternOpportunities(account);
  assert(patterns.length === 1, 'sanity: one genuine Apparel pattern detected');
  assert(patterns[0].accountOpportunityId === undefined, 'REQUIRED: with no server-issued refs available, createRepeatPatternOpportunities() never fabricates an id');
}
{
  // Refs available -- createRepeatPatternOpportunities() copies the
  // category-specific ref onto the matching pattern.
  const account = makeAccount({
    accountHistoryOpportunityRefs: { followUp: null, repeatPattern: { Apparel: { id: 'opp-apparel', fingerprint: 'opp:repeat_pattern:v1:acme|apparel|last:2025-03-15' } } }
  });
  const patterns = dash.createRepeatPatternOpportunities(account);
  assert(patterns[0].accountOpportunityId === 'opp-apparel', `REQUIRED: the real, server-issued ref is copied onto the matching category's opportunity object (got ${patterns[0].accountOpportunityId})`);
  assert(patterns[0].accountOpportunityFingerprint === 'opp:repeat_pattern:v1:acme|apparel|last:2025-03-15', 'the fingerprint is copied alongside the id');
}
{
  // generateFutureOpportunities()'s generic industry-template branch copies
  // the account-level follow_up ref onto every generic template it builds.
  const account = makeAccount({
    industry: 'Manufacturing / Industrial',
    accountHistoryOpportunityRefs: { followUp: { id: 'opp-followup', fingerprint: 'opp:follow_up:v1:acme|last:2025-03-15' }, repeatPattern: {} }
  });
  const opps = dash.generateFutureOpportunities(account);
  const generic = opps.filter(o => o.opportunityType !== 'REPEAT PATTERN');
  assert(generic.length > 0, 'sanity: at least one generic industry-template opportunity was generated');
  assert(generic.every(o => o.accountOpportunityId === 'opp-followup'), 'REQUIRED: every generic template opportunity for this account carries the SAME account-level follow_up ref, regardless of which template');
  const pattern = opps.find(o => o.opportunityType === 'REPEAT PATTERN');
  assert(pattern.accountOpportunityId === undefined, 'sanity: the genuine pattern opportunity is unaffected -- it has no repeatPattern ref in this fixture, so it stays honestly unstamped, never inheriting the follow_up ref by mistake');
}
{
  // No refs at all on the account -- generic templates stay honestly
  // unstamped too.
  const account = makeAccount({ industry: 'Manufacturing / Industrial' });
  const opps = dash.generateFutureOpportunities(account);
  assert(opps.every(o => o.accountOpportunityId === undefined), 'REQUIRED: with no refs on the account at all, no opportunity object anywhere fabricates an id');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
