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

import handler, { CLIENT_REQUESTABLE_PLANS, NOTIFICATION_PREFERENCES, planConfig, planPatch } from '../api/settings.js';

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
let OWNER = { id: 'user-owner', auth_user_id: 'auth-owner', email: 'owner@example.com', organization_id: ORG_ID, app_role: 'owner', notification_preference: 'weekly' };
let MEMBER = { id: 'user-member', auth_user_id: 'auth-member', email: 'member@example.com', organization_id: ORG_ID, app_role: 'member', notification_preference: 'weekly' };

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
    if(u.includes('/rest/v1/ha_users?id=eq.') && options.method === 'PATCH'){
      const patch = JSON.parse(options.body);
      const targetId = decodeURIComponent(u.split('id=eq.')[1].split('&')[0]);
      if(OWNER.id === targetId){ OWNER = { ...OWNER, ...patch }; return jsonResponse([{ ...OWNER }]); }
      if(MEMBER.id === targetId){ MEMBER = { ...MEMBER, ...patch }; return jsonResponse([{ ...MEMBER }]); }
      return jsonResponse([]);
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

  // 2. Pricing/billing sprint (2026-08-13): owner requests plan:'team' ->
  // rejected. No new 30-day paid-capacity trials are granted through this
  // self-service endpoint anymore -- paid capacity is purchased through
  // Stripe Checkout (api/create-checkout-session.js) instead, so 'team'
  // (and 'solo') were removed from CLIENT_REQUESTABLE_PLANS.
  {
    orgState = { id: ORG_ID, plan: 'free', seat_limit: 1, subscription_status: 'inactive', trial_status: 'inactive', trial_used: false, trial_end: null };
    global.fetch = mockFetch(OWNER);
    auditLines = [];
    const req = fakeReq({ body: { action: 'update-plan', plan: 'team' } });
    const res = fakeRes();
    await handler(req, res);
    assert(res.statusCode === 400, 'owner requesting team plan is rejected -- no new self-service trials are granted');
    assert(orgState.plan === 'free', 'the rejected team request leaves the org on free, unchanged');
    assert(auditLines.some(l => l.includes('update-plan.rejected') && l.includes('plan-not-allowlisted') && l.includes('"requestedPlan":"team"')), 'the rejected attempt is written to the audit log');
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

  // ---------------------------------------------------------------------
  // Pricing/billing sprint (2026-08-13): the self-service update-plan
  // action no longer grants any new trial -- 'solo' and 'team' are simply
  // rejected, every time, regardless of the org's trial history. These
  // cases replace the old free<->team/solo trial-lifecycle regressions
  // (which tested trial-granting behavior that has been intentionally
  // retired) with regressions proving that retirement is complete and
  // doesn't regress by accident.
  // ---------------------------------------------------------------------

  // 8. A never-used-trial org requesting 'team' is rejected, not granted a
  // fresh trial -- the prior behavior this replaces.
  {
    orgState = { id: ORG_ID, plan: 'free', seat_limit: 1, subscription_status: 'inactive', trial_status: 'inactive', trial_used: false, trial_end: null };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: { action: 'update-plan', plan: 'team' } }), res);
    assert(res.statusCode === 400 && orgState.trial_used === false, 'a never-used-trial org requesting team is rejected, not granted a fresh trial');
    assert(orgState.plan === 'free', 'the org remains on free after the rejected request');
  }

  // 9. Free downgrade remains available and is a genuine no-op/idempotent
  // action for an org already on free.
  {
    orgState = { id: ORG_ID, plan: 'free', seat_limit: 1, subscription_status: 'inactive', trial_status: 'inactive', trial_used: false, trial_end: null };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: { action: 'update-plan', plan: 'free' } }), res);
    assert(res.statusCode === 200 && orgState.plan === 'free', 'requesting free while already on free succeeds (self-service downgrade path remains available)');
  }

  // 10. An org already mid-trial (e.g. an existing Beta organization from
  // before this sprint) requesting 'solo' is still rejected -- switching
  // between paid tiers via this endpoint is retired entirely, not just
  // new-trial-granting. Existing trial access itself is untouched by this
  // endpoint (see api/lib/entitlement.js's dynamic trial check).
  {
    orgState = { id: ORG_ID, plan: 'team', seat_limit: 25, subscription_status: 'trialing', trial_status: 'active', trial_used: true, trial_end: new Date(Date.now() + 20 * 86400000).toISOString() };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: { action: 'update-plan', plan: 'solo' } }), res);
    assert(res.statusCode === 400, 'an org mid-trial requesting a tier switch to solo is rejected');
    assert(orgState.plan === 'team' && orgState.trial_end, 'the org\'s existing mid-trial state (plan, trial_end) is untouched by the rejected request');
  }

  // 11. Expired trial -> team: still rejected, same as always, now simply
  // for the allowlist reason rather than the trial-already-used reason.
  {
    orgState = { id: ORG_ID, plan: 'solo', seat_limit: 1, subscription_status: 'trialing', trial_status: 'active', trial_used: true, trial_end: new Date(Date.now() - 5 * 86400000).toISOString() };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: { action: 'update-plan', plan: 'team' } }), res);
    assert(res.statusCode === 400, 'a request to switch to team after the org\'s trial has already expired is rejected');
    assert(orgState.plan === 'solo', 'the org plan is unchanged by the rejected request');
  }

  // ---------------------------------------------------------------------
  // Notification & Outcome Loop V1, Part A4: POST /api/settings
  // action:update-notification-preference. A personal preference, not an
  // org-level plan change -- no owner/role gate, unlike update-plan above.
  // ---------------------------------------------------------------------

  // 12. Owner sets their own preference to 'daily' -> 200, persisted.
  {
    OWNER = { ...OWNER, notification_preference: 'weekly' };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: { action: 'update-notification-preference', notificationPreference: 'daily' } }), res);
    assert(res.statusCode === 200 && res.body?.ok === true, `owner setting notification preference to 'daily' succeeds (got status ${res.statusCode})`);
    assert(OWNER.notification_preference === 'daily', 'the ha_users row is actually patched to the requested value');
    assert(res.body?.user?.notification_preference === 'daily', 'the response reflects the updated preference');
  }

  // 13. A non-owner member can set their OWN preference too -- this is a
  // personal setting, not an org-level change, so no owner-only gate.
  {
    MEMBER = { ...MEMBER, notification_preference: 'weekly' };
    global.fetch = mockFetch(MEMBER);
    const res = fakeRes();
    await handler(fakeReq({ body: { action: 'update-notification-preference', notificationPreference: 'in_app_only' } }), res);
    assert(res.statusCode === 200, `REQUIRED: a non-owner member can update their own notification preference without an owner/role gate (got ${res.statusCode})`);
    assert(MEMBER.notification_preference === 'in_app_only', 'the member\'s own row is patched to the requested value');
  }

  // 14. Isolation: updating the member's preference never touched the owner's.
  {
    assert(OWNER.notification_preference === 'daily', 'REQUIRED: updating one user\'s notification preference never affects a different user\'s row');
  }

  // 15. Unknown value -> 400, rejected before any PATCH -- no CRM-stage-style
  // free-for-all; only the three backend-supported values are accepted.
  {
    OWNER = { ...OWNER, notification_preference: 'daily' };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: { action: 'update-notification-preference', notificationPreference: 'instant' } }), res);
    assert(res.statusCode === 400, `REQUIRED: an unrecognized notification preference is rejected 400, not silently accepted or coerced (got ${res.statusCode})`);
    assert(OWNER.notification_preference === 'daily', 'the rejected request leaves the existing preference unchanged');
  }

  // 16. Unauthenticated request -> 401, same as every other action.
  {
    global.fetch = async (url) => { if(String(url).includes('/auth/v1/user')) return jsonResponse({}, false, 401); throw new Error('should not reach REST calls when unauthenticated'); };
    const res = fakeRes();
    await handler(fakeReq({ token: '', body: { action: 'update-notification-preference', notificationPreference: 'daily' } }), res);
    assert(res.statusCode === 401, 'an unauthenticated notification-preference update attempt gets 401');
  }

  // 17. Pure allowlist sanity -- matches migration 22's ha_users check
  // constraint exactly, no invented values.
  assert(NOTIFICATION_PREFERENCES.length === 3 && ['daily', 'weekly', 'in_app_only'].every(v => NOTIFICATION_PREFERENCES.includes(v)), `NOTIFICATION_PREFERENCES matches the exact three backend-supported values (got ${JSON.stringify(NOTIFICATION_PREFERENCES)})`);

  // 7. Pure allowlist/config sanity.
  assert(CLIENT_REQUESTABLE_PLANS.length === 1 && CLIENT_REQUESTABLE_PLANS.includes('free'), 'the allowlist includes exactly one legitimate self-service plan: free (solo/team self-service trials are retired; paid capacity is purchased through Stripe Checkout)');
  assert(!CLIENT_REQUESTABLE_PLANS.includes('solo') && !CLIENT_REQUESTABLE_PLANS.includes('team'), 'the allowlist no longer includes solo or team');
  assert(!CLIENT_REQUESTABLE_PLANS.includes('enterprise') && !CLIENT_REQUESTABLE_PLANS.includes('manual'), 'the allowlist excludes enterprise and manual');
  assert(planConfig('enterprise').plan === 'enterprise', 'planConfig() itself is left intact for a future internal/admin-only caller -- the allowlist, not planConfig(), is the gate');

  global.fetch = originalFetch;
  console.log = originalConsoleLog;

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
