// POST/GET /api/monitoring-scheduler
// Phase 2B founder Queue dark-run: the lightweight due-target scheduler.
// Deliberately NOT added to vercel.json's crons array in this phase --
// per item I, this stays a manually-invokable, CRON_SECRET-gated endpoint
// until the founder deliberately decides to automate it, exactly like
// api/weekly-scan.js's own auth convention (reused verbatim here, not
// reinvented).
//
// What this endpoint does, and does not do:
//   - Selects active, due, Queue-managed targets (organization_id in the
//     QUEUE_MANAGED_ORGANIZATION_IDS allowlist -- empty by default, so this
//     endpoint finds nothing and does nothing until that env var is set).
//   - Publishes exactly one Queue message per due target (item F: never a
//     batch).
//   - Does NOT advance next_due_at, last_scanned_at, or any other
//     scheduling field -- cadence only ever advances via
//     complete_ha_monitoring_attempt(), called by the consumer
//     (api/queues/monitoring-consumer.js) after real research concludes.
//     This endpoint's only side effect is publishing Queue messages.
//   - Is cheap and short by construction: one Supabase SELECT plus N
//     enqueueMonitoringJob() calls, no provider/research work at all.
//   - Is safe to run repeatedly: buildIdempotencyKey() is deterministic
//     per (targetId, next_due_at), so a target that is still due when this
//     endpoint runs again produces the SAME idempotency key and Vercel
//     Queue's own send-time deduplication collapses the repeat -- no
//     separate "have I already enqueued this" bookkeeping is needed here.
import { timingSafeEqual } from 'crypto';
import { enqueueMonitoringJob, isQueueManagedOrganization } from './lib/monitoring-queue.js';

