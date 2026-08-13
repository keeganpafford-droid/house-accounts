// Pricing/billing sprint: pure-logic regression for the canonical
// pricing-bands.js module -- band-boundary math, price formatting, and
// the server-only Stripe Price ID lookups (both directions).
//
// Usage: node scripts/test-pricing-bands.js
import { PRICING_BANDS, bandForAccountCount, bandByKey, formatPriceCents, stripePriceIdForBand, bandForStripePriceId } from '../pricing-bands.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// Band boundaries: exactly at a ceiling stays in that band, one over
// rolls into the next.
assert(bandForAccountCount(1).key === 'free', '1 account resolves to Free');
assert(bandForAccountCount(10).key === 'free', '10 accounts (the ceiling) resolves to Free');
assert(bandForAccountCount(11).key === 'band_100', '11 accounts (one over the Free ceiling) resolves to the next band, not Free');
assert(bandForAccountCount(100).key === 'band_100', '100 accounts resolves to the 100 band');
assert(bandForAccountCount(101).key === 'band_250', '101 accounts rolls into the 250 band');
assert(bandForAccountCount(250).key === 'band_250', '250 accounts resolves to the 250 band');
assert(bandForAccountCount(2500).key === 'band_2500', '2500 accounts (the top paid ceiling) resolves to the 2500 band');
assert(bandForAccountCount(2501).contactSales === true, '2501 accounts (one over the top paid ceiling) resolves to the Enterprise/contact-sales state');
assert(bandForAccountCount(387).key === 'band_500', '387 accounts resolves to "up to 500" -- matches the founder\'s own worked example');
assert(bandForAccountCount(0).key === 'free', 'a non-positive/zero count is clamped to at least 1 and resolves to Free, never throws');
assert(bandForAccountCount(-5).key === 'free', 'a negative count is clamped, never throws or produces a negative band');
assert(bandForAccountCount('not a number').key === 'free', 'a non-numeric count is clamped to Free rather than throwing');

// bandByKey
assert(bandByKey('band_500').maxAccounts === 500, 'bandByKey resolves a known key to the matching band');
assert(bandByKey('nonexistent') === null, 'bandByKey returns null for an unknown key rather than throwing');

// formatPriceCents
assert(formatPriceCents(0) === '$0', 'formatPriceCents(0) is "$0"');
assert(formatPriceCents(9900) === '$99', 'formatPriceCents(9900) is "$99"');
assert(formatPriceCents(89900) === '$899', 'formatPriceCents(89900) is "$899"');
assert(formatPriceCents(null) === null, 'formatPriceCents(null) (Enterprise\'s priceCents) returns null, not a garbage string');

// PRICING_BANDS shape: exactly the approved 9-tier table, monotonically
// increasing ceilings, monotonically increasing prices for the paid bands.
assert(PRICING_BANDS.length === 9, 'exactly 9 bands are defined (Free + 7 paid + Enterprise)');
{
  const paidBands = PRICING_BANDS.filter(b => !b.contactSales && b.key !== 'free');
  assert(paidBands.length === 7, 'exactly 7 paid bands are defined');
  for(let i = 1; i < paidBands.length; i++){
    assert(paidBands[i].maxAccounts > paidBands[i-1].maxAccounts, `band ${paidBands[i].key} has a strictly higher ceiling than ${paidBands[i-1].key}`);
    assert(paidBands[i].priceCents > paidBands[i-1].priceCents, `band ${paidBands[i].key} costs strictly more than ${paidBands[i-1].key}`);
  }
}
assert(PRICING_BANDS.filter(b => b.contactSales).length === 1, 'exactly one band is a contact-sales (Enterprise) state');
assert(PRICING_BANDS[PRICING_BANDS.length - 1].contactSales === true, 'the Enterprise band is last in the list');

// stripePriceIdForBand / bandForStripePriceId: server-only lookups,
// exercised with real env vars set (mirrors how they'd be configured in
// Production), and confirmed safe to import without process.env set.
{
  const originalEnv = { ...process.env };
  process.env.STRIPE_PRICE_ID_500 = 'price_test_500';
  process.env.STRIPE_PRICE_ID_1000 = 'price_test_1000';
  assert(stripePriceIdForBand('band_500') === 'price_test_500', 'stripePriceIdForBand resolves the configured env var for a paid band');
  assert(stripePriceIdForBand('free') === undefined, 'stripePriceIdForBand never returns a Price ID for the Free band');
  assert(stripePriceIdForBand('enterprise') === undefined, 'stripePriceIdForBand never returns a Price ID for the Enterprise/contact-sales band');
  assert(stripePriceIdForBand('nonexistent') === undefined, 'stripePriceIdForBand returns undefined for an unknown band key rather than throwing');
  assert(bandForStripePriceId('price_test_500').key === 'band_500', 'bandForStripePriceId reverse-resolves a real configured Price ID to its band');
  assert(bandForStripePriceId('price_test_1000').key === 'band_1000', 'bandForStripePriceId reverse-resolves a second configured Price ID correctly');
  assert(bandForStripePriceId('price_unknown') === null, 'bandForStripePriceId returns null for a Price ID that matches no configured band');
  assert(bandForStripePriceId(null) === null, 'bandForStripePriceId returns null for a missing price id rather than throwing');
  process.env = originalEnv;
}
assert(stripePriceIdForBand('band_500') === undefined, 'with no STRIPE_PRICE_ID_500 env var configured, stripePriceIdForBand returns undefined rather than a stale/wrong value');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
