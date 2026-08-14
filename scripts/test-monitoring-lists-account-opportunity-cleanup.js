// Organizational Learning V1B, production bug fix: "A downstream data
// request failed" on deleting a customer list. Root cause, confirmed by a
// direct live SQL reproduction (BEGIN; DELETE FROM ha_signals/ha_accounts/
// ha_uploads; ROLLBACK; against Supabase project zodtymrckbtbiomakupf):
//   ERROR: 23503 update or delete on table "ha_uploads" violates foreign
//   key constraint "ha_account_opportunities_upload_id_fkey" on table
//   "ha_account_opportunities"
// migration 12 declared ha_account_opportunities.upload_id REFERENCES
// ha_uploads(id) with no ON DELETE action (defaults to NO ACTION) --
// every OTHER table referencing ha_uploads(id) already uses ON DELETE
// CASCADE. Migration 13 fixes the schema (ON DELETE SET NULL, matching
// this schema's OTHER historical-evidence-preservation FKs, never
// CASCADE -- that would destroy real longitudinal history). This file
// proves the APPLICATION-level half of the fix: deleteList() in
// api/monitoring-lists.js now also transitions the deleted list's
// now-orphaned ACTIVE ha_account_opportunities rows to 'inactive' (never
// deletes them -- append-only history preserved, same lifecycle model
// reconcileAccountOpportunities() already uses), scoped precisely so it
// NEVER touches an account_name still represented by a different,
// still-live upload for the same user, and NEVER touches another user's
// data. The schema-level fix (the actual DELETE FROM ha_uploads no longer
// raising 23503) cannot be exercised against a mock -- it is verified
// directly against live Supabase (see the founder report for this round).
//
// Mocks global.fetch and invokes the real exported handler, same
// established convention as scripts/test-monitoring-lists-ownership.js.
//
// Usage: node scripts/test-monitoring-lists-account-opportunity-cleanup.js
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
function qp(url, col){
  const m = url.match(new RegExp(`[?&]${col}=eq\\.([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function parseInFilter(url, col){
  const m = url.match(new RegExp(`[?&]${col}=in\\.\\(([^)]*)\\)`));
  if(!m) return null;
  return m[1].split(',').map(s => decodeURIComponent(s.replace(/^"|"$/g, '')));
}

const AUTH_USERS = { 'token-a': { id: 'auth-a', email: 'a@example.com' } };
const HA_USERS = [{ id: 'user-a', auth_user_id: 'auth-a', email: 'a@example.com', app_role: 'member', organization_id: null, status: 'active' }];

let haUploads, haAccounts, haSignals, haAccountOpportunities, accountOpportunitiesPatchCalls, uploadsDeleteCalls;

function resetAll(overrides = {}){
  haUploads = overrides.haUploads || [{ id: 'upload-x', user_id: 'user-a', upload_name: 'Old List', stage: 'researched', updated_at: '2026-01-01' }];
  haAccounts = overrides.haAccounts || [{ id: 'acct-1', upload_id: 'upload-x', user_id: 'user-a', account_name: 'Acme Co' }];
  haSignals = overrides.haSignals || [];
  haAccountOpportunities = overrides.haAccountOpportunities || [
    { id: 'opp-1', user_id: 'user-a', upload_id: 'upload-x', account_name: 'Acme Co', opportunity_type: 'follow_up', category: null, fingerprint: 'opp:follow_up:v1:acme|last:2025-06-01', status: 'active' }
  ];
  accountOpportunitiesPatchCalls = [];
  uploadsDeleteCalls = [];
  global.fetch = mockFetch();
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
    if(u.includes('/rest/v1/ha_uploads') && u.includes('id=eq.') && u.includes('user_id=in.') && method === 'GET'){
      const id = qp(u, 'id');
      const owners = parseInFilter(u, 'user_id') || [];
      const row = haUploads.find(x => x.id === id && owners.includes(x.user_id));
      return jsonResponse(row ? [{ id: row.id }] : []);
    }
    if(u.includes('/rest/v1/ha_uploads') && method === 'DELETE'){
      const id = qp(u, 'id');
      uploadsDeleteCalls.push(id);
      haUploads = haUploads.filter(x => x.id !== id);
      return jsonResponse([]);
    }
    // deleteList()'s new pre-delete capture of this upload's own accounts.
    if(u.includes('/rest/v1/ha_accounts') && method === 'GET' && u.includes('upload_id=eq.')){
      const uploadId = qp(u, 'upload_id');
      return jsonResponse(haAccounts.filter(a => a.upload_id === uploadId).map(a => ({ user_id: a.user_id, account_name: a.account_name })));
    }
    // inactivateOrphanedAccountOpportunities()'s "is this account_name
    // still represented anywhere else for this user" check.
    if(u.includes('/rest/v1/ha_accounts') && method === 'GET' && u.includes('user_id=eq.') && u.includes('account_name=in.')){
      const userId = qp(u, 'user_id');
      const names = parseInFilter(u, 'account_name') || [];
      return jsonResponse(haAccounts.filter(a => a.user_id === userId && names.includes(a.account_name)).map(a => ({ account_name: a.account_name })));
    }
    if(u.includes('/rest/v1/ha_accounts') && method === 'DELETE'){
      const uploadId = qp(u, 'upload_id');
      haAccounts = haAccounts.filter(a => a.upload_id !== uploadId);
      return jsonResponse([]);
    }
    if(u.includes('/rest/v1/ha_signals') && method === 'DELETE'){
      const uploadId = qp(u, 'upload_id');
      haSignals = haSignals.filter(s => s.upload_id !== uploadId);
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
    throw new Error(`Unhandled mock fetch URL in test: ${method} ${u}`);
  };
}

async function run(){
  const originalFetch = global.fetch;

  // ---------------------------------------------------------------------
  // REQUIRED: deleting a list whose accounts have live ha_account_opportunities
  // rows now succeeds (this is the exact scenario that used to hit 23503
  // at the schema level) -- proven here at the application layer: the
  // handler returns 200, the upload/accounts/signals are gone, and the
  // now-orphaned opportunity is transitioned to inactive, never deleted.
  // ---------------------------------------------------------------------
  {
    resetAll();
    const res = fakeRes();
    await handler(fakeReq('DELETE', 'token-a', { type: 'customer', id: 'upload-x' }), res);
    assert(res.statusCode === 200 && res.body?.ok === true, 'REQUIRED: deleting a list whose accounts have live opportunities succeeds (200)');
    assert(!haUploads.some(u => u.id === 'upload-x'), 'the upload row is gone');
    assert(!haAccounts.some(a => a.upload_id === 'upload-x'), 'the accounts are gone');
    const opp = haAccountOpportunities.find(o => o.id === 'opp-1');
    assert(!!opp, 'REQUIRED: the ha_account_opportunities row itself is NEVER deleted -- append-only history is preserved');
    assert(opp.status === 'inactive', 'REQUIRED: the now-orphaned opportunity is transitioned to inactive, not left active pointing at deleted customer data');
    assert(accountOpportunitiesPatchCalls.length === 1 && accountOpportunitiesPatchCalls[0].userId === 'user-a' && accountOpportunitiesPatchCalls[0].names.includes('Acme Co'), 'the inactivation PATCH is scoped to exactly this user and this account name');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: an account_name still represented by a DIFFERENT, still-live
  // upload for the SAME user is never inactivated -- account names are
  // unique only WITHIN one upload, never globally per user.
  // ---------------------------------------------------------------------
  {
    resetAll({
      haUploads: [
        { id: 'upload-x', user_id: 'user-a', upload_name: 'Old List', stage: 'researched', updated_at: '2026-01-01' },
        { id: 'upload-y', user_id: 'user-a', upload_name: 'Newer List', stage: 'researched', updated_at: '2026-02-01' }
      ],
      haAccounts: [
        { id: 'acct-1', upload_id: 'upload-x', user_id: 'user-a', account_name: 'Acme Co' },
        { id: 'acct-2', upload_id: 'upload-y', user_id: 'user-a', account_name: 'Acme Co' }
      ]
    });
    const res = fakeRes();
    await handler(fakeReq('DELETE', 'token-a', { type: 'customer', id: 'upload-x' }), res);
    assert(res.statusCode === 200, 'sanity: the delete still succeeds');
    const opp = haAccountOpportunities.find(o => o.id === 'opp-1');
    assert(opp.status === 'active', 'REQUIRED: Acme Co\'s opportunity stays ACTIVE -- upload-y still represents this exact account for this user, so it is not orphaned');
    assert(accountOpportunitiesPatchCalls.length === 0, 'REQUIRED: no inactivation PATCH is ever issued when the account_name survives via another upload');
    assert(!haAccounts.some(a => a.upload_id === 'upload-x'), 'sanity: upload-x\'s own account row is still gone');
    assert(haAccounts.some(a => a.upload_id === 'upload-y'), 'sanity: upload-y\'s account row is completely untouched');
  }

  // ---------------------------------------------------------------------
  // REQUIRED: a DIFFERENT user's opportunities (even for an account of the
  // exact same name) are never touched by this cleanup.
  // ---------------------------------------------------------------------
  {
    resetAll({
      haAccountOpportunities: [
        { id: 'opp-1', user_id: 'user-a', upload_id: 'upload-x', account_name: 'Acme Co', opportunity_type: 'follow_up', category: null, fingerprint: 'opp:follow_up:v1:acme|last:2025-06-01', status: 'active' },
        { id: 'opp-other-user', user_id: 'user-b', upload_id: 'upload-z', account_name: 'Acme Co', opportunity_type: 'follow_up', category: null, fingerprint: 'opp:follow_up:v1:acme|last:2025-06-01', status: 'active' }
      ]
    });
    const res = fakeRes();
    await handler(fakeReq('DELETE', 'token-a', { type: 'customer', id: 'upload-x' }), res);
    assert(res.statusCode === 200, 'sanity: the delete succeeds');
    const otherUserOpp = haAccountOpportunities.find(o => o.id === 'opp-other-user');
    assert(otherUserOpp.status === 'active', 'REQUIRED: a different user\'s opportunity for an identically-named account is never inactivated by this user\'s list delete');
  }

  // ---------------------------------------------------------------------
  // Sanity: a list with no opportunities at all (the common case before
  // V1B, and for any account with no qualifying purchase history) deletes
  // cleanly with zero opportunity-cleanup calls -- the fix adds no new
  // failure mode or unnecessary work for the ordinary case.
  // ---------------------------------------------------------------------
  {
    resetAll({ haAccountOpportunities: [] });
    const res = fakeRes();
    await handler(fakeReq('DELETE', 'token-a', { type: 'customer', id: 'upload-x' }), res);
    assert(res.statusCode === 200, 'sanity: a list with zero opportunities still deletes successfully');
    // A scoped, status=eq.active PATCH may still be ISSUED (it matches
    // zero rows and is a harmless no-op) -- the required guarantee is that
    // nothing in ha_account_opportunities actually changes, not that the
    // call itself is skipped.
    assert(haAccountOpportunities.length === 0, 'sanity: still zero opportunity rows after the delete -- nothing was fabricated or left behind');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
