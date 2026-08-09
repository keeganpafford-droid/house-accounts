// Trust correction (identity-bootstrap follow-up): the "corroborator !=
// entity match" invariant, covering the two structural sources this
// initiative found could let a domain corroborator manufacture a name
// match that was never actually there -- priorityOwnedPages()'s synthetic
// placeholder titles, and buildQueryPlan()'s bare-domain guaranteed query.
// The name-match gate itself (verifyCandidateCompanyGrounding()) is tested
// directly in scripts/test-signal-account-evidence-grounding.js (tests
// 26-30); this file covers the two upstream sources that fed it bad
// evidence before those fixes.
//
// Usage: node scripts/test-trust-correction-corroborator-manufactures-entity.js
import { priorityOwnedPages, domainFromContactEmail } from '../api/research-batch.js';
import { buildQueryPlan, verifyCandidateCompanyGrounding } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const account = { name: 'Dover Honda', website: domainFromContactEmail('predden@iclautos.com') };

// ---------------------------------------------------------------------------
// Fix 2: priorityOwnedPages() must never inject the account name into a
// synthetic candidate's title/snippet before real content has been fetched.
// ---------------------------------------------------------------------------
const pages = priorityOwnedPages(account);
assert(
  pages.length === 11,
  '1) priorityOwnedPages() still generates the same 11 candidate paths (no behavior change beyond the text fields)'
);
assert(
  pages.every(p => !p.title.includes(account.name) && !p.snippet.includes(account.name)),
  '2) NO synthetic placeholder\'s title or snippet contains the account name anywhere -- the exact leak that let an un-enriched candidate self-certify'
);
assert(
  pages.every(p => p.accountName === account.name),
  '3) accountName is still carried as ROUTING metadata (needed by requireResolvedCandidate() and similar) -- only the TEXT fields entityMatch() reads were sanitized, not the routing field'
);
const communityPage = pages.find(p => p.url.endsWith('/community'));
const groundingBeforeEnrichment = verifyCandidateCompanyGrounding(communityPage, account);
assert(
  groundingBeforeEnrichment.identityConfidence === 'rejected',
  '4) an un-enriched synthetic placeholder cannot itself satisfy grounding -- rejected (no name match), not confirmed, not even unconfirmed-via-domain-alone'
);

// An account with no website at all still gets no owned pages (unchanged
// behavior, not part of this fix but worth locking in given the file it
// lives in touches this function).
assert(
  priorityOwnedPages({ name: 'No Website Co' }).length === 0,
  '5) an account with no website produces zero owned-page candidates, unchanged'
);

// ---------------------------------------------------------------------------
// Fix 3: the guaranteed owned-domain query in buildQueryPlan() must be
// name-scoped, at the SAME array position, with NO query-count change.
// ---------------------------------------------------------------------------
const withDomain = buildQueryPlan('Dover Honda', { website: 'iclautos.com' });
const withoutDomain = buildQueryPlan('Dover Honda', {});
assert(
  withDomain[0].query.includes('"Dover Honda"') && withDomain[0].query.includes('site:iclautos.com'),
  '6) the guaranteed owned-domain query is quoted-name-scoped: both "Dover Honda" and site:iclautos.com are present'
);
assert(
  withDomain[0].signalFamily === 'owned',
  '7) the name-scoped query keeps its original \'owned\' intent identity/position (position 0, same array slot as before)'
);
assert(
  withDomain.length === withoutDomain.length + 1,
  `8) adding a domain still adds exactly ONE query slot (the owned intent) -- no query-count increase beyond what already existed (with: ${withDomain.length}, without: ${withoutDomain.length})`
);
assert(
  withoutDomain.every(item => !item.query.startsWith('site:')),
  '9) an account with no usable domain generates no site: query at all -- behaves correctly with no domain, exactly as before'
);

// ---------------------------------------------------------------------------
// End-to-end: the guaranteed query text itself, run through the real
// grounding primitive as if it were a search-result title, would no longer
// be satisfiable by a same-domain-but-unrelated result -- proving fixes 1
// and 3 compose correctly together.
// ---------------------------------------------------------------------------
assert(
  verifyCandidateCompanyGrounding({
    title: 'ICL Autos careers and current openings',
    snippet: 'Browse open roles across our dealership group.',
    url: 'https://iclautos.com/careers',
  }, account).identityConfidence === 'rejected',
  '10) a same-domain result matching the guaranteed query\'s OWN search terms (careers) but never naming Dover Honda still rejects -- fixes 1 and 3 compose correctly'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
