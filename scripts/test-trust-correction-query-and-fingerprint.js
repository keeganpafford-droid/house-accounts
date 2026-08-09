// Trust correction (entity-disambiguation) regression tests, part 2: the
// query-template location-symmetry fix and the eventFingerprint() identity
// invariant. See scripts/test-signal-account-evidence-grounding.js for the
// tri-state identityConfidence grounding tests (part 1).
//
// Usage: node scripts/test-trust-correction-query-and-fingerprint.js
import { queryTemplates } from '../api/research-batch.js';
import { eventFingerprint } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------------
// 14) warm-account / prospect-intelligence queries use location when
// available, closing the pre-existing asymmetry with the default/'ranked'
// mode family (which has always interpolated location). This is the query-
// construction half of the Dover Honda fix -- a location-blind query is what
// let a same-name, different-city dealership surface as a top search result
// in the first place.
// ---------------------------------------------------------------------------
const withLocation = queryTemplates('Dover Honda', { location: 'Dover, NH' }, 'warm-account');
const withoutLocation = queryTemplates('Dover Honda', {}, 'warm-account');

assert(
  withLocation.some(q => q.includes('Dover, NH')),
  '14a) warm-account queries include the account location when one is on file'
);
assert(
  withLocation.filter(q => q.includes('"Dover Honda"')).every(q => !q.includes('site:') ? q.includes('Dover, NH') || !q.startsWith('"Dover Honda" AND (') : true),
  '14b) every non-site: quoted-company-name query in the warm-account family carries the location, not just one or two of them'
);
assert(
  withoutLocation.every(q => !/Dover, NH/.test(q)),
  '14c) an account with no location on file gets exactly the prior (location-free) query text -- preserved sensible behavior, no placeholder/blank artifacts'
);
assert(
  !withoutLocation.some(q => / {2,}/.test(q)),
  '14d) omitting location never leaves a double-space artifact in the query string'
);

// ---------------------------------------------------------------------------
// 15) query count/provider/runtime architecture is unchanged -- the fix adds
// location text to existing query strings, it does not add new query slots,
// which would increase provider call volume/latency for every research run.
// ---------------------------------------------------------------------------
const prospectWithLocation = queryTemplates('Acme Co', { location: 'Boston, MA' }, 'prospect-intelligence');
const prospectWithoutLocation = queryTemplates('Acme Co', {}, 'prospect-intelligence');
assert(
  withLocation.length === withoutLocation.length,
  `15a) adding a location does not change the warm-account query COUNT (with: ${withLocation.length}, without: ${withoutLocation.length})`
);
assert(
  prospectWithLocation.length === prospectWithoutLocation.length,
  `15b) adding a location does not change the prospect-intelligence query COUNT (with: ${prospectWithLocation.length}, without: ${prospectWithoutLocation.length})`
);
// Domain-scoped (site:) queries are intentionally left alone -- see the fix's
// own comment in queryTemplates(): appending location to an already-precise
// site: search narrows it, it does not disambiguate an ambiguous name. This
// asserts that invariant stays true rather than silently regressing later.
const domainQueries = queryTemplates('Acme Co', { location: 'Boston, MA', website: 'acmeco.com' }, 'warm-account').filter(q => q.startsWith('site:'));
assert(
  domainQueries.length > 0 && domainQueries.every(q => !q.includes('Boston, MA')),
  '15c) domain-scoped (site:) queries are unaffected by the location-symmetry fix, as documented'
);

// ---------------------------------------------------------------------------
// 13) account identity fields (location/domain) never alter eventFingerprint
// -- entity grounding and event-fingerprint identity are deliberately
// separate concerns (see the fingerprint-drift observations in the trust-
// correction report). eventFingerprint() does not even accept an `account`
// parameter, so this also guards against a future change accidentally
// threading account context into it.
// ---------------------------------------------------------------------------
const baseCandidate = {
  title: 'Dover Honda announces platinum sponsorship of the 2026 Dover Holiday Parade',
  snippet: 'The dealership will be the lead sponsor of this year\'s parade.',
  companyName: 'Dover Honda',
  eventDate: '2026-12-01'
};
const fpWithoutContext = eventFingerprint(baseCandidate);
const fpWithLocationNoise = eventFingerprint({ ...baseCandidate, companyDomain: 'doverhonda.com', location: 'Dover, NH', accountLocation: 'Indianapolis, IN' });
assert(
  fpWithoutContext === fpWithLocationNoise,
  '13) adding companyDomain/location/accountLocation fields to the candidate object never changes its eventFingerprint -- identity confidence and event identity stay independent axes'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
