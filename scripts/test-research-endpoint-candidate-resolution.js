// Endpoint-specific candidate-RESOLUTION regression tests (Sprint 1 /
// Sprint 1 extension). The shared company-grounding rule itself
// (verifyCandidateCompanyGrounding()) is tested once, at its actual module
// boundary, in scripts/test-signal-account-evidence-grounding.js -- this
// file intentionally does not repeat those assertions. It only covers what
// genuinely differs per endpoint: HOW a signal's sourceUrl resolves to a
// discovered candidate.
//
//   - api/research-batch.js's requireResolvedCandidate() serves a
//     multi-account batch request, so it must also confirm the matched
//     candidate belongs to the REQUESTED account (a shared sourceUrl could
//     otherwise cross-resolve to a different account's candidate).
//   - api/research-account.js's resolveAccountCandidate() serves exactly
//     one account per request, so it needs no such filter -- every
//     candidate already belongs to the one account being researched.
//
// Both replaced a previous `find(...) || {}` (silent empty-object fallback,
// never rejecting) with a hard requirement (`|| null`, rejected upstream).
//
// Extracts the real, verbatim functions via a hardcoded contiguous line
// range from each file; if either file changes shape, extractLines() below
// throws instead of silently testing stale/wrong code.
//
// Usage: node scripts/test-research-endpoint-candidate-resolution.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function extractLines(filePath, label, startLine, endLine, expectedFirst) {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const first = lines[startLine - 1];
  if (!first || !first.startsWith(expectedFirst)) {
    throw new Error(`extractLines(${label}): ${filePath} line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  return lines.slice(startLine - 1, endLine).join('\n');
}

// --- api/research-batch.js: requireResolvedCandidate(candidates, mapped, account) ---
const RESEARCH_BATCH_PATH = path.join(__dirname, '..', 'api', 'research-batch.js');
const REQUIRE_RESOLVED_CANDIDATE_SRC = extractLines(RESEARCH_BATCH_PATH, 'requireResolvedCandidate', 2370, 2373, 'function requireResolvedCandidate(candidates, mapped, account) {');
const batchSandbox = {};
vm.createContext(batchSandbox);
vm.runInContext(`${REQUIRE_RESOLVED_CANDIDATE_SRC}\nthis.requireResolvedCandidate = requireResolvedCandidate;`, batchSandbox);
const { requireResolvedCandidate } = batchSandbox;
assert(typeof requireResolvedCandidate === 'function', 'extracted the real requireResolvedCandidate() from api/research-batch.js');

// --- api/research-account.js: resolveAccountCandidate(candidates, sourceUrl) ---
const RESEARCH_ACCOUNT_PATH = path.join(__dirname, '..', 'api', 'research-account.js');
const RESOLVE_ACCOUNT_CANDIDATE_SRC = extractLines(RESEARCH_ACCOUNT_PATH, 'resolveAccountCandidate', 1208, 1211, 'function resolveAccountCandidate(candidates, sourceUrl) {');
const accountSandbox = {};
vm.createContext(accountSandbox);
vm.runInContext(`${RESOLVE_ACCOUNT_CANDIDATE_SRC}\nthis.resolveAccountCandidate = resolveAccountCandidate;`, accountSandbox);
const { resolveAccountCandidate } = accountSandbox;
assert(typeof resolveAccountCandidate === 'function', 'extracted the real resolveAccountCandidate() from api/research-account.js');

const GALLAGHER = { name: 'Arthur J. Gallagher' };

// ---------------------------------------------------------------------------
// api/research-batch.js: requireResolvedCandidate()
// ---------------------------------------------------------------------------
assert(
  requireResolvedCandidate(
    [{ accountName: 'Arthur J. Gallagher', url: 'https://news.example.com/real-candidate' }],
    { sourceUrl: 'https://news.example.com/real-candidate' },
    GALLAGHER
  )?.url === 'https://news.example.com/real-candidate',
  'batch: a sourceUrl matching a real discovered candidate for the requested account resolves to it'
);

assert(
  requireResolvedCandidate(
    [{ accountName: 'Arthur J. Gallagher', url: 'https://news.example.com/real-candidate' }],
    { sourceUrl: 'https://news.example.com/a-url-no-candidate-discovered-for-this-account' },
    GALLAGHER
  ) === null,
  'batch: a sourceUrl that resolves to no candidate discovered for the account is rejected (returns null, not {})'
);

assert(
  requireResolvedCandidate(
    [{ accountName: 'Avidia Bank', url: 'https://news.example.com/shared-page' }],
    { sourceUrl: 'https://news.example.com/shared-page' },
    GALLAGHER
  ) === null,
  'batch: a sourceUrl matching a DIFFERENT account\'s candidate does not cross-resolve to the requested account'
);

// ---------------------------------------------------------------------------
// api/research-account.js: resolveAccountCandidate()
// ---------------------------------------------------------------------------
assert(
  resolveAccountCandidate(
    [{ url: 'https://news.example.com/real-candidate', title: 'Arthur J. Gallagher & Co. announces new hires' }],
    'https://news.example.com/real-candidate'
  )?.url === 'https://news.example.com/real-candidate',
  'account: a sourceUrl matching a real discovered candidate resolves to it (no accountName filter needed -- single account per request)'
);

assert(
  resolveAccountCandidate(
    [{ url: 'https://news.example.com/real-candidate' }],
    'https://news.example.com/a-url-no-candidate-discovered'
  ) === null,
  'account: a sourceUrl that resolves to no discovered candidate is rejected (returns null, not {})'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
