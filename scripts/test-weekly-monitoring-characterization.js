// Phase 2A: characterization suite for api/research-batch.js's
// weekly-monitoring pipeline, captured BEFORE the parse/map/validate/
// grounding/event-resolution tail is extracted into a shared, reusable
// function. This is the regression baseline Phase 1's report recommended
// building before attempting that extraction -- it pins externally
// meaningful behavior (what the caller observes: response shape, signal
// content, provider-usage counts, failure semantics), not implementation
// details of how the tail is currently structured internally.
//
// Drives the REAL, production-bound `handler` export (mocked fetch only),
// same convention as scripts/test-trust-correction-derived-identity-
// endpoint-regression.js and scripts/test-research-batch-weekly-monitoring-
// auth.js. Every fixture here uses mode:'weekly-monitoring' with the
// CRON_SECRET bearer auth path (no uploadId), matching how
// api/weekly-scan.js actually calls this endpoint today and how a future
// background worker would call the extracted pipeline.
//
// Usage: node scripts/test-weekly-monitoring-characterization.js
import handler from '../api/research-batch.js';

const TEST_CRON_SECRET = 'characterization-cron-secret-0987654321';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function setBaseEnv({ firecrawl = false } = {}) {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  process.env.OPENAI_API_KEY = 'sk-test-do-not-log-1234567890';
  process.env.SERPER_API_KEY = 'fake-serper-key';
  if (firecrawl) process.env.FIRECRAWL_API_KEY = 'fake-firecrawl-key'; else delete process.env.FIRECRAWL_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
}

async function runWeeklyMonitoring(accounts, fetchImpl) {
  const realFetch = global.fetch;
  global.fetch = fetchImpl;
  const req = { method: 'POST', headers: { authorization: `Bearer ${TEST_CRON_SECRET}` }, body: { mode: 'weekly-monitoring', accounts } };
  const res = makeRes();
  let threw = null;
  try { await handler(req, res); } catch (err) { threw = err; } finally { global.fetch = realFetch; }
  return { res, threw };
}

// ---------------------------------------------------------------------------
// Scenario 1: a real signal is produced end to end. Known-good fixture
// shape (matching sourceUrl <-> discovered candidate link, minimal signal
// fields) reused from scripts/test-trust-correction-derived-identity-
// endpoint-regression.js's proven working case.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const candidateUrl = 'https://news.example.com/acme-facility-expansion';
  const { res, threw } = await runWeeklyMonitoring([{ name: 'Acme Test Co' }], async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      return { ok: true, status: 200, json: async () => ({ organic: [{
        title: 'Acme Test Co opens new facility',
        snippet: 'Acme Test Co held a ribbon cutting for a new facility expansion, announced 2026.',
        link: candidateUrl, date: '2026-01-01'
      }] }) };
    }
    if (u.includes('api.openai.com')) {
      return { ok: true, status: 200, json: async () => ({
        output_text: JSON.stringify({ signals: [{
          accountName: 'Acme Test Co', signal_type: 'Growth / Expansion',
          concrete_trigger: 'New facility ribbon cutting',
          business_context: 'Acme Test Co held a ribbon cutting for a new facility expansion.',
          sourceUrl: candidateUrl, confidence: 90
        }] }),
        usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }
      }) };
    }
    throw new Error(`unexpected fetch call (scenario 1): ${u}`);
  });
  assert(threw === null, `CHARACTERIZATION 1: the handler completes without throwing${threw ? `: ${threw.message}` : ''}`);
  assert(res.statusCode === 200, `CHARACTERIZATION 1: a real-signal weekly-monitoring request succeeds (got ${res.statusCode})`);
  assert(Array.isArray(res.body?.signals) && res.body.signals.length === 1, `CHARACTERIZATION 1: exactly one real signal is returned (got ${res.body?.signals?.length})`);
  const signal = res.body?.signals?.[0];
  assert(signal?.accountName === 'Acme Test Co', 'CHARACTERIZATION 1: the signal resolves to the correct requested account name');
  assert(!!signal?.eventFingerprint, 'CHARACTERIZATION 1: the signal carries a non-empty eventFingerprint -- the identity dedup persistence upstream (weekly-scan.js) depends on');
  assert(signal?.isFallbackOpportunity !== true, 'CHARACTERIZATION 1: a real synthesized signal is never marked as a fallback/fabricated opportunity');
  assert(res.body?.diagnostics?.mode === 'weekly-monitoring', 'CHARACTERIZATION 1: diagnostics confirm the weekly-monitoring path ran');
  assert(res.body?.diagnostics?.synthesisMode === 'candidate-backed', `CHARACTERIZATION 1: synthesisMode is candidate-backed (got ${res.body?.diagnostics?.synthesisMode})`);
  assert(res.body?.providerUsage?.openai?.calls === 1, `CHARACTERIZATION 1: exactly one OpenAI call is counted in providerUsage (got ${res.body?.providerUsage?.openai?.calls})`);
}

