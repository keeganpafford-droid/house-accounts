// Phase 2B: the thin Vercel Queue adapter. Every Vercel-Queue-specific call
// (the @vercel/queue SDK's QueueClient) is isolated to this one file's
// getQueueClient()/enqueueMonitoringJob() -- domain/research code never
// imports @vercel/queue directly. This is cheap insurance, not abstraction
// for its own sake: a future Vercel Queue API change, or a later move to
// Workflow for a different job shape, touches this one file's boundary
// rather than the scheduler, the consumer route, or the research pipeline.
//
// Verified against the actually installed package: @vercel/queue 0.4.0,
// exact-pinned in package.json (Queues remain public beta -- no caret
// range). This file's use of `new QueueClient()`, the destructured
// `send`/`handleNodeCallback` arrow-function properties, `idempotencyKey`,
// `retentionSeconds`, and the `MessageMetadata`/`RetryHandler`/
// `RetryDirective` shapes below were all read directly from
// node_modules/@vercel/queue/dist/index.d.mts, not assumed from docs --
// this still has not been executed against a real deployed Queue from this
// sandbox (no Vercel deployment access here), so the first live smoke test
// remains the actual proof.
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

// Item 3: how long a duplicate delivery that lands on an ACTIVELY-LEASED
// target waits before Queue tries again. Deliberately short relative to
// DB_LEASE_SECONDS (300s) -- this is not an attempt to "wait out" the
// original worker, just a modest, non-hot-looping check-back interval.
// Whichever outcome has actually happened by the time the redelivery
// lands -- original succeeded (target now not-due -> ack) or original
// crashed (DB lease expired -> reclaimed) -- is decided fresh by a real
// claim_ha_monitoring_target call at that later delivery, not by this
// timer; the timer only bounds how soon that fresh check happens. Matches
// the SDK's own vercel.json `retryAfterSeconds` default (60s, confirmed
// via Vercel's queue/v2beta trigger docs) so an already-leased retry and a
// generic unhandled-error retry behave on the same cadence.
export const ALREADY_LEASED_RETRY_DELAY_SECONDS = 60;

// Phase 2D: how long a delivery that found the global capacity pool full
// waits before Queue tries again. Deliberately shorter than
// ALREADY_LEASED_RETRY_DELAY_SECONDS -- an already-leased retry is waiting
// on one specific target's own research to finish (tens of seconds at
// least), while a capacity slot can free up the moment ANY worker in the
// global pool finishes, which happens more often in aggregate. Not so
// short it hot-loops uselessly against a pool that is genuinely saturated
// for a while.
export const CAPACITY_UNAVAILABLE_RETRY_DELAY_SECONDS = 30;

// Phase 2D default: MONITORING_MAX_CONCURRENT_WORKERS env var, read here
// (not scattered across call sites) so every consumer of the default
// agrees on it. api/queues/monitoring-consumer.js and
// api/monitoring-scheduler.js each read their own env vars independently
// where they need them (matching this codebase's existing per-file env
// convention) -- this constant exists only as the documented fallback
// value for MONITORING_MAX_CONCURRENT_WORKERS itself.
export const DEFAULT_MONITORING_MAX_CONCURRENT_WORKERS = 2;

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

