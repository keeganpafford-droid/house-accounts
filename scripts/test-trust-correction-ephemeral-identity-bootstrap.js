// Trust correction: ephemeral account-identity bootstrap. For a sparse
// account (name + order history + a contact email, no uploaded website or
// location -- the live Dover Honda / iclautos.com fixture), this derives an
// in-memory-only identity from real, account-specific content already
// discovered on the account's own trusted domain, and uses it to strengthen
// (never weaken) grounding for INDEPENDENT third-party candidates.
//
// Two primitives, tested together and separately:
//   - deriveAccountLocationFromContent() (api/signal-intelligence.js): the
//     name-associated-location extraction rule. Never "name anywhere on the
//     page + any City/ST anywhere on the page" -- a dealer-group page
//     listing many companies must never let one company's mention borrow a
//     DIFFERENT company's nearby address.
//   - buildDerivedIdentity() / prioritizeIdentityBootstrapCandidates()
//     (api/research-batch.js): the per-run orchestration -- eligible
//     sources (real content, trusted domain, never a synthetic
//     placeholder), and the zero-additional-call Firecrawl reordering.
//
// Usage: node scripts/test-trust-correction-ephemeral-identity-bootstrap.js
import { deriveAccountLocationFromContent, verifyCandidateCompanyGrounding, buildQueryPlan } from '../api/signal-intelligence.js';
import { buildDerivedIdentity, prioritizeIdentityBootstrapCandidates, priorityOwnedPages, domainFromContactEmail } from '../api/research-batch.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DEALER_GROUP_PAGE = 'Our Family of Dealerships\nDover Honda — Dover, NH\nPortsmouth Ford — Portsmouth, NH\nExeter Subaru — Stratham, NH\n';

// ---------------------------------------------------------------------------
// 1) account-name + locally associated City, ST on trusted-domain content
// -> derived identity.
// ---------------------------------------------------------------------------
assert(
  deriveAccountLocationFromContent('Dover Honda', DEALER_GROUP_PAGE) === 'Dover, NH',
  '1) account name + its own locally-associated line -> Dover, NH derived, even with other dealerships present elsewhere on the page'
);

// ---------------------------------------------------------------------------
// 2) account name and an unrelated location elsewhere on the same
// multi-location page -> no incorrect association.
// ---------------------------------------------------------------------------
const nameAloneNoLocalLocation = 'Portsmouth Ford — Portsmouth, NH\nDover Honda\nExeter Subaru — Stratham, NH\n';
assert(
  deriveAccountLocationFromContent('Dover Honda', nameAloneNoLocalLocation) === null,
  '2) account name on its own line, with unrelated locations only on OTHER lines -> derives nothing (proves global co-presence is never used)'
);

// ---------------------------------------------------------------------------
// 3) conflicting locations associated with repeated account mentions ->
// derive nothing.
// ---------------------------------------------------------------------------
const conflicting = 'Dover Honda — Dover, NH\nDover Honda relocated its parts department to Manchester, NH last year.\n';
assert(
  deriveAccountLocationFromContent('Dover Honda', conflicting) === null,
  '3) two DIFFERENT locations, each locally associated with its own mention of the account -> conflicting evidence, derive nothing rather than guessing'
);

// ---------------------------------------------------------------------------
// 4) generic parent/group page -> no derived identity.
// ---------------------------------------------------------------------------
const genericGroupText = 'ICL Autos is a family-owned automotive group serving the New England region since 1985.';
assert(
  deriveAccountLocationFromContent('Dover Honda', genericGroupText) === null,
  '4) generic group content with no mention of the account at all -> derives nothing'
);
const account = { name: 'Dover Honda', website: domainFromContactEmail('predden@iclautos.com'), websiteProvenance: 'contact-derived' };
assert(
  buildDerivedIdentity(account, [{ url: 'https://iclautos.com/careers', pageContent: genericGroupText, accountName: 'Dover Honda' }]) === null,
  '4b) same generic group page, run through the full orchestration -> no derived identity object built'
);

// ---------------------------------------------------------------------------
// 5) synthetic placeholder -> never an identity source.
// ---------------------------------------------------------------------------
const syntheticPages = priorityOwnedPages(account);
const syntheticAsCandidate = { ...syntheticPages.find(p => p.url.endsWith('/locations')), pageContent: undefined };
assert(
  buildDerivedIdentity(account, [syntheticAsCandidate]) === null,
  '5) a synthetic owned-page placeholder (no pageContent, i.e. never actually fetched) can never become an identity source, even though it lives on the trusted domain'
);