// ---------------------------------------------------------------------------
// Scenario 2: confirmed zero-result scan -- real candidate-backed discovery
// and a real OpenAI synthesis call both happened, but the model legitimately
// found nothing. Must be distinguishable from scenario 3 (discovery itself
// found nothing) via diagnostics.rankedCandidates and synthesisMode.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const { res, threw } = await runWeeklyMonitoring([{ name: 'Quiet Co' }], async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      return { ok: true, status: 200, json: async () => ({ organic: [{
        title: 'Quiet Co annual report', snippet: 'Quiet Co filed its routine annual report.',
        link: 'https://news.example.com/quiet-co-annual', date: '2026-01-01'
      }] }) };
    }
    if (u.includes('api.openai.com')) {
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: [] }), usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 } }) };
    }
    throw new Error(`unexpected fetch call (scenario 2): ${u}`);
  });
  assert(threw === null, 'CHARACTERIZATION 2: the handler completes without throwing on a legitimate zero-result scan');
  assert(res.statusCode === 200, `CHARACTERIZATION 2: a confirmed-empty scan is still a successful response, not an error (got ${res.statusCode})`);
  assert(Array.isArray(res.body?.signals) && res.body.signals.length === 0, 'CHARACTERIZATION 2: signals is an honest empty array');
  assert(res.body?.diagnostics?.synthesisMode === 'candidate-backed', 'CHARACTERIZATION 2: synthesisMode confirms real synthesis was attempted (distinguishes this from scenario 3)');
  assert(Number(res.body?.diagnostics?.rankedCandidates) > 0, `CHARACTERIZATION 2: rankedCandidates > 0 proves real discovery evidence existed and was evaluated, not skipped (got ${res.body?.diagnostics?.rankedCandidates})`);
  assert(res.body?.providerUsage?.openai?.calls === 1, 'CHARACTERIZATION 2: an OpenAI call genuinely happened (this is coverage, not a shortcut)');
}

// ---------------------------------------------------------------------------
// Scenario 3: candidate discovery itself finds nothing -- the zero-candidate
// policy (Sprint 1) skips the OpenAI call entirely rather than paying for a
// call requireResolvedCandidate() is guaranteed to reject anyway.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const { res, threw } = await runWeeklyMonitoring([{ name: 'Obscure Co' }], async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) return { ok: true, status: 200, json: async () => ({ organic: [] }) };
    throw new Error(`unexpected fetch call (scenario 3, OpenAI must not be called): ${u}`);
  });
  assert(threw === null, 'CHARACTERIZATION 3: the handler completes without throwing when discovery finds nothing');
  assert(res.statusCode === 200, `CHARACTERIZATION 3: zero discovered candidates is still a successful response (got ${res.statusCode})`);
  assert(Array.isArray(res.body?.signals) && res.body.signals.length === 0, 'CHARACTERIZATION 3: signals is empty');
  assert(res.body?.diagnostics?.synthesisMode === 'no-candidate-evidence', `CHARACTERIZATION 3: synthesisMode reports no-candidate-evidence, distinct from a real zero-result scan (got ${res.body?.diagnostics?.synthesisMode})`);
  assert(res.body?.providerUsage?.openai?.calls === 0, 'CHARACTERIZATION 3: REQUIRED -- zero OpenAI calls are made when there is no candidate evidence to evaluate (cost-avoidance policy)');
}

