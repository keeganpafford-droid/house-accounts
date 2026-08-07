// Scaling round -- Manage Customer Accounts pagination, server side.
//
// Exercises the REAL, unmodified default export of api/monitoring-lists.js
// against a realistic 1,000-account fixture with a fetch mock standing in
// for Supabase/PostgREST (including Prefer: count=exact -> Content-Range,
// the exact mechanism this endpoint uses to report totals without ever
// downloading the rows themselves). No real network call is ever made.
//
// Usage: node scripts/test-manage-accounts-pagination-server.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler from '../api/monitoring-lists.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Fixtures: two organizations, entirely separate. Org A owns upload-1 with a
// realistic 1,000-account book (deterministically sorted by account_name,
// ~10% paused, a handful already researched). Org B owns upload-2 -- used
// exclusively as the "forged/foreign upload" target for the authorization
// tests, and must never be reachable from an Org A token.
// ===========================================================================
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const TOKEN_OWNER_A = 'token-owner-a';
const TOKEN_OWNER_B = 'token-owner-b';
const AUTH_USER_OWNER_A = 'auth-owner-a';
const AUTH_USER_OWNER_B = 'auth-owner-b';
const USER_OWNER_A = 'user-owner-a';
const USER_OWNER_B = 'user-owner-b';
const UPLOAD_A = 'upload-1';
const UPLOAD_B = 'upload-2';

const HA_USERS = [
  {id: USER_OWNER_A, auth_user_id: AUTH_USER_OWNER_A, email: 'owner-a@example.com', app_role: 'owner', organization_id: ORG_A, status: 'active'},
  {id: USER_OWNER_B, auth_user_id: AUTH_USER_OWNER_B, email: 'owner-b@example.com', app_role: 'owner', organization_id: ORG_B, status: 'active'}
];
const AUTH_TOKEN_TO_AUTH_USER_ID = {
  [TOKEN_OWNER_A]: AUTH_USER_OWNER_A,
  [TOKEN_OWNER_B]: AUTH_USER_OWNER_B
};
const HA_UPLOADS = [
  {id: UPLOAD_A, user_id: USER_OWNER_A, upload_name: 'Big Distributor Book', stage: 'researched', updated_at: '2026-08-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z'},
  {id: UPLOAD_B, user_id: USER_OWNER_B, upload_name: "Org B's List", stage: 'uploaded', updated_at: '2026-08-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z'}
];

const FIXTURE_SIZE = 1000;
const HA_ACCOUNTS_A = Array.from({length: FIXTURE_SIZE}, (_, i) => ({
  id: `acct-a-${i}`,
  upload_id: UPLOAD_A,
  account_name: `Account ${String(i).padStart(4, '0')}`,
  industry: 'Promotional Products',
  raw_data: {
    monitoring_status: i % 10 === 0 ? 'paused' : 'active',
    last_researched_at: i < 7 ? '2026-08-01T00:00:00Z' : null,
    website: ''
  },
  created_at: '2026-01-05T00:00:00Z'
})).sort((a, b) => a.account_name.localeCompare(b.account_name));
// A single, uniquely-matchable account for the search tests.
HA_ACCOUNTS_A.push({
  id: 'acct-a-needle', upload_id: UPLOAD_A, account_name: 'Zenith Distinctive Needle Co',
  industry: 'Test', raw_data: {monitoring_status: 'active'}, created_at: '2026-01-05T00:00:00Z'
});
const HA_ACCOUNTS_B = [
  {id: 'acct-b-1', upload_id: UPLOAD_B, account_name: 'Org B Account', industry: 'Test', raw_data: {monitoring_status: 'active'}, created_at: '2026-01-05T00:00:00Z'}
];
const ALL_ACCOUNTS = [...HA_ACCOUNTS_A, ...HA_ACCOUNTS_B];

