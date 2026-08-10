// Foundation freeze, Phase 1A -- Follow-Up / Repeat-Pattern persistence
// preservation. Audit found a plausible live data-loss path: the source-of-
// truth correction (api/get-dashboard.js's buildAccountsFromRows()) began
// excluding business-classified raw_data.existingSignals entries before
// reconcileStoredOpportunity() runs -- correctly -- but that function still
// force-set isVerifiedSignalOpportunity:true and defaulted signalLayerType
// to 'Business Activity Signal' on every entry it touched. Since only
// non-business entries ever reach it now, that force-set INVERTED their
// classification right back: a Follow-Up Signal loaded from a saved account
// would come back out of reconcileStoredOpportunity() looking exactly like
// a business signal to isWebResearchSignal() (dashboard/index.html), and
// the client's own write-side exclusion (serializeAccountForStorage()) would
// then drop it from the next save. Follow-Up Signals have no ha_signals
// home -- only regenerated at CSV upload -- so this was a genuine, silent,
// permanent-erasure-on-one-load-then-save-cycle bug.
//
// This test proves the full real cycle end to end: a saved account's
// raw_data is read through buildAccountsFromRows() (the real server
// function, real reconciliation), and the reconciled result is fed through
// the real client serializeAccountForStorage()/isWebResearchSignal() (the
// exact functions extracted verbatim from dashboard/index.html, not
// reimplemented) to prove what actually gets written back.
//
// Usage: node scripts/test-followup-repeat-pattern-persistence-roundtrip.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';
import { buildAccountsFromRows } from '../api/get-dashboard.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();


// Real, verbatim client-side functions -- the exact write boundary under
// test, not a reimplementation of it.
const CLASSIFIER_SRC = [
  extractFn(DASHBOARD_SRC, 'isWebResearchSignal'),
  extractFn(DASHBOARD_SRC, 'signalLayerLabel'),
  extractFn(DASHBOARD_SRC, 'isRecentAccountActivity'),
  extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType')
].join('\n\n');
const SERIALIZE_SRC = extractFn(DASHBOARD_SRC, 'serializeAccountForStorage');

function makeSandbox() {
  const sandbox = { console, Array, Object, String, Number, Boolean, JSON };
  vm.createContext(sandbox);
  new vm.Script([CLASSIFIER_SRC, SERIALIZE_SRC].join('\n\n'), { filename: 'followup-persistence-roundtrip-extract.js' }).runInContext(sandbox);
  return sandbox;
}

// ===========================================================================
// The full round trip: load saved account -> reconcile (server) ->
// serialize/save (client) -> [implicit reload: the next load reads exactly
// what was just serialized]. Fixture carries all three opportunity kinds at
// once, plus one live ha_signals row, to prove none of them interfere.
// ===========================================================================
{
  const accountRows = [{
    account_name: 'Roundtrip Co', upload_id: 'upload-rt', industry: 'Test',
    contact_name: '', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 0, relationshipStrength: 0 },
    raw_data: {
      monitoring_status: 'active',
      // A genuine Follow-Up Signal: order-history-derived, no sourceUrl, no
      // isVerifiedSignalOpportunity -- exactly the shape that must survive.
      existingSignals: [{
        account: 'Roundtrip Co', accountName: 'Roundtrip Co',
        signalLayerType: 'Follow-Up Signal',
        signalTitle: 'Recent order creates a natural follow-up',
        reasonToReachOut: 'They closed an order 30 days ago; a natural check-in window.',
        eventDate: '2026-07-01',
        confidence: 60
      }],
      // Repeat/Pattern lives in its own dedicated field -- never reaches
      // reconcileStoredOpportunity() at all, included here to prove it's
      // genuinely unaffected by this fix, not merely untested.
      repeatPatterns: [{
        account: 'Roundtrip Co', accountName: 'Roundtrip Co',
        signalLayerType: 'Repeat / Pattern Signal',
        signalTitle: 'Repeat buying window detected',
        opportunityType: 'REPEAT PATTERN',
        confidence: 55
      }]
    }
  }];
  const signalRows = [{
    account_name: 'Roundtrip Co', upload_id: 'upload-rt', signal_type: 'Expansion',
    title: 'Roundtrip Co Opens New Facility',
    source_url: 'https://example.com/roundtrip-co-new-facility',
    source_domain: 'example.com', confidence: 85,
    published_at: '2026-07-01T00:00:00Z',
    payload: {
      isReal: true, identityConfidence: 'confirmed',
      whatChanged: 'Roundtrip Co opened a new distribution facility.',
      eventDate: '2026-07-01', event_date: '2026-07-01',
      actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true },
      confidenceScore: 85
    },
    first_seen_at: '2026-07-01T00:00:00Z', last_seen_at: '2026-08-09T13:00:00.000Z'
  }];

  // Step 1: load + reconcile (real server function).
  const { accountList } = buildAccountsFromRows(accountRows, signalRows);
  const account = accountList.find(a => a.name === 'Roundtrip Co');
  assert(!!account, 'sanity: Roundtrip Co survives buildAccountsFromRows()');

  const followUp = account.futureOpportunities.find(o => o.signalLayerType === 'Follow-Up Signal' || /natural follow-up/i.test(o.signalTitle || ''));
  assert(!!followUp, 'sanity: the Follow-Up Signal is present in futureOpportunities after reconciliation');
  assert(
    followUp && followUp.isVerifiedSignalOpportunity !== true,
    `1A) reconcileStoredOpportunity() no longer force-sets isVerifiedSignalOpportunity on a Follow-Up Signal (got ${JSON.stringify(followUp && followUp.isVerifiedSignalOpportunity)})`
  );
  assert(
    followUp && followUp.signalLayerType === 'Follow-Up Signal',
    `1A) reconcileStoredOpportunity() preserves the original Follow-Up Signal signalLayerType, never defaults it to Business Activity Signal (got "${followUp && followUp.signalLayerType}")`
  );

  const liveSignal = account.futureOpportunities.find(o => /New Facility/i.test(o.signalTitle || o.title || ''));
  assert(!!liveSignal, '1A) the live ha_signals-sourced business signal is present and unaffected by this fix');

  // Step 2: serialize/save (real client function, extracted verbatim).
  const sandbox = makeSandbox();
  const serialized = sandbox.serializeAccountForStorage(account, { includeSignals: true });

  assert(
    Array.isArray(serialized.rawData.existingSignals) && serialized.rawData.existingSignals.some(o => o.signalLayerType === 'Follow-Up Signal' || /natural follow-up/i.test(o.signalTitle || '')),
    '1A) REQUIRED: the Follow-Up Signal survives the full load-reconcile-save round trip into existingSignals -- this is the exact data-loss path the audit found, now closed'
  );
  assert(
    !serialized.rawData.existingSignals.some(o => /New Facility/i.test(o.signalTitle || o.title || '')),
    '1A) REQUIRED: the live ha_signals-sourced business signal is correctly EXCLUDED from existingSignals -- canonical ha_signals source-of-truth remains intact, not weakened by this fix'
  );

  // Step 3 (implicit reload): the account.futureOpportunities the server
  // would rebuild on the NEXT load must have been drawn from an
  // existingSignals array that still contains the Follow-Up Signal --
  // already proven above. A second buildAccountsFromRows() pass over the
  // just-serialized raw_data confirms the cycle is stable (idempotent),
  // not merely correct once.
  const reloadedAccountRows = [{ ...accountRows[0], raw_data: { ...accountRows[0].raw_data, existingSignals: serialized.rawData.existingSignals, repeatPatterns: serialized.rawData.repeatPatterns } }];
  const { accountList: reloadedList } = buildAccountsFromRows(reloadedAccountRows, signalRows);
  const reloaded = reloadedList.find(a => a.name === 'Roundtrip Co');
  const reloadedFollowUp = reloaded.futureOpportunities.find(o => o.signalLayerType === 'Follow-Up Signal' || /natural follow-up/i.test(o.signalTitle || ''));
  assert(!!reloadedFollowUp, '1A) REQUIRED: the Follow-Up Signal survives a SECOND load-reconcile-save cycle -- the fix is stable, not a one-time accident');
  assert(reloadedFollowUp && reloadedFollowUp.isVerifiedSignalOpportunity !== true, '1A) the Follow-Up Signal still carries no forced business flag after a second cycle');
}

