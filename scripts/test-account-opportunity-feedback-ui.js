// Organizational Learning V1B, item 10: deterministic coverage for the
// client-side wiring that lets a rep give Useful/Not-useful feedback, log
// outreach, and share an approach note on a Follow-Up/Repeat-Pattern
// account-history opportunity -- the SAME UI/event vocabulary V1A already
// built for signals, extended (not duplicated) to a second identity
// family. Extracted verbatim from dashboard/index.html (via
// dashboard-extract.js), not a reimplementation:
//   - resolveSignalEventTarget()/logOpportunityAwareEvent(): the shared
//     dispatch that chooses signal_* vs opportunity_* identity/eventType.
//   - renderAccountHistoryOpportunityFeedback(): the Useful/Not-useful
//     button pair, rendered only when a durable server-issued ref exists.
//   - wireOutreachRow()'s opportunity branch: outreach/approach-note save
//     targets opportunityId + opportunity_* event types + templateKey when
//     the row was rendered for an account-history opportunity.
//
// Usage: node scripts/test-account-opportunity-feedback-ui.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const RESOLVE_TARGET_SRC = extractFn(DASHBOARD_SRC, 'resolveSignalEventTarget');
const OPPORTUNITY_EVENT_TYPE_MAP_SRC = extractFn(DASHBOARD_SRC, 'OPPORTUNITY_EVENT_TYPE_MAP');
const LOG_OPPORTUNITY_AWARE_EVENT_SRC = extractFn(DASHBOARD_SRC, 'logOpportunityAwareEvent');
const RENDER_FEEDBACK_SRC = extractFn(DASHBOARD_SRC, 'renderAccountHistoryOpportunityFeedback');
const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
const WIRE_OUTREACH_ROW_SRC = extractFn(DASHBOARD_SRC, 'wireOutreachRow');
const HYDRATE_FEEDBACK_SRC = extractFn(DASHBOARD_SRC, 'hydrateSignalFeedbackButtons');

function makeFakeElement() {
  const el = {
    textContent: '', hidden: true, disabled: false, dataset: {}, _classes: new Set(), _listeners: {},
    classList: { add(c) { el._classes.add(c); }, remove(c) { el._classes.delete(c); }, contains(c) { return el._classes.has(c); } },
    addEventListener(evt, fn) { (el._listeners[evt] = el._listeners[evt] || []).push(fn); },
    async fire(evt) { for (const fn of (el._listeners[evt] || [])) await fn(); }
  };
  return el;
}
function makeFakeRow(dataset) {
  const logBtn = makeFakeElement();
  const noteInput = makeFakeElement(); noteInput.value = '';
  const noteSaveBtn = makeFakeElement();
  const noteCancelBtn = makeFakeElement();
  const statusEl = makeFakeElement();
  const noteReadonly = makeFakeElement();
  const noteWrap = makeFakeElement();
  const map = {
    '.outreach-log-btn': logBtn, '.outreach-status': statusEl, '.approach-note-wrap': noteWrap,
    '.approach-note-input': noteInput, '.approach-note-save': noteSaveBtn, '.approach-note-cancel': noteCancelBtn,
    '.approach-note-readonly': noteReadonly
  };
  const rowEl = { dataset, querySelector: (sel) => map[sel] || null };
  return { rowEl, logBtn, noteInput, noteSaveBtn, noteCancelBtn, statusEl, noteReadonly, noteWrap };
}

function makeSandbox({ logSignalEventImpl, fetchSignalEventStatesImpl } = {}) {
  const calls = { logSignalEvent: [] };
  const sandbox = {
    console,
    logSignalEvent: async (eventType, opts) => {
      calls.logSignalEvent.push({ eventType, opts });
      return logSignalEventImpl ? logSignalEventImpl(eventType, opts) : { ok: true, id: 'event-x' };
    },
    fetchSignalEventStates: async (keys) => fetchSignalEventStatesImpl ? fetchSignalEventStatesImpl(keys) : {},
    signalStateKey: (eventFingerprint, accountName) => `${eventFingerprint}::${accountName || ''}`,
    generateClientEventId: (() => { let n = 0; return () => `client-event-${++n}`; })()
  };
  vm.createContext(sandbox);
  new vm.Script(
    [RESOLVE_TARGET_SRC, OPPORTUNITY_EVENT_TYPE_MAP_SRC, LOG_OPPORTUNITY_AWARE_EVENT_SRC, ESCAPE_HTML_SRC, RENDER_FEEDBACK_SRC, WIRE_OUTREACH_ROW_SRC, HYDRATE_FEEDBACK_SRC].join('\n\n'),
    { filename: 'account-opportunity-feedback-ui-extract.js' }
  ).runInContext(sandbox);
  return { sandbox, calls };
}

function makeFeedbackBtn(fingerprint, accountName, feedbackType, opportunityId) {
  const btn = {
    dataset: { eventFingerprint: fingerprint, accountName, signalFeedback: feedbackType, opportunityId },
    _attrs: {},
    setAttribute(k, v) { btn._attrs[k] = v; },
    classList: { _set: new Set(), add(c) { btn.classList._set.add(c); }, contains(c) { return btn.classList._set.has(c); } }
  };
  return btn;
}
function makeRoot(feedbackBtns) {
  return { querySelectorAll(sel) { return sel === '.signal-feedback-btn[data-event-fingerprint]' ? feedbackBtns : []; } };
}

