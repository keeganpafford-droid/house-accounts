// ux/research-control-progress: unit tests for the shared client-side
// research start/stop/progress tracker module in dashboard/index.html
// (startResearchTracker()/markResearchAccountStarted()/markResearchAccountDone()/
// markResearchGroupDone()/requestResearchStop()/researchTrackerSnapshot()/
// researchTrackerAccountState()). Extracts the real, verbatim module
// (a single contiguous block) and runs it for real in a vm sandbox --
// self-contained, no DOM/fetch dependencies, so no stubbing beyond the
// native globals (Map, Set, AbortController, setTimeout/clearTimeout) it
// actually uses.
//
// Covers required tests 8/9 from the ux/research-control-progress sprint:
// progress counts must reflect real per-account state (never a fake/
// animated bar), and complete/failed/stopped outcomes must terminate the
// progress UI correctly (a "finished" run, not one stuck showing
// "researching" forever).
//
// Usage: node scripts/test-research-control-tracker.js
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
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const LINES = readFileSync(DASHBOARD_PATH, 'utf8').split('\n');

function extractLines(label, startLine, endLine, expectedFirst) {
  const first = LINES[startLine - 1];
  if (!first || !first.startsWith(expectedFirst)) {
    throw new Error(`extractLines(${label}): dashboard/index.html line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  return LINES.slice(startLine - 1, endLine).join('\n');
}

const TRACKER_SRC = extractLines('research-tracker-module', 7670, 7784, 'const researchRunTrackers = new Map();');
const PROGRESS_LABEL_SRC = extractLines('researchProgressLabel', 7790, 7805, 'function researchProgressLabel(snap){');

const sandbox = { Map, Set, AbortController, setTimeout, clearTimeout, console: { warn(){} } };
vm.createContext(sandbox);
vm.runInContext(`${TRACKER_SRC}
${PROGRESS_LABEL_SRC}
this.researchProgressLabel = researchProgressLabel;
this.startResearchTracker = startResearchTracker;
this.getResearchTracker = getResearchTracker;
this.finishResearchTracker = finishResearchTracker;
this.registerResearchAbort = registerResearchAbort;
this.unregisterResearchAbort = unregisterResearchAbort;
this.markResearchAccountStarted = markResearchAccountStarted;
this.markResearchAccountDone = markResearchAccountDone;
this.markResearchGroupDone = markResearchGroupDone;
this.requestResearchStop = requestResearchStop;
this.isResearchStopRequested = isResearchStopRequested;
this.onResearchTrackerChange = onResearchTrackerChange;
this.researchTrackerSnapshot = researchTrackerSnapshot;
this.researchTrackerAccountState = researchTrackerAccountState;
`, sandbox);

const {
  startResearchTracker, getResearchTracker, finishResearchTracker,
  registerResearchAbort, unregisterResearchAbort,
  markResearchAccountStarted, markResearchAccountDone, markResearchGroupDone,
  requestResearchStop, isResearchStopRequested, onResearchTrackerChange,
  researchTrackerSnapshot, researchTrackerAccountState, researchProgressLabel
} = sandbox;

for (const fn of [startResearchTracker, markResearchAccountStarted, markResearchAccountDone, markResearchGroupDone, requestResearchStop, researchTrackerSnapshot, researchTrackerAccountState]) {
  assert(typeof fn === 'function', `extraction produced a real function (${fn && fn.name})`);
}

// ---------------------------------------------------------------------------
// Required test 8: progress counts reflect real per-account state.
// ---------------------------------------------------------------------------
{
  startResearchTracker('upload-a', ['Acme', 'Bravo', 'Charlie', 'Delta'], { label: 'Test List' });
  let snap = researchTrackerSnapshot('upload-a');
  assert(snap.total === 4 && snap.completed === 0 && snap.researching === 0 && snap.remaining === 4, `fresh tracker starts at 0 completed, 4 remaining (got ${JSON.stringify(snap)})`);

  markResearchAccountStarted('upload-a', 'Acme');
  snap = researchTrackerSnapshot('upload-a');
  assert(snap.researching === 1 && snap.remaining === 3 && snap.completed === 0, `starting one account moves it from remaining to researching, not completed (got ${JSON.stringify(snap)})`);
  assert(researchTrackerAccountState('upload-a', 'Acme') === 'researching', 'per-account state reports "researching" for the started account');
  assert(researchTrackerAccountState('upload-a', 'Bravo') === 'queued', 'per-account state reports "queued" for an account not yet started');

  markResearchAccountDone('upload-a', 'Acme', { opportunities: 2 });
  snap = researchTrackerSnapshot('upload-a');
  assert(snap.completed === 1 && snap.researching === 0 && snap.remaining === 3 && snap.opportunitiesFound === 2, `completing an account with 2 opportunities updates completed/opportunitiesFound (got ${JSON.stringify(snap)})`);
  assert(researchTrackerAccountState('upload-a', 'Acme') === 'complete', 'per-account state reports "complete" after a successful completion');

  markResearchAccountStarted('upload-a', 'Bravo');
  markResearchAccountDone('upload-a', 'Bravo', { failed: true });
  snap = researchTrackerSnapshot('upload-a');
  assert(snap.failed === 1 && snap.completed === 2 && snap.remaining === 2, `a failed account counts toward "completed" (settled) but is separately tracked as failed (got ${JSON.stringify(snap)})`);
  assert(researchTrackerAccountState('upload-a', 'Bravo') === 'failed', 'per-account state reports "failed"');

  markResearchGroupDone('upload-a', ['Charlie', 'Delta'], { opportunities: 5 });
  snap = researchTrackerSnapshot('upload-a');
  assert(snap.completed === 4 && snap.remaining === 0 && snap.opportunitiesFound === 7, `a whole-group completion (the enhanced/warm-mixed batch call shape) settles every named account at once and adds its total opportunities (got ${JSON.stringify(snap)})`);
}

// ---------------------------------------------------------------------------
// Required test 9: complete/failed/stopped states terminate the progress UI
// correctly -- a run must not linger showing "researching" forever once
// every account has settled.
// ---------------------------------------------------------------------------
{
  startResearchTracker('upload-b', ['OnlyAccount'], { label: 'Single' });
  let snap = researchTrackerSnapshot('upload-b');
  assert(snap.finished === false, 'a freshly started tracker is not finished');
  markResearchAccountDone('upload-b', 'OnlyAccount', { opportunities: 1 });
  finishResearchTracker('upload-b');
  snap = researchTrackerSnapshot('upload-b');
  assert(snap.finished === true, 'finishResearchTracker() marks the run finished');
  assert(snap.completed === 1 && snap.remaining === 0, 'a finished run reports 100% settled, zero remaining');
  assert(getResearchTracker('upload-b') !== null, 'the tracker is still readable immediately after finishing (not instantly cleared, so a completed progress UI is actually visible for a moment)');
}
{
  // Stopped-mid-run: some accounts complete, the rest are marked stopped --
  // the run must still terminate (finished), not remain stuck "researching".
  startResearchTracker('upload-c', ['One', 'Two', 'Three'], { label: 'Stopped List' });
  markResearchAccountDone('upload-c', 'One', { opportunities: 1 });
  requestResearchStop('upload-c');
  assert(isResearchStopRequested('upload-c') === true, 'requestResearchStop() sets the stop flag this tracker\'s uploadId reports');
  markResearchAccountDone('upload-c', 'Two', { stopped: true });
  markResearchAccountDone('upload-c', 'Three', { stopped: true });
  finishResearchTracker('upload-c');
  const snap = researchTrackerSnapshot('upload-c');
  assert(snap.finished === true, 'a stopped run still terminates (finished:true), never left stuck mid-progress');
  // snapshot.completed is the aggregate SETTLED count (real completions +
  // failed + stopped) used for the progress bar's "X of Y complete" -- the
  // breakdown of WHICH kind is reported separately via snap.stopped/failed.
  assert(snap.completed === 3 && snap.stopped === 2 && snap.remaining === 0, `one real completion plus two stopped accounts settles the whole run (got ${JSON.stringify(snap)})`);
}

// ---------------------------------------------------------------------------
// Stop semantics: requestResearchStop() aborts every registered controller
// for that uploadId (the mechanism list/individual Stop controls rely on),
// and never touches a DIFFERENT upload's tracker.
// ---------------------------------------------------------------------------
{
  startResearchTracker('upload-d', ['X', 'Y']);
  startResearchTracker('upload-e', ['Z']);
  let aborted = { x: false, y: false, z: false };
  const ctrlX = { abort(){ aborted.x = true; } };
  const ctrlY = { abort(){ aborted.y = true; } };
  const ctrlZ = { abort(){ aborted.z = true; } };
  registerResearchAbort('upload-d', 'X', ctrlX);
  registerResearchAbort('upload-d', 'Y', ctrlY);
  registerResearchAbort('upload-e', 'Z', ctrlZ);
  requestResearchStop('upload-d');
  assert(aborted.x === true && aborted.y === true, 'requestResearchStop() aborts every registered controller for the stopped uploadId');
  assert(aborted.z === false, 'requestResearchStop() never aborts a DIFFERENT upload\'s in-flight controllers');
  assert(isResearchStopRequested('upload-e') === false, 'a different upload\'s stopRequested flag is untouched by another upload\'s stop');
  unregisterResearchAbort('upload-d', 'X');
  // Unregistering then re-requesting stop must not throw or re-abort.
  requestResearchStop('upload-d');
}

// ---------------------------------------------------------------------------
// Change notifications: onResearchTrackerChange() fires on every mutating
// call (this is what lets the Manage Accounts modal/main dashboard progress
// UI update live instead of only on the next poll).
// ---------------------------------------------------------------------------
{
  let fired = 0;
  const unsubscribe = onResearchTrackerChange(() => { fired += 1; });
  startResearchTracker('upload-f', ['One']);
  markResearchAccountStarted('upload-f', 'One');
  markResearchAccountDone('upload-f', 'One', {});
  assert(fired >= 3, `onResearchTrackerChange() listeners fire on tracker mutations (got ${fired} notifications for 3 mutating calls)`);
  unsubscribe();
  const before = fired;
  markResearchAccountStarted('upload-f', 'One');
  assert(fired === before, 'unsubscribing actually stops further notifications');
}

// ---------------------------------------------------------------------------
// QA correction 2: a run's user-facing title/count must never call stopped
// accounts "complete". researchProgressLabel() is the single shared helper
// both progress surfaces (Manage Accounts panel, dashboard mini indicator)
// call, so proving it here proves both.
// ---------------------------------------------------------------------------
{
  // Fully stopped: 10 of 10 stopped, zero real completions.
  const allStopped = { completed: 10, total: 10, failed: 0, stopped: 10, finished: true };
  const label = researchProgressLabel(allStopped);
  assert(label.title === 'Research stopped', `an all-stopped finished run is titled "Research stopped", never "Research complete" (got "${label.title}")`);
  assert(label.countLine === '10 stopped', `an all-stopped run's count line reads "10 stopped", not "10 of 10 complete" (got "${label.countLine}")`);
}
{
  // Partially stopped: 4 real completions, 6 stopped.
  const partial = { completed: 10, total: 10, failed: 0, stopped: 6, finished: true };
  const label = researchProgressLabel(partial);
  assert(label.title === 'Research stopped', `a partially-stopped finished run is also titled "Research stopped" (got "${label.title}")`);
  assert(label.countLine === '4 completed · 6 stopped', `a partially-stopped run's count line distinguishes completed from stopped (got "${label.countLine}")`);
}
{
  // A clean finish with no stop must be entirely unaffected by this fix.
  const clean = { completed: 5, total: 5, failed: 0, stopped: 0, finished: true };
  const label = researchProgressLabel(clean);
  assert(label.title === 'Research complete', `a run with no stopped accounts is still titled "Research complete" (got "${label.title}")`);
  assert(label.countLine === '5 of 5 complete', `a clean finished run keeps the original "N of N complete" count line (got "${label.countLine}")`);
}
{
  // A run still in progress (not finished) must also be unaffected.
  const inProgress = { completed: 2, total: 5, failed: 0, stopped: 0, finished: false };
  const label = researchProgressLabel(inProgress);
  assert(label.title === 'Researching accounts', `an in-progress run keeps its original title (got "${label.title}")`);
  assert(label.countLine === '2 of 5 complete', `an in-progress run keeps its original "N of N complete" count line (got "${label.countLine}")`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