// ===========================================================================
// Fetch mock: routes by URL substring, mirroring exactly what
// api/monitoring-lists.js's sb()/sbCount() actually request. Tracks every
// call (method + full URL) so tests can assert on what was -- and,
// critically, was NOT -- queried. No write (PATCH/POST/DELETE) is ever
// expected from this file -- every test here only exercises GET.
// ===========================================================================
function createFetchMock(){
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({url: String(url), method, headers: init.headers || {}});
    const u = new URL(url);
    const params = u.searchParams;

    if(u.pathname === '/auth/v1/user'){
      const authHeader = String((init.headers || {}).Authorization || '');
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const authUserId = AUTH_TOKEN_TO_AUTH_USER_ID[token];
      if(!authUserId) return jsonResp({error: 'invalid token'}, 401);
      return jsonResp({id: authUserId});
    }

    if(u.pathname === '/rest/v1/ha_users'){
      if(method !== 'GET') throw new Error(`UNEXPECTED WRITE to ha_users: ${method} ${url}`);
      const authUserId = params.get('auth_user_id')?.replace('eq.', '');
      const orgId = params.get('organization_id')?.replace('eq.', '');
      if(authUserId) return jsonResp(HA_USERS.filter(x => x.auth_user_id === authUserId));
      if(orgId) return jsonResp(HA_USERS.filter(x => x.organization_id === orgId));
      return jsonResp([]);
    }

    if(u.pathname === '/rest/v1/ha_uploads'){
      if(method !== 'GET') throw new Error(`UNEXPECTED WRITE to ha_uploads: ${method} ${url}`);
      const idFilter = params.get('id')?.replace('eq.', '');
      const userIdFilter = params.get('user_id') || '';
      const allowedIds = parseInFilter(userIdFilter);
      let rows = HA_UPLOADS;
      if(idFilter) rows = rows.filter(x => x.id === idFilter);
      if(allowedIds) rows = rows.filter(x => allowedIds.includes(x.user_id));
      return jsonResp(rows);
    }

    if(u.pathname === '/rest/v1/ha_accounts'){
      if(method !== 'GET') throw new Error(`UNEXPECTED WRITE to ha_accounts: ${method} ${url} -- this endpoint must never mutate account data`);
      let rows = filterAccounts(ALL_ACCOUNTS, params);
      const isCount = (init.headers || {}).Prefer === 'count=exact';
      if(isCount){
        const resp = jsonResp([]);
        resp.headers = {get: h => (h.toLowerCase() === 'content-range' ? `0-0/${rows.length}` : null)};
        return resp;
      }
      const limitMatch = url.match(/limit=(\d+)/);
      const limit = limitMatch ? Number(limitMatch[1]) : rows.length;
      return jsonResp(rows.slice(0, limit));
    }

    if(u.pathname === '/rest/v1/ha_signals'){
      if(method !== 'GET') throw new Error(`UNEXPECTED WRITE to ha_signals: ${method} ${url}`);
      return jsonResp([]);
    }

    if(u.pathname === '/rest/v1/ha_research_runs'){
      if(method !== 'GET') throw new Error(`UNEXPECTED WRITE to ha_research_runs: ${method} ${url}`);
      return jsonResp([]);
    }

    if(u.pathname === '/rest/v1/ha_prospect_uploads') return jsonResp([]);

    throw new Error(`unexpected fetch in test-manage-accounts-pagination-server: ${method} ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResp(data, status = 200){
  const text = JSON.stringify(data);
  return {ok: status >= 200 && status < 300, status, json: async () => data, text: async () => text, headers: {get: () => null}};
}
function parseInFilter(raw){
  const m = raw.match(/^in\.\((.*)\)$/);
  if(!m) return null;
  return m[1].split(',').map(s => s.replace(/^"|"$/g, ''));
}
function filterAccounts(all, params){
  let rows = all;
  const uploadId = params.get('upload_id')?.replace('eq.', '');
  if(uploadId) rows = rows.filter(a => a.upload_id === uploadId);
  const monitoringStatus = params.get('raw_data->>monitoring_status');
  if(monitoringStatus === 'eq.paused') rows = rows.filter(a => a.raw_data?.monitoring_status === 'paused');
  const lastResearched = params.get('raw_data->>last_researched_at');
  if(lastResearched === 'not.is.null') rows = rows.filter(a => !!a.raw_data?.last_researched_at);
  const nameFilter = params.get('account_name');
  if(nameFilter){
    if(nameFilter.startsWith('gt.')) rows = rows.filter(a => a.account_name > nameFilter.slice(3));
    else if(nameFilter.startsWith('ilike.')){
      const pat = nameFilter.slice(6).replace(/^\*/, '').replace(/\*$/, '').toLowerCase();
      rows = rows.filter(a => a.account_name.toLowerCase().includes(pat));
    }
  }
  return [...rows].sort((a, b) => a.account_name.localeCompare(b.account_name));
}

function fakeReq({token, query = {}}){
  return {method: 'GET', headers: token ? {authorization: `Bearer ${token}`} : {}, query};
}
function fakeRes(){
  return {
    _status: null, _body: null,
    status(c){ this._status = c; return this; },
    json(b){ this._body = b; return this; },
    setHeader(){}
  };
}

async function run(){
  // =========================================================================
  // 1/2. Modal-open request returns upload summaries only -- no account
  // array, no raw_data anywhere in the response.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A}), res);
    assert(res._status === 200, `1) modal-open GET succeeds (got ${res._status})`);
    const upload = res._body.lists.customer.find(l => l.id === UPLOAD_A);
    assert(!!upload, '1) the summary response includes the upload');
    assert(!('accounts' in upload), '2) the upload summary does NOT include an .accounts array');
    assert(JSON.stringify(res._body).indexOf('raw_data') === -1, '2) raw_data never appears anywhere in the summary response JSON');
    assert(upload.companyCount === FIXTURE_SIZE + 1, `the summary reports the real total account count (got ${upload.companyCount})`);
    assert(typeof upload.activeCount === 'number' && typeof upload.pausedCount === 'number', 'active/paused counts are present on the summary');
    assert(typeof upload.everResearched === 'boolean', 'everResearched is present on the summary');
    // Performance acceptance item 1: opening the modal never fetches the
    // 1,000 account records themselves. Every ha_accounts call is either a
    // count=exact (zero rows transferred) or the tiny, bounded
    // "everResearched" existence check (limit=1) -- never a real dump of
    // account rows.
    const accountFetches = fetchImpl.calls.filter(c => c.url.includes('/rest/v1/ha_accounts'));
    const nonCountAccountFetches = accountFetches.filter(c => c.headers.Prefer !== 'count=exact');
    assert(nonCountAccountFetches.every(c => /limit=([0-9]+)/.test(c.url) && Number(c.url.match(/limit=([0-9]+)/)[1]) <= 5), `1) opening the modal never downloads a real batch of account rows -- the only non-count ha_accounts calls are tiny, limit<=5 existence checks (got: ${nonCountAccountFetches.map(c => c.url).join(', ')})`);
  }

  // =========================================================================
  // 3. Expanding one upload fetches only that upload.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A}}), res);
    assert(res._status === 200, `3) expand request succeeds (got ${res._status})`);
    assert(res._body.accounts.every(a => a.uploadId === UPLOAD_A), '3) every returned account row belongs to the requested upload');
    const accountFetches = fetchImpl.calls.filter(c => c.url.includes('/rest/v1/ha_accounts'));
    assert(accountFetches.every(c => c.url.includes(`upload_id=eq.${UPLOAD_A}`)), '3) every ha_accounts query issued is scoped to exactly the requested upload_id');
  }

  // =========================================================================
  // 4/5. Default page size is bounded around 50; a caller cannot request an
  // arbitrarily huge (or invalid/zero) page size.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A}}), res);
    assert(res._body.accounts.length === 50 && res._body.pageInfo.limit === 50, `4) default page size is 50 (got ${res._body.accounts.length} rows, limit=${res._body.pageInfo.limit})`);
  }
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A, limit: '999999'}}), res);
    assert(res._body.pageInfo.limit === 100, `5) an absurdly large requested limit is clamped to the server maximum (got ${res._body.pageInfo.limit})`);
    assert(res._body.accounts.length === 100, '5) the actual returned row count matches the clamped limit, not the requested one');
  }
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A, limit: '-5'}}), res);
    assert(res._body.pageInfo.limit >= 1, `5) a negative/invalid requested limit never produces a zero-or-negative page size (got ${res._body.pageInfo.limit})`);
  }

  // =========================================================================
  // 6/7/8. Pagination order is deterministic; page 1 + page 2 have no
  // duplicate accounts and no missing boundary account.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res1a = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A}}), res1a);
    const res1b = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A}}), res1b);
    assert(JSON.stringify(res1a._body.accounts) === JSON.stringify(res1b._body.accounts), '6) requesting page 1 twice returns the identical set in the identical order -- deterministic pagination');

    const res2 = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A, cursor: res1a._body.pageInfo.nextCursor}}), res2);
    const names1 = res1a._body.accounts.map(a => a.name);
    const names2 = res2._body.accounts.map(a => a.name);
    const overlap = names1.filter(n => names2.includes(n));
    assert(overlap.length === 0, `7) page 1 and page 2 share no accounts (got ${overlap.length} overlapping)`);
    assert(names2[0] > names1[names1.length - 1], '8) page 2 begins with the very next account after page 1 ends, in sorted order -- no boundary account is skipped');
    // Full-book reconstruction: walking every page via nextCursor visits
    // every account exactly once, in sorted order.
    let cursor = null; const seen = [];
    for(let i = 0; i < 30; i++){
      const res = fakeRes();
      await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A, ...(cursor ? {cursor} : {})}}), res);
      seen.push(...res._body.accounts.map(a => a.name));
      if(!res._body.pageInfo.hasMore) break;
      cursor = res._body.pageInfo.nextCursor;
    }
    assert(seen.length === FIXTURE_SIZE + 1, `walking every page via nextCursor visits every account exactly once (got ${seen.length}, expected ${FIXTURE_SIZE + 1})`);
    assert(new Set(seen).size === seen.length, 'no account is ever visited twice while walking every page');
    const sortedCopy = [...seen].sort((a, b) => a.localeCompare(b));
    assert(JSON.stringify(seen) === JSON.stringify(sortedCopy), '6) the full walked sequence is in deterministic, sorted account_name order');
  }

  // =========================================================================
  // 9. Cursor cannot escape the selected upload.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res1 = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A}}), res1);
    const cursorFromUploadA = res1._body.pageInfo.nextCursor;
    // Reusing upload-A's cursor against upload-B (owned by a DIFFERENT
    // organization) must be rejected before the cursor is ever applied --
    // proven by the 404 (ownership is checked first) and by asserting no
    // ha_accounts query for upload-B ever executes.
    const resForged = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_B, cursor: cursorFromUploadA}}), resForged);
    assert(resForged._status === 404, `9) an Org A token cannot use ANY cursor to reach Org B's upload (got ${resForged._status})`);
    const uploadBAccountFetches = fetchImpl.calls.filter(c => c.url.includes('/rest/v1/ha_accounts') && c.url.includes(`upload_id=eq.${UPLOAD_B}`));
    assert(uploadBAccountFetches.length === 0, '9) no ha_accounts query for the foreign upload was ever issued -- the cursor could not smuggle access to it');
  }

  // =========================================================================
  // 10/11. Search is upload-scoped and organization-authorized.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A, q: 'Zenith Distinctive'}}), res);
    assert(res._status === 200 && res._body.accounts.length === 1 && res._body.accounts[0].name === 'Zenith Distinctive Needle Co', `10) search finds the exact matching account within the selected upload (got ${JSON.stringify(res._body.accounts.map(a => a.name))})`);
    assert(res._body.accounts.every(a => a.uploadId === UPLOAD_A), '10) search results never include a row from a different upload');
  }
  {
    // 11) org-authorization: Org B's token can never search Org A's
    // upload, regardless of the search term.
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_B, query: {uploadId: UPLOAD_A, q: 'Account'}}), res);
    assert(res._status === 404, `11) search against another organization's upload is rejected regardless of the search term (got ${res._status})`);
  }

  // =========================================================================
  // 12. Forged upload IDs cannot expose another organization's data.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_B, query: {uploadId: UPLOAD_A}}), res);
    assert(res._status === 404, `12) Org B's token requesting Org A's real upload id is rejected (got ${res._status})`);
    assert(!res._body.accounts, '12) no accounts are ever returned for a forged/foreign upload id');
    const uploadAAccountFetches = fetchImpl.calls.filter(c => c.url.includes('/rest/v1/ha_accounts') && c.url.includes(`upload_id=eq.${UPLOAD_A}`));
    assert(uploadAAccountFetches.length === 0, '12) the authorization check rejects the request before any ha_accounts query for the foreign upload is ever issued');
  }
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: 'totally-made-up-upload-id'}}), res);
    assert(res._status === 404, `12) a wholly nonexistent upload id is rejected the same way as a real foreign one (got ${res._status})`);
  }

  // =========================================================================
  // 13. Total counts are independent of page size.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const resSmall = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A, limit: '5'}}), resSmall);
    const resLarge = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A, limit: '100'}}), resLarge);
    assert(resSmall._body.pageInfo.total === resLarge._body.pageInfo.total && resSmall._body.pageInfo.total === FIXTURE_SIZE + 1, `13) the reported total is identical regardless of the requested page size (got ${resSmall._body.pageInfo.total} vs ${resLarge._body.pageInfo.total})`);
  }

  // =========================================================================
  // 14. Search counts are accurate.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    // "Account 000" matches Account 0000-0009 -- exactly 10 real accounts.
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A, q: 'Account 000'}}), res);
    assert(res._body.pageInfo.total === 10, `14) the search total accurately reflects only the matching accounts, not the whole upload (got ${res._body.pageInfo.total})`);
    assert(res._body.accounts.length === 10 && res._body.pageInfo.hasMore === false, '14) a search result smaller than the page size reports hasMore:false correctly');
  }

  // =========================================================================
  // 15. List-row payload excludes raw_data.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A}}), res);
    for(const row of res._body.accounts){
      assert(!('raw_data' in row), `15) account row for "${row.name}" never includes the raw raw_data blob`);
      const keys = Object.keys(row).sort();
      assert(JSON.stringify(keys) === JSON.stringify(['dateAdded', 'domain', 'hasActionableAlert', 'id', 'industry', 'lastResearchedAt', 'monitoringStatus', 'name', 'researchStatus', 'uploadId'].sort()), `15) account row for "${row.name}" contains only the expected display fields (got ${keys.join(',')})`);
    }
  }

  // =========================================================================
  // No database write: every single call made anywhere in this file was a
  // GET -- this pagination/search endpoint is fully read-only.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const res = fakeRes();
    await handler(fakeReq({token: TOKEN_OWNER_A, query: {uploadId: UPLOAD_A, q: 'Account'}}), res);
    assert(fetchImpl.calls.length > 0 && fetchImpl.calls.every(c => c.method === 'GET'), 'no database write: every request this endpoint issues (across auth, ownership check, count, and page fetch) is a GET');
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

const originalFetch = global.fetch;
run().finally(() => { global.fetch = originalFetch; });
