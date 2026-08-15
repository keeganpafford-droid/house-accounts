// Phase 2B item L -- deterministic coverage for api/lib/monitoring-queue.js:
// message schema/idempotency-key construction, the ack-vs-retry decision
// table, the coherent timing relationship (item B), and processMonitoringJob
// with fully mocked dependencies (no real Queue, database, or provider
// call -- @vercel/queue is not installed in this sandbox, which is exactly
// why the adapter is designed to be testable without it; see
// api/lib/monitoring-queue.js's own header comment).
//
// Usage: node scripts/test-monitoring-queue-adapter.js
import {
  buildIdempotencyKey, buildEnqueuePayload, isQueueManagedOrganization,
  decideQueueOutcome, processMonitoringJob,
  WORKER_MAX_DURATION_SECONDS, DB_LEASE_SECONDS, QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  MESSAGE_RETENTION_SECONDS, POISON_DELIVERY_THRESHOLD, CADENCE_DAYS
} from '../api/lib/monitoring-queue.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}
async function assertRejects(promise, message) {
  try { await promise; failures += 1; console.error(`FAIL: ${message} (did not reject)`); }
  catch { console.log(`PASS: ${message}`); }
}

// ---------------------------------------------------------------------------
// Coherent failure-model timing relationship (item B) -- pinned as a real
// assertion, not just a comment, so a future edit cannot silently break the
// ordering the whole design depends on.
// ---------------------------------------------------------------------------
assert(WORKER_MAX_DURATION_SECONDS < DB_LEASE_SECONDS, `REQUIRED: worker maxDuration (${WORKER_MAX_DURATION_SECONDS}s) < DB lease (${DB_LEASE_SECONDS}s) -- a legitimately-finishing worker always clears its lease before the platform would kill it`);
assert(DB_LEASE_SECONDS < QUEUE_VISIBILITY_TIMEOUT_SECONDS, `REQUIRED: DB lease (${DB_LEASE_SECONDS}s) < Queue visibility timeout (${QUEUE_VISIBILITY_TIMEOUT_SECONDS}s) -- a crashed worker's DB lease expires before Queue would ever redeliver, so a redelivered attempt correctly reclaims rather than bouncing off a stale already-leased state`);
assert(MESSAGE_RETENTION_SECONDS < 24 * 60 * 60, `REQUIRED: message retention (${MESSAGE_RETENTION_SECONDS}s) is deliberately well under Queue's 24h maximum -- bounds how long a stuck target can go before a scheduler republish becomes fresh again`);
assert(POISON_DELIVERY_THRESHOLD > 1 && POISON_DELIVERY_THRESHOLD < 32, `REQUIRED: the poison threshold (${POISON_DELIVERY_THRESHOLD}) is small and deliberate, not Queue's own ~32-attempt honored-delay ceiling`);
assert(CADENCE_DAYS === 7, 'cadence is the locked weekly default');

// ---------------------------------------------------------------------------
// buildIdempotencyKey / buildEnqueuePayload -- one account per message.
// ---------------------------------------------------------------------------
{
  const target = { id: 'target-1', organization_id: 'org-1', next_due_at: '2026-08-20T00:00:00.000Z' };
  const key1 = buildIdempotencyKey(target);
  const key2 = buildIdempotencyKey(target);
  assert(key1 === key2, 'REQUIRED: the idempotency key is deterministic for the same target/next_due_at -- repeated scheduler runs produce the same key');
  const afterAdvance = buildIdempotencyKey({ ...target, next_due_at: '2026-08-27T00:00:00.000Z' });
  assert(afterAdvance !== key1, 'the idempotency key changes once next_due_at actually advances, so a genuinely new cycle is not deduped against the old one');

  const payload = buildEnqueuePayload(target);
  assert(payload.targetId === 'target-1' && payload.organizationId === 'org-1', 'the payload carries the target identity');
  assert(!Array.isArray(payload.targetId) && typeof payload.targetId === 'string', 'REQUIRED: the payload is a single target id, never an array/batch -- one account per message is structural');
}

// ---------------------------------------------------------------------------
// isQueueManagedOrganization.
// ---------------------------------------------------------------------------
{
  assert(isQueueManagedOrganization('org-1', '') === false, 'an empty allowlist manages no organization');
  assert(isQueueManagedOrganization('org-1', undefined) === false, 'an unset allowlist manages no organization (the default, no-op state)');
  assert(isQueueManagedOrganization('org-1', 'org-1') === true, 'an exact single-entry allowlist match is managed');
  assert(isQueueManagedOrganization('org-2', 'org-1,org-2,org-3') === true, 'a multi-entry allowlist match is managed');
  assert(isQueueManagedOrganization('org-4', 'org-1,org-2,org-3') === false, 'an organization not in the allowlist is not managed');
  assert(isQueueManagedOrganization(null, 'org-1') === false, 'a null/missing organizationId is never managed, even with a non-empty allowlist');
}

