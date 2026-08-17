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
//     House Accounts MAY eventually improve globally by learning from
//     aggregated, de-identified feedback ACROSS MANY organizations about
//     the INTELLIGENCE SYSTEM ITSELF — e.g. many users across many
//     organizations marking a type of signal useful/not useful; systemic
//     source-quality patterns; recurring false-positive identity patterns;
//     general timing/actionability accuracy; whether certain signal
//     classifications or commercial interpretations consistently perform
//     poorly or well. This is a real, permitted future capability, NOT
//     forbidden by anything in this file — what's forbidden is narrower and
//     specific (see the two rules below). If ever built, Layer A is a
//     SEPARATE module, keyed by properties of the SIGNAL/SOURCE ITSELF
//     (canonicalEventType, source domain, identity-confidence tier,
//     coverage classification — see the "future global layer" note at the
//     bottom of this file), reading raw ha_signal_events rows directly.
//
//   Layer B — Private organization intelligence (THIS FILE):
//     How a specific organization sells and wins — which signal/opportunity
//     families it tends to value, based on ITS OWN reps' feedback and
//     outcomes. THIS COMPUTED PREFERENCE PROFILE is proprietary to that one
//     organization and must never cross organizations.
//
// The exact boundary between the two layers (founder-confirmed):
//   1. A future Layer A MAY consume aggregated/de-identified raw feedback
//      signals (signal_useful/not_useful, etc.) pooled across many
//      organizations — that is global signal-quality learning, not private
//      selling-behavior learning, and is allowed.
//   2. A future Layer A must NOT consume another organization's COMPUTED
//      preference adjustment (this file's computeOrgSignalPreferences()
//      return value) as an input. Raw de-identified events are a legitimate
//      Layer A input; this file's derived per-org output is not.
//   3. An org-specific preference weight must never be copied, averaged, or
//      transferred into another organization's ranking, by any layer.
//   4. Future global-learning work must remain a separate module/system
//      from this one.
//
// "House Accounts gets better at understanding signals globally, while the
// way your team sells becomes private intelligence for your organization."
// This file is the second half of that sentence — it computes ONLY private,
// organization-scoped preference weights, and must never itself pool
// evidence or output across organizations. It does not, by existing,
// prevent HA from ever learning globally elsewhere; a hypothetical global
// module simply may never read what THIS file produces, and this file may
// never read or blend in what another organization produced.
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
// DIMENSION (V1 — three broad families, deliberately coarser than what's
// actually persisted, per founder decision after the design-review audit)
// ============================================================================
// The recon's original "signal family/layer" idea (Follow-Up vs. Repeat-
// Pattern vs. Business Activity Signal) is a DASHBOARD-ONLY, client-side-
// computed label (getRecommendationType()/signalLayerLabel() in
// dashboard/index.html) that is never persisted onto a ha_signal_events row.
// An early Phase 1 draft substituted the closest ALREADY-PERSISTED proxies
// instead (payload.signalType's ~15-value taxonomy plus an ~11-value
// BUSINESS_ACTIVITY_* fallback family, and payload.opportunityType's 2
// values) — a design-review audit found this was materially higher
// cardinality than intended (~25+ possible buckets against a 5-event floor
// on tiny Beta data), so buckets would almost never accumulate enough
// evidence to matter.
//
// Founder decision: V1 stays intentionally much coarser than that. Exactly
// THREE canonical preference families, matching the original three-way
// product distinction without requiring the unpersisted display label:
//   - FOLLOW_UP        — payload.opportunityType === 'follow_up'
//   - REPEAT_PATTERN    — payload.opportunityType === 'repeat_pattern'
//   - BUSINESS_ACTIVITY — any signal_* event backed by the public/business
//                         payload.signalType taxonomy (regardless of WHICH
//                         specific signalType string -- V1 does not yet
//                         learn Acquisition vs. Hiring vs. Award; that
//                         finer-grained learning is an explicit, deferred
//                         V1.1/V2 once real evidence volume justifies it)
// canonicalPreferenceFamily() below is the ONE function that performs this
// mapping. It fails safe: an event that doesn't confidently match one of
// the three rules returns null and is EXCLUDED from learning entirely --
// never guessed, and never collapsed into a synthetic fourth "UNKNOWN"
// bucket that could itself accumulate influence.
//
// Payload shapes verified directly against the real snapshot builders
// (api/signal-events.js) to confirm BUSINESS_ACTIVITY cannot accidentally
// swallow the other two families: buildOpportunityRecommendationSnapshot()
// (opportunity_* events) returns {opportunityType, opportunityName,
// recommendedContact, reasonToReachOut, conversationStarter} -- it NEVER
// sets a signalType field, in either its 'repeat_pattern' or 'follow_up'
// branch. buildRecommendationSnapshot() (signal_* events) returns
// {signalType, signalTitle, commercialPlay, recommendedContact,
// activationIdeas, conversationStarter} -- it NEVER sets an opportunityType
// field. The two snapshot shapes are disjoint by construction; checking
// opportunityType first (with an exact-value match, not mere truthiness) is
// still done defensively so a hypothetical future THIRD opportunityType
// value is excluded rather than silently falling through to
// BUSINESS_ACTIVITY.

