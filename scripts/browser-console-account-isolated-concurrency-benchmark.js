// House Accounts -- account-isolated concurrency benchmark (Stage A/B/C).
// PASTE THIS ENTIRE FILE INTO THE BROWSER CONSOLE ON THE PREVIEW DEPLOYMENT.
//
// Question: can bounded parallelism across independent, ONE-account
// /api/research-batch requests give acceptable whole-list throughput
// without putting multiple companies inside one long-running invocation?
//
// Same anonymous, no-uploadId, no-auth request shape as the prior chunk-size
// benchmark -- confirmed by direct code inspection (api/research-batch.js)
// to skip resolveAuthenticatedUploadOwner(), the researchRunId/attemptId
// requirement, the heartbeat-lease gate, and the duplicate-company check
// (all gated on `if (targetUploadId)`), and the file writes NOTHING to
// ha_accounts/ha_signals under any payload shape. Zero DB reads or writes.
// mapLimit() and every other piece of per-request state is locally scoped
// (verified -- no module-level mutable accumulator, no rate-limiter, no
// semaphore anywhere in the file), so concurrent invocations cannot
// interfere with each other's in-memory state.
//
// Stage A: 3 sequential single-account requests (well-known / ordinary /
//          sparse). Stops here if any is unhealthy.
// Stage B: 2 concurrent single-account requests (only if A is healthy).
// Stage C: 4 concurrent single-account requests (only if B is healthy).
// Never escalates concurrency above 4. Never auto-repeats a stage.

