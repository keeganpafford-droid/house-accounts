// Founder notification sprint: internal notifications to keegan@houseaccounts.ai
// on (1) a genuine new House Accounts signup and (2) a user's first
// successful login, sent from api/auth.js. Drives the REAL, production-bound
// handler export (mocked Supabase + Resend fetch), same convention as
// scripts/test-security-correction-anonymous-endpoints.js.
//
// Note on scope: api/auth.js's signup action ALSO performs the user's first
// login as part of establishing their session (this is pre-existing,
// unchanged behavior -- see recordLogin() being called from both the
// signup and login branches). A genuinely new signup is therefore also,
// correctly, that user's first login -- so the signup scenario below
// expects BOTH a "new signup" email and a "user activated" email, one of
// each. The standalone "first login" and "later login" scenarios exercise
// the login action directly, for a user who already has an ha_users row
// (e.g. from an invite) but has never logged in yet.
//
// Usage: node scripts/test-founder-notifications.js
import handler from '../api/auth.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}
function makeReq(body) {
  return { method: 'POST', headers: {}, body };
}

function setBaseEnv() {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.RESEND_API_KEY = 'fake-resend-key';
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.ALERTS_FROM_EMAIL;
}

async function withMockFetch(handlers, fn) {
  const real = global.fetch;
  const resendCalls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u === 'https://api.resend.com/emails') {
      const body = JSON.parse(options.body);
      resendCalls.push(body);
      return handlers.resend ? handlers.resend(body) : jsonResponse({ id: 'email-1' });
    }
    for (const h of handlers.routes) {
      const result = h(u, options);
      if (result !== undefined) return result;
    }
    throw new Error(`unexpected fetch call in test: ${u}`);
  };
  try {
    return { ...(await fn()), resendCalls };
  } finally {
    global.fetch = real;
  }
}

// ---------------------------------------------------------------------------
// Test 1: a genuine new signup -- exactly one "new signup" email AND exactly
// one "user activated" email (signup performs the user's own first login,
// see the header note above), both addressed to the founder, both from the
// House Accounts sender address, and both grounded in the verified/created
// identity (never raw request-body fields beyond what was legitimately used
// to create the account).
// ---------------------------------------------------------------------------
async function testGenuineNewSignup() {
  setBaseEnv();
  const routes = [
    (u, o) => (u.includes('/auth/v1/admin/users') && o.method === 'POST')
      ? jsonResponse({ id: 'auth-1', email: 'newuser@example.com', user_metadata: JSON.parse(o.body).user_metadata })
      : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([]) : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('email=eq.newuser%40example.com')) ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_organizations') && o.method === 'POST')
      ? jsonResponse([{ id: 'org-1', name: 'Acme Inc' }])
      : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'POST')
      ? jsonResponse([{ ...JSON.parse(o.body)[0], id: 'user-1' }]) // no login_count key -> falsy -> first login
      : undefined,
    (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
      ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-1', email: 'newuser@example.com' } })
      : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ id: 'user-1' }]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
  ];
  const { res, resendCalls } = await withMockFetch({ routes }, async () => {
    const req = makeReq({ action: 'signup', email: 'newuser@example.com', password: 'Sup3rSecret!1', name: 'New User', organizationName: 'Acme Inc' });
    const res = makeRes();
    await handler(req, res);
    return { res };
  });

  assert(res.statusCode === 200, `REQUIRED: signup succeeds (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
  const signupEmails = resendCalls.filter(c => String(c.subject || '').startsWith('New House Accounts signup'));
  const activationEmails = resendCalls.filter(c => String(c.subject || '').startsWith('House Accounts user activated'));
  assert(signupEmails.length === 1, `REQUIRED: exactly one "new signup" founder email is sent for a genuine new signup (got ${signupEmails.length})`);
  assert(activationEmails.length === 1, `signup also performs the new user's first login, so exactly one "user activated" email is sent too (got ${activationEmails.length})`);
  assert(resendCalls.length === 2, `no other founder emails are sent for a signup (got ${resendCalls.length} total)`);

  const signupEmail = signupEmails[0];
  assert(signupEmail.subject === 'New House Accounts signup — newuser@example.com', `signup subject matches the required format (got ${JSON.stringify(signupEmail.subject)})`);
  assert(signupEmail.to === 'keegan@houseaccounts.ai', `REQUIRED: the signup notification is addressed to keegan@houseaccounts.ai (got ${JSON.stringify(signupEmail.to)})`);
  assert(signupEmail.from === 'House Accounts <hello@houseaccounts.ai>', `REQUIRED: the signup notification is sent from House Accounts <hello@houseaccounts.ai> (got ${JSON.stringify(signupEmail.from)})`);
  assert(signupEmail.html.includes('New User') && signupEmail.html.includes('newuser@example.com') && signupEmail.html.includes('Acme Inc'), 'signup notification includes name, email, and organization/company');

  const activationEmail = activationEmails[0];
  assert(activationEmail.subject === 'House Accounts user activated — newuser@example.com', `activation subject matches the required format (got ${JSON.stringify(activationEmail.subject)})`);
  assert(activationEmail.to === 'keegan@houseaccounts.ai' && activationEmail.from === 'House Accounts <hello@houseaccounts.ai>', 'activation notification uses the same founder recipient/sender');
}
await testGenuineNewSignup();

