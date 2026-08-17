// Behavioral Learning V1, Phase 1 — deterministic, isolated proof of the
// private organization-preference aggregation function, against fixture
// event histories only. No Supabase, no wiring into api/get-dashboard.js or
// api/lib/notification-digest.js yet (that's Phase 2/3) -- this proves the
// pure function in isolation first, matching this codebase's established
// pure-function-first convention (classifyMonitoringSignalEligibility(),
// decideQueueOutcome(), evaluateOutreachOutcome() were all proven this way
// before being wired anywhere).
//
// Usage: node scripts/test-org-preference-learning.js
import {
  computeOrgSignalPreferences, getOrgPreferenceAdjustment, dimensionKeyForSnapshot,
  MIN_EVIDENCE_COUNT, MAX_ADJUSTMENT, RECENCY_WINDOW_DAYS
} from '../api/lib/org-preference-learning.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const NOW = new Date('2026-08-17T12:00:00.000Z');
let seq = 0;
function ev({ orgId = 'org-a', type, daysAgo = 0, payload = {}, parentId = null, id = null }) {
  seq += 1;
  return {
    id: id || `ev-${seq}`,
    organization_id: orgId,
    event_type: type,
    parent_event_id: parentId,
    payload,
    created_at: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
  };
}
function signalUseful(orgId, signalType, daysAgo = 0) { return ev({ orgId, type: 'signal_useful', daysAgo, payload: { signalType } }); }
function signalNotUseful(orgId, signalType, daysAgo = 0) { return ev({ orgId, type: 'signal_not_useful', daysAgo, payload: { signalType } }); }
function outreach(orgId, signalType, daysAgo, id) { return ev({ orgId, type: 'outreach_made', daysAgo, payload: { signalType }, id }); }
function outcome(orgId, status, parentId, daysAgo = 0) { return ev({ orgId, type: 'outcome_reported', daysAgo, payload: { outcomeStatus: status }, parentId }); }

// ===========================================================================
// 1. Dimension-key extraction: namespaced, never colliding between the two
//    real snapshot shapes actually persisted in production
//    (payload.signalType vs payload.opportunityType).
// ===========================================================================
{
  assert(dimensionKeyForSnapshot({ signalType: 'Hiring' }) === 'signal:Hiring', 'signal_* snapshot resolves to a signal:-namespaced key');
  assert(dimensionKeyForSnapshot({ opportunityType: 'repeat_pattern' }) === 'opportunity:repeat_pattern', 'opportunity_* snapshot resolves to an opportunity:-namespaced key');
  assert(dimensionKeyForSnapshot({}) === null, 'a snapshot with neither field resolves to null (excluded, not an error)');
}

// ===========================================================================
// 2. Cold start: default is ALWAYS unchanged ranking (0) below the evidence
//    floor, and for any organization/dimension with zero history at all.
// ===========================================================================
{
  const prefs = computeOrgSignalPreferences('org-a', []);
  assert(Object.keys(prefs).length === 0, 'REQUIRED: zero events produces zero dimension buckets -- every organization starts here');
  assert(getOrgPreferenceAdjustment(prefs, 'signal:Hiring') === 0, 'REQUIRED: a dimension key with no evidence at all returns adjustment 0 via the lookup helper');
}
{
  // Below MIN_EVIDENCE_COUNT (4 events when the floor is 5).
  const events = Array.from({ length: MIN_EVIDENCE_COUNT - 1 }, () => signalUseful('org-a', 'Hiring'));
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Hiring'].sufficientEvidence === false, `REQUIRED: ${MIN_EVIDENCE_COUNT - 1} events (below the ${MIN_EVIDENCE_COUNT}-event floor) is marked insufficient`);
  assert(prefs['signal:Hiring'].adjustment === 0, 'REQUIRED: insufficient evidence produces adjustment 0, not a wild swing from a tiny sample');
  assert(prefs['signal:Hiring'].totalEvidenceCount === MIN_EVIDENCE_COUNT - 1, 'the raw evidence count is still reported for transparency even though no adjustment applies');
}

