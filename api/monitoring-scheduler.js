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

    const dueActive = await supabase(`ha_monitoring_targets?status=eq.active&next_due_at=lte.${encodeURIComponent(new Date().toISOString())}&select=id,organization_id,next_due_at&limit=500`);
    const eligible = selectQueueManagedDueTargets(dueActive, allowlist);

    const results = [];
    for (const target of eligible) {
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

    return json(res, 200, { ok: true, dueActiveCount: dueActive.length, queueManagedDueCount: eligible.length, results });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Monitoring scheduler failed' });
  }
}
