// Behavioral Learning V1, Phase 1 — deterministic, isolated proof of the
// private organization-preference aggregation function, against fixture
// event histories only. No Supabase, no wiring into api/get-dashboard.js or
// api/lib/notification-digest.js yet (that's Phase 2/3) -- this proves the
// pure function in isolation first, matching this codebase's established
// pure-function-first convention (classifyMonitoringSignalEligibility(),
// decideQueueOutcome(), evaluateOutreachOutcome() were all proven this way
// before being wired anywhere).
//
// Design-review round (post-Phase-1, pre-Phase-2): every fixture "vote" is
// now its own distinct (userId, eventFingerprint) pair by default -- each
// call to signalUseful()/signalNotUseful() auto-generates a fresh rep and
// fingerprint unless explicitly told to reuse one, so tests that need N
// INDEPENDENT votes and tests that need ONE rep's opinion HISTORY on ONE
// signal are both easy to express precisely and never accidentally conflate.
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
function ev({ orgId = 'org-a', type, daysAgo = 0, payload = {}, parentId = null, id = null, userId = null, eventFingerprint = null }) {
  seq += 1;
  return {
    id: id || `ev-${seq}`,
    organization_id: orgId,
    event_type: type,
    parent_event_id: parentId,
    user_id: userId || `user-${seq}`,
    event_fingerprint: eventFingerprint || `fp-${seq}`,
    payload,
    created_at: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
  };
}
// Each call is, by default, an INDEPENDENT rep+signal unless userId/
// eventFingerprint are explicitly supplied to represent the SAME rep
// judging the SAME signal (e.g. an opinion change over time).
function signalUseful(orgId, signalType, { daysAgo = 0, userId, eventFingerprint } = {}) {
  return ev({ orgId, type: 'signal_useful', daysAgo, payload: { signalType }, userId, eventFingerprint });
}
function signalNotUseful(orgId, signalType, { daysAgo = 0, userId, eventFingerprint } = {}) {
  return ev({ orgId, type: 'signal_not_useful', daysAgo, payload: { signalType }, userId, eventFingerprint });
}
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
  // Below MIN_EVIDENCE_COUNT (4 INDEPENDENT reps/signals when the floor is 5).
  const events = Array.from({ length: MIN_EVIDENCE_COUNT - 1 }, () => signalUseful('org-a', 'Hiring'));
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Hiring'].sufficientEvidence === false, `REQUIRED: ${MIN_EVIDENCE_COUNT - 1} independent votes (below the ${MIN_EVIDENCE_COUNT}-vote floor) is marked insufficient`);
  assert(prefs['signal:Hiring'].adjustment === 0, 'REQUIRED: insufficient evidence produces adjustment 0, not a wild swing from a tiny sample');
  assert(prefs['signal:Hiring'].totalEvidenceCount === MIN_EVIDENCE_COUNT - 1, 'the raw evidence count is still reported for transparency even though no adjustment applies');
}

// ===========================================================================
// 3. Sufficient, unanimous, INDEPENDENT evidence hits the cap, never
//    exceeds it.
// ===========================================================================
{
  const events = Array.from({ length: 20 }, () => signalUseful('org-a', 'Hiring'));
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Hiring'].totalEvidenceCount === 20, 'sanity: 20 independent reps each judging a different signal all count separately');
  assert(prefs['signal:Hiring'].adjustment === MAX_ADJUSTMENT, `REQUIRED: unanimous positive evidence hits the positive cap exactly (${MAX_ADJUSTMENT}), never exceeds it (got ${prefs['signal:Hiring'].adjustment})`);
}
{
  const events = Array.from({ length: 20 }, () => signalNotUseful('org-a', 'Award / Recognition'));
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Award / Recognition'].adjustment === -MAX_ADJUSTMENT, `REQUIRED: unanimous negative evidence hits the negative cap exactly (-${MAX_ADJUSTMENT}), never exceeds it (got ${prefs['signal:Award / Recognition'].adjustment})`);
}

