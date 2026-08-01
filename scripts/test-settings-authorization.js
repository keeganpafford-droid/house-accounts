// Phase 2A / A1 — validates the POST /api/settings action:update-plan
// authorization fix without a live database: mocks global.fetch for both the
// Supabase Auth call and every REST call the handler makes, then invokes the
// real exported `handler` with fake req/res objects and asserts on status
// codes, response bodies, and (for accepted/rejected attempts) the
// structured [settings.audit] console lines.
//
// Usage: node scripts/test-settings-authorization.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler, { CLIENT_REQUESTABLE_PLANS, planConfig, planPatch } from '../api/settings.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

// One fake org + owner user + one fake non-owner member, reused across cases.
const ORG_ID = 'org-1';
let orgState = { id: ORG_ID, name: 'Test Org', plan: 'free', seat_limit: 1, subscription_status: 'inactive', trial_status: 'inactive', trial_used: false, trial_end: null };
const OWNER = { id: 'user-owner', auth_user_id: 'auth-owner', email: 'owner@example.com', organization_id: ORG_ID, app_role: 'owner' };
const MEMBER = { id: 'user-member', auth_user_id: 'auth-member', email: 'member@example.com', organization_id: ORG_ID, app_role: 'member' };

function mockFetch(authUserForToken){
  return async (url, options = {}) => {
    const u = String(url);
    if(u.includes('/auth/v1/user')){
      return jsonResponse({ id: authUserForToken.auth_user_id, email: authUserForToken.email });
    }
    if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')){
      const match = [OWNER, MEMBER].find(x => u.includes(encodeURIComponent(x.auth_user_id)));
      return jsonResponse(match ? [match] : []);
    }
    if(u.includes('/rest/v1/ha_organizations?id=eq.') && (!options.method || options.method === 'GET')){
      return jsonResponse([{ ...orgState }]);
    }
    if(u.includes('/rest/v1/ha_organizations?id=eq.') && options.method === 'PATCH'){
      const patch = JSON.parse(options.body);
      orgState = { ...orgState, ...patch };
      return jsonResponse([{ ...orgState }]);
    }
    if(u.includes('/rest/v1/ha_users?organization_id=eq.')){
      return jsonResponse([OWNER, MEMBER]);
    }
    if(u.includes('/rest/v1/ha_uploads?user_id=')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_accounts?upload_id=')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_monitored_companies?user_id=')) return jsonResponse([], false, 404); // exercised via the handler's own try/catch
    if(u.includes('/rest/v1/ha_prospect_uploads?user_email=eq.')) return jsonResponse([]);
    throw new Error(`Unhandled mock fetch URL in test: ${u}`);
  };
}

function fakeReq({ method = 'POST', token = 'valid-token', body = {} }){
  return { method, headers: { authorization: token ? `Bearer ${token}` : '' }, body };
}
function fakeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}

const originalFetch = global.fetch;
const originalConsoleLog = console.log;
let auditLines = [];
console.log = (...args) => { auditLines.push(args.map(String).join(' ')); originalConsoleLog(...args); };

