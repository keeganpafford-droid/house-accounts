// Trust correction: verified terminology / counting semantics.
//
// Product invariant (founder-specified):
//   Found / discovered signal   = research produced a legitimate candidate.
//   Verified signal / Opportunity = identityConfidence === 'confirmed',
//     strictly. An explicit 'unconfirmed' must never be counted or
//     described as verified. 'rejected' must never be seller-facing. A
//     true legacy row (identityConfidence missing entirely) is eligible to
//     display (unchanged grandfather policy -- see
//     hasConfirmedOrLegacyIdentity()) but must NOT be silently described as
//     verified merely because older code historically treated absence as
//     "not explicitly unconfirmed."
//
// This file drives the REAL, verbatim dashboard/index.html primitives
// (isExplicitlyVerifiedIdentity(), dedupeFoundSignals(),
// foundAndVerifiedSuffix(), getRecentlyResearchedAccounts(),
// renderRecentlyResearchedSection()) extracted into a vm sandbox -- not a
// reimplementation of the counting logic. renderVerifiedOpportunitySection()'s
// own heading fix has its dedicated regression already in
// scripts/test-trust-correction-dashboard-gating.js (items 12a-12c); this
// file focuses on the counting/toast-wording model that test does not
// cover.
//
// Usage: node scripts/test-trust-correction-verified-terminology.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();


// Real, verbatim primitives this sprint added/renamed, plus their own
// dependency chain.
const CORE_SRC = [
  extractFn(DASHBOARD_SRC, 'sourceDomain'),
  extractFn(DASHBOARD_SRC, 'foundSignalDedupeKey'),
  extractFn(DASHBOARD_SRC, 'dedupeFoundSignals'),
  extractFn(DASHBOARD_SRC, 'hasConfirmedOrLegacyIdentity'),
  extractFn(DASHBOARD_SRC, 'isExplicitlyVerifiedIdentity'),
  extractFn(DASHBOARD_SRC, 'foundAndVerifiedSuffix')
].join('\n\n');

function makeCoreSandbox() {
  const sandbox = { console, Array, Object, String, Number, Boolean, JSON, URL, Map };
  vm.createContext(sandbox);
  new vm.Script(CORE_SRC, { filename: 'verified-terminology-core-extract.js' }).runInContext(sandbox);
  return sandbox;
}

// Real, verbatim Recently Researched pipeline -- everything OUTSIDE this
// sprint's own scope (dismissal, active-opportunity eligibility) is
// stubbed as a harmless pass-through, matching the established pattern in
// scripts/test-research-run-reattachment.js.
const RR_SRC = [
  extractFn(DASHBOARD_SRC, 'sourceDomain'),
  extractFn(DASHBOARD_SRC, 'foundSignalDedupeKey'),
  extractFn(DASHBOARD_SRC, 'dedupeFoundSignals'),
  extractFn(DASHBOARD_SRC, 'isExplicitlyVerifiedIdentity'),
  extractFn(DASHBOARD_SRC, 'getRecentlyResearchedAccounts'),
  extractFn(DASHBOARD_SRC, 'relativeResearchTimeLabel'),
  extractFn(DASHBOARD_SRC, 'renderRecentlyResearchedSection')
].join('\n\n');

function makeRecentlyResearchedSandbox(accounts) {
  const sandbox = {
    console, Array, Object, String, Number, Boolean, JSON, URL, Map, Date,
    window: { accountRadarAccounts: accounts },
    RECENTLY_RESEARCHED_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
    isResearchResultDismissed: () => false,
    priorityEligibleOpportunities: (opps) => opps || [],
    dedupeOpportunities: (opps) => opps || [],
    collapseDuplicateAccountHistorySignals: (opps) => opps || [],
    escapeHtml: (s) => String(s == null ? '' : s),
    document: { getElementById: () => ({ hidden: false, innerHTML: '' }) }
  };
  vm.createContext(sandbox);
  new vm.Script(RR_SRC, { filename: 'verified-terminology-recently-researched-extract.js' }).runInContext(sandbox);
  return sandbox;
}

const confirmedSignal = { isReal: true, sourceUrl: 'https://dovernh.org/parade', signalType: 'Community', signalTitle: 'Holiday Parade', identityConfidence: 'confirmed', confidenceScore: 66 };
const unconfirmedSignal = { isReal: true, sourceUrl: 'https://example.com/presidents-award', signalType: 'Award', signalTitle: "Presidents' Award", identityConfidence: 'unconfirmed', confidenceScore: 60 };
const rejectedSignal = { isReal: true, sourceUrl: 'https://example.com/wrong-company', signalType: 'Rebrand', signalTitle: 'Rebrand', identityConfidence: 'rejected', confidenceScore: 74 };
const legacySignal = { isReal: true, sourceUrl: 'https://example.com/legacy', signalType: 'Rebrand', signalTitle: 'Legacy Rebrand', confidenceScore: 74 }; // no identityConfidence at all

