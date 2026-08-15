// Phase 1 monitoring-architecture foundation: the first, deliberately
// narrow slice of api/research-batch.js's core pipeline pulled into a
// shared, request/response-free module so a future background Queue
// worker can reuse it in-process -- no HTTP self-call into
// /api/research-batch, no nested-timeout stacking on top of that
// endpoint's own ~58s platform ceiling.
//
// SCOPE OF THIS EXTRACTION, AND WHY IT IS NARROW:
//
// api/research-batch.js's handler() was read in full while planning this
// work. The "discovery -> prompt construction -> OpenAI synthesis" front
// half is genuinely separable: discoverCandidatesForAccounts(),
// accountPromptContext(), pairedPurchases(), and callOpenAIJson() are
// already standalone functions with no request/response coupling at all
// -- they are now exported directly from api/research-batch.js (see that
// file) so a future worker can import them without an HTTP hop. Moving
// them into a second file would only relocate text, not reduce risk or
// change behavior, and this module intentionally does not re-export them
// from here to avoid a circular import between the two files (research-
// batch.js needs runBudgetedSynthesis from THIS module; this module has
// no need to import anything back from research-batch.js).
//
// The one piece that genuinely needed to change, not just move, is the
// budget-gated synthesis call: runBudgetedSynthesis() below is the exact
// same deadline-check-then-call decision that was previously inline in
// api/research-batch.js's handler() (reading REQUEST_DEADLINE_MS /
// MIN_USEFUL_OPENAI_MS / OPENAI_CALL_MAX_MS as hardcoded module
// constants), now with budget as an explicit parameter. The interactive
// handler passes those exact same constants explicitly, so its own
// behavior is provably unchanged (see scripts/test-research-pipeline-
// extraction.js); a future worker can pass its own, independently larger
// budget instead.
//
// PHASE 2A UPDATE: the remaining tail this file's Phase 1 version left
// in place -- parsing the model's raw response, per-signal account-name
// resolution, makeSignal()/normalizeOpportunity()/validateOpportunity()/
// verifyCandidateCompanyGrounding(), and resolveOpportunityEvents() -- is
// now extracted too, as api/research-batch.js's mapSignalsFromModelOutput()
// (same file, same reasoning as buildSynthesisPrompt() below: it depends on
// module-scope helpers not worth duplicating or moving). It was extracted
// only after scripts/test-weekly-monitoring-characterization.js pinned its
// externally observable behavior across 6 scenarios (30 assertions) run
// against the pre-extraction inline code, then re-run unchanged against the
// extracted function -- proving equivalence rather than assuming it. See
// the Phase 2A report for the full before/after evidence.
//
// runResearchPipeline() below is the complete single-account boundary this
// file exists for: discovery -> Firecrawl enrichment -> identity bootstrap
// -> prompt construction -> budgeted synthesis -> parse/map/validate/
// grounding/event-resolution -> a structured, worker-usable result
// (coverage classification, signals, provider usage, elapsed time, error
// info). It composes exported functions from api/research-batch.js
// (discoverCandidatesForAccounts, enrichCandidatesWithFirecrawl,
// buildDerivedIdentity, buildSynthesisPrompt, callOpenAIJson,
// parseJsonLoose, mapSignalsFromModelOutput) with runBudgetedSynthesis()
// and classifyResearchCoverage() defined in this file -- the interactive
// handler in api/research-batch.js calls the SAME underlying functions
// directly (not through runResearchPipeline(), which is worker-shaped:
// single account, no interactive-only auth/run-control/duplicate-check
// concerns), so there is exactly one implementation of every piece of
// actual research logic, never two.
export async function runBudgetedSynthesis({
  prompt,
  apiKey,
  model,
  startedAt,
  requestDeadlineMs,
  minUsefulOpenAiMs,
  openAiCallMaxMs,
  callOpenAIJson
}) {
  const remainingMs = requestDeadlineMs - (Date.now() - startedAt);
  if (remainingMs < minUsefulOpenAiMs) {
    throw new Error(`Research incomplete: only ${Math.max(0, Math.round(remainingMs))}ms of budget remained before signal synthesis -- not enough to run reliably. Please try again.`);
  }
  return callOpenAIJson({ apiKey, model, prompt, timeoutMs: Math.min(remainingMs, openAiCallMaxMs) });
}

import {
  discoverCandidatesForAccounts, enrichCandidatesWithFirecrawl, buildDerivedIdentity,
  buildSynthesisPrompt, callOpenAIJson, parseJsonLoose, mapSignalsFromModelOutput,
  REQUEST_DEADLINE_MS, MIN_USEFUL_OPENAI_MS, OPENAI_CALL_MAX_MS
} from '../research-batch.js';

