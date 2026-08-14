// P0 security fix verification (pre-beta blocker hardening): api/monitoring-lists.js's
// whole-list rename/pause/resume/delete actions (patchList()/deleteList())
// used to act directly on a client-supplied list id with ZERO ownership
// check -- unlike the sibling patchCustomerAccount() in the same file, which
// already re-verifies the resource belongs to the caller's ctx before doing
// anything. This mocks global.fetch for auth/ha_users/ha_uploads/
// ha_prospect_uploads/ha_accounts/ha_prospect_accounts/ha_signals/
// ha_prospect_signals, then invokes the real exported handler with fake
// req/res objects -- proving the actual authorization behavior, not a
// source-text pattern match.
//
// Covers (per the pre-beta blocker hardening spec):
// - owner can rename/pause/resume/delete their own customer list
// - owner can rename/pause/resume/delete their own prospect list
// - user A cannot rename/pause/resume/delete user B's customer list
// - user A cannot rename/pause/resume/delete user B's prospect list
// - a rejected (unauthorized) delete performs ZERO child mutations
//   (no ha_signals/ha_accounts DELETE fired) and ZERO parent mutation
//   (no ha_uploads DELETE fired)
// - organization/multi-user ownership semantics continue working: an
//   owner/admin (canViewTeam) can still manage a teammate's list, since
//   ctx.userIds legitimately includes every visible org member
// - malformed/nonexistent list ids behave safely (404, no mutation,
//   no 500, no distinguishable signal of whether the id belongs to
//   someone else)
// - auth-required behavior is unchanged (no token -> 401, unaffected by
//   this fix)
//
// Usage: node scripts/test-monitoring-lists-ownership.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler from '../api/monitoring-lists.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function fakeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}
function fakeReq(method, token, body){
  return { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body };
}

// ---------------------------------------------------------------------------
// Fixture data: three independent users (A, B -- unrelated, no shared org)
// plus an org (C = owner, D = plain member) to prove multi-user org
// ownership semantics keep working through ctx.userIds.
// ---------------------------------------------------------------------------
const AUTH_USERS = {
  'token-a': { id: 'auth-a', email: 'a@example.com' },
  'token-b': { id: 'auth-b', email: 'b@example.com' },
  'token-c-owner': { id: 'auth-c', email: 'c@example.com' },
  'token-d-member': { id: 'auth-d', email: 'd@example.com' }
};
const HA_USERS = [
  { id: 'user-a', auth_user_id: 'auth-a', email: 'a@example.com', app_role: 'member', organization_id: null, status: 'active' },
  { id: 'user-b', auth_user_id: 'auth-b', email: 'b@example.com', app_role: 'member', organization_id: null, status: 'active' },
  { id: 'user-c', auth_user_id: 'auth-c', email: 'c@example.com', app_role: 'owner', organization_id: 'org-1', status: 'active' },
  { id: 'user-d', auth_user_id: 'auth-d', email: 'd@example.com', app_role: 'member', organization_id: 'org-1', status: 'active' }
];

let haUploads, haProspectUploads, haAccounts, haProspectAccounts, haSignals, haProspectSignals, haAccountOpportunities;
let uploadsPatchCalls, uploadsDeleteCalls, prospectUploadsPatchCalls, prospectUploadsDeleteCalls;
let accountsDeleteCalls, prospectAccountsPatchCalls, prospectAccountsDeleteCalls;
let signalsDeleteCalls, prospectSignalsDeleteCalls, accountOpportunitiesPatchCalls;

