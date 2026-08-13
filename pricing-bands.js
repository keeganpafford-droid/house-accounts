// Canonical House Accounts pricing-band definition. One file, imported
// as-is by both server code (Node ESM, via a relative import) and the
// browser (pricing.html loads it with <script type="module"
// src="/pricing-bands.js">) -- package.json already declares
// "type":"module" so the same ES module syntax works unmodified in both
// places, with no bundler and no second copy of the numbers anywhere.
//
// This is the single source of truth for: the pricing page's slider
// display, monitored-account-capacity enforcement (api/lib/
// entitlement.js), Stripe Checkout price lookup, and the webhook's
// band-from-Stripe-price resolution. Do not duplicate these numbers
// anywhere else -- import from here.
//
// Pricing approved 2026-08-13. maxAccounts is the inclusive ceiling for
// that band (e.g. band_100 covers 11-100 monitored accounts). The
// `enterprise` band has no self-serve price -- it is a contact-sales
// state, not a Stripe Price.
export const PRICING_BANDS = [
  { key: 'free',       label: 'Free',                 maxAccounts: 10,   priceCents: 0 },
  { key: 'band_100',   label: 'Up to 100 accounts',    maxAccounts: 100,  priceCents: 9900 },
  { key: 'band_250',   label: 'Up to 250 accounts',    maxAccounts: 250,  priceCents: 19900 },
  { key: 'band_500',   label: 'Up to 500 accounts',    maxAccounts: 500,  priceCents: 29900 },
  { key: 'band_750',   label: 'Up to 750 accounts',    maxAccounts: 750,  priceCents: 39900 },
  { key: 'band_1000',  label: 'Up to 1,000 accounts',  maxAccounts: 1000, priceCents: 49900 },
  { key: 'band_1500',  label: 'Up to 1,500 accounts',  maxAccounts: 1500, priceCents: 59900 },
  { key: 'band_2500',  label: 'Up to 2,500 accounts',  maxAccounts: 2500, priceCents: 89900 },
  { key: 'enterprise', label: 'Over 2,500 accounts',   maxAccounts: null, priceCents: null, contactSales: true },
];

// Smallest band whose ceiling covers the requested account count.
export function bandForAccountCount(n) {
  const count = Math.max(0, Number(n) || 0);
  return PRICING_BANDS.find(b => b.maxAccounts === null || count <= b.maxAccounts) || PRICING_BANDS[PRICING_BANDS.length - 1];
}

export function bandByKey(key) {
  return PRICING_BANDS.find(b => b.key === String(key || '')) || null;
}

export function formatPriceCents(cents) {
  if (cents === null || cents === undefined) return null;
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// Server-only lookup of the real Stripe Price ID for a paid band. The
// body only runs when a server handler calls it, so importing this
// module in the browser (where `process` does not exist) never throws --
// the browser only ever touches PRICING_BANDS/bandForAccountCount/
// formatPriceCents above.
export function stripePriceIdForBand(bandKey) {
  if (typeof process === 'undefined' || !process.env) return undefined;
  const band = bandByKey(bandKey);
  if (!band || band.contactSales || band.key === 'free') return undefined;
  const suffix = band.key.replace(/^band_/, '').toUpperCase();
  return process.env[`STRIPE_PRICE_ID_${suffix}`];
}

// Reverse lookup: given a real Stripe Price ID (from a checkout session or
// subscription object), find which configured band it belongs to. Used by
// the webhook so account_capacity always traces back to this same table.
export function bandForStripePriceId(priceId) {
  if (typeof process === 'undefined' || !process.env || !priceId) return null;
  for (const band of PRICING_BANDS) {
    if (stripePriceIdForBand(band.key) === priceId) return band;
  }
  return null;
}