// ===========================================================================
// Repeat/Pattern Signal: never touches reconcileStoredOpportunity() at all
// (its own dedicated raw_data.repeatPatterns field, untouched by this fix),
// confirmed to still round-trip correctly end to end.
// ===========================================================================
{
  const accountRows = [{
    account_name: 'Repeat Co', upload_id: 'upload-repeat', industry: 'Test',
    contact_name: '', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 0, relationshipStrength: 0 },
    raw_data: {
      monitoring_status: 'active',
      repeatPatterns: [{
        account: 'Repeat Co', accountName: 'Repeat Co',
        signalLayerType: 'Repeat / Pattern Signal',
        signalTitle: 'Quarterly reorder pattern detected',
        opportunityType: 'REPEAT PATTERN',
        confidence: 62
      }]
    }
  }];
  const { accountList } = buildAccountsFromRows(accountRows, []);
  const account = accountList.find(a => a.name === 'Repeat Co');
  const repeatOpp = account.futureOpportunities.find(o => o.signalLayerType === 'Repeat / Pattern Signal');
  assert(!!repeatOpp, '1A) the Repeat/Pattern Signal is present after reconciliation (never reached reconcileStoredOpportunity() at all)');
  assert(repeatOpp && repeatOpp.opportunityType === 'REPEAT PATTERN', `1A) its own opportunityType marker is untouched (got "${repeatOpp && repeatOpp.opportunityType}")`);

  const sandbox = makeSandbox();
  const serialized = sandbox.serializeAccountForStorage(account, { includeSignals: true });
  assert(
    Array.isArray(serialized.rawData.repeatPatterns) && serialized.rawData.repeatPatterns.some(o => o.signalLayerType === 'Repeat / Pattern Signal'),
    '1A) the Repeat/Pattern Signal round-trips into its own dedicated repeatPatterns field on save'
  );
}

// ===========================================================================
// Canonical exclusion still intact: a stale, old-shaped business signal
// (the exact Dover-Honda-class fixture the source-of-truth sprint fixed)
// must still be excluded by this same reconciliation boundary -- proving
// 1A's fix didn't weaken the read-side exclusion it sits right next to.
// ===========================================================================
{
  const accountRows = [{
    account_name: 'Stale Business Co', upload_id: 'upload-stale', industry: 'Test',
    contact_name: '', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 0, relationshipStrength: 0 },
    raw_data: {
      monitoring_status: 'active',
      existingSignals: [{
        account: 'Stale Business Co', accountName: 'Stale Business Co',
        signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
        signalTitle: 'Stale Business Co Wins Major Contract',
        sourceUrl: 'https://example.com/stale-business-co-contract',
        eventDate: '2025-01-01',
        confidence: 80
      }]
    }
  }];
  const { accountList } = buildAccountsFromRows(accountRows, []);
  const account = accountList.find(a => a.name === 'Stale Business Co');
  assert(account.futureOpportunities.length === 0, `1A) a stale business-classified existingSignals entry is still excluded entirely -- canonical ha_signals exclusivity intact (got ${account.futureOpportunities.length} opportunities)`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
