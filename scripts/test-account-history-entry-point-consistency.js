// Organizational Learning V1B, founder verification round (item 3): closes
// the entry-point consistency gap flagged in the prior report --
// opportunity_selected/"Used ✓" first-use semantics were only wired for
// the primary opportunity card. This proves the SAME invariant now holds
// for the two other real entry points a rep can use to intentionally open/
// work a persisted Follow-Up/Repeat-Pattern account-history opportunity:
//   - the Additional Opportunities "Prep this call ->" swap link
//     (prepAdditionalOpportunityCall()), and
//   - the post-research "View opportunities" handoff
//     (openResearchedAccountOpportunities()), which auto-opens the
//     top-ranked opportunity for an account.
//
// Both are proved against the REAL, verbatim source (extracted via
// dashboard-extract.js) -- resolveSignalEventTarget()/
// shouldMarkFirstOpportunitySelection()/logOpportunityAwareEvent() are
// real, not stubbed, so this is the actual decision logic, not a
// reimplementation. Only the network transport (logSignalEvent) and
// batched read-back (fetchSignalEventStates) are stubbed, matching this
// codebase's established convention.
//
// Contract being proved (same invariant as
// scripts/test-opportunity-selected-semantics.js, now for these two entry
// points):
//   - first-ever intentional use of an account-history opportunity through
//     either entry point creates exactly one opportunity_selected AND a
//     prepare_call_opened.
//   - reopening an already-selected instance through either entry point
//     creates only prepare_call_opened, never a second opportunity_selected.
//   - neither entry point ever fires opportunity_selected (or
//     signal_selected) for a signal-driven opportunity -- merely rendering,
//     listing, or swapping a signal-driven item into view is never treated
//     as intentional use of an account-history opportunity.
//
// Usage: node scripts/test-account-history-entry-point-consistency.js
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
const CARD_AND_MODAL_BLOCK = extractRange(DASHBOARD_SRC, 'function confidenceLabel(', 'function isSignalPriorityEligible(');
const SCORING_AND_TIMEBOX_BLOCK = extractRange(DASHBOARD_SRC, 'function normalizeSignalLayerType(', 'function feedSummary(');
const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
const CLAMP_SCORE_SRC = extractFn(DASHBOARD_SRC, 'clampScore');
const OPEN_RESEARCHED_ACCOUNT_OPPORTUNITIES_SRC = extractFn(DASHBOARD_SRC, 'openResearchedAccountOpportunities');
// The real V1B dispatch functions -- not stubbed, since this file exists
// specifically to prove their behavior through these two entry points.
const RESOLVE_TARGET_SRC = extractFn(DASHBOARD_SRC, 'resolveSignalEventTarget');
const OPPORTUNITY_EVENT_TYPE_MAP_SRC = extractFn(DASHBOARD_SRC, 'OPPORTUNITY_EVENT_TYPE_MAP');
const LOG_OPPORTUNITY_AWARE_EVENT_SRC = extractFn(DASHBOARD_SRC, 'logOpportunityAwareEvent');
const SHOULD_MARK_FIRST_SRC = extractFn(DASHBOARD_SRC, 'shouldMarkFirstOpportunitySelection');
const SIGNAL_STATE_KEY_SRC = extractFn(DASHBOARD_SRC, 'signalStateKey');
const PREP_ADDITIONAL_SRC = extractFn(DASHBOARD_SRC, 'prepAdditionalOpportunityCall');

function makeSandbox({ fetchStatesImpl } = {}){
  const calls = { logSignalEvent: [], createSalesPlayPanel: [] };
  const sandbox = {
    console,
    window: {
      accountRadarAccounts: [],
      HouseAccountsHeader: { beginOverlay(){}, endOverlay(){} },
      HouseAccountManager: { close(){}, isOpen(){ return false; }, showError(){}, showResearchResults(){} }
    },
    document: { getElementById: () => ({ textContent: '', innerHTML: '', style: {} }), querySelectorAll: () => [] },
    isWarmAccount: () => false,
    refreshAggregateDashboard: async () => ({ ok: true }),
    createSalesPlayPanel: (opp, opts) => { calls.createSalesPlayPanel.push({ opp, opts }); },
    logSignalEvent: async (eventType, opts) => { calls.logSignalEvent.push({ eventType, opts }); return { ok: true, id: `event-${calls.logSignalEvent.length}` }; },
    fetchSignalEventStates: async (keys) => fetchStatesImpl ? fetchStatesImpl(keys) : {},
    generateClientEventId: (() => { let n = 0; return () => `client-event-${++n}`; })(),
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON, Promise
  };
  vm.createContext(sandbox);
  const fullSource = [
    ESCAPE_HTML_SRC,
    CLAMP_SCORE_SRC,
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    RESOLVE_TARGET_SRC,
    OPPORTUNITY_EVENT_TYPE_MAP_SRC,
    LOG_OPPORTUNITY_AWARE_EVENT_SRC,
    SIGNAL_STATE_KEY_SRC,
    SHOULD_MARK_FIRST_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    CARD_AND_MODAL_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK,
    PREP_ADDITIONAL_SRC,
    OPEN_RESEARCHED_ACCOUNT_OPPORTUNITIES_SRC
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'account-history-entry-point-extract.js' }).runInContext(sandbox);
  return { sandbox, calls };
}

