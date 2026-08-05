// Commercial-readiness core validation, item 1 -- provider usage
// instrumentation. Tests the REAL, production-bound handler export from
// api/research-batch.js (not a reimplementation) via mocked fetch, plus the
// pure aggregation/pricing helpers in scripts/aggregate-provider-usage.js
// and scripts/provider-pricing.js.
//
// Usage: node scripts/test-provider-usage-instrumentation.js
import { Readable } from 'stream';
import handler, { openaiUsageFromResponse, enrichCandidatesWithFirecrawl } from '../api/research-batch.js';
import { estimateRunCostUsd, PROVIDER_PRICING } from './provider-pricing.js';
import { readUsageRecords, aggregate } from './aggregate-provider-usage.js';

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
  delete process.env.SERPER_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
}

// ---------------------------------------------------------------------------
// openaiUsageFromResponse(): pure token-extraction unit tests.
// ---------------------------------------------------------------------------
{
  const usage = openaiUsageFromResponse({ usage: { input_tokens: 1200, output_tokens: 340, total_tokens: 1540 } });
  assert(usage.inputTokens === 1200 && usage.outputTokens === 340 && usage.totalTokens === 1540, `openaiUsageFromResponse() extracts the real token counts OpenAI's own response already reports (got ${JSON.stringify(usage)})`);
  const missing = openaiUsageFromResponse({});
  assert(missing.inputTokens === 0 && missing.outputTokens === 0 && missing.totalTokens === 0, 'openaiUsageFromResponse() never throws on a response with no usage field, defaulting to zero');
}

// ---------------------------------------------------------------------------
// enrichCandidatesWithFirecrawl(): attemptedCount is present even when
// Firecrawl is not configured (0 attempted, 0 scraped) -- proves "failed
// calls are accounted for" starts from an honest baseline, not undefined.
// ---------------------------------------------------------------------------
{
  delete process.env.FIRECRAWL_API_KEY;
  const result = await enrichCandidatesWithFirecrawl([{ url: 'https://example.com/a', accountName: 'Acme' }]);
  assert(result.attemptedCount === 0 && result.scrapedCount === 0, `enrichCandidatesWithFirecrawl() reports 0 attempted/0 scraped when FIRECRAWL_API_KEY is not configured (got ${JSON.stringify(result)})`);
}