// ===========================================================================
// 3. Sufficient, unanimous evidence hits the cap, never exceeds it.
// ===========================================================================
{
  const events = Array.from({ length: 20 }, () => signalUseful('org-a', 'Hiring'));
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Hiring'].sufficientEvidence === true, 'sanity: 20 events clears the evidence floor');
  assert(prefs['signal:Hiring'].adjustment === MAX_ADJUSTMENT, `REQUIRED: unanimous positive evidence hits the positive cap exactly (${MAX_ADJUSTMENT}), never exceeds it (got ${prefs['signal:Hiring'].adjustment})`);
}
{
  const events = Array.from({ length: 20 }, () => signalNotUseful('org-a', 'Award / Recognition'));
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Award / Recognition'].adjustment === -MAX_ADJUSTMENT, `REQUIRED: unanimous negative evidence hits the negative cap exactly (-${MAX_ADJUSTMENT}), never exceeds it (got ${prefs['signal:Award / Recognition'].adjustment})`);
}

// ===========================================================================
// 4. Conflicting evidence nets toward zero with no special-casing.
// ===========================================================================
{
  const events = [
    ...Array.from({ length: 6 }, () => signalUseful('org-a', 'Acquisition')),
    ...Array.from({ length: 6 }, () => signalNotUseful('org-a', 'Acquisition'))
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Acquisition'].adjustment === 0, `REQUIRED: exactly balanced positive/negative evidence nets to adjustment 0 (got ${prefs['signal:Acquisition'].adjustment})`);
  assert(prefs['signal:Acquisition'].sufficientEvidence === true, 'sanity: still marked sufficient -- the net-zero result is a real computed answer, not a cold-start default');
}

// ===========================================================================
// 5. Excluded evidence: went_nowhere, no_response_yet, selected,
//    prepare_call_opened, and outreach_made itself must NEVER move the
//    adjustment, no matter how many of them exist.
// ===========================================================================
{
  const outreachId = 'outreach-1';
  const events = [
    outreach('org-a', 'Product Launch', 30, outreachId),
    ...Array.from({ length: 10 }, () => outcome('org-a', 'went_nowhere', outreachId)),
    ...Array.from({ length: 10 }, () => outcome('org-a', 'no_response_yet', outreachId)),
    ...Array.from({ length: 10 }, () => ev({ orgId: 'org-a', type: 'signal_selected', payload: { signalType: 'Product Launch' } })),
    ...Array.from({ length: 10 }, () => ev({ orgId: 'org-a', type: 'prepare_call_opened', payload: { signalType: 'Product Launch' } }))
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(!prefs['signal:Product Launch'] || prefs['signal:Product Launch'].totalEvidenceCount === 0, `REQUIRED: went_nowhere, no_response_yet, selected, prepare_call_opened, and outreach_made itself contribute ZERO evidence regardless of volume (got ${JSON.stringify(prefs['signal:Product Launch'])})`);
}

// ===========================================================================
// 6. Outcome evidence resolves its dimension via the PARENT outreach
//    event's own snapshot -- outcome_reported carries no signalType/
//    opportunityType of its own.
// ===========================================================================
{
  const outreachId = 'outreach-2';
  const events = [
    outreach('org-a', 'Leadership Change', 20, outreachId),
    ...Array.from({ length: 5 }, () => outcome('org-a', 'engaged', outreachId)),
    ...Array.from({ length: 2 }, () => outcome('org-a', 'progressed', outreachId))
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Leadership Change'], 'REQUIRED: outcome_reported evidence correctly attaches to its dimension via parent_event_id resolution, even though the outcome_reported row itself has no signalType');
  assert(prefs['signal:Leadership Change'].outcomePositiveCount === 7, `REQUIRED: engaged + progressed both count as outcome-positive evidence (got ${prefs['signal:Leadership Change']?.outcomePositiveCount})`);
  assert(prefs['signal:Leadership Change'].adjustment === MAX_ADJUSTMENT, 'unanimous positive outcome evidence alone (no quality feedback at all) still reaches the positive cap');
}
{
  // An outcome_reported row whose parent isn't a real outreach event (or
  // isn't found at all) must never crash or silently attach to the wrong
  // dimension -- it's simply excluded.
  const events = [outcome('org-a', 'engaged', 'nonexistent-parent-id')];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(Object.keys(prefs).length === 0, 'REQUIRED: an outcome_reported row with an unresolvable parent contributes no evidence and does not throw');
}

// ===========================================================================
// 7. Recency window: evidence older than RECENCY_WINDOW_DAYS is excluded.
// ===========================================================================
{
  const events = [
    ...Array.from({ length: 10 }, () => signalUseful('org-a', 'Hiring', RECENCY_WINDOW_DAYS - 1)),
    ...Array.from({ length: 10 }, () => signalUseful('org-a', 'Hiring', RECENCY_WINDOW_DAYS + 1))
  ];
  const prefs = computeOrgSignalPreferences('org-a', events, { now: NOW });
  assert(prefs['signal:Hiring'].totalEvidenceCount === 10, `REQUIRED: only the 10 in-window events count, the 10 older-than-${RECENCY_WINDOW_DAYS}-day events are excluded (got ${prefs['signal:Hiring'].totalEvidenceCount})`);
}

// ===========================================================================
// 8. THE CENTRAL GUARANTEE: cross-organization isolation. A caller that
//    accidentally passes another organization's events (or both orgs'
//    events mixed together) must NEVER have them contaminate the target
//    organization's computed preferences -- structural, not just a query
//    convention upstream.
// ===========================================================================
{
  const mixedEvents = [
    ...Array.from({ length: 20 }, () => signalUseful('org-a', 'Hiring')),
    ...Array.from({ length: 20 }, () => signalNotUseful('org-b', 'Hiring'))
  ];
  const prefsA = computeOrgSignalPreferences('org-a', mixedEvents);
  const prefsB = computeOrgSignalPreferences('org-b', mixedEvents);
  assert(prefsA['signal:Hiring'].adjustment === MAX_ADJUSTMENT, `REQUIRED: org-a's preferences are computed ONLY from org-a's own events, unaffected by org-b's opposite-direction feedback mixed into the same input array (got ${prefsA['signal:Hiring'].adjustment})`);
  assert(prefsB['signal:Hiring'].adjustment === -MAX_ADJUSTMENT, `REQUIRED: org-b's preferences are likewise computed only from org-b's own events (got ${prefsB['signal:Hiring'].adjustment})`);
  assert(prefsA['signal:Hiring'].totalEvidenceCount === 20 && prefsB['signal:Hiring'].totalEvidenceCount === 20, 'REQUIRED: each organization sees exactly its own event count, never the combined total');
}
{
  // No organizationId at all -> no events attributed to anyone, never a
  // silent "treat everything as unscoped" fallback.
  const events = Array.from({ length: 20 }, () => signalUseful('org-a', 'Hiring'));
  const prefs = computeOrgSignalPreferences('', events);
  assert(Object.keys(prefs).length === 0, 'REQUIRED: an empty/missing organizationId produces zero buckets rather than defaulting to "match everything"');
}

// ===========================================================================
// 9. Determinism / purity: identical input always produces identical
//    output; no reliance on real wall-clock time when `now` is supplied.
// ===========================================================================
{
  const events = [
    ...Array.from({ length: 6 }, () => signalUseful('org-a', 'Hiring', 10)),
    ...Array.from({ length: 3 }, () => signalNotUseful('org-a', 'Hiring', 5))
  ];
  const run1 = computeOrgSignalPreferences('org-a', events, { now: NOW });
  const run2 = computeOrgSignalPreferences('org-a', events, { now: NOW });
  assert(JSON.stringify(run1) === JSON.stringify(run2), 'REQUIRED: identical input produces byte-identical output on repeated calls -- pure, reproducible, nothing to "reset" because nothing is persisted');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
