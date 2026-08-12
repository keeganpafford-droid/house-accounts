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

// 7) Final bounded Beta trust correction (Item 3): isExactSelfSocialHandleMatch()
// now distinguishes a genuinely EXACT compacted handle match ("dover_honda"
// -> "doverhonda" === normalizeCompany("Dover Honda") -> "doverhonda") from
// a merely-INFERRED/resembling match (substring/contains, see test 16 and
// the AMBIGUOUS case below). This is the identical mechanism the founder's
// own L.L.Bean/@llbean example exercises -- exact equality only, no
// substring/fuzzy matching -- so it is deliberately, correctly promoted to
// 'confirmed' here too, superseding this test's pre-Item-3 expectation.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda announces platinum sponsorship of the 2026 Dover Holiday Parade',
    snippet: 'We are proud to be the lead sponsor of this year\'s holiday parade!',
    url: 'https://www.instagram.com/dover_honda',
  }, DOVER_HONDA).identityConfidence === 'confirmed',
  '17) an EXACT compacted social-handle match ("dover_honda" === "Dover Honda" compacted) is corroborating evidence and confirms, per Item 3 -- distinct from the merely-resembling/ambiguous case in test 16'
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

// 7c) Item 3 extends the SAME location-contradiction-override treatment
// already given to domainCorroborated/knownSocialProfileMatch/
// selfDomainCorroborated to exactSocialHandleCorroborated -- a genuine
// EXACT self-handle match is first-party-strength evidence, so (like the
// account's own domain in test 14) it compensates for an explicit
// new-market location claim rather than being vetoed by it.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda expands to new Indianapolis, IN location',
    snippet: 'We are proud to announce our new satellite location!',
    url: 'https://www.instagram.com/dover_honda',
  }, DOVER_HONDA).identityConfidence === 'confirmed',
  '17c) an EXACT compacted social-handle match compensates for an explicit location contradiction, same as the account\'s own domain does in test 14 -- both are first-party-strength self-identification evidence'
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

// ---------------------------------------------------------------------------
// Founder QA follow-up (Dover Holiday Parade false negative): a THIRD-PARTY
// publisher whose own domain is geographically tied to the account's
// city+state is now an independent corroborator -- but city ALONE in the
// domain is deliberately not sufficient (see accountCityStateGeoTokens()'s
// header comment for why: for a franchise-style name, the city is already
// baked into the company name, so a bare-city check would be satisfied by
// the wrong company exactly as easily as the right one).
// ---------------------------------------------------------------------------

// 20) Dover, NH + dovernh.org (city+state both encoded in the domain) +
// company-name match -> confirmed. The actual reproduced false-negative.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda Signs On as Dover Holiday Parade Sponsor',
    snippet: 'The Dover Holiday Parade committee announced Dover Honda as its lead sponsor for this year\'s event.',
    url: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026',
  }, DOVER_HONDA).identityConfidence === 'confirmed',
  '20) Dover, NH account + dovernh.org publisher (city+state both in the domain) + name match -> confirmed'
);

// 21) Dover, NH + a geographically neutral third-party domain -> unconfirmed,
// not automatically confirmed just because a third party (not a social
// profile) wrote about the company.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda mentioned in regional business roundup',
    snippet: 'Local dealerships including Dover Honda were featured in this week\'s roundup.',
    url: 'https://example-businessjournal.com/roundup',
  }, DOVER_HONDA).identityConfidence === 'unconfirmed',
  '21) geographically neutral third-party publisher domain -> unconfirmed (no automatic third-party trust)'
);

// 22) Dover, NH + a domain containing ONLY the city (no state token) ->
// does NOT automatically confirm -- the founder-specified conservative
// requirement (city+state, not city alone).
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda featured on Dover community blog',
    snippet: 'Local blog covering Dover area businesses featured Dover Honda this week.',
    url: 'https://doverblog.com/dover-honda-feature',
  }, DOVER_HONDA).identityConfidence === 'unconfirmed',
  '22) city-name-only third-party domain (no state token) -> does not automatically confirm, stays unconfirmed'
);

// 23) geo-matched publisher (city+state in domain) that ALSO names an
// explicit conflicting city/state -> still rejected. Publisher geography
// must never override an explicit contradiction the way the account's own
// domain does.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda opens new Indianapolis, IN satellite lot',
    snippet: 'The dealership announced a new Indianapolis, IN location as part of its growth plan.',
    url: 'https://www.dovernh.org/news/details/dover-honda-indianapolis-expansion',
  }, DOVER_HONDA).identityConfidence === 'rejected',
  '23) geo-matched publisher (dovernh.org) + explicit conflicting Indianapolis, IN text -> still rejected, geography corroboration does not compensate for a contradiction'
);

// 24) the original Indianapolis Instagram case remains rejected -- unaffected
// by the new publisher-geography rule (instagram.com carries no geographic
// identity to match against).
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda hosts unveiling event',
    snippet: 'The Indianapolis, IN dealership celebrated its major rebrand for 2028 with a new logo unveiling.',
    url: 'https://example-blog.com/indianapolis-honda-rebrand',
  }, DOVER_HONDA).identityConfidence === 'rejected',
  '24) Indianapolis Instagram-shaped case remains rejected, unaffected by the new publisher-geography corroborator'
);

