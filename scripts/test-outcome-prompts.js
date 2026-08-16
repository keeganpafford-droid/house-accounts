// Notification & Outcome Loop V1 -- deterministic coverage for
// api/lib/outcome-prompts.js's pure timing/state logic. No Supabase, no
// HTTP -- every scenario is expressed as already-resolved event rows,
// matching this codebase's established pure-function testability
// convention (decideQueueOutcome(), selectTargetsToPublish()).
//
// Usage: node scripts/test-outcome-prompts.js
import { evaluateOutreachOutcome, latestOutcomeEvent, INITIAL_PROMPT_DAYS, NO_RESPONSE_RECHECK_DAYS } from '../api/lib/outcome-prompts.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function daysAgo(n, from = new Date('2026-08-20T00:00:00.000Z')) {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}
const NOW = new Date('2026-08-20T00:00:00.000Z');

assert(INITIAL_PROMPT_DAYS === 5, 'REQUIRED: the initial automatic prompt fires ~5 days after outreach_made, per the founder\'s exact specification');
assert(NO_RESPONSE_RECHECK_DAYS === 7, 'REQUIRED: a no_response_yet report becomes eligible for another prompt no sooner than ~7 days after that report, per the founder\'s exact specification');

// ---------------------------------------------------------------------------
// Never reported yet -- eligibility gated purely on days since outreach_made.
// ---------------------------------------------------------------------------
{
  const r = evaluateOutreachOutcome({ outreachCreatedAt: daysAgo(3), outcomeEvents: [], now: NOW });
  assert(r.currentStatus === null, 'REQUIRED: with no outcome_reported row at all, currentStatus is null -- distinct from the real "no_response_yet" status');
  assert(r.isEligibleForPrompt === false, 'REQUIRED: an outreach only 3 days old (< 5) is not yet eligible for the automatic prompt');
  assert(r.isStillOpen === true, 'an unreported outreach is always "still open" for the dashboard, regardless of the automatic-prompt window');
}
{
  const r = evaluateOutreachOutcome({ outreachCreatedAt: daysAgo(5), outcomeEvents: [], now: NOW });
  assert(r.isEligibleForPrompt === true, 'REQUIRED: an outreach exactly 5 days old with no report yet IS eligible (>= threshold, not strictly greater)');
}
{
  const r = evaluateOutreachOutcome({ outreachCreatedAt: daysAgo(10), outcomeEvents: [], now: NOW });
  assert(r.isEligibleForPrompt === true, 'an outreach well past 5 days with no report yet is eligible');
}

// ---------------------------------------------------------------------------
// no_response_yet -- a REAL report, remains unresolved/open, only becomes
// prompt-eligible again after its OWN 7-day recheck window (not the
// original outreach_made timestamp).
// ---------------------------------------------------------------------------
{
  const r = evaluateOutreachOutcome({
    outreachCreatedAt: daysAgo(20),
    outcomeEvents: [{ created_at: daysAgo(2), payload: { outcomeStatus: 'no_response_yet' } }],
    now: NOW
  });
  assert(r.currentStatus === 'no_response_yet', 'REQUIRED: currentStatus reflects the latest report, no_response_yet');
  assert(r.isStillOpen === true, 'REQUIRED: no_response_yet remains unresolved/open -- it must never be treated as a terminal/negative outcome');
  assert(r.isEligibleForPrompt === false, 'REQUIRED: only 2 days since the no_response_yet report (< 7) -- not yet eligible for another prompt, even though the ORIGINAL outreach was 20 days ago');
}
{
  const r = evaluateOutreachOutcome({
    outreachCreatedAt: daysAgo(20),
    outcomeEvents: [{ created_at: daysAgo(7), payload: { outcomeStatus: 'no_response_yet' } }],
    now: NOW
  });
  assert(r.isEligibleForPrompt === true, 'REQUIRED: exactly 7 days since the no_response_yet report IS eligible for a re-prompt (>= threshold)');
}

// ---------------------------------------------------------------------------
// Terminal statuses -- stop automatic prompting entirely, regardless of how
// much time has passed; no longer "still open" on the dashboard either.
// ---------------------------------------------------------------------------
for (const terminal of ['engaged', 'progressed', 'went_nowhere']) {
  const r = evaluateOutreachOutcome({
    outreachCreatedAt: daysAgo(100),
    outcomeEvents: [{ created_at: daysAgo(50), payload: { outcomeStatus: terminal } }],
    now: NOW
  });
  assert(r.currentStatus === terminal, `currentStatus reflects the terminal report (${terminal})`);
  assert(r.isEligibleForPrompt === false, `REQUIRED: '${terminal}' stops automatic prompting -- never eligible again regardless of elapsed time (50 days since the report)`);
  assert(r.isStillOpen === false, `REQUIRED: '${terminal}' is no longer "still open" for the dashboard's unresolved-outreach surface`);
}

// ---------------------------------------------------------------------------
// Latest-report-wins: multiple historical reports, only the newest governs
// current state -- older reports are never destroyed, just superseded.
// ---------------------------------------------------------------------------
{
  const outcomeEvents = [
    { created_at: daysAgo(15), payload: { outcomeStatus: 'no_response_yet' } },
    { created_at: daysAgo(8), payload: { outcomeStatus: 'no_response_yet' } },
    { created_at: daysAgo(1), payload: { outcomeStatus: 'engaged' } }
  ];
  const r = evaluateOutreachOutcome({ outreachCreatedAt: daysAgo(20), outcomeEvents, now: NOW });
  assert(r.currentStatus === 'engaged', `REQUIRED: current state is the LATEST report (engaged), even though it is chronologically the third of three reports (got ${r.currentStatus})`);
  assert(r.isEligibleForPrompt === false, 'the engaged report is terminal -- correctly overrides the two earlier no_response_yet reports for eligibility purposes');

  const latest = latestOutcomeEvent(outcomeEvents);
  assert(latest.payload.outcomeStatus === 'engaged', 'latestOutcomeEvent() itself resolves to the newest row regardless of input array order');
}
{
  // Unordered input -- latestOutcomeEvent() must sort, not assume caller order.
  const shuffled = [
    { created_at: daysAgo(1), payload: { outcomeStatus: 'went_nowhere' } },
    { created_at: daysAgo(30), payload: { outcomeStatus: 'no_response_yet' } },
    { created_at: daysAgo(10), payload: { outcomeStatus: 'no_response_yet' } }
  ];
  const latest = latestOutcomeEvent(shuffled);
  assert(latest.payload.outcomeStatus === 'went_nowhere', `REQUIRED: latestOutcomeEvent() sorts by created_at itself, independent of input order (got ${latest.payload.outcomeStatus})`);
}
{
  assert(latestOutcomeEvent([]) === null, 'latestOutcomeEvent() on an empty array returns null, not an error');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