function safeSecretEqual(provided, expected) {
  const providedBuf = Buffer.from(String(provided || ''), 'utf8');
  const expectedBuf = Buffer.from(String(expected || ''), 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function json(res, status, body) { res.setHeader('Cache-Control', 'no-store, max-age=0'); return res.status(status).json(body); }

function env() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return { url, key };
}

async function supabase(path, options = {}) {
  const { url, key } = env();
  const resp = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

// Pure selection logic, exported for deterministic testing without any
// Supabase call: given already-fetched active+due target rows and the
// allowlist env value, returns only the ones actually eligible to enqueue.
export function selectQueueManagedDueTargets(dueActiveTargets, allowlistEnvValue) {
  return (dueActiveTargets || []).filter(t => isQueueManagedOrganization(t.organization_id, allowlistEnvValue));
}

export const DEFAULT_MONITORING_SCHEDULER_PUBLISH_LIMIT = 10;

// Phase 2D item E: deterministic due-ordering + publish-cap application,
// pure and exported for testing without any Supabase/Queue call. Sorts
// oldest-due-first (the fairest prioritization -- whichever target has
// been waiting longest gets published first), with a stable id tie-break
// so two targets that happen to share an exact next_due_at still produce
// the identical split on every call against the same input. Publishing
// fewer than every eligible target on one invocation is intentional
// backpressure, not a bug: a large due backlog should not cause hundreds
// of Vercel consumer invocations to all wake up merely to discover the
// global capacity pool (see api/lib/monitoring-capacity.js) is already
// occupied -- deferred targets are simply left due (this endpoint never
// writes next_due_at either way, see this file's own header comment) and
// are picked up by a later scheduler invocation, with the SAME
// idempotency key since next_due_at has not changed.
export function selectTargetsToPublish(eligibleDueTargets, publishLimit) {
  const ordered = [...(eligibleDueTargets || [])].sort((a, b) => {
    const dueA = new Date(a.next_due_at || 0).getTime();
    const dueB = new Date(b.next_due_at || 0).getTime();
    if (dueA !== dueB) return dueA - dueB;
    return String(a.id).localeCompare(String(b.id));
  });
  const limit = Math.max(1, Number(publishLimit) || DEFAULT_MONITORING_SCHEDULER_PUBLISH_LIMIT);
  return { toPublish: ordered.slice(0, limit), deferred: ordered.slice(limit) };
}

export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return json(res, 503, { error: 'Service unavailable: not configured.' });
    const authHeader = req.headers.authorization || '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    const providedSecret = bearerMatch ? bearerMatch[1] : '';
    if (!providedSecret || !safeSecretEqual(providedSecret, cronSecret)) return json(res, 401, { error: 'Unauthorized' });

    const allowlist = process.env.QUEUE_MANAGED_ORGANIZATION_IDS || '';
    if (!allowlist.trim()) return json(res, 200, { ok: true, enqueued: 0, reason: 'QUEUE_MANAGED_ORGANIZATION_IDS is empty -- no organization is Queue-managed yet.' });

    // order=next_due_at.asc,id.asc mirrors selectTargetsToPublish()'s own
    // deterministic sort -- a defense-in-depth/performance nicety so the
    // 500-row cap itself already grabs the oldest-due rows first if a
    // backlog ever exceeds it, but the CORRECTNESS-critical determinism
    // guarantee lives in the pure, independently-testable JS sort below,
    // not in trusting the DB's row order.
    //
    // research-failure cooldown (migration 20): the OR filter excludes any
    // target whose most recent attempt concluded 'insufficient' within the
    // last ~24h (research_retry_cooldown_until, set by
    // complete_ha_monitoring_attempt()) -- without this, a chronically-
    // failing target's next_due_at never advances, so it stays "due"
    // forever and this scheduler (now running every 5 minutes) would keep
    // re-publishing it once Vercel Queue's own idempotency-key
    // deduplication window lapses, re-triggering real paid research on a
    // loop. This predicate is the ONLY place the cooldown is consulted --
    // claim_ha_monitoring_target() and the Queue consumer's peekTarget()
    // deliberately never check it, so an already-in-flight message's own
    // Queue-level retry lifecycle is completely unaffected. A target with
    // no cooldown set (research_retry_cooldown_until is null -- the common
    // case: never failed, or already cleared by a later success) is always
    // eligible, same as before this migration.
    const nowIso = new Date().toISOString();
    const dueActive = await supabase(`ha_monitoring_targets?status=eq.active&next_due_at=lte.${encodeURIComponent(nowIso)}&or=(research_retry_cooldown_until.is.null,research_retry_cooldown_until.lte.${encodeURIComponent(nowIso)})&select=id,organization_id,next_due_at&order=next_due_at.asc,id.asc&limit=500`);
    const eligible = selectQueueManagedDueTargets(dueActive, allowlist);
    const publishLimit = Math.max(1, Number(process.env.MONITORING_SCHEDULER_PUBLISH_LIMIT || DEFAULT_MONITORING_SCHEDULER_PUBLISH_LIMIT));
    const { toPublish, deferred } = selectTargetsToPublish(eligible, publishLimit);

    const results = [];
    for (const target of toPublish) {
      try {
        const { messageId, idempotencyKey } = await enqueueMonitoringJob(target);
        results.push({ targetId: target.id, ok: true, messageId, idempotencyKey });
      } catch (err) {
        // Isolated per-target -- one publish failure never blocks the rest
        // of this cheap sweep, same isolation doctrine as every other
        // per-item loop in this codebase.
        results.push({ targetId: target.id, ok: false, error: err.message });
      }
    }

    const publishedCount = results.filter(r => r.ok).length;
    console.log('[monitoring-scheduler.published]', JSON.stringify({
      dueActiveCount: dueActive.length, queueManagedDueCount: eligible.length,
      publishLimit, publishedCount, deferredByPublishCapCount: deferred.length
    }));

    return json(res, 200, {
      ok: true,
      dueActiveCount: dueActive.length,
      queueManagedDueCount: eligible.length,
      publishLimit,
      publishedCount,
      deferredByPublishCapCount: deferred.length,
      results
    });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Monitoring scheduler failed' });
  }
}
