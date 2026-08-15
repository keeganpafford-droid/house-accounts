// Trust correction: source-of-truth boundary. Founder-approved architectural
// invariant -- canonical business/web-research signals shown to the rep must
// come EXCLUSIVELY from current ha_signals rows. raw_data.existingSignals
// (a snapshot the client writes into ha_accounts on every save) may only
// carry opportunity types that have no ha_signals representation at all
// (Follow-Up Signal / Repeat / Pattern Signal, both order-history-derived).
// A deleted/rejected/invalidated ha_signals business event must never be
// resurrected from raw_data -- proven live: the Dover Honda "Major Rebrand
// for 2028" Instagram-sourced signal was deleted from ha_signals (per SQL
// deletion, 2b490dd/f1ae8ac round), yet kept rendering on This Week's
// Priorities because api/get-dashboard.js's buildAccountsFromRows()
// unconditionally merged the account's own frozen raw_data.existingSignals
// snapshot alongside live ha_signals rows, with NO dedup/reconciliation ever
// run between the two sources.
//
// Deliberate design choice (source exclusivity, not fingerprint
// reconciliation): a raw_data.existingSignals entry classified as a
// business-activity signal (isBusinessSignalOpportunity()) is now dropped
// UNCONDITIONALLY at the read boundary -- never matched against a live
// ha_signals row by eventFingerprint or any other resemblance heuristic.
// Old snapshots may lack fingerprints entirely, fingerprints are already
// known to drift, and "try to find an old snapshot that looks like the
// deleted row" is exactly the failure mode this round rejects: a deleted
// live row must mean the opportunity is gone, full stop.
//
// Read-side change: api/get-dashboard.js's buildAccountsFromRows() (via the
// widened isBusinessSignalOpportunity(), which now also treats a bare
// sourceUrl as sufficient evidence -- closing the exact old-shape gap that
// function's own header comment already documented).
// Write-side change: dashboard/index.html's serializeAccountForStorage(),
// using the SAME classifier the client already trusts elsewhere
// (isWebResearchSignal()) rather than inventing a new taxonomy -- stops
// putting canonical business signals into existingSignals going forward, so
// old data is harmless and new saves stop creating more duplicate truth. No
// DB migration: old frozen snapshots stay physically present but become
// inert the moment this read-side filter is live.
//
// Usage: node scripts/test-trust-correction-source-of-truth-boundary.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';
import { buildAccountsFromRows } from '../api/get-dashboard.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();


// Real, verbatim client-side functions: the classifier the write-side fix
// reuses (isWebResearchSignal() and its own dependency chain), plus
// serializeAccountForStorage() itself -- the actual write boundary under
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
  new vm.Script([CLASSIFIER_SRC, SERIALIZE_SRC].join('\n\n'), { filename: 'source-of-truth-boundary-extract.js' }).runInContext(sandbox);
  return sandbox;
}

