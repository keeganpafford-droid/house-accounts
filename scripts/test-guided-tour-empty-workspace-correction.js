// Final bounded Beta correction (guided-tour empty-workspace fix): proves
// the deferred-continuation behavior for a brand-new, zero-data workspace.
// Extracts the REAL, verbatim source of the guided-tour engine and
// applyPopulatedWorkspaceState() via the shared semantic extractor
// (extractFn/extractRange) and runs them against a minimal fake DOM/
// localStorage sandbox -- proving actual behavior (which steps run, what
// gets persisted, when the tour resumes), not source-text pattern matching.
//
// Required regressions:
//   1. Empty workspace does not show steps 3-5.
//   2. Populated workspace can show all five.
//   3. A pending (deferred) tour resumes at step 3 after population.
//   4. Completion/skip state still behaves normally.
//
// Usage: node scripts/test-guided-tour-empty-workspace-correction.js
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

const SRC = [
  extractFn(DASHBOARD_SRC, 'applyPopulatedWorkspaceState'),
  extractRange(DASHBOARD_SRC, "const GUIDED_TOUR_STORAGE_PREFIX = 'ha_guided_tour_v1::';", 'function wireGuidedTourControls(){')
].join('\n\n');

// ---------------------------------------------------------------------------
// Minimal fake DOM -- only what the extracted functions above actually
// touch. document.querySelector() always returns null (every step target
// is treated as "not currently on screen"), which is deliberately
// sufficient here: this file proves WHICH steps run and WHEN the tour
// resumes/persists state, not spotlight geometry (already covered by
// test-guided-tour-and-import-experience.js's dedicated positioning tests).
// ---------------------------------------------------------------------------
function makeElement(id) {
  const classes = new Set();
  return {
    id,
    _classes: classes,
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: c => classes.has(c)
    },
    style: {},
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    disabled: false,
    hidden: false,
    focus() {},
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; }
  };
}

