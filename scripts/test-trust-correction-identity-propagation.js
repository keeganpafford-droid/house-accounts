// Trust correction (entity-disambiguation), founder QA follow-up: confirmed
// production defect. The Dover Holiday Parade signal persisted correctly as
// payload.identityConfidence = 'unconfirmed', but the live dashboard showed
// it as the primary opportunity labeled "Verified Opportunity" -- because
// api/get-dashboard.js's signalToOpportunity() builds the opportunity object
// consumed by every dashboard-side trust gate as an explicit field-by-field
// object literal, and identityConfidence was never added to that list when
// the tri-state grounding model shipped. rowToSignal() (the layer below it)
// already exposed the field correctly via its {...payload} spread -- the
// drop happened one layer up, between rowToSignal() and signalToOpportunity().
//
// This means every dashboard-side trust-gating test written earlier in this
// initiative (scripts/test-trust-correction-dashboard-gating.js) was
// correct about the GATE LOGIC, but used hand-built fixtures that already
// carried identityConfidence as a plain property -- never exercising the
// real read path from a raw ha_signals row. This file closes that gap: it
// runs the REAL, exported get-dashboard.js functions (no vm extraction, no
// reimplementation) end-to-end from a raw row shape to the object that
// actually reaches accountOpportunityCluster()/isPriorityEligibleOpportunity().
//
// Usage: node scripts/test-trust-correction-identity-propagation.js
import { rowToSignal, signalToOpportunity, buildAccountsFromRows, canonicalizeAccountOpportunities } from '../api/get-dashboard.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function doverRow(identityConfidence, overrides = {}) {
  return {
    account_name: 'Dover Honda',
    signal_type: 'Business Activity',
    title: 'Dover Honda Signs On as Dover Holiday Parade Sponsor',
    confidence: 55,
    source_url: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026',
    source_domain: 'dovernh.org',
    event_fingerprint: 'dover honda|event_community||2026',
    first_seen_at: '2026-08-09T00:41:57.039584+00:00',
    last_seen_at: '2026-08-09T02:19:45.286689+00:00',
    payload: {
      ...(identityConfidence !== undefined ? { identityConfidence } : {}),
      signalTitle: 'Dover Honda Signs On as Dover Holiday Parade Sponsor',
      whatChanged: 'Dover Honda will be the lead sponsor of this year\'s parade.',
      sourceUrl: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026',
      actionabilityStatus: { status: 'recent-past', isPriorityEligible: true }
    },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Layer-by-layer trace, matching the founder's exact requested trace order.
// ---------------------------------------------------------------------------
const unconfirmedRow = doverRow('unconfirmed');

const signal = rowToSignal(unconfirmedRow);
assert(
  signal.identityConfidence === 'unconfirmed',
  '1) rowToSignal() correctly exposes payload.identityConfidence at the top level (this layer was never broken)'
);

const opp = signalToOpportunity(unconfirmedRow);
assert(
  opp.identityConfidence === 'unconfirmed',
  '2) signalToOpportunity() now carries identityConfidence through -- FIXED (previously undefined; see the confirmed-defect test below for the regression proof)'
);

// ---------------------------------------------------------------------------
// The three-way distinction must survive identically: explicit 'confirmed',
// explicit 'unconfirmed', and true legacy (field absent) must never collapse
// into each other anywhere in this pipeline.
// ---------------------------------------------------------------------------
assert(
  signalToOpportunity(doverRow('confirmed')).identityConfidence === 'confirmed',
  '3) an explicitly confirmed row reaches the opportunity object as confirmed'
);
assert(
  signalToOpportunity(doverRow(undefined)).identityConfidence === undefined,
  '4) a true legacy row (no identityConfidence in payload at all) reaches the opportunity object as undefined, not coerced to any tri-state value -- the legacy-grandfather distinction survives'
);

// ---------------------------------------------------------------------------
// Full pipeline: buildAccountsFromRows() -> canonicalizeAccountOpportunities()
// (which runs resolveOpportunityEvents(), the merge step that must propagate
// the STRONGEST identityConfidence across a merged group). Proves the fix
// survives past signalToOpportunity() into the actual account.futureOpportunities
// array real dashboard code consumes.
// ---------------------------------------------------------------------------
const { accountList } = buildAccountsFromRows([], [unconfirmedRow]);
const doverAccount = accountList.find(a => a.name === 'Dover Honda');
assert(
  Boolean(doverAccount),
  '5) buildAccountsFromRows() produces a Dover Honda account from the raw signal row'
);
// Monitoring Identity V1: an 'unconfirmed' signal with no strong
// account-side corroborator is now correctly `secondary`-tier -- it stays
// visible in acct.signals (Research Details), but no longer reaches
// futureOpportunities (see classifyMonitoringSignalEligibility()). This
// test's own purpose (does the identityConfidence label survive intact
// through rowToSignal() -> buildAccountsFromRows()) is unaffected by that
// -- checked here against acct.signals, the surface an uncorroborated
// signal legitimately still reaches, instead of futureOpportunities.
const doverSignal = (doverAccount?.signals || [])[0];
assert(
  doverSignal?.identityConfidence === 'unconfirmed',
  '6) after buildAccountsFromRows(), the account.signals entry (Research Details -- this row has no strong corroborator, so it is correctly secondary-tier, not in futureOpportunities) still carries identityConfidence -- the label survives the pipeline, not just signalToOpportunity() in isolation'
);

// A confirmed candidate merged alongside an unconfirmed one for what
// resolveOpportunityEvents() considers the same event must keep 'confirmed'
// (mirrors the identityConfidence-merge fix already proven against
// signal-intelligence.js's resolveEvents() directly -- this proves it also
// holds through get-dashboard.js's own call site). The confirmed variant
// carries a real strong corroborator reason (a verified company domain) --
// consistent with what verifyCandidateCompanyGrounding() actually requires
// to reach 'confirmed' -- so the merged result is priority-eligible and
// reaches futureOpportunities, where the label-survival proof happens.
const confirmedVariant = doverRow('confirmed', {
  source_url: 'https://doverhonda.com/news/parade', source_domain: 'doverhonda.com',
  payload: { identityConfidence: 'confirmed', identityCorroboratorReasons: ['verified company domain'], signalTitle: 'Dover Honda Signs On as Dover Holiday Parade Sponsor', whatChanged: 'Dover Honda will be the lead sponsor of this year\'s parade.', sourceUrl: 'https://doverhonda.com/news/parade', actionabilityStatus: { status: 'recent-past', isPriorityEligible: true } }
});
const unconfirmedVariant = doverRow('unconfirmed');
const { accountList: mergedList } = buildAccountsFromRows([], [confirmedVariant, unconfirmedVariant]);
const mergedDover = mergedList.find(a => a.name === 'Dover Honda');
const mergedOpp = (mergedDover?.futureOpportunities || [])[0];
assert(
  mergedOpp?.identityConfidence === 'confirmed',
  '7) two representations of the same event (one confirmed with a real strong corroborator, one unconfirmed) merged through the real get-dashboard.js pipeline keep identityConfidence=confirmed'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
