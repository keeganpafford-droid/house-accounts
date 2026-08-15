// Phase 2B: the Vercel Queue consumer route for monitoring jobs. Thin by
// design -- all Queue-specific wiring (handleNodeCallback,
// visibilityTimeoutSeconds, the retry handler) lives only here; all
// decision logic lives in api/lib/monitoring-queue.js's
// processMonitoringJob()/decideQueueOutcome(), which this file supplies
// real Supabase/pipeline implementations to.
//
// Verified against @vercel/queue 0.4.0's actual installed type
// definitions: handleNodeCallback is an arrow-function property of a
// QueueClient instance (`const queue = new QueueClient(); const {
// handleNodeCallback } = queue;`), not a bare module export. Its options
// are `{ visibilityTimeoutSeconds?: number, retry?: RetryHandler }`, where
// `visibilityTimeoutSeconds` defaults to 300 and maxes at 3600 (push mode
// uses the SAME bounds as polling mode, confirmed from the SDK's own
// JSDoc) and `retry: (error, metadata) => { afterSeconds } | {
// acknowledge } | undefined` is called whenever the handler throws.
// Still not executed against a real deployed Queue from this sandbox (no
// Vercel deployment access here) -- the first live smoke test is the
// actual proof.
//
// Route registration: per @vercel/queue's queue/v2beta convention, this
// route is wired to its topic via a `functions["api/queues/monitoring-
// consumer.js"].experimentalTriggers` entry in vercel.json, not via file
// location/naming alone -- see vercel.json and the smoke-test runbook.
import { runResearchPipeline } from '../lib/research-pipeline.js';
import { projectAccountContext, normalizeCompanyName } from '../lib/monitoring-targets.js';
import {
  processMonitoringJob,
  QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  MonitoringRetryError
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
// resolve-to-ack / throw-to-retry contract handleNodeCallback actually
// expects (there is no "return a decision object" surface on the SDK
// side): a normal resolve tells Queue this delivery is permanently done;
// throwing a MonitoringRetryError triggers the `retry` option below, which
// reads the specific delay (e.g. the deliberately short
// ALREADY_LEASED_RETRY_DELAY_SECONDS for an active-lease duplicate) back
// off the error and returns it as `{ afterSeconds }`. Any OTHER thrown
// error (a genuine unexpected crash, not a modeled decision) falls through
// to `retry` returning undefined, which lets Queue apply its own
// vercel.json-configured default redelivery behavior.
//
// Deferred (dynamic import) so this module stays importable/testable
// (scripts/test-monitoring-queue-adapter.js imports consumeMonitoringMessage
// directly) even in an environment where @vercel/queue is not installed.
let handlerPromise;
async function loadHandler() {
  if (!handlerPromise) {
    handlerPromise = import('@vercel/queue').then(({ QueueClient }) => {
      const queue = new QueueClient();
      return queue.handleNodeCallback(async (message, metadata) => {
        const decision = await consumeMonitoringMessage(message, metadata);
        if (decision.action === 'retry') throw new MonitoringRetryError(decision.reason, decision.retryAfterSeconds);
        // action === 'ack': resolve normally, Queue never redelivers this message.
      }, {
        visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
        retry: (error, metadata) => {
          if (error instanceof MonitoringRetryError && typeof error.retryAfterSeconds === 'number') {
            return { afterSeconds: error.retryAfterSeconds };
          }
          return undefined;
        }
      });
    });
  }
  return handlerPromise;
}

export default async function handler(req, res) {
  const wrapped = await loadHandler();
  return wrapped(req, res);
}