function makeSandbox({ hasUploadedData = false, initialState = null } = {}) {
  const elements = {};
  ['haTourOverlay', 'haTourSpotlight', 'haTourCard', 'haTourEyebrow', 'haTourTitle', 'haTourBody', 'haTourDots', 'haTourSkipBtn', 'haTourBackBtn', 'haTourNextBtn'].forEach(id => {
    elements[id] = makeElement(id);
  });
  const fakeDocument = {
    body: { style: {} },
    documentElement: { style: {} },
    activeElement: null,
    getElementById: id => elements[id] || null,
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {}
  };
  const localStorageStore = {};
  if (initialState) localStorageStore['ha_guided_tour_v1::anonymous'] = JSON.stringify(initialState);
  const fakeLocalStorage = {
    getItem: k => (Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null),
    setItem: (k, v) => { localStorageStore[k] = String(v); },
    removeItem: k => { delete localStorageStore[k]; }
  };
  const fakeWindow = {
    location: { hash: '', href: 'https://app.example.com/dashboard/' },
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    pageYOffset: 0,
    scrollTo() {},
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ position: 'static' }),
    history: { replaceState() {} },
    accountRadarAccounts: hasUploadedData ? [{ name: 'Sample Co', uploadId: 'sample-upload' }] : []
  };
  const sandbox = {
    document: fakeDocument,
    window: fakeWindow,
    localStorage: fakeLocalStorage,
    console,
    URL,
    Array, Object, String, Number, Math, Date, JSON, Boolean,
    requestAnimationFrame: fn => fn()
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { launchGuidedTour, closeGuidedTour, nextGuidedTourStep, backGuidedTourStep, skipGuidedTour, finishGuidedTour, maybeResumeGuidedTourAfterPopulation, applyPopulatedWorkspaceState, wireGuidedTourControls, guidedTourStatus, markGuidedTourStatus, readGuidedTourState, writeGuidedTourState, GUIDED_TOUR_STEPS };`, { filename: 'guided-tour-empty-workspace-extract.js' }).runInContext(sandbox);
  return { dash: sandbox.__exports, elements, fakeWindow, localStorageStore };
}

// ===========================================================================
// Sanity: extraction produced real functions.
// ===========================================================================
{
  const { dash } = makeSandbox();
  for (const name of ['launchGuidedTour', 'nextGuidedTourStep', 'finishGuidedTour', 'maybeResumeGuidedTourAfterPopulation', 'applyPopulatedWorkspaceState', 'skipGuidedTour']) {
    assert(typeof dash[name] === 'function', `sanity: dashboard/index.html export "${name}" extracted successfully as a real function`);
  }
  assert(dash.GUIDED_TOUR_STEPS.length === 5, 'sanity: GUIDED_TOUR_STEPS still has all 5 canonical steps');
}

// ===========================================================================
// Required regression 1: empty workspace does not show steps 3-5.
// ===========================================================================
{
  const { dash, elements } = makeSandbox({ hasUploadedData: false });
  dash.launchGuidedTour();
  assert(elements.haTourTitle.textContent === 'Add Customer Data', 'REQUIRED 1: an empty workspace still opens on step 1');
  dash.nextGuidedTourStep();
  assert(elements.haTourTitle.textContent === 'Upload Guides', 'REQUIRED 1: an empty workspace still shows step 2');
  assert(elements.haTourNextBtn.textContent === 'Finish', 'REQUIRED 1: the Next button reads "Finish" after step 2 for an empty workspace -- there is no step 3 to advance to this run');
  dash.nextGuidedTourStep();
  assert(elements.haTourTitle.textContent === 'Upload Guides', 'REQUIRED 1: clicking Finish after step 2 does NOT advance to step 3 (Your Accounts) -- an empty workspace truly stops at step 2');
  assert(dash.guidedTourStatus() !== 'completed', 'REQUIRED 1: finishing the truncated (steps 1-2) run does not mark the WHOLE tour "completed" -- steps 3-5 are still owed');
  const state = dash.readGuidedTourState();
  assert(state.status === 'pending-resume' && state.pendingResumeStep === 2, `REQUIRED 1: the remainder (steps 3-5, starting at index 2) is marked pending-resume (got ${JSON.stringify(state)})`);
}

// ===========================================================================
// Required regression 2: populated workspace can show all five.
// ===========================================================================
{
  const { dash, elements } = makeSandbox({ hasUploadedData: true });
  dash.launchGuidedTour();
  const titles = ['Add Customer Data'];
  for (let i = 0; i < 4; i++) {
    dash.nextGuidedTourStep();
    titles.push(elements.haTourTitle.textContent);
  }
  assert(titles.join('|') === ['Add Customer Data', 'Upload Guides', 'Your Accounts', "This Week's Priorities", 'Prepare for Call'].join('|'), `REQUIRED 2: a populated workspace runs all 5 steps in order (got: ${titles.join(', ')})`);
  assert(elements.haTourNextBtn.textContent === 'Finish', 'REQUIRED 2: Next reads "Finish" on the real final (5th) step for a populated workspace');
  dash.nextGuidedTourStep();
  assert(dash.guidedTourStatus() === 'completed', 'REQUIRED 2: finishing all 5 steps marks the tour "completed" (not a pending-resume) for a populated workspace');
}

// ===========================================================================
// Required regression 3: a pending tour resumes at step 3 after population.
// ===========================================================================
{
  // Simulates: the tour already ran its truncated 1-2 pass on a previous
  // page load/session (pending-resume already persisted), and the account
  // now has just uploaded its first data.
  const { dash, elements, fakeWindow } = makeSandbox({
    hasUploadedData: false,
    initialState: { status: 'pending-resume', pendingResumeStep: 2, updatedAt: new Date().toISOString() }
  });
  assert(dash.guidedTourStatus() !== 'completed' && dash.guidedTourStatus() !== 'skipped', 'sanity: the fixture starts with a genuine pending-resume marker, not already settled');
  // The upload just completed -- the real workspace now has data, and
  // applyPopulatedWorkspaceState() (the one authoritative post-upload hook)
  // runs, exactly as it would after a real save-upload round trip.
  fakeWindow.accountRadarAccounts = [{ name: 'Newly Uploaded Co', uploadId: 'first-upload' }];
  dash.applyPopulatedWorkspaceState();
  assert(elements.haTourOverlay._classes.has('active'), 'REQUIRED 3: the tour automatically reopens once the workspace is populated');
  assert(elements.haTourTitle.textContent === 'Your Accounts', 'REQUIRED 3: the resumed tour opens directly on step 3 (Your Accounts), not step 1');
  assert(elements.haTourBackBtn.disabled === false, 'REQUIRED 3: Back is enabled on a resumed step 3 (there ARE earlier steps in this full run, unlike a fresh step-1 launch)');
  // The resumed run uses the FULL step list -- Next from step 3 reaches
  // step 4, not "Finish".
  assert(elements.haTourNextBtn.textContent === 'Next', 'REQUIRED 3: the resumed run knows about all 5 steps -- Next still reads "Next" on step 3, not "Finish"');
  dash.nextGuidedTourStep();
  assert(elements.haTourTitle.textContent === "This Week's Priorities", 'REQUIRED 3: the resumed run advances through the remaining real steps (4)');
  dash.nextGuidedTourStep();
  assert(elements.haTourTitle.textContent === 'Prepare for Call', 'REQUIRED 3: the resumed run reaches the real final step (5)');
  dash.nextGuidedTourStep();
  assert(dash.guidedTourStatus() === 'completed', 'REQUIRED 3: finishing a resumed run marks the tour genuinely "completed"');

  // The pending marker must never re-fire -- a second populate call (e.g. a
  // later silent dashboard refresh) must not relaunch the tour again.
  const { dash: dash2, elements: elements2, fakeWindow: fakeWindow2 } = makeSandbox({
    hasUploadedData: true,
    initialState: { status: 'pending-resume', pendingResumeStep: 2, updatedAt: new Date().toISOString() }
  });
  dash2.applyPopulatedWorkspaceState();
  assert(elements2.haTourOverlay._classes.has('active'), 'sanity: the tour resumed once, as expected');
  dash2.closeGuidedTour();
  dash2.applyPopulatedWorkspaceState();
  assert(!elements2.haTourOverlay._classes.has('active'), 'REQUIRED: the pending marker is cleared after the first resume -- a later applyPopulatedWorkspaceState() call never relaunches the tour a second time');
}

// ===========================================================================
// Required regression 4: completion/skip state still behaves normally.
// ===========================================================================
{
  // A populated workspace's full-tour Finish still behaves exactly as
  // before this correction.
  const { dash } = makeSandbox({ hasUploadedData: true });
  dash.launchGuidedTour();
  for (let i = 0; i < 4; i++) dash.nextGuidedTourStep();
  dash.nextGuidedTourStep();
  assert(dash.guidedTourStatus() === 'completed', 'REQUIRED 4: Finish on a populated, full-length run still persists "completed", unchanged');
}
{
  // Skip during an empty-workspace (truncated) run means skip, full stop --
  // it must NOT be treated as "pending-resume" (a user who explicitly
  // skips does not want the tour reappearing uninvited later).
  const { dash } = makeSandbox({ hasUploadedData: false });
  dash.launchGuidedTour();
  dash.skipGuidedTour();
  assert(dash.guidedTourStatus() === 'skipped', 'REQUIRED 4: Skip during the truncated (empty-workspace) run persists "skipped", exactly like skipping a full run');
  const state = dash.readGuidedTourState();
  assert(typeof state.pendingResumeStep !== 'number', 'REQUIRED 4: skipping the truncated run never leaves a pending-resume marker behind -- skip means skip, not "ask me again later"');
}
{
  // Skip during a populated, full-length run behaves exactly as before.
  const { dash } = makeSandbox({ hasUploadedData: true });
  dash.launchGuidedTour();
  dash.nextGuidedTourStep();
  dash.skipGuidedTour();
  assert(dash.guidedTourStatus() === 'skipped', 'REQUIRED 4: Skip mid-way through a populated, full-length run still persists "skipped", unchanged');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
