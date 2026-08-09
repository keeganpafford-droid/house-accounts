// Trust correction: production regression. Preview QA on
// d119fef988c55755bdb9f33fee9cbb85d73f3648 failed immediately with
// "derivedIdentityByAccount is not defined" on the real /api/research-batch
// endpoint. Root cause: `const derivedIdentityByAccount = new Map(...)` was
// declared inside the `if (hasSearchProvider) { ... }` block, but read from
// the `madeSignalsRaw` signal-mapping/grounding loop, which runs well after
// that block closes -- a plain `{...}` block, not a function, so the const
// went out of scope the instant the block ended.
//
// Every existing test for this sprint (test-trust-correction-ephemeral-
// identity-bootstrap.js and friends) called buildDerivedIdentity()/
// deriveAccountLocationFromContent()/verifyCandidateCompanyGrounding()
// directly as standalone functions -- correct proof of the LOGIC, but none
// of them ever executed api/research-batch.js's actual exported HTTP
// handler, which is the only place this specific JS scoping bug could ever
// manifest. This file closes that gap: it drives the REAL, production-bound
// handler export (mocked fetch only, same pattern
// scripts/test-provider-usage-instrumentation.js and
// scripts/test-research-batch-zero-candidate-policy.js already use) far
// enough to exercise the actual declaration/use lifecycle of
// derivedIdentityByAccount -- candidate discovery, Firecrawl enrichment,
// OpenAI synthesis returning a REAL signal, and the grounding call site
// that reads the map. Confirmed via code trace: this exact combination
// (a real discovered candidate AND a non-empty synthesized signals array)
// is what neither existing endpoint-level test ever exercised together --
// test-research-batch-zero-candidate-policy.js's Serper mock returns zero
// candidates, and test-provider-usage-instrumentation.js's OpenAI mock
// returns `signals: []` -- so madeSignalsRaw.map()'s callback, where the
// out-of-scope reference lived, was never actually invoked by either.
//
// The bug is mode-agnostic: any request with a configured search provider
// that produces at least one synthesized signal reaches the crash site,
// regardless of 'ranked'/'warm-account'/'prospect-intelligence' mode -- not
// limited to mixed/warm accounts specifically. This file exercises the
// 'warm-account' mode because that is the real, live-fixture path.
//
// Usage: node scripts/test-trust-correction-derived-identity-endpoint-regression.js
import handler from '../api/research-batch.js';

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

function setBaseEnv() {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  delete process.env.CRON_SECRET;
  process.env.OPENAI_API_KEY = 'sk-test-do-not-log-1234567890';
  process.env.SERPER_API_KEY = 'fake-serper-key';
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
}

