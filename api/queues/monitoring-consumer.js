// Phase 2B: the Vercel Queue consumer route for monitoring jobs. Thin by
// design -- all Queue-specific wiring (handleNodeCallback,
// visibilityTimeoutSeconds) lives only here; all decision logic lives in
// api/lib/monitoring-queue.js's processMonitoringJob()/decideQueueOutcome(),
// which this file supplies real Supabase/pipeline implementations to.
//
// NOT executed against a real Vercel Queue from this session (no
// deployment access, no live provider credentials here) -- written against
// the currently documented @vercel/queue API surface. Verify
// handleNodeCallback's exact signature against your installed package
// version before the first real deploy; see the Phase 2B report.
//
// Route registration: Vercel Queues wires a consumer to a topic via this
// file's location/export per @vercel/queue's documented convention for a
// Node-style (req/res) Vercel Function -- confirm the exact required path/
// export shape against your installed package version and vercel.json
// queue configuration before deploying; this repo has no prior Queue
// consumer to copy the convention from.
import { runResearchPipeline } from '../lib/research-pipeline.js';
import { projectAccountContext, normalizeCompanyName } from '../lib/monitoring-targets.js';
import {
  processMonitoringJob,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS
} from '../lib/monitoring-queue.js';

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
    headers: {
      apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation', ...(options.headers || {})
    }
  });
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!resp.ok) {
    const msg = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data));
    const err = new Error(`Supabase ${resp.status}: ${msg}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

async function claimTarget(targetId, leaseSeconds) {
  const result = await supabase('rpc/claim_ha_monitoring_target', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ p_target_id: targetId, p_lease_seconds: leaseSeconds })
  });
  return result;
}

async function completeAttempt({ targetId, attemptId, coverage, cadenceDays, error, telemetry }) {
  return supabase('rpc/complete_ha_monitoring_attempt', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({
      p_target_id: targetId, p_attempt_id: attemptId, p_coverage: coverage,
      p_cadence_days: cadenceDays, p_error: error || null,
      p_telemetry: {
        elapsedMs: telemetry?.elapsedMs, openaiCalls: telemetry?.openaiCalls,
        openaiInputTokens: telemetry?.openaiInputTokens, openaiOutputTokens: telemetry?.openaiOutputTokens,
        serperQueries: telemetry?.serperQueries, serperFailedQueries: telemetry?.serperFailedQueries,
        firecrawlRequests: telemetry?.firecrawlRequests, firecrawlSuccesses: telemetry?.firecrawlSuccesses,
        estimatedCostUsd: telemetry?.estimatedCostUsd, costModelVersion: telemetry?.costModelVersion
      }
    })
  });
}

// Resolves the CURRENT ha_accounts row for a target's durable identity
// (user_id + normalized_company_name) -- never a snapshot carried in the
// Queue message, so churn between enqueue and delivery (reupload, edit) is
// naturally absorbed (see Phase 1's identity-model rationale). Tries the
// exact display_account_name first (the common, fast case); falls back to
// scanning the user's accounts and normalizing if the account was renamed
// since the target was last synced.
async function resolveAccountContext(targetId) {
  const [target] = await supabase(`ha_monitoring_targets?id=eq.${encodeURIComponent(targetId)}&select=*&limit=1`);
  if (!target) throw new Error(`resolveAccountContext: no monitoring target ${targetId} exists`);

  let [row] = await supabase(
    `ha_accounts?user_id=eq.${encodeURIComponent(target.user_id)}&account_name=eq.${encodeURIComponent(target.display_account_name)}&select=*&limit=1`
  );
  if (!row) {
    const candidates = await supabase(`ha_accounts?user_id=eq.${encodeURIComponent(target.user_id)}&select=*&limit=5000`);
    row = (candidates || []).find(a => normalizeCompanyName(a.account_name) === target.normalized_company_name);
  }
  if (!row) throw new Error(`resolveAccountContext: no current ha_accounts row found for target ${targetId} (identity may have been deleted)`);
  return projectAccountContext(row);
}

async function runPipeline(accountContext, options) {
  return runResearchPipeline(accountContext, { ...options, mode: 'weekly-monitoring' });
}

async function consumeMonitoringMessage(message, metadata) {
  return processMonitoringJob(message, metadata, {
    claimTarget,
    completeAttempt,
    resolveAccountContext,
    runPipeline,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  });
}

export { consumeMonitoringMessage, QUEUE_VISIBILITY_TIMEOUT_SECONDS };

// @vercel/queue route wiring -- resolves the ack/retry decision into the
// throw-to-retry / return-to-ack contract handleNodeCallback expects.
// Deferred (dynamic import) so this module stays importable/testable
// (scripts/test-monitoring-queue-adapter.js imports consumeMonitoringMessage
// directly) even in an environment where @vercel/queue is not installed.
let handlerPromise;
async function loadHandler() {
  if (!handlerPromise) {
    handlerPromise = import('@vercel/queue').then(({ handleNodeCallback }) =>
      handleNodeCallback(async (message, metadata) => {
        const decision = await consumeMonitoringMessage(message, metadata);
        if (decision.action === 'retry') throw new Error(`monitoring job retry requested: ${decision.reason}`);
        return decision;
      }, { visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS })
    );
  }
  return handlerPromise;
}

export default async function handler(req, res) {
  const wrapped = await loadHandler();
  return wrapped(req, res);
}
