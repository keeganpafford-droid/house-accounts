// Security hotfix: api/research-batch.js previously had NO authorization
// check at all for mode:'weekly-monitoring' requests that omitted uploadId
// -- the only gate in the whole handler (resolveAuthenticatedUploadOwner)
// is skipped entirely when uploadId is absent, and that is exactly how
// api/weekly-scan.js calls this endpoint (mode:'weekly-monitoring', no
// uploadId, no auth header). Anyone who could reach this endpoint could
// trigger paid OpenAI/Serper/Firecrawl research for arbitrary
// caller-supplied "accounts".
//
// This file validates the fix against the REAL, production-bound `handler`
// export from api/research-batch.js (not a reimplementation): fail-closed
// authorization for mode:'weekly-monitoring' (tests 7-14 of the 18 required
// by this hotfix), plus differential proof that every other mode/path
// (dashboard uploadId research, prospect-intelligence) is completely
// unaffected by the new gate.
//
// Usage: node scripts/test-research-batch-weekly-monitoring-auth.js
import handler, { safeSecretEqual } from '../api/research-batch.js';

const TEST_CRON_SECRET = 'test-cron-secret-do-not-log-9876543210';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

function makeRes(){
  const res = { statusCode:200, body:null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function setBaseEnv({ cronSecret } = {}){
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  if (cronSecret === null) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = cronSecret === undefined ? TEST_CRON_SECRET : cronSecret;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SERPER_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
}

async function runWithFetchSpy(body, headers, fn){
  const realFetch = global.fetch;
  let fetchCalls = 0;
  const calledUrls = [];
  global.fetch = async (url, ...rest) => {
    fetchCalls += 1;
    calledUrls.push(String(url));
    return fn ? fn(url, ...rest) : (() => { throw new Error(`unexpected fetch call: ${url}`); })();
  };
  const req = { method:'POST', headers, body };
  const res = makeRes();
  try{
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
  }
  return { res, fetchCalls, calledUrls };
}

// ---------------------------------------------------------------------------
// Pure-function sanity check on the local safeSecretEqual copy (must behave
// identically to api/weekly-scan.js's copy).
// ---------------------------------------------------------------------------
{
  assert(safeSecretEqual('abc123', 'abc123') === true, 'safeSecretEqual returns true for identical secrets');
  assert(safeSecretEqual('abc123', 'abc124') === false, 'safeSecretEqual returns false for equal-length but differing secrets');
  assert(safeSecretEqual('short', 'a-much-longer-secret') === false, 'safeSecretEqual returns false for a length mismatch, without throwing');
}

// ---------------------------------------------------------------------------
// Hotfix test 7: missing CRON_SECRET -> 503, zero downstream calls.
// ---------------------------------------------------------------------------
{
  setBaseEnv({ cronSecret: null });
  const { res, fetchCalls } = await runWithFetchSpy(
    { mode: 'weekly-monitoring', accounts: [{ name: 'Acme Co' }] },
    { host: 'example.test' }
  );
  assert(res.statusCode === 503, 'mode:weekly-monitoring with CRON_SECRET unset returns 503 immediately (hotfix test 7)');
  assert(fetchCalls === 0, 'a missing CRON_SECRET results in zero downstream requests of any kind (hotfix test 7)');
}

// ---------------------------------------------------------------------------
// Hotfix test 8: CRON_SECRET configured but no Authorization header -> 401.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const { res, fetchCalls } = await runWithFetchSpy(
    { mode: 'weekly-monitoring', accounts: [{ name: 'Acme Co' }] },
    { host: 'example.test' }
  );
  assert(res.statusCode === 401, 'mode:weekly-monitoring with no Authorization header returns 401 when CRON_SECRET is configured (hotfix test 8)');
  assert(fetchCalls === 0, 'a missing Authorization header results in zero downstream requests (hotfix test 8)');
}

// ---------------------------------------------------------------------------
// Hotfix test 9: an Authorization header is present but wrong -> 401.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const { res, fetchCalls } = await runWithFetchSpy(
    { mode: 'weekly-monitoring', accounts: [{ name: 'Acme Co' }] },
    { host: 'example.test', authorization: 'Bearer this-is-not-the-configured-secret' }
  );
  assert(res.statusCode === 401, 'an incorrect Bearer token returns 401 (hotfix test 9)');
  assert(fetchCalls === 0, 'an incorrect Bearer token results in zero downstream requests (hotfix test 9)');
}

