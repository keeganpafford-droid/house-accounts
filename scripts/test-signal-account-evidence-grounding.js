// Regression test for the SHARED signal-to-account evidence-grounding
// primitive (Sprint 1, extended by the trust-correction / entity-
// disambiguation sprint). Reproduced production failure #1: a Gallagher
// research request returned an opportunity whose underlying evidence was
// actually about Avidia Bank. Reproduced production failure #2 (trust
// correction): Dover Honda's dashboard surfaced an Instagram "Major Rebrand"
// signal that actually belonged to an unrelated Honda dealership in
// Indianapolis, IN -- a same-name-but-different-company failure entityMatch()'s
// bare full-phrase match alone could not distinguish, because domain/location
// were only ever optional bonuses, never required corroboration, and there
// was no positive-contradiction veto at all.
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

// ---------------------------------------------------------------------------
// Trust correction (entity-disambiguation): tri-state identityConfidence.
// Reproduced production failure: Dover Honda's dashboard surfaced an
// Instagram "Major Rebrand for 2028" candidate that actually belonged to an
// unrelated Honda dealership in Indianapolis, IN, while the real Dover, NH
// dealership's Holiday Parade sponsorship existed in the same account's
// data. A bare "Dover Honda" text match alone (entityMatch()'s 58-point
// full-phrase bonus) was sufficient to pass the old boolean grounded gate --
// domain/location were only ever optional bonuses, never required
// corroboration, and there was no positive-contradiction veto at all.
// ---------------------------------------------------------------------------
const DOVER_HONDA = { name: 'Dover Honda', location: 'Dover, NH' };
const DOVER_HONDA_WITH_DOMAIN = { name: 'Dover Honda', website: 'doverhonda.com' };
const GALLAGHER_WITH_LOCATION = { name: 'Arthur J. Gallagher & Co.', location: 'Rolling Meadows, IL' };
const GALLAGHER_WITH_DOMAIN = { name: 'Arthur J. Gallagher & Co.', website: 'ajg.com' };

// 1) exact name + correct location -> confirmed
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda celebrates grand opening of remodeled showroom',
    snippet: 'The Dover, NH dealership unveiled its newly renovated facility to the community this week.',
    url: 'https://news.example.com/dover-honda-remodel',
  }, DOVER_HONDA).identityConfidence === 'confirmed',
  '10) exact name + correct account location present in source -> confirmed'
);

// 2) exact name + correct domain -> confirmed
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda announces major rebrand for 2028',
    snippet: 'The dealership unveiled a new logo and brand identity as part of a multi-year plan.',
    url: 'https://doverhonda.com/news/rebrand-2028',
  }, DOVER_HONDA_WITH_DOMAIN).identityConfidence === 'confirmed',
  '11) exact name + source hosted on the account\'s own domain -> confirmed'
);

// 3) exact name only, no corroboration -> unconfirmed (the actual reproduced defect)
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda announces major rebrand for 2028',
    snippet: 'The dealership unveiled a bold new logo and brand identity as part of a multi-year plan.',
    url: 'https://example-blog.com/dover-honda-rebrand',
  }, DOVER_HONDA).identityConfidence === 'unconfirmed',
  '12) exact name match with no location/domain/social corroboration and no contradiction -> unconfirmed, not confirmed (preserves recall without claiming truth)'
);

// 4) same name + explicitly contradictory city/state -> rejected
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda hosts unveiling event',
    snippet: 'The Indianapolis, IN dealership celebrated its major rebrand for 2028 with a new logo unveiling.',
    url: 'https://example-blog.com/indianapolis-honda-rebrand',
  }, DOVER_HONDA).identityConfidence === 'rejected',
  '13) same name + source explicitly naming a different city/state than the account, with no compensating evidence -> rejected (the actual reproduced Indianapolis/Dover NH failure)'
);

// 4b) same contradiction, but WITH compensating domain evidence -> still confirmed
// (a legitimate new-market press release from the company's own domain must
// not be penalized merely because it covers a market other than headquarters).
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda expands to new Indianapolis, IN location',
    snippet: 'The dealership group announced a new satellite location as part of its 2028 growth plan.',
    url: 'https://doverhonda.com/news/indianapolis-expansion',
  }, DOVER_HONDA_WITH_DOMAIN).identityConfidence === 'confirmed',
  '14) same explicit-contradiction shape, but sourced from the account\'s own domain (compensating evidence) -> still confirmed, not rejected -- a genuine new-market/expansion signal is not penalized'
);

