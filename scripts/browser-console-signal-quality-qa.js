// House Accounts -- signal/product-integrity QA for the reliability fix at
// 02dd49484e3ea54c88be1db7482a1839922af940.
// PASTE THIS ENTIRE FILE INTO THE BROWSER CONSOLE ON THE PREVIEW DEPLOYMENT.
//
// Runs 7 real companies through the SAME anonymous, no-uploadId/no-auth
// /api/research-batch path used by every prior benchmark this round (zero
// DB reads/writes -- confirmed by code inspection), sequentially (not
// concurrent -- this is a quality check, not a throughput test), and prints
// each returned signal's actual content next to this repo's OWN existing
// ground-truth expectations (benchmarks/signal-benchmark.json), so the
// founder can judge semantic quality directly rather than trusting a
// pass/fail heuristic.
//
// 6 of the 7 companies are exactly the fixture already used by this repo's
// existing offline classification/dedup benchmark (scripts/run-signal-
// benchmark.js) -- real regression history, not newly invented. Home Depot
// is included as the 7th for continuity with the tail-latency diagnostic.

(async function houseAccountsSignalQualityQA() {
  const ENDPOINT = '/api/research-batch';
  const CLIENT_ABORT_MS = 70000;

  // Source: benchmarks/signal-benchmark.json (already in this repo).
  // essential = must still be findable; optional = nice-to-have, its
  // absence is not a failure on its own.
  const COMPANIES = [
    { name: 'Avidia Bank', essential: ['renovated branch reopening (growth)', 'payment product innovation award (award)'], optional: ['employee promotion (leadership)'] },
    { name: 'Lonza', essential: ['facility expansion (growth)', 'workforce hiring tied to capacity (hiring)'], optional: ['conference participation (events)'] },
    { name: 'Hussey Seating', essential: ['major venue or customer contract (financial)'], optional: ['trade show participation (events)'] },
    { name: 'Amoskeag Beverages', essential: ['community sponsorship or event (community)'], optional: ['new brand or product launch (product)'] },
    { name: 'Arthur J. Gallagher', essential: ['acquisition (financial)'], optional: ['leadership appointment (leadership)'] },
    { name: 'Catalyst Investment Partners', essential: ['funding or investment event (financial)'], optional: ['portfolio company expansion (growth)'] },
    { name: 'The Home Depot', essential: [], optional: [], note: 'continuity company from the tail-latency diagnostic, no documented essential/optional fixture -- included for cross-reference, not a pass/fail source' },
  ];

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
        ? `Client-side abort after ${CLIENT_ABORT_MS}ms with no response.`
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
      errorMessage,
      rankedCandidates: typeof diag.rankedCandidates === 'number' ? diag.rankedCandidates : null,
      // Signals, trimmed to the fields relevant for a human quality read --
      // not every internal field the response carries.
      signals: Array.isArray(json && json.signals) ? json.signals.map(s => ({
        signalType: s.signalType || s.signal_type || null,
        headline: s.signalTitle || s.headline || s.whatChanged || null,
        whyThisMatters: s.whyThisMatters || s.why_this_matters || null,
        eventDate: s.eventDate || s.event_date || null,
        confidence: s.confidenceScore ?? s.confidence ?? null,
        sourceUrl: s.sourceUrl || s.source_url || null,
        corroboratingCandidates: s.corroboratingCandidates ?? null,
        isFallbackOpportunity: !!s.isFallbackOpportunity,
        suggestedOpener: s.suggestedOpener || s.suggested_opener || null,
      })) : [],
    };
  }

  console.log('%cHouse Accounts signal/product-integrity QA', 'font-weight:bold;font-size:14px');
  console.log(`${COMPANIES.length} companies, sequential, anonymous no-uploadId path (zero DB writes).`);
  console.warn('Confirm your address bar shows the PREVIEW deployment, not Production, before this runs.');

  const results = [];
  for (const c of COMPANIES) {
    console.log(`\n--- ${c.name} ---`);
    if (c.essential.length) console.log(`  Expected essential: ${c.essential.join('; ')}`);
    if (c.optional.length) console.log(`  Expected optional:  ${c.optional.join('; ')}`);
    const r = await singleRequest(c.name);
    results.push({ company: c.name, essential: c.essential, optional: c.optional, note: c.note || null, ...r });
    console.log(`  wallMs=${r.wallMs} serverElapsedMs=${r.serverElapsedMs} HTTP=${r.httpStatus} rankedCandidates=${r.rankedCandidates} signalsReturned=${r.signals.length} error=${r.errorMessage || 'none'}`);
    r.signals.forEach((s, i) => {
      console.log(`  [${i + 1}] ${s.signalType || '(untyped)'} -- ${s.headline || '(no headline)'} | date=${s.eventDate || '?'} | confidence=${s.confidence} | fallback=${s.isFallbackOpportunity} | source=${s.sourceUrl || '(none)'}`);
    });
  }

  console.log('\n%cResults table:', 'font-weight:bold');
  console.table(results.map(r => ({
    Company: r.company,
    'Wall ms': r.wallMs,
    'Server elapsedMs': r.serverElapsedMs,
    HTTP: r.httpStatus,
    'Ranked candidates': r.rankedCandidates,
    'Signals returned': r.signals.length,
    Result: r.errorMessage ? `ERROR: ${r.errorMessage}` : 'OK',
  })));

  const output = {
    qa: 'signal/product-integrity QA for reliability-fix SHA 02dd49484e3ea54c88be1db7482a1839922af940',
    endpoint: ENDPOINT,
    mode: 'warm-account',
    note: 'essential/optional per company are copied from this repo\'s own benchmarks/signal-benchmark.json ground-truth fixture. Compare each company\'s actual signals[] against its essential list -- exact wording is not required, the same underlying real-world event should still be findable.',
    results,
  };
  console.log('\n%cCopy this JSON back:', 'font-weight:bold');
  console.log(JSON.stringify(output, null, 2));
  window.__houseAccountsSignalQaResult = output;
  console.log('\n(Also saved to window.__houseAccountsSignalQaResult -- run copy(JSON.stringify(window.__houseAccountsSignalQaResult)) for clipboard.)');
})();
