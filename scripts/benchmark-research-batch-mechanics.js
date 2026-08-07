// Research-runtime benchmark spike (scale/research-runtime-benchmark):
// MECHANICS-ONLY chunk-size sweep against the REAL, production-bound
// api/research-batch.js handler (same import pattern as
// scripts/test-provider-usage-instrumentation.js), with every outbound
// provider call mocked to resolve INSTANTLY (zero injected network latency).
//
// WHAT THIS MEASURES: the pipeline's own code-driven scaling characteristics
// as account count (N) grows -- outbound call fan-out (Serper/Firecrawl call
// counts), OpenAI synthesis prompt size, response payload size, and
// CPU-bound wall-clock (JSON building, dedup/clustering, candidate scoring,
// mapLimit scheduling overhead) -- entirely independent of real provider
// network latency.
//
// WHAT THIS DOES NOT MEASURE, AND MUST NEVER BE CITED AS: real production
// wall-clock duration, real p90 latency, or "safe chunk size" in an
// absolute-seconds sense. Every fetch() call below returns in ~0ms; real
// OpenAI/Serper/Firecrawl calls do not. This script cannot and does not
// prove a chunk size is safe under the ~58s Vercel ceiling -- it can only
// prove (or disprove) that the CODE ITSELF scales linearly, and quantify
// exactly how much outbound fan-out and prompt size one request produces at
// a given N, which is real, measured, code-grounded data feeding the
// engineering report's "primary runtime bottlenecks" and "does runtime scale
// linearly" sections. See COMMERCIAL_READINESS_BENCHMARK.md for the
// separate, real-provider, Preview-only procedure required to measure actual
// wall-clock.
//
// Usage: node scripts/benchmark-research-batch-mechanics.js
import handler from '../api/research-batch.js';

function setBaseEnv(maxAccounts) {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  delete process.env.CRON_SECRET;
  process.env.OPENAI_API_KEY = 'sk-test-do-not-log-1234567890';
  process.env.SERPER_API_KEY = 'fake-serper-key';
  process.env.FIRECRAWL_API_KEY = 'fake-firecrawl-key';
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  if (maxAccounts) process.env.RESEARCH_BATCH_MAX_ACCOUNTS = String(maxAccounts);
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// Three workload classes, cycled to build a mixed batch -- not just easy
// companies. This varies payload richness (contacts/notes/website/order
// history), which is the only thing a mock can honestly vary; it cannot
// simulate real search difficulty (that requires real providers).
const WORKLOAD_CLASSES = ['rich', 'ordinary', 'sparse'];

function buildAccount(i, workloadClass) {
  const base = {
    name: `Benchmark Account ${i} ${workloadClass}`,
    industry: workloadClass === 'sparse' ? '' : 'Manufacturing',
    cityState: workloadClass === 'sparse' ? '' : 'Columbus, OH',
    intelligenceMode: 'warm',
  };
  if (workloadClass === 'rich') {
    return {
      ...base,
      website: `benchmark-account-${i}.example.com`,
      notes: 'Long-standing customer, expanding footprint, frequent trade show presence.',
      contactName: `Contact ${i}`,
      contacts: [{ name: `Contact ${i}`, title: 'VP Marketing', department: 'Marketing', email: `c${i}@example.com` }],
      categories: ['Apparel', 'Drinkware', 'Bags'],
      recentOrderDates: ['2026-01-15', '2025-11-02', '2025-08-20'],
      existingSignals: [{ type: 'Hiring Signal', why: 'Posted 3 new roles' }],
      repeatPatterns: [{ category: 'Apparel', why: 'Reorders every Q1' }],
      revenue: 45000,
      orderCount: 12,
    };
  }
  if (workloadClass === 'ordinary') {
    return {
      ...base,
      website: `mid-account-${i}.example.com`,
      notes: '',
      contacts: [],
      categories: ['Drinkware'],
      recentOrderDates: ['2025-09-01'],
      revenue: 8000,
      orderCount: 2,
    };
  }
  // sparse -- minimal fields, no website, matches a hard/no-evidence account
  return { ...base };
}

function buildAccounts(n) {
  return Array.from({ length: n }, (_, i) => buildAccount(i, WORKLOAD_CLASSES[i % WORKLOAD_CLASSES.length]));
}

// Deterministic per-query Serper mock. Varies URL per (query, account) so
// dedupeCandidates() doesn't collapse everything to one candidate, and
// includes real buying-moment keywords so scoreCandidate() clears the
// acceptance threshold (>=10, deep-research >=10) -- otherwise every
// candidate would be silently rejected and the synthesis prompt would carry
// zero candidates, defeating the point of measuring candidate-driven prompt
// growth.
let serperCalls = 0;
let firecrawlCalls = 0;
let openaiCalls = 0;
let lastOpenAIPromptChars = 0;
let lastOpenAIRequestBodyBytes = 0;

function mockFetch(url, options) {
  const u = String(url);
  if (u.includes('google.serper.dev')) {
    serperCalls += 1;
    const body = JSON.parse(options.body);
    const q = body.q;
    const seed = Math.abs(hashCode(q));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        organic: Array.from({ length: 5 }, (_, i) => ({
          title: `New facility expansion ribbon cutting announced 2026 (${q.slice(0, 20)} #${i})`,
          snippet: `Company held a ribbon cutting for a new facility expansion, announced 2026, trade show exhibitor booth.`,
          link: `https://news.example.com/${seed}-${i}`,
          date: '2026-01-01',
        })),
      }),
    });
  }
  if (u.includes('api.firecrawl.dev')) {
    firecrawlCalls += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          // Realistic-length scraped page text (firecrawlScrape() truncates
          // to 1800 chars via compact() regardless of what's returned here).
          markdown: 'Buying moment page content. '.repeat(120),
        },
      }),
    });
  }
  if (u.includes('api.openai.com')) {
    openaiCalls += 1;
    const body = JSON.parse(options.body);
    lastOpenAIPromptChars = String(body.input || '').length;
    lastOpenAIRequestBodyBytes = options.body.length;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify({ signals: [] }),
        usage: { input_tokens: Math.round(lastOpenAIPromptChars / 4), output_tokens: 50, total_tokens: Math.round(lastOpenAIPromptChars / 4) + 50 },
      }),
    });
  }
  throw new Error(`benchmark mock: unexpected fetch to ${u}`);
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

