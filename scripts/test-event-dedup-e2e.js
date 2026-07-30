// Priority 0 — reproduces the exact production failure (duplicate Avidia
// "Westborough Branch Ribbon Cutting" recommendations) and validates the fix,
// entirely without a database connection: everything here exercises the same
// resolveOpportunityEvents() / dedupeByEventFingerprint() functions that
// api/weekly-scan.js and api/save-upload.js now call immediately before
// persistence.
//
// Usage: node scripts/test-event-dedup-e2e.js
import { resolveOpportunityEvents, dedupeByEventFingerprint, normalizeOpportunity } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) { console.log(`PASS: ${message}`); }
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const account = { name: 'Avidia Bank' };
function opp(overrides) {
  return normalizeOpportunity({ companyName: 'Avidia Bank', accountName: 'Avidia Bank', ...overrides }, account, {});
}

// Exact phrasing from the production incident, plus a third alternate
// sentence-style description, each with a distinct source URL as if produced
// by three separate generations/sources.
const westboroughA = opp({
  signalTitle: 'Westborough Branch Ribbon Cutting',
  whatChanged: 'Avidia Bank held a ribbon cutting for its new Westborough branch.',
  sourceUrl: 'https://businesswire.com/avidia-westborough',
  whyThisMatters: 'New branch opening creates an onboarding and celebration gifting opportunity.',
  confidenceScore: 82
});
const westboroughB = opp({
  signalTitle: 'Ribbon Cutting Ceremony for Westborough Branch',
  whatChanged: 'A ribbon cutting ceremony was held celebrating the new Westborough branch of Avidia Bank.',
  sourceUrl: 'https://westboroughchamber.org/news/avidia',
  whyThisMatters: 'Branch opening — promotional products for the celebration and ongoing branch operations.',
  confidenceScore: 76
});
const westboroughC = opp({
  signalTitle: 'Avidia Bank Announces New Westborough Branch',
  whatChanged: 'Avidia Bank announced the opening of its new Westborough branch this month.',
  sourceUrl: 'https://localnewsdaily.com/avidia-westborough-opens',
  whyThisMatters: 'New location opening.',
  confidenceScore: 70
});

// --- "candidates produced in separate research chunks": each chunk's own
// research-batch.js call resolves independently (chunk-local dedup only sees
// its own chunk's candidates), then api/weekly-scan.js merges the raw chunk
// outputs with flatMap and runs ONE global resolution pass. Mirrored here. ---
const chunk1Output = [westboroughA];
const chunk2Output = [westboroughB, westboroughC];
const mergedAcrossChunks = [...chunk1Output, ...chunk2Output];
const globallyResolved = resolveOpportunityEvents(mergedAcrossChunks);

assert(globallyResolved.length === 1, 'Westborough phrasing variants produced in separate chunks with different source URLs resolve to exactly one event');
assert((globallyResolved[0]?.corroboratingCandidates || 0) === 3, 'all three corroborating sources are retained as evidence on the single event');
assert(new Set((globallyResolved[0]?.sources || []).map(s => s.url)).size === 3, 'all three distinct source URLs are preserved as evidence');
assert(!!globallyResolved[0]?.eventFingerprint, 'the resolved event carries a non-empty event_fingerprint to persist');

// --- Regression guard: a genuinely different event for the same account must
// NOT be merged away (the fix must not over-suppress legitimate events). ---
const springfield = opp({
  signalTitle: 'Avidia Bank Opens New Springfield Branch',
  whatChanged: 'Avidia Bank opened a new branch location in Springfield this month.',
  sourceUrl: 'https://localnewsdaily.com/avidia-springfield-opens',
  confidenceScore: 65
});
const withDifferentEvent = resolveOpportunityEvents([westboroughA, westboroughB, springfield]);
assert(withDifferentEvent.length === 2, 'a genuinely different branch opening in a different city is NOT merged into the Westborough event');

// --- "repeated persistence attempts": the fingerprint must be stable across
// independent resolution calls — this is exactly the property that makes the
// database's on_conflict(...).ignore-duplicates() safety net work on a
// later, separate run rather than re-inserting the same event. ---
const run1 = resolveOpportunityEvents([westboroughA, westboroughB]);
const run2 = resolveOpportunityEvents([westboroughA, westboroughB]);
assert(!!run1[0]?.eventFingerprint && run1[0].eventFingerprint === run2[0]?.eventFingerprint, 'event_fingerprint is stable across repeated resolution/persistence attempts for the same event');

// --- In-memory pre-insert dedup (requirement #4): even if something upstream
// still produced two rows with the same fingerprint, row-building must
// collapse them, keeping the higher-confidence variant. Keyed by
// (user_id, event_fingerprint) only — NOT upload_id, since the two rows
// below simulate exactly the re-upload case (same event, two different
// upload_ids) that must still collapse to one. ---
const rowShaped = [
  { user_id: 'u1', upload_id: 'up1', event_fingerprint: 'avidia bank|NEW_LOCATION_OPENING|westborough|unknown', confidence: 60, title: 'lower confidence variant' },
  { user_id: 'u1', upload_id: 'up2', event_fingerprint: 'avidia bank|NEW_LOCATION_OPENING|westborough|unknown', confidence: 90, title: 'higher confidence variant (different upload_id, e.g. a re-upload)' }
];
const dedupedRows = dedupeByEventFingerprint(rowShaped, {
  keyOf: r => `${r.user_id}|${r.event_fingerprint}`,
  scoreOf: r => Number(r.confidence || 0)
});
assert(dedupedRows.length === 1 && dedupedRows[0].title.startsWith('higher confidence'), 'in-memory dedupe collapses rows sharing a fingerprint across different upload_ids (e.g. a re-upload) into one, keeping the higher-confidence variant');

// --- Composite key correctness: a different company with a similarly-worded
// event must never merge into another account's event (the fix scopes on
// company identity, not just event wording). ---
const otherAccountOpp = normalizeOpportunity({
  companyName: 'Different Bank',
  accountName: 'Different Bank',
  signalTitle: 'Ribbon Cutting Ceremony for Westborough Branch',
  whatChanged: 'A ribbon cutting ceremony was held celebrating the new Westborough branch of Different Bank.',
  sourceUrl: 'https://example.com/different-bank-westborough',
  confidenceScore: 80
}, { name: 'Different Bank' }, {});
const crossAccount = resolveOpportunityEvents([westboroughA, otherAccountOpp]);
assert(crossAccount.length === 2, "a different company's similarly-worded event is never merged into another account's event");

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