// Reused, not reinvented: this is the SAME "latest report wins" primitive
// api/lib/outcome-prompts.js already established for exactly this append-
// only-history problem (an outreach's CURRENT outcome is always whatever
// was reported most recently). Design-review finding: without this, a
// single outreach that a rep first reported 'engaged' on and later updated
// to 'progressed' would count as TWO independent successful examples
// instead of one outreach attempt with an updated status.
import { latestOutcomeEvent } from './outcome-prompts.js';

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

export const FOLLOW_UP = 'FOLLOW_UP';
export const REPEAT_PATTERN = 'REPEAT_PATTERN';
export const BUSINESS_ACTIVITY = 'BUSINESS_ACTIVITY';

// The ONE canonicalization function -- maps an event's own snapshot payload
// to exactly one of the three V1 preference families, or null (excluded,
// never guessed, never a synthetic UNKNOWN bucket). See the DIMENSION
// header comment above for the full rationale and the payload-shape proof
// that BUSINESS_ACTIVITY cannot swallow the other two families.
export function canonicalPreferenceFamily(payload = {}) {
  const opportunityType = payload?.opportunityType;
  if (opportunityType === 'follow_up') return FOLLOW_UP;
  if (opportunityType === 'repeat_pattern') return REPEAT_PATTERN;
  // An opportunity_* event with some OTHER/future opportunityType value:
  // do not guess, and do NOT fall through to signalType -- this payload
  // shape never carries one anyway (see the header comment's proof), but
  // the explicit early return keeps that guarantee independent of that
  // fact ever changing unnoticed.
  if (opportunityType) return null;
  const signalType = typeof payload?.signalType === 'string' ? payload.signalType.trim() : '';
  return signalType ? BUSINESS_ACTIVITY : null;
}

