// Release-blocker fix verification: api/monitoring-lists.js's delete-account
// action used to issue a direct DELETE against ha_accounts (plus a
// best-effort ha_signals DELETE), bypassing replace_ha_accounts_snapshot()'s
// migration-7 accounts_maintenance identity lock (HA004) and active-run
// guard (55P03) entirely. This mocks global.fetch for auth, the account
// ownership lookup, the sibling-accounts lookup, the
// replace_ha_accounts_snapshot RPC (a faithful in-memory reimplementation of
// the real migration-7 accounts_maintenance semantics — active-run check,
// then identity-set check only when research history exists), and the
// post-success signals cleanup, then invokes the real exported handler with
// fake req/res objects.
//
// Covers:
// - pre-research account deletion succeeds through the maintenance RPC,
//   removes only the target account, and preserves every other account's
//   metadata untouched
// - a researched upload's account deletion is rejected with HA004
//   (identityLocked:true) and changes nothing
// - an active-run upload's account deletion is rejected with 55P03 and
//   changes nothing
// - a rejected deletion leaves the target account's signals untouched
// - pause/resume are unaffected (still a direct, narrow raw_data PATCH, no
//   RPC call at all)
// - no direct DELETE against ha_accounts occurs anywhere in the
//   delete-account code path (both a dynamic proof, via the fetch mock, and
//   a static structural check of deleteCustomerAccountViaSnapshot()'s own
//   source text)
// - the RPC call uses the real 6-argument replace_ha_accounts_snapshot
//   signature correctly: p_upload_id/p_user_id/p_accounts/p_mode set,
//   p_research_run_id/p_attempt_id both omitted (relying on their SQL
//   defaults, exactly like the untracked path in api/save-upload.js)
// - ownership failures (an account not visible to the caller) remain
//   rejected, unchanged from pre-patch behavior
// - CROSS-UPLOAD SIGNAL SCOPING (release blocker #2, found in review): the
//   post-success ha_signals cleanup used to filter by user_id +
//   account_name only, with no upload_id term -- deleting "Alpha Co" from
//   one upload would delete EVERY signal matching that account name across
//   EVERY upload the same user owns, not just the one being edited. The
//   mock's ha_signals DELETE handler below enforces upload_id/user_id/
//   account_name exactly like a real WHERE clause (a filter term that is
//   literally absent from the URL is NOT constrained -- it does not
//   compare against null), so this test would fail if the real code ever
//   regressed back to omitting upload_id from that DELETE call.
//
// What this CANNOT prove without a live Postgres/Supabase connection: that
// the advisory lock inside replace_ha_accounts_snapshot() actually
// serializes this call against a genuinely concurrent claim/persist call.
// See scripts/phase2a-rpc-authorization-tests.sql and
// scripts/test-account-maintenance-concurrency.sh for that.
//
// Usage: node scripts/test-monitoring-lists-account-delete.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
function fakeReq(body){
  return { method: 'PATCH', headers: { authorization: 'Bearer valid-token' }, body };
}
function fakeReqNoAuth(body){
  return { method: 'PATCH', headers: {}, body };
}

const AUTH_USER_ID = 'auth-user-1';
const USER_ID = 'user-1';
const UPLOAD_ID = 'upload-1';
const ACCOUNT_ALPHA_ID = 'acct-alpha';
const ACCOUNT_BETA_ID = 'acct-beta';

let fakeAccounts = [];
let fakeSignals = [];
let researchRuns = [];
let rpcCalls = [];
let directAccountDeleteCalls = [];
let accountPatchCalls = [];
let signalsDeleteCalls = [];

