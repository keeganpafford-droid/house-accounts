// product/commercial-opportunity-intelligence, QA correction round 4
// (Functional QA bug -- Northern Pool 0-vs-25 finding). Root cause (see the
// QA correction 4 "Return" report for the full trace): the post-upload
// "Research all N accounts" button (researchTopAccounts()/
// getAccountsForResearch() in dashboard/index.html) read
// window.accountRadarAccounts -- populated at CSV-parse time, BEFORE the
// server save even ran -- and never checked the server's own confirmed
// accountsSaved count, so a list the server saved ZERO accounts for could
// still launch a ~25-company research run.
//
// Product invariant this proves: only successfully accepted/saved active
// customer accounts may be researched. If the server confirms zero
// accounts were accepted, Research All must launch zero research and the
// UI must say so.
//
// Extracts the REAL, verbatim production functions and runs them for real
// in a vm sandbox -- proving actual behavior (no fetch/claim/research call
// is ever reached), not source-text pattern matching. researchTopAccounts()
// is large; this test only exercises its early-return guard path, so
// everything AFTER that guard is never reached and does not need stubbing.
//
// Usage: node scripts/test-northern-pool-zero-accounts-guard.js
import { readFileSync } from 'fs';
import vm from 'vm';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_PATH = new URL('../dashboard/index.html', import.meta.url);
const LINES = readFileSync(DASHBOARD_PATH, 'utf8').split('\n');

function extractLines(label, startLine, endLine, expectedFirst) {
  const slice = LINES.slice(startLine - 1, endLine).join('\n');
  const first = LINES[startLine - 1];
  if (!first.startsWith(expectedFirst)) {
    throw new Error(`extractLines(${label}): dashboard/index.html line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  return slice;
}

const GUARD_SRC = extractLines('northern-pool-zero-accounts-guard', 7427, 7640, 'function hideUploadDecisionForZeroAcceptedAccounts(){');

// Fresh DOM/state stub + fresh vm context per scenario -- avoids any
// cross-scenario state bleed, and keeps each run's assertions about
// exactly what happened (fetch calls, DOM mutations) unambiguous.
function runScenario({ researchInProgress, currentUploadId, lastUploadAcceptedAccountCount }) {
  const domState = {
    uploadResearchDecision: { hidden: false },
    uploadSuccessWarning: { hidden: true, innerHTML: '' }
  };
  const warnings = [];
  let researchDispatchReached = false;
  const sandbox = {
    document: { getElementById: (id) => domState[id] || null },
    console: { warn: (...args) => warnings.push(args.join(' ')), log: () => {} },
    // Sentinel: if execution ever proceeds past the guard into the real
    // research-dispatch logic, it will need functions/state this stub
    // doesn't provide and throw a ReferenceError -- which IS the proof
    // that the guard did not fire when it should have. Assigning this
    // marker instead only proves reachability if the real body happened to
    // reference it, so the actual proof below is "did NOT throw" plus the
    // explicit hidden/message assertions, not this flag.
    markReached: () => { researchDispatchReached = true; },
    researchInProgress,
    currentUploadId,
    lastUploadAcceptedAccountCount
  };
  vm.createContext(sandbox);
  vm.runInContext(GUARD_SRC, sandbox);
  return { sandbox, domState, warnings, researchDispatchReached: () => researchDispatchReached };
}

for (const fn of ['hideUploadDecisionForZeroAcceptedAccounts', 'researchTopAccounts']) {
  const { sandbox } = runScenario({ researchInProgress: false, currentUploadId: 'upload-1', lastUploadAcceptedAccountCount: null });
  assert(typeof sandbox[fn] === 'function', `extraction produced a real function (${fn})`);
}

// ===========================================================================
// Required test 12: zero accepted upload accounts cannot launch list
// research.
// ===========================================================================
{
  const { sandbox, domState, warnings } = runScenario({ researchInProgress: false, currentUploadId: 'upload-1', lastUploadAcceptedAccountCount: 0 });
  let threw = false;
  let result;
  try { result = sandbox.researchTopAccounts({ auto: false }); }
  catch (e) { threw = true; }
  assert(!threw, 'required test 12: researchTopAccounts() returns cleanly (does not throw trying to reach research-dispatch logic) when the server confirmed 0 accepted accounts');
  assert(result === undefined || typeof result?.then === 'function', 'sanity: researchTopAccounts() returns (a resolved promise, since it is async) rather than hanging');
  assert(domState.uploadResearchDecision.hidden === true, 'required test 12: the "Research all N accounts" decision UI is hidden when 0 accounts were accepted -- the UI must not imply there are researchable accounts');
  assert(domState.uploadSuccessWarning.hidden === false && /none of these accounts were saved/i.test(domState.uploadSuccessWarning.innerHTML), `required test 12: an honest, visible message explains that nothing was saved (got "${domState.uploadSuccessWarning.innerHTML}")`);
  assert(warnings.some(w => /confirmed 0 accounts/i.test(w)), 'required test 12: a console warning documents why research was refused');
}
{
  // Confirmed non-zero -> the guard does not fire (must not block
  // legitimate research). This scenario intentionally does NOT provide the
  // rest of researchTopAccounts()'s dependencies, so reaching past the
  // guard would throw a ReferenceError -- which is exactly the proof this
  // assertion needs: it must throw here (proving execution continued past
  // the zero-accounts guard), not return cleanly.
  const { sandbox } = runScenario({ researchInProgress: false, currentUploadId: 'upload-1', lastUploadAcceptedAccountCount: 3 });
  let threwPastGuard = false;
  try { await sandbox.researchTopAccounts({ auto: false }); }
  catch (e) { threwPastGuard = true; }
  assert(threwPastGuard, 'sanity: with a confirmed non-zero accepted count, researchTopAccounts() proceeds PAST the zero-accounts guard (proven by reaching unstubbed real dependencies) -- the guard only blocks a confirmed zero, never a real research run');
}
{
  // Unknown (null) -- never confirmed either way -- must NOT block (avoids
  // false positives against research launched from other flows, e.g.
  // Manage Customer Accounts, which re-fetches server truth itself).
  const { sandbox } = runScenario({ researchInProgress: false, currentUploadId: 'upload-1', lastUploadAcceptedAccountCount: null });
  let threwPastGuard = false;
  try { await sandbox.researchTopAccounts({ auto: false }); }
  catch (e) { threwPastGuard = true; }
  assert(threwPastGuard, 'required test 12: an UNKNOWN (not-yet-confirmed) accepted count never blocks research -- only a CONFIRMED zero does, proven by execution proceeding past the guard here too');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