function accountHistoryOpp(overrides = {}){
  return {
    account: 'Acme Co', accountName: 'Acme Co', uploadId: 'upload-1',
    signalLayerType: 'Repeat / Pattern Signal', opportunityType: 'REPEAT PATTERN',
    category: 'Apparel', templateKey: 'repeat_pattern',
    accountOpportunityId: 'opp-1', accountOpportunityFingerprint: 'opp:repeat_pattern:v1:acme|apparel|last:2025-03-15',
    ...overrides
  };
}
function signalDrivenOpp(overrides = {}){
  return {
    account: 'Beta Inc', accountName: 'Beta Inc', uploadId: 'upload-1',
    signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    id: 'sig-1', eventFingerprint: 'fp-1', actionabilityStatus: { status: 'recent-past', isPriorityEligible: true },
    ...overrides
  };
}

async function run(){
  // ---------------------------------------------------------------------
  // prepAdditionalOpportunityCall() -- the Additional Opportunities
  // "Prep this call ->" swap link.
  // ---------------------------------------------------------------------
  {
    const { sandbox, calls } = makeSandbox({ fetchStatesImpl: () => ({}) });
    await sandbox.prepAdditionalOpportunityCall(accountHistoryOpp());
    const call = calls.createSalesPlayPanel[0];
    assert(!!call, 'sanity: createSalesPlayPanel is called');
    assert(call.opts.isFirstOpportunitySelection === true, 'REQUIRED: swapping to a never-selected account-history opportunity marks isFirstOpportunitySelection:true');
    assert(call.opts.isSwap === true, 'the swap flag is preserved alongside the new first-use flag');
    const types = calls.logSignalEvent.map(c => c.eventType);
    // createSalesPlayPanel is stubbed here (captures opts only), so this
    // proves prepAdditionalOpportunityCall() computed the CORRECT flag --
    // scripts/test-opportunity-selected-semantics.js separately proves the
    // real createSalesPlayPanel() acts correctly on that flag.
    assert(types.length === 0, 'sanity: no events are logged directly by prepAdditionalOpportunityCall() itself -- that happens inside createSalesPlayPanel(), stubbed here');
  }
  {
    const { sandbox, calls } = makeSandbox({
      fetchStatesImpl: () => ({ 'opp:repeat_pattern:v1:acme|apparel|last:2025-03-15::Acme Co': { feedback: null, selected: true, outreachLogged: false, latestOutreachEventId: null, approachNote: null } })
    });
    await sandbox.prepAdditionalOpportunityCall(accountHistoryOpp());
    const call = calls.createSalesPlayPanel[0];
    assert(call.opts.isFirstOpportunitySelection === false, 'REQUIRED: swapping to an ALREADY-selected account-history opportunity never marks a second first-use');
  }
  {
    const { sandbox, calls } = makeSandbox({ fetchStatesImpl: () => ({}) });
    await sandbox.prepAdditionalOpportunityCall(signalDrivenOpp());
    const call = calls.createSalesPlayPanel[0];
    assert(call.opts.isFirstOpportunitySelection === false, 'REQUIRED: swapping to a signal-driven opportunity never fabricates isFirstOpportunitySelection -- that gate exists only for the account-history family');
  }

  // ---------------------------------------------------------------------
  // openResearchedAccountOpportunities() -- the post-research
  // "View opportunities" handoff, auto-opening the top-ranked opportunity.
  // ---------------------------------------------------------------------
  {
    const { sandbox, calls } = makeSandbox({ fetchStatesImpl: () => ({}) });
    const accountName = 'Acme Co', uploadId = 'upload-1';
    sandbox.window.accountRadarAccounts = [{ name: accountName, uploadId, signals: [], futureOpportunities: [accountHistoryOpp({ account: accountName, uploadId })] }];
    await sandbox.openResearchedAccountOpportunities(uploadId, accountName);
    const call = calls.createSalesPlayPanel[0];
    assert(!!call, 'sanity: the top-ranked opportunity opens through createSalesPlayPanel');
    assert(call.opts.isFirstOpportunitySelection === true, 'REQUIRED: the View opportunities handoff marks isFirstOpportunitySelection:true for a never-selected account-history opportunity');
  }
  {
    const { sandbox, calls } = makeSandbox({
      fetchStatesImpl: () => ({ 'opp:repeat_pattern:v1:acme|apparel|last:2025-03-15::Acme Co': { feedback: null, selected: true, outreachLogged: false, latestOutreachEventId: null, approachNote: null } })
    });
    const accountName = 'Acme Co', uploadId = 'upload-1';
    sandbox.window.accountRadarAccounts = [{ name: accountName, uploadId, signals: [], futureOpportunities: [accountHistoryOpp({ account: accountName, uploadId })] }];
    await sandbox.openResearchedAccountOpportunities(uploadId, accountName);
    const call = calls.createSalesPlayPanel[0];
    assert(call.opts.isFirstOpportunitySelection === false, 'REQUIRED: the View opportunities handoff never re-marks an already-selected account-history opportunity');
  }
  {
    const { sandbox, calls } = makeSandbox({ fetchStatesImpl: () => ({}) });
    const accountName = 'Beta Inc', uploadId = 'upload-1';
    sandbox.window.accountRadarAccounts = [{ name: accountName, uploadId, signals: [], futureOpportunities: [signalDrivenOpp({ account: accountName, uploadId })] }];
    await sandbox.openResearchedAccountOpportunities(uploadId, accountName);
    const call = calls.createSalesPlayPanel[0];
    assert(!!call, 'sanity: a signal-driven top result still opens through createSalesPlayPanel, unaffected');
    assert(call.opts.isFirstOpportunitySelection === false, 'REQUIRED: the View opportunities handoff never fabricates isFirstOpportunitySelection for a signal-driven top result');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
