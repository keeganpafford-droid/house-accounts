// Phase 2A item D -- deterministic proof that projectAccountContext()
// never lets a large raw ha_accounts.raw_data blob (e.g. ~3 years of order
// history) survive into the bounded context a recurring-monitoring worker
// would actually use. Pure/DB-free, matching api/lib/monitoring-targets.js's
// own convention.
//
// Usage: node scripts/test-account-context-projection.js
import { projectAccountContext } from '../api/lib/monitoring-targets.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// Simulate ~3 years of weekly order history: ~156 purchases, ~156 order
// dates, plus a large notes/contacts payload -- deliberately much larger
// than any bounded field this function is supposed to cap.
const threeYearsOfPurchases = Array.from({ length: 200 }, (_, i) => ({
  category: `Category ${i % 12}`, project: `Project ${i}`, dateStr: `2023-${String((i % 12) + 1).padStart(2, '0')}-01`
}));
const threeYearsOfOrderDates = Array.from({ length: 200 }, (_, i) => `2023-${String((i % 12) + 1).padStart(2, '0')}-01`);
const largeContacts = Array.from({ length: 50 }, (_, i) => ({ name: `Contact ${i}`, email: `contact${i}@example.com` }));

const bigRow = {
  account_name: 'Long History Co',
  industry: 'Manufacturing',
  contact_name: 'Contact 0',
  metrics: { relationshipStrength: 80, revenue: 500000, orderCount: 200 },
  raw_data: {
    location: 'Portsmouth, NH',
    website: 'https://longhistoryco.example.com',
    notes: 'x'.repeat(10000), // a large free-text field, unrelated to purchases but still worth bounding by not being included at all
    purchases: threeYearsOfPurchases,
    recentOrderDates: threeYearsOfOrderDates,
    historicalCategories: Array.from({ length: 40 }, (_, i) => `Category ${i}`),
    contacts: largeContacts,
    existingSignals: Array.from({ length: 30 }, (_, i) => ({ signalLayerType: 'Follow-Up Signal', opportunity: `Signal ${i}` })),
    repeatPatterns: Array.from({ length: 30 }, (_, i) => ({ opportunityType: 'REPEAT PATTERN', opportunity: `Pattern ${i}` })),
    monitoring_status: 'active'
  }
};

const projected = projectAccountContext(bigRow);

assert(projected.name === 'Long History Co', 'the account identity survives the projection');
assert(projected.website === 'https://longhistoryco.example.com', 'website survives the projection');
assert(projected.location === 'Portsmouth, NH', 'location survives the projection');

assert(Array.isArray(projected.purchases) && projected.purchases.length <= 8, `REQUIRED: purchases is bounded to <= 8 items regardless of a 200-item input (got ${projected.purchases.length})`);
assert(Array.isArray(projected.recentPurchases) && projected.recentPurchases.length <= 8, `REQUIRED: recentPurchases is bounded to <= 8 items (got ${projected.recentPurchases.length})`);
assert(Array.isArray(projected.recentOrderDates) && projected.recentOrderDates.length <= 5, `REQUIRED: recentOrderDates is bounded to <= 5 items regardless of a 200-item input (got ${projected.recentOrderDates.length})`);
assert(Array.isArray(projected.categories) && projected.categories.length <= 10, `REQUIRED: categories is bounded to <= 10 items regardless of a 40-item input (got ${projected.categories.length})`);
assert(Array.isArray(projected.contacts) && projected.contacts.length <= 12, `REQUIRED: contacts is bounded to <= 12 items regardless of a 50-item input (got ${projected.contacts.length})`);
assert(Array.isArray(projected.existingSignals) && projected.existingSignals.length <= 5, `REQUIRED: existingSignals is bounded to <= 5 items regardless of a 30-item input (got ${projected.existingSignals.length})`);
assert(Array.isArray(projected.repeatPatterns) && projected.repeatPatterns.length <= 5, `REQUIRED: repeatPatterns is bounded to <= 5 items regardless of a 30-item input (got ${projected.repeatPatterns.length})`);

// The core proof: total projected-context payload size must stay small and
// essentially FLAT regardless of how large the underlying raw_data grows --
// this is what "large raw account history is not unnecessarily passed into
// the recurring-monitoring pipeline" means in a single measurable assertion.
const projectedSize = JSON.stringify(projected).length;
const rawSize = JSON.stringify(bigRow.raw_data).length;
assert(rawSize > 20000, `test setup sanity: the simulated raw_data is genuinely large (got ${rawSize} bytes)`);
assert(projectedSize < 6000, `REQUIRED: the projected context stays small (< 6000 bytes) even when raw_data is ${rawSize} bytes (got ${projectedSize} bytes) -- proves large history is not carried through`);

// Doubling the input size must not meaningfully grow the output -- proves
// the bound is a real cap, not a fixed fraction that still scales with input.
const evenBiggerRow = {
  ...bigRow,
  raw_data: {
    ...bigRow.raw_data,
    purchases: [...threeYearsOfPurchases, ...threeYearsOfPurchases],
    recentOrderDates: [...threeYearsOfOrderDates, ...threeYearsOfOrderDates],
    notes: bigRow.raw_data.notes.repeat(2)
  }
};
const projectedBigger = projectAccountContext(evenBiggerRow);
assert(JSON.stringify(projectedBigger).length === projectedSize, `REQUIRED: doubling the raw input size produces an IDENTICALLY-sized projected context (got ${JSON.stringify(projectedBigger).length} vs ${projectedSize}) -- the cap does not scale with input`);

// A small/typical account (no long history) is unaffected -- the bound
// never truncates data that was already small.
const smallRow = {
  account_name: 'Small Co',
  raw_data: { purchases: [{ category: 'Apparel', project: 'Q1 order', dateStr: '2026-01-01' }], monitoring_status: 'active' }
};
const projectedSmall = projectAccountContext(smallRow);
assert(projectedSmall.purchases.length === 1, 'a small account with only 1 real purchase is not artificially padded or altered');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
