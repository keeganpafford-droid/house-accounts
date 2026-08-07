// House Accounts -- research-batch.js REAL-PROVIDER runtime benchmark.
// PASTE THIS ENTIRE FILE INTO THE BROWSER CONSOLE ON THE PREVIEW DEPLOYMENT.
//
// Calls the real, unmodified /api/research-batch endpoint with mode
// 'warm-account' -- the exact mode dashboard/index.html's
// researchListFromManageModal() ("Research Entire List") sends for its
// warm/mixed accounts -- and a per-account payload shape matching
// batchPayloadForAccounts() in that same file.
//
// Deliberately sends NO uploadId, researchRunId, attemptId, or
// researchRunAction. This is api/research-batch.js's own pre-existing
// "anonymous prospecting" code path (the same one prospect_script.js /
// prospects/index.html already use in production) -- confirmed by direct
// reading of api/research-batch.js that this path skips
// resolveAuthenticatedUploadOwner() entirely (gated on `if (targetUploadId)`
// at :2305), skips the researchRunId/attemptId requirement (:2456-2460),
// skips the heartbeat-lease gate and background renewal loop (both gated
// on `if (targetUploadId)` at :2463), and skips the duplicate-company
// collision check and its persistRunTargetCompanyKeys() write (gated on
// `if (targetUploadId)` at :2525). Combined with the separately-confirmed
// fact that this file never writes to ha_accounts or ha_signals under any
// payload shape (its only DB writes are ha_research_runs bookkeeping rows,
// all of which are themselves gated on uploadId being present), omitting
// uploadId guarantees this benchmark performs ZERO database reads or writes
// of any kind. No auth header is required or sent for this same reason.
//
// Runs tiers 1 -> 3 -> 5 -> 8 -> 10 SEQUENTIALLY (never concurrently).
// Auto-stops on error, on ~45s (approaching the 58s hard ceiling), or on
// ~35s (the desired internal ceiling) -- never auto-escalates past that,
// never tests 15/20, and never repeats a tier automatically.

