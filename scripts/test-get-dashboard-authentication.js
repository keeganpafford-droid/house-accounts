// Release blocker fix — api/get-dashboard.js authentication hardening.
//
// Prior behavior: resolveDashboardUser(req, email) fell back to resolving
// ha_users directly from the untrusted ?email= query parameter whenever the
// Bearer token was missing, invalid, or didn't resolve to a matching
// ha_users row. A request with no token (or an invalid one) could still
// retrieve another user's full dashboard -- accounts, signals, upload
// metadata, organization data -- by supplying their email. The new
// uploadId= single-upload-scoped path (see the cross-upload corruption
// fix) then authorized access using that email-resolved (i.e.
// unauthenticated) identity, defeating its own authorization check.
//
// This file exercises the REAL, unmodified default export of
// api/get-dashboard.js -- not a reconstructed helper -- by calling it with
// a fake req/res and a fetch mock that simulates Supabase's Auth and REST
// APIs. Every assertion below is checking the actual HTTP-status/body the
// real handler produces, and (for the "email is never an auth fallback"
// requirement) that the real handler never even issues the
// ha_users?email=eq.... query at all.
//
// Usage: node scripts/test-get-dashboard-authentication.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler from '../api/get-dashboard.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, {ok = true, status = 200} = {}){
  const text = JSON.stringify(data);
  return { ok, status, text: async () => text, json: async () => data };
}

// ===========================================================================
// Fixtures.
// ===========================================================================
const FIXTURES = {
  // Member A: owns upload-a. No organization.
  authTokenA: 'valid-token-a',
  authUserIdA: 'auth-user-a',
  userIdA: 'user-a',
  emailA: 'a@example.com',
  uploadA: 'upload-a',

  // Member B: owns upload-b. No organization. Used as "someone else's
  // email/upload" for the cross-identity and cross-upload tests.
  authTokenB: 'valid-token-b',
  authUserIdB: 'auth-user-b',
  userIdB: 'user-b',
  emailB: 'b@example.com',
  uploadB: 'upload-b',

  // Owner: belongs to org-1, role=owner. org-1 also contains Member C.
  authTokenOwner: 'valid-token-owner',
  authUserIdOwner: 'auth-user-owner',
  userIdOwner: 'user-owner',
  emailOwner: 'owner@example.com',
  orgId: 'org-1',

  // Member C: belongs to org-1 (same org as Owner), role=member, owns
  // upload-org.
  userIdC: 'user-c',
  emailC: 'c@example.com',
  uploadOrg: 'upload-org',

  // A token that authenticates (Supabase accepts it) but has no matching
  // ha_users row at all -- simulates a Supabase Auth user who never
  // completed House Accounts account setup.
  authTokenOrphan: 'valid-token-orphan',
  authUserIdOrphan: 'auth-user-orphan'
};

