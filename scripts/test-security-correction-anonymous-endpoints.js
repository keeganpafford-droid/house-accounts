// Security correction sprint (pre-Beta): dedicated regression coverage for
// every scenario the founder's correction-sprint instruction required
// (item 5), proven against the REAL exported handlers, not
// reimplementations:
//   1. an anonymous caller cannot call api/research-account.js
//   2. an anonymous caller cannot invoke paid api/research-batch.js
//   3. an anonymous caller cannot attach uploads/prospect data to an
//      existing user by asserting their email
//   4. an authenticated user can still use the legitimate current
//      research/upload flows
//   5. one organization/user cannot write into another user's data
//   6. the weekly cron / internal research path remains functional
//   7. Stripe/billing behavior is untouched (api/stripe-webhook.js and
//      api/create-checkout-session.js were not modified by this sprint --
//      scripts/test-stripe-webhook.js and scripts/test-checkout-session.js
//      already cover them and run unmodified as part of the full suite;
//      not duplicated here).
//
// Usage: node scripts/test-security-correction-anonymous-endpoints.js
import researchAccountHandler from '../api/research-account.js';
import researchBatchHandler from '../api/research-batch.js';
import saveProspectUploadHandler from '../api/save-prospect-upload.js';
import saveUploadHandler from '../api/save-upload.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, headers: { get: (name) => (String(name || '').toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => data, text: async () => JSON.stringify(data) };
}
function htmlResponse(text = '', ok = true) {
  return { ok, status: ok ? 200 : 404, headers: { get: (name) => (String(name || '').toLowerCase() === 'content-type' ? 'text/html' : null) }, text: async () => text, json: async () => ({}) };
}
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}

function setBaseEnv() {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  delete process.env.CRON_SECRET;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SERPER_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
}

async function withFetch(impl, fn) {
  const real = global.fetch;
  let calls = 0;
  const urls = [];
  global.fetch = async (url, ...rest) => {
    calls += 1;
    urls.push(String(url));
    return impl(String(url), ...rest);
  };
  try {
    return { ...(await fn()), fetchCalls: calls, calledUrls: urls };
  } finally {
    global.fetch = real;
  }
}