function resetAll(){
  haUploads = [
    { id: 'upload-a', user_id: 'user-a', upload_name: 'List A', stage: 'uploaded', updated_at: '2026-01-01' },
    { id: 'upload-b', user_id: 'user-b', upload_name: 'List B', stage: 'uploaded', updated_at: '2026-01-01' },
    { id: 'upload-d', user_id: 'user-d', upload_name: 'List D', stage: 'uploaded', updated_at: '2026-01-01' }
  ];
  haProspectUploads = [
    { id: 'plist-a', user_email: 'a@example.com', filename: 'Prospects A', status: 'active' },
    { id: 'plist-b', user_email: 'b@example.com', filename: 'Prospects B', status: 'active' }
  ];
  haAccounts = [
    { id: 'acct-a1', upload_id: 'upload-a', user_id: 'user-a', account_name: 'A Co' },
    { id: 'acct-b1', upload_id: 'upload-b', user_id: 'user-b', account_name: 'B Co' },
    { id: 'acct-d1', upload_id: 'upload-d', user_id: 'user-d', account_name: 'D Co' }
  ];
  haAccountOpportunities = [];
  accountOpportunitiesPatchCalls = [];
  haProspectAccounts = [
    { id: 'pacct-a1', upload_id: 'plist-a', company_name: 'A Prospect Co' },
    { id: 'pacct-b1', upload_id: 'plist-b', company_name: 'B Prospect Co' }
  ];
  haSignals = [
    { id: 'sig-a1', upload_id: 'upload-a', account_name: 'A Co' },
    { id: 'sig-b1', upload_id: 'upload-b', account_name: 'B Co' },
    { id: 'sig-d1', upload_id: 'upload-d', account_name: 'D Co' }
  ];
  haProspectSignals = [
    { id: 'psig-a1', upload_id: 'plist-a' },
    { id: 'psig-b1', upload_id: 'plist-b' }
  ];
  uploadsPatchCalls = []; uploadsDeleteCalls = [];
  prospectUploadsPatchCalls = []; prospectUploadsDeleteCalls = [];
  accountsDeleteCalls = []; prospectAccountsPatchCalls = []; prospectAccountsDeleteCalls = [];
  signalsDeleteCalls = []; prospectSignalsDeleteCalls = [];
  global.fetch = mockFetch();
}

