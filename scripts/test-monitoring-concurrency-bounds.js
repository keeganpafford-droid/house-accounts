// Phase 2D items 10-11 -- dynamic proof that provider fan-out inside one
// Queue worker actually stays within its configured bound, not just that
// the code reads the right env var. Drives the REAL, production-bound
// `handler` export (mocked fetch only), same convention as
// scripts/test-weekly-monitoring-characterization.js. Concurrency is proven
// by making the mocked fetch resolve after a short real delay (so multiple
// in-flight calls can genuinely overlap) and tracking the maximum number of
// simultaneously-open calls per provider -- a mock that resolves instantly
// would make an unbounded-concurrency bug invisible (everything would
// appear "sequential" purely because nothing is ever actually in flight at
// the same time as anything else), so this file deliberately introduces
// that overlap window and then also asserts real overlap was observed
// (sanity: maxInFlight >= 2), so the headline assertion is not vacuously
// true.
//
// Usage: node scripts/test-monitoring-concurrency-bounds.js
import handler from '../api/research-batch.js';

const TEST_CRON_SECRET = 'concurrency-bounds-cron-secret-1122334455';

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

async function runMonitoring(accounts, fetchImpl) {
  const realFetch = global.fetch;
  global.fetch = fetchImpl;
  const req = { method: 'POST', headers: { authorization: `Bearer ${TEST_CRON_SECRET}` }, body: { mode: 'weekly-monitoring', accounts } };
  const res = makeRes();
  let threw = null;
  try { await handler(req, res); } catch (err) { threw = err; } finally { global.fetch = realFetch; }
  return { res, threw };
}

function trackConcurrency() {
  const state = { inFlight: 0, maxInFlight: 0 };
  return state;
}

// ---------------------------------------------------------------------------
// Item 10: monitoring Serper concurrency never exceeds
// MONITORING_SERPER_CONCURRENCY, for the weekly-monitoring path specifically.
// One account's own query plan (~10 queries by default) is dispatched
// through discoverCandidatesForAccounts()'s bounded mapLimit() -- each
// distinct query gets a distinct mocked candidate link so real (deduped)
// discovery work is happening, not just repeated identical results.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  process.env.MONITORING_SERPER_CONCURRENCY = '3';
  const serperState = trackConcurrency();
  const seenQueries = new Set();
  const { res, threw } = await runMonitoring([{ name: 'Concurrency Test Co' }], async (url, options) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      serperState.inFlight += 1;
      serperState.maxInFlight = Math.max(serperState.maxInFlight, serperState.inFlight);
      const body = JSON.parse(options.body);
      seenQueries.add(body.q);
      await new Promise(resolve => setTimeout(resolve, 8));
      serperState.inFlight -= 1;
      return {
        ok: true, status: 200,
        json: async () => ({ organic: [{
          title: `Concurrency Test Co -- ${body.q}`,
          snippet: `Concurrency Test Co announced something related to ${body.q} in 2026.`,
          link: `https://news.example.com/concurrency/${encodeURIComponent(body.q)}`,
          date: '2026-01-01'
        }] })
      };
    }
    if (u.includes('api.openai.com')) {
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: [] }), usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }) };
    }
    throw new Error(`unexpected fetch call (Serper concurrency test): ${u}`);
  });
  delete process.env.MONITORING_SERPER_CONCURRENCY;

  assert(threw === null, `the handler completes without throwing${threw ? `: ${threw.message}` : ''}`);
  assert(res.statusCode === 200, `the request succeeds (got ${res.statusCode})`);
  assert(seenQueries.size >= 6, `sanity: enough distinct queries actually fired for concurrency to be meaningfully observable (got ${seenQueries.size})`);
  assert(serperState.maxInFlight >= 2, `sanity: the mock actually produced real overlapping in-flight requests, so the bound below is not vacuously satisfied by accidental serial execution (observed max simultaneous ${serperState.maxInFlight})`);
  assert(serperState.maxInFlight <= 3, `REQUIRED (item 10): Serper concurrency never exceeds the configured MONITORING_SERPER_CONCURRENCY=3 for the weekly-monitoring path (observed max simultaneous ${serperState.maxInFlight})`);
}

// ---------------------------------------------------------------------------
// Item 10 (default): with MONITORING_SERPER_CONCURRENCY unset, the
// documented default (4) applies -- not an accidental fallback to unbounded
// Promise.all.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  delete process.env.MONITORING_SERPER_CONCURRENCY;
  const serperState = trackConcurrency();
  const seenQueries = new Set();
  const { threw } = await runMonitoring([{ name: 'Default Concurrency Co' }], async (url, options) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      serperState.inFlight += 1;
      serperState.maxInFlight = Math.max(serperState.maxInFlight, serperState.inFlight);
      const body = JSON.parse(options.body);
      seenQueries.add(body.q);
      await new Promise(resolve => setTimeout(resolve, 8));
      serperState.inFlight -= 1;
      return { ok: true, status: 200, json: async () => ({ organic: [{ title: `Default Concurrency Co -- ${body.q}`, snippet: `Default Concurrency Co event related to ${body.q}.`, link: `https://news.example.com/default/${encodeURIComponent(body.q)}`, date: '2026-01-01' }] }) };
    }
    if (u.includes('api.openai.com')) {
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: [] }), usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }) };
    }
    throw new Error(`unexpected fetch call (default concurrency test): ${u}`);
  });
  assert(threw === null, `the default-concurrency request completes without throwing${threw ? `: ${threw.message}` : ''}`);
  assert(serperState.maxInFlight >= 2, `sanity: real overlap was observed with the default concurrency (observed ${serperState.maxInFlight})`);
  assert(serperState.maxInFlight <= 4, `REQUIRED (item 10): with MONITORING_SERPER_CONCURRENCY unset, the documented default of 4 is the effective bound, not unbounded Promise.all (observed max simultaneous ${serperState.maxInFlight})`);
}