// ---------------------------------------------------------------------------
// decideQueueOutcome -- the full ack-vs-retry decision table.
// ---------------------------------------------------------------------------
{
  assert(decideQueueOutcome({ claim: { ok: false, reason: 'already-leased' } }).action === 'ack', 'REQUIRED: duplicate delivery onto an actively-leased target is a safe ack, not a retry -- the active worker owns real completion independent of this delivery');
  assert(decideQueueOutcome({ claim: { ok: false, reason: 'not-due' } }).action === 'ack', 'REQUIRED: a not-due target (already completed, or a scheduler race) is a safe ack');
  assert(decideQueueOutcome({ claim: { ok: false, reason: 'not-active' } }).action === 'ack', 'REQUIRED: a paused/removed target is a safe ack -- retrying can never make it active again');
  assert(decideQueueOutcome({ coverage: 'complete' }).action === 'ack', 'a successful complete coverage is acked');
  assert(decideQueueOutcome({ coverage: 'degraded_trustworthy' }).action === 'ack', 'a successful degraded_trustworthy coverage is acked');
  assert(decideQueueOutcome({ coverage: 'insufficient', deliveryCount: 1 }).action === 'retry', 'REQUIRED: insufficient coverage below the poison threshold is retried -- absorbs a transient provider hiccup');
  assert(decideQueueOutcome({ coverage: 'insufficient', deliveryCount: POISON_DELIVERY_THRESHOLD - 1 }).action === 'retry', `insufficient coverage one delivery below the poison threshold (${POISON_DELIVERY_THRESHOLD}) is still retried`);
  assert(decideQueueOutcome({ coverage: 'insufficient', deliveryCount: POISON_DELIVERY_THRESHOLD }).action === 'ack', `REQUIRED: insufficient coverage AT the poison threshold (${POISON_DELIVERY_THRESHOLD}) is acked, not retried forever -- there is no built-in DLQ, so this is the application-level stop`);
  assert(decideQueueOutcome({ coverage: 'something-unrecognized', deliveryCount: 1 }).action === 'retry', 'an unrecognized outcome shape fails closed toward a bounded retry, never a silent drop, below the poison threshold');
  assert(decideQueueOutcome({ coverage: 'something-unrecognized', deliveryCount: POISON_DELIVERY_THRESHOLD }).action === 'ack', 'an unrecognized outcome shape is still bounded by the same poison threshold');
}

// ---------------------------------------------------------------------------
// processMonitoringJob -- full dependency-injected flow.
// ---------------------------------------------------------------------------
function makeDeps(overrides = {}) {
  return {
    claimTarget: async () => ({ ok: true, outcome: 'claimed', attemptId: 'attempt-1' }),
    completeAttempt: async () => ({ ok: true }),
    resolveAccountContext: async () => ({ name: 'Test Co' }),
    runPipeline: async () => ({ coverage: 'complete', signals: [], providerUsage: { elapsedMs: 10 }, error: null }),
    apiKey: 'sk-test', model: 'gpt-4o-mini',
    ...overrides
  };
}

{
  // Malformed message: no target id -- zero calls to any dependency.
  let claimCalled = false, pipelineCalled = false;
  const deps = makeDeps({ claimTarget: async () => { claimCalled = true; return { ok: true }; }, runPipeline: async () => { pipelineCalled = true; return { coverage: 'complete', providerUsage: {} }; } });
  const decision = await processMonitoringJob({}, { deliveryCount: 1 }, deps);
  assert(decision.action === 'ack' && decision.reason === 'malformed-message-missing-target-id', `REQUIRED: a message with no targetId is acked as malformed, never retried forever (got ${JSON.stringify(decision)})`);
  assert(!claimCalled && !pipelineCalled, 'REQUIRED: zero dependency calls (including zero provider spend) for a malformed message');
}

