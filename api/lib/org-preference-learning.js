// Behavioral Learning V1, Phase 1 — the PRIVATE ORGANIZATION preference
// layer only. Pure, isolated, unit-tested against fixtures in this phase;
// not yet wired into api/get-dashboard.js or api/lib/notification-digest.js
// (that's Phase 2/3, per the founder-approved architecture proposal).
//
// ============================================================================
// TWO-LAYER LEARNING DOCTRINE — read this before touching this file.
// ============================================================================
// House Accounts has (or will eventually have) two DELIBERATELY SEPARATE
// learning layers, and this file is ONLY one of them:
//
//   Layer A — Global HA intelligence (NOT this file, NOT built yet):
//     House Accounts may eventually improve globally from aggregated,
//     de-identified feedback about the INTELLIGENCE SYSTEM ITSELF — signal/
//     source quality, event classification accuracy, timing/actionability
//     accuracy, systemic false-positive/false-negative patterns. This would
//     be keyed by properties of the SIGNAL/SOURCE ITSELF (canonicalEventType,
//     source domain, identity-confidence tier, coverage classification —
//     see the "future global layer" note at the bottom of this file), never
//     by which organization felt what. If ever built, it lives in a
//     SEPARATE module and NEVER reads this file's output.
//
//   Layer B — Private organization intelligence (THIS FILE):
//     How a specific organization sells and wins — which signal/opportunity
//     families it tends to value, based on ITS OWN reps' feedback and
//     outcomes. This is proprietary to that one organization (see
//     api/signal-events.js's own header doctrine: "raw rep behavior captured
//     here is proprietary to the organization that generated it and is
//     never pooled, benchmarked, or exposed across organizations" — this
//     file inherits and enforces that same rule for the derived preference
//     weights it computes, not just the raw events).
//
// "House Accounts gets better at understanding signals globally, while the
// way your team sells becomes private intelligence for your organization."
// This file is the second half of that sentence. It must never become, or
// be extended into, the first half.
//
// STRUCTURAL GUARANTEE (not just documentation): computeOrgSignalPreferences()
// below takes an explicit organizationId and DEFENSIVELY filters its input
// events to that exact organization, even though every real caller is
// already expected to have scoped its own ha_signal_events query by
// organization_id (api/signal-events.js's established pattern). This is
// deliberate defense in depth — a caller bug that passes a too-broad event
// set can never cause one organization's preference weights to be computed
// from, or contaminated by, another organization's events. No customer-
// specific preference profile is ever copied, averaged, or transferred
// between organizations by this file, structurally, not merely by
// intention.
//
// ============================================================================
// EVIDENCE DOCTRINE (from the founder-approved architecture proposal)
// ============================================================================
// Two kinds of evidence, tracked separately, never blended into a single
// unlabeled number:
//   - Signal-quality feedback: signal_useful/opportunity_useful (positive),
//     signal_not_useful/opportunity_not_useful (negative). A rep's direct
//     judgment on the signal/opportunity itself.
//   - Outcome evidence: outcome_reported with status 'engaged' or
//     'progressed' only (positive). Rep-attributed, correlational evidence
//     that this KIND of thing tends to lead somewhere for this org — never
//     interpreted as proof any one specific signal "caused" the result.
//
// Explicitly NOT counted as evidence, by design (do not add these later
// without deliberately revisiting this doctrine):
//   - selected / prepare_call_opened — engagement, not a quality judgment.
//     Doctrine: do not assume "selected" means the signal was good.
//   - outreach_made itself — acting on something is not proof it was good.
//   - went_nowhere — does NOT prove the underlying signal was bad; timing,
//     the specific contact, budget, or plain bad luck could explain it just
//     as well. Doctrine: distinguish "bad signal" from "good signal the org
//     just didn't convert on this time."
//   - no_response_yet — explicitly unresolved, never negative evidence.
//   - approach_shared notes — free text, not structured evidence.
//
// ============================================================================
// DIMENSION (V1 — single dimension, chosen from what's ACTUALLY persisted)
// ============================================================================
// The recon's original "signal family/layer" idea (Follow-Up vs. Repeat-
// Pattern vs. Business Activity Signal) turned out to be a DASHBOARD-ONLY,
// client-side-computed label (getRecommendationType()/signalLayerLabel() in
// dashboard/index.html) that is never persisted onto a ha_signal_events row
// — so it cannot be read back here. Two already-persisted proxies exist
// instead, both captured in the recommendation snapshot at event-write time
// (api/signal-events.js's buildRecommendationSnapshot()/
// buildOpportunityRecommendationSnapshot()):
//   - signal_* family events carry payload.signalType (e.g. "Hiring",
//     "Award / Recognition", "Acquisition", "Leadership Change") —
//     moderate cardinality.
//   - opportunity_* family events carry payload.opportunityType, exactly
//     two values: 'repeat_pattern' | 'follow_up' — low cardinality, closer
//     to the original "family" idea for that one family.
// dimensionKeyForSnapshot() below namespaces these into one dimension-key
// space (`signal:<signalType>` / `opportunity:<opportunityType>`) so the
// aggregation logic stays generic and doesn't need to know which family it
// came from.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Cold-start / sample-size guardrails (architecture proposal §5). Kept as
// named, overridable constants rather than buried literals — tune here,
// nowhere else, if real Beta evidence later justifies different numbers.
export const MIN_EVIDENCE_COUNT = 5;
export const MAX_ADJUSTMENT = 8;
export const RECENCY_WINDOW_DAYS = 90;