// ---------------------------------------------------------------------------
// Full handler: a successful run (no uploadId -- the anonymous/untracked
// path, so no Supabase auth mocking is needed) returns a providerUsage
// object with real OpenAI token counts, and the console log line contains
// no secret material.
// ---------------------------------------------------------------------------
async function testSuccessfulRun(){
  setBaseEnv();
  const realFetch = global.fetch;
  const realConsoleLog = console.log;
  const loggedLines = [];
  console.log = (...args) => { loggedLines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); };
  global.fetch = async (url) => {
    if(String(url).includes('api.openai.com')){
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({ signals: [] }),
          usage: { input_tokens: 4321, output_tokens: 987, total_tokens: 5308 }
        })
      };
    }
    throw new Error(`unexpected fetch call in successful-run test: ${url}`);
  };
  const req = { method: 'POST', headers: {}, body: { accounts: [{ name: 'Acme Test Co' }], mode: 'ranked' } };
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
    console.log = realConsoleLog;
  }

  assert(res.statusCode === 200, `successful run: handler returns 200 (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
  const usage = res.body?.providerUsage;
  assert(!!usage, 'successful run: response includes a providerUsage object');
  if(usage){
    assert(usage.openai.calls === 1, `successful run: openai.calls is 1 (got ${usage.openai.calls})`);
    assert(usage.openai.failures === 0, `successful run: openai.failures is 0 (got ${usage.openai.failures})`);
    assert(usage.openai.inputTokens === 4321 && usage.openai.outputTokens === 987 && usage.openai.totalTokens === 5308, `successful run: real OpenAI token counts are captured (got ${JSON.stringify(usage.openai)})`);
    assert(usage.serper.configured === false && usage.serper.queries === 0, `successful run: serper reports not-configured/zero queries when SERPER_API_KEY is unset (got ${JSON.stringify(usage.serper)})`);
    assert(usage.firecrawl.configured === false && usage.firecrawl.requests === 0, `successful run: firecrawl reports not-configured/zero requests when FIRECRAWL_API_KEY is unset (got ${JSON.stringify(usage.firecrawl)})`);
    assert(usage.run.accountsAttempted === 1, `successful run: accountsAttempted matches the request (got ${usage.run.accountsAttempted})`);
    assert(typeof usage.run.elapsedMs === 'number' && usage.run.elapsedMs >= 0, 'successful run: elapsedMs is a real non-negative number');
  }

  const usageLine = loggedLines.find(l => l.includes('[research-batch.provider-usage]'));
  assert(!!usageLine, 'successful run: the structured provider-usage log line was emitted');
  if(usageLine){
    assert(!usageLine.includes('sk-test-do-not-log'), 'successful run: the logged line never contains the OpenAI API key');
    assert(!/authorization/i.test(usageLine), 'successful run: the logged line never contains an Authorization header');
    assert(!usageLine.includes('fake-service-role-key'), 'successful run: the logged line never contains the Supabase service role key');
  }
}
await testSuccessfulRun();

// ---------------------------------------------------------------------------
// Full handler: a failed OpenAI call still logs (failures are accounted
// for, not silently dropped merely because the whole request also fails),
// and the request itself still fails exactly as before this change.
// ---------------------------------------------------------------------------
async function testFailedRun(){
  setBaseEnv();
  const realFetch = global.fetch;
  const realConsoleLog = console.log;
  const loggedLines = [];
  console.log = (...args) => { loggedLines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); };
  global.fetch = async (url) => {
    if(String(url).includes('api.openai.com')){
      return { ok: false, status: 500, text: async () => 'OpenAI is having a bad day' };
    }
    throw new Error(`unexpected fetch call in failed-run test: ${url}`);
  };
  const req = { method: 'POST', headers: {}, body: { accounts: [{ name: 'Acme Test Co' }], mode: 'ranked' } };
  const res = makeRes();
  try {
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
    console.log = realConsoleLog;
  }

  assert(res.statusCode === 500, `failed run: the request still fails exactly as before this change (got ${res.statusCode})`);
  const usageLine = loggedLines.find(l => l.includes('[research-batch.provider-usage]'));
  assert(!!usageLine, 'failed run: a provider-usage log line is still emitted even though the whole request failed');
  if(usageLine){
    const payload = JSON.parse(usageLine.slice(usageLine.indexOf('{')));
    assert(payload.openai.failures === 1, `failed run: openai.failures is 1 (got ${payload.openai.failures})`);
    assert(payload.run.failed === true, 'failed run: the logged record is marked failed:true');
  }
}
await testFailedRun();

// ---------------------------------------------------------------------------
// provider-pricing.js: estimateRunCostUsd() math, and that pricing inputs
// live in exactly one place (this file), separate from usage measurement.
// ---------------------------------------------------------------------------
{
  const cost = estimateRunCostUsd({
    openai: { inputTokens: 10000, outputTokens: 2000 },
    serper: { queries: 100 },
    firecrawl: { requests: 50 }
  });
  const expectedOpenai = (10000/1000) * PROVIDER_PRICING.openai.inputPer1kTokens + (2000/1000) * PROVIDER_PRICING.openai.outputPer1kTokens;
  const expectedSerper = 100 * PROVIDER_PRICING.serper.perQuery;
  const expectedFirecrawl = 50 * PROVIDER_PRICING.firecrawl.perRequest;
  assert(Math.abs(cost.openaiCostUsd - expectedOpenai) < 0.0001, `estimateRunCostUsd(): openai cost matches configured per-token pricing (got ${cost.openaiCostUsd})`);
  assert(Math.abs(cost.serperCostUsd - expectedSerper) < 0.0001, `estimateRunCostUsd(): serper cost matches configured per-query pricing (got ${cost.serperCostUsd})`);
  assert(Math.abs(cost.firecrawlCostUsd - expectedFirecrawl) < 0.0001, `estimateRunCostUsd(): firecrawl cost matches configured per-request pricing (got ${cost.firecrawlCostUsd})`);
  assert(Math.abs(cost.totalCostUsd - (expectedOpenai + expectedSerper + expectedFirecrawl)) < 0.0001, 'estimateRunCostUsd(): total is the sum of all three providers');

  const empty = estimateRunCostUsd({});
  assert(empty.totalCostUsd === 0, `estimateRunCostUsd(): a usage object missing every provider estimates $0, never throws (got ${JSON.stringify(empty)})`);
}

// ---------------------------------------------------------------------------
// aggregate-provider-usage.js: readUsageRecords() parses only well-formed
// log lines (skipping noise), and aggregate() computes correct per-run,
// per-upload, per-provider totals and failed-account accounting.
// ---------------------------------------------------------------------------
async function testAggregation(){
  const logLines = [
    'this is an unrelated log line with no marker',
    '2026-01-01T00:00:00Z [research-batch.provider-usage] {"userId":"u1","run":{"uploadId":"up1","researchRunId":"auto","mode":"ranked","elapsedMs":15000,"accountsAttempted":10,"accountsWithSignals":7,"accountsWithNoSignals":3,"signalsProduced":12},"openai":{"calls":1,"failures":0,"inputTokens":8000,"outputTokens":2200,"totalTokens":10200,"model":"gpt-4o-mini"},"serper":{"configured":true,"queries":90,"failedQueries":1},"firecrawl":{"configured":true,"requests":40,"successes":36,"failures":4}}',
    'malformed [research-batch.provider-usage] { not valid json',
    '2026-01-01T01:00:00Z [research-batch.provider-usage] {"userId":"u1","run":{"uploadId":"up1","researchRunId":"manual-1","mode":"ranked","elapsedMs":9000,"accountsAttempted":3,"accountsWithSignals":0,"accountsWithNoSignals":3,"signalsProduced":0},"openai":{"calls":1,"failures":0,"inputTokens":2500,"outputTokens":700,"totalTokens":3200,"model":"gpt-4o-mini"},"serper":{"configured":true,"queries":27,"failedQueries":0},"firecrawl":{"configured":false,"requests":0,"successes":0,"failures":0}}'
  ].join('\n');
  const records = await readUsageRecords(Readable.from([logLines]));
  assert(records.length === 2, `readUsageRecords(): parses exactly the 2 well-formed records, skipping the unrelated/malformed lines (got ${records.length})`);

  const result = aggregate(records);
  assert(result.totals.runs === 2, `aggregate(): totals.runs is 2 (got ${result.totals.runs})`);
  assert(result.totals.accountsAttempted === 13, `aggregate(): totals.accountsAttempted sums across runs (got ${result.totals.accountsAttempted})`);
  assert(result.totals.openaiInputTokens === 10500, `aggregate(): totals.openaiInputTokens sums across runs (got ${result.totals.openaiInputTokens})`);
  assert(result.totals.serperQueries === 117, `aggregate(): totals.serperQueries sums across runs (got ${result.totals.serperQueries})`);
  assert(result.perUpload.length === 1 && result.perUpload[0].uploadId === 'up1', `aggregate(): usage per upload is grouped by uploadId (got ${JSON.stringify(result.perUpload)})`);
  assert(result.perRun.length === 2, `aggregate(): usage per research run has one entry per run (got ${result.perRun.length})`);
  assert(result.failedAccountUsage.accountsWithNoSignals === 6, `aggregate(): failed-account usage counts accountsWithNoSignals across runs (got ${result.failedAccountUsage.accountsWithNoSignals})`);
  assert(result.failedAccountUsage.runsAffected === 2, `aggregate(): both runs had at least one non-actionable account (got ${result.failedAccountUsage.runsAffected})`);
  assert(result.costPerResearchedAccount > 0, `aggregate(): costPerResearchedAccount is a positive number (got ${result.costPerResearchedAccount})`);
  assert(result.costPerActionableSignal > 0, `aggregate(): costPerActionableSignal is a positive number (got ${result.costPerActionableSignal})`);
  assert(result.avgUsagePerSuccessfulAccount !== null, 'aggregate(): avgUsagePerSuccessfulAccount is computed when at least one account produced signals');

  const emptyResult = aggregate([{ run: { uploadId: 'x', researchRunId: 'y', mode: 'ranked', elapsedMs: 1, accountsAttempted: 2, accountsWithSignals: 0, accountsWithNoSignals: 2, signalsProduced: 0 }, openai: { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 }, serper: { queries: 0, failedQueries: 0 }, firecrawl: { requests: 0, failures: 0 } }]);
  assert(emptyResult.avgUsagePerSuccessfulAccount === null, 'aggregate(): avgUsagePerSuccessfulAccount is null (not a divide-by-zero NaN) when no account produced signals');
}
await testAggregation();

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