// Parses PostgREST's `col=in.("a","b")` shape into a plain array of values.
function parseInFilter(url, col){
  const m = url.match(new RegExp(`[?&]${col}=in\\.\\(([^)]*)\\)`));
  if(!m) return null;
  return m[1].split(',').map(s => decodeURIComponent(s.replace(/^"|"$/g, '')));
}
function qp(url, col){
  const m = url.match(new RegExp(`[?&]${col}=eq\\.([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function mockFetch(){
  return async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';

    if(u.includes('/auth/v1/user')){
      const token = String((options.headers || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      const au = AUTH_USERS[token];
      return au ? jsonResponse(au) : jsonResponse(null, false, 401);
    }
    if(u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')){
      const authId = qp(u, 'auth_user_id');
      const row = HA_USERS.find(x => x.auth_user_id === authId);
      return jsonResponse(row ? [row] : []);
    }
    if(u.includes('/rest/v1/ha_users') && u.includes('organization_id=eq.')){
      const orgId = qp(u, 'organization_id');
      return jsonResponse(HA_USERS.filter(x => x.organization_id === orgId));
    }

    // assertOwnedUpload() ownership check (GET, id + user_id=in.(...)).
    if(u.includes('/rest/v1/ha_uploads') && u.includes('id=eq.') && u.includes('user_id=in.') && method === 'GET'){
      const id = qp(u, 'id');
      const owners = parseInFilter(u, 'user_id') || [];
      const row = haUploads.find(x => x.id === id && owners.includes(x.user_id));
      return jsonResponse(row ? [{ id: row.id }] : []);
    }
    if(u.includes('/rest/v1/ha_uploads') && method === 'PATCH'){
      const id = qp(u, 'id');
      const body = JSON.parse(options.body);
      uploadsPatchCalls.push({ id, body });
      const idx = haUploads.findIndex(x => x.id === id);
      if(idx >= 0) haUploads[idx] = { ...haUploads[idx], ...body };
      return jsonResponse(idx >= 0 ? [haUploads[idx]] : []);
    }
    if(u.includes('/rest/v1/ha_uploads') && method === 'DELETE'){
      const id = qp(u, 'id');
      uploadsDeleteCalls.push(id);
      haUploads = haUploads.filter(x => x.id !== id);
      return jsonResponse([]);
    }

    // assertOwnedProspectUpload() ownership check (GET, id + user_email=in.(...)).
    if(u.includes('/rest/v1/ha_prospect_uploads') && u.includes('id=eq.') && u.includes('user_email=in.') && method === 'GET'){
      const id = qp(u, 'id');
      const owners = parseInFilter(u, 'user_email') || [];
      const row = haProspectUploads.find(x => x.id === id && owners.includes(x.user_email));
      return jsonResponse(row ? [{ id: row.id }] : []);
    }
    if(u.includes('/rest/v1/ha_prospect_uploads') && method === 'PATCH'){
      const id = qp(u, 'id');
      const body = JSON.parse(options.body);
      prospectUploadsPatchCalls.push({ id, body });
      const idx = haProspectUploads.findIndex(x => x.id === id);
      if(idx >= 0) haProspectUploads[idx] = { ...haProspectUploads[idx], ...body };
      return jsonResponse(idx >= 0 ? [haProspectUploads[idx]] : []);
    }
    if(u.includes('/rest/v1/ha_prospect_uploads') && method === 'DELETE'){
      const id = qp(u, 'id');
      prospectUploadsDeleteCalls.push(id);
      haProspectUploads = haProspectUploads.filter(x => x.id !== id);
      return jsonResponse([]);
    }

    if(u.includes('/rest/v1/ha_prospect_accounts') && method === 'PATCH'){
      const uploadId = qp(u, 'upload_id');
      const body = JSON.parse(options.body);
      prospectAccountsPatchCalls.push({ uploadId, body });
      haProspectAccounts = haProspectAccounts.map(a => a.upload_id === uploadId ? { ...a, ...body } : a);
      return jsonResponse([]);
    }
    if(u.includes('/rest/v1/ha_prospect_accounts') && method === 'DELETE'){
      const uploadId = qp(u, 'upload_id');
      prospectAccountsDeleteCalls.push(uploadId);
      haProspectAccounts = haProspectAccounts.filter(a => a.upload_id !== uploadId);
      return jsonResponse([]);
    }
    // Organizational Learning V1B fix: deleteList() now GETs the upload's
    // own accounts (user_id, account_name) BEFORE deleting them, so the
    // account-opportunity cleanup pass afterward knows which account_names
    // to consider -- and separately GETs by (user_id, account_name=in.())
    // to check whether any of those names are still represented by a
    // DIFFERENT, still-live upload (see inactivateOrphanedAccountOpportunities()).
    // Both are plain GETs against ha_accounts; distinguished by which
    // filter combination is present.
    if(u.includes('/rest/v1/ha_accounts') && method === 'GET' && u.includes('upload_id=eq.')){
      const uploadId = qp(u, 'upload_id');
      return jsonResponse(haAccounts.filter(a => a.upload_id === uploadId).map(a => ({ user_id: a.user_id, account_name: a.account_name })));
    }
    if(u.includes('/rest/v1/ha_accounts') && method === 'GET' && u.includes('user_id=eq.') && u.includes('account_name=in.')){
      const userId = qp(u, 'user_id');
      const names = parseInFilter(u, 'account_name') || [];
      return jsonResponse(haAccounts.filter(a => a.user_id === userId && names.includes(a.account_name)).map(a => ({ account_name: a.account_name })));
    }
    if(u.includes('/rest/v1/ha_accounts') && method === 'DELETE'){
      const uploadId = qp(u, 'upload_id');
      accountsDeleteCalls.push(uploadId);
      haAccounts = haAccounts.filter(a => a.upload_id !== uploadId);
      return jsonResponse([]);
    }
    if(u.includes('/rest/v1/ha_account_opportunities') && method === 'PATCH'){
      const userId = qp(u, 'user_id');
      const names = parseInFilter(u, 'account_name') || [];
      const body = JSON.parse(options.body);
      accountOpportunitiesPatchCalls.push({ userId, names, body });
      haAccountOpportunities = haAccountOpportunities.map(o => (o.user_id === userId && names.includes(o.account_name) && o.status === 'active') ? { ...o, ...body } : o);
      return jsonResponse([]);
    }
    if(u.includes('/rest/v1/ha_signals') && method === 'DELETE'){
      const uploadId = qp(u, 'upload_id');
      signalsDeleteCalls.push(uploadId);
      haSignals = haSignals.filter(s => s.upload_id !== uploadId);
      return jsonResponse([]);
    }
    if(u.includes('/rest/v1/ha_prospect_signals') && method === 'DELETE'){
      const uploadId = qp(u, 'upload_id');
      prospectSignalsDeleteCalls.push(uploadId);
      haProspectSignals = haProspectSignals.filter(s => s.upload_id !== uploadId);
      return jsonResponse([]);
    }
    throw new Error(`Unhandled mock fetch URL in test: ${method} ${u}`);
  };
}

async function run(){
  const originalFetch = global.fetch;

  // 1) Owner can rename their own customer list.
  {
    resetAll();
    const res = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'customer', id: 'upload-a', action: 'rename', name: 'Renamed A' }), res);
    assert(res.statusCode === 200 && res.body?.ok === true, '1) owner can rename their own customer list');
    assert(haUploads.find(u => u.id === 'upload-a')?.upload_name === 'Renamed A', '1) the rename actually took effect');
  }

  // 2) Owner can pause/resume their own customer list.
  {
    resetAll();
    const pauseRes = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'customer', id: 'upload-a', action: 'pause' }), pauseRes);
    assert(pauseRes.statusCode === 200 && pauseRes.body?.ok === true, '2a) owner can pause their own customer list');
    assert(haUploads.find(u => u.id === 'upload-a')?.stage === 'paused', '2a) the pause actually took effect');
    const resumeRes = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'customer', id: 'upload-a', action: 'resume' }), resumeRes);
    assert(resumeRes.statusCode === 200 && resumeRes.body?.ok === true, '2b) owner can resume their own customer list');
    assert(haUploads.find(u => u.id === 'upload-a')?.stage === 'uploaded', '2b) the resume actually took effect');
  }

  // 3) Owner can delete their own customer list -- cascades in the correct
  // order (signals, then accounts, then the upload itself).
  {
    resetAll();
    const res = fakeRes();
    await handler(fakeReq('DELETE', 'token-a', { type: 'customer', id: 'upload-a' }), res);
    assert(res.statusCode === 200 && res.body?.ok === true, '3) owner can delete their own customer list');
    assert(!haUploads.some(u => u.id === 'upload-a'), '3) the upload row is gone');
    assert(!haAccounts.some(a => a.upload_id === 'upload-a'), '3) the upload\'s accounts are gone');
    assert(!haSignals.some(s => s.upload_id === 'upload-a'), '3) the upload\'s signals are gone');
    assert(haUploads.some(u => u.id === 'upload-b') && haAccounts.some(a => a.upload_id === 'upload-b') && haSignals.some(s => s.upload_id === 'upload-b'), '3) an unrelated upload (B) is completely untouched');
  }

  // 4) Owner can rename/pause/resume/delete their own PROSPECT list.
  {
    resetAll();
    const renameRes = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'prospect', id: 'plist-a', action: 'rename', name: 'Renamed Prospects A' }), renameRes);
    assert(renameRes.statusCode === 200 && renameRes.body?.ok === true, '4a) owner can rename their own prospect list');
    assert(haProspectUploads.find(p => p.id === 'plist-a')?.filename === 'Renamed Prospects A', '4a) the rename actually took effect');
    const pauseRes = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'prospect', id: 'plist-a', action: 'pause' }), pauseRes);
    assert(pauseRes.statusCode === 200 && haProspectUploads.find(p => p.id === 'plist-a')?.status === 'paused', '4b) owner can pause their own prospect list');
    const deleteRes = fakeRes();
    await handler(fakeReq('DELETE', 'token-a', { type: 'prospect', id: 'plist-a' }), deleteRes);
    assert(deleteRes.statusCode === 200 && deleteRes.body?.ok === true, '4c) owner can delete their own prospect list');
    assert(!haProspectUploads.some(p => p.id === 'plist-a'), '4c) the prospect upload row is gone');
    assert(!haProspectAccounts.some(a => a.upload_id === 'plist-a'), '4c) the prospect upload\'s accounts are gone');
    assert(!haProspectSignals.some(s => s.upload_id === 'plist-a'), '4c) the prospect upload\'s signals are gone');
  }

  // 5) User A CANNOT rename/pause/resume User B's customer list.
  {
    resetAll();
    const renameRes = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'customer', id: 'upload-b', action: 'rename', name: 'Hijacked' }), renameRes);
    assert(renameRes.statusCode === 404, '5a) user A renaming user B\'s customer list is rejected (404)');
    assert(haUploads.find(u => u.id === 'upload-b')?.upload_name === 'List B', '5a) user B\'s list name is untouched');
    assert(uploadsPatchCalls.length === 0, '5a) no PATCH against ha_uploads was ever issued');
    const pauseRes = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'customer', id: 'upload-b', action: 'pause' }), pauseRes);
    assert(pauseRes.statusCode === 404, '5b) user A pausing user B\'s customer list is rejected (404)');
    assert(haUploads.find(u => u.id === 'upload-b')?.stage === 'uploaded', '5b) user B\'s list stage is untouched');
  }

  // 6) User A CANNOT delete User B's customer list -- and the failure
  // performs ZERO child mutations and ZERO parent mutation.
  {
    resetAll();
    const res = fakeRes();
    await handler(fakeReq('DELETE', 'token-a', { type: 'customer', id: 'upload-b' }), res);
    assert(res.statusCode === 404, '6) user A deleting user B\'s customer list is rejected (404)');
    assert(haUploads.some(u => u.id === 'upload-b'), '6) user B\'s upload row still exists (zero parent mutation)');
    assert(haAccounts.some(a => a.upload_id === 'upload-b'), '6) user B\'s accounts still exist (zero child mutation)');
    assert(haSignals.some(s => s.upload_id === 'upload-b'), '6) user B\'s signals still exist (zero child mutation)');
    assert(uploadsDeleteCalls.length === 0, '6) no DELETE against ha_uploads was ever issued');
    assert(accountsDeleteCalls.length === 0, '6) no DELETE against ha_accounts was ever issued');
    assert(signalsDeleteCalls.length === 0, '6) no DELETE against ha_signals was ever issued');
  }

  // 7) User A CANNOT rename/pause or delete User B's PROSPECT list, with
  // the same zero-mutation guarantee on delete.
  {
    resetAll();
    const renameRes = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'prospect', id: 'plist-b', action: 'rename', name: 'Hijacked' }), renameRes);
    assert(renameRes.statusCode === 404, '7a) user A renaming user B\'s prospect list is rejected (404)');
    assert(haProspectUploads.find(p => p.id === 'plist-b')?.filename === 'Prospects B', '7a) user B\'s prospect list name is untouched');
    const pauseRes = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'prospect', id: 'plist-b', action: 'pause' }), pauseRes);
    assert(pauseRes.statusCode === 404, '7b) user A pausing user B\'s prospect list is rejected (404)');
    const deleteRes = fakeRes();
    await handler(fakeReq('DELETE', 'token-a', { type: 'prospect', id: 'plist-b' }), deleteRes);
    assert(deleteRes.statusCode === 404, '7c) user A deleting user B\'s prospect list is rejected (404)');
    assert(haProspectUploads.some(p => p.id === 'plist-b'), '7c) user B\'s prospect upload row still exists');
    assert(haProspectAccounts.some(a => a.upload_id === 'plist-b'), '7c) user B\'s prospect accounts still exist');
    assert(haProspectSignals.some(s => s.upload_id === 'plist-b'), '7c) user B\'s prospect signals still exist');
    assert(prospectUploadsDeleteCalls.length === 0 && prospectAccountsDeleteCalls.length === 0 && prospectSignalsDeleteCalls.length === 0, '7c) no DELETE of any kind was issued for the prospect cascade');
  }

  // 8) Organization/multi-user ownership semantics continue working:
  // an owner (canViewTeam=true) can still manage a TEAMMATE's list, since
  // ctx.userIds legitimately includes every visible org member's id.
  {
    resetAll();
    const res = fakeRes();
    await handler(fakeReq('PATCH', 'token-c-owner', { type: 'customer', id: 'upload-d', action: 'rename', name: 'Renamed by Owner' }), res);
    assert(res.statusCode === 200 && res.body?.ok === true, '8) an org owner can rename a teammate\'s (User D\'s) customer list');
    assert(haUploads.find(u => u.id === 'upload-d')?.upload_name === 'Renamed by Owner', '8) the org-scoped rename actually took effect');
  }

  // 9) Malformed/nonexistent list id behaves safely: 404, no mutation, no
  // 500, and (by construction) no way to distinguish "doesn't exist" from
  // "belongs to someone else" -- same contract as a not-owned id.
  {
    resetAll();
    const renameRes = fakeRes();
    await handler(fakeReq('PATCH', 'token-a', { type: 'customer', id: 'does-not-exist-at-all', action: 'rename', name: 'X' }), renameRes);
    assert(renameRes.statusCode === 404, '9a) a nonexistent list id returns 404, not a 500');
    assert(uploadsPatchCalls.length === 0, '9a) no PATCH was ever issued for a nonexistent id');
    const deleteRes = fakeRes();
    await handler(fakeReq('DELETE', 'token-a', { type: 'customer', id: 'does-not-exist-at-all' }), deleteRes);
    assert(deleteRes.statusCode === 404, '9b) deleting a nonexistent list id returns 404, not a 500');
    assert(uploadsDeleteCalls.length === 0 && accountsDeleteCalls.length === 0 && signalsDeleteCalls.length === 0, '9b) no mutation of any kind was attempted for a nonexistent id');
  }

  // 10) Auth-required behavior is unchanged by this fix.
  {
    resetAll();
    const res = fakeRes();
    await handler(fakeReq('DELETE', null, { type: 'customer', id: 'upload-a' }), res);
    assert(res.statusCode === 401, '10) an unauthenticated request is still rejected with 401, unaffected by the ownership fix');
    assert(uploadsDeleteCalls.length === 0, '10) no mutation is attempted without authentication');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
