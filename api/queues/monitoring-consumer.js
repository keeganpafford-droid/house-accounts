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
  MonitoringRetryError,
  DEFAULT_MONITORING_MAX_CONCURRENT_WORKERS
} from '../lib/monitoring-queue.js';
// Phase 2D: the global capacity lease -- see api/lib/monitoring-capacity.js's
// own header comment for why this exists and how it differs from
// claim_ha_monitoring_target()/complete_ha_monitoring_attempt() above.
import { acquireMonitoringCapacity, releaseMonitoringCapacity, DEFAULT_CAPACITY_LEASE_SECONDS } from '../lib/monitoring-capacity.js';
// Phase 2C: the same shared persistence boundary api/weekly-scan.js calls
// -- not a second implementation. uploadId/weeklyRunId are null for every
// monitoring call (this path is not upload-driven).
import { persistValidatedSignals } from '../lib/signal-persistence.js';
// Monitoring Identity V1: resolves/persists the target's durable identity
// anchor from account-side evidence ONLY (never a research candidate --
// see resolveTargetIdentity()'s own circularity-guard comment), and brings
// this Queue path to parity with the interactive endpoint's existing
// contact-email-domain derivation.
import { resolveTargetIdentity } from '../lib/monitoring-identity.js';

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

// Resolves/persists the target's durable Monitoring Identity V1 anchor
// (see api/lib/monitoring-identity.js) from account-side evidence found on
// the CURRENT ha_accounts row -- the uploaded website and every contact's
// email domain. Deliberately called with ONLY account-side data, never
// anything from a research candidate -- resolveTargetIdentity()'s own
// circularity guard depends on that. A no-op (`null`) result means nothing
// changed and nothing is written -- most cycles, once a target is resolved
// or durably unresolved, touch nothing here.
async function resolveAndPersistTargetIdentity(target, accountRow) {
  const current = {
    status: target.identity_status || 'unresolved',
    domain: target.identity_domain || null,
    source: target.identity_domain_source || null
  };
  const uploadedWebsite = accountRow?.raw_data?.website || '';
  const contacts = Array.isArray(accountRow?.raw_data?.contacts) ? accountRow.raw_data.contacts : [];
  const next = resolveTargetIdentity({ current, uploadedWebsite, contacts });
  if (!next) return current;

  await supabase(`ha_monitoring_targets?id=eq.${encodeURIComponent(target.id)}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({
      identity_status: next.status,
      identity_domain: next.domain,
      identity_domain_source: next.source,
      identity_resolved_at: new Date().toISOString()
    })
  });
  return next;
}

// Resolves the CURRENT ha_accounts row for a target's durable identity
// (user_id + normalized_company_name) -- never a snapshot carried in the
// Queue message, so churn between enqueue and delivery (reupload, edit) is
// naturally absorbed (see Phase 1's identity-model rationale). Tries the
// exact display_account_name first (the common, fast case); falls back to
// scanning the user's accounts and normalizing if the account was renamed
// since the target was last synced. Returns userId alongside the bounded
// accountContext -- processMonitoringJob() needs the real user id for
// persistSignals(), but the projected accountContext itself stays exactly
// the bounded shape runPipeline()/the OpenAI prompt-builder already expect,
// never polluted with an extra raw id field.
//
// Monitoring Identity V1 parity: also resolves/persists the target's
// durable identity anchor (see resolveAndPersistTargetIdentity() above),
// and -- when one is on file -- projects it onto accountContext.website,
// matching the SAME contact-email-domain-derivation benefit
// api/research-batch.js's interactive safeAccounts construction already
// gives the weekly-scan path. Only ever overrides accountContext.website
// with a domain resolved from ACCOUNT-side evidence, never from a
// candidate discovered this cycle.
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

  const identity = await resolveAndPersistTargetIdentity(target, row);
  const accountContext = projectAccountContext(row);
  if (identity.domain) accountContext.website = identity.domain;
  return { userId: target.user_id, accountContext };
}

async function runPipeline(accountContext, options) {
  return runResearchPipeline(accountContext, { ...options, mode: 'weekly-monitoring' });
}

// Phase 2D: the cheap, non-locking pre-check processMonitoringJob() uses to
// skip global-capacity contention for an obviously-stale delivery, BEFORE
// the authoritative atomic claim runs. Deliberately just status/next_due_at
// -- never a lock, never mutates anything -- so a wrong/stale answer can
// only ever cause a redundant (still-correct) fall-through to the real
// claim, never a false short-circuit past it. A target that no longer
// exists at all resolves to null here (empty result), which
// processMonitoringJob() treats as "no cheap info, proceed normally" --
// the real claimTarget() call below remains the one that raises the
// authoritative not-found error.
async function peekTarget(targetId) {
  const [target] = await supabase(`ha_monitoring_targets?id=eq.${encodeURIComponent(targetId)}&select=status,next_due_at&limit=1`);
  return target || null;
}

async function acquireCapacity({ maxWorkers, leaseSeconds }) {
  return acquireMonitoringCapacity({ maxWorkers, leaseSeconds, supabase });
}

async function releaseCapacity({ leaseToken }) {
  return releaseMonitoringCapacity({ leaseToken, supabase });
}

// Real persistence implementation: calls the SAME shared boundary
// api/weekly-scan.js calls. uploadId/weeklyRunId are null -- this path is
// not upload-driven, and persistValidatedSignals() treats both as optional.
async function persistSignals({ userId, signals }) {
  return persistValidatedSignals({ userId, uploadId: null, weeklyRunId: null, signals, supabase });
}

async function consumeMonitoringMessage(message, metadata) {
  return processMonitoringJob(message, metadata, {
    claimTarget,
    completeAttempt,
    resolveAccountContext,
    runPipeline,
    persistSignals,
    peekTarget,
    acquireCapacity,
    releaseCapacity,
    // Phase 2D Beta safety default: 2 concurrent monitoring workers
    // globally. Env-configurable, never a migration/code change, per
    // MONITORING_MAX_CONCURRENT_WORKERS's own design intent.
    maxWorkers: Math.max(1, Number(process.env.MONITORING_MAX_CONCURRENT_WORKERS || DEFAULT_MONITORING_MAX_CONCURRENT_WORKERS)),
    capacityLeaseSeconds: DEFAULT_CAPACITY_LEASE_SECONDS,
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