async function run() {
  // ---------------------------------------------------------------------
  // resolveSignalEventTarget(): chooses the account-history opportunity
  // identity when a durable ref is present, the signal identity when only
  // that is present, and null (no fabricated identity) when neither is.
  // ---------------------------------------------------------------------
  {
    const { sandbox } = makeSandbox();
    const oppTarget = sandbox.resolveSignalEventTarget({ accountOpportunityId: 'opp-1', accountOpportunityFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01', templateKey: 'auto_service_apparel' });
    assert(oppTarget.isOpportunity === true, 'REQUIRED: an opp with a durable account-history ref resolves to the opportunity family');
    assert(oppTarget.opportunityId === 'opp-1' && oppTarget.eventFingerprint === 'opp:follow_up:v1:acme|last:2025-06-01' && oppTarget.templateKey === 'auto_service_apparel', 'the resolved target carries the exact ref fields, verbatim');

    const signalTarget = sandbox.resolveSignalEventTarget({ id: 'sig-1', eventFingerprint: 'fp-1' });
    assert(signalTarget.isOpportunity === false && signalTarget.signalId === 'sig-1' && signalTarget.eventFingerprint === 'fp-1', 'REQUIRED: an opp with only a signal identity resolves to the signal family');

    const noIdentity = sandbox.resolveSignalEventTarget({ account: 'Nothing Co' });
    assert(noIdentity === null, 'REQUIRED: an opp with neither identity resolves to null -- never a fabricated target');
  }

  // ---------------------------------------------------------------------
  // logOpportunityAwareEvent(): maps base event types to their
  // opportunity_* counterparts, sends prepare_call_opened unchanged
  // (shared event type), and is a genuine no-op (never calls
  // logSignalEvent) when the opp has no identity yet.
  // ---------------------------------------------------------------------
  {
    const { sandbox, calls } = makeSandbox();
    await sandbox.logOpportunityAwareEvent('signal_selected', { account: 'Acme Co', accountOpportunityId: 'opp-1', accountOpportunityFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01' });
    assert(calls.logSignalEvent.length === 1 && calls.logSignalEvent[0].eventType === 'opportunity_selected', `REQUIRED: signal_selected maps to opportunity_selected for an account-history opp (got ${JSON.stringify(calls.logSignalEvent[0])})`);
    assert(calls.logSignalEvent[0].opts.opportunityId === 'opp-1' && calls.logSignalEvent[0].opts.signalId === undefined, 'REQUIRED: the opportunity branch sends opportunityId, never signalId');
  }
  {
    const { sandbox, calls } = makeSandbox();
    await sandbox.logOpportunityAwareEvent('prepare_call_opened', { account: 'Acme Co', accountOpportunityId: 'opp-1', accountOpportunityFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01' });
    assert(calls.logSignalEvent[0].eventType === 'prepare_call_opened', 'REQUIRED: prepare_call_opened is sent UNCHANGED for an account-history opp -- it is the one event type genuinely shared between both families');
  }
  {
    const { sandbox, calls } = makeSandbox();
    await sandbox.logOpportunityAwareEvent('signal_selected', { id: 'sig-1', eventFingerprint: 'fp-1', account: 'Acme Co' });
    assert(calls.logSignalEvent[0].eventType === 'signal_selected' && calls.logSignalEvent[0].opts.signalId === 'sig-1', 'a signal-identified opp keeps the original signal_* event type');
  }
  {
    const { sandbox, calls } = makeSandbox();
    const result = await sandbox.logOpportunityAwareEvent('prepare_call_opened', { account: 'Brand New Co' });
    assert(result === null && calls.logSignalEvent.length === 0, 'REQUIRED: an opp with no durable identity in either family logs nothing at all');
  }

  // ---------------------------------------------------------------------
  // renderAccountHistoryOpportunityFeedback(): renders nothing without a
  // durable ref; renders both buttons, correctly scoped, when one exists.
  // ---------------------------------------------------------------------
  {
    const { sandbox } = makeSandbox();
    const noRef = sandbox.renderAccountHistoryOpportunityFeedback({ account: 'Acme Co' });
    assert(noRef === '', 'REQUIRED: with no server-issued ref, the feedback row renders nothing -- never a control that would fail or fabricate identity');

    const html = sandbox.renderAccountHistoryOpportunityFeedback({ account: 'Acme Co', accountOpportunityId: 'opp-1', accountOpportunityFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01', templateKey: 'auto_service_apparel' });
    assert(html.includes('data-opportunity-id="opp-1"'), 'REQUIRED: the rendered feedback buttons carry data-opportunity-id');
    assert(html.includes('data-event-fingerprint="opp:follow_up:v1:acme|last:2025-06-01"'), 'REQUIRED: the rendered feedback buttons carry the exact durable fingerprint');
    assert(html.includes('data-account-name="Acme Co"'), 'the rendered feedback buttons carry the account name for read-back scoping');
    assert(html.includes('data-signal-feedback="useful"') && html.includes('data-signal-feedback="not_useful"'), 'REQUIRED: both a Useful and a Not-useful button render');
    assert(html.includes('data-template-key="auto_service_apparel"'), 'the rendered feedback buttons carry templateKey for the recommendation snapshot');
  }

  // ---------------------------------------------------------------------
  // wireOutreachRow(): the opportunity-family branch. dataset.outreachOpportunityId
  // presence alone selects opportunity_* event types + opportunityId,
  // never signalId -- and carries templateKey through to the
  // opportunity_outreach_made snapshot event.
  // ---------------------------------------------------------------------
  {
    const { rowEl, logBtn, noteInput } = makeFakeRow({
      outreachOpportunityId: 'opp-1', outreachTemplateKey: 'auto_service_apparel', outreachFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01', accountName: 'Acme Co'
    });
    const { sandbox, calls } = makeSandbox({
      logSignalEventImpl: async (eventType) => eventType === 'opportunity_outreach_made' ? { ok: true, id: 'event-outreach-1' } : { ok: true, id: 'event-note-1' }
    });
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    noteInput.value = 'Checked in about the recent order.';
    await rowEl.querySelector('.approach-note-save').fire('click');
    const outreachCall = calls.logSignalEvent.find(c => c.eventType === 'opportunity_outreach_made');
    const noteCall = calls.logSignalEvent.find(c => c.eventType === 'opportunity_approach_shared');
    assert(!!outreachCall, 'REQUIRED: the opportunity branch logs opportunity_outreach_made, not outreach_made');
    assert(outreachCall.opts.opportunityId === 'opp-1' && outreachCall.opts.signalId === undefined, 'REQUIRED: the outreach event carries opportunityId, never signalId, for an account-history row');
    assert(outreachCall.opts.templateKey === 'auto_service_apparel', 'REQUIRED: the outreach event carries the row\'s templateKey for the recommendation snapshot');
    assert(!!noteCall, 'REQUIRED: the opportunity branch logs opportunity_approach_shared for the note, not approach_shared');
    assert(noteCall.opts.parentEventId === 'event-outreach-1', 'the approach note is parent-linked to the exact new opportunity_outreach_made id');
  }
  {
    // The signal-family branch is unaffected: no outreachOpportunityId
    // present means the original outreach_made/approach_shared path runs,
    // unchanged, with signalId (not opportunityId).
    const { rowEl, logBtn, noteInput } = makeFakeRow({ outreachSignalId: 'sig-1', outreachFingerprint: 'fp-1', accountName: 'Acme Co' });
    const { sandbox, calls } = makeSandbox({
      logSignalEventImpl: async (eventType) => eventType === 'outreach_made' ? { ok: true, id: 'event-outreach-2' } : { ok: true, id: 'event-note-2' }
    });
    sandbox.wireOutreachRow(rowEl);
    await logBtn.fire('click');
    noteInput.value = 'Left a voicemail.';
    await rowEl.querySelector('.approach-note-save').fire('click');
    const outreachCall = calls.logSignalEvent.find(c => c.eventType === 'outreach_made');
    assert(!!outreachCall, 'REQUIRED: a row with no outreachOpportunityId still logs the original outreach_made event type');
    assert(outreachCall.opts.signalId === 'sig-1' && outreachCall.opts.opportunityId === undefined, 'REQUIRED: the signal-family row carries signalId, never opportunityId');
  }

  // ---------------------------------------------------------------------
  // hydrateSignalFeedbackButtons(): already family-agnostic by
  // construction -- it keys purely on (eventFingerprint, accountName) and
  // data-signal-feedback, never on data-signal-id -- so it hydrates an
  // account-history opportunity's Useful/Not-useful buttons with zero
  // changes needed. Proven directly here rather than merely inferred.
  // ---------------------------------------------------------------------
  {
    const usefulBtn = makeFeedbackBtn('opp:follow_up:v1:acme|last:2025-06-01', 'Acme Co', 'useful', 'opp-1');
    const notUsefulBtn = makeFeedbackBtn('opp:follow_up:v1:acme|last:2025-06-01', 'Acme Co', 'not_useful', 'opp-1');
    const { sandbox } = makeSandbox({
      fetchSignalEventStatesImpl: async () => ({ 'opp:follow_up:v1:acme|last:2025-06-01::Acme Co': { feedback: 'useful', selected: false, outreachLogged: false, latestOutreachEventId: null, approachNote: null } })
    });
    await sandbox.hydrateSignalFeedbackButtons(makeRoot([usefulBtn, notUsefulBtn]));
    assert(usefulBtn._attrs['aria-pressed'] === 'true' && usefulBtn.classList.contains('signal-feedback-active'), 'REQUIRED: an account-history opportunity\'s Useful button hydrates pressed from the server\'s prior opportunity_useful record');
    assert(notUsefulBtn._attrs['aria-pressed'] === undefined, 'REQUIRED: the sibling Not-useful button stays unpressed');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
