// Regression test for the SHARED signal-to-account evidence-grounding
// primitive (Sprint 1). Reproduced production failure: a Gallagher research
// request returned an opportunity whose underlying evidence was actually
// about Avidia Bank.
//
// verifyCandidateCompanyGrounding() (and the distinctive-name fallback /
// generic-word exclusion list it's built on) lives in signal-intelligence.js,
// next to entityMatch(), and is consumed by BOTH live-research endpoints --
// api/research-batch.js's multi-account pipeline and
// api/research-account.js's single-account pipeline. This file tests that
// ONE shared primitive, once, via a real import (no vm/line-range
// extraction needed now that it's a real module export). Endpoint-specific
// candidate RESOLUTION behavior (does a sourceUrl with no matching
// discovered candidate get rejected? does resolution correctly stay scoped
// to the right account?) is intentionally NOT duplicated here -- see
// scripts/test-research-endpoint-candidate-resolution.js for that.
//
// Usage: node scripts/test-signal-account-evidence-grounding.js
import { entityMatch, verifyCandidateCompanyGrounding, hasDistinctiveNameFallbackMatch, distinctiveCompanyTokens } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

for (const fn of [entityMatch, verifyCandidateCompanyGrounding, hasDistinctiveNameFallbackMatch, distinctiveCompanyTokens]) {
  assert(typeof fn === 'function', `signal-intelligence.js exports a real function (${fn && fn.name})`);
}

const GALLAGHER = { name: 'Arthur J. Gallagher' };
const AVIDIA = { name: 'Avidia Bank' };

// ---------------------------------------------------------------------------
// Must reject.
// ---------------------------------------------------------------------------
assert(
  verifyCandidateCompanyGrounding({
    title: 'Avidia Bank opens new Westborough branch',
    snippet: 'The Hudson-based bank celebrated the opening of its newest branch location in Westborough with a ribbon cutting ceremony this week.',
    url: 'https://news.example.com/avidia-westborough',
  }, GALLAGHER).grounded === false,
  '1) reproduced failure class: Gallagher request + Avidia Hudson/Westborough candidate evidence is rejected'
);

assert(
  verifyCandidateCompanyGrounding({
    title: 'Local bank expands mobile services',
    snippet: 'The bank announced new mobile banking features for customers throughout the region.',
    url: 'https://news.example.com/generic-bank-story',
  }, AVIDIA).grounded === false,
  '2) Avidia Bank request + generic banking text containing "bank" but not "Avidia" is rejected (generic-word exclusion works)'
);

// ---------------------------------------------------------------------------
// Must accept.
// ---------------------------------------------------------------------------
assert(
  verifyCandidateCompanyGrounding({
    title: 'Arthur J. Gallagher & Co. announces expanded Northeast operations',
    snippet: 'The insurance brokerage firm detailed plans for its growing regional presence.',
    url: 'https://news.example.com/gallagher-expansion',
  }, GALLAGHER).grounded === true,
  '3) full "Arthur J. Gallagher & Co." reference is accepted'
);

assert(
  verifyCandidateCompanyGrounding({
    title: 'Insurance brokerage completes acquisition',
    snippet: 'Gallagher acquired Wilson M. Beck Insurance Services in a deal announced this week.',
    url: 'https://news.example.com/gallagher-shortname',
  }, GALLAGHER).grounded === true,
  '4) "Gallagher"-only reference is accepted via the narrow distinctive-name fallback'
);

assert(
  verifyCandidateCompanyGrounding({
    title: 'Wilson M. Beck Insurance Services joins new ownership',
    snippet: 'Wilson M. Beck Insurance Services, a New York-based agency, will operate as part of Gallagher\'s brokerage division following the transaction. Terms of the deal were not disclosed.',
    url: 'https://news.example.com/wilson-beck-acquisition',
  }, GALLAGHER).grounded === true,
  '5) Wilson M. Beck acquisition (Gallagher mentioned once, most evidence about the acquired company) is accepted'
);

assert(
  verifyCandidateCompanyGrounding({
    title: 'New CFO appointed to lead finance division',
    snippet: 'Arthur J. Gallagher & Co. announced today that Jane Smith has been appointed Chief Financial Officer effective immediately.',
    url: 'https://news.example.com/gallagher-cfo',
  }, GALLAGHER).grounded === true,
  '6) account name omitted from candidate title but present in query-scoped snippet is accepted'
);

assert(
  verifyCandidateCompanyGrounding({
    title: 'Arthur J Gallagher Ltd today announced a new partnership',
    snippet: 'The firm, formerly styled Arthur J. Gallagher & Co., confirmed the deal.',
    url: 'https://news.example.com/gallagher-punctuation',
  }, GALLAGHER).grounded === true,
  '7) punctuation/legal-suffix variations are accepted'
);

// ---------------------------------------------------------------------------
// Documented residual boundary: company grounding uses title+snippet only,
// and is unaffected by unrelated content in the full pageContent scrape.
// This is a deliberate scope limit (see the header comment above
// verifyCandidateCompanyGrounding() in signal-intelligence.js), not a claim
// that unrelated-event extraction from a mixed-content page is impossible.
// ---------------------------------------------------------------------------
assert(
  verifyCandidateCompanyGrounding({
    title: 'Arthur J. Gallagher & Co. announces new hires',
    snippet: 'The insurance brokerage firm announced several new leadership appointments across its Northeast division this week.',
    pageContent: 'In other regional news, Avidia Bank also announced a new Westborough branch opening today with a ribbon cutting ceremony, unrelated to the Gallagher appointments above.',
    url: 'https://news.example.com/mixed-page-gallagher-and-avidia',
  }, GALLAGHER).grounded === true,
  '8) mixed-page-scope: title+snippet correctly identify Gallagher and grounding is unaffected by unrelated Avidia content that exists only in pageContent'
);

// research-account.js's candidates carry `.headline` (from the shared
// normalizeCandidate()) rather than always guaranteeing `.title` -- confirm
// the grounding check reads either field, so both endpoints' candidate
// shapes are genuinely supported by this one shared primitive.
assert(
  verifyCandidateCompanyGrounding({
    headline: 'Arthur J. Gallagher & Co. announces expanded Northeast operations',
    snippet: 'The insurance brokerage firm detailed plans for its growing regional presence.',
    url: 'https://news.example.com/gallagher-headline-field',
  }, GALLAGHER).grounded === true,
  '9) a candidate using .headline instead of .title (api/research-account.js\'s shape) is still correctly grounded'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
