// Controlled-beta zero-candidate synthesis policy (Sprint 1 follow-up).
//
// Prior finding: when candidate-backed discovery (Serper/Firecrawl) finds
// zero surviving candidates, api/research-batch.js used to fall back to
// callOpenAIWebSearch() -- OpenAI's own independent web search, with no
// discovered-candidate object behind it. Since Sprint 1's
// requireResolvedCandidate() requires every signal's sourceUrl to resolve to
// a candidate this run actually discovered, and the fallback branch's
// `candidates` array is always empty by construction, every signal that
// branch could ever produce was already guaranteed to be rejected -- so the
// fallback call was pure wasted latency/cost, spent on output that could
// never survive.
//
// This tests the fix: the candidates.length===0 branch no longer calls
// callOpenAIWebSearch() at all, returns the same successful empty-result
// response an honestly-dry candidate-backed account already returns, and
// reports an explicit `synthesisMode`/`fallbackSkippedReason` in diagnostics
// so beta usage can be measured from existing structured logs. This drives
// the REAL, production-bound handler export (mocked fetch), the same
// pattern scripts/test-provider-usage-instrumentation.js uses -- proving the
// actual behavioral boundary, not just source text.
//
// Usage: node scripts/test-research-batch-zero-candidate-policy.js
import handler from '../api/research-batch.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function makeRes(){
  const res = { statusCode:200, body:null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function setBaseEnv(){
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  delete process.env.CRON_SECRET;
  process.env.OPENAI_API_KEY = 'sk-test-do-not-log-1234567890';
  process.env.SERPER_API_KEY = 'fake-serper-key';
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
}

// ---------------------------------------------------------------------------
// Case 1: Serper is configured and genuinely finds nothing usable for this
// account (every organic result is empty/irrelevant, clearing no acceptance
// threshold) -- the real "sparse account" shape this policy targets.
// ---------------------------------------------------------------------------
async function testZeroCandidateSkipsWebSearchFallback(){
  setBaseEnv();
  const realFetch = global.fetch;
  let openaiCalled = false;
  let serperCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if(u.includes('google.serper.dev')){
      serperCalls += 1;
      return { ok: true, status: 200, json: async () => ({ organic: [] }) };
    }
    if(u.includes('api.openai.com')){
      openaiCalled = true;
      throw new Error('callOpenAIWebSearch() must not be called when zero candidates were discovered');
    }
    throw new Error(`unexpected fetch call in zero-candidate test: ${u}`);
  };
  const req = { method: 'POST', headers: {}, body: { accounts: [{ name: 'Sparse Obscure Co', intelligenceMode: 'warm' }], mode: 'warm-account' } };
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
  }

  assert(serperCalls > 0, `sanity: Serper was actually queried for this account (got ${serperCalls} calls)`);
  assert(openaiCalled === false, '1) callOpenAIWebSearch() is never invoked when candidate-backed discovery finds zero surviving candidates');
  assert(res.statusCode === 200, `2) a zero-candidate request still returns the existing successful response, not an HTTP/provider error (got ${res.statusCode})`);
  assert(Array.isArray(res.body?.signals) && res.body.signals.length === 0, '2) the successful response carries an honest empty signals array');
  assert(res.body?.providerUsage?.openai?.calls === 0, `2) providerUsage confirms zero OpenAI calls were made (got ${res.body?.providerUsage?.openai?.calls})`);

  const diag = res.body?.diagnostics || {};
  assert(diag.synthesisMode === 'no-candidate-evidence', `3) diagnostics.synthesisMode reports 'no-candidate-evidence' (got ${diag.synthesisMode})`);
  assert(diag.fallbackSkippedReason === 'no candidate-backed evidence discovered', `3) diagnostics.fallbackSkippedReason is the exact agreed wording (got ${JSON.stringify(diag.fallbackSkippedReason)})`);
  assert(diag.rankedCandidates === 0, `3) diagnostics.rankedCandidates confirms zero candidates were the actual cause (got ${diag.rankedCandidates})`);
  assert(diag.providerMode !== 'openai-web-search', `2) diagnostics.providerMode never claims 'openai-web-search' when no such call occurred (got ${diag.providerMode})`);
}
await testZeroCandidateSkipsWebSearchFallback();