// ---------------------------------------------------------------------------
// Test 2: a standalone first successful login (an existing ha_users row --
// e.g. created via a team invite -- that has never logged in, login_count
// falsy) sends exactly one "user activated" email and zero signup emails.
// ---------------------------------------------------------------------------
async function testFirstStandaloneLogin() {
  setBaseEnv();
  const existingRow = { id: 'user-2', email: 'member@example.com', name: 'Existing Member', company: 'Beta Co', organization_id: 'org-2', auth_user_id: 'auth-2', login_count: 0 };
  const routes = [
    (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
      ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-2', email: 'member@example.com' } })
      : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([existingRow]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ ...existingRow, ...JSON.parse(o.body) }]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
  ];
  const { res, resendCalls } = await withMockFetch({ routes }, async () => {
    const req = makeReq({ action: 'login', email: 'member@example.com', password: 'whatever-the-real-password-is' });
    const res = makeRes();
    await handler(req, res);
    return { res };
  });

  assert(res.statusCode === 200, `REQUIRED: login succeeds (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
  assert(resendCalls.length === 1, `REQUIRED: exactly one founder email is sent for a user's first successful login (got ${resendCalls.length})`);
  const email = resendCalls[0];
  assert(email.subject === 'House Accounts user activated — member@example.com', `activation subject matches the required format (got ${JSON.stringify(email.subject)})`);
  assert(email.html.includes('Existing Member') && email.html.includes('member@example.com') && email.html.includes('Beta Co'), 'activation notification includes name, email, and organization/company');
}
await testFirstStandaloneLogin();

// ---------------------------------------------------------------------------
// Test 3: a later login (login_count already >= 1) sends NO additional
// activation email -- the persisted login_count marker, not browser state,
// makes this deterministic.
// ---------------------------------------------------------------------------
async function testLaterLoginNoEmail() {
  setBaseEnv();
  const existingRow = { id: 'user-2', email: 'member@example.com', name: 'Existing Member', company: 'Beta Co', organization_id: 'org-2', auth_user_id: 'auth-2', login_count: 5 };
  const routes = [
    (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
      ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-2', email: 'member@example.com' } })
      : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([existingRow]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ ...existingRow, ...JSON.parse(o.body) }]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
  ];
  const { res, resendCalls } = await withMockFetch({ routes }, async () => {
    const req = makeReq({ action: 'login', email: 'member@example.com', password: 'whatever-the-real-password-is' });
    const res = makeRes();
    await handler(req, res);
    return { res };
  });

  assert(res.statusCode === 200, `login succeeds (got ${res.statusCode})`);
  assert(resendCalls.length === 0, `REQUIRED: a later login (login_count already >= 1) sends zero founder emails (got ${resendCalls.length})`);
}
await testLaterLoginNoEmail();

// ---------------------------------------------------------------------------
// Test 4: notification delivery failure never blocks or fails the actual
// signup/login response -- proven for both a Resend API error response and
// a hard network failure (fetch throwing), on both the signup and login
// paths.
// ---------------------------------------------------------------------------
async function testNotificationFailureNeverBlocksSignupOrLogin() {
  // 4a: Resend returns a non-ok response during signup.
  {
    setBaseEnv();
    const routes = [
      (u, o) => (u.includes('/auth/v1/admin/users') && o.method === 'POST')
        ? jsonResponse({ id: 'auth-3', email: 'flaky@example.com', user_metadata: JSON.parse(o.body).user_metadata })
        : undefined,
      (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([]) : undefined,
      (u) => (u.includes('/rest/v1/ha_users') && u.includes('email=eq.')) ? jsonResponse([]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_organizations') && o.method === 'POST') ? jsonResponse([{ id: 'org-3', name: 'Flaky Co' }]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'POST') ? jsonResponse([{ ...JSON.parse(o.body)[0], id: 'user-3' }]) : undefined,
      (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
        ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-3', email: 'flaky@example.com' } })
        : undefined,
      (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ id: 'user-3' }]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
    ];
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    const { res } = await withMockFetch({ routes, resend: () => jsonResponse({ message: 'Resend is down' }, false, 500) }, async () => {
      const req = makeReq({ action: 'signup', email: 'flaky@example.com', password: 'Sup3rSecret!1', name: 'Flaky User', organizationName: 'Flaky Co' });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    console.warn = originalWarn;
    assert(res.statusCode === 200, `REQUIRED: a Resend API error during signup still results in a successful signup (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
    assert(!!res.body?.session?.access_token, 'REQUIRED: the signup response still includes a real session even though the founder notification failed');
    assert(warnings.some(w => w.includes('[auth] founder notification failed')), 'the notification failure is logged server-side, not silently discarded without a trace');
  }

  // 4b: the notification fetch itself throws (hard network failure) during
  // a first login.
  {
    setBaseEnv();
    const existingRow = { id: 'user-4', email: 'member2@example.com', name: 'Member Two', company: 'Gamma Co', organization_id: 'org-4', auth_user_id: 'auth-4', login_count: 0 };
    const routes = [
      (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
        ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-4', email: 'member2@example.com' } })
        : undefined,
      (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([existingRow]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ ...existingRow, ...JSON.parse(o.body) }]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
    ];
    const { res } = await withMockFetch({ routes, resend: () => { throw new Error('simulated network failure reaching Resend'); } }, async () => {
      const req = makeReq({ action: 'login', email: 'member2@example.com', password: 'whatever-the-real-password-is' });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 200, `REQUIRED: a hard network failure reaching Resend during a first login still results in a successful login (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
    assert(!!res.body?.session?.access_token, 'REQUIRED: the login response still includes a real session even though the founder notification failed');
  }
}
await testNotificationFailureNeverBlocksSignupOrLogin();

// ---------------------------------------------------------------------------
// Test 5: identity for the notification comes from the VERIFIED Supabase
// auth response, never from the raw request body. A caller submits a login
// request with a spoofed body.email; the Supabase password-grant response
// (the actual verified identity) names a different address, and the
// resulting founder notification must reflect ONLY the verified address.
// ---------------------------------------------------------------------------
async function testIdentityFromVerifiedAuthNotRequestBody() {
  setBaseEnv();
  const existingRow = { id: 'user-5', email: 'real-owner@example.com', name: 'Real Owner', company: 'RealCo', organization_id: 'org-5', auth_user_id: 'auth-5', login_count: 0 };
  const routes = [
    (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
      // The verified Supabase response names the REAL account owner --
      // deliberately different from the spoofed body.email below.
      ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-5', email: 'real-owner@example.com' } })
      : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([existingRow]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ ...existingRow, ...JSON.parse(o.body) }]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
  ];
  const { res, resendCalls } = await withMockFetch({ routes }, async () => {
    // NOTE: the real api/auth.js login action still uses body.email to
    // attempt the Supabase password grant itself (that attempt IS the
    // identity verification step) -- but the resulting notification must be
    // built from the grant's own returned user, not this value.
    const req = makeReq({ action: 'login', email: 'attacker-supplied@evil.com', password: 'irrelevant-in-this-mock' });
    const res = makeRes();
    await handler(req, res);
    return { res };
  });

  assert(res.statusCode === 200, `login succeeds (got ${res.statusCode})`);
  assert(resendCalls.length === 1, `exactly one activation email is sent (got ${resendCalls.length})`);
  const email = resendCalls[0];
  assert(email.subject.includes('real-owner@example.com'), `REQUIRED: the notification identifies the VERIFIED account owner (got subject ${JSON.stringify(email.subject)})`);
  assert(!email.subject.includes('attacker-supplied@evil.com'), 'REQUIRED: the notification subject never contains the spoofed request-body email');
  assert(email.html.includes('real-owner@example.com') && !email.html.includes('attacker-supplied@evil.com'), 'REQUIRED: the notification body reflects only the verified identity, never the unverified request-body email');
}
await testIdentityFromVerifiedAuthNotRequestBody();

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
