// Trust correction: identity-bootstrap live-diagnosis round 5 -- account-
// block association + compact City/ST/ZIP recognition.
//
// Live diagnostics (6ed603d) proved the real iclautos.com dealership
// directory represents each dealership as a NUMBERED entry whose address
// sits two lines below the name, not on it, and renders the city/state/ZIP
// with no separating spaces at all:
//
//   09. **Dover Honda**
//   1 Dover Point Rd
//   Dover,NH03820
//   - Sales:(603) 242-1129
//   10. **International Cars**
//   382 NEWBURY ST
//
// Two real gaps, both fixed in api/signal-intelligence.js:
//   A. Association gap -- deriveAccountLocationFromContent() only ever
//      looked at the account's OWN line. Fixed via accountBlockLines(): a
//      line that is itself a numbered directory entry ("09. ...") gets its
//      block extended through the following lines up to (never including)
//      the next numbered entry -- a generic, markup-driven boundary, not a
//      hardcoded company name or an arbitrary character radius. Any other
//      line shape (prose, "Name -- City, ST") gets no lookahead at all --
//      unchanged same-line-only behavior.
//   B. Formatting gap -- CITY_STATE_PATTERN's trailing `\b` could never
//      match "NH03820" (state letters fused directly to zip digits: both
//      are \w characters, so there is no boundary between them at all).
//      Fixed by appending an optional, non-capturing zip suffix to the
//      shared pattern.
//
// This file proves both fixes in isolation and together, and re-proves
// every existing invariant (same-line pages, ambiguity, conflicting
// occurrences, generic pages, non-circularity) still holds unchanged.
//
// Usage: node scripts/test-trust-correction-account-block-location-extraction.js
import { deriveAccountLocationFromContent, extractCityStatePairs, verifyCandidateCompanyGrounding } from '../api/signal-intelligence.js';
import { buildDerivedIdentity, priorityOwnedPages, domainFromContactEmail } from '../api/research-batch.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// The exact live block shape, verbatim from the founder's live diagnostics
// (icl-employee-awards.htm / careers.htm / community-involvement.htm all
// showed this same structure).
const LIVE_ICL_BLOCK =
  '09. **Dover Honda**\n' +
  '1 Dover Point Rd\n' +
  'Dover,NH03820\n' +
  '- Sales:(603) 242-1129\n' +
  '10. **International Cars**\n' +
  '382 NEWBURY ST\n';

// ---------------------------------------------------------------------------
// 1) exact live "Dover,NH03820" format (no spaces at all).
// ---------------------------------------------------------------------------
assert(
  extractCityStatePairs('Dover,NH03820').some(p => p.city === 'Dover' && p.state === 'NH'),
  '1) extractCityStatePairs() recognizes the exact live compact form "Dover,NH03820" with zero separating spaces'
);

// ---------------------------------------------------------------------------
// 2) spacing variants around comma/state/ZIP all normalize identically.
// ---------------------------------------------------------------------------
for (const variant of ['Dover,NH03820', 'Dover,NH 03820', 'Dover, NH03820', 'Dover, NH 03820']) {
  const pairs = extractCityStatePairs(variant);
  assert(
    pairs.length === 1 && pairs[0].city === 'Dover' && pairs[0].state === 'NH',
    `2) spacing variant "${variant}" normalizes to city=Dover, state=NH (got ${JSON.stringify(pairs)})`
  );
}
// Already-working format (no ZIP at all) must be completely unaffected.
assert(
  JSON.stringify(extractCityStatePairs('Dover, NH')) === JSON.stringify([{ city: 'Dover', state: 'NH' }]),
  '2b) the pre-existing "Dover, NH" format (no trailing ZIP) is byte-for-byte unaffected by the new optional ZIP suffix'
);