// ===========================================================================
// 4. Conflicting evidence (from different reps/signals) nets toward zero
//    with no special-casing.
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
// 5. DESIGN-REVIEW FIX 1 — a single rep changing their mind on ONE signal
//    counts as their CURRENT opinion only, never as two independent votes.
//    The event history itself still preserves both rows (unchanged,
//    upstream, api/signal-events.js's own doctrine) -- only this
//    aggregation collapses them.
// ===========================================================================
{
  const sameRep = 'rep-1', sameSignal = 'fp-shared-1';
  const events = [
    signalUseful('org-a', 'Product Launch', { daysAgo: 10, userId: sameRep, eventFingerprint: sameSignal }),
    signalNotUseful('org-a', 'Product Launch', { daysAgo: 2, userId: sameRep, eventFingerprint: sameSignal }) // the rep changed their mind more recently
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Product Launch'].totalEvidenceCount === 1, `REQUIRED: one rep's changed opinion on one signal contributes exactly ONE vote (the current one), not two (got totalEvidenceCount=${prefs['signal:Product Launch']?.totalEvidenceCount})`);
  assert(prefs['signal:Product Launch'].qualityPositiveCount === 0 && prefs['signal:Product Launch'].qualityNegativeCount === 1, `REQUIRED: the counted vote reflects the MOST RECENT opinion (not_useful), not the first one (got ${JSON.stringify(prefs['signal:Product Launch'])})`);
}
{
  // Order in the input array must not matter -- "most recent by
  // created_at" is what decides, not array position.
  const sameRep = 'rep-2', sameSignal = 'fp-shared-2';
  const events = [
    signalNotUseful('org-a', 'Rebrand', { daysAgo: 2, userId: sameRep, eventFingerprint: sameSignal }), // most recent, listed FIRST
    signalUseful('org-a', 'Rebrand', { daysAgo: 10, userId: sameRep, eventFingerprint: sameSignal })
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Rebrand'].qualityNegativeCount === 1 && prefs['signal:Rebrand'].qualityPositiveCount === 0, 'REQUIRED: resolution is by created_at, not input array order');
}
{
  // Two DIFFERENT reps judging the SAME signal remain two legitimately
  // separate, independent votes -- only a single rep's OWN history collapses.
  const sameSignal = 'fp-shared-3';
  const events = [
    signalUseful('org-a', 'Community Event', { daysAgo: 5, userId: 'rep-a', eventFingerprint: sameSignal }),
    signalNotUseful('org-a', 'Community Event', { daysAgo: 5, userId: 'rep-b', eventFingerprint: sameSignal })
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Community Event'].totalEvidenceCount === 2, `REQUIRED: two DIFFERENT reps judging the same signal both count -- this is not the same collapsing case as one rep changing their mind (got ${prefs['signal:Community Event']?.totalEvidenceCount})`);
}

// ===========================================================================
// 6. Excluded evidence: went_nowhere, no_response_yet, selected,
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
// 7. Outcome evidence resolves its dimension via the PARENT outreach
//    event's own snapshot -- outcome_reported carries no signalType/
//    opportunityType of its own. Multiple DISTINCT outreach attempts on
//    the same signal type each contribute their own vote.
// ===========================================================================
{
  const outreachId = 'outreach-2';
  const events = [
    outreach('org-a', 'Leadership Change', 20, outreachId),
    outcome('org-a', 'engaged', outreachId, 15)
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Leadership Change'], 'REQUIRED: outcome_reported evidence correctly attaches to its dimension via parent_event_id resolution, even though the outcome_reported row itself has no signalType');
  assert(prefs['signal:Leadership Change'].outcomePositiveCount === 1, `REQUIRED: one real outreach attempt with a positive outcome counts as one vote (got ${prefs['signal:Leadership Change']?.outcomePositiveCount})`);
}
{
  // Four genuinely DIFFERENT outreach attempts (four distinct parent
  // events) on the same signal type -> four independent outcome votes.
  const events = [];
  for (let i = 0; i < 4; i++) {
    const outreachId = `outreach-multi-${i}`;
    events.push(outreach('org-a', 'Facility Expansion', 40, outreachId));
    events.push(outcome('org-a', 'progressed', outreachId, 10));
  }
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Facility Expansion'].outcomePositiveCount === 4, `REQUIRED: four genuinely distinct outreach attempts each contribute their own outcome vote (got ${prefs['signal:Facility Expansion']?.outcomePositiveCount})`);
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
// 8. DESIGN-REVIEW FIX 2 — sequential outcome updates on ONE outreach
//    attempt (e.g. engaged -> later updated to progressed) count as ONE
//    outreach's current status, never as two independent successful
//    examples. This is the append-only-history risk explicitly flagged
//    before Phase 2: an engaged->progressed update must not masquerade as
//    two distinct wins.
// ===========================================================================
{
  const outreachId = 'outreach-sequential';
  const events = [
    outreach('org-a', 'Trade Show Participation', 30, outreachId),
    outcome('org-a', 'no_response_yet', outreachId, 20), // first report: no response
    outcome('org-a', 'engaged', outreachId, 10),          // second report: they replied
    outcome('org-a', 'progressed', outreachId, 2)          // third, most recent report: it's moving forward
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs['signal:Trade Show Participation'].outcomePositiveCount === 1, `REQUIRED: three sequential status updates on ONE outreach attempt count as exactly ONE outcome vote (the current/latest status), not three (got ${prefs['signal:Trade Show Participation']?.outcomePositiveCount})`);
  assert(prefs['signal:Trade Show Participation'].totalEvidenceCount === 1, `REQUIRED: total evidence for this attempt is 1, not 3 (got ${prefs['signal:Trade Show Participation']?.totalEvidenceCount})`);
}
{
  // The reverse direction matters too: if the LATEST report reverts to a
  // non-counted status, the earlier positive report must not linger.
  const outreachId = 'outreach-reverts';
  const events = [
    outreach('org-a', 'Partnership / Contract', 30, outreachId),
    outcome('org-a', 'engaged', outreachId, 20),
    outcome('org-a', 'went_nowhere', outreachId, 5) // most recent: it ultimately didn't convert
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(!prefs['signal:Partnership / Contract'] || prefs['signal:Partnership / Contract'].totalEvidenceCount === 0, `REQUIRED: when the LATEST outcome report is went_nowhere, the earlier 'engaged' report is superseded and contributes nothing (got ${JSON.stringify(prefs['signal:Partnership / Contract'])})`);
}

// ===========================================================================
// 9. Recency window applies to the RESOLVED latest state's own timestamp,
//    not to raw historical rows -- an old opinion whose rep never revisited
//    it correctly ages out; a rep's fresh update on an old signal correctly
//    still counts.
// ===========================================================================
{
  const events = Array.from({ length: 10 }, () => signalUseful('org-a', 'Hiring', { daysAgo: RECENCY_WINDOW_DAYS + 1 }));
  const prefs = computeOrgSignalPreferences('org-a', events, { now: NOW });
  assert(!prefs['signal:Hiring'], `REQUIRED: votes whose only (and therefore latest) record is older than the ${RECENCY_WINDOW_DAYS}-day window are excluded entirely`);
}
{
  const sameRep = 'rep-recency', sameSignal = 'fp-recency';
  const events = [
    signalNotUseful('org-a', 'Hiring', { daysAgo: RECENCY_WINDOW_DAYS + 30, userId: sameRep, eventFingerprint: sameSignal }), // old opinion
    signalUseful('org-a', 'Hiring', { daysAgo: 1, userId: sameRep, eventFingerprint: sameSignal }) // same rep, fresh updated opinion
  ];
  const prefs = computeOrgSignalPreferences('org-a', events, { now: NOW });
  assert(prefs['signal:Hiring'].qualityPositiveCount === 1 && prefs['signal:Hiring'].totalEvidenceCount === 1, `REQUIRED: the rep's fresh, in-window updated opinion counts even though their original opinion was outside the window (got ${JSON.stringify(prefs['signal:Hiring'])})`);
}

// ===========================================================================
// 10. THE CENTRAL GUARANTEE: cross-organization isolation. A caller that
//     accidentally passes another organization's events (or both orgs'
//     events mixed together) must NEVER have them contaminate the target
//     organization's computed preferences -- structural, not just a query
//     convention upstream.
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
// 11. Determinism / purity: identical input always produces identical
//     output; no reliance on real wall-clock time when `now` is supplied.
// ===========================================================================
{
  const events = [
    ...Array.from({ length: 6 }, () => signalUseful('org-a', 'Hiring', { daysAgo: 10 })),
    ...Array.from({ length: 3 }, () => signalNotUseful('org-a', 'Hiring', { daysAgo: 5 }))
  ];
  const run1 = computeOrgSignalPreferences('org-a', events, { now: NOW });
  const run2 = computeOrgSignalPreferences('org-a', events, { now: NOW });
  assert(JSON.stringify(run1) === JSON.stringify(run2), 'REQUIRED: identical input produces byte-identical output on repeated calls -- pure, reproducible, nothing to "reset" because nothing is persisted');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
