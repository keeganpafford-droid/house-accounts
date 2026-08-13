// Signal feedback / organizational-learning foundation, live-QA final
// correction: the backend already durably recorded signal_selected, but
// the verified-signal UI never hydrated it -- reopening Research Results
// for a signal the rep had already chosen to work still showed "Use This
// Signal →" as if nothing had happened, and clicking it again would write
// a second, redundant signal_selected merely to reopen Prepare for Call.
//
// This file proves, against the REAL, verbatim
// repSelectedOpportunityFromSignal()/useSignalAsRepSelected()/
// reopenRepSelectedSignal()/hydrateSignalFeedbackButtons() from
// dashboard/index.html (extracted via dashboard-extract.js), not a
// reimplementation:
//   - an unused signal renders/behaves as "Use This Signal" and clicking
//     it writes exactly one signal_selected before opening Prepare for
//     Call;
//   - hydration of a previously-selected signal relabels the button to
//     "Prepare for Call →" and reveals the "Used ✓" status, purely from
//     the batched read-back's new `selected` field;
//   - reopening an already-selected signal (the hydrated path) opens the
//     same rep-selected Prepare for Call experience WITHOUT writing
//     another signal_selected;
//   - a second, independent signal can hydrate its OWN "Used ✓" state
//     without affecting an unrelated signal's.
//
// api/signal-events.js's own GET handler test (scripts/test-signal-events.js)
// separately proves the server-side `selected` derivation itself.
//
// Usage: node scripts/test-signal-selected-reopen.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const REP_SELECTED_OPP_SRC = extractFn(DASHBOARD_SRC, 'repSelectedOpportunityFromSignal');
const USE_SIGNAL_SRC = extractFn(DASHBOARD_SRC, 'useSignalAsRepSelected');
const REOPEN_SIGNAL_SRC = extractFn(DASHBOARD_SRC, 'reopenRepSelectedSignal');
const HYDRATE_SRC = extractFn(DASHBOARD_SRC, 'hydrateSignalFeedbackButtons');

function makeSandbox({ fetchSignalEventStatesImpl } = {}) {
  const calls = { logSignalEvent: [], createSalesPlayPanel: [] };
  const sandbox = {
    console,
    logSignalEvent: async (eventType, opts) => { calls.logSignalEvent.push({ eventType, opts }); return { ok: true, id: `event-${calls.logSignalEvent.length}` }; },
    createSalesPlayPanel: (opp, opts) => { calls.createSalesPlayPanel.push({ opp, opts }); },
    fetchSignalEventStates: async (keys) => fetchSignalEventStatesImpl ? fetchSignalEventStatesImpl(keys) : {},
    signalStateKey: (eventFingerprint, accountName) => `${eventFingerprint}::${accountName || ''}`,
    generateClientEventId: (() => { let n = 0; return () => `client-event-${++n}`; })()
  };
  vm.createContext(sandbox);
  new vm.Script([REP_SELECTED_OPP_SRC, USE_SIGNAL_SRC, REOPEN_SIGNAL_SRC, HYDRATE_SRC].join('\n\n'), { filename: 'signal-selected-reopen-extract.js' }).runInContext(sandbox);
  return { sandbox, calls };
}

const SIGNAL_A = { id: 'sig-a', eventFingerprint: 'fp-a', accountName: 'Acme Co', account: 'Acme Co', title: 'Acme Co is hiring' };
const SIGNAL_B = { id: 'sig-b', eventFingerprint: 'fp-b', accountName: 'Beta Inc', account: 'Beta Inc', title: 'Beta Inc opens new office' };

function makeFeedbackBtn(fingerprint, accountName, feedbackType) {
  const btn = {
    dataset: { eventFingerprint: fingerprint, accountName, signalFeedback: feedbackType },
    _attrs: {},
    setAttribute(k, v) { btn._attrs[k] = v; },
    classList: { _set: new Set(), add(c) { btn.classList._set.add(c); }, contains(c) { return btn.classList._set.has(c); } }
  };
  return btn;
}

function makeUseSignalBtn(fingerprint, accountName) {
  const statusEl = { hidden: true };
  const actionsRow = { querySelector: (sel) => (sel === '.signal-used-status' ? statusEl : null) };
  const btn = {
    dataset: { eventFingerprint: fingerprint, accountName },
    textContent: 'Use This Signal →',
    closest: (sel) => (sel === '.verified-signal-actions' ? actionsRow : null)
  };
  btn._statusEl = statusEl;
  return btn;
}

function makeRoot(feedbackBtns, useSignalBtns) {
  return {
    querySelectorAll(sel) {
      if (sel === '.signal-feedback-btn[data-event-fingerprint]') return feedbackBtns;
      if (sel === '.use-signal-btn[data-event-fingerprint]') return useSignalBtns;
      return [];
    }
  };
}