async function runOne(n, maxAccounts) {
  setBaseEnv(maxAccounts);
  serperCalls = 0; firecrawlCalls = 0; openaiCalls = 0; lastOpenAIPromptChars = 0; lastOpenAIRequestBodyBytes = 0;
  const realFetch = global.fetch;
  const realConsoleLog = console.log;
  console.log = () => {}; // silence the handler's own structured logging for a clean table
  global.fetch = mockFetch;

  const accounts = buildAccounts(n);
  const req = { method: 'POST', headers: {}, body: { accounts, mode: 'warm-account' } };
  const res = makeRes();

  const wallStart = process.hrtime.bigint();
  let error = null;
  try {
    await handler(req, res);
  } catch (err) {
    error = err;
  } finally {
    const wallEnd = process.hrtime.bigint();
    global.fetch = realFetch;
    console.log = realConsoleLog;
    const wallMs = Number(wallEnd - wallStart) / 1e6;
    const diag = res.body?.diagnostics || {};
    const responseBytes = res.body ? JSON.stringify(res.body).length : 0;
    return {
      n,
      status: res.statusCode,
      error: error ? error.message : (res.body?.error || null),
      wallMs: Math.round(wallMs * 10) / 10,
      serverElapsedMs: diag.elapsedMs ?? null,
      accountsResearched: diag.accountsResearched ?? null,
      serperCalls,
      firecrawlCalls,
      openaiCalls,
      promptChars: lastOpenAIPromptChars,
      promptEstTokens: Math.round(lastOpenAIPromptChars / 4),
      requestBodyBytes: lastOpenAIRequestBodyBytes,
      responseBytes,
    };
  }
}

async function main() {
  const sizes = [1, 3, 5, 8, 10, 15, 20, 25, 50, 100, 150, 250];
  console.log('=== research-batch.js MECHANICS-ONLY chunk-size sweep ===');
  console.log('Zero injected network latency. Measures code-driven scaling only. NOT production runtime evidence.\n');
  const rows = [];
  for (const n of sizes) {
    // RESEARCH_BATCH_MAX_ACCOUNTS must be >= n or the server-side clamp
    // (api/research-batch.js) silently truncates the batch before this
    // script's accounts ever get processed -- pass n itself as the cap so
    // every requested size is actually exercised, not clamped down to 250.
    const row = await runOne(n, Math.max(n, 250));
    rows.push(row);
    console.log(`n=${String(n).padStart(4)}  status=${row.status}  wallMs=${String(row.wallMs).padStart(8)}  serverElapsedMs=${String(row.serverElapsedMs).padStart(6)}  serperCalls=${String(row.serperCalls).padStart(5)}  firecrawlCalls=${String(row.firecrawlCalls).padStart(4)}  openaiCalls=${row.openaiCalls}  promptChars=${String(row.promptChars).padStart(7)}  promptEstTokens=${String(row.promptEstTokens).padStart(6)}  responseBytes=${row.responseBytes}${row.error ? `  ERROR=${row.error}` : ''}`);
  }

  console.log('\n=== Derived scaling observations (still mechanics-only) ===');
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first && last && first.n !== last.n) {
    const nRatio = last.n / first.n;
    const wallRatio = first.wallMs > 0 ? last.wallMs / first.wallMs : null;
    const promptRatio = first.promptChars > 0 ? last.promptChars / first.promptChars : null;
    console.log(`Account count grew ${nRatio.toFixed(1)}x (n=${first.n} -> n=${last.n}).`);
    if (wallRatio !== null) console.log(`Mechanics-only wall-clock grew ${wallRatio.toFixed(1)}x over the same range (${first.wallMs}ms -> ${last.wallMs}ms).`);
    if (promptRatio !== null) console.log(`OpenAI prompt size grew ${promptRatio.toFixed(1)}x (${first.promptChars} chars -> ${last.promptChars} chars, ~${first.promptEstTokens} -> ~${last.promptEstTokens} tokens est.).`);
    console.log('Serper call count is expected to scale ~linearly with N (one query-set per account); Firecrawl call count is expected to plateau near its global cap (100 scrapes) once N is large enough to produce >100 eligible candidates.');
  }
  console.log('\nSee COMMERCIAL_READINESS_BENCHMARK.md for the real-provider, Preview-only procedure required before any of these numbers can be treated as production runtime evidence.');
}

main();