const QUALITY_POSITIVE_TYPES = new Set(['signal_useful', 'opportunity_useful']);
const QUALITY_NEGATIVE_TYPES = new Set(['signal_not_useful', 'opportunity_not_useful']);
const OUTREACH_TYPES = new Set(['outreach_made', 'opportunity_outreach_made']);
const OUTCOME_POSITIVE_STATUSES = new Set(['engaged', 'progressed']);

// Extracts this dimension's bucket key from an event's own snapshot
// payload. Returns null when the event type carries no snapshot at all
// (e.g. outcome_reported, approach_shared) or the snapshot has neither
// signalType nor opportunityType (should not happen for a well-formed row,
// but never throws on one -- an unclassifiable event is simply excluded,
// not an error).
function dimensionKeyForSnapshot(payload = {}) {
  if (payload.signalType) return `signal:${payload.signalType}`;
  if (payload.opportunityType) return `opportunity:${payload.opportunityType}`;
  return null;
}

function withinRecencyWindow(createdAt, now, windowDays) {
  return (now.getTime() - new Date(createdAt).getTime()) <= windowDays * MS_PER_DAY;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Pure. Takes an explicit organizationId plus an already-fetched array of
// ha_signal_events rows (any shape/scope the caller happened to fetch --
// this function is the one place responsible for narrowing to exactly one
// organization, see the structural-guarantee note above) and returns a
// plain object keyed by dimension key, each value carrying both the
// combined bounded ranking adjustment AND the raw evidence counts it was
// computed from (architecture proposal §8 — explainability from day one,
// no separate audit table: this return value IS the explanation).
//
// Default behavior with insufficient evidence for a given dimension key is
// NO adjustment (0) -- this is also what every organization gets on day
// one, by construction, before any real Beta feedback accumulates.
export function computeOrgSignalPreferences(organizationId, events, { now = new Date() } = {}) {
  const orgId = String(organizationId || '');
  const allEvents = Array.isArray(events) ? events : [];

  // Structural cross-org guarantee: never trust the caller's own query
  // scoping alone.
  const orgEvents = orgId ? allEvents.filter(e => String(e?.organization_id || '') === orgId) : [];
  const recentEvents = orgEvents.filter(e => e?.created_at && withinRecencyWindow(e.created_at, now, RECENCY_WINDOW_DAYS));

  // outcome_reported rows carry no snapshot of their own (payload is just
  // {outcomeStatus, note?}) -- their dimension key is resolved via their
  // parent outreach_made/opportunity_outreach_made event's own snapshot.
  // Built from the FULL org event set (not just the recency-windowed one),
  // since an in-window outcome report can legitimately reference an
  // out-of-window outreach event; the outcome report's own created_at is
  // what the recency filter above already applied to decide whether the
  // outcome itself counts.
  const eventsById = new Map(orgEvents.map(e => [e.id, e]));

  const buckets = new Map(); // dimensionKey -> { qualityPositiveCount, qualityNegativeCount, outcomePositiveCount }
  function bucketFor(key) {
    if (!buckets.has(key)) buckets.set(key, { qualityPositiveCount: 0, qualityNegativeCount: 0, outcomePositiveCount: 0 });
    return buckets.get(key);
  }

  for (const event of recentEvents) {
    const eventType = event?.event_type;
    if (QUALITY_POSITIVE_TYPES.has(eventType) || QUALITY_NEGATIVE_TYPES.has(eventType)) {
      const key = dimensionKeyForSnapshot(event.payload || {});
      if (!key) continue;
      const bucket = bucketFor(key);
      if (QUALITY_POSITIVE_TYPES.has(eventType)) bucket.qualityPositiveCount += 1;
      else bucket.qualityNegativeCount += 1;
      continue;
    }
    if (eventType === 'outcome_reported') {
      const status = event.payload?.outcomeStatus;
      if (!OUTCOME_POSITIVE_STATUSES.has(status)) continue; // went_nowhere/no_response_yet: never counted, by design
      const parent = event.parent_event_id ? eventsById.get(event.parent_event_id) : null;
      if (!parent || !OUTREACH_TYPES.has(parent.event_type)) continue;
      const key = dimensionKeyForSnapshot(parent.payload || {});
      if (!key) continue;
      bucketFor(key).outcomePositiveCount += 1;
    }
    // Every other event type (selected, prepare_call_opened, outreach_made
    // itself, approach_shared) is intentionally never counted as evidence
    // — see the EVIDENCE DOCTRINE header comment.
  }

  const result = {};
  for (const [key, counts] of buckets) {
    const totalEvidenceCount = counts.qualityPositiveCount + counts.qualityNegativeCount + counts.outcomePositiveCount;
    const sufficientEvidence = totalEvidenceCount >= MIN_EVIDENCE_COUNT;
    // Simple, explainable net-rate formula -- not a model, a bounded
    // tie-break. Quality feedback and outcome evidence contribute equally
    // per event; conflicting evidence naturally nets toward zero with no
    // special-casing. Never computed (stays 0) below the evidence floor.
    const netScore = counts.qualityPositiveCount - counts.qualityNegativeCount + counts.outcomePositiveCount;
    const adjustment = sufficientEvidence
      ? clamp(Math.round((netScore / totalEvidenceCount) * MAX_ADJUSTMENT), -MAX_ADJUSTMENT, MAX_ADJUSTMENT)
      : 0;
    result[key] = { adjustment, sufficientEvidence, totalEvidenceCount, ...counts };
  }
  return result;
}

// Small lookup helper for future wiring (Phase 2/3, not called anywhere
// yet): returns 0 for a missing or insufficient-evidence dimension key,
// exactly the "current ranking unchanged" default the architecture
// proposal requires.
export function getOrgPreferenceAdjustment(preferences, dimensionKey) {
  const entry = preferences?.[dimensionKey];
  return entry?.sufficientEvidence ? entry.adjustment : 0;
}

export { dimensionKeyForSnapshot };

// ============================================================================
// FUTURE GLOBAL LAYER — NOT IMPLEMENTED. Left as a pointer only, per the
// founder's explicit instruction not to build Layer A in this sprint.
// ============================================================================
// If a future, SEPARATE module implements Layer A (global HA intelligence),
// it should key its aggregation by properties of the SIGNAL/SOURCE ITSELF —
// never by organization_id, and never by reading this file's per-org
// preference output. Candidate existing fields, all already captured
// somewhere in this codebase today, that a global-quality module could
// aggregate signal_useful/signal_not_useful counts against WITHOUT ever
// importing an organization's private preference weights:
//   - payload.signalType / canonicalEventType (api/research-batch.js) —
//     is this CATEGORY of signal generally reliable across all customers?
//   - source_domain (ha_signals.source_domain) — is this SOURCE generally
//     trustworthy?
//   - identityConfidence / identityCorroboratorReasons
//     (api/lib/monitoring-identity.js) — does weak identity correlate with
//     "not useful" feedback in general, regardless of which org reported it?
//   - coverage_classification (ha_monitoring_attempts) — does degraded
//     research coverage correlate with lower-quality signals generally?
//   - actionabilityStatus (api/research-batch.js's classifyLegacySignalActionability())
//     — is the actionability-gate logic itself systematically over/under-
//     confident for certain event categories?
// A global module built on these would read RAW ha_signal_events rows
// (already de-identified of organization-specific selling behavior by
// virtue of the fields it selects), never this file's computeOrgSignalPreferences()
// return value -- the two data paths must stay structurally independent,
// not just conventionally separate.