// ---------------------------------------------------------------------------
// Hotfix test 10: a correct Bearer token permits the EXISTING
// weekly-monitoring path end-to-end -- the real handler proceeds past the
// new gate and returns a normal 200 response shaped exactly like before
// this hotfix.
//
// Sprint 1 controlled-beta policy note: this used to prove the OpenAI call
// via SERPER_API_KEY left unset (candidates.length===0 -> the old
// callOpenAIWebSearch() fallback). That fallback is no longer called from
// the zero-candidate branch at all (see api/research-batch.js's
// synthesisMode='no-candidate-evidence' policy) -- every real, currently
// live path that reaches OpenAI now does so via the candidate-backed
// branch, so this test configures SERPER_API_KEY and mocks a real
// discovered candidate to keep proving "this hotfix's new auth gate doesn't
// break the normal research call" against the code path that is actually
// still live.
{
  setBaseEnv();
  process.env.OPENAI_API_KEY = 'fake-openai-key';
  process.env.SERPER_API_KEY = 'fake-serper-key';
  const { res, fetchCalls, calledUrls } = await runWithFetchSpy(
    { mode: 'weekly-monitoring', accounts: [{ name: 'Acme Co' }] },
    { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` },
    async (url) => {
      if (String(url).includes('google.serper.dev')) {
        return jsonResponse({
          organic: [{
            title: 'New facility expansion ribbon cutting announced 2026',
            snippet: 'Acme Co held a ribbon cutting for a new facility expansion, announced 2026, trade show exhibitor booth.',
            link: 'https://news.example.com/acme-co-facility',
            date: '2026-01-01'
          }]
        });
      }
      if (String(url) === 'https://api.openai.com/v1/responses') {
        return jsonResponse({ output_text: JSON.stringify({ signals: [] }) });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    }
  );
  assert(res.statusCode === 200, 'a correct Bearer token reaches normal orchestration and returns 200 (hotfix test 10)');
  assert(Array.isArray(res.body?.signals), 'the response has the existing shape (a signals array), unchanged by this hotfix (hotfix test 10)');
  assert(res.body?.diagnostics?.mode === 'weekly-monitoring', 'the response diagnostics confirm the weekly-monitoring path actually ran (hotfix test 10)');
  assert(calledUrls.includes('https://api.openai.com/v1/responses'), 'an authorized weekly-monitoring request still reaches the real OpenAI research call exactly as before this hotfix, via the candidate-backed path (hotfix test 10)');
  assert(res.body?.diagnostics?.synthesisMode === 'candidate-backed', `hotfix test 10 exercises the candidate-backed synthesis path, not the disabled no-candidate fallback (got ${res.body?.diagnostics?.synthesisMode})`);
}

// ---------------------------------------------------------------------------
// Hotfix test 11: every rejection path makes zero paid-provider calls.
// (Combines the three rejection scenarios above into one explicit,
// dedicated proof, as required by the hotfix's test plan.)
// ---------------------------------------------------------------------------
{
  const rejectionScenarios = [
    { label: 'missing CRON_SECRET', cronSecret: null, headers: { host:'example.test' } },
    { label: 'missing Authorization header', cronSecret: undefined, headers: { host:'example.test' } },
    { label: 'incorrect Bearer token', cronSecret: undefined, headers: { host:'example.test', authorization:'Bearer wrong-secret-value' } }
  ];
  for (const scenario of rejectionScenarios) {
    setBaseEnv({ cronSecret: scenario.cronSecret });
    const { res, fetchCalls } = await runWithFetchSpy(
      { mode: 'weekly-monitoring', accounts: [{ name: 'Acme Co' }, { name: 'Beta Inc' }] },
      scenario.headers
    );
    assert(fetchCalls === 0, `zero paid-provider (or any other downstream) calls for a rejected request: ${scenario.label} (hotfix test 11)`);
    assert(res.statusCode === 401 || res.statusCode === 503, `a rejected request (${scenario.label}) returns 401 or 503 (hotfix test 11)`);
  }
}

// ---------------------------------------------------------------------------
// Hotfix test 12: a large caller-supplied accounts array is not processed
// before auth -- the account-normalization/filtering pipeline (which is CPU
// work, independent of any network call) never runs for a rejected request,
// proven both by zero fetch calls and by the request completing in a time
// bound far too small to have filtered/deduped/sliced 50,000 account
// objects.
// ---------------------------------------------------------------------------
{
  setBaseEnv();
  const hugeAccounts = Array.from({ length: 50000 }, (_, i) => ({ name: `Account ${i}`, notes: 'x'.repeat(200) }));
  const startedAt = Date.now();
  const { res, fetchCalls } = await runWithFetchSpy(
    { mode: 'weekly-monitoring', accounts: hugeAccounts },
    { host: 'example.test' } // no Authorization header
  );
  const elapsed = Date.now() - startedAt;
  assert(res.statusCode === 401, 'a large caller-supplied accounts array does not bypass the auth gate (hotfix test 12)');
  assert(fetchCalls === 0, 'a large caller-supplied accounts array results in zero downstream calls when unauthorized (hotfix test 12)');
  assert(elapsed < 200, `a large (50,000-account) unauthorized request is rejected in ${elapsed}ms, far too fast to have run the account-normalization pipeline -- proving auth runs before any account-array processing (hotfix test 12)`);
}

// ---------------------------------------------------------------------------
// Hotfix test 13: the secret is never accepted from body, query string, or
// cookies -- only the Authorization: Bearer header.
// ---------------------------------------------------------------------------
{
  const attempts = [
    { label: 'body.secret', body: { mode:'weekly-monitoring', accounts:[{name:'Acme Co'}], secret: TEST_CRON_SECRET } },
    { label: 'body.cronSecret', body: { mode:'weekly-monitoring', accounts:[{name:'Acme Co'}], cronSecret: TEST_CRON_SECRET } },
    { label: 'body.authorization (not a header)', body: { mode:'weekly-monitoring', accounts:[{name:'Acme Co'}], authorization: `Bearer ${TEST_CRON_SECRET}` } }
  ];
  for (const attempt of attempts) {
    setBaseEnv();
    const { res, fetchCalls } = await runWithFetchSpy(attempt.body, { host:'example.test', cookie:`secret=${TEST_CRON_SECRET}` });
    assert(res.statusCode === 401, `the correct secret supplied via ${attempt.label} (no real Authorization header) is rejected (hotfix test 13)`);
    assert(fetchCalls === 0, `${attempt.label} does not grant access to any downstream call (hotfix test 13)`);
  }

  // Query-string variant, mirroring the removed ?secret= fallback in
  // weekly-scan.js -- research-batch.js never had a query-string path for
  // this secret, and this confirms none was accidentally introduced either.
  setBaseEnv();
  const req = { method:'POST', headers:{ host:'example.test' }, query:{ secret: TEST_CRON_SECRET, cronSecret: TEST_CRON_SECRET }, body:{ mode:'weekly-monitoring', accounts:[{name:'Acme Co'}] } };
  const res = makeRes();
  const realFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async (...args) => { fetchCalls += 1; throw new Error(`unexpected fetch: ${args[0]}`); };
  try{ await handler(req, res); } finally { global.fetch = realFetch; }
  assert(res.statusCode === 401, 'the correct secret supplied via a query string parameter is rejected -- no query-string path exists for this secret (hotfix test 13)');
  assert(fetchCalls === 0, 'a query-string secret attempt makes zero downstream calls (hotfix test 13)');
}

// ---------------------------------------------------------------------------
// Hotfix test 14: the secret never appears in the response body or in
// anything logged to the console, for either an authorized or a rejected
// request.
// ---------------------------------------------------------------------------
{
  const originalLog = console.log, originalError = console.error, originalWarn = console.warn;
  const loggedText = [];
  const capture = (...args) => { loggedText.push(args.map(a => (a instanceof Error ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ')); };
  console.log = capture; console.error = capture; console.warn = capture;

  setBaseEnv();
  const rejected = await runWithFetchSpy(
    { mode: 'weekly-monitoring', accounts: [{ name: 'Acme Co' }] },
    { host: 'example.test', authorization: 'Bearer wrong-secret-value' }
  );

  setBaseEnv();
  process.env.OPENAI_API_KEY = 'fake-openai-key';
  const accepted = await runWithFetchSpy(
    { mode: 'weekly-monitoring', accounts: [{ name: 'Acme Co' }] },
    { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` },
    async (url) => (String(url) === 'https://api.openai.com/v1/responses')
      ? jsonResponse({ output_text: JSON.stringify({ signals: [] }) })
      : (() => { throw new Error(`unexpected fetch: ${url}`); })()
  );

  console.log = originalLog; console.error = originalError; console.warn = originalWarn;

  const rejectedBodyText = JSON.stringify(rejected.res.body || {});
  const acceptedBodyText = JSON.stringify(accepted.res.body || {});
  const allLoggedText = loggedText.join('\n');

  assert(!rejectedBodyText.includes(TEST_CRON_SECRET), 'the configured CRON_SECRET never appears in a rejected request\'s response body (hotfix test 14)');
  assert(!rejectedBodyText.includes('wrong-secret-value'), 'the supplied (incorrect) secret never appears in a rejected request\'s response body (hotfix test 14)');
  assert(!acceptedBodyText.includes(TEST_CRON_SECRET), 'the configured CRON_SECRET never appears in an accepted request\'s response body (hotfix test 14)');
  assert(!allLoggedText.includes(TEST_CRON_SECRET), 'the configured CRON_SECRET is never written to console.log/warn/error across an authorized or rejected request (hotfix test 14)');
  assert(!allLoggedText.includes('wrong-secret-value'), 'a supplied incorrect secret is never written to console.log/warn/error (hotfix test 14)');
}