function seedTwoAccounts(){
  fakeAccounts = [
    { id: ACCOUNT_ALPHA_ID, user_id: USER_ID, upload_id: UPLOAD_ID, account_name: 'Alpha Co', industry: 'Software', contact_name: 'Ann', contact_email: 'ann@alpha.example', metrics: { revenue: 100 }, raw_data: { monitoring_status: 'active' } },
    { id: ACCOUNT_BETA_ID, user_id: USER_ID, upload_id: UPLOAD_ID, account_name: 'Beta Co', industry: 'Manufacturing', contact_name: 'Bo', contact_email: 'bo@beta.example', metrics: { revenue: 200 }, raw_data: { monitoring_status: 'active' } }
  ];
  fakeSignals = [
    { id: 'sig-alpha-1', user_id: USER_ID, upload_id: UPLOAD_ID, account_name: 'Alpha Co', event_fingerprint: 'fp-alpha-1' },
    { id: 'sig-beta-1', user_id: USER_ID, upload_id: UPLOAD_ID, account_name: 'Beta Co', event_fingerprint: 'fp-beta-1' }
  ];
}

// Faithful in-memory reimplementation of
// supabase-schema-migration-7-mode-scoped-account-writes.sql's
// accounts_maintenance branch: active-run check first (55P03), then --
// ONLY when research history exists for the upload -- the account_name SET
// comparison (HA004). Identity is the name set, not full-row equality, so
// carrying every sibling account's real industry/contact/metrics/raw_data
// through a deletion call is expected, safe behavior, not itself a rename.
function fakeReplaceAccountsSnapshot(body){
  rpcCalls.push(body);
  const { p_upload_id, p_user_id, p_accounts, p_mode } = body;
  if(p_mode !== 'accounts_maintenance'){
    return { ok: false, status: 400, body: { message: `unexpected p_mode ${p_mode} in this test`, code: '22023' } };
  }
  const activeRunning = researchRuns.some(r => r.upload_id === p_upload_id && r.status === 'running' && r.lease_expires_at_ms > Date.now());
  if(activeRunning){
    return { ok: false, status: 409, body: { message: 'a research run is currently active', code: '55P03' } };
  }
  const hasHistory = researchRuns.some(r => r.upload_id === p_upload_id);
  const existingNames = fakeAccounts.filter(a => a.upload_id === p_upload_id).map(a => a.account_name).slice().sort();
  const incomingNames = (Array.isArray(p_accounts) ? p_accounts : []).map(a => a.account_name).filter(Boolean).slice().sort();
  if(hasHistory){
    const same = existingNames.length === incomingNames.length && existingNames.every((n, i) => n === incomingNames[i]);
    if(!same){
      return { ok: false, status: 400, body: { message: 'accounts_maintenance cannot add, remove, or rename accounts once research history exists', code: 'HA004' } };
    }
  }
  fakeAccounts = fakeAccounts
    .filter(a => a.upload_id !== p_upload_id)
    .concat((Array.isArray(p_accounts) ? p_accounts : []).map(a => ({
      id: fakeAccounts.find(existing => existing.upload_id === p_upload_id && existing.account_name === a.account_name)?.id || `acct-${a.account_name}`,
      user_id: p_user_id, upload_id: p_upload_id,
      account_name: a.account_name, industry: a.industry, contact_name: a.contact_name,
      contact_email: a.contact_email, metrics: a.metrics, raw_data: a.raw_data
    })));
  return { ok: true, status: 200, body: fakeAccounts.filter(a => a.upload_id === p_upload_id) };
}