async function run() {
  // ---------------------------------------------------------------------
  // REQUIRED: an unused signal's "Use This Signal" click writes exactly
  // one signal_selected, then opens Prepare for Call with repSelected:true.
  // ---------------------------------------------------------------------
  {
    const { sandbox, calls } = makeSandbox();
    sandbox.useSignalAsRepSelected(SIGNAL_A);
    assert(calls.logSignalEvent.length === 1 && calls.logSignalEvent[0].eventType === 'signal_selected', `REQUIRED: the first use of a signal writes exactly one signal_selected (got ${JSON.stringify(calls.logSignalEvent)})`);
    assert(calls.logSignalEvent[0].opts.signalId === 'sig-a', 'the signal_selected event carries the correct signalId');
    assert(calls.createSalesPlayPanel.length === 1 && calls.createSalesPlayPanel[0].opts.repSelected === true, 'REQUIRED: the first use opens Prepare for Call with repSelected:true');
  }

  // ---------------------------------------------------------------------
  // REQUIRED (hydration): a signal this rep has already selected relabels
  // to "Prepare for Call →" and reveals its "Used ✓" status, purely from
  // the batched read-back's `selected` field -- no separate request.
  // ---------------------------------------------------------------------
  {
    const useBtnA = makeUseSignalBtn('fp-a', 'Acme Co');
    const useBtnB = makeUseSignalBtn('fp-b', 'Beta Inc');
    const root = makeRoot([], [useBtnA, useBtnB]);
    const { sandbox } = makeSandbox({
      fetchSignalEventStatesImpl: async () => ({
        'fp-a::Acme Co': { feedback: null, selected: true, outreachLogged: false, latestOutreachEventId: null, approachNote: null },
        'fp-b::Beta Inc': { feedback: null, selected: false, outreachLogged: false, latestOutreachEventId: null, approachNote: null }
      })
    });
    await sandbox.hydrateSignalFeedbackButtons(root);
    assert(useBtnA.textContent === 'Prepare for Call →', `REQUIRED: the previously-selected signal's button relabels to "Prepare for Call →" (got ${JSON.stringify(useBtnA.textContent)})`);
    assert(useBtnA.dataset.signalSelected === '1', 'REQUIRED: the button is flagged data-signal-selected="1" for the delegated click handler to read');
    assert(useBtnA._statusEl.hidden === false, 'REQUIRED: the "Used ✓" status becomes visible for the previously-selected signal');
    assert(useBtnB.textContent === 'Use This Signal →', 'REQUIRED: a second, distinct signal the rep has NOT selected stays "Use This Signal →" -- hydration is independent per signal');
    assert(useBtnB.dataset.signalSelected === undefined, 'the unselected signal is never flagged as selected');
    assert(useBtnB._statusEl.hidden === true, 'the unselected signal never shows "Used ✓"');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: reopening an already-selected signal (the path the delegated
  // click handler takes once data-signal-selected="1") writes NO further
  // signal_selected, but still opens the same rep-selected Prepare for
  // Call experience -- prepare_call_opened continues to fire through that
  // existing, unconditional open path (already proven separately; this
  // asserts the reopen call reaches createSalesPlayPanel identically to a
  // first-time use).
  // ---------------------------------------------------------------------
  {
    const { sandbox, calls } = makeSandbox();
    sandbox.reopenRepSelectedSignal(SIGNAL_A);
    assert(calls.logSignalEvent.length === 0, `REQUIRED: reopening a previously-selected signal writes NO signal_selected (got ${calls.logSignalEvent.length} events)`);
    assert(calls.createSalesPlayPanel.length === 1 && calls.createSalesPlayPanel[0].opts.repSelected === true, 'REQUIRED: reopening still opens the same rep-selected Prepare for Call experience');
    assert(calls.createSalesPlayPanel[0].opp.id === 'sig-a' && calls.createSalesPlayPanel[0].opp.account === 'Acme Co', 'the reopened opportunity is built from the exact same signal');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: feedback buttons (Useful/Not-useful) hydrate correctly
  // alongside the new "Used ✓" logic in the same batched call -- no
  // regression from folding the two together.
  // ---------------------------------------------------------------------
  {
    const usefulBtn = makeFeedbackBtn('fp-a', 'Acme Co', 'useful');
    const notUsefulBtn = makeFeedbackBtn('fp-a', 'Acme Co', 'not_useful');
    const useBtn = makeUseSignalBtn('fp-a', 'Acme Co');
    const root = makeRoot([usefulBtn, notUsefulBtn], [useBtn]);
    const { sandbox } = makeSandbox({
      fetchSignalEventStatesImpl: async () => ({
        'fp-a::Acme Co': { feedback: 'useful', selected: true, outreachLogged: false, latestOutreachEventId: null, approachNote: null }
      })
    });
    await sandbox.hydrateSignalFeedbackButtons(root);
    assert(usefulBtn._attrs['aria-pressed'] === 'true' && usefulBtn.classList.contains('signal-feedback-active'), 'REQUIRED: the Useful button still hydrates correctly alongside the new Used-signal logic');
    assert(notUsefulBtn._attrs['aria-pressed'] !== 'true', 'the Not-useful button correctly stays unpressed');
    assert(useBtn.textContent === 'Prepare for Call →', 'the Use This Signal button hydrates in the same batched pass');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
