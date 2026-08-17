// Behavioral Learning V1, Phase 1 — deterministic, isolated proof of the
// private organization-preference aggregation function, against fixture
// event histories only. No Supabase, no wiring into api/get-dashboard.js or
// api/lib/notification-digest.js yet (that's Phase 2/3) -- this proves the
// pure function in isolation first, matching this codebase's established
// pure-function-first convention (classifyMonitoringSignalEligibility(),
// decideQueueOutcome(), evaluateOutreachOutcome() were all proven this way
// before being wired anywhere).
//
// Dimension-reframe round (founder decision after the design-review audit):
// V1's canonical preference dimension is exactly three broad families
// (FOLLOW_UP / REPEAT_PATTERN / BUSINESS_ACTIVITY), not the ~25-value raw
// signalType/opportunityType taxonomy an earlier Phase 1 draft used. See
// canonicalPreferenceFamily()'s own header comment in
// api/lib/org-preference-learning.js for the full rationale.
//
// Fixture convention (unchanged from the prior design-review round): every
// "vote" is its own distinct (userId, eventFingerprint) pair by default --
// each call to signalUseful()/signalNotUseful()/etc. auto-generates a fresh
// rep and fingerprint unless explicitly told to reuse one, so tests that
// need N INDEPENDENT votes and tests that need ONE rep's opinion HISTORY on
// ONE signal are both easy to express precisely and never accidentally
// conflate.
//
// Usage: node scripts/test-org-preference-learning.js
import {
  computeOrgSignalPreferences, getOrgPreferenceAdjustment, canonicalPreferenceFamily,
  FOLLOW_UP, REPEAT_PATTERN, BUSINESS_ACTIVITY,
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
function opportunityUseful(orgId, opportunityType, { daysAgo = 0, userId, eventFingerprint } = {}) {
  return ev({ orgId, type: 'opportunity_useful', daysAgo, payload: { opportunityType }, userId, eventFingerprint });
}
function opportunityNotUseful(orgId, opportunityType, { daysAgo = 0, userId, eventFingerprint } = {}) {
  return ev({ orgId, type: 'opportunity_not_useful', daysAgo, payload: { opportunityType }, userId, eventFingerprint });
}
function outreach(orgId, payload, daysAgo, id) { return ev({ orgId, type: 'outreach_made', daysAgo, payload, id }); }
function opportunityOutreach(orgId, payload, daysAgo, id) { return ev({ orgId, type: 'opportunity_outreach_made', daysAgo, payload, id }); }
function outcome(orgId, status, parentId, daysAgo = 0) { return ev({ orgId, type: 'outcome_reported', daysAgo, payload: { outcomeStatus: status }, parentId }); }

// ===========================================================================
// 1. Canonicalization: the exact three-family mapping, verified against the
//    REAL snapshot shapes api/signal-events.js actually persists.
// ===========================================================================
{
  assert(canonicalPreferenceFamily({ opportunityType: 'follow_up' }) === FOLLOW_UP, 'REQUIRED: an opportunity_* snapshot with opportunityType follow_up canonicalizes to FOLLOW_UP');
  assert(canonicalPreferenceFamily({ opportunityType: 'repeat_pattern' }) === REPEAT_PATTERN, 'REQUIRED: an opportunity_* snapshot with opportunityType repeat_pattern canonicalizes to REPEAT_PATTERN');
}
{
  // Multiple DIFFERENT raw signalType values must all canonicalize to the
  // SAME single BUSINESS_ACTIVITY family -- V1 does not learn Acquisition
  // vs. Hiring vs. Award yet, by design.
  const rawTypes = ['Acquisition', 'Hiring Activity', 'Award / Recognition', 'Leadership Change', 'Product Launch', 'Trade Show Participation', 'Business Activity'];
  for (const t of rawTypes) {
    assert(canonicalPreferenceFamily({ signalType: t }) === BUSINESS_ACTIVITY, `REQUIRED: raw signalType "${t}" canonicalizes to the single BUSINESS_ACTIVITY family, not its own bucket`);
  }
}
{
  // Fail-safe cases: never guess, never invent a fourth bucket.
  assert(canonicalPreferenceFamily({}) === null, 'REQUIRED: an empty payload (neither field present) is excluded');
  assert(canonicalPreferenceFamily({ opportunityType: 'some_future_type' }) === null, 'REQUIRED: an unrecognized opportunityType is excluded, never guessed into BUSINESS_ACTIVITY or a new bucket');
  assert(canonicalPreferenceFamily({ signalType: '' }) === null, 'REQUIRED: an empty-string signalType is excluded');
  assert(canonicalPreferenceFamily({ signalType: '   ' }) === null, 'REQUIRED: a whitespace-only signalType is excluded');
  assert(canonicalPreferenceFamily({ signalType: 42 }) === null, 'REQUIRED: a malformed (non-string) signalType is excluded, not coerced');
  assert(canonicalPreferenceFamily({ signalType: null, opportunityType: null }) === null, 'REQUIRED: explicit nulls on both fields are excluded');
}
{
  // The central swallow-prevention proof: verified against the REAL
  // buildOpportunityRecommendationSnapshot()/buildRecommendationSnapshot()
  // shapes (api/signal-events.js) -- opportunity_* payloads never carry
  // signalType, signal_* payloads never carry opportunityType, but this
  // proves the canonicalizer's OWN precedence is safe even if that ever
  // changed: opportunityType is checked first and wins.
  const mixedFollowUp = { opportunityType: 'follow_up', signalType: 'Hiring Activity' }; // should not happen for a real row, but must not swallow into BUSINESS_ACTIVITY if it did
  assert(canonicalPreferenceFamily(mixedFollowUp) === FOLLOW_UP, 'REQUIRED: opportunityType takes precedence over a co-present signalType, so a Follow-Up event can never be misclassified as Business Activity');
}

// ===========================================================================
// 2. Cold start: default is ALWAYS unchanged ranking (0) below the evidence
//    floor, and for any organization/family with zero history at all.
// ===========================================================================
{
  const prefs = computeOrgSignalPreferences('org-a', []);
  assert(Object.keys(prefs).length === 0, 'REQUIRED: zero events produces zero family buckets -- every organization starts here');
  assert(getOrgPreferenceAdjustment(prefs, BUSINESS_ACTIVITY) === 0, 'REQUIRED: a family with no evidence at all returns adjustment 0 via the lookup helper');
}
{
  // Below MIN_EVIDENCE_COUNT (4 INDEPENDENT reps/signals when the floor is 5).
  const events = Array.from({ length: MIN_EVIDENCE_COUNT - 1 }, () => signalUseful('org-a', 'Hiring Activity'));
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[BUSINESS_ACTIVITY].sufficientEvidence === false, `REQUIRED: ${MIN_EVIDENCE_COUNT - 1} independent votes (below the ${MIN_EVIDENCE_COUNT}-vote floor) is marked insufficient`);
  assert(prefs[BUSINESS_ACTIVITY].adjustment === 0, 'REQUIRED: insufficient evidence produces adjustment 0, not a wild swing from a tiny sample');
  assert(prefs[BUSINESS_ACTIVITY].totalEvidenceCount === MIN_EVIDENCE_COUNT - 1, 'the raw evidence count is still reported for transparency even though no adjustment applies');
}

