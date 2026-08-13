// Signal feedback / organizational-learning foundation, live-QA final
// correction: opening the outreach form must never itself be evidence
// that an outreach occurred. Earlier rounds fixed two UX gaps ("Log
// another outreach" was invisible; a saved note looked like a still-
// editable form), but "I reached out" itself immediately POSTed
// outreach_made, so merely opening the panel and clicking it once created
// a durable event even if the rep never actually confirmed anything.
//
// Final model, proved here against the REAL, verbatim wireOutreachRow()/
// hydrateOutreachRow() (extracted via dashboard-extract.js), not a
// reimplementation:
//   - "I reached out" / "Log another outreach" only open a blank draft
//     form -- zero network calls.
//   - "Cancel" (or closing the panel) discards the draft -- zero writes.
//   - "Save outreach" is the one action that writes anything: exactly one
//     outreach_made, then (only if the trimmed textarea has text) exactly
//     one approach_shared whose parent_event_id is that new outreach's id.
//   - A saved outreach with a blank note is a fully valid, permanent
//     state -- the note stays optional.
//   - A subsequent "Log another outreach" -> Save outreach gets a
//     genuinely new outreach id and a genuinely blank note field, never
//     inheriting the prior attempt's text.
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
const HYDRATE_OUTREACH_ROW_SRC = extractFn(DASHBOARD_SRC, 'hydrateOutreachRow');

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
  const noteCancelBtn = makeFakeElement();
  const noteReadonly = makeFakeElement();
  noteInput.value = '';
  const map = {
    '.outreach-log-btn': logBtn,
    '.outreach-status': statusEl,
    '.approach-note-wrap': noteWrap,
    '.approach-note-input': noteInput,
    '.approach-note-save': noteSaveBtn,
    '.approach-note-cancel': noteCancelBtn,
    '.approach-note-readonly': noteReadonly
  };
  const rowEl = {
    dataset: { outreachSignalId: 'sig-1', outreachFingerprint: 'fp-1', accountName: 'Acme Co' },
    querySelector: (sel) => map[sel] || null
  };
  return { rowEl, logBtn, statusEl, noteWrap, noteInput, noteSaveBtn, noteCancelBtn, noteReadonly };
}

function makeSandbox({ logSignalEventImpl, fetchSignalEventStatesImpl } = {}) {
  const calls = { logSignalEvent: [] };
  const sandbox = {
    console,
    logSignalEvent: async (eventType, opts) => {
      calls.logSignalEvent.push({ eventType, opts });
      return logSignalEventImpl ? logSignalEventImpl(eventType, opts) : null;
    },
    fetchSignalEventStates: async (keys) => fetchSignalEventStatesImpl ? fetchSignalEventStatesImpl(keys) : {},
    signalStateKey: (eventFingerprint, accountName) => `${eventFingerprint}::${accountName || ''}`,
    generateClientEventId: (() => { let n = 0; return () => `client-event-${++n}`; })()
  };
  vm.createContext(sandbox);
  new vm.Script([WIRE_OUTREACH_ROW_SRC, HYDRATE_OUTREACH_ROW_SRC].join('\n\n'), { filename: 'wire-outreach-row-extract.js' }).runInContext(sandbox);
  return { sandbox, calls };
}

