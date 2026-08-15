// Phase 2B: the thin Vercel Queue adapter. Every Vercel-Queue-specific call
// (the @vercel/queue SDK's send()) is isolated to this one file's
// enqueueMonitoringJob() -- domain/research code never imports @vercel/queue
// directly. This is cheap insurance, not abstraction for its own sake: a
// future Vercel Queue API change, or a later move to Workflow for a
// different job shape, touches this one file's boundary rather than the
// scheduler, the consumer route, or the research pipeline.
//
// IMPORTANT, stated plainly: this file is written against the current
// documented @vercel/queue API surface (see the Phase 2B report for the
// exact doc citations) but has NOT been executed against a real Vercel
// Queue from this session -- this sandboxed environment has no Vercel
// deployment access and no live provider credentials. Verify send()'s exact
// signature against your installed @vercel/queue version before the first
// real deploy; this is the one piece of this file that cannot be proven
// correct by a deterministic test alone.
//
// ============================================================================
// Coherent failure-model timings (Phase 2B item B).
// ============================================================================
// Three numbers, in a deliberate order, so a crashed/hung worker resolves
// itself in a predictable sequence rather than three independent, possibly-
// conflicting timeouts:
//
//   WORKER_MAX_DURATION_SECONDS (180) < DB_LEASE_SECONDS (300)
//     < QUEUE_VISIBILITY_TIMEOUT_SECONDS (600)
//
// 180s: generous headroom over the single-account research benchmarks
// already established (25-55s typical, per api/research-batch.js's own
// documented timing) -- a worker still running past this is genuinely
// hung, not just slow, and should be platform-killed rather than occupy a
// concurrency slot indefinitely (see the Phase 1 architecture
// recommendation this carries forward unchanged).
//
// 300s DB lease: comfortably above the worker's own maxDuration (a
// legitimately-finishing worker always completes and clears its lease
// well before this), but well BELOW the Queue visibility timeout. This
// ordering matters: if the worker is killed by the platform (hits its own
//180s ceiling) or crashes outright, the DATABASE lease expires at 300s --
// before Queue would even consider redelivering the message at 600s. A
// worker checking the target's claimability in that 300-600s window (e.g.
// an operator-triggered manual retry, or a future heartbeat mechanism)
// already sees a reclaimable expired lease, not a false "already-leased".
//
// 600s Queue visibility: generous enough that Queue's own natural
// redelivery essentially never fires for a healthy worker, and when it
// does fire (a genuine crash), the DB lease has already lapsed 300s
// earlier -- so the redelivered attempt's claim call correctly reclaims
// and retries the real work, rather than bouncing off a stale
// already-leased state that no longer reflects reality.
//
// No mid-flight lease-extension (ExtendLease API / Queue's documented
// visibility-timeout-extension) is used for V1 -- the task's own
// instruction to "prefer the simplest documented solution" is satisfied by
// a single generous fixed timeout, since 600s is already 3.3x the worker's
// own ceiling. Revisit only if real single-account timing is ever
// observed exceeding this margin.
export const WORKER_MAX_DURATION_SECONDS = 180;
export const DB_LEASE_SECONDS = 300;
export const QUEUE_VISIBILITY_TIMEOUT_SECONDS = 600;

// ============================================================================
// Message retention / TTL (Phase 2B item D).
// ============================================================================
// Deliberately SHORT (1 hour), not Queue's 24h default/maximum. Reasoning:
// next_due_at is the durable, long-term source of scheduling truth, not the
// Queue message -- a target whose Queue message is ever truly abandoned
// (e.g. a worker crash with no completion call at all) simply stays "due"
// in the database forever, regardless of what happens to that one message.
// The scheduler (api/monitoring-scheduler.js) republishes for any due
// target on every run, using a DETERMINISTIC idempotency key derived from
// (targetId, next_due_at) -- see buildIdempotencyKey() below. Because that
// key does not change until next_due_at actually advances, a republish
// attempt for a still-stuck target reuses the IDENTICAL idempotency key
// every time, and Vercel Queue's own idempotency-key deduplication window
// is tied to the original message's retention/TTL (per current docs) --
// so as long as the ORIGINAL message's retention window has expired, the
// republish is treated as fresh and actually reaches a consumer again. A
// short retention window directly bounds how long a stuck target can go
// before becoming re-publishable: at most ~1 hour plus one scheduler
// interval, not up to a full day. Given this system's cadence is weekly,
// that bound is more than tight enough.
export const MESSAGE_RETENTION_SECONDS = 60 * 60;