(async function houseAccountsConcurrencyBenchmark() {
  const ENDPOINT = '/api/research-batch';
  const CLIENT_ABORT_MS = 70000; // safety valve against a genuine hang
  const STAGE_A_STOP_MS = 45000; // "approaches ~45-50s" -> trigger stopping before concurrency
  const CONCURRENT_STOP_MS = 50000; // Stage B/C: any individual request at/above this = stop
  const THROTTLE_RATIO_WARN = 1.5; // individual concurrent time vs Stage A sequential baseline

  // Real companies. WELL_KNOWN/ORDINARY are high-confidence real; SPARSE is
  // lower-confidence from memory -- swap in a specific small local business
  // you know if you want more certainty. Distinct names are used across all
  // of Stage A+B+C (9 total needed); pools have headroom beyond that.
  const WELL_KNOWN = [
    'Cardinal Health', 'The Home Depot', 'FedEx', 'Whirlpool Corporation',
    'Coca-Cola', 'UPS', '3M', 'Kroger', 'Nationwide Mutual Insurance',
    'Honda of America Mfg', 'Procter & Gamble', 'Marathon Petroleum',
  ];
  const ORDINARY = [
    'Worthington Industries', 'Bob Evans Farms', "Jeni's Splendid Ice Creams",
    'Donatos Pizza', 'Root Insurance', 'Express Inc', 'Bath & Body Works',
    'Skyline Chili', "Nationwide Children's Hospital Foundation",
  ];
  const SPARSE = [
    'Anchor Hocking', 'Northstar Cafe', 'Middle West Spirits',
    'Watershed Distillery', 'Land-Grant Brewing Company', 'Homage LLC',
  ];

  const used = new Set();
  function pickN(pool, n) {
    const out = [];
    for (const name of pool) {
      if (out.length >= n) break;
      if (used.has(name)) continue;
      out.push(name);
      used.add(name);
    }
    if (out.length < n) throw new Error(`Company pool exhausted: need ${n} more distinct names. Add entries to WELL_KNOWN/ORDINARY/SPARSE above and re-paste.`);
    return out;
  }

  function accountPayload(name) {
    return {
      name, industry: '', cityState: '', notes: '', website: '',
      orderCount: 0, revenue: 0, relationshipStrength: '', quickWinScore: '',
      categories: [], contacts: [], recentOrderDates: [], existingSignals: [],
      repeatPatterns: [], intelligenceMode: 'warm', assignedRep: '',
    };
  }

  function band(ms) {
    if (ms == null) return 'unknown';
    if (ms < 35000) return 'excellent (<35s)';
    if (ms < 40000) return 'healthy (35-40s)';
    if (ms < 45000) return 'watch carefully (40-45s)';
    if (ms < 50000) return 'uncomfortable (45-50s)';
    return 'unsuitable (50s+)';
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
      company: name,
      wallMs,
      serverElapsedMs: typeof diag.elapsedMs === 'number' ? diag.elapsedMs : null,
      httpStatus: res ? res.status : null,
      ok: !!(res && res.ok) && !errorMessage,
      signalsReturned: Array.isArray(json && json.signals) ? json.signals.length : null,
      errorMessage,
    };
  }

  function worstOf(r) { return Math.max(r.wallMs, r.serverElapsedMs || 0); }

  console.log('%cHouse Accounts account-isolated concurrency benchmark', 'font-weight:bold;font-size:14px');
  console.warn('Confirm your address bar shows the PREVIEW deployment, not Production, before this runs.');

  const tableRows = [];
  const stageResults = { A: [], B: null, C: null };
  let stopped = false, stopReason = '';

  function addRows(stage, concurrency, results, groupWallMs, baselineAvg) {
    results.forEach(r => {
      tableRows.push({
        Stage: stage,
        Concurrency: concurrency,
        Company: r.company,
        'Server elapsedMs': r.serverElapsedMs,
        'Wall ms': r.wallMs,
        'Group wall ms': groupWallMs,
        Signals: r.signalsReturned,
        HTTP: r.httpStatus,
        'Slowdown vs sequential': baselineAvg ? `${(worstOf(r) / baselineAvg).toFixed(2)}x` : 'n/a (baseline)',
        Result: r.errorMessage ? `ERROR: ${r.errorMessage}` : 'OK',
      });
    });
  }

  // ---------------------------------------------------------------------
  // STAGE A -- 3 sequential single-account requests
  // ---------------------------------------------------------------------
  console.log('\n%cSTAGE A -- 3 sequential single-account requests', 'font-weight:bold;font-size:13px');
  const stageACompanies = [...pickN(WELL_KNOWN, 1), ...pickN(ORDINARY, 1), ...pickN(SPARSE, 1)];
  for (const name of stageACompanies) {
    console.log(`Requesting: ${name} ...`);
    const r = await singleRequest(name);
    stageResults.A.push(r);
    const worst = worstOf(r);
    console.log(`  -> wallMs=${r.wallMs} serverElapsedMs=${r.serverElapsedMs} HTTP=${r.httpStatus} signals=${r.signalsReturned} error=${r.errorMessage || 'none'} [${band(worst)}]`);
    if (r.errorMessage || !r.ok) {
      stopped = true;
      stopReason = `Stage A: "${name}" errored/failed. Stopping before any concurrency testing.`;
      break;
    }
    if (worst >= STAGE_A_STOP_MS) {
      stopped = true;
      stopReason = `Stage A: "${name}" took ${worst}ms, approaching the 45-50s danger zone. Stopping before any concurrency testing.`;
      break;
    }
  }
  addRows('A', 1, stageResults.A, null, null);

  const baselineAvgMs = stageResults.A.length
    ? Math.round(stageResults.A.reduce((s, r) => s + worstOf(r), 0) / stageResults.A.length)
    : null;

  // ---------------------------------------------------------------------
  // STAGE B -- 2-way concurrency (only if Stage A was fully healthy)
  // ---------------------------------------------------------------------
  if (stopped) {
    console.warn(`\n${stopReason}`);
  } else {
    console.log('\n%cSTAGE B -- 2-way concurrency', 'font-weight:bold;font-size:13px');
    const stageBCompanies = [...pickN(WELL_KNOWN, 1), ...pickN(ORDINARY, 1)];
    const t0 = performance.now();
    const stageBResults = await Promise.all(stageBCompanies.map(singleRequest));
    const groupWallMs = Math.round(performance.now() - t0);
    stageResults.B = { companies: stageBCompanies, results: stageBResults, groupWallMs };
    addRows('B', 2, stageBResults, groupWallMs, baselineAvgMs);
    stageBResults.forEach(r => {
      const worst = worstOf(r);
      const slowdown = baselineAvgMs ? (worst / baselineAvgMs).toFixed(2) : 'n/a';
      console.log(`  ${r.company}: wallMs=${r.wallMs} serverElapsedMs=${r.serverElapsedMs} HTTP=${r.httpStatus} signals=${r.signalsReturned} error=${r.errorMessage || 'none'} slowdownVsSequential=${slowdown}x [${band(worst)}]`);
    });
    console.log(`  Group wall-clock (both together): ${groupWallMs}ms`);

    const worstB = Math.max(...stageBResults.map(worstOf));
    const hasErrorB = stageBResults.some(r => r.errorMessage || !r.ok);
    const throttleB = baselineAvgMs && stageBResults.some(r => worstOf(r) / baselineAvgMs >= THROTTLE_RATIO_WARN);

    if (hasErrorB) { stopped = true; stopReason = 'Stage B: at least one concurrent request errored/failed. Concurrency is NOT safe -- stopping before 4-way.'; }
    else if (worstB >= CONCURRENT_STOP_MS) { stopped = true; stopReason = `Stage B: an individual request reached ${worstB}ms (>=50s zone). Stopping before 4-way concurrency.`; }
    else if (throttleB) { stopped = true; stopReason = `Stage B: an individual request was >=${THROTTLE_RATIO_WARN}x slower than the sequential baseline (${baselineAvgMs}ms) -- possible provider contention. Stopping before 4-way concurrency.`; }

    if (stopped) {
      console.warn(`\n${stopReason}`);
    } else {
      // ---------------------------------------------------------------
      // STAGE C -- 4-way concurrency (only if Stage B was fully healthy)
      // ---------------------------------------------------------------
      console.log('\n%cSTAGE C -- 4-way concurrency', 'font-weight:bold;font-size:13px');
      const stageCCompanies = [...pickN(WELL_KNOWN, 1), ...pickN(ORDINARY, 1), ...pickN(SPARSE, 2)];
      const t0c = performance.now();
      const stageCResults = await Promise.all(stageCCompanies.map(singleRequest));
      const groupWallMsC = Math.round(performance.now() - t0c);
      stageResults.C = { companies: stageCCompanies, results: stageCResults, groupWallMs: groupWallMsC };
      addRows('C', 4, stageCResults, groupWallMsC, baselineAvgMs);
      stageCResults.forEach(r => {
        const worst = worstOf(r);
        const slowdown = baselineAvgMs ? (worst / baselineAvgMs).toFixed(2) : 'n/a';
        console.log(`  ${r.company}: wallMs=${r.wallMs} serverElapsedMs=${r.serverElapsedMs} HTTP=${r.httpStatus} signals=${r.signalsReturned} error=${r.errorMessage || 'none'} slowdownVsSequential=${slowdown}x [${band(worst)}]`);
      });
      console.log(`  Group wall-clock (all four together): ${groupWallMsC}ms`);

      const worstC = Math.max(...stageCResults.map(worstOf));
      const hasErrorC = stageCResults.some(r => r.errorMessage || !r.ok);
      const throttleC = baselineAvgMs && stageCResults.some(r => worstOf(r) / baselineAvgMs >= THROTTLE_RATIO_WARN);

      if (hasErrorC) console.warn('\nStage C: at least one request errored/failed. Concurrency 4 is NOT safe as observed.');
      else if (worstC >= CONCURRENT_STOP_MS) console.warn(`\nStage C: an individual request reached ${worstC}ms (>=50s zone). Concurrency 4 is at/beyond the danger zone.`);
      else if (throttleC) console.warn(`\nStage C: throttling-like slowdown detected (>=${THROTTLE_RATIO_WARN}x sequential baseline). Treat concurrency 4 with caution.`);
      else console.log('\nStage C completed without tripping a stop condition.');
      console.log('Per the task boundary, concurrency is not escalated above 4 automatically regardless of this result.');
    }
  }

  // ---------------------------------------------------------------------
  // Final table + JSON
  // ---------------------------------------------------------------------
  console.log('\n%cResults table:', 'font-weight:bold');
  console.table(tableRows);

  const output = {
    benchmark: 'account-isolated concurrency ladder (Stage A/B/C)',
    endpoint: ENDPOINT,
    mode: 'warm-account',
    note: 'No uploadId/auth sent -- anonymous prospecting code path, zero DB writes. Real OpenAI/Serper/Firecrawl calls were made; this is NOT a mock.',
    sequentialBaselineAvgMs: baselineAvgMs,
    stoppedEarly: stopped,
    stopReason: stopped ? stopReason : null,
    stageA: { concurrency: 1, results: stageResults.A },
    stageB: stageResults.B,
    stageC: stageResults.C,
  };
  console.log('\n%cCopy this JSON back:', 'font-weight:bold');
  console.log(JSON.stringify(output, null, 2));
  window.__houseAccountsConcurrencyBenchmarkResult = output;
  console.log('\n(Also saved to window.__houseAccountsConcurrencyBenchmarkResult -- run copy(JSON.stringify(window.__houseAccountsConcurrencyBenchmarkResult)) to grab it via clipboard.)');
})();