// 25) an account with no parseable city+state on file never gets this
// corroborator at all -- degrades gracefully, no crash, no false positive.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda Signs On as Dover Holiday Parade Sponsor',
    snippet: 'The Dover Holiday Parade committee announced Dover Honda as its lead sponsor.',
    url: 'https://www.dovernh.org/news/details/dover-honda-parade-sponsor',
  }, { name: 'Dover Honda' }).identityConfidence === 'unconfirmed',
  '25) account with no location on file at all -> publisher-geography corroborator never fires, degrades to unconfirmed rather than confirmed or a crash'
);

// ---------------------------------------------------------------------------
// Founder QA follow-up (ICL Autos live fixture): CORROBORATOR != ENTITY
// MATCH. Domain/location/social corroboration must never manufacture a name
// match that isn't there -- confirmed production risk: entityMatch()'s
// domain bonus alone (38 points) used to clear the 'rejected' floor (30)
// with zero name-text match required, so ANY page on account.website could
// confirm even with no mention of the account at all. Harmless for an
// exclusive single-company domain, but a real false-attribution vector once
// a domain can be shared (e.g. derived from a contact's email at a
// multi-brand dealer group like "iclautos.com").
// ---------------------------------------------------------------------------
const DOVER_HONDA_GROUP_DOMAIN = { name: 'Dover Honda', website: 'iclautos.com' };

// 26) shared/group domain + zero target-name mention -> must NOT confirm.
assert(
  verifyCandidateCompanyGrounding({
    title: 'ICL Autos Group announces new careers page',
    snippet: 'Explore career opportunities across the ICL Autos family of dealerships.',
    url: 'https://iclautos.com/careers',
  }, DOVER_HONDA_GROUP_DOMAIN).identityConfidence === 'rejected',
  '26) shared group domain + zero mention of the target account name -> rejected, not confirmed (the exact live ICL Autos / Dover Honda risk)'
);

// 27) the SAME invariant holds even for an uploaded, EXCLUSIVE domain --
// corroborator strength never substitutes for the name-match floor,
// regardless of whether the domain came from upload or derivation.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Now hiring: service technicians',
    snippet: 'Apply today for open positions.',
    url: 'https://doverhonda.com/careers',
  }, DOVER_HONDA_WITH_DOMAIN).identityConfidence === 'rejected',
  '27) an uploaded, exclusive account.website ALSO cannot bypass the name-match floor via domain alone -- the invariant is unconditional, not just for shared domains'
);

// 28) domain + a TRUE target-name match -> corroboration remains fully
// available (regression guard: the gate fix must not have broken the
// legitimate confirmed path).
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda unveils new showroom',
    snippet: 'The dealership announced a full renovation.',
    url: 'https://doverhonda.com/news/showroom-renovation',
  }, DOVER_HONDA_WITH_DOMAIN).identityConfidence === 'confirmed',
  '28) domain + an actual name match still confirms -- the fix narrows the gate, it does not weaken the legitimate path'
);

// 29) distinctive-token fallback still works ONLY under its existing
// intended rules (bounded generic-word exclusion, ANY-token match) -- the
// gate rewrite must not have disturbed this separate mechanism. Final Beta
// Signal Intelligence Correction sprint: the RESULT grade for a token-only,
// uncorroborated fallback match is now 'possible' (Possible Match), not
// 'unconfirmed' -- this is the exact confirmed-collision shape (an uploaded
// "Wyman's" matching "Careers at Oliver Wyman | A Marsh business", a
// different company that merely shares a surname/token) the sprint's
// identity-separation fix targets. The account is named "Arthur J.
// Gallagher" here; the candidate text contains only the bare, ambiguous
// token "Gallagher," never the account's actual (normalized) full name --
// exactly as consistent with a different Gallagher-named entity as with
// this one, so it must not be shown as a legitimate Business Signal.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Insurance brokerage completes acquisition',
    snippet: 'Gallagher acquired Wilson M. Beck Insurance Services in a deal announced this week.',
    url: 'https://example-blog.com/gallagher-shortname',
  }, GALLAGHER).identityConfidence === 'possible',
  '29) distinctive-token fallback ("Gallagher") still grounds enough to return a visible result, but grades as \'possible\' (Possible Match, identity uncertain), not a legitimate Business Signal -- the fallback mechanism\'s own matching rules are untouched, only the resulting confidence label'
);
assert(
  verifyCandidateCompanyGrounding({
    title: 'Local bank expands mobile services',
    snippet: 'The bank announced new mobile banking features for customers throughout the region.',
    url: 'https://news.example.com/generic-bank-story',
  }, AVIDIA).identityConfidence === 'rejected',
  '29b) the bounded generic-word exclusion still prevents a bare "bank" mention from counting as the Avidia Bank fallback -- unaffected by the gate rewrite'
);

// 30) an account-specific ICL Autos page that actually names Dover Honda
// passes the name floor -- proving the fix distinguishes "no evidence" from
// "real evidence," not just tightening everything indiscriminately.
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda featured on ICL Autos locations page',
    snippet: 'Dover Honda, located at 1 Dover Point Rd, Dover, NH 03820, is part of the ICL Autos family.',
    url: 'https://iclautos.com/locations',
  }, DOVER_HONDA_GROUP_DOMAIN).identityConfidence === 'confirmed',
  '30) an account-specific group-domain page that explicitly names Dover Honda passes the name floor and confirms via domain corroboration -- proving the architecture is feasible once real evidence exists'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