// ===========================================================================
// 3. Sufficient, unanimous, INDEPENDENT evidence hits the cap, never
//    exceeds it -- and different raw signalTypes correctly pool together.
// ===========================================================================
{
  const events = [
    ...Array.from({ length: 10 }, () => signalUseful('org-a', 'Hiring Activity')),
    ...Array.from({ length: 10 }, () => signalUseful('org-a', 'Award / Recognition')) // a DIFFERENT raw type, same family
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[BUSINESS_ACTIVITY].totalEvidenceCount === 20, 'REQUIRED: Hiring Activity and Award / Recognition votes pool into the SAME BUSINESS_ACTIVITY bucket');
  assert(prefs[BUSINESS_ACTIVITY].adjustment === MAX_ADJUSTMENT, `REQUIRED: unanimous positive evidence hits the positive cap exactly (${MAX_ADJUSTMENT}), never exceeds it (got ${prefs[BUSINESS_ACTIVITY].adjustment})`);
}
{
  const events = Array.from({ length: 20 }, () => opportunityNotUseful('org-a', 'follow_up'));
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[FOLLOW_UP].adjustment === -MAX_ADJUSTMENT, `REQUIRED: unanimous negative evidence on Follow-Up hits the negative cap exactly (-${MAX_ADJUSTMENT}), never exceeds it (got ${prefs[FOLLOW_UP]?.adjustment})`);
}
{
  const events = Array.from({ length: 20 }, () => opportunityUseful('org-a', 'repeat_pattern'));
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[REPEAT_PATTERN].adjustment === MAX_ADJUSTMENT, `REQUIRED: Repeat-Pattern evidence accumulates into its own family, independent of Follow-Up/Business Activity (got ${prefs[REPEAT_PATTERN]?.adjustment})`);
  assert(!prefs[FOLLOW_UP] && !prefs[BUSINESS_ACTIVITY], 'REQUIRED: the three families never leak into each other -- only REPEAT_PATTERN has evidence here');
}