// ---------------------------------------------------------------------------
// Case 1b: no search provider configured at all (SERPER_API_KEY unset) --
// the exact scenario that exposed the stale providerMode default. Before
// the diagnostics fix, providerMode defaulted to 'openai-web-search' because
// this branch always used to actually call it; now it must not claim a
// provider call that never happens.
// ---------------------------------------------------------------------------
async function testNoSearchProviderDiagnosticsAreTruthful(){
  setBaseEnv();
  delete process.env.SERPER_API_KEY;
  const realFetch = global.fetch;
  let anyFetchCalled = false;
  global.fetch = async (url) => {
    anyFetchCalled = true;
    throw new Error(`unexpected fetch call with no search provider configured: ${url}`);
  };
  const req = { method: 'POST', headers: {}, body: { accounts: [{ name: 'No Provider Co', intelligenceMode: 'warm' }], mode: 'warm-account' } };
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
  }

  assert(anyFetchCalled === false, '1) zero fetch calls of any kind (including OpenAI) when no search provider is configured at all');
  assert(res.statusCode === 200, `2) still the existing successful empty-result response, not an error (got ${res.statusCode})`);
  const diag = res.body?.diagnostics || {};
  assert(diag.providerMode !== 'openai-web-search', `2) diagnostics.providerMode no longer reports the stale 'openai-web-search' default (got ${diag.providerMode})`);
  assert(diag.synthesisMode === 'no-candidate-evidence', `4) diagnostics.synthesisMode is still 'no-candidate-evidence' (got ${diag.synthesisMode})`);
  assert(res.body?.providerUsage?.openai?.calls === 0, `3) providerUsage.openai.calls is 0 (got ${res.body?.providerUsage?.openai?.calls})`);
}
await testNoSearchProviderDiagnosticsAreTruthful();

// ---------------------------------------------------------------------------
// Case 2: candidate-backed discovery succeeds -- the normal synthesis path
// (callOpenAIJson(), NOT callOpenAIWebSearch()) must still run exactly as
// before this change.
// ---------------------------------------------------------------------------
async function testCandidateBackedPathUnaffected(){
  setBaseEnv();
  const realFetch = global.fetch;
  let openaiCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if(u.includes('google.serper.dev')){
      return {
        ok: true,
        status: 200,
        json: async () => ({
          organic: [{
            title: 'New facility expansion ribbon cutting announced 2026',
            snippet: 'Dense Co held a ribbon cutting for a new facility expansion, announced 2026, trade show exhibitor booth.',
            link: 'https://news.example.com/dense-co-facility',
            date: '2026-01-01'
          }]
        })
      };
    }
    if(u.includes('api.openai.com')){
      openaiCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({ signals: [] }),
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
        })
      };
    }
    throw new Error(`unexpected fetch call in candidate-backed test: ${u}`);
  };
  const req = { method: 'POST', headers: {}, body: { accounts: [{ name: 'Dense Co', intelligenceMode: 'warm' }], mode: 'warm-account' } };
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
  }

  assert(res.statusCode === 200, `4) candidate-backed request still succeeds (got ${res.statusCode})`);
  assert(openaiCalls === 1, `4) candidate-backed discovery still reaches the normal OpenAI synthesis call exactly once (got ${openaiCalls})`);
  const diag = res.body?.diagnostics || {};
  assert(diag.synthesisMode === 'candidate-backed', `4) diagnostics.synthesisMode reports 'candidate-backed' when real candidates exist (got ${diag.synthesisMode})`);
  assert(diag.fallbackSkippedReason === '', `4) diagnostics.fallbackSkippedReason is empty on the normal candidate-backed path (got ${JSON.stringify(diag.fallbackSkippedReason)})`);
  assert(diag.rankedCandidates > 0, `4) diagnostics.rankedCandidates reflects the real discovered candidate (got ${diag.rankedCandidates})`);
  assert(diag.providerMode === 'targeted-search', `4) diagnostics.providerMode accurately reports 'targeted-search' -- the provider actually used for discovery (got ${diag.providerMode})`);
}
await testCandidateBackedPathUnaffected();

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
