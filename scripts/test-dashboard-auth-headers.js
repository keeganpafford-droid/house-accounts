// Release-blocker fix verification: dashboard/index.html's protected /api
// fetch call sites (the monitoring-lists request() helper, loadDashboardUsage(),
// claimAutomaticResearchRun(), heartbeatCurrentResearchRun(),
// reportResearchRunOutcome()) used to attach whatever access_token happened
// to be cached in localStorage via the SYNCHRONOUS HouseAuth.authHeaders(),
// with no expiry check. auth-client.js's own proactive refresh
// (requireAuth()'s refreshIfNeeded() call) only ran ONCE, at page load --
// once the access token's own TTL elapsed during a long-lived dashboard
// session, every later request silently sent a stale Bearer token and the
// server correctly 401'd it (observed in Preview QA against
// /api/monitoring-lists, /api/usage, and /api/research-batch).
//
// This does NOT mock away auth-client.js. It loads the REAL auth-client.js
// source into a vm sandbox (fake localStorage, fake fetch, a settable
// window.location.href to observe redirects) so the real
// refreshIfNeeded()/authHeadersAsync()/goToLogin() logic actually runs, then
// loads the REAL extracted dashboard/index.html call sites into the SAME
// sandbox (sharing the one real window.HouseAuth those functions look up at
// call time), and drives them with a mock fetch that records every request's
// headers.
//
// Covers:
// - the monitoring-lists request(), /api/usage, and research
//   claim/heartbeat/outcome requests each include the CURRENT session's
//   Bearer token
// - an expired (or within-buffer) session is refreshed via /api/auth BEFORE
//   the protected request is sent, and the request carries the NEW
//   post-refresh token, not the stale one
// - a session with no refresh_token, or one whose refresh_token is rejected
//   by the server, results in NO protected request being sent at all, and a
//   redirect to /login
// - no SUPABASE_SERVICE_ROLE_KEY (or any other server secret) appears
//   anywhere in browser-served files
// - existing request method/body/error-handling contracts are unchanged
//   (request()'s thrown-error-on-!ok behavior, claimAutomaticResearchRun()'s
//   {ok,status,data} return shape, heartbeat/reportOutcome's best-effort
//   silent-skip behavior)
//
// What this CANNOT prove without a real browser: that a genuine Supabase
// access token/refresh token pair round-trips correctly through actual
// Supabase Auth endpoints. api/auth.js's own real /auth/v1/token calls are
// exercised by this file's mock only as a stand-in for that live behavior.
//
// Usage: node scripts/test-dashboard-auth-headers.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Part 0: static check -- no service-role secret anywhere in browser-served
// files. Run first, independent of the sandbox below.
// ===========================================================================
{
  const browserFiles = [
    'auth-client.js',
    'dashboard/index.html',
    'settings.html',
    'admin/index.html',
    '_script.js',
    'prospect_script.js'
  ];
  let leaked = [];
  for(const rel of browserFiles){
    const path = join(REPO_ROOT, rel);
    let src;
    try{ src = readFileSync(path, 'utf8'); } catch { continue; }
    if(/SUPABASE_SERVICE_ROLE_KEY/.test(src) || /service_role/i.test(src)) leaked.push(rel);
  }
  assert(leaked.length === 0, `no SUPABASE_SERVICE_ROLE_KEY / service_role reference in any browser-served file (checked: ${browserFiles.join(', ')})${leaked.length ? ` -- FOUND IN: ${leaked.join(', ')}` : ''}`);
}

