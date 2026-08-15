# Phase 2B: first live Queue smoke test — founder runbook

Status: branch prepared and deterministically tested, **not merged**, **no real Queue
message has been sent from this session**. This sandbox has no Vercel deployment
access and no live provider credentials, so everything below is written for the
founder/product to execute and review directly.

## 0. What this proves

One real `ha_monitoring_target` going all the way through:

Queue publish → consumer delivery → atomic DB claim → bounded account-context
resolution → real Serper/Firecrawl/OpenAI pipeline → coverage classification →
signal persistence (if applicable) → monitoring-attempt/provider telemetry →
completion RPC → cadence advancement (only on `complete`/`degraded_trustworthy`) →
Queue acknowledgment.

A legitimate `complete` result with **zero signals** is a pass — coverage is judged
on execution evidence (did the pipeline actually run and finish), never on whether
anything interesting was found.

## 1. Deploy

Deploy this branch (`monitoring/phase-2b-queue-dark-run`) as a **Vercel Preview**
with the existing required HA environment variables (Supabase, OpenAI, Serper,
Firecrawl, `CRON_SECRET`). No new environment variables are required for this
smoke test.

Do **not** set `QUEUE_MANAGED_ORGANIZATION_IDS` yet — leave it unset until step 3.

## 2. Deployment partitioning — read before publishing anything

Vercel Queues in push mode partitions topics **by deployment ID by default**: a
message published from a given deployment is delivered back to a consumer running
in *that same deployment*, not to production, and not to a different preview.
`QueueClient`'s `deploymentId` option auto-detects `VERCEL_DEPLOYMENT_ID` and pins
every `send()` call to it; this repo does not override that option anywhere, so the
default (correct) behavior applies automatically.

Practically: the one Queue message you publish in step 4 must be published **from
the same Preview deployment** whose consumer you want to observe (i.e., run the
publish step against that Preview's own environment/URL, not from your local
machine against a different deployment's Supabase). If you ever need a message
published from one deployment to reach a different one, that requires an explicit
`deploymentId` override — out of scope for this first smoke test, and not wired up.

## 3. Prepare exactly one target

1. Pick ONE existing founder-controlled `ha_monitoring_target` row (or create one
   via the normal product flow).
2. Set `QUEUE_MANAGED_ORGANIZATION_IDS` (Preview env var) to that target's
   `organization_id` only — no other organization.
3. Confirm no *other* target belonging to that same organization is currently due
   (`next_due_at <= now()`). If any are, either pause them or push their
   `next_due_at` into the future for the duration of the test. This matters because
   the publish step (step 4) enqueues **every** due, Queue-managed target it finds,
   and this first test is specifically for exactly one message.
4. Manually make your chosen target due: `UPDATE ha_monitoring_targets SET
   next_due_at = now() WHERE id = '<target-id>';` (via the Supabase SQL editor or
   equivalent).

## 4. Publish exactly one Queue message

No new debug endpoint was added for this. `api/monitoring-scheduler.js` already
does exactly what's needed and was already built, tested, and left deliberately
**unregistered** in `vercel.json`'s `crons` (general scheduling stays disabled) —
it is a manually-invokable, `CRON_SECRET`-gated endpoint, same auth convention as
`api/weekly-scan.js`. With exactly one target made due in one allowlisted
organization (step 3), one call publishes exactly one message:

```bash
curl -X POST "https://<your-preview-deployment>.vercel.app/api/monitoring-scheduler" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected response: `{"ok":true,"dueActiveCount":1,"queueManagedDueCount":1,"results":[{"targetId":"...","ok":true,"messageId":"...","idempotencyKey":"monitor:<targetId>:<next_due_at>"}]}`.

Record the `messageId` and `idempotencyKey` now — you'll need them for step 6.

Do **not** call this endpoint again for the same target while the test is in
flight; the idempotency key is deterministic per `(targetId, next_due_at)`, so a
repeat call before `next_due_at` advances is deduplicated by Queue itself, which is
expected but would confuse elapsed-time observation.

## 5. Let the consumer run

Nothing else to do here — `api/queues/monitoring-consumer.js` is wired to the
`monitoring-jobs` topic via `vercel.json`'s `queue/v2beta` `experimentalTriggers`
entry and Vercel invokes it automatically once the message is available
(`initialDelaySeconds: 0`, no delay configured on the send).

## 6. Inspect and record results

**Vercel:**
- Project → Observability → Queues: confirm the message, its `deliveryCount`
  (should be 1 for a clean run), and consumer invocation.
- Project → Observability → Functions/Logs: search for `[monitoring-queue.enqueued]`
  and `[monitoring-queue.completed]` — both are correlated by `targetId` and
  `messageId`/`idempotencyKey`, and the completed line includes `attemptId`,
  `coverage`, `signalCount`, `elapsedMs`, and `estimatedCostUsd` directly in the
  log line.

**Supabase (`ha_monitoring_targets` and `ha_monitoring_attempts`, filtered to the
target id from step 3):**
- `ha_monitoring_attempts`: the one new attempt row — `id` (attempt id), coverage
  classification, provider telemetry, `error` (should be null for a clean pass).
- `ha_monitoring_targets`: `last_scanned_at` updated to now; `next_due_at` advanced
  by 7 days **only if** coverage was `complete` or `degraded_trustworthy` — if
  coverage was `insufficient`, `next_due_at` must be unchanged (this is the
  cadence-only-advances-on-trustworthy-completion guarantee; check it explicitly).
- `ha_signals`: any newly persisted signals for the account, if the run found any.
  Zero rows here with a `complete` attempt is a legitimate pass, not a failure.

**Checklist to fill in and report back:**

| Field | Value |
|---|---|
| Message ID | |
| Delivery count | |
| Attempt ID | |
| Target ID | |
| Elapsed time (ms) | |
| Coverage classification | |
| Signal count | |
| Provider usage (OpenAI/Serper/Firecrawl calls) | |
| Estimated cost (USD) | |
| `last_scanned_at` (before → after) | |
| `next_due_at` (before → after) | |
| Any retry/redelivery observed | |

## 7. What is intentionally NOT enabled yet

- `api/monitoring-scheduler.js` stays **off the `crons` list** — no automatic
  production monitoring. It only ever runs when manually invoked, as in step 4.
- Effective concurrency for this first test is 1 (a single message, a single
  consumer invocation). The installed `@vercel/queue@0.4.0` SDK does not expose any
  concurrency-limiting option (checked the full type surface — no such field on
  `QueueClientOptions`, `handleCallback`/`handleNodeCallback` options, or the
  `vercel.json` `queue/v2beta` trigger schema). After a clean single-message
  lifecycle, moving to 2 concurrent founder-only messages just means preparing two
  due targets and publishing twice — there is no dial to turn. Broader concurrency
  control is a vendor-level question to resolve before any wider activation, not
  something to build a custom throttle for now; the DB claim/lease already prevents
  double-processing of any one target regardless of how many messages are in
  flight.