async function run(){
  // 1. Non-owner org member calls update-plan -> 403, org unchanged, rejection audited.
  {
    orgState = { ...orgState, plan: 'free', subscription_status: 'inactive', trial_status: 'inactive' };
    global.fetch = mockFetch(MEMBER);
    auditLines = [];
    const req = fakeReq({ body: { action: 'update-plan', plan: 'team' } });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 403, 'non-owner org member calling update-plan gets 403');
    assert(orgState.plan === 'free', 'non-owner update-plan attempt leaves the org plan unchanged');
    assert(auditLines.some(l => l.includes('update-plan.rejected') && l.includes('not-owner')), 'a rejected non-owner attempt is written to the audit log');
  }

  // 2. Owner requests plan:'team' while trial not yet used -> succeeds, matches existing trial behavior.
  {
    orgState = { id: ORG_ID, plan: 'free', seat_limit: 1, subscription_status: 'inactive', trial_status: 'inactive', trial_used: false, trial_end: null };
    global.fetch = mockFetch(OWNER);
    auditLines = [];
    const req = fakeReq({ body: { action: 'update-plan', plan: 'team' } });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 200, 'owner requesting team plan (trial not yet used) succeeds');
    assert(orgState.plan === 'team' && orgState.subscription_status === 'trialing', 'org state reflects the team trial after a successful owner-initiated change');
    assert(auditLines.some(l => l.includes('update-plan.applied') && l.includes('"requestedPlan":"team"')), 'a successful owner-initiated change is written to the audit log with the requested plan');
  }

  // 3. Owner requests plan:'enterprise' -> 400, rejected before planPatch ever runs, org unchanged.
  {
    orgState = { id: ORG_ID, plan: 'free', seat_limit: 1, subscription_status: 'inactive', trial_status: 'inactive', trial_used: false, trial_end: null };
    global.fetch = mockFetch(OWNER);
    auditLines = [];
    const req = fakeReq({ body: { action: 'update-plan', plan: 'enterprise' } });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'owner requesting plan:"enterprise" gets 400, not a silent success');
    assert(orgState.plan === 'free', 'an enterprise request leaves the org plan unchanged -- no client-reachable path to self-assign it');
    assert(auditLines.some(l => l.includes('update-plan.rejected') && l.includes('plan-not-allowlisted')), 'a rejected enterprise attempt is written to the audit log');
  }

  // 4. Same test repeated as a non-owner, to confirm rejection does not depend on role for this specific plan value.
  {
    orgState = { id: ORG_ID, plan: 'free', seat_limit: 1, subscription_status: 'inactive', trial_status: 'inactive', trial_used: false, trial_end: null };
    global.fetch = mockFetch(MEMBER);
    const req = fakeReq({ body: { action: 'update-plan', plan: 'enterprise' } });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 403, 'non-owner requesting plan:"enterprise" is rejected on the role check (403), never reaching the plan-allowlist check');
  }

  // 5. Owner requests an unknown/garbage plan string -> 400, not silently coerced to free.
  {
    orgState = { id: ORG_ID, plan: 'team', seat_limit: 25, subscription_status: 'trialing', trial_status: 'active', trial_used: true, trial_end: new Date(Date.now()+30*86400000).toISOString() };
    global.fetch = mockFetch(OWNER);
    const req = fakeReq({ body: { action: 'update-plan', plan: 'super-ultra-plan' } });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'an unrecognized plan string returns 400');
    assert(orgState.plan === 'team', 'an unrecognized plan string does not silently coerce the org to free plan (previous behavior via planConfig() default)');
  }

  // 6. Unauthenticated request -> 401, unaffected by this change.
  {
    global.fetch = async (url) => { if(String(url).includes('/auth/v1/user')) return jsonResponse({}, false, 401); throw new Error('should not reach REST calls when unauthenticated'); };
    const req = fakeReq({ token: '' });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 401, 'a request with no bearer token still gets 401, unchanged from prior behavior');
  }

  // 7. Pure allowlist/config sanity.
  assert(CLIENT_REQUESTABLE_PLANS.includes('free') && CLIENT_REQUESTABLE_PLANS.includes('solo') && CLIENT_REQUESTABLE_PLANS.includes('team'), 'the allowlist includes exactly the three legitimate self-service plans');
  assert(!CLIENT_REQUESTABLE_PLANS.includes('enterprise') && !CLIENT_REQUESTABLE_PLANS.includes('manual'), 'the allowlist excludes enterprise and manual');
  assert(planConfig('enterprise').plan === 'enterprise', 'planConfig() itself is left intact for a future internal/admin-only caller -- the allowlist, not planConfig(), is the gate');

  global.fetch = originalFetch;
  console.log = originalConsoleLog;

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