// 5) same name + clearly wrong social profile/handle -> rejected
assert(
  verifyCandidateCompanyGrounding({
    title: 'Regional dealer feature: Ed Martin Honda',
    snippet: 'This Indianapolis, IN Honda dealership, also doing business as Dover Honda Group in local marketing, announced a rebrand.',
    url: 'https://www.instagram.com/edmartinhonda',
  }, DOVER_HONDA).identityConfidence === 'rejected',
  '15) same name match, on an unrelated dealership\'s own social handle, with an explicit conflicting city/state -> rejected'
);

// 6) ambiguous social candidate (name match, no location, unrecognized handle) -> unconfirmed
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda spotted at regional auto show',
    snippet: 'Photos from the show floor featured several dealership booths including Dover Honda.',
    url: 'https://www.instagram.com/newenglandautoscene',
  }, DOVER_HONDA).identityConfidence === 'unconfirmed',
  '16) ambiguous social candidate: name match, no location/domain, and a handle that is neither the account\'s own nor explicitly a different named business -> unconfirmed (same general rule as non-social sources, no social-specific carve-out needed)'
);

// 7) Founder QA follow-up: an INFERRED social handle match (the handle text
// merely resembles the company name, with no known-official-profile data on
// file) must NOT confirm by itself -- this is the exact shape of the
// original Dover Honda failure (an unrelated real "Dover Honda" could just
// as easily post from "@dover_honda"). Same evidence as the old test 17,
// different expected outcome: unconfirmed, not confirmed.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda announces platinum sponsorship of the 2026 Dover Holiday Parade',
    snippet: 'We are proud to be the lead sponsor of this year\'s holiday parade!',
    url: 'https://www.instagram.com/dover_honda',
  }, DOVER_HONDA).identityConfidence === 'unconfirmed',
  '17) inferred social handle match alone (text resembles account name, no known-official-profile data) -> unconfirmed, NOT confirmed -- a same-name-but-wrong-company profile would pass this exact check equally easily, so it is not independent evidence'
);

// 7b) the SAME evidence confirms once House Accounts actually knows this is
// the account's own official profile (account.knownSocialProfiles) --
// proving social sources are not banned, just held to a real independence
// bar instead of a text-resemblance guess.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda announces platinum sponsorship of the 2026 Dover Holiday Parade',
    snippet: 'We are proud to be the lead sponsor of this year\'s holiday parade!',
    url: 'https://www.instagram.com/dover_honda',
  }, { ...DOVER_HONDA, knownSocialProfiles: ['https://www.instagram.com/dover_honda'] }).identityConfidence === 'confirmed',
  '17b) the identical candidate confirms once the account record carries a KNOWN official profile matching this exact handle/URL'
);

// 7c) an inferred handle match must not override a location contradiction
// either -- only a KNOWN profile (or domain) counts as compensating evidence.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda expands to new Indianapolis, IN location',
    snippet: 'We are proud to announce our new satellite location!',
    url: 'https://www.instagram.com/dover_honda',
  }, DOVER_HONDA).identityConfidence === 'rejected',
  '17c) inferred-only handle match does not compensate for an explicit location contradiction -- still rejected (contrast with test 14, where the account\'s own DOMAIN does compensate)'
);

// 8) distinctive-token fallback follows the SAME corroboration/contradiction rules
assert(
  verifyCandidateCompanyGrounding({
    title: 'Local insurance agency opens new Miami, FL office',
    snippet: 'Gallagher confirmed the expansion as part of its regional growth strategy.',
    url: 'https://example-blog.com/gallagher-miami',
  }, GALLAGHER_WITH_LOCATION).identityConfidence === 'rejected',
  '18) distinctive-token-only match ("Gallagher") + explicit contradictory location vs. the account\'s Rolling Meadows, IL -> rejected, same as a full-phrase match would be'
);
assert(
  verifyCandidateCompanyGrounding({
    title: 'Insurance brokerage completes acquisition',
    snippet: 'Gallagher acquired Wilson M. Beck Insurance Services in a deal announced this week.',
    url: 'https://ajg.com/news/wilson-beck-acquisition',
  }, GALLAGHER_WITH_DOMAIN).identityConfidence === 'confirmed',
  '19) distinctive-token-only match ("Gallagher") + the account\'s own domain -> confirmed, same as a full-phrase match would be'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