(async function houseAccountsResearchBatchBenchmark() {
  // ---------------------------------------------------------------------
  // CONFIG -- edit freely. SPARSE especially: swap in any real small local
  // business you know for higher confidence than a guessed-from-memory name.
  // ---------------------------------------------------------------------
  const TIERS = [1, 3, 5, 8, 10];
  const SOFT_STOP_MS = 35000; // desired internal ceiling
  const HARD_STOP_MS = 45000; // approaching the 58s hard ceiling
  const CLIENT_ABORT_MS = 70000; // safety valve so a genuine network hang can't block the console forever
  const ENDPOINT = '/api/research-batch';

  // Real companies, high web-evidence ("well-known").
  const WELL_KNOWN = [
    'Cardinal Health', 'The Home Depot', 'FedEx', 'Whirlpool Corporation',
    'Coca-Cola', 'UPS', '3M', 'Kroger', 'Nationwide Mutual Insurance',
    'Honda of America Mfg', 'Procter & Gamble', 'Marathon Petroleum',
  ];
  // Real companies, moderate/regional web-evidence ("ordinary").
  const ORDINARY = [
    'Worthington Industries', 'Bob Evans Farms', "Jeni's Splendid Ice Creams",
    'Donatos Pizza', 'Root Insurance', 'Express Inc', 'Bath & Body Works',
    'Skyline Chili', 'Nationwide Children\'s Hospital Foundation',
  ];
  // Smaller/quieter real companies ("sparse"). Confidence here is lower than
  // the two pools above -- swap any of these for a specific small local
  // business you personally know exists if you want more certainty.
  const SPARSE = [
    'Anchor Hocking', 'Northstar Cafe', 'Middle West Spirits',
    'Watershed Distillery', 'Land-Grant Brewing Company', 'Homage LLC',
  ];

  // -----------------------------------------------------------------------
  const used = new Set();
  function pickN(pool, n) {
    const out = [];
    for (const name of pool) {
      if (out.length >= n) break;
      if (used.has(name)) continue;
      out.push(name);
      used.add(name);
    }
    if (out.length < n) {
      throw new Error(`Company pool exhausted: need ${n} more distinct names than are left. Add more entries to WELL_KNOWN/ORDINARY/SPARSE above and re-paste.`);
    }
    return out;
  }

  function buildTierCompanies(n) {
    // Roughly a 1/3-1/3-1/3 mix, always at least one well-known company so
    // the batch has qualifying candidates and exercises the main synthesis
    // path (a batch with zero candidates across every account falls back to
    // a different, smaller OpenAI web-search prompt -- not what we're
    // measuring here).
    const wellKnown = Math.max(1, Math.round(n / 3));
    const sparse = n >= 3 ? Math.max(1, Math.round(n / 3)) : 0;
    const ordinary = Math.max(0, n - wellKnown - sparse);
    return [...pickN(WELL_KNOWN, wellKnown), ...pickN(ORDINARY, ordinary), ...pickN(SPARSE, sparse)];
  }

  // Materially equivalent to dashboard/index.html's batchPayloadForAccounts()
  // output shape, for a fresh prospect with no purchase history.
  function accountPayload(name) {
    return {
      name,
      industry: '',
      cityState: '',
      notes: '',
      website: '',
      orderCount: 0,
      revenue: 0,
      relationshipStrength: '',
      quickWinScore: '',
      categories: [],
      contacts: [],
      recentOrderDates: [],
      existingSignals: [],
      repeatPatterns: [],
      intelligenceMode: 'warm',
      assignedRep: '',
    };
  }

  async function runTier(n) {
    const companies = buildTierCompanies(n);
    const body = { mode: 'warm-account', accounts: companies.map(accountPayload) };

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), CLIENT_ABORT_MS);
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
      clearTimeout(abortTimer);
    }
    const wallMs = Math.round(performance.now() - t0);
    const diag = (json && json.diagnostics) || {};
    const summary = diag.structuredSummary || {};

    return {
      tier: n,
      requestedAccounts: n,
      companies,
      accountsAttempted: diag.accountsResearched ?? summary.processedAccounts ?? null,
      wallMs,
      serverElapsedMs: typeof diag.elapsedMs === 'number' ? diag.elapsedMs : null,
      httpStatus: res ? res.status : null,
      ok: !!(res && res.ok) && !errorMessage,
      signalsReturned: Array.isArray(json && json.signals) ? json.signals.length : null,
      failedAccounts: summary.failedAccounts ?? null,
      failureReasons: summary.failureReasons ?? null,
      errorMessage,
    };
  }

  console.log('%cHouse Accounts research-batch.js runtime benchmark', 'font-weight:bold;font-size:14px');
  console.log(`Endpoint: ${ENDPOINT} | Tiers: ${TIERS.join(' -> ')} | Soft stop: ~${SOFT_STOP_MS / 1000}s | Hard stop: ~${HARD_STOP_MS / 1000}s`);
  console.warn('Confirm your address bar shows the PREVIEW deployment, not Production, before this runs.');

  const results = [];
  for (const n of TIERS) {
    console.log(`\n--- Tier n=${n}: sending real request (this makes real OpenAI/Serper/Firecrawl calls)... ---`);
    const r = await runTier(n);
    results.push(r);

    const worstMs = Math.max(r.wallMs, r.serverElapsedMs || 0);
    console.log(
      `Tier n=${n} finished: wallMs=${r.wallMs} serverElapsedMs=${r.serverElapsedMs} httpStatus=${r.httpStatus} ` +
      `signals=${r.signalsReturned} error=${r.errorMessage || 'none'}`
    );

    if (r.errorMessage || !r.ok) {
      console.warn(`STOPPING: tier n=${n} errored or failed. Treat this as strong evidence the safe chunk size is smaller than ${n}.`);
      break;
    }
    if (worstMs >= HARD_STOP_MS) {
      console.warn(`STOPPING: tier n=${n} took ${worstMs}ms, at/above the ~${HARD_STOP_MS / 1000}s hard-stop threshold (approaching the 58s ceiling). Do not test a larger size than this.`);
      break;
    }
    if (worstMs >= SOFT_STOP_MS) {
      console.warn(`STOPPING PROGRESSION: tier n=${n} took ${worstMs}ms, at/above the ~${SOFT_STOP_MS / 1000}s internal ceiling. This tier (or smaller) is your likely starting point -- do not escalate further automatically.`);
      break;
    }
  }

  console.log('\n%cResults table:', 'font-weight:bold');
  console.table(results.map(r => ({
    Tier: r.tier,
    Accounts: r.accountsAttempted ?? r.requestedAccounts,
    'Wall ms': r.wallMs,
    'Server elapsedMs': r.serverElapsedMs,
    HTTP: r.httpStatus,
    'Signals/Results': r.signalsReturned,
    Result: r.errorMessage ? `ERROR: ${r.errorMessage}` : 'OK',
  })));

  const output = {
    benchmark: 'research-batch.js real-provider runtime ladder',
    endpoint: ENDPOINT,
    mode: 'warm-account',
    softStopMs: SOFT_STOP_MS,
    hardStopMs: HARD_STOP_MS,
    note: 'No uploadId/auth sent -- anonymous prospecting code path, zero DB writes. Real OpenAI/Serper/Firecrawl calls were made; this is NOT a mock.',
    tiers: results,
  };
  console.log('\n%cCopy this JSON back:', 'font-weight:bold');
  console.log(JSON.stringify(output, null, 2));
  window.__houseAccountsBenchmarkResult = output;
  console.log('\n(Also saved to window.__houseAccountsBenchmarkResult -- run copy(JSON.stringify(window.__houseAccountsBenchmarkResult)) to grab it via clipboard instead of selecting console text.)');
})();