function withinRecencyWindow(createdAt, now, windowDays) {
  return (now.getTime() - new Date(createdAt).getTime()) <= windowDays * MS_PER_DAY;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function latestByCreatedAt(rows) {
  return rows.reduce((latest, row) => (!latest || new Date(row.created_at).getTime() > new Date(latest.created_at).getTime()) ? row : latest, null);
}
function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
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
//
// UNIT OF EVIDENCE (design-review correction, before Phase 2 wiring): the
// event system deliberately preserves changed feedback and updated
// outcomes as real history (see api/signal-events.js's semantic-dedupe
// doctrine and outcome_reported's own append-only doctrine) -- but that
// full history is the wrong thing to count directly here. A rep flipping
// Useful -> Not Useful on ONE signal is a single CURRENT opinion, not two
// independent votes; an outreach first reported 'engaged' and later
// updated to 'progressed' is ONE successful outreach attempt, not two.
// Both are collapsed to "only the latest state counts" BEFORE counting,
// using the exact same grouping key each doctrine already uses elsewhere
// (user_id + event_fingerprint for a rep's own opinion on one signal --
// matching api/signal-events.js's own semantic-dedupe query scope; and
// parent_event_id for one outreach attempt's outcome history -- reusing
// api/lib/outcome-prompts.js's latestOutcomeEvent() directly rather than
// re-deriving it). Two DIFFERENT reps judging the same signal, or two
// DIFFERENT real outreach attempts on the same signal, remain two
// legitimately separate pieces of evidence -- only a single rep's/single
// attempt's own history collapses.
export function computeOrgSignalPreferences(organizationId, events, { now = new Date() } = {}) {
  const orgId = String(organizationId || '');
  const allEvents = Array.isArray(events) ? events : [];

  // Structural cross-org guarantee: never trust the caller's own query
  // scoping alone. Unfiltered by recency here -- resolving each rep's/
  // outreach's true LATEST state requires the full history; recency is
  // applied afterward, to that resolved latest state's own timestamp (see
  // below), not to the raw rows before collapsing.
  const orgEvents = orgId ? allEvents.filter(e => String(e?.organization_id || '') === orgId) : [];
  const eventsById = new Map(orgEvents.map(e => [e.id, e]));

  const buckets = new Map(); // dimensionKey -> { qualityPositiveCount, qualityNegativeCount, outcomePositiveCount }
  function bucketFor(key) {
    if (!buckets.has(key)) buckets.set(key, { qualityPositiveCount: 0, qualityNegativeCount: 0, outcomePositiveCount: 0 });
    return buckets.get(key);
  }

  // Quality feedback: one vote per (user_id, event_fingerprint) -- this
  // rep's CURRENT opinion on this signal, not their full opinion history.
  const qualityEvents = orgEvents.filter(e => QUALITY_POSITIVE_TYPES.has(e?.event_type) || QUALITY_NEGATIVE_TYPES.has(e?.event_type));
  const qualityGroups = groupBy(qualityEvents, e => `${e.user_id}::${e.event_fingerprint}`);
  for (const group of qualityGroups.values()) {
    const latest = latestByCreatedAt(group);
    if (!latest?.created_at || !withinRecencyWindow(latest.created_at, now, RECENCY_WINDOW_DAYS)) continue;
    const key = canonicalPreferenceFamily(latest.payload || {});
    if (!key) continue;
    const bucket = bucketFor(key);
    if (QUALITY_POSITIVE_TYPES.has(latest.event_type)) bucket.qualityPositiveCount += 1;
    else bucket.qualityNegativeCount += 1;
  }

  // Outcome evidence: one vote per outreach ATTEMPT (parent_event_id) --
  // that attempt's CURRENT reported status, not every status it ever
  // passed through. outcome_reported rows carry no snapshot of their own
  // (payload is just {outcomeStatus, note?}); the dimension key is
  // resolved via the attempt's own outreach_made/opportunity_outreach_made
  // event snapshot.
  const outcomeEvents = orgEvents.filter(e => e?.event_type === 'outcome_reported' && e?.parent_event_id);
  const outcomeGroups = groupBy(outcomeEvents, e => e.parent_event_id);
  for (const group of outcomeGroups.values()) {
    const latest = latestOutcomeEvent(group);
    if (!latest?.created_at || !withinRecencyWindow(latest.created_at, now, RECENCY_WINDOW_DAYS)) continue;
    const status = latest.payload?.outcomeStatus;
    if (!OUTCOME_POSITIVE_STATUSES.has(status)) continue; // went_nowhere/no_response_yet: never counted, by design
    const parent = eventsById.get(latest.parent_event_id);
    if (!parent || !OUTREACH_TYPES.has(parent.event_type)) continue;
    const key = canonicalPreferenceFamily(parent.payload || {});
    if (!key) continue;
    bucketFor(key).outcomePositiveCount += 1;
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