// ---------------------------------------------------------------------------
// Core primitive contrast: hasConfirmedOrLegacyIdentity() (eligibility) vs
// isExplicitlyVerifiedIdentity() (verified-labeling) must disagree on a
// legacy row -- that disagreement IS the fix.
// ---------------------------------------------------------------------------
{
  const s = makeCoreSandbox();
  assert(s.hasConfirmedOrLegacyIdentity(legacySignal) === true, 'sanity: a legacy signal (no identityConfidence) remains ELIGIBLE -- unchanged grandfather policy');
  assert(s.isExplicitlyVerifiedIdentity(legacySignal) === false, '5) a legacy signal (no identityConfidence) is NOT explicitly verified -- eligibility and verified-labeling are genuinely different questions');
  assert(s.isExplicitlyVerifiedIdentity(confirmedSignal) === true, 'sanity: an explicitly confirmed signal IS explicitly verified');
  assert(s.isExplicitlyVerifiedIdentity(unconfirmedSignal) === false, '3) an explicitly unconfirmed signal is never counted as verified');
  assert(s.isExplicitlyVerifiedIdentity(rejectedSignal) === false, '4) a rejected signal is never counted as verified');
}

// ---------------------------------------------------------------------------
// 1) one confirmed + one unconfirmed signal returned -> the UI's own
// verified count must be exactly 1, never 2 -- it cannot say "2 verified
// signals."
// ---------------------------------------------------------------------------
{
  const s = makeCoreSandbox();
  const mixed = [confirmedSignal, unconfirmedSignal];
  const found = s.dedupeFoundSignals(mixed);
  assert(found.length === 2, `1) both signals survive the FOUND dedup -- found count is 2, not silently reduced (got ${found.length})`);
  const verifiedCount = found.filter(s.isExplicitlyVerifiedIdentity).length;
  assert(verifiedCount === 1, `1) the verified count is exactly 1, not 2 -- the UI cannot say "2 verified signals" for this mix (got ${verifiedCount})`);
  assert(s.foundAndVerifiedSuffix(mixed) === ' · 1 verified', `1) foundAndVerifiedSuffix() reports exactly "1 verified" for a mixed confirmed+unconfirmed pair (got "${s.foundAndVerifiedSuffix(mixed)}")`);
}

// ---------------------------------------------------------------------------
// 2) confirmed only -> one verified.
// ---------------------------------------------------------------------------
{
  const s = makeCoreSandbox();
  assert(s.foundAndVerifiedSuffix([confirmedSignal]) === ' · 1 verified', '2) a single confirmed signal reports "1 verified"');
}

// ---------------------------------------------------------------------------
// 3) unconfirmed only -> signal found, zero verified (no verified claim at
// all, positive or negative -- per the founder's own "avoid noisy trust
// labels everywhere" guidance).
// ---------------------------------------------------------------------------
{
  const s = makeCoreSandbox();
  const found = s.dedupeFoundSignals([unconfirmedSignal]);
  assert(found.length === 1, '3) the unconfirmed signal is still found/discovered (found count is 1)');
  assert(s.foundAndVerifiedSuffix([unconfirmedSignal]) === '', '3) foundAndVerifiedSuffix() adds nothing at all for an unconfirmed-only result -- no "0 verified" noise, just silence');
}

// ---------------------------------------------------------------------------
// 4) rejected -> not counted (defense in depth: even if one somehow reached
// this layer, it must never contribute to the verified count).
// ---------------------------------------------------------------------------
{
  const s = makeCoreSandbox();
  assert(s.foundAndVerifiedSuffix([rejectedSignal]) === '', '4) a rejected signal contributes nothing to the verified count');
}

// ---------------------------------------------------------------------------
// 5) legacy missing identityConfidence -> does not falsely increment an
// explicit verified count (covered above via isExplicitlyVerifiedIdentity()
// directly; re-proven here through the actual counting helper).
// ---------------------------------------------------------------------------
{
  const s = makeCoreSandbox();
  assert(s.foundAndVerifiedSuffix([legacySignal]) === '', '5) a legacy signal (no identityConfidence) never increments the verified count');
  assert(s.foundAndVerifiedSuffix([legacySignal, confirmedSignal]) === ' · 1 verified', '5) mixed legacy + confirmed reports exactly 1 verified, not 2 -- legacy never silently joins the confirmed tally');
}