function mockFetch(){
  return async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';

    if(u.includes('/auth/v1/user')){
      const token = String((options.headers || {}).Authorization || '');
      if(!token.includes('valid-token')) return jsonResponse(null, false, 401);
      return jsonResponse({ id: AUTH_USER_ID, email: 'qa@example.com' });
    }
    if(u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')){
      return jsonResponse([{ id: USER_ID, email: 'qa@example.com', app_role: 'member', role: 'member', organization_id: null, status: 'active' }]);
    }
    if(u.includes('/rest/v1/ha_users') && u.includes('organization_id=eq.')) return jsonResponse([]);

    // "id=eq." as a query PARAMETER (bounded by ? or & on the left) --
    // "upload_id=eq." must not match here, since "id=eq." is a substring of
    // it. This is the actual distinguishing signal between the
    // ownership-scoped single-account lookup and the sibling-accounts
    // lookup below.
    const hasIdParam = /[?&]id=eq\./.test(u);

    // Ownership-scoped single-account lookup (patchCustomerAccount).
    if(u.includes('/rest/v1/ha_accounts') && hasIdParam && u.includes('user_id=') && method === 'GET'){
      const idMatch = u.match(/[?&]id=eq\.([^&]+)/);
      const qId = idMatch ? decodeURIComponent(idMatch[1]) : null;
      const account = fakeAccounts.find(a => a.id === qId);
      // The ownership filter is "user_id=in.(...ctx.userIds...)" -- this
      // mock's ctx.userIds is always exactly [USER_ID] (single-user, no
      // org), so any account not owned by USER_ID is correctly invisible.
      return jsonResponse(account && account.user_id === USER_ID ? [account] : []);
    }
    // Sibling-accounts lookup (deleteCustomerAccountViaSnapshot): scoped by
    // upload_id only, no id=eq. query parameter present.
    if(u.includes('/rest/v1/ha_accounts') && u.includes('upload_id=eq.') && !hasIdParam && method === 'GET'){
      const uploadMatch = u.match(/upload_id=eq\.([^&]+)/);
      const qUploadId = uploadMatch ? decodeURIComponent(uploadMatch[1]) : null;
      return jsonResponse(fakeAccounts.filter(a => a.upload_id === qUploadId));
    }
    if(u.includes('/rest/v1/ha_accounts') && hasIdParam && method === 'PATCH'){
      const idMatch = u.match(/[?&]id=eq\.([^&]+)/);
      const qId = idMatch ? decodeURIComponent(idMatch[1]) : null;
      const body = JSON.parse(options.body);
      accountPatchCalls.push({ id: qId, body });
      const idx = fakeAccounts.findIndex(a => a.id === qId);
      if(idx >= 0) fakeAccounts[idx] = { ...fakeAccounts[idx], ...body };
      return jsonResponse(idx >= 0 ? [fakeAccounts[idx]] : []);
    }
    if(u.includes('/rest/v1/ha_accounts') && method === 'DELETE'){
      // This is the OLD, now-removed direct-delete shape. Recorded so tests
      // can assert it never fires during the delete-account flow.
      directAccountDeleteCalls.push(u);
      const idMatch = u.match(/[?&]id=eq\.([^&]+)/);
      const qId = idMatch ? decodeURIComponent(idMatch[1]) : null;
      fakeAccounts = fakeAccounts.filter(a => a.id !== qId);
      return jsonResponse([]);
    }
    if(u.includes('/rest/v1/rpc/replace_ha_accounts_snapshot')){
      const body = JSON.parse(options.body);
      const result = fakeReplaceAccountsSnapshot(body);
      return jsonResponse(result.body, result.ok, result.status);
    }
    if(u.includes('/rest/v1/ha_signals') && method === 'DELETE'){
      // Mirrors real Postgres WHERE-clause semantics: a filter term that is
      // literally absent from the URL is UNCONSTRAINED (matches every row),
      // not "compared against null" (which would match nothing). This is
      // what makes this mock actually sensitive to a regression that drops
      // the upload_id term from the real DELETE call -- see release
      // blocker #2 above.
      const uploadMatch = u.match(/[?&]upload_id=eq\.([^&]+)/);
      const userMatch = u.match(/[?&]user_id=eq\.([^&]+)/);
      const nameMatch = u.match(/[?&]account_name=eq\.([^&]+)/);
      const qUploadId = uploadMatch ? decodeURIComponent(uploadMatch[1]) : null;
      const qUserId = userMatch ? decodeURIComponent(userMatch[1]) : null;
      const qName = nameMatch ? decodeURIComponent(nameMatch[1]) : null;
      signalsDeleteCalls.push(u);
      fakeSignals = fakeSignals.filter(s => {
        const matchesUpload = qUploadId === null || s.upload_id === qUploadId;
        const matchesUser = qUserId === null || s.user_id === qUserId;
        const matchesName = qName === null || s.account_name === qName;
        return !(matchesUpload && matchesUser && matchesName);
      });
      return jsonResponse([]);
    }
    throw new Error(`Unhandled mock fetch URL in test: ${method} ${u}`);
  };
}