// ---------------------------------------------------------------------------
// Scope-correctness / regression differential tests: proving the new gate
// applies ONLY to mode:'weekly-monitoring', and that every other path this
// endpoint serves is byte-for-byte unaffected by this hotfix.
// ---------------------------------------------------------------------------

{
  // Regression (item 15 support): a dashboard-style request bound to an
  // upload (uploadId present, mode omitted/default) with no CRON_SECRET
  // configured at all is NOT rejected by the new gate -- it falls straight
  // through to the pre-existing resolveAuthenticatedUploadOwner() check,
  // proven by getting that check's own distinct 401 message ("Login
  // required..."), not the new gate's generic "Unauthorized", and not a 503.
  setBaseEnv({ cronSecret: null });
  const { res, fetchCalls } = await runWithFetchSpy(
    { uploadId: 'upload-1', accounts: [{ name: 'Acme Co' }] },
    { host: 'example.test' } // no Authorization header either
  );
  assert(res.statusCode === 401, 'a dashboard-style uploadId request with no CRON_SECRET configured still gets a 401 (from the pre-existing owner check), not a 503 from the new gate (regression 15)');
  assert(res.body?.error === 'Login required to research an uploaded account list.', 'the 401 carries the pre-existing resolveAuthenticatedUploadOwner() error message, proving the new mode-gated check never ran for this request (regression 15)');
  assert(fetchCalls === 0, 'the pre-existing owner check itself makes zero downstream calls for a request with no auth token at all (unchanged behavior)');
}