const HA_USERS = [
  {id: FIXTURES.userIdA, auth_user_id: FIXTURES.authUserIdA, email: FIXTURES.emailA, app_role: 'member', organization_id: null},
  {id: FIXTURES.userIdB, auth_user_id: FIXTURES.authUserIdB, email: FIXTURES.emailB, app_role: 'member', organization_id: null},
  {id: FIXTURES.userIdOwner, auth_user_id: FIXTURES.authUserIdOwner, email: FIXTURES.emailOwner, app_role: 'owner', organization_id: FIXTURES.orgId, status: 'active'},
  {id: FIXTURES.userIdC, auth_user_id: null, email: FIXTURES.emailC, app_role: 'member', organization_id: FIXTURES.orgId, status: 'active'}
];
const AUTH_TOKEN_TO_AUTH_USER_ID = {
  [FIXTURES.authTokenA]: FIXTURES.authUserIdA,
  [FIXTURES.authTokenB]: FIXTURES.authUserIdB,
  [FIXTURES.authTokenOwner]: FIXTURES.authUserIdOwner,
  [FIXTURES.authTokenOrphan]: FIXTURES.authUserIdOrphan
};
const HA_UPLOADS = [
  {id: FIXTURES.uploadA, user_id: FIXTURES.userIdA, upload_name: 'Upload A', stage: 'researched', updated_at: '2026-08-01T00:00:00Z', summary: {}},
  {id: FIXTURES.uploadB, user_id: FIXTURES.userIdB, upload_name: 'Upload B', stage: 'researched', updated_at: '2026-08-01T00:00:00Z', summary: {}},
  {id: FIXTURES.uploadOrg, user_id: FIXTURES.userIdC, upload_name: 'Upload Org', stage: 'researched', updated_at: '2026-08-02T00:00:00Z', summary: {}}
];
const HA_ACCOUNTS = [
  {id: 'acct-a1', upload_id: FIXTURES.uploadA, user_id: FIXTURES.userIdA, account_name: 'A Account', industry: 'Test', raw_data: {}, metrics: {}, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z'},
  {id: 'acct-b1', upload_id: FIXTURES.uploadB, user_id: FIXTURES.userIdB, account_name: 'B Account', industry: 'Test', raw_data: {}, metrics: {}, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z'},
  {id: 'acct-org1', upload_id: FIXTURES.uploadOrg, user_id: FIXTURES.userIdC, account_name: 'Org Account', industry: 'Test', raw_data: {}, metrics: {}, created_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-02T00:00:00Z'}
];
const HA_SIGNALS = [
  {id: 'sig-a1', upload_id: FIXTURES.uploadA, user_id: FIXTURES.userIdA, account_name: 'A Account', signal_type: 'Hiring', title: 'A signal', confidence: 70, first_seen_at: '2026-08-01T00:00:00Z', last_seen_at: '2026-08-01T00:00:00Z', payload: {}},
  {id: 'sig-b1', upload_id: FIXTURES.uploadB, user_id: FIXTURES.userIdB, account_name: 'B Account', signal_type: 'Award', title: 'B signal', confidence: 70, first_seen_at: '2026-08-01T00:00:00Z', last_seen_at: '2026-08-01T00:00:00Z', payload: {}},
  {id: 'sig-org1', upload_id: FIXTURES.uploadOrg, user_id: FIXTURES.userIdC, account_name: 'Org Account', signal_type: 'Expansion', title: 'Org signal', confidence: 70, first_seen_at: '2026-08-02T00:00:00Z', last_seen_at: '2026-08-02T00:00:00Z', payload: {}}
];

// ===========================================================================
// Fetch mock: routes by URL substring, mirroring exactly what
// api/get-dashboard.js's supabase()/authFetchUser() actually request.
// Tracks every call so tests can assert on what was (and, critically, was
// NOT) queried.
// ===========================================================================
function createFetchMock(){
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url, headers: init.headers || {}});

    if(url.includes('/auth/v1/user')){
      const authHeader = String((init.headers || {}).Authorization || '');
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const authUserId = AUTH_TOKEN_TO_AUTH_USER_ID[token];
      if(!authUserId) return jsonResponse({error: 'invalid token'}, {ok: false, status: 401});
      return jsonResponse({id: authUserId});
    }

    // Deliberately explicit: if the real handler EVER issues this exact
    // query shape (resolving a user by the untrusted email query param),
    // that IS the release-blocker regression -- fail loudly instead of
    // quietly answering it.
    if(url.includes('/rest/v1/ha_users') && url.includes('email=eq.')){
      throw new Error(`RELEASE BLOCKER REGRESSION: api/get-dashboard.js queried ha_users by email=eq. (untrusted query param) -- identity must come ONLY from the verified Bearer token. URL: ${url}`);
    }

    if(url.includes('/rest/v1/ha_users') && url.includes('auth_user_id=eq.')){
      const m = url.match(/auth_user_id=eq\.([^&]+)/);
      const authUserId = m ? decodeURIComponent(m[1]) : null;
      return jsonResponse(HA_USERS.filter(u => u.auth_user_id === authUserId));
    }

    if(url.includes('/rest/v1/ha_users') && url.includes('organization_id=eq.')){
      const m = url.match(/organization_id=eq\.([^&]+)/);
      const orgId = m ? decodeURIComponent(m[1]) : null;
      return jsonResponse(HA_USERS.filter(u => u.organization_id === orgId));
    }

    if(url.includes('/rest/v1/ha_organizations')){
      return jsonResponse([{id: FIXTURES.orgId, name: 'Test Org'}]);
    }

    if(url.includes('/rest/v1/ha_uploads')){
      if(url.includes('id=eq.')){
        const m = url.match(/[?&]id=eq\.([^&]+)/);
        const targetId = m ? decodeURIComponent(m[1]) : null;
        const uidsMatch = url.match(/user_id=in\.\(([^)]*)\)/);
        const allowedIds = uidsMatch ? uidsMatch[1].split(',').map(decodeURIComponent) : null;
        let rows = HA_UPLOADS.filter(u => u.id === targetId);
        if(allowedIds) rows = rows.filter(u => allowedIds.includes(u.user_id));
        return jsonResponse(rows);
      }
      const uidsMatch = url.match(/user_id=in\.\(([^)]*)\)/);
      const allowedIds = uidsMatch ? uidsMatch[1].split(',').map(decodeURIComponent) : [];
      return jsonResponse(HA_UPLOADS.filter(u => allowedIds.includes(u.user_id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
    }

    if(url.includes('/rest/v1/ha_accounts')){
      if(url.includes('select=account_name')) return jsonResponse([]); // teamCustomerCount side query -- irrelevant here
      if(url.includes('upload_id=eq.')){
        const m = url.match(/upload_id=eq\.([^&]+)/);
        const uploadId = m ? decodeURIComponent(m[1]) : null;
        return jsonResponse(HA_ACCOUNTS.filter(a => a.upload_id === uploadId));
      }
      if(url.includes('upload_id=in.')){
        const m = url.match(/upload_id=in\.\(([^)]*)\)/);
        const ids = m ? m[1].split(',').map(decodeURIComponent) : [];
        return jsonResponse(HA_ACCOUNTS.filter(a => ids.includes(a.upload_id)));
      }
      if(url.includes('user_id=in.')){
        const m = url.match(/user_id=in\.\(([^)]*)\)/);
        const ids = m ? m[1].split(',').map(decodeURIComponent) : [];
        return jsonResponse(HA_ACCOUNTS.filter(a => ids.includes(a.user_id)));
      }
      return jsonResponse([]);
    }

    if(url.includes('/rest/v1/ha_signals')){
      if(url.includes('upload_id=eq.')){
        const m = url.match(/upload_id=eq\.([^&]+)/);
        const uploadId = m ? decodeURIComponent(m[1]) : null;
        return jsonResponse(HA_SIGNALS.filter(s => s.upload_id === uploadId));
      }
      if(url.includes('upload_id=in.')){
        const m = url.match(/upload_id=in\.\(([^)]*)\)/);
        const ids = m ? m[1].split(',').map(decodeURIComponent) : [];
        return jsonResponse(HA_SIGNALS.filter(s => ids.includes(s.upload_id)));
      }
      if(url.includes('user_id=in.')){
        const m = url.match(/user_id=in\.\(([^)]*)\)/);
        const ids = m ? m[1].split(',').map(decodeURIComponent) : [];
        return jsonResponse(HA_SIGNALS.filter(s => ids.includes(s.user_id)));
      }
      return jsonResponse([]);
    }

    if(url.includes('/rest/v1/ha_weekly_runs')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_prospect_uploads')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_prospect_accounts')) return jsonResponse([]);

    throw new Error(`unexpected fetch in test-get-dashboard-authentication: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function fakeReq({token, query = {}} = {}){
  return {
    method: 'GET',
    headers: token ? {authorization: `Bearer ${token}`} : {},
    query
  };
}
function fakeRes(){
  const res = {
    _status: null,
    _body: null,
    status(code){ this._status = code; return this; },
    json(body){ this._body = body; return this; }
  };
  return res;
}

const originalFetch = global.fetch;

async function run(){
  // =========================================================================
  // 1. No token + valid user email in the query -> 401, no user resolved by
  //    email, nothing about uploads/accounts/signals/organization/usage
  //    returned.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({query: {email: FIXTURES.emailA}}); // no token at all
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 401, `1) no token + valid email: returns 401 (got ${res._status})`);
    assert(!('accounts' in (res._body || {})) && !('upload' in (res._body || {})), '1) no token + valid email: response body contains no accounts/upload data');
    assert(!fetchImpl.calls.some(c => c.url.includes('/rest/v1/ha_uploads')), '1) no token + valid email: ha_uploads was never queried');
    assert(!fetchImpl.calls.some(c => c.url.includes('/rest/v1/ha_accounts')), '1) no token + valid email: ha_accounts was never queried');
    assert(!fetchImpl.calls.some(c => c.url.includes('/rest/v1/ha_signals')), '1) no token + valid email: ha_signals was never queried');
    assert(!fetchImpl.calls.some(c => c.url.includes('/rest/v1/ha_organizations')), '1) no token + valid email: ha_organizations was never queried');
  }

  // =========================================================================
  // 2. Invalid/expired token + valid user email -> 401, no email fallback.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: 'garbage-invalid-token', query: {email: FIXTURES.emailA}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 401, `2) invalid token + valid email: returns 401 (got ${res._status})`);
    assert(!fetchImpl.calls.some(c => c.url.includes('/rest/v1/ha_uploads')), '2) invalid token + valid email: ha_uploads was never queried');
  }

  // =========================================================================
  // 3. Valid token for User A + User B's email in the query -> resolves
  //    User A ONLY. This is the exact identity-confusion scenario: proves
  //    the email param cannot override/redirect a legitimate token's
  //    identity either.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.authTokenA, query: {email: FIXTURES.emailB}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `3) valid token A + email B: request succeeds (got ${res._status}, body ${JSON.stringify(res._body)})`);
    assert(res._body.user.id === FIXTURES.userIdA, '3) valid token A + email B: resolved user is User A, not User B');
    const returnedAccountNames = (res._body.accounts || []).map(a => a.name);
    assert(!returnedAccountNames.includes('B Account'), '3) valid token A + email B: User B\'s account never appears in the response');
    assert(!fetchImpl.calls.some(c => c.url.includes('/rest/v1/ha_users') && c.url.includes('email=eq.')), '3) valid token A + email B: ha_users was never queried by email at all (ha_prospect_uploads?user_email=eq.... is a separate, legitimate, unrelated query and does not count)');
  }

  // =========================================================================
  // 4. Valid token, no matching ha_users row -> 404/account-setup error, no
  //    fallback to another user by email.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.authTokenOrphan, query: {email: FIXTURES.emailA}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 404, `4) valid token, no ha_users row + valid email: returns 404 (got ${res._status})`);
    assert(!res._body || res._body.user === undefined, '4) valid token, no ha_users row: no user object returned');
    assert(!fetchImpl.calls.some(c => c.url.includes('/rest/v1/ha_users') && c.url.includes('email=eq.')), '4) valid token, no ha_users row: does NOT fall back to resolving User A by the supplied email');
  }

  // =========================================================================
  // 5. Authenticated member cannot access another member's upload via
  //    uploadId=.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.authTokenA, query: {uploadId: FIXTURES.uploadB}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 404, `5) member A requesting member B's upload: returns 404 (got ${res._status})`);
    assert(!(res._body && Array.isArray(res._body.accounts) && res._body.accounts.length), '5) member A requesting member B\'s upload: no accounts returned');
  }

  // =========================================================================
  // 6. Authenticated owner/admin CAN access an authorized organization
  //    upload (belonging to a different member of their own org).
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.authTokenOwner, query: {uploadId: FIXTURES.uploadOrg}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `6) owner requesting an org member's upload: succeeds (got ${res._status}, body ${JSON.stringify(res._body)})`);
    assert(res._body.upload && res._body.upload.id === FIXTURES.uploadOrg, '6) owner requesting an org member\'s upload: the correct upload is returned');
    assert((res._body.accounts || []).some(a => a.name === 'Org Account'), '6) owner requesting an org member\'s upload: the org member\'s account is present');
  }

  // =========================================================================
  // 7. uploadId-scoped response contains ONLY that upload's accounts and
  //    signals -- nothing from the requester's OTHER uploads leaks in.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.authTokenA, query: {uploadId: FIXTURES.uploadA}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `7) uploadId-scoped request for own upload: succeeds (got ${res._status})`);
    const accountNames = (res._body.accounts || []).map(a => a.name);
    assert(accountNames.length === 1 && accountNames[0] === 'A Account', `7) uploadId-scoped response contains exactly Upload A's one account (got ${JSON.stringify(accountNames)})`);
    const signalTitles = (res._body.signals || []).map(s => s.title || s.signalTitle);
    assert(signalTitles.length === 1, `7) uploadId-scoped response contains exactly Upload A's one signal (got ${JSON.stringify(signalTitles)})`);
    assert((res._body.accounts || []).every(a => a.uploadId === FIXTURES.uploadA), '7) every returned account carries uploadId === the requested upload');
  }

  // =========================================================================
  // 8. Aggregate My View still works for an authenticated request (no
  //    uploadId=, no view=team).
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.authTokenA, query: {}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `8) aggregate My View for an authenticated member: succeeds (got ${res._status})`);
    assert(res._body.viewMode === 'my', '8) aggregate My View: viewMode is "my"');
    assert((res._body.accounts || []).some(a => a.name === 'A Account'), '8) aggregate My View: the member\'s own account is present');
  }

  // =========================================================================
  // 9. Aggregate Team View still works for an authenticated owner/admin.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.authTokenOwner, query: {view: 'team'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `9) aggregate Team View for an authenticated owner: succeeds (got ${res._status})`);
    assert(res._body.viewMode === 'team', '9) aggregate Team View: viewMode is "team"');
    assert((res._body.accounts || []).some(a => a.name === 'Org Account'), '9) aggregate Team View: an org member\'s account is present (organization-wide aggregation still works)');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL GET-DASHBOARD AUTHENTICATION TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
