// Account Expansion / Whitespace Intelligence -- durable, organization-
// scoped buying-center confirmation endpoint (api/whitespace-map.js).
// Exercised against the REAL, unmodified default export (same convention
// as scripts/test-get-dashboard-org-preferences.js), not a reconstructed
// helper. Covers: Bearer-token auth, organization-scoped reads/writes
// (never client-supplied org id), the toggle's add/remove semantics, a
// concurrent-insert race handled gracefully, and safe defaults for a
// user with no organization.
//
// Usage: node scripts/test-whitespace-map-endpoint.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler from '../api/whitespace-map.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}
function jsonResponse(data, {ok = true, status = 200} = {}){
  const text = JSON.stringify(data);
  return { ok, status, text: async () => text, json: async () => data };
}
function makeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

const AUTH_TOKEN = 'valid-token-wsmap';
const AUTH_USER_ID = 'auth-user-wsmap';
const USER_ID = 'user-wsmap';
const ORG_ID = 'org-wsmap';

function mockFetchFactory(routes){
  return async (url) => {
    const u = String(url);
    for(const [matcher, responder] of routes){
      const matches = typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u);
      if(matches) return responder(u);
    }
    throw new Error(`unexpected fetch in whitespace-map test: ${u}`);
  };
}

// ===========================================================================
// 1. Authentication -- no token, invalid token, no matching ha_users row.
// ===========================================================================
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory([]);
  try{
    const res = makeRes();
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    assert(res.statusCode === 401, `REQUIRED: a request with no Authorization header is rejected with 401 (got ${res.statusCode})`);
  } finally { global.fetch = realFetch; }
}
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory([
    [/\/auth\/v1\/user/, async () => jsonResponse({}, {ok:false, status:401})]
  ]);
  try{
    const res = makeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer invalid' }, query: {} }, res);
    assert(res.statusCode === 401, `REQUIRED: an invalid Bearer token is rejected with 401 (got ${res.statusCode})`);
  } finally { global.fetch = realFetch; }
}