// ===========================================================================
// Extraction helpers (same fail-loud contract as
// scripts/test-dashboard-orchestration.js's extractFn/extractRaw, tolerant
// of the single-space indentation this specific region of dashboard/index.html
// happens to use).
// ===========================================================================
const DASHBOARD_SRC = readFileSync(join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8');
const DASHBOARD_LINES = DASHBOARD_SRC.split('\n');
function extractFn(name, startLine, endLine, {async: isAsync = false} = {}){
  const slice = DASHBOARD_LINES.slice(startLine - 1, endLine).join('\n');
  const trimmedStart = slice.replace(/^\s+/, '');
  const expectedPrefix = `${isAsync ? 'async ' : ''}function ${name}(`;
  if(!trimmedStart.startsWith(expectedPrefix)){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-dashboard-auth-headers.js.`);
  }
  if(!slice.trimEnd().endsWith('}')){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${endLine} does not close the function body as expected -- update the line range.`);
  }
  return slice;
}
// ROUND 12: line ranges re-derived after this round's changes shifted the
// file -- extractFn()'s own signature/closing-brace checks are the actual
// correctness guarantee, not these numbers.
const EXTRACTED = {
  // Scaling round: shifted by the pagination-rewrite's CSS insertion
  // (~line 2006) and dashboard/index.html's Manage Customer Accounts
  // additions further down -- bodies of these functions are unchanged.
  claimAutomaticResearchRun: extractFn('claimAutomaticResearchRun', 2530, 2540, {async: true}),
  heartbeatCurrentResearchRun: extractFn('heartbeatCurrentResearchRun', 2603, 2620, {async: true}),
  reportResearchRunOutcome: extractFn('reportResearchRunOutcome', 2634, 2659, {async: true}),
  loadDashboardUsage: extractFn('loadDashboardUsage', 2681, 2691, {async: true}),
  request: extractFn('request', 10664, 10681, {async: true})
};
const REAL_DASHBOARD_SOURCE = Object.values(EXTRACTED).join('\n\n');

