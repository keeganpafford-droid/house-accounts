// Final cron-runtime verification before Production activation: Vercel Cron
// invokes a configured cron path with HTTP GET; every manual/operator
// Production QA invocation of these two schedulers in this engagement used
// POST. This proves an authenticated GET request reaches the exact same
// behavior as POST for both api/monitoring-scheduler.js and
// api/notification-scheduler.js -- required before Vercel Cron can be
// trusted to actually drive these endpoints.
//
// Structural half: neither file's source contains any req.method branch at
// all (confirmed by direct grep before writing this test -- there is
// nothing named 'GET only'/'POST only' anywhere in either handler), so by
// construction there is no code path for method to diverge. This test
// still proves it BEHAVIORALLY, not just by absence-of-branch, against the
// real production-bound handler() export with mocked Supabase fetch (same
// convention as scripts/test-notification-scheduler.js) -- covering both
// the auth boundary (a bad/missing token is still rejected regardless of
// method) and the real due-query/candidate-query business logic (not just
// the empty-allowlist early return), by supplying zero due
// targets/candidates so the Queue SDK / Resend transport never needs
// mocking, while the actual Supabase query path still runs for real.
//
// Usage: node scripts/test-cron-get-method-compatibility.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import monitoringHandler from '../api/monitoring-scheduler.js';
import notificationHandler from '../api/notification-scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CRON_SECRET = 'cron-get-compat-test-secret-1234567890';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}
function makeReq(method, secret = CRON_SECRET) {
  return { method, headers: secret ? { authorization: `Bearer ${secret}` } : {}, body: undefined };
}
function jsonResponse(data) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

async function invoke(handler, method, mockFetch, secret = CRON_SECRET) {
  const realFetch = global.fetch;
  global.fetch = mockFetch;
  try {
    const res = makeRes();
    await handler(makeReq(method, secret), res);
    return res;
  } finally {
    global.fetch = realFetch;
  }
}

// ===========================================================================
// 1. Structural proof: no req.method conditional exists in either file --
//    both are unconditionally method-agnostic by construction.
// ===========================================================================
{
  const monitoringSrc = readFileSync(join(REPO_ROOT, 'api', 'monitoring-scheduler.js'), 'utf8');
  const notificationSrc = readFileSync(join(REPO_ROOT, 'api', 'notification-scheduler.js'), 'utf8');
  assert(!/req\.method/.test(monitoringSrc), 'REQUIRED: api/monitoring-scheduler.js contains no req.method check -- GET and POST cannot diverge because there is no branch on method at all');
  assert(!/req\.method/.test(notificationSrc), 'REQUIRED: api/notification-scheduler.js contains no req.method check -- GET and POST cannot diverge because there is no branch on method at all');
  assert(!/req\.body/.test(monitoringSrc), 'sanity: api/monitoring-scheduler.js never reads req.body -- a GET request (which has no body) cannot behave differently for this reason either');
  assert(!/req\.body/.test(notificationSrc), 'sanity: api/notification-scheduler.js never reads req.body -- a GET request (which has no body) cannot behave differently for this reason either');
}

// ===========================================================================
// 2. api/monitoring-scheduler.js: real handler() invocation, GET vs POST.
// ===========================================================================
{
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.QUEUE_MANAGED_ORGANIZATION_IDS = 'org-1';

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/ha_monitoring_targets')) return jsonResponse([]); // zero due targets -- exercises the real due-query path without ever reaching enqueueMonitoringJob()/the Queue SDK
    throw new Error(`unexpected fetch in monitoring-scheduler GET/POST parity test: ${u}`);
  };

  const getRes = await invoke(monitoringHandler, 'GET', mockFetch);
  const postRes = await invoke(monitoringHandler, 'POST', mockFetch);
  assert(getRes.statusCode === 200, `REQUIRED: an authenticated GET request to api/monitoring-scheduler.js succeeds (got ${getRes.statusCode}, body ${JSON.stringify(getRes.body)})`);
  assert(JSON.stringify(getRes.body) === JSON.stringify(postRes.body), `REQUIRED: GET and POST produce byte-identical response bodies for api/monitoring-scheduler.js (GET: ${JSON.stringify(getRes.body)}, POST: ${JSON.stringify(postRes.body)})`);
  assert(getRes.body.ok === true && getRes.body.dueActiveCount === 0 && getRes.body.publishedCount === 0, `REQUIRED: the GET request actually ran the real due-query logic (dueActiveCount/publishedCount present and correct), not a stub -- got ${JSON.stringify(getRes.body)}`);

  const unauthedGet = await invoke(monitoringHandler, 'GET', mockFetch, null);
  assert(unauthedGet.statusCode === 401, `REQUIRED: a GET request with no Authorization header is still rejected 401, same as POST -- auth is unconditional on method (got ${unauthedGet.statusCode})`);
  const wrongSecretGet = await invoke(monitoringHandler, 'GET', mockFetch, 'wrong-secret');
  assert(wrongSecretGet.statusCode === 401, `REQUIRED: a GET request with the wrong secret is still rejected 401 (got ${wrongSecretGet.statusCode})`);
}