// ---------------------------------------------------------------------------
// Test 1: the exact crash scenario -- a real discovered candidate, a real
// synthesized signal resolving to that candidate, no Firecrawl configured
// (so buildDerivedIdentity() finds nothing -- the "no-derived-identity case"
// -- but derivedIdentityByAccount must still be a valid, referenceable Map,
// not a ReferenceError). This alone reproduces the exact production defect
// if the scoping bug is present.
// ---------------------------------------------------------------------------
async function testMixedWarmPathNoReferenceErrorNoFirecrawl() {
  setBaseEnv();
  delete process.env.FIRECRAWL_API_KEY;
  const realFetch = global.fetch;
  const candidateUrl = 'https://news.example.com/acme-facility-1';
  let serperQueries = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      serperQueries += 1;
      return {
        ok: true, status: 200,
        json: async () => ({ organic: [{
          title: 'Acme Test Co opens new facility',
          snippet: 'Acme Test Co held a ribbon cutting for a new facility expansion, announced 2026.',
          link: candidateUrl,
          date: '2026-01-01'
        }] })
      };
    }
    if (u.includes('api.openai.com')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          output_text: JSON.stringify({ signals: [{
            accountName: 'Acme Test Co',
            signal_type: 'Growth / Expansion',
            concrete_trigger: 'New facility ribbon cutting',
            business_context: 'Acme Test Co held a ribbon cutting for a new facility expansion.',
            sourceUrl: candidateUrl,
            confidence: 90
          }] }),
          usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }
        })
      };
    }
    throw new Error(`unexpected fetch call in derived-identity endpoint regression test: ${u}`);
  };
  const req = { method: 'POST', headers: {}, body: { accounts: [{ name: 'Acme Test Co', intelligenceMode: 'warm' }], mode: 'warm-account' } };
  const res = makeRes();
  let threw = null;
  try {
    await handler(req, res);
  } catch (err) {
    threw = err;
  } finally {
    global.fetch = realFetch;
  }

  assert(threw === null, `1) the handler completes without throwing (this is the exact regression -- previously threw ReferenceError: derivedIdentityByAccount is not defined)${threw ? `: ${threw.message}` : ''}`);
  assert(serperQueries > 0, 'sanity: the mixed/warm-account path actually discovered candidates via Serper (the real crash precondition)');
  assert(res.statusCode === 200, `2) the request succeeds end to end (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
  assert(Array.isArray(res.body?.signals) && res.body.signals.length === 1, `3) the real synthesized signal, resolved to its discovered candidate, survives all the way to the response (got ${res.body?.signals?.length} signals)`);
  const signal = res.body?.signals?.[0];
  assert(!!signal && signal.identityConfidence === 'unconfirmed', `4) with no Firecrawl configured, no derived identity is available (the "no-derived-identity case") -- grounding still runs safely and correctly grades this bare-name-match candidate 'unconfirmed', not confirmed and not a crash (got ${signal?.identityConfidence})`);
}
await testMixedWarmPathNoReferenceErrorNoFirecrawl();

// ---------------------------------------------------------------------------
// Test 2: derived identity map is genuinely AVAILABLE and FUNCTIONAL at the
// real grounding call site -- a sparse account (contact email only, no
// uploaded website/location, the live Dover Honda / iclautos.com shape)
// whose contact-derived domain yields real, account-specific, Firecrawl-
// enriched content, used to confirm an INDEPENDENT third-party candidate.
// This proves the map is not just harmlessly empty but actually reaches and
// affects the real grounding call.
// ---------------------------------------------------------------------------
async function testDerivedIdentityReachesGroundingThroughRealHandler() {
  setBaseEnv();
  process.env.FIRECRAWL_API_KEY = 'fake-firecrawl-key';
  const realFetch = global.fetch;
  const icalUrl = 'https://iclautos.com/locations';
  const paradeUrl = 'https://www.dovernh.org/news/details/dover-honda-parade-sponsor';
  let firecrawlRequests = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      return {
        ok: true, status: 200,
        json: async () => ({ organic: [
          { title: 'ICL Autos Dealership Locations', snippet: 'Find Dover Honda and our other dealerships.', link: icalUrl, date: '2026-01-01' },
          { title: 'Dover Honda Signs On as Dover Holiday Parade Sponsor', snippet: 'The Dover Holiday Parade committee announced Dover Honda as its lead sponsor.', link: paradeUrl, date: '2026-07-23' }
        ] })
      };
    }
    if (u.includes('api.firecrawl.dev')) {
      firecrawlRequests += 1;
      const body = JSON.parse(opts.body);
      const markdown = body.url === icalUrl
        ? 'Our Family of Dealerships\nDover Honda — Dover, NH\nPortsmouth Ford — Portsmouth, NH\n'
        : 'Dover Holiday Parade sponsorship announcement.';
      return { ok: true, status: 200, json: async () => ({ data: { markdown } }) };
    }
    if (u.includes('api.openai.com')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          output_text: JSON.stringify({ signals: [{
            accountName: 'Dover Honda',
            signal_type: 'Community / CSR',
            concrete_trigger: 'Dover Holiday Parade sponsorship',
            business_context: 'Dover Honda will be the lead sponsor of the 2026 Dover Holiday Parade.',
            sourceUrl: paradeUrl,
            confidence: 85
          }] }),
          usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }
        })
      };
    }
    throw new Error(`unexpected fetch call in derived-identity-reaches-grounding test: ${u}`);
  };
  const req = {
    method: 'POST', headers: {},
    body: {
      accounts: [{
        name: 'Dover Honda',
        intelligenceMode: 'mixed',
        contacts: [{ name: 'Paula Redden', email: 'predden@iclautos.com', department: 'Sales' }]
      }],
      mode: 'warm-account'
    }
  };
  const res = makeRes();
  let threw = null;
  try {
    await handler(req, res);
  } catch (err) {
    threw = err;
  } finally {
    global.fetch = realFetch;
  }

  assert(threw === null, `1) no crash with Firecrawl configured and a real identity-bootstrap-eligible candidate in play${threw ? `: ${threw.message}` : ''}`);
  assert(res.statusCode === 200, `2) request succeeds (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
  assert(firecrawlRequests > 0, 'sanity: Firecrawl was actually invoked (the enrichment step derived identity depends on)');
  const signal = (res.body?.signals || []).find(s => s.sourceUrl === paradeUrl);
  assert(!!signal, `3) the independent dovernh.org Parade signal (not the identity source itself) reached the response (got signals: ${JSON.stringify((res.body?.signals || []).map(s => s.sourceUrl))})`);
  assert(signal?.identityConfidence === 'confirmed', `4) derived identity genuinely reached and affected the real grounding call site through the actual handler -- the Parade signal confirms (got ${signal?.identityConfidence})`);
}
await testDerivedIdentityReachesGroundingThroughRealHandler();