// ===========================================================================
// The exact live Dover Honda fixture (per the founder's own confirmed
// post-deletion DB state): the stale raw_data snapshot still physically
// contains "Major Rebrand for 2028" (Instagram-sourced, no ha_signals row
// left for it -- deleted per the 2b490dd/f1ae8ac cleanup SQL), while the
// confirmed dovernh.org Holiday Parade signal exists as a live ha_signals
// row. No manual raw-data cleanup performed -- this proves server truth
// wins even with the physically-stale row still sitting there.
// ===========================================================================
{
  const accountRows = [{
    account_name: 'Dover Honda', upload_id: 'upload-dover', industry: 'Automotive',
    contact_name: 'Paula Redden', contact_email: 'predden@iclautos.com',
    metrics: { revenue: 0, orderCount: 0, confidence: 0, relationshipStrength: 0 },
    raw_data: {
      monitoring_status: 'active',
      website: 'iclautos.com',
      // The exact stale snapshot: a real Business Activity Signal shape
      // (signalLayerType + isVerifiedSignalOpportunity + sourceUrl), never
      // cleaned up per the founder's explicit instruction to leave it
      // physically present as the acceptance fixture.
      existingSignals: [{
        account: 'Dover Honda', accountName: 'Dover Honda',
        signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
        canonicalEventType: 'REBRAND', opportunityType: 'REBRAND',
        signalTitle: 'Major Rebrand for 2028',
        signalSummary: 'The Indianapolis, IN dealership celebrated its major rebrand for 2028.',
        sourceName: 'Instagram',
        sourceUrl: 'https://www.instagram.com/reel/Da7u-CzAB8Y/',
        eventDate: '2028-01-01', eventDateConfidence: 'exact',
        publicationDate: '2026-01-01', publishedDate: '2026-01-01',
        actionabilityStatus: { status: 'upcoming', tense: 'future', isPriorityEligible: true },
        confidence: 74, commercialScore: 74
      }]
    }
  }];
  const signalRows = [{
    account_name: 'Dover Honda', upload_id: 'upload-dover', signal_type: 'Community / CSR',
    title: 'Dover Honda Signs On as Dover Holiday Parade Sponsor',
    source_url: 'https://www.dovernh.org/news/details/dover-honda-parade-sponsor',
    source_domain: 'dovernh.org', confidence: 66,
    published_at: '2026-07-23T00:00:00Z',
    payload: {
      isReal: true, identityConfidence: 'confirmed', identityCorroboratorReasons: ['verified company domain'],
      whatChanged: 'Dover Honda will be the lead sponsor of the 2026 Dover Holiday Parade.',
      signalDetail: 'Dover Honda will be the lead sponsor of the 2026 Dover Holiday Parade.',
      eventDate: '2026-07-23', event_date: '2026-07-23',
      publicationDate: '2026-07-23T00:00:00Z', publishedDate: '2026-07-23T00:00:00Z',
      actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true },
      confidenceScore: 66
    },
    first_seen_at: '2026-07-23T00:00:00Z', last_seen_at: '2026-08-09T13:27:46.360Z'
  }];

  const { accountList } = buildAccountsFromRows(accountRows, signalRows);
  const dover = accountList.find(a => a.name === 'Dover Honda');
  assert(!!dover, '8) Dover Honda account survives buildAccountsFromRows() with the stale snapshot still physically present');
  assert(
    !dover.futureOpportunities.some(o => /Major Rebrand for 2028/i.test(o.signalTitle || '')),
    '8) Major Rebrand for 2028 is ABSENT from futureOpportunities even though the stale raw_data snapshot still physically contains it and was never manually cleaned up'
  );
  assert(
    !dover.futureOpportunities.some(o => /Da7u-CzAB8Y/.test(o.sourceUrl || '')),
    '8) the contaminated Instagram sourceUrl never survives into futureOpportunities either'
  );
  const parade = dover.futureOpportunities.find(o => /Holiday Parade/i.test(o.signalTitle || ''));
  assert(!!parade, '8) the confirmed dovernh.org Holiday Parade signal IS present -- server truth wins, not "nothing renders"');
  assert(parade.identityConfidence === 'confirmed', `8) the Parade signal keeps its confirmed identityConfidence (got ${parade.identityConfidence})`);
  assert(parade.actionabilityStatus?.isPriorityEligible === true, '8) the Parade signal is priority-eligible (present and eligible, per the required end result)');
  assert(dover.futureOpportunities.length === 1, `8) exactly one opportunity survives -- the live Parade signal only, no residual entry from the excluded snapshot (got ${dover.futureOpportunities.length})`);
}

