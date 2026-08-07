// Regression test for Sprint 1 (signal-to-account evidence grounding).
//
// Reproduced production failure: a Gallagher research request returned an
// opportunity whose underlying evidence was actually about Avidia Bank. Two
// independent gaps caused it, both closed by api/research-batch.js's
// requireResolvedCandidate()/verifyCandidateCompanyGrounding() (added next
// to dedupeSignals()):
//   1. mapped.eventFingerprint is never populated at candidate-resolution
//      time, so the previous `sourceUrl OR eventFingerprint` lookup's
//      second branch was dead -- resolution was always sourceUrl-only, but
//      silently fell back to `{}` (not a rejection) on no match.
//   2. Even a correct sourceUrl match never confirmed the candidate's
//      evidence was actually ABOUT the requested account.
//
// This extracts the real, verbatim functions from api/research-batch.js
// (a hardcoded contiguous line range; if the file changes shape,
// extractLines() below throws instead of silently testing stale/wrong
// code) into a vm sandbox pre-populated with the REAL entityMatch()
// (signal-intelligence.js) and normalizeCompanyName() (company-identity.js)
// dependencies, then calls them for real.
//
// Usage: node scripts/test-signal-account-evidence-grounding.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { entityMatch } from '../api/signal-intelligence.js';
import { normalizeCompanyName } from '../api/company-identity.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH_BATCH_PATH = path.join(__dirname, '..', 'api', 'research-batch.js');
const SRC = readFileSync(RESEARCH_BATCH_PATH, 'utf8');
const LINES = SRC.split('\n');

function extractLines(label, startLine, endLine, expectedFirst) {
  const first = LINES[startLine - 1];
  if (!first || !first.startsWith(expectedFirst)) {
    throw new Error(`extractLines(${label}): api/research-batch.js line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  return LINES.slice(startLine - 1, endLine).join('\n');
}

// GENERIC_COMPANY_WORDS -> distinctiveCompanyTokens -> hasDistinctiveNameFallbackMatch
// -> verifyCandidateCompanyGrounding -> requireResolvedCandidate, all contiguous.
const GROUNDING_SRC = extractLines('signal-account-evidence-grounding', 2037, 2090, "const GENERIC_COMPANY_WORDS = new Set([");

const sandbox = { entityMatch, normalizeCompanyName };
vm.createContext(sandbox);
vm.runInContext(`${GROUNDING_SRC}\nthis.distinctiveCompanyTokens = distinctiveCompanyTokens; this.hasDistinctiveNameFallbackMatch = hasDistinctiveNameFallbackMatch; this.verifyCandidateCompanyGrounding = verifyCandidateCompanyGrounding; this.requireResolvedCandidate = requireResolvedCandidate;`, sandbox);
const { hasDistinctiveNameFallbackMatch, verifyCandidateCompanyGrounding, requireResolvedCandidate } = sandbox;

for (const fn of [hasDistinctiveNameFallbackMatch, verifyCandidateCompanyGrounding, requireResolvedCandidate]) {
  assert(typeof fn === 'function', `extraction produced a real function (${fn && fn.name})`);
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

assert(
  requireResolvedCandidate(
    [{ accountName: 'Arthur J. Gallagher', url: 'https://news.example.com/real-candidate' }],
    { sourceUrl: 'https://news.example.com/a-url-no-candidate-discovered-for-this-account' },
    GALLAGHER
  ) === null,
  '3) a sourceUrl that resolves to no candidate discovered for the account is rejected (returns null, not {})'
);

assert(
  requireResolvedCandidate(
    [{ accountName: 'Avidia Bank', url: 'https://news.example.com/shared-page' }],
    { sourceUrl: 'https://news.example.com/shared-page' },
    GALLAGHER
  ) === null,
  '3b) a sourceUrl matching a DIFFERENT account\'s candidate does not cross-resolve to the requested account'
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
  '4) full "Arthur J. Gallagher & Co." reference is accepted'
);

assert(
  verifyCandidateCompanyGrounding({
    title: 'Insurance brokerage completes acquisition',
    snippet: 'Gallagher acquired Wilson M. Beck Insurance Services in a deal announced this week.',
    url: 'https://news.example.com/gallagher-shortname',
  }, GALLAGHER).grounded === true,
  '5) "Gallagher"-only reference is accepted via the narrow distinctive-name fallback'
);

assert(
  verifyCandidateCompanyGrounding({
    title: 'Wilson M. Beck Insurance Services joins new ownership',
    snippet: 'Wilson M. Beck Insurance Services, a New York-based agency, will operate as part of Gallagher\'s brokerage division following the transaction. Terms of the deal were not disclosed.',
    url: 'https://news.example.com/wilson-beck-acquisition',
  }, GALLAGHER).grounded === true,
  '6) Wilson M. Beck acquisition (Gallagher mentioned once, most evidence about the acquired company) is accepted'
);

assert(
  verifyCandidateCompanyGrounding({
    title: 'New CFO appointed to lead finance division',
    snippet: 'Arthur J. Gallagher & Co. announced today that Jane Smith has been appointed Chief Financial Officer effective immediately.',
    url: 'https://news.example.com/gallagher-cfo',
  }, GALLAGHER).grounded === true,
  '7) account name omitted from candidate title but present in query-scoped snippet is accepted'
);

assert(
  verifyCandidateCompanyGrounding({
    title: 'Arthur J Gallagher Ltd today announced a new partnership',
    snippet: 'The firm, formerly styled Arthur J. Gallagher & Co., confirmed the deal.',
    url: 'https://news.example.com/gallagher-punctuation',
  }, GALLAGHER).grounded === true,
  '8) punctuation/legal-suffix variations are accepted'
);

// ---------------------------------------------------------------------------
// Documented residual boundary: company grounding uses title+snippet only,
// and is unaffected by unrelated content in the full pageContent scrape.
// This is a deliberate scope limit (see the header comment above
// requireResolvedCandidate() in api/research-batch.js), not a claim that
// unrelated-event extraction from a mixed-content page is impossible.
// ---------------------------------------------------------------------------
assert(
  verifyCandidateCompanyGrounding({
    title: 'Arthur J. Gallagher & Co. announces new hires',
    snippet: 'The insurance brokerage firm announced several new leadership appointments across its Northeast division this week.',
    pageContent: 'In other regional news, Avidia Bank also announced a new Westborough branch opening today with a ribbon cutting ceremony, unrelated to the Gallagher appointments above.',
    url: 'https://news.example.com/mixed-page-gallagher-and-avidia',
  }, GALLAGHER).grounded === true,
  '9) mixed-page-scope: title+snippet correctly identify Gallagher and grounding is unaffected by unrelated Avidia content that exists only in pageContent'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