// ===========================================================================
// Static regression assertion (in addition to the behavioral ones further
// down): each extracted function's VERBATIM source -- pulled from the real,
// on-disk dashboard/index.html above, not a reconstructed/hand-written
// string -- must call authHeadersAsync() and must NOT call the synchronous
// authHeaders(). This directly answers "is the shipped source what we
// think it is", the exact question a Preview build serving a stale bundle
// raised: this check operates on the actual file contents regardless of
// what any particular deployment happens to be running, so a future
// regression that reintroduces the sync call here fails this test
// immediately, on the very next local/CI run, rather than being
// discovered only via a live 401 in production.
// ===========================================================================
{
  const SYNC_CALL = /authHeaders\(/; // does NOT match "authHeadersAsync(" -- "Async" intervenes before the "("
  const ASYNC_CALL = /authHeadersAsync/;
  for(const [name, src] of Object.entries(EXTRACTED)){
    assert(ASYNC_CALL.test(src), `static: ${name}()'s real, on-disk source contains authHeadersAsync`);
    assert(!SYNC_CALL.test(src), `static: ${name}()'s real, on-disk source contains NO synchronous authHeaders() call`);
  }
}

// ===========================================================================
// Sandbox: the REAL auth-client.js source (unmocked) plus the REAL
// extracted dashboard call sites above, sharing one vm context so
// window.HouseAuth set up by auth-client.js's own IIFE is exactly what the
// dashboard functions look up at call time.
// ===========================================================================
const AUTH_CLIENT_SRC = readFileSync(join(REPO_ROOT, 'auth-client.js'), 'utf8');

function createSandbox({ fetchImpl, initialSession = null }){
  const store = {};
  if(initialSession) store.haAuthSession = JSON.stringify(initialSession);
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const locationState = { href: 'https://example.com/dashboard/', pathname: '/dashboard/', search: '' };
  // Real Object.defineProperty-backed href setter so goToLogin()'s
  // `window.location.href = '/login?next=...'` is observable exactly as it
  // would be in a real browser (a plain data property would work too, but
  // this makes the assignment explicit and inspectable).
  const location = {
    get href(){ return locationState.href; },
    set href(v){ locationState.href = v; },
    get pathname(){ return locationState.pathname; },
    get search(){ return locationState.search; }
  };
  const sandbox = {
    window: {},
    localStorage,
    location,
    fetch: fetchImpl,
    document: { addEventListener: () => {}, documentElement: { dataset: {} } },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout,
    encodeURIComponent,
    Promise,
    JSON
  };
  sandbox.window.location = location;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Real auth-client.js, unmodified, exactly as shipped. It attaches
  // window.HouseAuth = {...} at the end of its IIFE.
  vm.runInContext(AUTH_CLIENT_SRC, sandbox, { filename: 'auth-client.js' });
  // dashboard/index.html's real call sites reference HouseAuth as a bare
  // identifier in some branches (e.g. request()'s `HouseAuth.authHeadersAsync`
  // after the `window.HouseAuth?.authHeadersAsync` guard) -- in a real
  // browser this resolves via window being the global object itself; here
  // window and the vm's contextified global are two separate objects, so
  // the reference has to be mirrored explicitly.
  sandbox.HouseAuth = sandbox.window.HouseAuth;
  // Real dashboard/index.html call sites, sharing sandbox.window.HouseAuth.
  vm.runInContext(`
var currentUploadId = 'upload-1';
var currentUploadName = 'Test Upload';
var currentResearchRunId = 'auto';
var currentResearchAttemptId = 'attempt-1';
var dashboardUsage = null;
var currentDashboardData = null;
var dashboardViewMode = 'team';
function defaultDashboardView(){ return 'team'; }
function renderDashboardUsage(){}
function renderDashboardViewSwitcher(){}
${REAL_DASHBOARD_SOURCE}
`, sandbox, { filename: 'dashboard-extract.js' });
  return { sandbox, locationState };
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const VALID_ACCESS_TOKEN = 'valid-access-token';
const EXPIRING_ACCESS_TOKEN = 'expiring-access-token';
const REFRESHED_ACCESS_TOKEN = 'refreshed-access-token-after-refresh';
const VALID_REFRESH_TOKEN = 'valid-refresh-token';
const DEAD_REFRESH_TOKEN = 'dead-refresh-token';

function freshSession(){
  return { access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN, expires_at: Math.floor(Date.now() / 1000) + 3600 };
}
function expiringSoonSession(){
  // Inside refreshIfNeeded()'s 120s buffer -- must trigger a real refresh.
  return { access_token: EXPIRING_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN, expires_at: Math.floor(Date.now() / 1000) + 30 };
}
function deadSession(){
  return { access_token: EXPIRING_ACCESS_TOKEN, refresh_token: DEAD_REFRESH_TOKEN, expires_at: Math.floor(Date.now() / 1000) - 10 };
}

// Records every fetch call. Handles /api/auth (refresh) genuinely (mirrors
// api/auth.js's real contract: refresh_token in, a new session out, or a
// rejection for DEAD_REFRESH_TOKEN) and every protected endpoint as a
// simple 200/401 responder that records the Authorization header it saw.
function mockFetch(calls){
  return async (url, options = {}) => {
    const u = String(url);
    const headers = options.headers || {};
    calls.push({ url: u, method: options.method || 'GET', headers, body: options.body });
    if(u.includes('/api/auth')){
      const body = options.body ? JSON.parse(options.body) : {};
      if(body.action === 'refresh'){
        if(body.refresh_token === DEAD_REFRESH_TOKEN){
          return jsonResponse({ error: 'Invalid refresh token' }, false, 401);
        }
        return jsonResponse({
          ok: true,
          session: { access_token: REFRESHED_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN, expires_at: Math.floor(Date.now() / 1000) + 3600 },
          user: { id: 'user-1', email: 'qa@example.com' }
        });
      }
      return jsonResponse({ error: 'Unknown auth action' }, false, 400);
    }
    // Every protected endpoint: 401 if no/blank Authorization header,
    // otherwise 200 -- mirrors the real servers' actual behavior closely
    // enough to prove the CLIENT's own header-attachment logic, which is
    // what this file is about (not server-side validation, already covered
    // by scripts/phase2a-rpc-authorization-tests*.sql and the api/*.js unit
    // tests).
    const authHeader = headers.Authorization || headers.authorization || '';
    if(!authHeader) return jsonResponse({ error: 'Authentication required' }, false, 401);
    if(u.includes('/api/monitoring-lists')) return jsonResponse({ ok: true, lists: { customer: [], prospect: [] } });
    if(u.includes('/api/usage')) return jsonResponse({ ok: true, usage: {}, organization: {} });
    if(u.includes('/api/research-batch')) return jsonResponse({ ok: true, outcome: 'claimed-new', researchRunId: 'auto', attemptId: 'attempt-1' });
    return jsonResponse({ ok: true });
  };
}

async function run(){
  // 1) monitoring-lists request() includes the current Bearer token.
  {
    const calls = [];
    const { sandbox } = createSandbox({ fetchImpl: mockFetch(calls), initialSession: freshSession() });
    const result = await sandbox.request('GET');
    const call = calls.find(c => c.url.includes('/api/monitoring-lists'));
    assert(!!call, '1) monitoring-lists request() actually called /api/monitoring-lists');
    assert(call && call.headers.Authorization === `Bearer ${VALID_ACCESS_TOKEN}`, '1) monitoring-lists request() included Authorization: Bearer <current access token>');
    assert(result && result.ok === true, "1) request() still returns the parsed response body on success (existing contract preserved)");
  }

  // 2) /api/usage request includes the current Bearer token.
  {
    const calls = [];
    const { sandbox } = createSandbox({ fetchImpl: mockFetch(calls), initialSession: freshSession() });
    const data = await sandbox.loadDashboardUsage();
    const call = calls.find(c => c.url.includes('/api/usage'));
    assert(!!call, '2) loadDashboardUsage() actually called /api/usage');
    assert(call && call.headers.Authorization === `Bearer ${VALID_ACCESS_TOKEN}`, '2) /api/usage request included Authorization: Bearer <current access token>');
    assert(data && data.ok === true, '2) loadDashboardUsage() still returns the parsed response body on success');
  }

  // 3) research claim/heartbeat/outcome requests include the current Bearer token.
  {
    const calls = [];
    const { sandbox } = createSandbox({ fetchImpl: mockFetch(calls), initialSession: freshSession() });
    const claim = await sandbox.claimAutomaticResearchRun('auto');
    await sandbox.heartbeatCurrentResearchRun({ researchRunId: 'auto', attemptId: 'attempt-1' });
    await sandbox.reportResearchRunOutcome('fail', new Error('boom'), { researchRunId: 'auto', attemptId: 'attempt-1' });
    const researchCalls = calls.filter(c => c.url.includes('/api/research-batch'));
    assert(researchCalls.length === 3, `3) exactly 3 /api/research-batch calls were made (claim + heartbeat + outcome), got ${researchCalls.length}`);
    assert(researchCalls.every(c => c.headers.Authorization === `Bearer ${VALID_ACCESS_TOKEN}`), '3) every one of claim/heartbeat/outcome carried Authorization: Bearer <current access token>');
    assert(claim && claim.ok === true && claim.status === 200 && claim.data && claim.data.outcome === 'claimed-new', "3) claimAutomaticResearchRun() still returns the {ok,status,data} shape (existing contract preserved)");
  }

  // 4) an expired (within-buffer) session is refreshed BEFORE the protected
  // request, and the request carries the NEW token, not the stale one.
  {
    const calls = [];
    const { sandbox } = createSandbox({ fetchImpl: mockFetch(calls), initialSession: expiringSoonSession() });
    await sandbox.request('GET');
    const refreshCall = calls.find(c => c.url.includes('/api/auth'));
    const listCall = calls.find(c => c.url.includes('/api/monitoring-lists'));
    assert(!!refreshCall, '4) a refresh call to /api/auth was made before the protected request');
    assert(refreshCall && calls.indexOf(refreshCall) < calls.indexOf(listCall), '4) the refresh call happened BEFORE the protected request, not after or never');
    assert(listCall && listCall.headers.Authorization === `Bearer ${REFRESHED_ACCESS_TOKEN}`, '4) the protected request carried the NEW post-refresh token, not the stale one');
    assert(listCall && listCall.headers.Authorization !== `Bearer ${EXPIRING_ACCESS_TOKEN}`, '4) the protected request did NOT carry the old, about-to-expire token');
  }

  // 5) a session with no refresh_token at all: no protected request is sent,
  // and the user is redirected to login.
  {
    const calls = [];
    const { sandbox, locationState } = createSandbox({ fetchImpl: mockFetch(calls), initialSession: null });
    let threw = false;
    try{ await sandbox.request('GET'); } catch(e){ threw = true; }
    const listCall = calls.find(c => c.url.includes('/api/monitoring-lists'));
    assert(!listCall, '5) with no session at all, no request was ever sent to /api/monitoring-lists');
    assert(threw, "5) request() throws a clear error instead of silently succeeding with no auth");
    assert(locationState.href.includes('/login'), '5) the user was redirected to /login');
  }

  // 6) a session whose refresh_token is rejected by the server (truly
  // unrefreshable, not just "never had one"): no protected request is sent,
  // and the user is redirected to login.
  {
    const calls = [];
    const { sandbox, locationState } = createSandbox({ fetchImpl: mockFetch(calls), initialSession: deadSession() });
    let threw = false;
    try{ await sandbox.request('GET'); } catch(e){ threw = true; }
    const listCall = calls.find(c => c.url.includes('/api/monitoring-lists'));
    const refreshCall = calls.find(c => c.url.includes('/api/auth'));
    assert(!!refreshCall, '6) a refresh attempt WAS made (the client did try to recover first)');
    assert(!listCall, '6) but no request was ever sent to /api/monitoring-lists once the refresh itself failed');
    assert(threw, '6) request() throws a clear error instead of silently succeeding with no auth');
    assert(locationState.href.includes('/login'), '6) the user was redirected to /login after the unrefreshable session was detected');
  }

  // 7) existing error-handling contract: a non-ok response from the
  // protected endpoint still throws with the server's error message
  // (unchanged by this fix -- only the auth-header attachment changed).
  {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      if(String(url).includes('/api/monitoring-lists')) return jsonResponse({ error: 'Invalid list update' }, false, 400);
      return mockFetch(calls)(url, options);
    };
    const { sandbox } = createSandbox({ fetchImpl, initialSession: freshSession() });
    let message = null;
    try{ await sandbox.request('PATCH', { type: 'bogus' }); } catch(e){ message = e.message; }
    assert(message === 'Invalid list update', `7) request() still surfaces the server's exact error message on a non-ok response (got: ${message})`);
  }

  // 8) existing method/body contract: request() still sends the given
  // method and JSON-stringified body unchanged.
  {
    const calls = [];
    const { sandbox } = createSandbox({ fetchImpl: mockFetch(calls), initialSession: freshSession() });
    await sandbox.request('PATCH', { type: 'account', id: 'acct-1', action: 'delete-account' });
    const call = calls.find(c => c.url.includes('/api/monitoring-lists'));
    assert(call && call.method === 'PATCH', '8) request() still sends the exact method passed in');
    assert(call && call.body === JSON.stringify({ type: 'account', id: 'acct-1', action: 'delete-account' }), '8) request() still JSON-stringifies the exact body passed in, unchanged');
  }

  // 9) best-effort calls (heartbeat/reportOutcome) skip silently, without
  // throwing, when no valid session is obtainable -- unlike request()'s
  // primary-action throw, matching their existing "best-effort, silent on
  // failure" design.
  {
    const calls = [];
    const { sandbox } = createSandbox({ fetchImpl: mockFetch(calls), initialSession: null });
    let threw = false;
    try{
      await sandbox.heartbeatCurrentResearchRun({ researchRunId: 'auto', attemptId: 'attempt-1' });
      await sandbox.reportResearchRunOutcome('fail', new Error('boom'), { researchRunId: 'auto', attemptId: 'attempt-1' });
    }catch(e){ threw = true; }
    const researchCalls = calls.filter(c => c.url.includes('/api/research-batch'));
    assert(!threw, '9) heartbeat/reportOutcome do not throw when no session is available (best-effort contract preserved)');
    assert(researchCalls.length === 0, '9) heartbeat/reportOutcome sent no request at all when no session is available');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