{
  // Combining mode:'weekly-monitoring' WITH a real-looking uploadId must
  // still be gated by CRON_SECRET -- the new check is layered alongside the
  // uploadId owner check, not replaced by it, exactly as required ("applies
  // whether uploadId is present or absent").
  setBaseEnv({ cronSecret: null });
  const { res, fetchCalls } = await runWithFetchSpy(
    { uploadId: 'upload-1', mode: 'weekly-monitoring', accounts: [{ name: 'Acme Co' }] },
    { host: 'example.test' }
  );
  assert(res.statusCode === 503, 'mode:weekly-monitoring combined with a uploadId is still gated by CRON_SECRET (missing -> 503), not silently exempted by the presence of uploadId (hotfix requirement: applies whether uploadId is present or absent)');
  assert(fetchCalls === 0, 'the combined uploadId + weekly-monitoring rejection makes zero downstream calls, including no attempt to resolve upload ownership first');
}

{
  // Regression (item 18 support): the public prospect-intelligence mode is
  // completely unaffected by this hotfix -- with no CRON_SECRET configured
  // at all, it proceeds past the new gate (which only checks
  // mode==='weekly-monitoring') into its own pre-existing, unrelated
  // OPENAI_API_KEY check. This intentionally proves the residual exposure
  // (prospect-intelligence still has no authorization of its own) is
  // unchanged by this patch, not fixed by it -- exactly as scoped.
  setBaseEnv({ cronSecret: null });
  const { res, fetchCalls } = await runWithFetchSpy(
    { mode: 'prospect-intelligence', accounts: [{ name: 'Acme Co' }] },
    { host: 'example.test' } // no Authorization header, no uploadId
  );
  assert(res.statusCode === 400, 'a prospect-intelligence request with no CRON_SECRET configured and no auth header is NOT rejected by the new gate -- it reaches the pre-existing OPENAI_API_KEY check unchanged (regression 18)');
  assert(res.body?.error === 'OPENAI_API_KEY not configured', 'the 400 is the endpoint\'s own pre-existing error for this mode, confirming the new gate never activated for prospect-intelligence (regression 18)');
  assert(fetchCalls === 0, 'no downstream call is made either way for this scenario (OPENAI_API_KEY missing short-circuits before any fetch, same as before this hotfix)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