{
  // Target does not exist -- claimTarget throws -- ack, no pipeline call.
  let pipelineCalled = false;
  const deps = makeDeps({
    claimTarget: async () => { throw new Error('claim_ha_monitoring_target: no monitoring target xyz exists'); },
    runPipeline: async () => { pipelineCalled = true; return { coverage: 'complete', providerUsage: {} }; }
  });
  const decision = await processMonitoringJob({ targetId: 'nonexistent' }, { deliveryCount: 1 }, deps);
  assert(decision.action === 'ack' && decision.reason === 'claim-failed-target-not-found', `REQUIRED: a nonexistent target is acked, not retried forever (got ${JSON.stringify(decision)})`);
  assert(!pipelineCalled, 'REQUIRED: zero provider spend for a nonexistent target');
}

{
  // Duplicate while actively leased -- ack, and REQUIRED: zero provider calls.
  let pipelineCalled = false;
  const deps = makeDeps({
    claimTarget: async () => ({ ok: false, reason: 'already-leased', lease_expires_at: '2026-01-01T00:00:00Z' }),
    runPipeline: async () => { pipelineCalled = true; return { coverage: 'complete', providerUsage: {} }; }
  });
  const decision = await processMonitoringJob({ targetId: 't1' }, { deliveryCount: 2 }, deps);
  assert(decision.action === 'ack' && decision.reason === 'already-leased', 'a duplicate delivery onto an actively-leased target is acked');
  assert(!pipelineCalled, 'REQUIRED: duplicate delivery triggers ZERO Serper/Firecrawl/OpenAI spend -- the DB claim gate runs strictly before any research call');
}

{
  // Paused target -- ack, zero provider calls.
  let pipelineCalled = false;
  const deps = makeDeps({ claimTarget: async () => ({ ok: false, reason: 'not-active', status: 'paused' }), runPipeline: async () => { pipelineCalled = true; return { coverage: 'complete', providerUsage: {} }; } });
  const decision = await processMonitoringJob({ targetId: 't1' }, {}, deps);
  assert(decision.action === 'ack' && decision.reason === 'not-active', 'a paused target no-ops safely');
  assert(!pipelineCalled, 'zero provider spend for a paused target');
}

{
  // Successful claim -> full flow -> correct dependency call sequence and arguments.
  const calls = [];
  const deps = makeDeps({
    claimTarget: async (id, lease) => { calls.push(['claim', id, lease]); return { ok: true, outcome: 'claimed', attemptId: 'attempt-42' }; },
    resolveAccountContext: async (id) => { calls.push(['resolve', id]); return { name: 'Real Co' }; },
    runPipeline: async (ctx) => { calls.push(['pipeline', ctx.name]); return { coverage: 'complete', signals: [{ accountName: 'Real Co' }], providerUsage: { elapsedMs: 500, openaiCalls: 1 }, error: null }; },
    completeAttempt: async (args) => { calls.push(['complete', args.targetId, args.attemptId, args.coverage, args.cadenceDays]); return { ok: true }; }
  });
  const decision = await processMonitoringJob({ targetId: 'target-real' }, { deliveryCount: 1 }, deps);
  assert(calls[0][0] === 'claim' && calls[0][1] === 'target-real' && calls[0][2] === DB_LEASE_SECONDS, 'claim is called first, with the target id and the coherent DB lease duration');
  assert(calls[1][0] === 'resolve' && calls[1][1] === 'target-real', 'account context is resolved for the same target, only after a successful claim');
  assert(calls[2][0] === 'pipeline' && calls[2][1] === 'Real Co', 'the research pipeline runs against the resolved account context, only after claim + resolve');
  assert(calls[3][0] === 'complete' && calls[3][1] === 'target-real' && calls[3][2] === 'attempt-42' && calls[3][3] === 'complete' && calls[3][4] === CADENCE_DAYS, `completion is called with the SAME attempt id the claim returned, the real coverage, and the locked cadence (got ${JSON.stringify(calls[3])})`);
  assert(decision.action === 'ack', 'a successful complete-coverage attempt is acked');
}

{
  // Insufficient coverage, low delivery count -> retry; completeAttempt still called (telemetry persisted even on failure).
  let completeArgs = null;
  const deps = makeDeps({
    runPipeline: async () => ({ coverage: 'insufficient', signals: [], providerUsage: { elapsedMs: 50 }, error: 'budget exhausted' }),
    completeAttempt: async (args) => { completeArgs = args; return { ok: true }; }
  });
  const decision = await processMonitoringJob({ targetId: 't1' }, { deliveryCount: 1 }, deps);
  assert(decision.action === 'retry', 'insufficient coverage below the poison threshold is retried');
  assert(completeArgs && completeArgs.coverage === 'insufficient' && completeArgs.error === 'budget exhausted', 'REQUIRED: attempt telemetry/error is persisted via completeAttempt even though the Queue outcome is retry -- a failed attempt is not invisible');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