// Phase 2B item K: whether an organization is currently activated for
// recurring Queue monitoring at all -- the legacy api/weekly-scan.js sweep
// this allowlist originally excluded orgs FROM was retired with the Full
// Beta Cutover, so the Queue path is now the only recurring-monitoring
// mechanism and this allowlist is a straightforward activation gate.
// Empty/unset allowlist -> false for everyone -- fail-closed, so this
// function existing at all does not monitor any organization until an
// operator deliberately sets QUEUE_MANAGED_ORGANIZATION_IDS.
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
// route, via MonitoringRetryError below) tells Queue's `retry` handler to
// reschedule redelivery after retryAfterSeconds.
// ============================================================================
export function decideQueueOutcome({ claim, coverage, deliveryCount = 1 }) {
  if (claim && claim.ok === false) {
    if (claim.reason === 'already-leased') {
      // Item 3 (changed from the earlier ack-everything behavior): another
      // worker actively owns this target's real completion RIGHT NOW.
      // Acking here would tell Queue "permanently done" for a delivery
      // this adapter deliberately did zero research work on -- wrong,
      // because database ownership (the lease), not this Queue message,
      // is what is actually authoritative. Retry instead, after a short
      // delay, so a later delivery re-checks with a fresh
      // claim_ha_monitoring_target call: if the original worker has since
      // succeeded, that later claim returns not-due (ack, below); if it
      // crashed, the lease has expired and the later claim reclaims and
      // processes normally. No duplicate provider spend occurs either way,
      // because this branch returns before any research call is made.
      return { action: 'retry', reason: 'already-leased', retryAfterSeconds: ALREADY_LEASED_RETRY_DELAY_SECONDS };
    }
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

// Lazily creates ONE QueueClient instance (per this file's own JSDoc-
// recommended pattern: `const queue = new QueueClient(); export const
// { send, handleCallback, handleNodeCallback } = queue;`) and reuses it for
// every enqueueMonitoringJob() call, rather than constructing a fresh
// client per publish. Deferred/dynamic import keeps every OTHER export in
// this file importable/testable in an environment (like this sandbox)
// where @vercel/queue is not installed. The constructor never throws (per
// the SDK's own documented contract), so there is no failure mode here to
// handle beyond the import itself.
let queueClientPromise;
async function getQueueClient() {
  if (!queueClientPromise) {
    queueClientPromise = import('@vercel/queue').then(({ QueueClient }) => new QueueClient());
  }
  return queueClientPromise;
}

// Publishes exactly one monitoring job for exactly one target. Written
// against @vercel/queue@0.4.0's actual QueueClient.send(topicName, payload,
// options) signature (idempotencyKey, retentionSeconds, delaySeconds,
// headers) -- confirmed directly from the installed package's type
// definitions, not assumed from docs.
export async function enqueueMonitoringJob(target) {
  const { send } = await getQueueClient();
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

// Thrown by the consumer route's handler when decideQueueOutcome() (via
// processMonitoringJob) returns { action: 'retry' }. @vercel/queue's
// handleCallback/handleNodeCallback contract is: the handler resolves
// normally to ack, or throws to trigger the `retry` option (a RetryHandler:
// `(error, metadata) => { afterSeconds: N } | { acknowledge: true } |
// undefined`) -- there is no "return a decision object" surface, so this
// error class is how a specific delay (e.g.
// ALREADY_LEASED_RETRY_DELAY_SECONDS) crosses from processMonitoringJob's
// decision into the retry handler that reads it back off the thrown error.
export class MonitoringRetryError extends Error {
  constructor(reason, retryAfterSeconds) {
    super(`monitoring job retry requested: ${reason}`);
    this.name = 'MonitoringRetryError';
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// The consumer body. Deliberately dependency-injected (claimTarget/
// completeAttempt/resolveAccountContext/runPipeline/persistSignals/
// peekTarget/acquireCapacity/releaseCapacity) rather than importing
// Supabase/research-pipeline calls directly, so it is testable with plain
// mocks (see scripts/test-monitoring-queue-adapter.js) without any real
// Queue, database, or provider call. api/queues/monitoring-consumer.js is
// the thin route file that supplies the real implementations and hands
// this function to @vercel/queue's handleNodeCallback().
//
// Phase 2C: the intended architecture is research -> validate/ground ->
// PERSIST -> downstream notification -- the pipeline's own validation
// (validateOpportunity()/verifyCandidateCompanyGrounding(), inside
// runPipeline itself) is unchanged, but a validated result.signals is no
// longer trustworthy just because runPipeline() returned it: it must
// actually land durably in ha_signals before this attempt is allowed to
// report success. persistSignals() (the real implementation calls the
// shared persistValidatedSignals() boundary in
// api/lib/signal-persistence.js -- the SAME function api/save-upload.js
// calls, not a second implementation) is only invoked for a coverage that
// would otherwise advance cadence (complete/degraded_trustworthy); an
// 'insufficient' result never had anything worth persisting and already
// never advances cadence regardless.
//
// If persistence throws, this attempt's outcome is deliberately downgraded
// to 'insufficient' before calling completeAttempt() -- reusing the
// EXISTING, already-proven "coverage=insufficient -> cadence does not
// advance, lease clears, retry up to the poison threshold" path
// (migration 16 / decideQueueOutcome()) rather than inventing a new
// completion state. result.error is set to a persistence-specific message
// (distinct from a genuine research failure) so ha_monitoring_attempts.error
// stays honest about what actually happened. A subsequent retry re-runs
// persistSignals() (via a full new pipeline run) against the SAME
// underlying real-world events, which resolve to the SAME event_fingerprint
// -- persistValidatedSignals()'s ignore-duplicates insert makes that retry
// safe by construction, never creating a duplicate row.
//
// Phase 2D acquisition order (the entire reason this function's shape
// changed): global capacity is acquired BEFORE the real target claim, and
// the real target claim happens ONLY once capacity is held. "Do not claim
// a target for five minutes and then sit waiting for global research
// capacity" -- claim_ha_monitoring_target() hands out a real 300s DB
// lease; holding that lease while blocked on a scarce, shared resource
// would needlessly keep the target unclaimable by any other worker for the
// whole wait, for zero reason (no research work is happening yet). The
// target claim remains the sole source of truth for duplicate-SAME-target
// spend prevention, unchanged; the capacity lease solves the separate
// problem of bounding TOTAL simultaneous provider work.
//
// Step 0 (peekTarget): a cheap, non-locking pre-check -- NOT the
// authoritative claim -- that lets an obviously-stale delivery (target
// already paused/removed, or genuinely not due yet) skip capacity
// contention entirely, so the global pool is never occupied by work that
// was never going to happen. A peekTarget() that returns null (unknown /
// no cheap data available) always falls through to the normal
// capacity-then-claim path -- this step can only ever SKIP work early on
// a confident negative, never invent a false positive; the real claim
// below remains the authoritative decision in every other case.
export async function processMonitoringJob(message, metadata, deps) {
  const {
    claimTarget, completeAttempt, resolveAccountContext, runPipeline, persistSignals, apiKey, model,
    peekTarget, acquireCapacity, releaseCapacity, maxWorkers, capacityLeaseSeconds
  } = deps;
  const targetId = message?.targetId;
  const deliveryCount = metadata?.deliveryCount || 1;

  if (!targetId) {
    // Malformed message: nothing to claim, never retryable.
    return { action: 'ack', reason: 'malformed-message-missing-target-id' };
  }

  const peek = await peekTarget(targetId);
  if (peek) {
    if (peek.status && peek.status !== 'active') {
      return { action: 'ack', reason: 'not-active' };
    }
    if (peek.next_due_at && new Date(peek.next_due_at).getTime() > Date.now()) {
      return { action: 'ack', reason: 'not-due' };
    }
  }

  const capacity = await acquireCapacity({ maxWorkers, leaseSeconds: capacityLeaseSeconds });
  if (!capacity.ok) {
    // Phase 2D item C: capacity exhaustion is normal backpressure, not a
    // poison-message failure -- deliberately retried unconditionally,
    // never checked against deliveryCount/POISON_DELIVERY_THRESHOLD (see
    // decideQueueOutcome()'s poison logic, which this branch never calls
    // into). Zero provider calls happened, no ha_monitoring_attempts row
    // is created, next_due_at is never touched -- this return is the ONLY
    // side effect.
    return { action: 'retry', reason: 'capacity-unavailable', retryAfterSeconds: CAPACITY_UNAVAILABLE_RETRY_DELAY_SECONDS };
  }

  try {
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
      // Target claim lost (already-leased) or the target turned out to be
      // not-due/not-active by the time the AUTHORITATIVE check ran (the
      // cheap peek above can miss this -- it is an optimization, not a
      // guarantee). Capacity is released via the finally below; the
      // existing per-reason Queue outcome is preserved unchanged.
      return decideQueueOutcome({ claim, deliveryCount });
    }

    const startedAt = Date.now();
    const { userId, accountContext } = await resolveAccountContext(targetId);
    const result = await runPipeline(accountContext, { apiKey, model, startedAt });

    let coverage = result.coverage;
    let error = result.error;
    let persistedSignalCount = 0;
    if (coverage === 'complete' || coverage === 'degraded_trustworthy') {
      try {
        const persisted = await persistSignals({ userId, signals: result.signals || [] });
        persistedSignalCount = (persisted?.newSignalRows || []).length;
      } catch (persistErr) {
        // Downgrade, do not swallow: a validated-but-unpersisted result is
        // not a trustworthy monitoring cycle. See this function's header
        // comment for why 'insufficient' (not a new state) is the correct
        // reuse here.
        coverage = 'insufficient';
        error = `signal persistence failed: ${persistErr.message}`;
      }
    }

    await completeAttempt({
      targetId,
      attemptId: claim.attemptId,
      coverage,
      cadenceDays: CADENCE_DAYS,
      error,
      telemetry: result.providerUsage
    });

    const decision = decideQueueOutcome({ coverage, deliveryCount });
    // Item J observability: correlates back to the enqueue log line via
    // targetId, and is the "monitoring attempt -> completion/failure" half of
    // the due-target -> published message -> Queue delivery -> attempt ->
    // completion chain this item asks to be reconcilable, without any new
    // dashboard. Deliberately counts/fingerprints only (Phase 2C
    // observability direction) -- full signal content (title, evidence,
    // source URL) is never logged here; the durable ha_signals row itself is
    // the auditable source for that.
    //
    // Naming correction (founder QA, live Test A reconciliation): this is
    // claim_ha_monitoring_target()'s lease/ownership token (migration 16),
    // used only for complete_ha_monitoring_attempt()'s compare-and-swap check
    // -- it is never written to, and has no relationship to,
    // ha_monitoring_attempts.id (that row's own primary key, minted
    // independently by its own gen_random_uuid() default). Logging it as
    // plain "attemptId" reads as if it correlates to the durable attempt row,
    // which it does not and structurally cannot without a separate change to
    // return that row's id from the RPC. Named for what it actually is.
    console.log('[monitoring-queue.completed]', JSON.stringify({
      targetId, leaseAttemptId: claim.attemptId, deliveryCount, coverage,
      signalCount: (result.signals || []).length, persistedSignalCount, elapsedMs: result.elapsedMs,
      estimatedCostUsd: result.providerUsage?.estimatedCostUsd, queueAction: decision.action, queueActionReason: decision.reason
    }));
    return decision;
  } finally {
    // Phase 2D: released unconditionally on every path out of this block
    // -- claim loss, normal completion, or an uncaught pipeline/persistence
    // exception -- exactly the "normal/error paths release in finally"
    // requirement. Never throws itself (see releaseMonitoringCapacity()'s
    // own contract), so it can never mask whatever this block was already
    // returning/throwing.
    await releaseCapacity({ leaseToken: capacity.leaseToken });
  }
}