// ---------------------------------------------------------------------------
// Test 3 (round 5, live-diagnosis follow-up): Test 2 used an em-dash
// "Dover Honda -- Dover, NH" placeholder shape, chosen before any live data
// existed. Live diagnostics (6ed603d) proved the REAL iclautos.com shape is
// a numbered directory entry with the address two lines below the name and
// a compact, space-free "Dover,NH03820" city/state/zip -- exactly what
// api/signal-intelligence.js's accountBlockLines()/CITY_STATE_PATTERN fix
// (round 5) exists to handle. This re-runs the full real-handler path
// against that EXACT live shape (not a synthetic placeholder), and adds an
// Indianapolis-shaped signal to prove the SAME derived identity still
// rejects a conflicting candidate end to end -- not just confirms an
// agreeing one. Also asserts the query/Firecrawl ceilings this round was
// forbidden from changing are, in fact, unchanged from Test 2's own numbers.
// ---------------------------------------------------------------------------
async function testLiveShapedAccountBlockReachesGroundingThroughRealHandler() {
  setBaseEnv();
  process.env.FIRECRAWL_API_KEY = 'fake-firecrawl-key';
  const realFetch = global.fetch;
  const icalUrl = 'https://iclautos.com/careers.htm';
  const paradeUrl = 'https://www.dovernh.org/news/details/dover-honda-parade-sponsor';
  const indianapolisUrl = 'https://example-blog.com/indianapolis-honda-rebrand';
  let firecrawlRequests = 0;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('google.serper.dev')) {
      return {
        ok: true, status: 200,
        json: async () => ({ organic: [
          { title: 'ICL Autos Careers', snippet: 'Find Dover Honda and our other dealerships.', link: icalUrl, date: '2026-01-01' },
          { title: 'Dover Honda Signs On as Dover Holiday Parade Sponsor', snippet: 'The Dover Holiday Parade committee announced Dover Honda as its lead sponsor.', link: paradeUrl, date: '2026-07-23' },
          { title: 'Dover Honda hosts unveiling event', snippet: 'The Indianapolis, IN dealership celebrated its major rebrand with a new logo unveiling.', link: indianapolisUrl, date: '2028-01-01' }
        ] })
      };
    }
    if (u.includes('api.firecrawl.dev')) {
      firecrawlRequests += 1;
      const body = JSON.parse(opts.body);
      // The exact live block shape from the founder's own diagnostics:
      // numbered entry, address two lines below the name, compact ZIP.
      const markdown = body.url === icalUrl
        ? '09. **Dover Honda**\n1 Dover Point Rd\nDover,NH03820\n- Sales:(603) 242-1129\n10. **International Cars**\n382 NEWBURY ST\n'
        : 'Community and event coverage.';
      return { ok: true, status: 200, json: async () => ({ data: { markdown } }) };
    }
    if (u.includes('api.openai.com')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          output_text: JSON.stringify({ signals: [
            {
              accountName: 'Dover Honda', signal_type: 'Community / CSR', concrete_trigger: 'Dover Holiday Parade sponsorship',
              business_context: 'Dover Honda will be the lead sponsor of the 2026 Dover Holiday Parade.', sourceUrl: paradeUrl, confidence: 85
            },
            {
              accountName: 'Dover Honda', signal_type: 'Rebrand', concrete_trigger: 'Logo unveiling event',
              business_context: 'The Indianapolis, IN dealership celebrated its major rebrand with a new logo unveiling.', sourceUrl: indianapolisUrl, confidence: 70
            }
          ] }),
          usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }
        })
      };
    }
    throw new Error(`unexpected fetch call in live-shaped account-block regression test: ${u}`);
  };
  const req = {
    method: 'POST', headers: {},
    body: {
      accounts: [{
        name: 'Dover Honda',
        intelligenceMode: 'mixed',
        contacts: [{ name: 'Paula Redden', email: 'predden@iclautos.com', department: 'Sales' }]
      }],
      mode: 'warm-account'
    }
  };
  const res = makeRes();
  let threw = null;
  try {
    await handler(req, res);
  } catch (err) {
    threw = err;
  } finally {
    global.fetch = realFetch;
  }

  assert(threw === null, `1) no crash against the exact live account-block shape${threw ? `: ${threw.message}` : ''}`);
  assert(res.statusCode === 200, `2) request succeeds (got ${res.statusCode})`);
  assert(firecrawlRequests > 0, 'sanity: Firecrawl was actually invoked against the live-shaped page');
  const paradeSignal = (res.body?.signals || []).find(s => s.sourceUrl === paradeUrl);
  const indySignal = (res.body?.signals || []).find(s => s.sourceUrl === indianapolisUrl);
  assert(!!paradeSignal, `3) the independent dovernh.org Parade signal reached the response (got signals: ${JSON.stringify((res.body?.signals || []).map(s => s.sourceUrl))})`);
  assert(paradeSignal?.identityConfidence === 'confirmed', `4) the Dover, NH identity derived from the REAL live-shaped numbered-directory block (compact "Dover,NH03820", address two lines below the name) reaches grounding and confirms the Parade signal (got ${paradeSignal?.identityConfidence})`);
  // 'rejected' signals are filtered out of the response entirely (existing,
  // unchanged behavior -- see the rawSignals/finalSignals length difference
  // this endpoint already reports as diagnostics.signalsRejected), so
  // "rejected end to end" is proven by absence from signals[] plus the
  // rejection actually being counted, not by a visible identityConfidence
  // field on a returned item.
  assert(!indySignal, `5) the SAME live-shaped derived identity makes the conflicting Indianapolis candidate reject outright through the real handler -- it never reaches the response at all (got signals: ${JSON.stringify((res.body?.signals || []).map(s => s.sourceUrl))})`);
  assert(res.body?.diagnostics?.rawSignals === 2, `6a) sanity: OpenAI synthesized both raw signals (Parade + Indianapolis) before grounding filtered one (got ${res.body?.diagnostics?.rawSignals})`);
  assert(res.body?.diagnostics?.signalsRejected === 1, `6b) exactly one signal was rejected by grounding -- the Indianapolis one, not the Parade one (got ${res.body?.diagnostics?.signalsRejected})`);
  const serperQueries = res.body?.providerUsage?.serper?.queries;
  const firecrawlSuccesses = res.body?.providerUsage?.firecrawl?.successes;
  assert(serperQueries === 12, `7) query ceiling is unchanged by this round (still 12 queries for a single warm-account request, got ${serperQueries})`);
  assert(typeof firecrawlSuccesses === 'number' && firecrawlSuccesses <= 6, `8) Firecrawl per-account ceiling (6) is unchanged by this round (got ${firecrawlSuccesses})`);
}
await testLiveShapedAccountBlockReachesGroundingThroughRealHandler();

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