function resetAll(){
  seedTwoAccounts();
  researchRuns = [];
  rpcCalls = [];
  directAccountDeleteCalls = [];
  accountPatchCalls = [];
  signalsDeleteCalls = [];
  global.fetch = mockFetch();
}

async function run(){
  const originalFetch = global.fetch;

  // 1) Pre-research: deleting one account succeeds through the maintenance
  // RPC, only the selected account is removed, and the remaining account's
  // metadata is preserved exactly.
  {
    resetAll();
    const res = fakeRes();
    await handler(fakeReq({ type: 'account', id: ACCOUNT_ALPHA_ID, action: 'delete-account' }), res);
    assert(res.statusCode === 200 && res.body?.ok === true, '1) pre-research deletion succeeds (200, ok:true)');
    assert(!fakeAccounts.some(a => a.id === ACCOUNT_ALPHA_ID), '1) the deleted account (Alpha Co) is gone');
    const beta = fakeAccounts.find(a => a.account_name === 'Beta Co');
    assert(!!beta, '1) the other account (Beta Co) still exists');
    assert(beta && beta.industry === 'Manufacturing' && beta.contact_name === 'Bo' && beta.metrics.revenue === 200, '1) the remaining account\'s metadata (industry/contact/metrics) is preserved exactly');
    assert(directAccountDeleteCalls.length === 0, '1) no direct DELETE against ha_accounts occurred');
    assert(rpcCalls.length === 1 && rpcCalls[0].p_mode === 'accounts_maintenance', '1) exactly one RPC call was made, with p_mode=accounts_maintenance');
    assert(signalsDeleteCalls.length === 1 && !fakeSignals.some(s => s.event_fingerprint === 'fp-alpha-1'), '1) the removed account\'s signal was cleaned up only after the RPC succeeded');
    assert(fakeSignals.some(s => s.event_fingerprint === 'fp-beta-1'), '1) the remaining account\'s signal is untouched');
  }

  // 2) Researched upload: deletion is rejected with HA004, the account
  // remains, its signals remain, and the response is a clear
  // identity-locked rejection (not a generic 500).
  {
    resetAll();
    researchRuns = [{ upload_id: UPLOAD_ID, status: 'completed', lease_expires_at_ms: 0 }];
    const res = fakeRes();
    await handler(fakeReq({ type: 'account', id: ACCOUNT_ALPHA_ID, action: 'delete-account' }), res);
    assert(res.statusCode !== 500, '2) a researched-upload deletion is rejected with a structured status, not a generic 500');
    assert(res.body?.identityLocked === true, '2) the response carries identityLocked:true');
    assert(fakeAccounts.some(a => a.id === ACCOUNT_ALPHA_ID), '2) the account was NOT removed');
    assert(fakeAccounts.length === 2, '2) the account count is unchanged (2)');
    assert(fakeSignals.some(s => s.event_fingerprint === 'fp-alpha-1'), '2) the account\'s signal was NOT removed');
    assert(directAccountDeleteCalls.length === 0, '2) no direct DELETE against ha_accounts occurred');
  }

  // 3) Active research run: deletion is rejected with 55P03, no account or
  // signal rows change.
  {
    resetAll();
    researchRuns = [{ upload_id: UPLOAD_ID, status: 'running', lease_expires_at_ms: Date.now() + 60_000 }];
    const res = fakeRes();
    await handler(fakeReq({ type: 'account', id: ACCOUNT_ALPHA_ID, action: 'delete-account' }), res);
    assert(res.statusCode === 409, '3) an active-run deletion is rejected with 409');
    assert(fakeAccounts.length === 2 && fakeAccounts.some(a => a.id === ACCOUNT_ALPHA_ID), '3) no account rows changed');
    assert(fakeSignals.length === 2, '3) no signal rows changed');
    assert(directAccountDeleteCalls.length === 0, '3) no direct DELETE against ha_accounts occurred');
  }

  // 4) Pause/resume are unaffected: still a direct, narrow raw_data PATCH,
  // no RPC call at all.
  {
    resetAll();
    const pauseRes = fakeRes();
    await handler(fakeReq({ type: 'account', id: ACCOUNT_ALPHA_ID, action: 'pause-account' }), pauseRes);
    assert(pauseRes.statusCode === 200 && pauseRes.body?.ok === true, '4a) pause-account succeeds');
    assert(fakeAccounts.find(a => a.id === ACCOUNT_ALPHA_ID)?.raw_data?.monitoring_status === 'paused', '4a) monitoring_status is now paused');
    const resumeRes = fakeRes();
    await handler(fakeReq({ type: 'account', id: ACCOUNT_ALPHA_ID, action: 'resume-account' }), resumeRes);
    assert(resumeRes.statusCode === 200 && resumeRes.body?.ok === true, '4b) resume-account succeeds');
    assert(fakeAccounts.find(a => a.id === ACCOUNT_ALPHA_ID)?.raw_data?.monitoring_status === 'active', '4b) monitoring_status is back to active');
    assert(rpcCalls.length === 0, '4) pause/resume never call replace_ha_accounts_snapshot');
    assert(accountPatchCalls.length === 2, '4) pause/resume each issue exactly one direct ha_accounts PATCH, as before');
  }

  // 5) Ownership failure remains rejected -- unchanged, pre-existing check.
  {
    resetAll();
    const strangerAccountId = 'acct-not-owned';
    fakeAccounts.push({ id: strangerAccountId, user_id: 'someone-else', upload_id: 'upload-2', account_name: 'Stranger Co', industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: {} });
    const res = fakeRes();
    await handler(fakeReq({ type: 'account', id: strangerAccountId, action: 'delete-account' }), res);
    assert(res.statusCode !== 200, '5) deleting an account not owned by the caller is rejected');
    assert(fakeAccounts.some(a => a.id === strangerAccountId), '5) the not-owned account is untouched');
    assert(rpcCalls.length === 0, '5) the RPC is never reached for a not-owned account');
  }

  // 6) No-auth request is rejected the same way as every other action in
  // this file (unchanged, pre-existing behavior).
  {
    resetAll();
    const res = fakeRes();
    await handler(fakeReqNoAuth({ type: 'account', id: ACCOUNT_ALPHA_ID, action: 'delete-account' }), res);
    assert(res.statusCode === 401, '6) an unauthenticated delete-account request is rejected with 401');
    assert(rpcCalls.length === 0, '6) the RPC is never reached without authentication');
  }

  // 7) The RPC call uses the real 6-argument replace_ha_accounts_snapshot
  // signature correctly: only p_upload_id/p_user_id/p_accounts/p_mode are
  // set; p_research_run_id/p_attempt_id are both omitted (relying on their
  // SQL defaults), exactly like api/save-upload.js's untracked-path call.
  {
    resetAll();
    await handler(fakeReq({ type: 'account', id: ACCOUNT_ALPHA_ID, action: 'delete-account' }), fakeRes());
    assert(rpcCalls.length === 1, '7) exactly one RPC call was captured');
    const call = rpcCalls[0];
    assert(call.p_upload_id === UPLOAD_ID && call.p_user_id === USER_ID, '7) p_upload_id/p_user_id are the account\'s real upload/owner, not the acting user');
    assert(Array.isArray(call.p_accounts) && call.p_accounts.length === 1 && call.p_accounts[0].account_name === 'Beta Co', '7) p_accounts is the full remaining snapshot (Beta Co only), not a partial/delta payload');
    assert(call.p_mode === 'accounts_maintenance', '7) p_mode is accounts_maintenance');
    assert(!('p_research_run_id' in call) && !('p_attempt_id' in call), '7) p_research_run_id/p_attempt_id are omitted, relying on their SQL defaults (this is not a tracked-research call)');
  }

  // 8) Static structural check: deleteCustomerAccountViaSnapshot()'s own
  // source text contains the RPC call and contains NO direct DELETE method
  // call against ha_accounts, scoped to that function only (deleteList()'s
  // explicit whole-list purge is untouched by this patch and deliberately
  // still contains a direct ha_accounts DELETE -- this check does not
  // inspect that function).
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'api', 'monitoring-lists.js'), 'utf8');
    const fnMatch = src.match(/async function deleteCustomerAccountViaSnapshot\([\s\S]*?\n}/);
    assert(!!fnMatch, '8) deleteCustomerAccountViaSnapshot() is present in the source');
    const fnSrc = fnMatch ? fnMatch[0] : '';
    assert(/rpc\/replace_ha_accounts_snapshot/.test(fnSrc), '8) deleteCustomerAccountViaSnapshot() calls replace_ha_accounts_snapshot');
    assert(!/ha_accounts\?id=eq[\s\S]{0,40}method\s*:\s*'DELETE'/.test(fnSrc), '8) deleteCustomerAccountViaSnapshot() contains no direct id-scoped DELETE against ha_accounts');
  }

  // 9) Release blocker #2 regression: the SAME user has TWO different
  // uploads, and both happen to contain an account named "Alpha Co" (a
  // real, plausible scenario -- account names are only unique per-upload,
  // not per-user). Each upload's "Alpha Co" has its own, separate signal.
  // Deleting Upload A's Alpha Co must delete only Upload A's Alpha Co
  // signal -- Upload B's Alpha Co (a completely different account row,
  // completely different upload) and its signal must be untouched.
  {
    resetAll();
    const UPLOAD_B_ID = 'upload-2';
    const ACCOUNT_ALPHA_B_ID = 'acct-alpha-b';
    fakeAccounts.push({ id: ACCOUNT_ALPHA_B_ID, user_id: USER_ID, upload_id: UPLOAD_B_ID, account_name: 'Alpha Co', industry: 'Retail', contact_name: 'Cy', contact_email: 'cy@alphab.example', metrics: { revenue: 300 }, raw_data: { monitoring_status: 'active' } });
    fakeSignals.push({ id: 'sig-alpha-b-1', user_id: USER_ID, upload_id: UPLOAD_B_ID, account_name: 'Alpha Co', event_fingerprint: 'fp-alpha-b-1' });

    const res = fakeRes();
    await handler(fakeReq({ type: 'account', id: ACCOUNT_ALPHA_ID, action: 'delete-account' }), res);

    assert(res.statusCode === 200 && res.body?.ok === true, '9) deleting Upload A\'s Alpha Co succeeds');
    assert(!fakeAccounts.some(a => a.id === ACCOUNT_ALPHA_ID), '9) Upload A\'s Alpha Co account is gone');
    assert(fakeAccounts.some(a => a.id === ACCOUNT_ALPHA_B_ID), '9) Upload B\'s Alpha Co account is untouched (the RPC snapshot replace is upload_id-scoped and always was)');
    assert(!fakeSignals.some(s => s.event_fingerprint === 'fp-alpha-1'), '9) Upload A\'s Alpha Co signal was deleted');
    assert(fakeSignals.some(s => s.event_fingerprint === 'fp-alpha-b-1'), '9) Upload B\'s Alpha Co signal is UNTOUCHED -- this is the exact release-blocker #2 scenario: same user, same account name, different upload, must not cross-delete');
    assert(fakeSignals.some(s => s.event_fingerprint === 'fp-beta-1'), '9) Upload A\'s unrelated Beta Co signal is also untouched, as before');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
