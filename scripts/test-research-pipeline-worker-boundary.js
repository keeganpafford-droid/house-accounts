// Phase 2A items B/C/G -- proves runResearchPipeline() (api/lib/research-
// pipeline.js) is a genuine in-process, worker-usable boundary: no HTTP
// self-call into /api/research-batch, deterministic coverage
// classification driven by execution evidence (not model confidence), and
// a telemetry shape ready for complete_ha_monitoring_attempt() (migration
// 16). Same fetch-mocking convention as scripts/test-weekly-monitoring-
// characterization.js, but drives runResearchPipeline() directly instead
// of the HTTP handler.
//
// Usage: node scripts/test-research-pipeline-worker-boundary.js
import { runResearchPipeline, classifyResearchCoverage, estimateAttemptCostUsd, COST_MODEL_VERSION } from '../api/lib/research-pipeline.js';
import { projectAccountContext } from '../api/lib/monitoring-targets.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function setBaseEnv({ serper = true, firecrawl = false } = {}) {
  process.env.OPENAI_API_KEY = 'sk-test-do-not-log-1234567890';
  if (serper) process.env.SERPER_API_KEY = 'fake-serper-key'; else delete process.env.SERPER_API_KEY;
  if (firecrawl) process.env.FIRECRAWL_API_KEY = 'fake-firecrawl-key'; else delete process.env.FIRECRAWL_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
}

async function withMockedFetch(fetchImpl, fn) {
  const realFetch = global.fetch;
  const calledUrls = [];
  global.fetch = async (url, ...rest) => { calledUrls.push(String(url)); return fetchImpl(url, ...rest); };
  try { return { result: await fn(), calledUrls }; } finally { global.fetch = realFetch; }
}

const BASIC_ACCOUNT = projectAccountContext({ account_name: 'Pipeline Test Co', raw_data: {} });

// ---------------------------------------------------------------------------
// No HTTP self-call: every fetch this pipeline makes goes to a real
// provider domain (serper/openai/firecrawl) -- never to this app's own
// /api/research-batch endpoint or any relative/localhost path, proving a
// worker calling runResearchPipeline() never re-enters the HTTP layer.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const candidateUrl = 'https://news.example.com/pipeline-test-co-event';
  const { result, calledUrls } = await withMockedFetch(async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) return { ok: true, status: 200, json: async () => ({ organic: [{ title: 'Event', snippet: 'Pipeline Test Co held an event.', link: candidateUrl, date: '2026-01-01' }] }) };
    if (u.includes('api.openai.com')) return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: [] }), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }) };
    throw new Error(`unexpected fetch: ${u}`);
  }, () => runResearchPipeline(BASIC_ACCOUNT, { apiKey: 'sk-test', startedAt: Date.now() }));

  assert(result.error === null, `runResearchPipeline completes without error${result.error ? `: ${result.error}` : ''}`);
  assert(calledUrls.every(u => !u.includes('/api/research-batch') && !u.startsWith('/') && !u.includes('localhost')), `REQUIRED: no call was made back into /api/research-batch or any local/relative path -- true in-process reuse, no HTTP self-call (calls: ${JSON.stringify(calledUrls)})`);
  assert(calledUrls.some(u => u.includes('google.serper.dev')), 'a real provider call (Serper) did happen');
  assert(calledUrls.some(u => u.includes('api.openai.com')), 'a real provider call (OpenAI) did happen');
}

// ---------------------------------------------------------------------------
// Legitimate zero-result scan classifies as 'complete', cadence may advance.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const { result } = await withMockedFetch(async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) return { ok: true, status: 200, json: async () => ({ organic: [{ title: 'Routine filing', snippet: 'Quiet Co filed a routine report.', link: 'https://news.example.com/quiet', date: '2026-01-01' }] }) };
    if (u.includes('api.openai.com')) return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: [] }), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }) };
    throw new Error(`unexpected fetch: ${u}`);
  }, () => runResearchPipeline(projectAccountContext({ account_name: 'Quiet Co', raw_data: {} }), { apiKey: 'sk-test', startedAt: Date.now() }));
  assert(result.coverage === 'complete', `REQUIRED: a confirmed zero-result scan classifies as 'complete' (got ${result.coverage})`);
  assert(Array.isArray(result.signals) && result.signals.length === 0, 'zero legitimate signals returned');
}