// ---------------------------------------------------------------------------
// 6) Dover live-shaped fixture: Parade confirmed + Presidents' Award
// unconfirmed -> two signals found, one verified.
// ---------------------------------------------------------------------------
{
  const s = makeCoreSandbox();
  const doverSignals = [confirmedSignal, unconfirmedSignal]; // Parade (confirmed) + Presidents' Award (unconfirmed)
  const found = s.dedupeFoundSignals(doverSignals);
  assert(found.length === 2, `6) Dover fixture: two signals found (got ${found.length})`);
  assert(s.foundAndVerifiedSuffix(doverSignals) === ' · 1 verified', `6) Dover fixture: exactly one verified (got "${s.foundAndVerifiedSuffix(doverSignals)}")`);
}

// ---------------------------------------------------------------------------
// 7) Recently Researched uses the SAME semantics -- real
// getRecentlyResearchedAccounts()/renderRecentlyResearchedSection(), fed
// the exact Dover-shaped account.
// ---------------------------------------------------------------------------
{
  const doverAccount = {
    uploadId: 'upload-dover', name: 'Dover Honda',
    lastResearchedAt: new Date().toISOString(),
    signals: [confirmedSignal, unconfirmedSignal],
    futureOpportunities: []
  };
  const s = makeRecentlyResearchedSandbox([doverAccount]);
  const entries = s.getRecentlyResearchedAccounts();
  assert(entries.length === 1, `7) Dover Honda appears in Recently Researched (got ${entries.length} entries)`);
  assert(entries[0].signalCount === 2, `7) signalCount is 2 (both discovered signals) (got ${entries[0].signalCount})`);
  assert(entries[0].verifiedCount === 1, `7) verifiedCount is exactly 1 (only the confirmed Parade signal) (got ${entries[0].verifiedCount})`);

  const host = { hidden: true, innerHTML: '' };
  s.document = { getElementById: () => host };
  // Re-run inside the same sandbox context via a fresh call (document was
  // captured at extraction time as a reference the function closure reads
  // through globalThis -- reassigning the sandbox's own document property
  // before calling is sufficient since these are plain global functions).
  vm.createContext(s);
  s.renderRecentlyResearchedSection();
  assert(/2 signals found/.test(host.innerHTML), `7) the rendered Recently Researched card says "2 signals found" (got: ${host.innerHTML.slice(0, 200)})`);
  assert(/1 verified/.test(host.innerHTML), '7) the rendered card also shows "1 verified" -- the same found/verified split as every other entry point');
  assert(!/2 verified/.test(host.innerHTML), '7) the rendered card never says "2 verified" -- the exact original bug this sprint fixes');
}

// ---------------------------------------------------------------------------
// 8) all research entry points use consistent language -- both
// researchAccountFromCard() and handleResearchClick()'s two call sites
// route through the SAME shared foundAndVerifiedSuffix() helper, proven by
// static inspection of the real source rather than duplicating the
// assertion's own wording model per call site (which is exactly how this
// bug class recurred across three call sites before this sprint).
// ---------------------------------------------------------------------------
{
  const callSites = [
    { label: 'researchAccountFromCard()', pattern: /const toastMessage = signalCount\s*\n\s*\?\s*`\$\{signalCount\} signal\$\{signalCount === 1 \? '' : 's'\} found for \$\{accountName\}\$\{foundAndVerifiedSuffix\(fresh\.signals\)\}\.`/ },
    { label: 'handleResearchClick() setRowStatus', pattern: /setRowStatus\(row, 'success', signalCount\s*\n\s*\?\s*`Research complete — \$\{signalCount\} signal\$\{signalCount===1\?'':'s'\} found\$\{typeof foundAndVerifiedSuffix === 'function' \? foundAndVerifiedSuffix\(fresh\.signals\) : ''\}\.`/ },
    { label: 'handleResearchClick() toast', pattern: /const toastMessage = signalCount\s*\n\s*\?\s*`\$\{signalCount\} signal\$\{signalCount===1\?'':'s'\} found for \$\{accountName\}\$\{typeof foundAndVerifiedSuffix === 'function' \? foundAndVerifiedSuffix\(fresh\.signals\) : ''\}\.`/ }
  ];
  for (const { label, pattern } of callSites) {
    assert(pattern.test(DASHBOARD_SRC), `8) ${label} routes its research-completion message through the shared foundAndVerifiedSuffix() helper, not its own independently-worded verified count`);
  }
  // Negative control: no research-completion toast/status message anywhere
  // in the file still uses the pre-sprint "N verified signal(s) found"
  // phrasing this bug class was built from.
  assert(!/\d?\}?\s*verified signal\$\{.*found/.test(DASHBOARD_SRC), '8) no remaining call site inlines its own "N verified signal(s) found" phrasing');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
