// Pricing/billing sprint: seats/users are unlimited at every pricing
// level, including Free. Validates api/team.js's invite/accept-invite
// paths no longer reject on seat count (against mocked Supabase fetch),
// and confirms api/admin-dashboard.js's three obsolete seat-based
// assumptions (a login-risk heuristic, a health status, and an
// attention-queue item, all keyed off the legacy plan/seat_limit
// columns) were removed without touching the rest of its fraud/security
// monitoring.
//
// Usage: node scripts/test-unlimited-seats.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';

import { readFileSync } from 'fs';
import handler from '../api/team.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

const ORG_ID = 'org-1';
const OWNER = { id: 'user-owner', auth_user_id: 'auth-owner', email: 'owner@example.com', organization_id: ORG_ID, app_role: 'owner' };
// A legacy org whose stored seat_limit (1, the historical Free/Solo
// value) has already been exceeded by real invited members -- exactly
// the scenario that used to 403.
const orgState = { id: ORG_ID, name: 'Acme Promo', plan: 'free', seat_limit: 1 };
const manyExistingUsers = Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, email: `user${i}@example.com`, app_role: 'member', status: 'active', created_at: new Date().toISOString() }));

function mockFetch(){
  return async (url, options = {}) => {
    const u = String(url);
    if(u.includes('/auth/v1/user')) return jsonResponse({ id: OWNER.auth_user_id, email: OWNER.email });
    if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([OWNER]);
    if(u.includes('/rest/v1/ha_organizations?id=eq.')) return jsonResponse([orgState]);
    if(u.includes('/rest/v1/ha_users?organization_id=eq.')) return jsonResponse(manyExistingUsers);
    if(u.includes('/rest/v1/ha_invitations?organization_id=eq.')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_users?email=eq.')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_invitations') && options.method === 'POST') return jsonResponse([{ id: 'inv-1', email: 'new@example.com', role: 'member', status: 'pending' }]);
    if(u.includes('api.resend.com/emails')) return { ok: true, json: async () => ({ id: 'email-1' }) };
    throw new Error(`Unhandled mock fetch URL in test: ${u}`);
  };
}

function fakeReq({ method = 'POST', body = {} }){
  return { method, query: {}, headers: { authorization: 'Bearer valid-token' }, body };
}
function fakeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}

const originalFetch = global.fetch;

async function run(){
  global.fetch = mockFetch();

  // 1. list: an org already at 12 members, well over its legacy
  // seat_limit of 1, is reported as unlimited (seatLimit: null), not
  // over-limit.
  {
    const res = fakeRes();
    await handler(fakeReq({ method: 'GET' }), res);
    assert(res.statusCode === 200, 'list succeeds');
    assert(res.body.seatLimit === null, 'seatLimit is reported as null (unlimited) even though the legacy org.seat_limit column still says 1');
    assert(res.body.seatsUsed === 12, 'seatsUsed still accurately reports the real member count for display');
  }

  // 2. invite: inviting a 13th teammate on this same over-legacy-limit org
  // succeeds -- this used to 403 with "This plan includes 1 seats."
  {
    const res = fakeRes();
    await handler(fakeReq({ body: { action: 'invite', email: 'new@example.com', role: 'member' } }), res);
    assert(res.statusCode === 200, 'inviting a 13th teammate on an org whose legacy seat_limit is 1 succeeds -- seats are unlimited at every pricing level');
  }

  global.fetch = originalFetch;

  // 3. Source-level confirmation: the three obsolete seat-based
  // assumptions in api/admin-dashboard.js were removed, without touching
  // the rest of its login-risk fraud monitoring (IP/device velocity
  // checks, cross-region logins, etc. all remain).
  const adminSrc = readFileSync(new URL('../api/admin-dashboard.js', import.meta.url), 'utf8');
  assert(!/plan==='solo'&&ips7\.size/.test(adminSrc), 'the "Solo plan shows repeated multi-device/multi-IP use" login-risk heuristic is removed');
  assert(!/Over Seat Limit/.test(adminSrc), 'the "Over Seat Limit" health status is removed');
  assert(!/Over seat limit/.test(adminSrc), 'the "Over seat limit" attention-queue item is removed');
  assert(/uniqueIps24h|ips24\.size>=5/.test(adminSrc), 'the unrelated IP-velocity login-risk heuristic (not seat-based) is untouched');
  assert(/differentCountry|different countries/.test(adminSrc), 'the unrelated cross-region/cross-country login-risk heuristic (not seat-based) is untouched');
  assert(/Trial Expired|Trial Expiring/.test(adminSrc), 'the unrelated trial-expiry health/attention signals (not seat-based) are untouched');

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