// ---------------------------------------------------------------------------
// Real signal produced classifies as 'complete'.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const candidateUrl = 'https://news.example.com/growth-co-facility';
  const { result } = await withMockedFetch(async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) return { ok: true, status: 200, json: async () => ({ organic: [{ title: 'New facility', snippet: 'Growth Co opened a new facility, ribbon cutting 2026.', link: candidateUrl, date: '2026-01-01' }] }) };
    if (u.includes('api.openai.com')) return {
      ok: true, status: 200, json: async () => ({
        output_text: JSON.stringify({ signals: [{ accountName: 'Growth Co', signal_type: 'Growth / Expansion', concrete_trigger: 'New facility ribbon cutting', business_context: 'Growth Co opened a new facility.', sourceUrl: candidateUrl, confidence: 88 }] }),
        usage: { input_tokens: 800, output_tokens: 120, total_tokens: 920 }
      })
    };
    throw new Error(`unexpected fetch: ${u}`);
  }, () => runResearchPipeline(projectAccountContext({ account_name: 'Growth Co', raw_data: {} }), { apiKey: 'sk-test', startedAt: Date.now() }));
  assert(result.coverage === 'complete', `REQUIRED: a real signal classifies as 'complete' (got ${result.coverage})`);
  assert(result.signals.length === 1 && result.signals[0].accountName === 'Growth Co', 'the real signal is returned, correctly attributed');
}

// ---------------------------------------------------------------------------
// No search provider configured at all -> 'insufficient', regardless of
// whether OpenAI would have been reachable. This is the specific case the
// "synthesis happened is not sufficient for success" doctrine guards.
// ---------------------------------------------------------------------------
{
  setBaseEnv({ serper: false });
  const { result, calledUrls } = await withMockedFetch(async (url) => {
    throw new Error(`unexpected fetch (no provider configured, nothing should be called): ${url}`);
  }, () => runResearchPipeline(BASIC_ACCOUNT, { apiKey: 'sk-test', startedAt: Date.now() }));
  assert(result.coverage === 'insufficient', `REQUIRED: no search provider configured classifies as 'insufficient' (got ${result.coverage})`);
  assert(calledUrls.length === 0, 'zero provider calls are made when there is no discovery capability at all');
}

// ---------------------------------------------------------------------------
// Budget exhausted before synthesis -> 'insufficient', signals empty.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const { result } = await withMockedFetch(async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) return { ok: true, status: 200, json: async () => ({ organic: [{ title: 'Budget Co opens new facility', snippet: 'Budget Co held a ribbon cutting for a new facility expansion, announced 2026.', link: 'https://news.example.com/budget-co-facility', date: '2026-01-01' }] }) };
    throw new Error(`unexpected fetch (OpenAI must not be reached with zero budget): ${u}`);
  }, () => runResearchPipeline(projectAccountContext({ account_name: 'Budget Co', raw_data: {} }), { apiKey: 'sk-test', startedAt: Date.now() - 100000, requestDeadlineMs: 50000, minUsefulOpenAiMs: 15000, openAiCallMaxMs: 45000 }));
  assert(result.coverage === 'insufficient', `REQUIRED: budget exhausted before synthesis classifies as 'insufficient' (got ${result.coverage})`);
  assert(result.error && /budget/i.test(result.error), `REQUIRED: the error explains the budget failure (got ${result.error})`);
  assert(result.signals.length === 0, 'no signals on an insufficient attempt');
}

// ---------------------------------------------------------------------------
// OpenAI provider failure -> 'insufficient', not a silent empty success.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const { result } = await withMockedFetch(async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) return { ok: true, status: 200, json: async () => ({ organic: [{ title: 'Outage Co opens new facility', snippet: 'Outage Co held a ribbon cutting for a new facility expansion, announced 2026.', link: 'https://news.example.com/outage-co-facility', date: '2026-01-01' }] }) };
    if (u.includes('api.openai.com')) return { ok: false, status: 503, json: async () => ({ error: { message: 'overloaded' } }) };
    throw new Error(`unexpected fetch: ${u}`);
  }, () => runResearchPipeline(projectAccountContext({ account_name: 'Outage Co', raw_data: {} }), { apiKey: 'sk-test', startedAt: Date.now() }));
  assert(result.coverage === 'insufficient', `REQUIRED: an OpenAI provider failure classifies as 'insufficient' (got ${result.coverage})`);
  assert(!!result.error, 'a real error message is captured');
}