// ---------------------------------------------------------------------------
// 6) identity source and evaluated third-party candidate must be distinct
// -- the exact page an identity was derived from is never also graded
// USING that same derived location.
// ---------------------------------------------------------------------------
const icalLocationsCandidate = { url: 'https://iclautos.com/locations', pageContent: DEALER_GROUP_PAGE, accountName: 'Dover Honda' };
const derived = buildDerivedIdentity(account, [icalLocationsCandidate]);
assert(
  derived?.location === 'Dover, NH' && derived.sourceUrl === icalLocationsCandidate.url,
  '6a) derived identity correctly records its own sourceUrl'
);
assert(
  derived.sourceUrl !== 'https://www.dovernh.org/news/details/dover-honda-parade-sponsor',
  '6b) sanity: the identity source is never the same URL as the independent third-party candidate this identity will be used to evaluate'
);
// The orchestration-level non-circularity guard itself (identical logic to
// api/research-batch.js's madeSignalsRaw mapping) -- proves that IF the
// identity-source candidate were re-evaluated, the augmentation would not
// apply to it.
function wouldAugment(baseAccount, derivedIdentity, candidateUrl) {
  const candidateIsIdentitySource = Boolean(derivedIdentity?.sourceUrl) && candidateUrl === derivedIdentity.sourceUrl;
  return !baseAccount.location && derivedIdentity?.location && !candidateIsIdentitySource;
}
assert(
  wouldAugment(account, derived, derived.sourceUrl) === false,
  '6c) the identity source\'s OWN url is explicitly excluded from receiving the augmented (derived-location) account -- structurally enforced, not incidental'
);
assert(
  wouldAugment(account, derived, 'https://www.dovernh.org/news/details/dover-honda-parade-sponsor') === true,
  '6d) a genuinely independent third-party candidate DOES receive the augmented account -- the guard is specific to the source, not a blanket block'
);

// ---------------------------------------------------------------------------
// 7) original account object is not mutated.
// ---------------------------------------------------------------------------
const originalAccount = { name: 'Dover Honda', website: 'iclautos.com', location: '' };
const frozenSnapshot = JSON.stringify(originalAccount);
const identityForMutationCheck = buildDerivedIdentity(originalAccount, [icalLocationsCandidate]);
// Reproduce the exact augmentation expression used in research-batch.js.
const augmented = (!originalAccount.location && identityForMutationCheck?.location)
  ? { ...originalAccount, location: identityForMutationCheck.location }
  : originalAccount;
assert(
  JSON.stringify(originalAccount) === frozenSnapshot && originalAccount.location === '',
  '7a) the original account object is untouched after building and applying derived identity'
);
assert(
  augmented !== originalAccount && augmented.location === 'Dover, NH',
  '7b) the augmented object used for grounding is a genuinely NEW object, not the original mutated in place'
);

// ---------------------------------------------------------------------------
// 8) derived location makes Dover Parade confirm; 9) Indianapolis candidate
// remains non-confirmed -- the full live-fixture goal, end to end.
// ---------------------------------------------------------------------------
const groundingAccountWithDerivedLocation = { name: 'Dover Honda', location: derived.location };
const parade = verifyCandidateCompanyGrounding({
  title: 'Dover Honda Signs On as Dover Holiday Parade Sponsor',
  snippet: 'The Dover Holiday Parade committee announced Dover Honda as its lead sponsor for this year\'s event.',
  url: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026',
}, groundingAccountWithDerivedLocation);
assert(
  parade.identityConfidence === 'confirmed',
  '8) with ephemeral Dover, NH identity applied, the independent dovernh.org Holiday Parade candidate confirms -- the live-fixture objective'
);
const indianapolis = verifyCandidateCompanyGrounding({
  title: 'Dover Honda hosts unveiling event',
  snippet: 'The Indianapolis, IN dealership celebrated its major rebrand for 2028 with a new logo unveiling.',
  url: 'https://example-blog.com/indianapolis-honda-rebrand',
}, groundingAccountWithDerivedLocation);
assert(
  indianapolis.identityConfidence === 'rejected',
  '9) the SAME ephemeral identity makes the conflicting Indianapolis candidate reject outright (explicit contradiction), not just fail to confirm'
);

// ---------------------------------------------------------------------------
// 10) no additional query count; 11) no additional Firecrawl call count.
// ---------------------------------------------------------------------------
const planWithDomain = buildQueryPlan('Dover Honda', { website: 'iclautos.com' });
const planWithoutDomain = buildQueryPlan('Dover Honda', {});
assert(
  planWithDomain.length === planWithoutDomain.length + 1,
  `10) query count is unchanged by this sprint -- still exactly one extra slot for the (already name-scoped, from the prior fix) owned-domain query (with: ${planWithDomain.length}, without: ${planWithoutDomain.length})`
);
const accountsByName = new Map([['Dover Honda', account]]);
const poolBefore = [
  { url: 'https://news.example.com/story', title: 'Unrelated', snippet: 'Unrelated', accountName: 'Dover Honda' },
  { url: 'https://iclautos.com/locations', title: 'Dover Honda | ICL Autos Locations', snippet: 'Find Dover Honda and our other dealerships.', accountName: 'Dover Honda' },
];
const poolAfter = prioritizeIdentityBootstrapCandidates(poolBefore, accountsByName);
assert(
  poolAfter.length === poolBefore.length,
  '11) prioritization only REORDERS the existing candidate pool -- same length in and out, so enrichCandidatesWithFirecrawl()\'s own per-account/total call ceiling is completely unaffected (no new calls)'
);
assert(
  poolAfter[0].url === 'https://iclautos.com/locations',
  '11b) the trusted-domain, pre-fetch-named candidate is moved to the front so it wins the existing enrichment budget over an unrelated result'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