// ---------------------------------------------------------------------------
// 3) bounded 3-line dealership block associates correctly -- the exact live
// fixture derives Dover, NH from a location two lines below the name.
// ---------------------------------------------------------------------------
assert(
  deriveAccountLocationFromContent('Dover Honda', LIVE_ICL_BLOCK) === 'Dover, NH',
  '3) the exact live numbered-directory block (address two lines below the name, compact ZIP) derives Dover, NH'
);

// ---------------------------------------------------------------------------
// 4) next numbered-account boundary prevents bleed -- must NOT derive
// Portsmouth when Dover Honda's own block has no location at all.
// ---------------------------------------------------------------------------
const NO_LOCATION_THEN_PORTSMOUTH =
  '09. **Dover Honda**\n' +
  '1 Dover Point Rd\n' +
  '10. **Portsmouth Ford**\n' +
  '123 Main St\n' +
  'Portsmouth,NH03801\n';
assert(
  deriveAccountLocationFromContent('Dover Honda', NO_LOCATION_THEN_PORTSMOUTH) === null,
  '4) Dover Honda\'s own numbered block has no City/ST before the next entry begins -- Portsmouth\'s address (past the "10." boundary) must never bleed onto Dover Honda'
);
// Sanity: Portsmouth Ford, queried directly, DOES get its own real address --
// proves the boundary rule blocks cross-account bleed, not location parsing
// in general.
assert(
  deriveAccountLocationFromContent('Portsmouth Ford', NO_LOCATION_THEN_PORTSMOUTH) === 'Portsmouth, NH',
  '4b) sanity: Portsmouth Ford\'s own address, within ITS OWN block, still derives normally'
);

// ---------------------------------------------------------------------------
// 5) multiple nearby locations within the SAME account block remain
// ambiguous -- correctly refuses to guess.
// ---------------------------------------------------------------------------
const AMBIGUOUS_BLOCK =
  '09. **Dover Honda**\n' +
  'Dover,NH03820\n' +
  'Also serving customers in Portsmouth,NH03801\n' +
  '10. **International Cars**\n';
assert(
  deriveAccountLocationFromContent('Dover Honda', AMBIGUOUS_BLOCK) === null,
  '5) two distinct City/ST pairs within one account\'s own block -- ambiguous, derives nothing rather than guessing'
);

// ---------------------------------------------------------------------------
// 6) cross-occurrence conflicts (different pages/blocks) remain rejected.
// ---------------------------------------------------------------------------
const CONFLICTING_ACROSS_OCCURRENCES =
  '09. **Dover Honda**\nDover,NH03820\n10. **Next Co**\n' +
  '===\n' +
  '09. **Dover Honda**\nManchester,NH03101\n10. **Another Co**\n';
assert(
  deriveAccountLocationFromContent('Dover Honda', CONFLICTING_ACROSS_OCCURRENCES) === null,
  '6) two DIFFERENT occurrences of the account, each with its own unambiguous but disagreeing block location -- conflicting evidence, derive nothing'
);

// ---------------------------------------------------------------------------
// 7) employee-awards-shaped live fixture: per the founder's actual live
// diagnostics, this page's Dover Honda block genuinely has no City/ST
// anywhere in it (globalCityStateMatchCount: 0 on the real page) -- this
// must continue to correctly yield NO identity, not a forced/guessed one.
// ---------------------------------------------------------------------------
const EMPLOYEE_AWARDS_SHAPED =
  '09. **Dover Honda**\n' +
  'Employee of the Month: Jane Smith\n' +
  '- Sales:(603) 242-1129\n' +
  '10. **International Cars**\n';
assert(
  deriveAccountLocationFromContent('Dover Honda', EMPLOYEE_AWARDS_SHAPED) === null,
  '7) employee-awards-shaped block genuinely has no City/ST pattern in it -- correctly derives nothing (matches the real page\'s own globalCityStateMatchCount: 0)'
);

// ---------------------------------------------------------------------------
// 8) community/careers-shaped live fixture: the real shape WITH the address
// present -- must derive Dover, NH (same assertion as #3, restated against
// the community/careers naming to match the founder's own page list).
// ---------------------------------------------------------------------------
assert(
  deriveAccountLocationFromContent('Dover Honda', LIVE_ICL_BLOCK) === 'Dover, NH',
  '8) community/careers-shaped live block (address present, two lines below the name) derives Dover, NH'
);