// ---------------------------------------------------------------------------
// Firecrawl degrades but synthesis still succeeds -> 'degraded_trustworthy',
// distinct from a clean 'complete'.
// ---------------------------------------------------------------------------
{
  setBaseEnv({ firecrawl: true });
  const candidateUrl = 'https://news.example.com/degraded-co-event';
  const { result } = await withMockedFetch(async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) return { ok: true, status: 200, json: async () => ({ organic: [{ title: 'Event', snippet: 'Degraded Co held an event, ribbon cutting 2026.', link: candidateUrl, date: '2026-01-01' }] }) };
    if (u.includes('firecrawl.dev')) return { ok: false, status: 502, json: async () => ({ error: 'upstream failed' }) };
    if (u.includes('api.openai.com')) return {
      ok: true, status: 200, json: async () => ({
        output_text: JSON.stringify({ signals: [{
          accountName: 'Degraded Co', signal_type: 'Growth / Expansion', concrete_trigger: 'New facility ribbon cutting',
          business_context: 'Degraded Co held a ribbon cutting for a new facility expansion, announced 2026.',
          commercial_play: { concept: 'Grand Opening Kit', narrative: 'Mark the new facility opening with team apparel and a client-facing welcome gift.' },
          activation_ideas: ['Team polos for the opening event', 'Client welcome gift box'],
          sourceUrl: candidateUrl, confidence: 80
        }] }),
        usage: { input_tokens: 700, output_tokens: 100, total_tokens: 800 }
      })
    };
    throw new Error(`unexpected fetch: ${u}`);
  }, () => runResearchPipeline(projectAccountContext({ account_name: 'Degraded Co', raw_data: {} }), { apiKey: 'sk-test', startedAt: Date.now() }));
  assert(result.coverage === 'degraded_trustworthy', `REQUIRED: a degraded-but-successful Firecrawl attempt classifies as 'degraded_trustworthy', not plain 'complete' (got ${result.coverage})`);
  assert(result.signals.length === 1, 'the signal still survives despite the degradation');
  assert(result.providerUsage.firecrawlRequests > 0 && result.providerUsage.firecrawlSuccesses === 0, 'the degradation is visible in the returned telemetry');
}

// ---------------------------------------------------------------------------
// classifyResearchCoverage() -- exhaustive pure-function matrix.
// ---------------------------------------------------------------------------
{
  assert(classifyResearchCoverage({ serperConfigured: false, candidatesFound: 0, synthesisAttempted: false, synthesisSucceeded: false }) === 'insufficient', 'no search provider -> insufficient, even with zero candidates');
  assert(classifyResearchCoverage({ serperConfigured: true, candidatesFound: 0, synthesisAttempted: false, synthesisSucceeded: false }) === 'complete', 'real search, zero candidates -> complete (legitimate zero-result)');
  assert(classifyResearchCoverage({ serperConfigured: true, candidatesFound: 3, synthesisAttempted: true, synthesisSucceeded: true }) === 'complete', 'candidates found, synthesis succeeded, no degradation -> complete');
  assert(classifyResearchCoverage({ serperConfigured: true, candidatesFound: 3, synthesisAttempted: false, synthesisSucceeded: false }) === 'insufficient', 'candidates found but synthesis never ran -> insufficient');
  assert(classifyResearchCoverage({ serperConfigured: true, candidatesFound: 3, synthesisAttempted: true, synthesisSucceeded: false }) === 'insufficient', 'candidates found, synthesis attempted but failed -> insufficient');
  assert(classifyResearchCoverage({ serperConfigured: true, candidatesFound: 3, synthesisAttempted: true, synthesisSucceeded: true, firecrawlAttempted: 2, firecrawlSucceeded: 1 }) === 'degraded_trustworthy', 'partial Firecrawl success -> degraded_trustworthy');
  assert(classifyResearchCoverage({ serperConfigured: true, candidatesFound: 3, synthesisAttempted: true, synthesisSucceeded: true, firecrawlAttempted: 2, firecrawlSucceeded: 2 }) === 'complete', 'full Firecrawl success -> complete, not degraded');
  assert(classifyResearchCoverage({ serperConfigured: true, candidatesFound: 3, synthesisAttempted: true, synthesisSucceeded: true, firecrawlAttempted: 0, firecrawlSucceeded: 0 }) === 'complete', 'Firecrawl not configured/attempted at all -> complete, not treated as degradation');
}

// ---------------------------------------------------------------------------
// Telemetry shape and cost estimation.
// ---------------------------------------------------------------------------
{
  const usage = { openaiInputTokens: 1000, openaiOutputTokens: 200, serperQueries: 10, firecrawlSuccesses: 2 };
  const cost = estimateAttemptCostUsd(usage);
  assert(typeof cost === 'number' && cost > 0, `estimateAttemptCostUsd returns a positive number for real usage (got ${cost})`);
  assert(estimateAttemptCostUsd({}) === 0, 'zero usage estimates to zero cost, not NaN or a thrown error');
  assert(typeof COST_MODEL_VERSION === 'string' && COST_MODEL_VERSION.length > 0, 'a cost model version string is exported for persistence alongside every estimate');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