// ===========================================================================
// 1) a stale business signal that exists ONLY in raw_data.existingSignals,
// with NO corresponding ha_signals row at all, does not render.
// ===========================================================================
{
  const accountRows = [{
    account_name: 'Stale Only Co', upload_id: 'upload-x', industry: 'Test',
    contact_name: '', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 0, relationshipStrength: 0 },
    raw_data: {
      monitoring_status: 'active',
      existingSignals: [{
        account: 'Stale Only Co', accountName: 'Stale Only Co',
        signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
        signalTitle: 'Stale Only Co Wins Major Contract',
        sourceUrl: 'https://example.com/stale-only-co-contract',
        eventDate: '2025-01-01',
        actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true },
        confidence: 80
      }]
    }
  }];
  const { accountList } = buildAccountsFromRows(accountRows, []);
  const account = accountList.find(a => a.name === 'Stale Only Co');
  assert(!!account, '1) the account itself still survives buildAccountsFromRows() even with no live signals at all');
  assert(Array.isArray(account.futureOpportunities) && account.futureOpportunities.length === 0, `1) a stale business signal existing ONLY in raw_data.existingSignals (no ha_signals row) does not render -- futureOpportunities is empty (got ${account.futureOpportunities.length})`);
}

// ===========================================================================
// 2) the same stale snapshot PLUS a current, confirmed live signal for the
// same account -- only the live signal renders.
// ===========================================================================
{
  const accountRows = [{
    account_name: 'Mixed Co', upload_id: 'upload-y', industry: 'Test',
    contact_name: '', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 0, relationshipStrength: 0 },
    raw_data: {
      monitoring_status: 'active',
      existingSignals: [{
        account: 'Mixed Co', accountName: 'Mixed Co',
        signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
        signalTitle: 'Mixed Co Stale Rebrand Rumor',
        sourceUrl: 'https://example.com/mixed-co-stale-rumor',
        eventDate: '2024-01-01',
        actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true },
        confidence: 60
      }]
    }
  }];
  const signalRows = [{
    account_name: 'Mixed Co', upload_id: 'upload-y', signal_type: 'Expansion',
    title: 'Mixed Co Opens New Facility',
    source_url: 'https://example.com/mixed-co-new-facility',
    source_domain: 'Example Wire', confidence: 85,
    published_at: '2026-07-01T00:00:00Z',
    payload: {
      isReal: true, identityConfidence: 'confirmed', identityCorroboratorReasons: ['verified company domain'],
      whatChanged: 'Mixed Co opened a new distribution facility.',
      eventDate: '2026-07-01', event_date: '2026-07-01',
      publicationDate: '2026-07-01T00:00:00Z', publishedDate: '2026-07-01T00:00:00Z',
      actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true },
      confidenceScore: 85
    },
    first_seen_at: '2026-07-01T00:00:00Z', last_seen_at: '2026-07-01T00:00:00Z'
  }];
  const { accountList } = buildAccountsFromRows(accountRows, signalRows);
  const account = accountList.find(a => a.name === 'Mixed Co');
  assert(account.futureOpportunities.length === 1, `2) exactly one opportunity survives when a stale snapshot and a live signal coexist (got ${account.futureOpportunities.length})`);
  assert(/New Facility/i.test(account.futureOpportunities[0].signalTitle || ''), '2) the surviving opportunity is the live signal, never the stale snapshot');
  assert(!account.futureOpportunities.some(o => /Stale Rebrand Rumor/i.test(o.signalTitle || '')), '2) the stale snapshot never renders alongside the live signal either');
}

