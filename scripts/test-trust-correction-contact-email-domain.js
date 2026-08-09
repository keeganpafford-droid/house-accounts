// Trust correction (entity-disambiguation), founder identity-bootstrap
// follow-up: api/research-account.js's single-account pipeline already
// derives an account's domain from a non-free contact email
// (domainFromEmailDomain(), fed dashboard/index.html's extractEmailDomain()).
// But any account with BOTH order history and any uploaded contact routes
// to api/research-batch.js instead (see deriveAccountIntelligenceMode() in
// dashboard/index.html -- 'mixed' mode), whose safeAccounts mapping never
// derived a domain from a contact email at all. Confirmed production case:
// Dover Honda has order history + an uploaded contact with a corporate
// email, but ha_accounts.raw_data.website/location are both blank -- this
// endpoint had no path to ever learn that domain, even though the data was
// right there in the request payload the whole time.
//
// This is a narrow parity fix, not the broader identity-bootstrap
// architecture (deriving location from a verified website, persisting
// derived identity, resolving parent/subsidiary domains) -- those remain
// explicitly unimplemented pending a product decision; see the accompanying
// Return report.
//
// Usage: node scripts/test-trust-correction-contact-email-domain.js
import { domainFromContactEmail } from '../api/research-batch.js';
import { verifyCandidateCompanyGrounding } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------------
// domainFromContactEmail() itself.
// ---------------------------------------------------------------------------
assert(
  domainFromContactEmail('paula.redden@doverhonda.com') === 'doverhonda.com',
  '1) a corporate email extracts its domain'
);
assert(
  domainFromContactEmail('paula.redden@gmail.com') === '',
  '2) a free-provider email (gmail) is excluded, not treated as a company domain'
);
assert(
  domainFromContactEmail('paula.redden@yahoo.com') === ''
  && domainFromContactEmail('paula.redden@outlook.com') === ''
  && domainFromContactEmail('paula.redden@hotmail.com') === ''
  && domainFromContactEmail('paula.redden@icloud.com') === ''
  && domainFromContactEmail('paula.redden@aol.com') === '',
  '3) every major free-provider domain from the existing exclusion list is excluded'
);
assert(
  domainFromContactEmail('not-an-email') === '' && domainFromContactEmail('') === '' && domainFromContactEmail(undefined) === '',
  '4) malformed/missing input returns empty string, never throws'
);
assert(
  domainFromContactEmail('Paula.Redden@DoverHonda.COM') === 'doverhonda.com',
  '5) case-insensitive extraction, matching research-account.js\'s existing equivalent'
);

// ---------------------------------------------------------------------------
// The exact "first valid contact wins" selection rule the safeAccounts
// mapping now uses -- reproduced here as a plain array scan (not a
// reimplementation of grounding logic, just the selection rule itself,
// since safeAccounts is inline in the request handler and not separately
// exported).
// ---------------------------------------------------------------------------
function firstContactDomain(contacts) {
  return (contacts || []).map(c => domainFromContactEmail(c?.email)).find(Boolean) || '';
}
assert(
  firstContactDomain([{ email: 'paula.redden@gmail.com' }, { email: 'someone@doverhonda.com' }]) === 'doverhonda.com',
  '6) with multiple contacts, the free-provider one is skipped and the first valid corporate domain is used'
);
assert(
  firstContactDomain([{ email: 'someone@parentgroup.com' }, { email: 'paula.redden@doverhonda.com' }]) === 'parentgroup.com',
  '7) selection is deterministic first-valid-in-order, not "most specific" -- documented as a known limitation, not a bug: a parent-group domain listed first would be picked over a more specific one listed second'
);
assert(
  firstContactDomain([{ email: 'paula.redden@gmail.com' }]) === '',
  '8) an account whose only contact uses a free-provider email gets no derived domain at all -- degrades to no corroboration, never a false one'
);

// ---------------------------------------------------------------------------
// Proves the derived domain, once set as account.website, is consumed
// correctly by the real, unmodified grounding primitive -- i.e. the
// downstream half of the chain (upstream half is domainFromContactEmail()
// above; safeAccounts' `clean(a.website || '') || contactDerivedDomain`
// fallback-only wiring is exercised implicitly since it is the literal
// expression added to research-batch.js).
// ---------------------------------------------------------------------------
const doverHondaWithDerivedDomain = { name: 'Dover Honda', website: domainFromContactEmail('paula.redden@doverhonda.com') };
assert(
  verifyCandidateCompanyGrounding({
    title: 'Dover Honda unveils new showroom',
    snippet: 'The dealership announced a full renovation.',
    url: 'https://doverhonda.com/news/showroom-renovation',
  }, doverHondaWithDerivedDomain).identityConfidence === 'confirmed',
  '9) a candidate hosted on the contact-email-derived domain is confirmed via the existing, unmodified domain-match corroborator -- no grounding logic changed for this fix'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