// ---------------------------------------------------------------------------
// Scenario 4: partial provider degradation (Firecrawl fails) that still
// leaves trustworthy coverage -- Serper discovery and OpenAI synthesis both
// succeed; only the optional enrichment step degrades. A real signal must
// still be produced, and the degradation must be visible in providerUsage.
// ---------------------------------------------------------------------------
{
  setBaseEnv({ firecrawl: true });
  const candidateUrl = 'https://news.example.com/beta-co-expansion';
  const { res, threw } = await runWeeklyMonitoring([{ name: 'Beta Co' }], async (url, options) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      return { ok: true, status: 200, json: async () => ({ organic: [{
        title: 'Beta Co opens new distribution center', snippet: 'Beta Co announced a new distribution center, ribbon cutting held 2026.',
        link: candidateUrl, date: '2026-01-01'
      }] }) };
    }
    if (u.includes('firecrawl.dev')) {
      // Simulate a degraded/failed scrape -- non-2xx, no page content.
      return { ok: false, status: 502, json: async () => ({ error: 'upstream fetch failed' }) };
    }
    if (u.includes('api.openai.com')) {
      return { ok: true, status: 200, json: async () => ({
        output_text: JSON.stringify({ signals: [{
          accountName: 'Beta Co', signal_type: 'Growth / Expansion',
          concrete_trigger: 'New distribution center ribbon cutting',
          business_context: 'Beta Co announced a new distribution center.',
          sourceUrl: candidateUrl, confidence: 85
        }] }),
        usage: { input_tokens: 900, output_tokens: 150, total_tokens: 1050 }
      }) };
    }
    throw new Error(`unexpected fetch call (scenario 4): ${u}`);
  });
  assert(threw === null, `CHARACTERIZATION 4: a Firecrawl-degraded request still completes without throwing${threw ? `: ${threw.message}` : ''}`);
  assert(res.statusCode === 200, `CHARACTERIZATION 4: degraded-but-trustworthy coverage still succeeds (got ${res.statusCode})`);
  assert(Array.isArray(res.body?.signals) && res.body.signals.length === 1, `CHARACTERIZATION 4: a real signal still survives despite Firecrawl degradation (got ${res.body?.signals?.length})`);
  assert(res.body?.providerUsage?.firecrawl?.requests > 0, 'CHARACTERIZATION 4: the degraded Firecrawl attempt is counted');
  assert(res.body?.providerUsage?.firecrawl?.successes === 0, 'CHARACTERIZATION 4: REQUIRED -- the failed Firecrawl attempt is NOT counted as a success, making the degradation visible to a future coverage classifier');
  assert(res.body?.providerUsage?.openai?.calls === 1, 'CHARACTERIZATION 4: OpenAI synthesis still ran on the un-enriched (snippet-only) candidate');
}

// ---------------------------------------------------------------------------
// Scenario 5: insufficient completion -- the OpenAI call itself fails
// (simulating a provider outage), which must surface as a genuine error, not
// a silently-empty success. This is the shape a future worker must treat as
// "insufficient": cadence must not advance on this outcome.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const candidateUrl = 'https://news.example.com/gamma-co-event';
  const { res, threw } = await runWeeklyMonitoring([{ name: 'Gamma Co' }], async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      return { ok: true, status: 200, json: async () => ({ organic: [{ title: 'Gamma Co event', snippet: 'Gamma Co held an event.', link: candidateUrl, date: '2026-01-01' }] }) };
    }
    if (u.includes('api.openai.com')) {
      return { ok: false, status: 503, json: async () => ({ error: { message: 'The model is overloaded. Please try again later.' } }) };
    }
    throw new Error(`unexpected fetch call (scenario 5): ${u}`);
  });
  assert(threw === null, 'CHARACTERIZATION 5: a provider failure is caught inside the handler, not thrown out of it');
  assert(res.statusCode === 500, `CHARACTERIZATION 5: REQUIRED -- an OpenAI failure surfaces as a genuine error response, never a disguised success (got ${res.statusCode})`);
  assert(typeof res.body?.error === 'string' && res.body.error.length > 0, 'CHARACTERIZATION 5: a real, non-empty error message is returned');
  assert(!Array.isArray(res.body?.signals), 'CHARACTERIZATION 5: REQUIRED -- no signals array (empty or otherwise) is returned on a genuine failure -- a future worker must not confuse this response shape with scenario 2/3\'s legitimate empty-signals success');
}

// ---------------------------------------------------------------------------
// Scenario 6: mode-specific weekly-monitoring guarantee -- zero-candidate
// coverage NEVER produces a fabricated/predictable-timing fallback signal.
// That fallback exists only for mode:'prospect-intelligence' (see
// makePredictableTimingSignal()'s call site); if it ever leaked into
// weekly-monitoring, real customer accounts would be monitored with
// fabricated signals presented as genuine intelligence -- explicitly the
// "dangerous to alter" case this characterization suite exists to guard.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const { res } = await runWeeklyMonitoring([{ name: 'No Evidence Co' }], async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) return { ok: true, status: 200, json: async () => ({ organic: [] }) };
    throw new Error(`unexpected fetch call (scenario 6, OpenAI must not be called): ${u}`);
  });
  assert(res.statusCode === 200, 'CHARACTERIZATION 6: zero-evidence weekly-monitoring is still a clean success');
  assert(Array.isArray(res.body?.signals) && res.body.signals.length === 0, 'CHARACTERIZATION 6: REQUIRED -- weekly-monitoring never fabricates a predictable-timing fallback signal the way prospect-intelligence mode does for a sparse account');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
