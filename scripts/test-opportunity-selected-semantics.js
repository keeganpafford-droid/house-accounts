// Organizational Learning V1B, founder verification round: exact semantics
// of opportunity_selected vs prepare_call_opened for Follow-Up/Repeat-
// Pattern account-history opportunity cards, proved against the REAL,
// verbatim renderPrepareForCallButton()/createSalesPlayPanel()/
// hydrateSignalFeedbackButtons()/resolveSignalEventTarget()/
// logOpportunityAwareEvent() from dashboard/index.html (extracted via
// dashboard-extract.js), not a reimplementation.
//
// Contract being proved:
//   - prepare_call_opened fires on EVERY "Prepare for Call" open, for both
//     a signal-driven opportunity and an account-history one.
//   - opportunity_selected fires ONLY for a Follow-Up/Repeat-Pattern
//     account-history opportunity, and ONLY on the first-ever open of that
//     exact opportunity instance -- never on a reopen, never for a
//     signal-driven opportunity (that family's own "chose to work this"
//     signal is signal_selected, fired from an entirely separate "Use This
//     Signal" gesture this file does not touch).
//   - the gate is driven by prior hydration (hydrateSignalFeedbackButtons()
//     reading the server's own `selected` state), not by any client-side
//     session memory -- so it survives a page reload.
//   - a hydrated "Used ✓" badge reflects that same prior state.
//
// Usage: node scripts/test-opportunity-selected-semantics.js
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const TIMEBOX_CONFIG_SRC = extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG');
const IS_RELATIONSHIP_EXPANSION_SRC = extractFn(DASHBOARD_SRC, 'isRelationshipExpansionOpportunity');
const DEDUPE_AND_IDENTITY_BLOCK = extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(', 'function isWebResearchSignal(opp){');
const CARD_AND_MODAL_BLOCK = extractRange(DASHBOARD_SRC, 'function confidenceLabel(', 'function addSignalDerivedOpportunities(');
const OPPORTUNITY_GENERATION_BLOCK = extractRange(DASHBOARD_SRC, 'function estimateFutureValue(account, opportunityType){', 'function getPriorityTier(');
const SALES_PLAY_BLOCK = extractRange(DASHBOARD_SRC, 'function salesPlayModeFromOpp(', 'function renderPipelineTable(');
const SCORING_AND_TIMEBOX_BLOCK = extractRange(DASHBOARD_SRC, 'function normalizeSignalLayerType(', 'function feedSummary(');
const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
const FMT_MONEY_SRC = extractFn(DASHBOARD_SRC, 'fmtMoney');
const CLAMP_SCORE_SRC = extractFn(DASHBOARD_SRC, 'clampScore');
const REASON_AND_STARTER_BLOCK = extractRange(DASHBOARD_SRC, 'function getReasonToReachOutTitle(opp){', 'function getConversationStarterText(');
// The three V1B dispatch functions -- REAL, not stubbed, since this file
// exists specifically to prove their behavior end-to-end.
const RESOLVE_TARGET_SRC = extractFn(DASHBOARD_SRC, 'resolveSignalEventTarget');
const OPPORTUNITY_EVENT_TYPE_MAP_SRC = extractFn(DASHBOARD_SRC, 'OPPORTUNITY_EVENT_TYPE_MAP');
const LOG_OPPORTUNITY_AWARE_EVENT_SRC = extractFn(DASHBOARD_SRC, 'logOpportunityAwareEvent');
const HYDRATE_FEEDBACK_SRC = extractFn(DASHBOARD_SRC, 'hydrateSignalFeedbackButtons');
const SIGNAL_STATE_KEY_SRC = extractFn(DASHBOARD_SRC, 'signalStateKey');

// Everything below this is genuinely irrelevant to the semantics being
// proved (network transport, note UI) -- stubbed exactly like the existing
// dashboard-extraction test files' own established convention.
const STUB_SOURCE = `
function fetchSignalEventStates(){ return Promise.resolve(__fetchStatesImpl ? __fetchStatesImpl() : {}); }
function wireOutreachRow(){}
function hydrateOutreachRow(){ return Promise.resolve(); }
`;

function makeSandbox({ fetchStatesImpl, logSignalEventImpl } = {}){
  const fakeModal = { querySelector: () => ({ focus(){} }), querySelectorAll: () => [] };
  const calls = { logSignalEvent: [] };
  const sandbox = {
    console,
    window: { accountRadarAccounts: [], HouseAccountsHeader: { beginOverlay(){}, endOverlay(){} } },
    document: {
      getElementById: () => ({ textContent: '', innerHTML: '', style: {} }),
      querySelectorAll: () => [],
      body: {
        insertAdjacentHTML(pos, html){ sandbox.__lastSalesPlayHtml = html; },
        get lastElementChild(){ return fakeModal; }
      }
    },
    isWarmAccount: () => false,
    logSignalEvent: async (eventType, opts) => {
      calls.logSignalEvent.push({ eventType, opts });
      return logSignalEventImpl ? logSignalEventImpl(eventType, opts) : { ok: true, id: `event-${calls.logSignalEvent.length}` };
    },
    generateClientEventId: (() => { let n = 0; return () => `client-event-${++n}`; })(),
    __fetchStatesImpl: fetchStatesImpl,
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  const fullSource = [
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    ESCAPE_HTML_SRC,
    FMT_MONEY_SRC,
    CLAMP_SCORE_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    RESOLVE_TARGET_SRC,
    OPPORTUNITY_EVENT_TYPE_MAP_SRC,
    LOG_OPPORTUNITY_AWARE_EVENT_SRC,
    CARD_AND_MODAL_BLOCK,
    OPPORTUNITY_GENERATION_BLOCK,
    REASON_AND_STARTER_BLOCK,
    SALES_PLAY_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK,
    HYDRATE_FEEDBACK_SRC,
    SIGNAL_STATE_KEY_SRC,
    STUB_SOURCE,
    // The real source assigns window.createSalesPlayPanel = function(){...};
    // every internal call site resolves the bare identifier
    // `createSalesPlayPanel` against the shared global object, exactly like
    // a classic (non-module) browser script -- alias it here so this vm
    // context resolves it the same way, without touching the extracted
    // source itself (same pattern as test-final-beta-signal-intelligence-correction.js).
    `this.createSalesPlayPanel = window.createSalesPlayPanel;`
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'opportunity-selected-semantics-extract.js' }).runInContext(sandbox);
  return { sandbox, calls };
}

function d(dateStr){ return new Date(dateStr); }
function baseOpp(overrides = {}){
  return {
    account: 'Acme Co', accountName: 'Acme Co', uploadId: 'upload-1',
    industry: 'Other', opportunity: 'Employee Recognition Program', opportunityName: 'Employee Recognition Program',
    estimatedValue: 4000, confidence: 60, quickWinScore: 60, relationshipStrength: 40, closeProbability: 55,
    opportunityType: 'FOLLOW UP', signalLayerType: 'Follow-Up Signal', signalDate: '2025-06-01',
    reasonToReachOut: 'Recent order delivered or completed', conversationStarter: 'Check in and ask how the recent order was received.',
    relationshipMode: 'warm', contact: '', contactTitle: '', buyer: '', suggestedContact: '',
    department: 'Unknown Department', buyingCategory: 'Apparel', email: '', evidence: [], suggestedProducts: [],
    historicalPurchaseData: [], businessSignals: [], purchases: [{ category: 'Apparel', revenue: 2000, date: d('2025-06-01') }],
    templateKey: 'generic_employee_recognition',
    ...overrides
  };
}

async function run(){
  // ---------------------------------------------------------------------
  // renderPrepareForCallButton() (via renderRepOpportunityCard()): the
  // account-history variant renders only with a durable ref; a signal-driven
  // or not-yet-reconciled opp keeps the original inline-onclick button.
  // ---------------------------------------------------------------------
  {
    const { sandbox } = makeSandbox();
    const noRef = sandbox.renderRepOpportunityCard(baseOpp());
    assert(!noRef.includes('account-history-prepare-btn'), 'REQUIRED: with no durable ref, the card renders the ORIGINAL inline-onclick button, not the delegated account-history one');
    assert(noRef.includes("onclick='createSalesPlayPanel("), 'sanity: the original inline onclick is still present for a non-account-history opp');

    const withRef = sandbox.renderRepOpportunityCard(baseOpp({ accountOpportunityId: 'opp-1', accountOpportunityFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01' }));
    assert(withRef.includes('class="btn btn-generate-play account-history-prepare-btn"'), 'REQUIRED: with a durable ref, the card renders the delegated account-history button');
    assert(withRef.includes('data-opportunity-id="opp-1"') && withRef.includes('data-event-fingerprint="opp:follow_up:v1:acme|last:2025-06-01"'), 'the delegated button carries the exact durable ref');
    assert(withRef.includes('data-opportunity-payload='), 'the delegated button carries a full opportunity payload for createSalesPlayPanel() to consume at click time');
    assert(withRef.includes('class="opportunity-used-status" hidden'), 'REQUIRED: the "Used ✓" badge renders hidden by default -- only hydration reveals it');
  }

  // ---------------------------------------------------------------------
  // createSalesPlayPanel(): prepare_call_opened fires on every open;
  // opportunity_selected (mapped from signal_selected) fires ONLY when
  // opts.isFirstOpportunitySelection is explicitly true.
  // ---------------------------------------------------------------------
  {
    const { sandbox, calls } = makeSandbox();
    const opp = baseOpp({ accountOpportunityId: 'opp-1', accountOpportunityFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01' });
    sandbox.createSalesPlayPanel(opp, { isFirstOpportunitySelection: true });
    const types = calls.logSignalEvent.map(c => c.eventType);
    assert(types.includes('prepare_call_opened'), 'REQUIRED: prepare_call_opened fires on the first open');
    assert(types.includes('opportunity_selected'), 'REQUIRED: opportunity_selected fires on the first-ever open of an account-history opportunity (isFirstOpportunitySelection:true)');
    const selectedCall = calls.logSignalEvent.find(c => c.eventType === 'opportunity_selected');
    assert(selectedCall.opts.opportunityId === 'opp-1', 'the opportunity_selected event carries the exact durable opportunityId, never a signalId');
  }
  {
    const { sandbox, calls } = makeSandbox();
    const opp = baseOpp({ accountOpportunityId: 'opp-1', accountOpportunityFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01' });
    sandbox.createSalesPlayPanel(opp, { isFirstOpportunitySelection: false });
    const types = calls.logSignalEvent.map(c => c.eventType);
    assert(types.includes('prepare_call_opened'), 'REQUIRED: prepare_call_opened STILL fires on a reopen');
    assert(!types.includes('opportunity_selected'), 'REQUIRED: reopening an already-selected opportunity (isFirstOpportunitySelection:false) never logs a second opportunity_selected');
  }
  {
    // Founder correction: the generic "View opportunities"/post-research
    // handoff (openResearchedAccountOpportunities()) never passes
    // isFirstOpportunitySelection at all -- exactly this call shape (no
    // opts object). Auto-opening an opportunity is exposure, not an
    // explicit selection gesture, so opportunity_selected must never fire
    // here even for a never-selected account-history opportunity;
    // prepare_call_opened still fires unconditionally -- the opportunity
    // WAS genuinely presented to the rep.
    const { sandbox, calls } = makeSandbox();
    const opp = baseOpp({ accountOpportunityId: 'opp-1', accountOpportunityFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01' });
    sandbox.createSalesPlayPanel(opp);
    const types = calls.logSignalEvent.map(c => c.eventType);
    assert(types.includes('prepare_call_opened'), 'REQUIRED: an auto-opened (no opts) account-history opportunity still fires prepare_call_opened -- it was genuinely presented');
    assert(!types.includes('opportunity_selected'), `REQUIRED: an auto-opened account-history opportunity NEVER fires opportunity_selected merely for being presented (got ${JSON.stringify(types)})`);
  }
  {
    // Signal-driven opportunities are entirely unaffected: no
    // isFirstOpportunitySelection is ever passed for them (every real call
    // site omits it), so opportunity_selected never fires, and
    // prepare_call_opened resolves to the signal_* family, not opportunity_*.
    const { sandbox, calls } = makeSandbox();
    const signalOpp = baseOpp({ id: 'sig-1', eventFingerprint: 'fp-1' });
    delete signalOpp.accountOpportunityId; delete signalOpp.accountOpportunityFingerprint;
    sandbox.createSalesPlayPanel(signalOpp, {});
    const types = calls.logSignalEvent.map(c => c.eventType);
    assert(types.includes('prepare_call_opened') && !types.includes('opportunity_selected') && !types.includes('signal_selected'), `REQUIRED: a signal-driven opportunity's Prepare for Call open never fires opportunity_selected OR signal_selected -- only prepare_call_opened (got ${JSON.stringify(types)})`);
    const prepareCall = calls.logSignalEvent.find(c => c.eventType === 'prepare_call_opened');
    assert(prepareCall.opts.signalId === 'sig-1' && prepareCall.opts.opportunityId === undefined, 'the shared prepare_call_opened event resolves to the signal family for a signal-driven opp');
  }
  {
    // No identity at all (a brand-new, never-reconciled account-history
    // opportunity) -- logs nothing, not even prepare_call_opened. Never
    // fabricates identity.
    const { sandbox, calls } = makeSandbox();
    const opp = baseOpp();
    delete opp.id; delete opp.eventFingerprint;
    sandbox.createSalesPlayPanel(opp, { isFirstOpportunitySelection: true });
    assert(calls.logSignalEvent.length === 0, `REQUIRED: an opportunity with no durable identity in either family logs nothing, even when isFirstOpportunitySelection is (meaninglessly) true (got ${calls.logSignalEvent.length} calls)`);
  }

  // ---------------------------------------------------------------------
  // hydrateSignalFeedbackButtons(): reflects prior selection from the
  // server's OWN `selected` state -- this is what makes the gate durable
  // across a reload, not client-side session memory.
  // ---------------------------------------------------------------------
  {
    const { sandbox } = makeSandbox({
      fetchStatesImpl: () => ({ 'opp:follow_up:v1:acme|last:2025-06-01::Acme Co': { feedback: null, selected: true, outreachLogged: false, latestOutreachEventId: null, approachNote: null } })
    });
    const statusEl = { hidden: true };
    const btn = {
      dataset: { eventFingerprint: 'opp:follow_up:v1:acme|last:2025-06-01', accountName: 'Acme Co' },
      parentElement: { querySelector: (sel) => sel === '.opportunity-used-status' ? statusEl : null }
    };
    const root = { querySelectorAll: (sel) => sel === '.account-history-prepare-btn[data-event-fingerprint]' ? [btn] : [] };
    await sandbox.hydrateSignalFeedbackButtons(root);
    assert(btn.dataset.opportunitySelected === '1', 'REQUIRED: hydration flags the button data-opportunity-selected="1" from the server\'s prior opportunity_selected record');
    assert(statusEl.hidden === false, 'REQUIRED: hydration reveals the "Used ✓" badge for a previously-selected opportunity');
  }
  {
    const { sandbox } = makeSandbox({ fetchStatesImpl: () => ({}) });
    const statusEl = { hidden: true };
    const btn = {
      dataset: { eventFingerprint: 'opp:follow_up:v1:beta|apparel|last:2025-03-15', accountName: 'Beta Inc' },
      parentElement: { querySelector: (sel) => sel === '.opportunity-used-status' ? statusEl : null }
    };
    const root = { querySelectorAll: (sel) => sel === '.account-history-prepare-btn[data-event-fingerprint]' ? [btn] : [] };
    await sandbox.hydrateSignalFeedbackButtons(root);
    assert(btn.dataset.opportunitySelected === undefined, 'REQUIRED: a never-selected opportunity is never flagged as selected');
    assert(statusEl.hidden === true, 'REQUIRED: the "Used ✓" badge stays hidden for a never-selected opportunity');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