// Small and deliberate, not Queue's own ~32-attempt honored-delay ceiling.
// There is no built-in DLQ (per current docs), so an application-level cap
// is required to stop a permanently bad message from consuming retries
// forever with no diagnostic trail. 5 attempts is enough to absorb a
// transient provider hiccup (the common, worth-retrying case) without
// looking anything like "stuck forever."
export const POISON_DELIVERY_THRESHOLD = 5;

// Fixed weekly cadence, matching the locked architecture direction
// (dynamic cadence is explicitly deferred). Not read from anywhere else --
// this is the one place it is defined for the Queue-connected path.
export const CADENCE_DAYS = 7;

export const MONITORING_QUEUE_TOPIC = process.env.MONITORING_QUEUE_TOPIC || 'monitoring-jobs';

// Deterministic per-due-cycle idempotency key: identical for the same
// target as long as next_due_at has not changed (i.e. as long as it has
// not yet successfully completed). Repeated scheduler runs against the
// same still-due target therefore always produce the same key, which
// Vercel Queue's own send-time deduplication collapses -- the scheduler
// does not need its own separate "have I already enqueued this" tracking.
export function buildIdempotencyKey(target) {
  return `monitor:${target.id}:${target.next_due_at}`;
}

// Phase 2B item K: whether an organization is currently managed by the new
// Queue-connected path rather than the legacy api/weekly-scan.js sweep.
// Empty/unset allowlist -> false for everyone -- a no-op by default, so
// this function existing at all does not change production behavior until
// an operator deliberately sets QUEUE_MANAGED_ORGANIZATION_IDS for their
// own founder-controlled org(s).
export function isQueueManagedOrganization(organizationId, allowlistEnvValue) {
  const list = String(allowlistEnvValue || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length || !organizationId) return false;
  return list.includes(String(organizationId));
}

// ============================================================================
// Item C: the exact ack-vs-retry decision, as a pure function so it is
// fully unit-testable without any real Queue or database call. "ack"
// (resolve normally from the consumer route) tells Queue this delivery is
// permanently done, never redeliver it. "retry" (throw from the consumer
// route) tells Queue to redeliver later per its own backoff.
// ============================================================================
export function decideQueueOutcome({ claim, coverage, deliveryCount = 1 }) {
  if (claim && claim.ok === false) {
    // already-leased: another worker owns this target's real completion
    // right now, independent of this Queue delivery -- acking here never
    // loses recoverable work, because next_due_at (not this message) is
    // what actually tracks whether the target still needs research. If the
    // OTHER worker also fails, next_due_at stays unchanged and a future
    // scheduler run republishes fresh, under a Queue message this one's ack
    // has no bearing on.
    // not-due: expected (a race against a just-completed scan, or a stale
    // duplicate arriving after real completion) -- never retryable.
    // not-active: paused/removed -- never retryable; no amount of retrying
    // makes a paused target active again.
    return { action: 'ack', reason: claim.reason };
  }
  if (coverage === 'complete' || coverage === 'degraded_trustworthy') {
    return { action: 'ack', reason: 'completed' };
  }
  if (coverage === 'insufficient') {
    // Retryable up to the poison threshold -- absorbs a transient provider
    // hiccup via Queue's own backoff. Beyond the threshold, stop: the
    // completion RPC has already recorded last_error/last_attempt_status
    // for operator visibility, and next_due_at was correctly left
    // unchanged, so the database scheduler remains the long-term backstop
    // regardless of what happens to this specific message.
    if (deliveryCount < POISON_DELIVERY_THRESHOLD) return { action: 'retry', reason: 'insufficient-coverage-retryable' };
    return { action: 'ack', reason: 'insufficient-coverage-poison-threshold-exceeded' };
  }
  // Unrecognized outcome shape -- fail closed toward a bounded retry
  // (never toward silently dropping unrecognized work), same poison
  // threshold as the insufficient-coverage case.
  if (deliveryCount < POISON_DELIVERY_THRESHOLD) return { action: 'retry', reason: 'unrecognized-outcome' };
  return { action: 'ack', reason: 'unrecognized-outcome-poison-threshold-exceeded' };
}

