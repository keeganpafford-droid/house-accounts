// House Accounts -- matched PRE-FIX vs POST-FIX signal-quality comparison.
// PASTE THIS INTO THE BROWSER CONSOLE ON EACH PREVIEW DEPLOYMENT.
//
// Cross-origin note: api/research-batch.js sets no CORS headers (confirmed
// by inspection) and vercel.json has no global CORS config either, so a
// single script cannot safely call both Preview deployments from one tab --
// the browser would block it. This ONE script is reused on both origins
// instead: it only ever calls the relative /api/research-batch path, so it
// automatically hits whichever Preview deployment's page it's pasted into.
//
// EDIT THESE TWO LINES BEFORE EACH PASTE, THEN RUN:
const VERSION_LABEL = 'EDIT ME: PRE-FIX or POST-FIX';
const COMPANY = 'Avidia Bank'; // 'Avidia Bank' | 'Arthur J. Gallagher' | 'Lonza'
//
// Recommended execution order (keeps each company's PRE vs POST samples
// close in time, which is what actually matters for this comparison --
// interleaving Avidia against Gallagher does not):
//   1. Pre-fix tab:  VERSION_LABEL='PRE-FIX',  COMPANY='Avidia Bank'         -> paste, run, copy JSON
//   2. Post-fix tab: VERSION_LABEL='POST-FIX', COMPANY='Avidia Bank'         -> paste, run, copy JSON
//   3. Pre-fix tab:  VERSION_LABEL='PRE-FIX',  COMPANY='Arthur J. Gallagher' -> paste, run, copy JSON
//   4. Post-fix tab: VERSION_LABEL='POST-FIX', COMPANY='Arthur J. Gallagher' -> paste, run, copy JSON
//   5. Pre-fix tab:  VERSION_LABEL='PRE-FIX',  COMPANY='Lonza'               -> paste, run, copy JSON
//   6. Post-fix tab: VERSION_LABEL='POST-FIX', COMPANY='Lonza'               -> paste, run, copy JSON
//
// Runs 3 sequential requests for COMPANY, anonymous no-uploadId path (zero
// DB reads/writes, same as every prior benchmark this round). Pre-fix has
// no timeout protection -- a slow run there may hit Vercel's ~58s 504;
// this is recorded honestly as a result, not treated as a script error.

(async function houseAccountsPrePostQualityComparison() {
  const ENDPOINT = '/api/research-batch';
  const REPEATS = 3;
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
        ? `Client-side abort after ${CLIENT_ABORT_MS}ms with no response -- treat as a hang/timeout (expected possibility on pre-fix).`
        : (err && err.message) || String(err);
    } finally {
      clearTimeout(timer);
    }
    const wallMs = Math.round(performance.now() - t0);
    const diag = (json && json.diagnostics) || {};
    const summary = diag.structuredSummary || {};
    return {
      wallMs,
      serverElapsedMs: typeof diag.elapsedMs === 'number' ? diag.elapsedMs : null,
      httpStatus: res ? res.status : null,
      result: errorMessage ? `ERROR: ${errorMessage}` : (res && res.ok ? 'OK' : 'UNKNOWN'),
      // Diagnostics already present in the response body on BOTH SHAs
      // (confirmed identical shape via diff) -- no new instrumentation.
      rankedCandidates: typeof diag.rankedCandidates === 'number' ? diag.rankedCandidates : null,
      rawSignals: typeof diag.rawSignals === 'number' ? diag.rawSignals : null,
      signalsRejected: typeof diag.signalsRejected === 'number' ? diag.signalsRejected : null,
      signalsReturned: typeof diag.signalsReturned === 'number' ? diag.signalsReturned : null,
      failedAccounts: typeof summary.failedAccounts === 'number' ? summary.failedAccounts : null,
      failureReasons: summary.failureReasons || null,
      signalCount: Array.isArray(json && json.signals) ? json.signals.length : 0,
      signals: Array.isArray(json && json.signals) ? json.signals.map(s => ({
        signalType: s.signalType || s.signal_type || null,
        headline: s.signalTitle || s.headline || s.whatChanged || null,
        whyThisMatters: s.whyThisMatters || s.why_this_matters || null,
        eventDate: s.eventDate || s.event_date || null,
        confidence: s.confidenceScore ?? s.confidence ?? null,
        sourceUrl: s.sourceUrl || s.source_url || null,
        corroboratingCandidates: s.corroboratingCandidates ?? null,
        isFallbackOpportunity: !!s.isFallbackOpportunity,
      })) : [],
    };
  }

  console.log(`%cHouse Accounts PRE/POST-FIX quality comparison -- ${VERSION_LABEL} -- ${COMPANY}`, 'font-weight:bold;font-size:14px');
  if (VERSION_LABEL.startsWith('EDIT ME')) console.error('Set VERSION_LABEL before running -- output will be ambiguous otherwise.');
  console.warn('Confirm your address bar shows the deployment you intend to test (pre-fix vs post-fix) before this runs.');

  const runs = [];
  for (let i = 1; i <= REPEATS; i++) {
    console.log(`\nRun ${i}/${REPEATS}: requesting "${COMPANY}" ...`);
    const r = await singleRequest(COMPANY);
    runs.push({ version: VERSION_LABEL, company: COMPANY, run: i, ...r });
    console.log(`  -> wallMs=${r.wallMs} serverElapsedMs=${r.serverElapsedMs} HTTP=${r.httpStatus} result=${r.result} rankedCandidates=${r.rankedCandidates} rawSignals=${r.rawSignals} signalsReturned=${r.signalCount}`);
    r.signals.forEach((s, idx) => {
      console.log(`    [${idx + 1}] ${s.signalType || '(untyped)'} -- ${s.headline || '(no headline)'} | date=${s.eventDate || '?'} | confidence=${s.confidence} | source=${s.sourceUrl || '(none)'}`);
    });
  }

  console.log('\n%cResults table:', 'font-weight:bold');
  console.table(runs.map(r => ({
    Version: r.version, Company: r.company, Run: r.run,
    'Wall ms': r.wallMs, 'Server elapsedMs': r.serverElapsedMs, HTTP: r.httpStatus,
    'Ranked candidates': r.rankedCandidates, 'Raw signals': r.rawSignals, 'Signals returned': r.signalCount,
    Result: r.result,
  })));

  const output = { comparison: 'pre-fix vs post-fix signal quality', version: VERSION_LABEL, company: COMPANY, runs };
  console.log('\n%cCopy this JSON back:', 'font-weight:bold');
  console.log(JSON.stringify(output, null, 2));
  window.__houseAccountsPrePostResult = output;
  console.log('\n(Also saved to window.__houseAccountsPrePostResult -- run copy(JSON.stringify(window.__houseAccountsPrePostResult)) for clipboard.)');
})();