// ===========================================================================
// 4. Conflicting evidence (from different reps/signals, within one family)
//    nets toward zero with no special-casing.
// ===========================================================================
{
  const events = [
    ...Array.from({ length: 6 }, () => signalUseful('org-a', 'Acquisition')),
    ...Array.from({ length: 6 }, () => signalNotUseful('org-a', 'Hiring Activity')) // different raw type, same family, still conflicts correctly
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[BUSINESS_ACTIVITY].adjustment === 0, `REQUIRED: exactly balanced positive/negative evidence nets to adjustment 0 even across different raw signalTypes within the same family (got ${prefs[BUSINESS_ACTIVITY].adjustment})`);
  assert(prefs[BUSINESS_ACTIVITY].sufficientEvidence === true, 'sanity: still marked sufficient -- the net-zero result is a real computed answer, not a cold-start default');
}

// ===========================================================================
// 5. Changed-opinion correction (kept from the prior design-review round,
//    re-verified against the new family dimension): a single rep changing
//    their mind on ONE signal counts as their CURRENT opinion only.
// ===========================================================================
{
  const sameRep = 'rep-1', sameSignal = 'fp-shared-1';
  const events = [
    signalUseful('org-a', 'Product Launch', { daysAgo: 10, userId: sameRep, eventFingerprint: sameSignal }),
    signalNotUseful('org-a', 'Product Launch', { daysAgo: 2, userId: sameRep, eventFingerprint: sameSignal }) // the rep changed their mind more recently
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[BUSINESS_ACTIVITY].totalEvidenceCount === 1, `REQUIRED: one rep's changed opinion on one signal contributes exactly ONE vote (the current one), not two (got totalEvidenceCount=${prefs[BUSINESS_ACTIVITY]?.totalEvidenceCount})`);
  assert(prefs[BUSINESS_ACTIVITY].qualityPositiveCount === 0 && prefs[BUSINESS_ACTIVITY].qualityNegativeCount === 1, `REQUIRED: the counted vote reflects the MOST RECENT opinion (not_useful), not the first one (got ${JSON.stringify(prefs[BUSINESS_ACTIVITY])})`);
}
{
  const sameSignal = 'fp-shared-3';
  const events = [
    signalUseful('org-a', 'Community Event', { daysAgo: 5, userId: 'rep-a', eventFingerprint: sameSignal }),
    signalNotUseful('org-a', 'Community Event', { daysAgo: 5, userId: 'rep-b', eventFingerprint: sameSignal })
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[BUSINESS_ACTIVITY].totalEvidenceCount === 2, `REQUIRED: two DIFFERENT reps judging the same signal both count -- this is not the same collapsing case as one rep changing their mind (got ${prefs[BUSINESS_ACTIVITY]?.totalEvidenceCount})`);
}

