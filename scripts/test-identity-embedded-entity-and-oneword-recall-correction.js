// Final bounded Beta correction (embedded-entity precision + one-word
// third-party recall): proves the two identity-grounding fixes from this
// round against fresh FICTIONAL archetypes (never the real production
// account names) driven through the REAL, unmodified
// verifyCandidateCompanyGrounding() in api/signal-intelligence.js.
//
//   1. Precision (Albany International / Airport shape): a MULTI-WORD bare
//      company-name match that is embedded inside a larger, different
//      proper-name entity in the evidence text must fall to 'possible',
//      not sail through to 'unconfirmed' unprotected (the single-token
//      downgrade never applied to multi-word names at all).
//   2. Recall (Cianbro shape): a SINGLE-TOKEN company with no independent
//      domain/location/social corroborator may still reach 'unconfirmed'
//      when the evidence contains a genuine standalone, capitalized,
//      contextual mention in a recognized business-activity family --
//      instead of being unconditionally stuck at 'possible'.
//
// Both directions share ONE bounded, deterministic, snippet-scoped
// contextual-adjacency primitive (isEntityEmbeddedInLargerName() /
// isStandaloneSingleTokenMention()) -- no model calls, no publisher
// allowlists, no company-specific dictionaries.
//
// Usage: node scripts/test-identity-embedded-entity-and-oneword-recall-correction.js
import { verifyCandidateCompanyGrounding, isEntityEmbeddedInLargerName, isStandaloneSingleTokenMention, isSingleTokenCompanyIdentity } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Precision: embedded/larger-entity collisions (multi-word bare match).
// ===========================================================================

// A. The Albany International / Airport shape itself: the account's full
// two-word phrase is a literal prefix of a DIFFERENT, larger public
// institution's name, with no other standalone mention anywhere in the
// snippet.
{
  const account = { name: 'Fairview International' };
  assert(isSingleTokenCompanyIdentity(account.name) === false, 'A: sanity -- "Fairview International" is a genuine multi-word phrase, not single-token');
  const candidate = {
    title: 'Regional Travel Update',
    snippet: 'Delays are expected for travelers passing through Fairview International Airport this weekend.',
    url: 'https://localnews.example/regional-travel-update'
  };
  assert(isEntityEmbeddedInLargerName(account.name, candidate.snippet) === true, 'A: sanity -- isEntityEmbeddedInLargerName() recognizes the embedded Airport extension');
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'possible', `A: REQUIRED -- "Fairview International" embedded inside "Fairview International Airport" must not automatically establish legitimate company identity; falls to 'possible' absent independent corroboration (got '${grounding.identityConfidence}')`);
}

// B. The SAME account, but the snippet ALSO contains a genuine standalone
// self-mention elsewhere -- at least one occurrence stands on its own, so
// this must NOT be treated as a collision (isEntityEmbeddedInLargerName()
// requires EVERY occurrence to be embedded).
{
  const account = { name: 'Fairview International' };
  const candidate = {
    title: 'Fairview International Reports Record Quarter',
    snippet: 'Fairview International announced record revenue this quarter, citing strong demand near Fairview International Airport.',
    url: 'https://industrynews.example/fairview-international-earnings'
  };
  assert(isEntityEmbeddedInLargerName(account.name, candidate.snippet) === false, 'B: sanity -- a real standalone self-mention elsewhere in the same snippet means NOT every occurrence is embedded');
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'unconfirmed', `B: a genuine standalone self-mention alongside an embedded one still reaches 'unconfirmed' -- one real mention is enough (got '${grounding.identityConfidence}')`);
}

// C. Legitimate legal/company suffix continuation preserved: "Corp"
// immediately following the account's own bare name is the company's OWN
// suffix, not evidence of a different, larger entity -- must not be
// downgraded.
{
  const account = { name: 'Fairview International' };
  const candidate = {
    title: 'Fairview International Corp Donates to Local Shelter',
    snippet: 'Fairview International Corp donated supplies to the downtown shelter this week.',
    url: 'https://localnews.example/fairview-international-corp-donation'
  };
  assert(isEntityEmbeddedInLargerName(account.name, candidate.snippet) === false, 'C: REQUIRED -- the account\'s own generic legal suffix ("Corp") is exempt, never treated as a different/larger entity');
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'unconfirmed', `C: a legitimate self-mention with its own legal suffix keeps the ordinary 'unconfirmed' grade (got '${grounding.identityConfidence}')`);
}

// J. Preserve: legitimate multi-word third-party match, unaffected by this
// correction (no embedding present at all -- a fresh archetype in the same
// shape as the existing Redstone Manufacturing Group / Bramwell Logistics
// regressions).
{
  const account = { name: 'Cross Valley Freight' };
  const candidate = {
    title: 'Cross Valley Freight Announces Regional Expansion',
    snippet: 'Cross Valley Freight is expanding its distribution network to serve regional clients.',
    url: 'https://industrynews.example/cross-valley-freight-expansion'
  };
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'unconfirmed', `J: REQUIRED -- a legitimate multi-word third-party match with no uploaded website remains 'unconfirmed', exactly as before this correction (got '${grounding.identityConfidence}')`);
}

