// Notification & Outcome Loop V1: pure outcome-prompt timing/state logic.
// No Supabase calls, no side effects -- every input is already-resolved
// ha_signal_events rows, matching this codebase's established pure-function
// testability convention (decideQueueOutcome(), selectTargetsToPublish()).
// Shared by api/unresolved-outreach.js (the dashboard read endpoint) and
// api/lib/notification-digest.js (Step 3) -- one source of truth for the
// 5-day/7-day timing rule, so the two surfaces can never silently disagree
// on when an outreach becomes prompt-eligible.
//
// Product doctrine (founder correction): 'no_response_yet' IS a real
// outcome_reported row, not the absence of one -- "unresolved" means the
// latest known state is either no_response_yet or genuinely never reported,
// never merely "no outcome_reported row exists yet" (that would wrongly
// treat a rep's honest "still don't know" as if they'd never answered).
// engaged/progressed/went_nowhere are terminal for AUTOMATIC prompting
// only -- outcome_reported stays append-only, so a rep can always add a
// later manual update; this module just stops the SYSTEM nudging again
// once a rep has given a real answer.
import { OUTCOME_STATUSES } from '../signal-events.js';

export const INITIAL_PROMPT_DAYS = 5;
export const NO_RESPONSE_RECHECK_DAYS = 7;
const TERMINAL_STATUSES = new Set(OUTCOME_STATUSES.filter(s => s !== 'no_response_yet'));
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysSince(isoTimestamp, now) {
  return (now.getTime() - new Date(isoTimestamp).getTime()) / MS_PER_DAY;
}

// outcomeEvents: every outcome_reported row for ONE outreach_made/
// opportunity_outreach_made event, any order -- returns the single LATEST
// one by created_at (append-only history means "current state" is always
// whatever was reported most recently), or null if none exist yet.
export function latestOutcomeEvent(outcomeEvents = []) {
  if (!outcomeEvents.length) return null;
  return [...outcomeEvents].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
}

// The full evaluated state for one outreach attempt.
//   currentStatus: null only when literally no outcome_reported row exists
//     yet (distinct from 'no_response_yet', which IS a status).
//   isEligibleForPrompt: governs automatic NOTIFICATION inclusion only.
//   isStillOpen: the broader dashboard condition -- "not yet given a
//     terminal answer" -- true for both never-reported and no_response_yet,
//     independent of the 5/7-day window (a rep can close this out any time,
//     not only once the automatic-prompt window opens).
export function evaluateOutreachOutcome({ outreachCreatedAt, outcomeEvents = [], now = new Date() }) {
  const latest = latestOutcomeEvent(outcomeEvents);
  const currentStatus = latest ? (latest.payload?.outcomeStatus || null) : null;
  // Exposed so a caller (api/lib/notification-digest.js) can tell whether
  // an item's state has genuinely changed since it was last mentioned in a
  // notification, independent of this function's own eligibility window --
  // null when nothing has ever been reported (outreachCreatedAt is then the
  // relevant "last changed" timestamp for that comparison).
  const latestOutcomeReportedAt = latest ? latest.created_at : null;

  if (latest && TERMINAL_STATUSES.has(currentStatus)) {
    return { currentStatus, isEligibleForPrompt: false, isStillOpen: false, reason: 'terminal-outcome-reported', latestOutcomeReportedAt };
  }

  if (!latest) {
    const eligible = daysSince(outreachCreatedAt, now) >= INITIAL_PROMPT_DAYS;
    return { currentStatus: null, isEligibleForPrompt: eligible, isStillOpen: true, reason: eligible ? 'never-reported-past-initial-window' : 'never-reported-within-initial-window', latestOutcomeReportedAt };
  }

  // currentStatus === 'no_response_yet' (the only remaining case: latest
  // exists and is not terminal).
  const eligible = daysSince(latest.created_at, now) >= NO_RESPONSE_RECHECK_DAYS;
  return { currentStatus, isEligibleForPrompt: eligible, isStillOpen: true, reason: eligible ? 'no-response-yet-past-recheck-window' : 'no-response-yet-within-recheck-window', latestOutcomeReportedAt };
}