async function run() {
  // =========================================================================
  // Item 1: an anonymous caller cannot call api/research-account.js.
  // =========================================================================
  {
    setBaseEnv();
    const { res, fetchCalls } = await withFetch(
      () => { throw new Error('should not be called'); },
      async () => {
        const req = { method: 'POST', headers: {}, body: { accountName: 'Acme Co' } };
        const res = makeRes();
        await researchAccountHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 401, 'REQUIRED (item 1): research-account.js rejects a request with no Authorization header (401)');
    assert(fetchCalls === 0, 'REQUIRED (item 1): a request with no token makes zero downstream calls, including no paid-provider calls');
  }
  {
    setBaseEnv();
    const { res, fetchCalls, calledUrls } = await withFetch(
      async (url) => (url.includes('/auth/v1/user') ? jsonResponse({}, false, 401) : (() => { throw new Error(`unexpected fetch: ${url}`); })()),
      async () => {
        const req = { method: 'POST', headers: { authorization: 'Bearer not-a-real-token' }, body: { accountName: 'Acme Co' } };
        const res = makeRes();
        await researchAccountHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 401, 'REQUIRED (item 1): research-account.js rejects an invalid/expired Bearer token (401)');
    assert(fetchCalls === 1 && calledUrls[0].includes('/auth/v1/user'), 'the only call made for an invalid token is the auth verification itself -- no paid-provider call happens first');
  }

  // =========================================================================
  // Item 4 (research-account.js half): an authenticated caller passes the
  // gate and reaches real orchestration (proven by NOT getting 401, and by
  // the very first call being the auth check, before anything else).
  // =========================================================================
  {
    setBaseEnv();
    const { res, calledUrls } = await withFetch(
      async (url) => (url.includes('/auth/v1/user') ? jsonResponse({ id: 'auth-1', email: 'seller@example.com' }) : htmlResponse('')),
      async () => {
        const req = { method: 'POST', headers: { authorization: 'Bearer valid-token' }, body: { accountName: 'Acme Co' } };
        const res = makeRes();
        await researchAccountHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 200, 'REQUIRED (item 4): research-account.js proceeds to normal orchestration (200) for a validly authenticated caller');
    assert(calledUrls[0].includes('/auth/v1/user'), 'authentication is verified before any provider call, even for an authorized caller');
  }

  // =========================================================================
  // Item 2: an anonymous caller cannot invoke paid api/research-batch.js
  // (the former "anonymous prospecting" default/prospect-intelligence path,
  // and the default 'ranked' mode -- proving the fix is not scoped to one
  // literal mode string).
  // =========================================================================
  for (const mode of ['prospect-intelligence', 'warm-account', undefined]) {
    setBaseEnv();
    const body = { accounts: [{ name: 'Acme Co' }] };
    if (mode) body.mode = mode;
    const { res, fetchCalls } = await withFetch(
      () => { throw new Error('should not be called'); },
      async () => {
        const req = { method: 'POST', headers: {}, body };
        const res = makeRes();
        await researchBatchHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 401, `REQUIRED (item 2): research-batch.js rejects an unauthenticated request for mode=${mode || '(default)'} (401)`);
    assert(fetchCalls === 0, `REQUIRED (item 2): mode=${mode || '(default)'} with no token makes zero downstream/paid-provider calls`);
  }
  {
    setBaseEnv();
    const { res, fetchCalls, calledUrls } = await withFetch(
      async (url) => (url.includes('/auth/v1/user') ? jsonResponse({}, false, 401) : (() => { throw new Error(`unexpected fetch: ${url}`); })()),
      async () => {
        const req = { method: 'POST', headers: { authorization: 'Bearer not-a-real-token' }, body: { mode: 'prospect-intelligence', accounts: [{ name: 'Acme Co' }] } };
        const res = makeRes();
        await researchBatchHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 401, 'REQUIRED (item 2): research-batch.js rejects an invalid Bearer token for the anonymous-prospecting path (401)');
    assert(fetchCalls === 1 && calledUrls[0].includes('/auth/v1/user'), 'only the auth check itself is called before rejection -- no paid-provider request is made');
  }

  // =========================================================================
  // Item 4 (research-batch.js half): a validly authenticated caller passes
  // the new gate for the no-uploadId path (proven by reaching the
  // pre-existing OPENAI_API_KEY check instead of being rejected 401).
  // =========================================================================
  {
    setBaseEnv();
    const { res, calledUrls } = await withFetch(
      async (url) => (url.includes('/auth/v1/user') ? jsonResponse({ id: 'auth-1' })
        : url.includes('/rest/v1/ha_users') ? jsonResponse([{ id: 'user-1', email: 'seller@example.com' }])
        : (() => { throw new Error(`unexpected fetch: ${url}`); })()),
      async () => {
        const req = { method: 'POST', headers: { authorization: 'Bearer valid-token' }, body: { mode: 'prospect-intelligence', accounts: [{ name: 'Acme Co' }] } };
        const res = makeRes();
        await researchBatchHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 400 && res.body?.error === 'OPENAI_API_KEY not configured', 'REQUIRED (item 4): an authenticated caller reaches the pre-existing OPENAI_API_KEY check for the anonymous-prospecting path, not the new 401 auth gate');
    assert(calledUrls[0].includes('/auth/v1/user'), 'authentication is verified before any other processing');
  }

  // =========================================================================
  // Item 6: the weekly cron / internal research path remains fully
  // functional and is unaffected by the new caller-auth gate (it is
  // exempted because it already passed the pre-existing CRON_SECRET check).
  // =========================================================================
  {
    setBaseEnv();
    process.env.CRON_SECRET = 'test-cron-secret-1234567890';
    const { res, fetchCalls } = await withFetch(
      () => { throw new Error('should not be called'); },
      async () => {
        const req = { method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, body: { mode: 'weekly-monitoring', accounts: [{ name: 'Acme Co' }] } };
        const res = makeRes();
        await researchBatchHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 400 && res.body?.error === 'OPENAI_API_KEY not configured', 'REQUIRED (item 6): a correctly authenticated weekly-monitoring cron request is unaffected by the new caller-auth gate and reaches its own pre-existing logic');
    assert(fetchCalls === 0, 'a correct CRON_SECRET requires no Supabase auth call at all -- the weekly-monitoring path never calls resolveAuthenticatedCaller()');
  }

  // =========================================================================
  // Item 3: an anonymous caller cannot attach prospect data to an existing
  // user by asserting their email (api/save-prospect-upload.js).
  // =========================================================================
  {
    setBaseEnv();
    const { res, fetchCalls } = await withFetch(
      () => { throw new Error('should not be called'); },
      async () => {
        const req = { method: 'POST', headers: {}, body: { lead: { email: 'victim@example.com' }, accounts: [{ companyName: 'Acme Co' }] } };
        const res = makeRes();
        await saveProspectUploadHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 401, 'REQUIRED (item 3): save-prospect-upload.js rejects an anonymous request that asserts an existing user\'s email (401)');
    assert(fetchCalls === 0, 'REQUIRED (item 3): the rejected request makes zero Supabase writes -- lead.email is never consulted as identity');
  }

  // =========================================================================
  // Item 4 (save-prospect-upload.js half) + defense-in-depth on item 3: an
  // authenticated caller's save succeeds, and the persisted user_email comes
  // from the VERIFIED token, never from body.lead.email -- even when
  // lead.email is present and names a different (victim) address.
  // =========================================================================
  {
    setBaseEnv();
    let uploadWriteBody = null;
    const { res } = await withFetch(
      async (url, options = {}) => {
        if (url.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-1', email: 'real-owner@example.com' });
        if (url.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([{ id: 'user-1', email: 'real-owner@example.com' }]);
        if (url.includes('/rest/v1/ha_prospect_uploads') && options.method === 'POST') {
          uploadWriteBody = JSON.parse(options.body)[0];
          return jsonResponse([{ id: 'upload-99' }]);
        }
        if (url.includes('/rest/v1/ha_prospect_accounts') && options.method === 'POST') return jsonResponse(JSON.parse(options.body).map((r, i) => ({ ...r, id: `acct-${i}` })));
        if (url.includes('/rest/v1/ha_prospect_signals') && options.method === 'POST') return jsonResponse([]);
        throw new Error(`unexpected fetch: ${url}`);
      },
      async () => {
        const req = {
          method: 'POST',
          headers: { authorization: 'Bearer valid-token' },
          body: { lead: { email: 'victim@example.com', name: 'Attacker' }, accounts: [{ companyName: 'Acme Co' }] }
        };
        const res = makeRes();
        await saveProspectUploadHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 200, 'REQUIRED (item 4): an authenticated caller\'s save-prospect-upload.js save succeeds normally');
    assert(res.body?.userEmail === 'real-owner@example.com', 'REQUIRED (item 3 defense-in-depth): the persisted/returned user email is the VERIFIED token identity, never body.lead.email, even when lead.email names a different address');
    assert(uploadWriteBody?.user_email === 'real-owner@example.com', 'REQUIRED (item 3 defense-in-depth): the actual Supabase write uses the verified email, not the client-supplied lead.email ("victim@example.com" never appears in the write)');
  }

  // =========================================================================
  // Item 3 (save-upload.js half): the legacy anonymous lead.email
  // upload-creation fallback is fully closed, both for an existing upload
  // and for the "genuinely new upload" case that used to be exempted.
  // =========================================================================
  {
    setBaseEnv();
    const { res, fetchCalls } = await withFetch(
      () => { throw new Error('should not be called'); },
      async () => {
        const req = { method: 'POST', headers: {}, body: { lead: { email: 'victim@example.com' }, uploadId: 'upload-1', stage: 'uploaded', accounts: [{ name: 'Acme Co', signals: [] }] } };
        const res = makeRes();
        await saveUploadHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 401, 'REQUIRED (item 3): save-upload.js rejects an anonymous request against an existing uploadId that asserts an existing user\'s email (401)');
    assert(fetchCalls === 0, 'the rejected request makes zero Supabase calls');
  }
  {
    setBaseEnv();
    const { res, fetchCalls } = await withFetch(
      () => { throw new Error('should not be called'); },
      async () => {
        // The formerly-legitimate anonymous-creation case: stage="uploaded", NO
        // uploadId. This branch is now closed entirely, not narrowed.
        const req = { method: 'POST', headers: {}, body: { lead: { email: 'brand-new-anonymous@example.com', name: 'New Lead' }, stage: 'uploaded', accounts: [{ name: 'Acme Co', signals: [] }] } };
        const res = makeRes();
        await saveUploadHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 401, 'REQUIRED (item 3): save-upload.js\'s formerly-legitimate anonymous new-upload-creation fallback (stage=uploaded, no uploadId, no token) is now rejected 401, not preserved');
    assert(fetchCalls === 0, 'the rejected anonymous new-upload attempt makes zero Supabase writes');
  }

  // =========================================================================
  // Item 5: one user/organization cannot write into another user's data.
  // A validly authenticated caller (user-1) whose token resolves correctly,
  // targeting an uploadId actually owned by a DIFFERENT user (user-2), is
  // rejected 403 before any mutation.
  // =========================================================================
  {
    setBaseEnv();
    let mutationAttempted = false;
    const { res } = await withFetch(
      async (url, options = {}) => {
        if (url.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-1', email: 'user-one@example.com' });
        if (url.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([{ id: 'user-1', email: 'user-one@example.com', organization_id: null }]);
        if (url.includes('/rest/v1/ha_uploads') && url.includes('user_id=eq.') && (!options.method || options.method === 'GET')) {
          // upload-1 belongs to user-2, not the authenticated user-1 -- this
          // scoped SELECT correctly returns nothing.
          return jsonResponse([]);
        }
        mutationAttempted = true;
        throw new Error(`unexpected mutation attempt: ${url}`);
      },
      async () => {
        const req = { method: 'POST', headers: { authorization: 'Bearer user-one-token' }, body: { uploadId: 'upload-1', stage: 'accounts_updated', accounts: [{ name: 'Hijack Attempt', signals: [] }] } };
        const res = makeRes();
        await saveUploadHandler(req, res);
        return { res };
      }
    );
    assert(res.statusCode === 403, 'REQUIRED (item 5): a validly authenticated user targeting an uploadId owned by a different user/org is rejected 403');
    assert(!mutationAttempted, 'REQUIRED (item 5): no write of any kind is attempted once cross-owner access is detected');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
