// Founder-reported gap (post-live-QA correction round): after logging a
// first outreach attempt, the SAME button used to relabel itself "Reached
// out ✓" and simply stay clickable -- the event architecture already
// supported a second, independent outreach_made attempt (wireOutreachRow's
// own isAnotherAttempt branch, and the live DB proved it), but nothing in
// the UI told a rep that clicking the checkmark-styled "done" pill again
// would log a NEW attempt. This file proves the smallest UI correction:
// the confirmation now lives in its own persistent .outreach-status
// element, and the button itself always reads as the NEXT available
// action ("I reached out" -> "Log another outreach"), never as a static
// "finished" state -- using the REAL, verbatim wireOutreachRow() from
// dashboard/index.html (extracted via dashboard-extract.js), not a
// reimplementation.
//
// Usage: node scripts/test-outreach-log-again-ux.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const WIRE_OUTREACH_ROW_SRC = extractFn(DASHBOARD_SRC, 'wireOutreachRow');

function makeFakeElement() {
  const el = {
    textContent: '',
    hidden: true,
    disabled: false,
    dataset: {},
    _classes: new Set(),
    _listeners: {},
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); }
    },
    addEventListener(evt, fn) { (el._listeners[evt] = el._listeners[evt] || []).push(fn); },
    async fire(evt) { for (const fn of (el._listeners[evt] || [])) await fn(); }
  };
  return el;
}

function makeFakeRow() {
  const logBtn = makeFakeElement();
  const statusEl = makeFakeElement();
  const noteWrap = makeFakeElement();
  const noteInput = makeFakeElement();
  const noteSaveBtn = makeFakeElement();
  noteInput.value = '';
  const map = {
    '.outreach-log-btn': logBtn,
    '.outreach-status': statusEl,
    '.approach-note-wrap': noteWrap,
    '.approach-note-input': noteInput,
    '.approach-note-save': noteSaveBtn
  };
  const rowEl = {
    dataset: { outreachSignalId: 'sig-1', outreachFingerprint: 'fp-1', accountName: 'Acme Co' },
    querySelector: (sel) => map[sel] || null
  };
  return { rowEl, logBtn, statusEl, noteWrap, noteInput, noteSaveBtn };
}

function makeSandbox({ logSignalEventImpl } = {}) {
  const calls = { logSignalEvent: [] };
  const sandbox = {
    console,
    logSignalEvent: async (eventType, opts) => {
      calls.logSignalEvent.push({ eventType, opts });
      return logSignalEventImpl ? logSignalEventImpl(eventType, opts) : null;
    },
    generateClientEventId: (() => { let n = 0; return () => `client-event-${++n}`; })()
  };
  vm.createContext(sandbox);
  new vm.Script(WIRE_OUTREACH_ROW_SRC, { filename: 'wire-outreach-row-extract.js' }).runInContext(sandbox);
  return { sandbox, calls };
}

async function run() {
  // ---------------------------------------------------------------------
  // Initial render: plain "I reached out", no status shown yet.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, statusEl } = makeFakeRow();
    logBtn.textContent = 'I reached out';
    const { sandbox } = makeSandbox({ logSignalEventImpl: async () => ({ ok: true, id: 'event-1' }) });
    sandbox.wireOutreachRow(rowEl);
    assert(logBtn.textContent === 'I reached out', 'sanity: initial label is unchanged before any click');
    assert(statusEl.hidden === true, 'sanity: the status indicator is not shown before any outreach is logged');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: after the first successful outreach_made, the confirmation
  // moves to its own persistent status element, and the button itself
  // becomes an explicit, discoverable "Log another outreach" affordance --
  // not a checkmark that merely happens to still be clickable.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, statusEl } = makeFakeRow();
    logBtn.textContent = 'I reached out';
    const { sandbox, calls } = makeSandbox({ logSignalEventImpl: async () => ({ ok: true, id: 'event-first' }) });
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    assert(calls.logSignalEvent.length === 1 && calls.logSignalEvent[0].eventType === 'outreach_made', 'REQUIRED: the first click logs exactly one outreach_made event');
    assert(statusEl.hidden === false, 'REQUIRED: the "Reached out" confirmation becomes visible in its own persistent status element');
    assert(logBtn.textContent === 'Log another outreach', 'REQUIRED: the button itself now reads as an explicit, discoverable secondary action, not a static "done" checkmark');
    assert(logBtn.dataset.outreachLogAgain === '1', 'sanity: the button is flagged for a deliberate next attempt');
    assert(logBtn.disabled === false, 'REQUIRED: the button remains genuinely clickable for a second attempt');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: a deliberate second click logs a genuinely NEW outreach_made
  // event (fresh clientEventId, distinct event id) and the button still
  // reads "Log another outreach" afterward -- unlimited legitimate
  // attempts, exactly as the event architecture (and the live DB) already
  // proved, now actually discoverable from the UI.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, statusEl } = makeFakeRow();
    logBtn.textContent = 'I reached out';
    let nextId = 0;
    const { sandbox, calls } = makeSandbox({ logSignalEventImpl: async () => ({ ok: true, id: `event-${++nextId}` }) });
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    await logBtn.fire('click');
    assert(calls.logSignalEvent.length === 2, `REQUIRED: two deliberate clicks log two separate outreach_made events (got ${calls.logSignalEvent.length})`);
    assert(calls.logSignalEvent[0].opts.clientEventId !== calls.logSignalEvent[1].opts.clientEventId, 'REQUIRED: the second attempt gets a genuinely fresh clientEventId, not a replay of the first');
    assert(logBtn.textContent === 'Log another outreach', 'REQUIRED: after a second logged attempt the button still offers a further attempt, not a dead-end label');
    assert(statusEl.hidden === false, 'the confirmation status remains visible across further attempts');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: a note saved after logging outreach attaches to the LATEST
  // outreach id, whether that latest id came from this session's own click
  // or from hydrateOutreachRow() restoring server state on reopen (both
  // paths call the same showReachedOut(), exposed as
  // rowEl.__houseAccountsShowReachedOut -- exercised directly here).
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, noteInput, noteSaveBtn } = makeFakeRow();
    logBtn.textContent = 'I reached out';
    const { sandbox, calls } = makeSandbox({
      logSignalEventImpl: async (eventType) => eventType === 'outreach_made' ? { ok: true, id: 'event-live-1' } : { ok: true, id: 'note-1' }
    });
    sandbox.wireOutreachRow(rowEl);
    // Simulate hydrateOutreachRow() restoring a LATER server-known outreach
    // id (e.g. a second attempt logged from another device) via the same
    // exposed hook real hydration uses.
    rowEl.__houseAccountsShowReachedOut('event-server-latest');
    noteInput.value = 'Left a voicemail.';
    noteSaveBtn.disabled = false;
    await noteSaveBtn.fire('click');
    const noteCall = calls.logSignalEvent.find(c => c.eventType === 'approach_shared');
    assert(!!noteCall, 'sanity: the note save fired an approach_shared event');
    assert(noteCall.opts.parentEventId === 'event-server-latest', `REQUIRED: the note attaches to the LATEST known outreach id (server-hydrated or just-logged), not a stale one (got ${noteCall.opts.parentEventId})`);
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