// ===========================================================================
// Recall: legitimate one-word third-party recognition (Cianbro shape).
// ===========================================================================

// D. Explicit third-party contextual statement (Facebook-caption shape):
// "X represented [company] at [event]".
{
  const account = { name: 'Larkfield' };
  const candidate = {
    title: 'Community Business Roundup',
    snippet: 'Jordan Blake represented Larkfield at the Regional Trade Expo this weekend.',
    url: 'https://facebook.example/communitypage/posts/882'
  };
  assert(isStandaloneSingleTokenMention(account.name, candidate.snippet) === true, 'D: sanity -- isStandaloneSingleTokenMention() recognizes the standalone, contextual mention');
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'unconfirmed', `D: REQUIRED -- an explicit contextual third-party statement clears the single-token Possible Match downgrade, without requiring a first-party domain (got '${grounding.identityConfidence}')`);
}

// E. Explicit third-party statement, award shape.
{
  const account = { name: 'Larkfield' };
  const candidate = {
    title: 'Chamber of Commerce Newsletter',
    snippet: 'Larkfield received the Regional Safety Award this year for its outstanding workplace record.',
    url: 'https://chambernews.example/newsletter-fall'
  };
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'unconfirmed', `E: REQUIRED -- "Larkfield received the ... Safety Award" clears the single-token downgrade the same way (got '${grounding.identityConfidence}')`);
}

// F. REQUIRED held-out counterexample: a sentence-initial, capitalized,
// isolated common-noun coincidence must NOT automatically become a
// Business Signal, even though it passes the capitalization/isolation
// check identically to case D/E above -- this is exactly why
// isStandaloneSingleTokenMention() also requires a recognized
// business-activity family in the snippet.
{
  const account = { name: 'Meadowbrook' };
  const candidate = {
    title: 'Regional Geography Feature',
    snippet: 'Meadowbrook covers thousands of acres of farmland along the river valley.',
    url: 'https://localnews.example/regional-geography-feature'
  };
  assert(isSingleTokenCompanyIdentity(account.name) === true, 'F: sanity -- "Meadowbrook" is a single-token identity');
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'possible', `F: REQUIRED -- a sentence-initial, capitalized common-noun coincidence ("Meadowbrook covers thousands of acres...") must NOT automatically become a Business Signal (got '${grounding.identityConfidence}')`);
}

// G. REQUIRED preserve: "Timberland Partners"-shaped collision -- a
// DIFFERENT company whose actual name is the account's token plus a
// generic business word. Deliberately STRICTER than the embedding check
// above: no generic-suffix exemption for the promotion direction, since
// "Partners" here names a genuinely different entity, not Meadowbrook's own
// legal form.
{
  const account = { name: 'Meadowbrook' };
  const candidate = {
    title: 'Meadowbrook Partners Announces New Fund',
    snippet: 'Meadowbrook Partners announced a new $500 million real estate fund today.',
    url: 'https://industrynews.example/meadowbrook-partners-fund'
  };
  assert(isStandaloneSingleTokenMention(account.name, candidate.snippet) === false, 'G: REQUIRED -- "Meadowbrook Partners" is not a standalone mention of the "Meadowbrook" account (any capitalized neighbor blocks promotion, even a generic business word)');
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'possible', `G: REQUIRED -- Meadowbrook Partners (a different real company) stays a Possible Match for the "Meadowbrook" account (got '${grounding.identityConfidence}')`);
}

// H. REQUIRED preserve: Oliver Wyman / Wyman's-shaped collision -- a
// DIFFERENT company's own possessive grammar normalizes into the account's
// single-token name, with a capitalized word immediately preceding it.
{
  const account = { name: "Ashgrove's" };
  const candidate = {
    title: 'Careers at Preston Ashgrove | A Larkspur Group Business',
    snippet: "Alumni gathered to celebrate a milestone anniversary for Preston Ashgrove's growing presence in the region.",
    url: 'https://careers.larkspurgroup.example/preston-ashgrove'
  };
  assert(isStandaloneSingleTokenMention(account.name, candidate.snippet) === false, 'H: REQUIRED -- "Preston Ashgrove\'s" is not a standalone mention (a capitalized word -- "Preston" -- immediately precedes it)');
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'possible', `H: REQUIRED -- Oliver Wyman / Wyman's-shaped collision stays a Possible Match, never promoted (got '${grounding.identityConfidence}')`);
}

// I. Preserve: legitimate one-word first-party match (self-domain
// corroboration) still confirms -- entirely unaffected by this round's new
// checks, since domain corroboration short-circuits before either new
// primitive is ever consulted.
{
  const account = { name: 'Larkfield' };
  const candidate = {
    title: 'Larkfield Opens New Distribution Center',
    snippet: 'Larkfield announced the opening of a new distribution center this quarter.',
    url: 'https://larkfield.com/news/new-distribution-center'
  };
  const grounding = verifyCandidateCompanyGrounding(candidate, account);
  assert(grounding.identityConfidence === 'confirmed', `I: REQUIRED -- a legitimate one-word first-party match (exact self-domain) still confirms, unaffected by this correction (got '${grounding.identityConfidence}')`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
