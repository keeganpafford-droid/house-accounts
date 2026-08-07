// House Accounts -- single-account tail-latency diagnostic.
// PASTE THIS ENTIRE FILE INTO THE BROWSER CONSOLE ON THE PREVIEW DEPLOYMENT.
//
// Purpose: reproduce the bimodal timing already observed for "The Home
// Depot" as a single-account request (17.3s success vs 58.6s/504) by
// repeating the IDENTICAL request several times sequentially. This is
// deliberately NOT a broad ladder -- same company every time, so any
// variance observed is attributable to the pipeline itself, not to
// workload difficulty.
//
// Same anonymous no-uploadId/no-auth request shape as the prior benchmarks
// (zero DB reads/writes -- see api/research-batch.js's own gating logic).
//
// CRITICAL: for any run that is slow or returns a 504, the browser gets
// NOTHING useful -- a Vercel platform timeout discards the entire response
// body. The only way to see where that run actually spent its time is to
// pull that exact invocation's Vercel function logs (Vercel dashboard ->
// this Preview deployment -> Logs/Functions tab, filtered to the request
// time window, or `vercel logs <preview-url> --output raw`) and look for
// these checkpoint lines (each now carries an explicit elapsedMs field):
//
//   [Prospect Research] Request received            {elapsedMs: ...}
//   [Prospect Research] Targeted search complete     {elapsedMs: ...}
//   [Prospect Research] Firecrawl enrichment complete {elapsedMs: ...}
//   [Prospect Research] OpenAI synthesis starting     {elapsedMs: ...}
//   [Prospect Research] LLM opportunity parser complete {elapsedMs: ...}
//
// Whichever of these is the LAST one present for a given invocation tells
// you which stage the platform was still inside when it force-killed the
// request (a genuine platform timeout runs no further code at all -- no
// catch, no cleanup -- so the last log line IS the answer).

(async function houseAccountsTailLatencyDiagnostic() {
  const ENDPOINT = '/api/research-batch';
  const COMPANY = 'The Home Depot'; // the exact company already showing bimodal behavior
  const REPEATS = 5;
  const CLIENT_ABORT_MS = 70000;

  function accountPayload(name) {
    return {
      name, industry: '', cityState: '', notes: '', website: '',
      orderCount: 0, revenue: 0, relationshipStrength: '', quickWinScore: '',
      categories: [], contacts: [], recentOrderDates: [], existingSignals: [],
      repeatPatterns: [], intelligenceMode: 'warm', assignedRep: '',
    };
  }

  async function singleRequest(name) {
    const body = { mode: 'warm-account', accounts: [accountPayload(name)] };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_ABORT_MS);
    const t0 = performance.now();
    let res = null, json = null, errorMessage = null;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      json = await res.json().catch(() => ({}));
      if (!res.ok) errorMessage = (json && json.error) || `HTTP ${res.status}`;
    } catch (err) {
      errorMessage = err && err.name === 'AbortError'
        ? `Client-side abort after ${CLIENT_ABORT_MS}ms with no response -- treat as a hang/timeout.`
        : (err && err.message) || String(err);
    } finally {
      clearTimeout(timer);
    }
    const wallMs = Math.round(performance.now() - t0);
    const diag = (json && json.diagnostics) || {};
    return {
      wallMs,
      serverElapsedMs: typeof diag.elapsedMs === 'number' ? diag.elapsedMs : null,
      httpStatus: res ? res.status : null,
      ok: !!(res && res.ok) && !errorMessage,
      signalsReturned: Array.isArray(json && json.signals) ? json.signals.length : null,
      errorMessage,
    };
  }

  console.log('%cHouse Accounts single-account tail-latency diagnostic', 'font-weight:bold;font-size:14px');
  console.log(`Company: "${COMPANY}" | Repeats: ${REPEATS} | Sequential (never concurrent)`);
  console.warn('Confirm your address bar shows the PREVIEW deployment, not Production, before this runs.');
  console.warn('For any slow or 504 run below, pull Vercel function logs for that exact invocation and read the elapsedMs-tagged checkpoint lines -- the browser has no useful diagnostics for a timed-out request.');

  const results = [];
  for (let i = 1; i <= REPEATS; i++) {
    console.log(`\nRun ${i}/${REPEATS}: requesting "${COMPANY}" ...`);
    const r = await singleRequest(COMPANY);
    results.push({ run: i, ...r });
    console.log(`  -> wallMs=${r.wallMs} serverElapsedMs=${r.serverElapsedMs} HTTP=${r.httpStatus} signals=${r.signalsReturned} error=${r.errorMessage || 'none'}`);
  }

  console.log('\n%cResults table:', 'font-weight:bold');
  console.table(results.map(r => ({
    Run: r.run,
    Company: COMPANY,
    'Wall ms': r.wallMs,
    'Server elapsedMs': r.serverElapsedMs,
    HTTP: r.httpStatus,
    Signals: r.signalsReturned,
    Result: r.errorMessage ? `ERROR: ${r.errorMessage}` : 'OK',
  })));

  const output = {
    benchmark: 'single-account tail-latency diagnostic',
    company: COMPANY,
    repeats: REPEATS,
    endpoint: ENDPOINT,
    mode: 'warm-account',
    note: 'For any slow/timed-out run above, cross-reference this exact invocation\'s Vercel function logs for the elapsedMs-tagged stage-timing checkpoints added on scale/research-runtime-benchmark. The browser response body is empty/absent on a 504 -- only server logs that already flushed before the platform kill contain useful signal.',
    results,
  };
  console.log('\n%cCopy this JSON back:', 'font-weight:bold');
  console.log(JSON.stringify(output, null, 2));
  window.__houseAccountsTailLatencyResult = output;
  console.log('\n(Also saved to window.__houseAccountsTailLatencyResult -- run copy(JSON.stringify(window.__houseAccountsTailLatencyResult)) for clipboard.)');
})();