async function run() {
  // ---------------------------------------------------------------------
  // REQUIRED: clicking "I reached out" alone opens the draft form and
  // creates NO event at all -- opening the form is not evidence an
  // outreach occurred.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, noteWrap, noteSaveBtn, noteCancelBtn } = makeFakeRow();
    const { sandbox, calls } = makeSandbox();
    sandbox.wireOutreachRow(rowEl);
    assert(logBtn.hidden === false && logBtn.textContent === 'I reached out', 'sanity: initial state shows the "I reached out" button');
    await logBtn.fire('click');
    assert(calls.logSignalEvent.length === 0, `REQUIRED: clicking "I reached out" alone creates no event (got ${calls.logSignalEvent.length} calls)`);
    assert(noteWrap.hidden === false, 'REQUIRED: clicking "I reached out" opens the draft form');
    assert(logBtn.hidden === true, 'the log button itself is hidden while the draft form is open -- only one action on screen at a time');
    assert(noteSaveBtn.textContent === 'Save outreach', 'the draft form\'s confirm control is labeled "Save outreach"');
    assert(noteCancelBtn.disabled === false, 'the draft form\'s Cancel control is enabled and ready to use');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: canceling an open draft creates no event and returns to the
  // initial state (nothing was ever saved).
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, noteWrap, noteCancelBtn } = makeFakeRow();
    const { sandbox, calls } = makeSandbox();
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    await noteCancelBtn.fire('click');
    assert(calls.logSignalEvent.length === 0, `REQUIRED: canceling a first-ever draft creates no event (got ${calls.logSignalEvent.length} calls)`);
    assert(logBtn.hidden === false && logBtn.textContent === 'I reached out', 'REQUIRED: canceling a never-saved draft returns to the initial "I reached out" state');
    assert(noteWrap.hidden === true, 'the draft form is closed after cancel');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: Save outreach with a BLANK note creates exactly one
  // outreach_made and zero approach_shared -- a note-less outreach is a
  // fully valid, permanent state.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, statusEl, noteWrap, noteReadonly } = makeFakeRow();
    const { sandbox, calls } = makeSandbox({ logSignalEventImpl: async () => ({ ok: true, id: 'event-1' }) });
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    const saveBtn = rowEl.querySelector('.approach-note-save');
    await saveBtn.fire('click');
    const outreachCalls = calls.logSignalEvent.filter(c => c.eventType === 'outreach_made');
    const noteCalls = calls.logSignalEvent.filter(c => c.eventType === 'approach_shared');
    assert(outreachCalls.length === 1, `REQUIRED: Save outreach with a blank note creates exactly one outreach_made (got ${outreachCalls.length})`);
    assert(noteCalls.length === 0, `REQUIRED: Save outreach with a blank note creates zero approach_shared (got ${noteCalls.length})`);
    assert(statusEl.hidden === false && logBtn.textContent === 'Log another outreach', 'after saving, the row shows the saved state with a "Log another outreach" secondary action');
    assert(noteWrap.hidden === true && noteReadonly.hidden === true, 'REQUIRED: a note-less saved outreach shows neither the editable form nor a read-only note');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: Save outreach with text creates one outreach_made and one
  // approach_shared, correctly parent-linked to that exact new outreach
  // id -- then the note renders as read-only, not inside a textarea.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, noteInput, noteWrap, noteReadonly } = makeFakeRow();
    const { sandbox, calls } = makeSandbox({
      logSignalEventImpl: async (eventType) => eventType === 'outreach_made' ? { ok: true, id: 'event-outreach-1' } : { ok: true, id: 'event-note-1' }
    });
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    noteInput.value = 'Called the marketing director and referenced their new location.';
    const saveBtn = rowEl.querySelector('.approach-note-save');
    await saveBtn.fire('click');
    const outreachCall = calls.logSignalEvent.find(c => c.eventType === 'outreach_made');
    const noteCall = calls.logSignalEvent.find(c => c.eventType === 'approach_shared');
    assert(!!outreachCall && !!noteCall, 'REQUIRED: Save outreach with text creates both an outreach_made and an approach_shared');
    assert(noteCall.opts.parentEventId === 'event-outreach-1', `REQUIRED: the approach_shared is parent-linked to the exact NEW outreach id just created (got ${noteCall.opts.parentEventId})`);
    assert(noteReadonly.hidden === false && noteReadonly.textContent === 'Called the marketing director and referenced their new location.', 'REQUIRED: the saved note renders as read-only text, not left in the textarea');
    assert(noteWrap.hidden === true, 'the editable form (and its Save/Cancel controls) is hidden once the note is saved');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: clicking "Log another outreach" alone (after a prior saved
  // outreach) opens a blank draft and creates NO event -- the second
  // attempt is only persisted by an explicit Save outreach, exactly like
  // the first.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, noteInput, noteWrap, noteReadonly } = makeFakeRow();
    const { sandbox, calls } = makeSandbox({
      logSignalEventImpl: async (eventType) => eventType === 'outreach_made' ? { ok: true, id: 'event-outreach-1' } : { ok: true, id: 'event-note-1' }
    });
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    noteInput.value = 'First attempt: left a voicemail.';
    await rowEl.querySelector('.approach-note-save').fire('click');
    const callsAfterFirstSave = calls.logSignalEvent.length;

    await logBtn.fire('click'); // "Log another outreach"
    assert(calls.logSignalEvent.length === callsAfterFirstSave, `REQUIRED: clicking "Log another outreach" alone creates no new event (got ${calls.logSignalEvent.length - callsAfterFirstSave} new calls)`);
    assert(noteWrap.hidden === false, 'REQUIRED: "Log another outreach" opens a fresh draft form');
    assert(noteReadonly.hidden === true, 'REQUIRED: the prior attempt\'s read-only note is hidden while drafting the new attempt');
    assert(noteInput.value === '', `REQUIRED: the fresh draft is never pre-populated with the prior attempt's note (got ${JSON.stringify(noteInput.value)})`);
  }

  // ---------------------------------------------------------------------
  // REQUIRED: canceling a "Log another outreach" draft restores the PRIOR
  // saved state (status + its own read-only note), never the blank
  // initial state -- nothing about the first attempt is lost.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, statusEl, noteWrap, noteReadonly } = makeFakeRow();
    const { sandbox } = makeSandbox({
      logSignalEventImpl: async (eventType) => eventType === 'outreach_made' ? { ok: true, id: 'event-outreach-1' } : { ok: true, id: 'event-note-1' }
    });
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    rowEl.querySelector('.approach-note-input').value = 'First attempt note.';
    await rowEl.querySelector('.approach-note-save').fire('click');
    await logBtn.fire('click'); // open a second draft
    await rowEl.querySelector('.approach-note-cancel').fire('click');
    assert(statusEl.hidden === false && logBtn.textContent === 'Log another outreach', 'REQUIRED: canceling a later draft restores the prior SAVED state, not the blank initial state');
    assert(noteReadonly.hidden === false && noteReadonly.textContent === 'First attempt note.', 'REQUIRED: the first attempt\'s own saved note is restored, untouched, after canceling a later draft');
    assert(noteWrap.hidden === true, 'the draft form is closed after cancel');
  }

  // ---------------------------------------------------------------------
  // REQUIRED (subsequent saved outreach): a second Save outreach receives
  // a genuinely new outreach id and, if a new note is entered, a genuinely
  // new parent-linked approach_shared -- not a mutation of the first.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, noteInput, noteReadonly } = makeFakeRow();
    let nextOutreachId = 0;
    const { sandbox, calls } = makeSandbox({
      logSignalEventImpl: async (eventType) => eventType === 'outreach_made'
        ? { ok: true, id: `event-outreach-${++nextOutreachId}` }
        : { ok: true, id: `event-note-${nextOutreachId}` }
    });
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    noteInput.value = 'First attempt note.';
    await rowEl.querySelector('.approach-note-save').fire('click');
    await logBtn.fire('click');
    noteInput.value = 'Second attempt note.';
    await rowEl.querySelector('.approach-note-save').fire('click');
    const outreachIds = calls.logSignalEvent.filter(c => c.eventType === 'outreach_made').map(c => c.opts.clientEventId);
    const noteCalls = calls.logSignalEvent.filter(c => c.eventType === 'approach_shared');
    assert(new Set(outreachIds).size === 2, 'REQUIRED: two saved attempts use two genuinely distinct clientEventIds');
    assert(noteCalls.length === 2 && noteCalls[1].opts.parentEventId === 'event-outreach-2', `REQUIRED: the second note is parent-linked to the SECOND outreach id, not the first (got ${JSON.stringify(noteCalls.map(c => c.opts.parentEventId))})`);
    assert(noteReadonly.textContent === 'Second attempt note.', 'REQUIRED: the row now shows the second attempt\'s own note, not the first\'s');
  }

  // ---------------------------------------------------------------------
  // REQUIRED (hydration): reopening the panel for an outreach whose latest
  // attempt already has a saved note renders it read-only immediately, in
  // the SAVED state -- never as an open draft.
  // ---------------------------------------------------------------------
  {
    const { rowEl, statusEl, logBtn, noteWrap, noteReadonly } = makeFakeRow();
    const { sandbox } = makeSandbox({
      fetchSignalEventStatesImpl: async () => ({
        'fp-1::Acme Co': { feedback: null, outreachLogged: true, latestOutreachEventId: 'event-server-1', approachNote: 'Called the ops lead about the hiring push.' }
      })
    });
    sandbox.wireOutreachRow(rowEl);
    await sandbox.hydrateOutreachRow(rowEl);
    assert(statusEl.hidden === false, 'sanity: hydration shows the Reached out status');
    assert(logBtn.hidden === false && logBtn.textContent === 'Log another outreach', 'hydration lands in the SAVED state, offering "Log another outreach"');
    assert(noteReadonly.hidden === false && noteReadonly.textContent === 'Called the ops lead about the hiring push.', `REQUIRED: a server-hydrated saved note renders as read-only text (got hidden=${noteReadonly.hidden}, text=${JSON.stringify(noteReadonly.textContent)})`);
    assert(noteWrap.hidden === true, 'REQUIRED: the editable draft form stays closed when hydration finds an existing note');
  }

  // ---------------------------------------------------------------------
  // REQUIRED (hydration): reopening the panel for an outreach whose latest
  // attempt has NO note yet lands in the SAVED state with no note shown
  // (not an open draft, not a blank textarea) -- the rep must click "Log
  // another outreach" to add one, exactly like any other saved outreach.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, noteWrap, noteReadonly, statusEl } = makeFakeRow();
    const { sandbox } = makeSandbox({
      fetchSignalEventStatesImpl: async () => ({
        'fp-1::Acme Co': { feedback: null, outreachLogged: true, latestOutreachEventId: 'event-server-2', approachNote: null }
      })
    });
    sandbox.wireOutreachRow(rowEl);
    await sandbox.hydrateOutreachRow(rowEl);
    assert(statusEl.hidden === false && logBtn.textContent === 'Log another outreach', 'REQUIRED: hydration with no saved note still lands in the SAVED state');
    assert(noteWrap.hidden === true, 'REQUIRED: hydration never auto-opens the draft form');
    assert(noteReadonly.hidden === true, 'REQUIRED: there is no note to show, so the read-only element stays hidden');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