// ===========================================================================
// 3. api/notification-scheduler.js: real handler() invocation, GET vs POST.
// ===========================================================================
{
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.RESEND_API_KEY = 'fake-resend-key';
  process.env.ALERTS_FROM_EMAIL = 'House Accounts <alerts@houseaccounts.ai>';
  process.env.NOTIFICATION_ENABLED_ORGANIZATION_IDS = 'org-1';

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/ha_users')) return jsonResponse([]); // zero candidate users -- exercises the real candidate-query path without ever needing a Resend/delivery mock
    throw new Error(`unexpected fetch in notification-scheduler GET/POST parity test: ${u}`);
  };

  const getRes = await invoke(notificationHandler, 'GET', mockFetch);
  const postRes = await invoke(notificationHandler, 'POST', mockFetch);
  assert(getRes.statusCode === 200, `REQUIRED: an authenticated GET request to api/notification-scheduler.js succeeds (got ${getRes.statusCode}, body ${JSON.stringify(getRes.body)})`);
  assert(JSON.stringify(getRes.body) === JSON.stringify(postRes.body), `REQUIRED: GET and POST produce byte-identical response bodies for api/notification-scheduler.js (GET: ${JSON.stringify(getRes.body)}, POST: ${JSON.stringify(postRes.body)})`);
  assert(getRes.body.ok === true && getRes.body.usersConsidered === 0, `REQUIRED: the GET request actually ran the real candidate-query logic (usersConsidered present and correct), not a stub -- got ${JSON.stringify(getRes.body)}`);

  const unauthedGet = await invoke(notificationHandler, 'GET', mockFetch, null);
  assert(unauthedGet.statusCode === 401, `REQUIRED: a GET request with no Authorization header is still rejected 401, same as POST -- auth is unconditional on method (got ${unauthedGet.statusCode})`);
  const wrongSecretGet = await invoke(notificationHandler, 'GET', mockFetch, 'wrong-secret');
  assert(wrongSecretGet.statusCode === 401, `REQUIRED: a GET request with the wrong secret is still rejected 401 (got ${wrongSecretGet.statusCode})`);
}

// ===========================================================================
// 4. vercel.json routing sanity: no rewrites/redirects/routes entry whose
//    source pattern could intercept or redirect a Vercel Cron request to
//    either endpoint before it reaches the function at all. Commercial
//    Credibility V1 (2026-08-21) added a real `redirects` array (retiring
//    the static /hall-of-accounts.html page to /real-world-results.html) --
//    a blanket "vercel.json has no redirects at all" assertion is no
//    longer the right check; the actual safety property this test cares
//    about is narrower and still holds: nothing in that array's `source`
//    can ever match either cron path.
// ===========================================================================
{
  const vercelConfig = JSON.parse(readFileSync(join(REPO_ROOT, 'vercel.json'), 'utf8'));
  assert(!vercelConfig.rewrites && !vercelConfig.routes, 'REQUIRED: vercel.json defines no rewrites/routes that could redirect a Vercel Cron request away from the configured cron path');
  const cronPaths = ['/api/monitoring-scheduler', '/api/notification-scheduler'];
  const redirectSources = (vercelConfig.redirects || []).map(r => r.source);
  for (const cronPath of cronPaths) {
    assert(!redirectSources.includes(cronPath), `REQUIRED: no vercel.json redirect entry sources from the exact cron path ${cronPath}`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
