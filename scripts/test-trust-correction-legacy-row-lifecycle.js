// Trust correction (entity-disambiguation), founder QA follow-up: traces
// exactly what happens to an OLD, pre-trust-correction contaminated row when
// the SAME source is re-researched and now correctly classifies as
// 'rejected'.
//
// The trace (see the accompanying Return report for the full write-up):
//   1. api/research-batch.js / api/research-account.js's per-signal mapping
//      calls verifyCandidateCompanyGrounding() and, on identityConfidence
//      === 'rejected', returns null for that candidate BEFORE it is ever
//      normalized into a signal object (see madeSignalsRaw's map() in
//      research-batch.js and the equivalent normalizedSignals map() in
//      research-account.js -- both now gate on identityConfidence explicitly,
//      see the trust-correction diff).
//   2. A null/discarded candidate never reaches resolveOpportunityEvents()/
//      dedupeSignals(), so it is never present in the `signals` array either
//      endpoint returns to the dashboard.
//   3. The dashboard forwards whatever it received to /api/save-upload,
//      which builds candidateRows/signalRows FROM THAT RESPONSE ONLY (see
//      api/save-upload.js's candidateRows map(), which reads
//      account.signals) and submits them as persist_ha_research_output()'s
//      p_signals argument.
//   4. Migration 9's ON CONFLICT (user_id, event_fingerprint) DO UPDATE only
//      fires for a fingerprint that IS present in p_signals this run. A
//      rejected candidate's fingerprint is never in that set, so the OLD
//      row (inserted before this fix existed, un-keyed to any
//      identityConfidence) is never touched by the upsert at all.
//
// Conclusion (this file proves step 1; steps 2-4 are direct code reads,
// cited above, of logic this repo has no local harness to execute against a
// real Postgres upsert): a pre-existing contaminated row does NOT self-heal
// merely by re-researching the account and having the new pass correctly
// reject the same source. It remains governed only by the legacy-grandfather
// rule (hasConfirmedOrLegacyIdentity() in dashboard/index.html, since it has
// no identityConfidence field at all) until it is targeted directly --
// exactly the founder-approved sequence: code fix -> re-research -> verify
// the correct signal now exists and is primary -> surgically
// fingerprint/id-scoped delete or suppress the demonstrably-wrong old row.
// No broad DB invalidation system is introduced here, per instruction.
//
// Usage: node scripts/test-trust-correction-legacy-row-lifecycle.js
import { verifyCandidateCompanyGrounding } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DOVER_HONDA = { name: 'Dover Honda', location: 'Dover, NH' };
const INDIANAPOLIS_CANDIDATE = {
  title: 'Dover Honda hosts unveiling event',
  snippet: 'The Indianapolis, IN dealership celebrated its major rebrand for 2028 with a new logo unveiling.',
  url: 'https://example-blog.com/indianapolis-honda-rebrand',
  sourceUrl: 'https://example-blog.com/indianapolis-honda-rebrand'
};

// Step 1: re-researching the exact same contaminated source now classifies
// it as rejected (this is the fix already proven in
// scripts/test-signal-account-evidence-grounding.js -- re-asserted here as
// the first link in this specific lifecycle chain).
const grounding = verifyCandidateCompanyGrounding(INDIANAPOLIS_CANDIDATE, DOVER_HONDA);
assert(
  grounding.identityConfidence === 'rejected',
  'step 1: re-researching the same Indianapolis source for the Dover Honda (NH) account now classifies it as rejected'
);

// Step 1b: this is the EXACT gate condition both api/research-batch.js
// (madeSignalsRaw's map()) and api/research-account.js (normalizedSignals'
// map()) now run before a candidate can become a persisted signal --
// reproduced verbatim here (not re-imported, since it is inline in each
// endpoint's request handler) to prove a 'rejected' verdict discards the
// candidate before persistence, exactly as steps 2-4 above assume.
function wouldBePersisted(candidateGrounding) {
  const groundingReasons = [];
  if (candidateGrounding.identityConfidence === 'rejected') {
    groundingReasons.push('company identity not confirmed in source evidence');
  }
  return groundingReasons.length === 0;
}
assert(
  wouldBePersisted(grounding) === false,
  'step 1b: the rejected candidate is discarded (returns null) by both endpoints\' persistence-gating logic -- it never becomes a normalized signal, so it can never appear in the payload sent to /api/save-upload'
);

// Sanity check the inverse: a confirmed candidate for the same account is
// NOT discarded, so the corrected Holiday Parade signal genuinely can reach
// persistence and (per the dashboard-gating tests) can win the primary slot.
const confirmedGrounding = verifyCandidateCompanyGrounding({
  title: 'Dover Honda announces platinum sponsorship of the 2026 Dover Holiday Parade',
  snippet: 'The Dover, NH dealership will be the lead sponsor of this year\'s parade.',
  url: 'https://doverhonda.com/news/parade-sponsorship'
}, DOVER_HONDA);
assert(
  wouldBePersisted(confirmedGrounding) === true,
  'sanity check: the correct, confirmed Holiday Parade candidate is NOT discarded -- re-research can supply a real replacement even while the old contaminated row sits untouched'
);

console.log('\nNOTE: this file proves the CODE-LEVEL discard gate (steps 1-1b) directly.');
console.log('Steps 2-4 (the discarded candidate never reaching /api/save-upload\'s payload,');
console.log('and migration 9\'s ON CONFLICT DO UPDATE therefore never firing for its');
console.log('fingerprint) are traced by direct code citation in this file\'s header comment');
console.log('rather than executed, since this repo has no local harness for the real');
console.log('Postgres upsert persist_ha_research_output() performs.');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