// ===========================================================================
// 6. Excluded evidence: went_nowhere, no_response_yet, selected,
//    prepare_call_opened, and outreach_made itself must NEVER move the
//    adjustment, no matter how many of them exist.
// ===========================================================================
{
  const outreachId = 'outreach-1';
  const events = [
    outreach('org-a', { signalType: 'Product Launch' }, 30, outreachId),
    ...Array.from({ length: 10 }, () => outcome('org-a', 'went_nowhere', outreachId)),
    ...Array.from({ length: 10 }, () => outcome('org-a', 'no_response_yet', outreachId)),
    ...Array.from({ length: 10 }, () => ev({ orgId: 'org-a', type: 'signal_selected', payload: { signalType: 'Product Launch' } })),
    ...Array.from({ length: 10 }, () => ev({ orgId: 'org-a', type: 'prepare_call_opened', payload: { signalType: 'Product Launch' } }))
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(!prefs[BUSINESS_ACTIVITY] || prefs[BUSINESS_ACTIVITY].totalEvidenceCount === 0, `REQUIRED: went_nowhere, no_response_yet, selected, prepare_call_opened, and outreach_made itself contribute ZERO evidence regardless of volume (got ${JSON.stringify(prefs[BUSINESS_ACTIVITY])})`);
}

// ===========================================================================
// 7. Outcome evidence resolves its family via the PARENT outreach event's
//    own snapshot -- outcome_reported carries no signalType/opportunityType
//    of its own. Multiple DISTINCT outreach attempts each contribute their
//    own vote, and Follow-Up/Repeat-Pattern outreach resolve correctly too.
// ===========================================================================
{
  const outreachId = 'outreach-2';
  const events = [
    outreach('org-a', { signalType: 'Leadership Change' }, 20, outreachId),
    outcome('org-a', 'engaged', outreachId, 15)
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[BUSINESS_ACTIVITY], 'REQUIRED: outcome_reported evidence correctly attaches to BUSINESS_ACTIVITY via parent_event_id resolution, even though the outcome_reported row itself has no signalType');
  assert(prefs[BUSINESS_ACTIVITY].outcomePositiveCount === 1, `REQUIRED: one real outreach attempt with a positive outcome counts as one vote (got ${prefs[BUSINESS_ACTIVITY]?.outcomePositiveCount})`);
}
{
  const outreachId = 'outreach-opp';
  const events = [
    opportunityOutreach('org-a', { opportunityType: 'repeat_pattern' }, 20, outreachId),
    outcome('org-a', 'progressed', outreachId, 15)
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[REPEAT_PATTERN]?.outcomePositiveCount === 1, `REQUIRED: opportunity_outreach_made's outcome evidence resolves to REPEAT_PATTERN via its own opportunityType snapshot (got ${JSON.stringify(prefs[REPEAT_PATTERN])})`);
}
{
  // Four genuinely DIFFERENT outreach attempts (four distinct parent
  // events) -> four independent outcome votes, all pooling into the same
  // BUSINESS_ACTIVITY family despite different raw signalTypes.
  const events = [];
  const rawTypes = ['Facility Expansion', 'Renovation Completed', 'New Location', 'Location Reopening'];
  rawTypes.forEach((t, i) => {
    const outreachId = `outreach-multi-${i}`;
    events.push(outreach('org-a', { signalType: t }, 40, outreachId));
    events.push(outcome('org-a', 'progressed', outreachId, 10));
  });
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[BUSINESS_ACTIVITY].outcomePositiveCount === 4, `REQUIRED: four genuinely distinct outreach attempts, across different raw signalTypes, each contribute their own outcome vote into the single pooled family (got ${prefs[BUSINESS_ACTIVITY]?.outcomePositiveCount})`);
}
{
  const events = [outcome('org-a', 'engaged', 'nonexistent-parent-id')];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(Object.keys(prefs).length === 0, 'REQUIRED: an outcome_reported row with an unresolvable parent contributes no evidence and does not throw');
}