// ===========================================================================
// 2. GET -- requires accountName, scopes strictly to the server-derived
//    organization_id, and normalizes the account name server-side.
// ===========================================================================
{
  const calledUrls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    calledUrls.push(String(url));
    const u = String(url);
    if(u.includes('/auth/v1/user')) return jsonResponse({ id: AUTH_USER_ID });
    if(u.includes('/rest/v1/ha_users?')) return jsonResponse([{ id: USER_ID, auth_user_id: AUTH_USER_ID, organization_id: ORG_ID }]);
    if(u.includes('/rest/v1/ha_whitespace_confirmations')){
      assert(u.includes(`organization_id=eq.${ORG_ID}`), `REQUIRED: the confirmations read is scoped to the exact server-derived organization_id (got ${u})`);
      assert(u.includes('normalized_company_name=eq.acme'), `REQUIRED: "Acme Corp" is normalized server-side to "acme" before querying (got ${u})`);
      return jsonResponse([{ buying_center: 'Marketing' }, { buying_center: 'HR / People' }]);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try{
    const res = makeRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: { accountName: 'Acme Corp' } }, res);
    assert(res.statusCode === 200 && res.body?.ok === true, `REQUIRED: a valid GET succeeds (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
    assert(Array.isArray(res.body?.confirmedCenters) && res.body.confirmedCenters.includes('Marketing') && res.body.confirmedCenters.includes('HR / People'), 'REQUIRED: the real confirmed centers are returned');
  } finally { global.fetch = realFetch; }
}
{
  // A GET with no accountName is the batch/org-wide mode -- one bounded
  // request per render, matching the client's loadWhitespaceConfirmations().
  // Must never 400; must return every confirmation for the org grouped by
  // normalized_company_name, and never leak another organization's rows.
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory([
    [/\/auth\/v1\/user/, async () => jsonResponse({ id: AUTH_USER_ID })],
    ['/rest/v1/ha_users?', async () => jsonResponse([{ id: USER_ID, auth_user_id: AUTH_USER_ID, organization_id: ORG_ID }])],
    [/\/rest\/v1\/ha_whitespace_confirmations\?.*select=normalized_company_name,buying_center/, async (u) => {
      assert(u.includes(`organization_id=eq.${ORG_ID}`), `REQUIRED: the batch confirmations read is scoped to the exact server-derived organization_id (got ${u})`);
      return jsonResponse([
        { normalized_company_name: 'acme', buying_center: 'Marketing' },
        { normalized_company_name: 'acme', buying_center: 'HR / People' },
        { normalized_company_name: 'globex', buying_center: 'Procurement' }
      ]);
    }]
  ]);
  try{
    const res = makeRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {} }, res);
    assert(res.statusCode === 200 && res.body?.ok === true, `REQUIRED: a batch GET with no accountName succeeds, never 400s (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
    const confirmations = res.body?.confirmations;
    assert(confirmations && typeof confirmations === 'object' && !Array.isArray(confirmations), 'REQUIRED: the batch response is a map keyed by normalized_company_name');
    assert(Array.isArray(confirmations?.acme) && confirmations.acme.includes('Marketing') && confirmations.acme.includes('HR / People'), 'REQUIRED: acme\'s confirmed centers are grouped correctly');
    assert(Array.isArray(confirmations?.globex) && confirmations.globex.includes('Procurement') && confirmations.globex.length === 1, 'REQUIRED: globex\'s confirmed centers are grouped independently of acme\'s');
  } finally { global.fetch = realFetch; }
}

// ===========================================================================
// 3. POST toggle -- add when absent, remove when present, rejects an
//    unrecognized buying center, and recovers gracefully from a
//    concurrent-insert race (unique-constraint conflict).
// ===========================================================================
function baseAuthRoutes(){
  return [
    [/\/auth\/v1\/user/, async () => jsonResponse({ id: AUTH_USER_ID })],
    ['/rest/v1/ha_users?', async () => jsonResponse([{ id: USER_ID, auth_user_id: AUTH_USER_ID, organization_id: ORG_ID }])]
  ];
}
{
  // Not currently confirmed -> POST inserts, then the follow-up read
  // reflects the new center.
  let insertCalled = false;
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    for(const [matcher, responder] of baseAuthRoutes()){
      if((typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u))) return responder(u);
    }
    if(u.includes('/rest/v1/ha_whitespace_confirmations') && (!options || options.method === 'GET' || !options.method)){
      if(options?.method === 'POST'){
        insertCalled = true;
        const body = JSON.parse(options.body);
        assert(body.organization_id === ORG_ID, 'REQUIRED: the inserted row carries the server-derived organization_id, never a client-supplied one');
        assert(body.normalized_company_name === 'acme', 'REQUIRED: the inserted row is keyed by the server-normalized account name');
        assert(body.buying_center === 'Marketing', 'REQUIRED: the inserted row carries the requested buying center');
        return jsonResponse([], {status:201});
      }
      // Existence check (before insert) -- nothing confirmed yet.
      if(u.includes('buying_center=eq.')) return jsonResponse([]);
      // Final read-back after the write.
      return jsonResponse([{ buying_center: 'Marketing' }]);
    }
    if(u.includes('/rest/v1/ha_whitespace_confirmations') && options?.method === 'POST'){
      insertCalled = true;
      return jsonResponse([], {status:201});
    }
    throw new Error(`unexpected fetch: ${u} ${options?.method || 'GET'}`);
  };
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { accountName: 'Acme Corp', buyingCenter: 'Marketing' } }, res);
    assert(res.statusCode === 200 && res.body?.ok === true, `REQUIRED: a valid POST toggle succeeds (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
    assert(insertCalled, 'REQUIRED: toggling an unconfirmed buying center inserts a row');
    assert(JSON.stringify(res.body?.confirmedCenters) === '["Marketing"]', `REQUIRED: the response reflects the real post-toggle state (got ${JSON.stringify(res.body?.confirmedCenters)})`);
  } finally { global.fetch = realFetch; }
}
{
  // Already confirmed -> POST deletes the existing row.
  let deleteCalled = false;
  const realFetch = global.fetch;
  let readCount = 0;
  global.fetch = async (url, options) => {
    const u = String(url);
    for(const [matcher, responder] of baseAuthRoutes()){
      if((typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u))) return responder(u);
    }
    if(u.includes('/rest/v1/ha_whitespace_confirmations')){
      if(options?.method === 'DELETE'){
        deleteCalled = true;
        assert(u.includes('id=eq.existing-row-id'), 'REQUIRED: the delete targets the exact existing row id, not a broad match');
        return jsonResponse([], {status:200});
      }
      readCount += 1;
      if(readCount === 1) return jsonResponse([{ id: 'existing-row-id' }]); // existence check
      return jsonResponse([]); // post-delete read-back: nothing confirmed
    }
    throw new Error(`unexpected fetch: ${u} ${options?.method || 'GET'}`);
  };
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { accountName: 'Acme Corp', buyingCenter: 'Marketing' } }, res);
    assert(deleteCalled, 'REQUIRED: toggling an already-confirmed buying center deletes the row -- a rep can correct a misclick');
    assert(JSON.stringify(res.body?.confirmedCenters) === '[]', 'REQUIRED: the response reflects the real post-toggle (now unconfirmed) state');
  } finally { global.fetch = realFetch; }
}
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory(baseAuthRoutes());
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { accountName: 'Acme Corp', buyingCenter: 'Not A Real Center' } }, res);
    assert(res.statusCode === 400, `REQUIRED: an unrecognized buying center is rejected with 400 (got ${res.statusCode})`);
  } finally { global.fetch = realFetch; }
}
{
  // Concurrent-insert race: the existence check finds nothing, but the
  // insert itself hits the unique constraint because another request won
  // the race in between -- this must resolve as success (the end state,
  // confirmed, is exactly what was requested), never a 500.
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    for(const [matcher, responder] of baseAuthRoutes()){
      if((typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u))) return responder(u);
    }
    if(u.includes('/rest/v1/ha_whitespace_confirmations')){
      if(options?.method === 'POST'){
        return { ok:false, status:409, text: async () => JSON.stringify({message:'duplicate key value violates unique constraint'}), json: async () => ({message:'duplicate key value violates unique constraint'}) };
      }
      if(u.includes('buying_center=eq.')) return jsonResponse([]); // existence check: not found (race)
      return jsonResponse([{ buying_center: 'Marketing' }]); // read-back: the concurrent request's row is now visible
    }
    throw new Error(`unexpected fetch: ${u} ${options?.method || 'GET'}`);
  };
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { accountName: 'Acme Corp', buyingCenter: 'Marketing' } }, res);
    assert(res.statusCode === 200 && res.body?.ok === true, `REQUIRED: a concurrent-insert race (unique constraint conflict) resolves as success, never a 500 (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
    assert(JSON.stringify(res.body?.confirmedCenters) === '["Marketing"]', 'REQUIRED: the response reflects the real, now-confirmed state despite losing the race');
  } finally { global.fetch = realFetch; }
}

// ===========================================================================
// 4. A user with no organization fails safe -- never errors, never
//    fabricates data.
// ===========================================================================
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory([
    [/\/auth\/v1\/user/, async () => jsonResponse({ id: AUTH_USER_ID })],
    ['/rest/v1/ha_users?', async () => jsonResponse([{ id: USER_ID, auth_user_id: AUTH_USER_ID, organization_id: null }])]
  ]);
  try{
    const res = makeRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: { accountName: 'Acme Corp' } }, res);
    assert(res.statusCode === 200 && JSON.stringify(res.body?.confirmedCenters) === '[]', `REQUIRED: a user with no organization gets an empty, safe result, never an error (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
  } finally { global.fetch = realFetch; }
}

// ===========================================================================
// 5. Method handling.
// ===========================================================================
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory(baseAuthRoutes());
  try{
    const res = makeRes();
    await handler({ method: 'DELETE', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {} }, res);
    assert(res.statusCode === 405, `REQUIRED: an unsupported method is rejected with 405 (got ${res.statusCode})`);
  } finally { global.fetch = realFetch; }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