// ---------------------------------------------------------------------------
// Phase 2A item C: deterministic research-coverage classification.
//
// Required doctrine: "OpenAI synthesis happened" is NOT sufficient for
// 'complete' -- a synthesis call can theoretically run after inadequate
// upstream evidence (e.g. no search provider configured at all, so there
// was never any real discovery capability). Classification is based purely
// on EXECUTION EVIDENCE (was a search provider configured, did discovery
// find candidates, did synthesis actually run and succeed, did an optional
// enrichment step degrade) -- never on the model's own stated confidence
// score, which is not trustworthy evidence that real research occurred.
//
//   'complete': a search provider was configured AND (candidates were
//     found and successfully evaluated by synthesis) OR (a real search ran
//     and genuinely found nothing -- a confirmed zero-result scan is
//     trustworthy, not a failure). Cadence may advance.
//   'degraded_trustworthy': the same as 'complete', except an optional
//     enrichment step (Firecrawl) was attempted and partially/fully failed
//     -- synthesis still ran on whatever evidence remained (snippet-only
//     candidates), which is a real, if lower-quality, evaluation. Cadence
//     may advance; the degradation is persisted as diagnostic evidence
//     (see runResearchPipeline()'s providerUsage return).
//   'insufficient': no search provider was configured at all (no real
//     discovery capability existed), or candidates existed but synthesis
//     never actually ran/succeeded (budget exhausted, provider failure).
//     Cadence must NOT advance.
export function classifyResearchCoverage({
  serperConfigured,
  candidatesFound,
  synthesisAttempted,
  synthesisSucceeded,
  firecrawlAttempted = 0,
  firecrawlSucceeded = 0
}) {
  if (!serperConfigured) return 'insufficient';
  if (candidatesFound > 0 && (!synthesisAttempted || !synthesisSucceeded)) return 'insufficient';
  if (candidatesFound === 0) return 'complete';
  if (firecrawlAttempted > 0 && firecrawlSucceeded < firecrawlAttempted) return 'degraded_trustworthy';
  return 'complete';
}

// Phase 2A item G: static, versioned per-unit provider rates -- the
// smallest useful cost telemetry this phase commits to. Deliberately not a
// finance/billing subsystem: these are directional estimates from measured
// per-attempt cost (~$0.01645/attempt per the CFO's own figures), not a
// claim of exact provider-invoice accuracy. cost_model_version is
// persisted alongside every estimate specifically so a later, more
// accurate model doesn't silently reinterpret historical rows -- see
// supabase-schema-migration-15's ha_monitoring_attempts.cost_model_version
// column comment.
export const COST_MODEL_VERSION = '2026-08-v1';
const ESTIMATED_RATES_USD = {
  openaiInputTokenRate: 0.15 / 1_000_000,
  openaiOutputTokenRate: 0.60 / 1_000_000,
  serperQueryRate: 0.001,
  firecrawlScrapeRate: 0.002
};
export function estimateAttemptCostUsd(usage = {}) {
  const openaiCost = (Number(usage.openaiInputTokens || 0) * ESTIMATED_RATES_USD.openaiInputTokenRate)
    + (Number(usage.openaiOutputTokens || 0) * ESTIMATED_RATES_USD.openaiOutputTokenRate);
  const serperCost = Number(usage.serperQueries || 0) * ESTIMATED_RATES_USD.serperQueryRate;
  const firecrawlCost = Number(usage.firecrawlSuccesses || 0) * ESTIMATED_RATES_USD.firecrawlScrapeRate;
  return Math.round((openaiCost + serperCost + firecrawlCost) * 100000) / 100000;
}