// ===========================================================================
// 3) deleting a live business signal cannot cause its raw snapshot copy to
// reappear -- simulated as "the snapshot exists, the live row is simply
// absent (as if deleted)," which must produce the exact same empty result
// as scenario 1 above, proving deletion is never compensated for by falling
// back to the snapshot.
// ===========================================================================
{
  const accountRowsBeforeDeletion = [{
    account_name: 'Deletable Co', upload_id: 'upload-z', industry: 'Test',
    contact_name: '', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 0, relationshipStrength: 0 },
    raw_data: {
      monitoring_status: 'active',
      existingSignals: [{
        account: 'Deletable Co', accountName: 'Deletable Co',
        signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
        signalTitle: 'Deletable Co Contaminated Signal',
        sourceUrl: 'https://example.com/deletable-co-contaminated',
        eventDate: '2025-06-01',
        actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true },
        confidence: 70
      }]
    }
  }];
  // "Before deletion": a live row for the SAME signal still exists.
  const signalRowsBeforeDeletion = [{
    account_name: 'Deletable Co', upload_id: 'upload-z', signal_type: 'Rebrand',
    title: 'Deletable Co Contaminated Signal', source_url: 'https://example.com/deletable-co-contaminated',
    source_domain: 'Example', confidence: 70, published_at: '2025-06-01T00:00:00Z',
    payload: { isReal: true, eventDate: '2025-06-01', event_date: '2025-06-01', actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true }, confidenceScore: 70 },
    first_seen_at: '2025-06-01T00:00:00Z', last_seen_at: '2025-06-01T00:00:00Z'
  }];
  const before = buildAccountsFromRows(accountRowsBeforeDeletion, signalRowsBeforeDeletion).accountList.find(a => a.name === 'Deletable Co');
  assert(before.futureOpportunities.length === 1, '3) sanity: before deletion, the live signal renders normally');

  // "After deletion": the exact same account row (raw_data untouched, per
  // the founder's own no-migration/no-manual-cleanup requirement) but the
  // live ha_signals row is now gone.
  const after = buildAccountsFromRows(accountRowsBeforeDeletion, []).accountList.find(a => a.name === 'Deletable Co');
  assert(Array.isArray(after.futureOpportunities) && after.futureOpportunities.length === 0, `3) after the live row is deleted, its raw_data snapshot copy does NOT reappear -- futureOpportunities is empty, identical to scenario 1's never-had-a-live-row case (got ${after.futureOpportunities.length})`);
}

// ===========================================================================
// 4) write-side: a save/reload cycle does not write canonical business
// signals back into existingSignals -- the real, verbatim
// serializeAccountForStorage() client function.
// ===========================================================================
{
  const sandbox = makeSandbox();
  const account = {
    name: 'Write Boundary Co',
    intelligenceMode: 'warm',
    futureOpportunities: [
      { account: 'Write Boundary Co', signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/write-boundary-business', signalTitle: 'Write Boundary Co Business Signal', confidence: 80 },
      { account: 'Write Boundary Co', signalLayerType: 'Follow-Up Signal', signalTitle: 'Recent order creates a natural follow-up', confidence: 60 },
      { account: 'Write Boundary Co', signalLayerType: 'Repeat / Pattern Signal', signalTitle: 'Repeat buying window detected', confidence: 55 }
    ]
  };
  const serialized = sandbox.serializeAccountForStorage(account);
  assert(
    !serialized.rawData.existingSignals.some(o => o.signalLayerType === 'Business Activity Signal'),
    '4) serializeAccountForStorage() never writes a Business Activity Signal opportunity into raw_data.existingSignals'
  );
  assert(
    !serialized.rawData.existingSignals.some(o => /Write Boundary Co Business Signal/.test(o.signalTitle || '')),
    '4) the specific business-signal title is not present in the serialized existingSignals payload'
  );
  // 5) the legitimate non-business type (Follow-Up Signal) still survives
  // the write boundary -- it has no ha_signals equivalent and would be lost
  // entirely if this filter were too broad.
  assert(
    serialized.rawData.existingSignals.some(o => o.signalLayerType === 'Follow-Up Signal'),
    '5) a legitimate Follow-Up Signal opportunity (order-history-derived, no ha_signals equivalent) still survives being written to existingSignals'
  );
  // 6) Repeat / Pattern Signal opportunities remain unaffected -- they keep
  // going through their own dedicated repeatPatterns field, untouched by
  // this correction.
  assert(
    serialized.rawData.repeatPatterns.some(o => o.signalLayerType === 'Repeat / Pattern Signal'),
    '6) Repeat / Pattern Signal opportunities are still written to their own dedicated repeatPatterns field, unaffected by this correction'
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