// ---------------------------------------------------------------------------
// Item 11: Firecrawl remains within its existing bound (up to 6 per
// account, via enrichCandidatesWithFirecrawl()'s unchanged perAccountLimit),
// for the SAME weekly-monitoring path now that Serper is bounded. Eight
// distinct discovered candidates are supplied for one account so the
// per-account cap itself (not merely a small input set) is what is actually
// exercised.
// ---------------------------------------------------------------------------
{
  setBaseEnv({ firecrawl: true });
  process.env.MONITORING_SERPER_CONCURRENCY = '4';
  const firecrawlState = trackConcurrency();
  let firecrawlRequestCount = 0;
  // Eight genuinely distinct business events (different signal families/
  // months/named tokens) so clusterCandidates()'s eventFingerprint-based
  // dedup (company|family|subtype|month|namedTokens) keeps them as 8
  // separate candidates for this one account, rather than collapsing
  // near-identical filler text into a single cluster -- that would make
  // the per-account cap of 6 untestable (nothing to cap against).
  const events = [
    { slug: 'facility', title: 'Firecrawl Bound Co opens new distribution facility', snippet: 'Firecrawl Bound Co held a ribbon cutting for its new distribution center facility expansion.', date: '2026-01-05' },
    { slug: 'hiring', title: 'Firecrawl Bound Co hiring for talent acquisition team', snippet: 'Firecrawl Bound Co is now hiring for its talent acquisition and people operations team.', date: '2026-02-05' },
    { slug: 'leadership', title: 'Firecrawl Bound Co names new chief financial officer', snippet: 'Firecrawl Bound Co appointed a new chief financial officer this quarter.', date: '2026-03-05' },
    { slug: 'product', title: 'Firecrawl Bound Co unveiled new product rollout', snippet: 'Firecrawl Bound Co unveiled a new product launch for its outdoor gear division.', date: '2026-04-05' },
    { slug: 'event', title: 'Firecrawl Bound Co exhibitor at national trade show', snippet: 'Firecrawl Bound Co was an exhibitor booth sponsor at the national trade show conference.', date: '2026-05-05' },
    { slug: 'award', title: 'Firecrawl Bound Co wins fastest growing company award', snippet: 'Firecrawl Bound Co was recognized as a fastest growing company award winner.', date: '2026-06-05' },
    { slug: 'acquisition', title: 'Firecrawl Bound Co announces acquisition of competitor', snippet: 'Firecrawl Bound Co announced the acquisition of a regional competitor via merger.', date: '2026-07-05' },
    { slug: 'partnership', title: 'Firecrawl Bound Co awarded major contract partnership', snippet: 'Firecrawl Bound Co was awarded a major contract partnership deal, selected by a new customer.', date: '2026-08-05' }
  ];
  const { res, threw } = await runMonitoring([{ name: 'Firecrawl Bound Co' }], async (url, options) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      // Every query returns the SAME 8 distinct candidate events so
      // enrichCandidatesWithFirecrawl() has more than 6 real deduped
      // candidates to choose from for this one account.
      return { ok: true, status: 200, json: async () => ({ organic: events.map(e => ({
        title: e.title, snippet: e.snippet, link: `https://news.example.com/firecrawl-bound-${e.slug}`, date: e.date
      })) }) };
    }
    if (u.includes('firecrawl.dev')) {
      firecrawlRequestCount += 1;
      firecrawlState.inFlight += 1;
      firecrawlState.maxInFlight = Math.max(firecrawlState.maxInFlight, firecrawlState.inFlight);
      await new Promise(resolve => setTimeout(resolve, 8));
      firecrawlState.inFlight -= 1;
      return { ok: true, status: 200, json: async () => ({ data: { markdown: 'Some scraped page content about Firecrawl Bound Co.' } }) };
    }
    if (u.includes('api.openai.com')) {
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: [] }), usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }) };
    }
    throw new Error(`unexpected fetch call (Firecrawl bound test): ${u}`);
  });
  delete process.env.MONITORING_SERPER_CONCURRENCY;

  assert(threw === null, `the Firecrawl-bound request completes without throwing${threw ? `: ${threw.message}` : ''}`);
  assert(res.statusCode === 200, `the request succeeds (got ${res.statusCode})`);
  assert(firecrawlRequestCount <= 6, `REQUIRED (item 11): Firecrawl requests for one account never exceed its existing per-account bound of 6, unchanged by Phase 2D (observed ${firecrawlRequestCount} requests against 8 available candidates)`);
  assert(firecrawlRequestCount >= 4, `sanity: enough of the 8 distinct events actually survived scoring/dedup to make the 6-per-account cap a meaningful boundary, not an accidentally-small input (observed ${firecrawlRequestCount})`);
  assert(firecrawlState.maxInFlight <= 6, `REQUIRED (item 11): Firecrawl's own simultaneous in-flight bound (mapLimit's concurrency of 8, further capped by the 6-per-account selection) is preserved (observed max simultaneous ${firecrawlState.maxInFlight})`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