// ===========================================================================
// 8. Sequential-outcome correction (kept from the prior design-review
//    round, re-verified against the new family dimension): status updates
//    on ONE outreach attempt count as ONE current status, never several.
// ===========================================================================
{
  const outreachId = 'outreach-sequential';
  const events = [
    outreach('org-a', { signalType: 'Trade Show Participation' }, 30, outreachId),
    outcome('org-a', 'no_response_yet', outreachId, 20),
    outcome('org-a', 'engaged', outreachId, 10),
    outcome('org-a', 'progressed', outreachId, 2)
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(prefs[BUSINESS_ACTIVITY].outcomePositiveCount === 1, `REQUIRED: three sequential status updates on ONE outreach attempt count as exactly ONE outcome vote, not three (got ${prefs[BUSINESS_ACTIVITY]?.outcomePositiveCount})`);
  assert(prefs[BUSINESS_ACTIVITY].totalEvidenceCount === 1, `REQUIRED: total evidence for this attempt is 1, not 3 (got ${prefs[BUSINESS_ACTIVITY]?.totalEvidenceCount})`);
}
{
  const outreachId = 'outreach-reverts';
  const events = [
    outreach('org-a', { signalType: 'Partnership / Contract' }, 30, outreachId),
    outcome('org-a', 'engaged', outreachId, 20),
    outcome('org-a', 'went_nowhere', outreachId, 5)
  ];
  const prefs = computeOrgSignalPreferences('org-a', events);
  assert(!prefs[BUSINESS_ACTIVITY] || prefs[BUSINESS_ACTIVITY].totalEvidenceCount === 0, `REQUIRED: when the LATEST outcome report is went_nowhere, the earlier 'engaged' report is superseded and contributes nothing (got ${JSON.stringify(prefs[BUSINESS_ACTIVITY])})`);
}

// ===========================================================================
// 9. Recency window applies to the RESOLVED latest state's own timestamp.
// ===========================================================================
{
  const events = Array.from({ length: 10 }, () => signalUseful('org-a', 'Hiring Activity', { daysAgo: RECENCY_WINDOW_DAYS + 1 }));
  const prefs = computeOrgSignalPreferences('org-a', events, { now: NOW });
  assert(!prefs[BUSINESS_ACTIVITY], `REQUIRED: votes whose only (and therefore latest) record is older than the ${RECENCY_WINDOW_DAYS}-day window are excluded entirely`);
}
{
  const sameRep = 'rep-recency', sameSignal = 'fp-recency';
  const events = [
    signalNotUseful('org-a', 'Hiring Activity', { daysAgo: RECENCY_WINDOW_DAYS + 30, userId: sameRep, eventFingerprint: sameSignal }),
    signalUseful('org-a', 'Hiring Activity', { daysAgo: 1, userId: sameRep, eventFingerprint: sameSignal })
  ];
  const prefs = computeOrgSignalPreferences('org-a', events, { now: NOW });
  assert(prefs[BUSINESS_ACTIVITY].qualityPositiveCount === 1 && prefs[BUSINESS_ACTIVITY].totalEvidenceCount === 1, `REQUIRED: the rep's fresh, in-window updated opinion counts even though their original opinion was outside the window (got ${JSON.stringify(prefs[BUSINESS_ACTIVITY])})`);
}

// ===========================================================================
// 10. THE CENTRAL GUARANTEE: cross-organization isolation.
// ===========================================================================
{
  const mixedEvents = [
    ...Array.from({ length: 20 }, () => signalUseful('org-a', 'Hiring Activity')),
    ...Array.from({ length: 20 }, () => signalNotUseful('org-b', 'Award / Recognition')) // different org, different raw type, same family
  ];
  const prefsA = computeOrgSignalPreferences('org-a', mixedEvents);
  const prefsB = computeOrgSignalPreferences('org-b', mixedEvents);
  assert(prefsA[BUSINESS_ACTIVITY].adjustment === MAX_ADJUSTMENT, `REQUIRED: org-a's preferences are computed ONLY from org-a's own events, unaffected by org-b's opposite-direction feedback mixed into the same input array (got ${prefsA[BUSINESS_ACTIVITY].adjustment})`);
  assert(prefsB[BUSINESS_ACTIVITY].adjustment === -MAX_ADJUSTMENT, `REQUIRED: org-b's preferences are likewise computed only from org-b's own events (got ${prefsB[BUSINESS_ACTIVITY].adjustment})`);
  assert(prefsA[BUSINESS_ACTIVITY].totalEvidenceCount === 20 && prefsB[BUSINESS_ACTIVITY].totalEvidenceCount === 20, 'REQUIRED: each organization sees exactly its own event count, never the combined total');
}
{
  const events = Array.from({ length: 20 }, () => signalUseful('org-a', 'Hiring Activity'));
  const prefs = computeOrgSignalPreferences('', events);
  assert(Object.keys(prefs).length === 0, 'REQUIRED: an empty/missing organizationId produces zero buckets rather than defaulting to "match everything"');
}

// ===========================================================================
// 11. Determinism / purity.
// ===========================================================================
{
  const events = [
    ...Array.from({ length: 6 }, () => signalUseful('org-a', 'Hiring Activity', { daysAgo: 10 })),
    ...Array.from({ length: 3 }, () => signalNotUseful('org-a', 'Award / Recognition', { daysAgo: 5 }))
  ];
  const run1 = computeOrgSignalPreferences('org-a', events, { now: NOW });
  const run2 = computeOrgSignalPreferences('org-a', events, { now: NOW });
  assert(JSON.stringify(run1) === JSON.stringify(run2), 'REQUIRED: identical input produces byte-identical output on repeated calls -- pure, reproducible, nothing to "reset" because nothing is persisted');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