// ---------------------------------------------------------------------------
// Phase 2A item B: the complete, worker-usable single-account pipeline.
//
// accountContext: a single account's BOUNDED context shape, as produced by
// api/lib/monitoring-targets.js's projectAccountContext() (item D) -- never
// the full raw_data blob. This function does not fetch anything itself; the
// caller (a future worker) resolves accountContext before calling this.
//
// options: { apiKey, model, startedAt, requestDeadlineMs, minUsefulOpenAiMs,
//   openAiCallMaxMs, mode, runId } -- budget fields default to the SAME
// constants the interactive endpoint uses today (REQUEST_DEADLINE_MS etc.),
// so calling this with no budget overrides reproduces today's interactive
// timing exactly; a worker passes its own larger values.
//
// Returns a structured result a worker can act on without re-deriving
// anything: { coverage, signals, rawSignalCount, providerUsage, elapsedMs,
// error }. providerUsage is already shaped for
// complete_ha_monitoring_attempt()'s p_telemetry parameter (migration 16).
export async function runResearchPipeline(accountContext, options = {}) {
  const startedAt = options.startedAt ?? Date.now();
  const mode = options.mode || 'weekly-monitoring';
  const runId = options.runId || `worker-${startedAt}`;
  const apiKey = options.apiKey;
  const model = options.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const requestDeadlineMs = options.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
  const minUsefulOpenAiMs = options.minUsefulOpenAiMs ?? MIN_USEFUL_OPENAI_MS;
  const openAiCallMaxMs = options.openAiCallMaxMs ?? OPENAI_CALL_MAX_MS;
  const safeAccounts = [{ id: '0', ...accountContext }];

  const serperConfigured = !!process.env.SERPER_API_KEY;
  const openaiUsage = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let firecrawlAttempted = 0;
  let firecrawlScraped = 0;
  let serperQueries = 0;
  let serperFailedQueries = 0;

  function buildProviderUsage() {
    const usage = {
      elapsedMs: Date.now() - startedAt,
      openaiCalls: openaiUsage.calls,
      openaiInputTokens: openaiUsage.inputTokens,
      openaiOutputTokens: openaiUsage.outputTokens,
      serperQueries,
      serperFailedQueries,
      firecrawlRequests: firecrawlAttempted,
      firecrawlSuccesses: firecrawlScraped,
      costModelVersion: COST_MODEL_VERSION
    };
    usage.estimatedCostUsd = estimateAttemptCostUsd(usage);
    return usage;
  }

  try {
    let candidates = [];
    let derivedIdentityByAccount = new Map();
    if (serperConfigured) {
      const discovered = await discoverCandidatesForAccounts(safeAccounts, mode);
      candidates = discovered.candidates || [];
      serperQueries = (discovered.diagnostics || []).reduce((sum, d) => sum + (d.targetedQueriesRun || 0), 0);
      serperFailedQueries = (discovered.diagnostics || []).reduce((sum, d) => sum + (Array.isArray(d.queries) ? d.queries.filter(q => q.error).length : 0), 0);
      if (candidates.length && process.env.FIRECRAWL_API_KEY) {
        const enriched = await enrichCandidatesWithFirecrawl(candidates);
        candidates = enriched.candidates;
        firecrawlAttempted = enriched.attemptedCount || 0;
        firecrawlScraped = enriched.scrapedCount || 0;
      }
      derivedIdentityByAccount = new Map(safeAccounts.map(a => [a.name, buildDerivedIdentity(a, candidates.filter(c => c && c.accountName === a.name))]));
    }

    let synthesisAttempted = false;
    let synthesisSucceeded = false;
    let parsed = { signals: [] };
    if (candidates.length) {
      synthesisAttempted = true;
      const prompt = buildSynthesisPrompt(safeAccounts, candidates);
      const result = await runBudgetedSynthesis({
        prompt, apiKey, model, startedAt, requestDeadlineMs, minUsefulOpenAiMs, openAiCallMaxMs, callOpenAIJson
      });
      openaiUsage.calls += 1;
      openaiUsage.inputTokens += result.usage.inputTokens;
      openaiUsage.outputTokens += result.usage.outputTokens;
      openaiUsage.totalTokens += result.usage.totalTokens;
      parsed = parseJsonLoose(result.text) || { signals: [] };
      synthesisSucceeded = true;
    }

    const { signals, rawSignals } = mapSignalsFromModelOutput({
      parsed, mode, startedAt, providerMode: serperConfigured ? 'targeted-search' : 'no-search-provider',
      candidates, safeAccounts, derivedIdentityByAccount, runId
    });

    const coverage = classifyResearchCoverage({
      serperConfigured,
      candidatesFound: candidates.length,
      synthesisAttempted,
      synthesisSucceeded,
      firecrawlAttempted,
      firecrawlSucceeded: firecrawlScraped
    });

    return {
      coverage,
      signals,
      rawSignalCount: rawSignals.length,
      providerUsage: buildProviderUsage(),
      elapsedMs: Date.now() - startedAt,
      error: null
    };
  } catch (err) {
    // A thrown error (insufficient budget, an OpenAI/provider failure) is
    // always 'insufficient' -- the pipeline did not reach a trustworthy
    // conclusion, so cadence must not advance (see migration 16's
    // complete_ha_monitoring_attempt()). providerUsage still reflects
    // whatever partial usage was accumulated before the failure, so a
    // failed attempt is not invisible to cost/retry-overhead telemetry.
    return {
      coverage: 'insufficient',
      signals: [],
      rawSignalCount: 0,
      providerUsage: buildProviderUsage(),
      elapsedMs: Date.now() - startedAt,
      error: err.message || 'Research pipeline failed'
    };
  }
}