// ---------------------------------------------------------------------------
// Retained invariants -- must be completely unaffected by this round.
// ---------------------------------------------------------------------------
assert(
  deriveAccountLocationFromContent('Dover Honda', 'ICL Autos is a family-owned automotive group serving the New England region since 1985.') === null,
  'retained: generic group page with no mention of the account at all -> derives nothing'
);
assert(
  deriveAccountLocationFromContent('Dover Honda', 'Dover Honda — Dover, NH\nDover Honda relocated its parts department to Manchester, NH last year.\n') === null,
  'retained: conflicting Dover Honda locations (pre-existing same-line shape) -> derives nothing'
);
assert(
  deriveAccountLocationFromContent('Dover Honda', 'Portsmouth Ford — Portsmouth, NH\nDover Honda\nExeter Subaru — Stratham, NH\n') === null,
  'retained: account name alone on a non-numbered line, unrelated locations only on other lines -> still derives nothing (global co-presence is never used)'
);

const account = { name: 'Dover Honda', website: domainFromContactEmail('predden@iclautos.com'), websiteProvenance: 'contact-derived' };
const syntheticPages = priorityOwnedPages(account);
const syntheticAsCandidate = { ...syntheticPages.find(p => p.url.endsWith('/locations')), pageContent: undefined };
assert(
  buildDerivedIdentity(account, [syntheticAsCandidate]) === null,
  'retained: a synthetic owned-page placeholder (never actually fetched) can never become an identity source'
);

const icalLiveShapedCandidate = { url: 'https://iclautos.com/careers.htm', pageContent: LIVE_ICL_BLOCK, pageContentRaw: LIVE_ICL_BLOCK, accountName: 'Dover Honda' };
const derived = buildDerivedIdentity(account, [icalLiveShapedCandidate]);
assert(
  derived?.location === 'Dover, NH' && derived.sourceUrl === icalLiveShapedCandidate.url,
  'retained: buildDerivedIdentity() orchestration correctly derives Dover, NH from the live-shaped block through the real candidate-eligibility path'
);
assert(
  derived.sourceUrl !== 'https://www.dovernh.org/news/details/dover-honda-parade-sponsor',
  'retained: the identity source is never the same URL as the independent third-party candidate this identity will be used to evaluate'
);

// ---------------------------------------------------------------------------
// End-to-end goal (unit level): the derived, live-shaped location confirms
// the independent Parade candidate and rejects the conflicting Indianapolis
// one -- same as the pre-round-5 fixture, now driven by the REAL live block
// shape instead of the earlier em-dash placeholder.
// ---------------------------------------------------------------------------
const groundingAccountWithDerivedLocation = { name: 'Dover Honda', location: derived.location };
const parade = verifyCandidateCompanyGrounding({
  title: 'Dover Honda Signs On as Dover Holiday Parade Sponsor',
  snippet: 'The Dover Holiday Parade committee announced Dover Honda as its lead sponsor for this year\'s event.',
  url: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026',
}, groundingAccountWithDerivedLocation);
assert(
  parade.identityConfidence === 'confirmed',
  '9) with the live-block-derived Dover, NH identity applied, the independent dovernh.org Holiday Parade candidate confirms'
);
const indianapolis = verifyCandidateCompanyGrounding({
  title: 'Dover Honda hosts unveiling event',
  snippet: 'The Indianapolis, IN dealership celebrated its major rebrand for 2028 with a new logo unveiling.',
  url: 'https://example-blog.com/indianapolis-honda-rebrand',
}, groundingAccountWithDerivedLocation);
assert(
  indianapolis.identityConfidence === 'rejected',
  '10) the SAME live-block-derived identity makes the conflicting Indianapolis candidate reject outright, not just fail to confirm'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
