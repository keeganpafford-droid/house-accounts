// Organizational Learning V1B: unit coverage for api/lib/account-opportunities.js --
// fingerprint namespacing/stability, and the top-level deriveAccountOpportunities()
// reconciliation/backfill both call. Behavioral parity with the dashboard's
// own pattern-detection is covered separately in
// scripts/test-account-opportunity-detection-equivalence.js.
//
// Usage: node scripts/test-account-opportunities-lib.js
import {
  repeatPatternFamilyFingerprint, repeatPatternInstanceFingerprint,
  followUpFamilyFingerprint, followUpInstanceFingerprint,
  deriveAccountOpportunities, parsePurchases
} from '../api/lib/account-opportunities.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------
// Fingerprint namespacing.
// ---------------------------------------------------------------------
{
  const family = repeatPatternFamilyFingerprint('Acme Co', 'Apparel');
  assert(family.startsWith('opp:repeat_pattern:v1:'), `REQUIRED: repeat_pattern family fingerprint carries the opp:repeat_pattern:v1: namespace (got ${family})`);
  assert(!family.includes('opp:follow_up'), 'a repeat_pattern fingerprint never collides with the follow_up namespace');
}
{
  const family = followUpFamilyFingerprint('Acme Co');
  assert(family.startsWith('opp:follow_up:v1:'), `REQUIRED: follow_up family fingerprint carries the opp:follow_up:v1: namespace (got ${family})`);
}
{
  // event_fingerprint (V1A) has no colon-delimited prefix at all -- the
  // opp: prefix makes collision with a V1A signal fingerprint impossible
  // by construction, not merely unlikely.
  const v1bFingerprint = repeatPatternFamilyFingerprint('Acme Co', 'Apparel');
  assert(v1bFingerprint.startsWith('opp:'), 'REQUIRED: every V1B fingerprint is namespaced away from the unprefixed V1A event_fingerprint format');
}
{
  const instance = repeatPatternInstanceFingerprint('Acme Co', 'Apparel', new Date('2025-03-15'));
  assert(instance === repeatPatternFamilyFingerprint('Acme Co', 'Apparel') + '|last:2025-03-15', `REQUIRED: instance fingerprint extends the family fingerprint with the anchor date (got ${instance})`);
}
{
  const a = repeatPatternInstanceFingerprint('Acme Co', 'Apparel', new Date('2025-03-15'));
  const b = repeatPatternInstanceFingerprint('Acme Co', 'Apparel', new Date('2026-04-01'));
  assert(a !== b, 'REQUIRED: two different anchor dates for the SAME family produce two different instance fingerprints (a new cycle is a new instance)');
  const familyA = a.split('|last:')[0];
  const familyB = b.split('|last:')[0];
  assert(familyA === familyB, 'sanity: both instances share the same family fingerprint');
}
{
  // Account-name normalization reuses V1A's normalizeCompany() -- same
  // corp-suffix/punctuation stripping the fingerprint-collision audit
  // already relies on, not a second, weaker normalizer.
  const a = repeatPatternFamilyFingerprint('Acme Inc.', 'Apparel');
  const b = repeatPatternFamilyFingerprint('Acme, Incorporated', 'Apparel');
  assert(a === b, `sanity: normalizeCompany() strips corp-suffix variants consistently (got ${a} vs ${b})`);
}
{
  const a = repeatPatternFamilyFingerprint('Acme Co', 'Apparel');
  const b = repeatPatternFamilyFingerprint('Acme Co', 'Headwear');
  assert(a !== b, 'REQUIRED: different categories for the same account are different families');
}

// ---------------------------------------------------------------------
// deriveAccountOpportunities(): the one canonical entry point reconciliation
// and backfill both call.
// ---------------------------------------------------------------------
{
  const rawData = {
    purchases: [
      { category: 'Apparel', revenue: 2000, dateStr: '2024-03-10' },
      { category: 'Apparel', revenue: 2400, dateStr: '2025-03-15' }
    ]
  };
  const results = deriveAccountOpportunities('Acme Co', rawData);
  const pattern = results.find(r => r.opportunityType === 'repeat_pattern');
  const followUp = results.find(r => r.opportunityType === 'follow_up');
  assert(!!pattern, 'REQUIRED: a qualifying multi-year category produces a repeat_pattern result');
  assert(pattern.category === 'Apparel', 'the pattern result carries its category');
  assert(pattern.fingerprint.startsWith('opp:repeat_pattern:v1:'), 'the pattern result carries a namespaced fingerprint');
  assert(pattern.payload.orderCount === 2 && pattern.payload.confidence === 82, `the pattern payload carries real evidence (got ${JSON.stringify(pattern.payload)})`);
  assert(!!followUp, 'REQUIRED: an account with dated purchases also produces a follow_up result');
  assert(followUp.payload.mostRecentOrderDate === '2025-03-15', 'the follow_up payload anchors on the most recent purchase date');
  assert(followUp.payload.orderCount === 2, 'the follow_up payload counts every dated purchase record');
}
{
  // No purchases at all -- neither family exists. Never fabricate an
  // opportunity for an account with no purchase history.
  const results = deriveAccountOpportunities('Empty Co', { purchases: [] });
  assert(results.length === 0, `REQUIRED: an account with zero purchases produces zero opportunities of either type (got ${results.length})`);
}
{
  // historicalProjects fallback, mirroring api/get-dashboard.js's own
  // buildAccountsFromRows() parsing precedence.
  const results = deriveAccountOpportunities('Legacy Co', {
    historicalProjects: [{ name: 'Old order', category: 'Drinkware', amount: 500, date: '2025-01-01' }]
  });
  const followUp = results.find(r => r.opportunityType === 'follow_up');
  assert(!!followUp, 'REQUIRED: historicalProjects (legacy shape) is parsed the same as purchases, matching get-dashboard.js precedence');
}
{
  const purchases = parsePurchases({ purchases: [{ category: 'Apparel', dateStr: '2025-01-01' }] });
  assert(purchases[0].date instanceof Date && !isNaN(purchases[0].date.getTime()), 'REQUIRED: parsePurchases() resolves dateStr into a real Date object');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