// Pure: the exact message payload for one target. Item F (one account per
// message) is structural here, not just a convention -- there is no
// plural/array form of this function or of the payload shape it returns.
// Separated from enqueueMonitoringJob() below purely so it is testable
// without needing @vercel/queue installed/importable (this sandbox has
// neither) -- see scripts/test-monitoring-queue-adapter.js.
export function buildEnqueuePayload(target) {
  return { targetId: target.id, organizationId: target.organization_id };
}

// Publishes exactly one monitoring job for exactly one target. Written
// against @vercel/queue's documented send(topic, payload, options)
// surface -- see this file's header comment for the "not executed live"
// caveat. The dynamic import keeps every OTHER export in this file
// importable/testable in an environment (like this one) where
// @vercel/queue is not installed.
export async function enqueueMonitoringJob(target) {
  const { send } = await import('@vercel/queue');
  const idempotencyKey = buildIdempotencyKey(target);
  const { messageId } = await send(
    MONITORING_QUEUE_TOPIC,
    buildEnqueuePayload(target),
    { idempotencyKey, retentionSeconds: MESSAGE_RETENTION_SECONDS }
  );
  // Item J observability: one log line per published message, correlated by
  // targetId/messageId/idempotencyKey -- these three values are what tie
  // "due target" to "published message" to "Queue delivery" (Vercel's own
  // Queue observability surfaces messageId/deliveryCount) to "monitoring
  // attempt" (the completion log line below, correlated by targetId and
  // attemptId). No new observability system -- existing Vercel function
  // logs plus these correlation ids are sufficient, per this item's own
  // "do not build a dashboard" instruction.
  console.log('[monitoring-queue.enqueued]', JSON.stringify({ targetId: target.id, organizationId: target.organization_id, messageId, idempotencyKey }));
  return { messageId, idempotencyKey };
}

// The consumer body. Deliberately dependency-injected (claimTarget/
// completeAttempt/resolveAccountContext/runPipeline) rather than importing
// Supabase/research-pipeline calls directly, so it is testable with plain
// mocks (see scripts/test-monitoring-queue-adapter.js) without any real
// Queue, database, or provider call. api/queues/monitoring-consumer.js is
// the thin route file that supplies the real implementations and hands
// this function to @vercel/queue's handleNodeCallback().
export async function processMonitoringJob(message, metadata, deps) {
  const { claimTarget, completeAttempt, resolveAccountContext, runPipeline, apiKey, model } = deps;
  const targetId = message?.targetId;
  const deliveryCount = metadata?.deliveryCount || 1;

  if (!targetId) {
    // Malformed message: nothing to claim, never retryable.
    return { action: 'ack', reason: 'malformed-message-missing-target-id' };
  }

  let claim;
  try {
    claim = await claimTarget(targetId, DB_LEASE_SECONDS);
  } catch (err) {
    // claim_ha_monitoring_target raises when the target does not exist at
    // all (errcode HA010) -- a genuinely non-retryable poison message, same
    // posture as a malformed one.
    return { action: 'ack', reason: 'claim-failed-target-not-found', error: err.message };
  }
  if (!claim.ok) {
    return decideQueueOutcome({ claim, deliveryCount });
  }

  const startedAt = Date.now();
  const accountContext = await resolveAccountContext(targetId);
  const result = await runPipeline(accountContext, { apiKey, model, startedAt });

  await completeAttempt({
    targetId,
    attemptId: claim.attemptId,
    coverage: result.coverage,
    cadenceDays: CADENCE_DAYS,
    error: result.error,
    telemetry: result.providerUsage
  });

  const decision = decideQueueOutcome({ coverage: result.coverage, deliveryCount });
  // Item J observability: correlates back to the enqueue log line via
  // targetId, and is the "monitoring attempt -> completion/failure" half of
  // the due-target -> published message -> Queue delivery -> attempt ->
  // completion chain this item asks to be reconcilable, without any new
  // dashboard.
  console.log('[monitoring-queue.completed]', JSON.stringify({
    targetId, attemptId: claim.attemptId, deliveryCount, coverage: result.coverage,
    signalCount: (result.signals || []).length, elapsedMs: result.elapsedMs,
    estimatedCostUsd: result.providerUsage?.estimatedCostUsd, queueAction: decision.action, queueActionReason: decision.reason
  }));
  return decision;
}
