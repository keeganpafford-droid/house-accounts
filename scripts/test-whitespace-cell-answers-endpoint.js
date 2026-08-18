// Cell-Level Buying Center x Offering Confirmation / Correction V1 --
// durable, organization-scoped cell-answer endpoint
// (api/whitespace-cell-answers.js). Exercised against the REAL,
// unmodified default export (same convention as
// scripts/test-whitespace-map-endpoint.js). Covers: Bearer-token auth,
// organization-scoped reads/writes (never client-supplied org id), the
// atomic upsert (insert-vs-update resolved by PostgREST, not a client-side
// existence check), input validation for all three fields, and safe
// defaults for a user with no organization.
//
// Usage: node scripts/test-whitespace-cell-answers-endpoint.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler from '../api/whitespace-cell-answers.js';

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

const AUTH_TOKEN = 'valid-token-wscell';
const AUTH_USER_ID = 'auth-user-wscell';
const USER_ID = 'user-wscell';
const ORG_ID = 'org-wscell';

function mockFetchFactory(routes){
  return async (url) => {
    const u = String(url);
    for(const [matcher, responder] of routes){
      const matches = typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u);
      if(matches) return responder(u);
    }
    throw new Error(`unexpected fetch in whitespace-cell-answers test: ${u}`);
  };
}
function baseAuthRoutes(){
  return [
    [/\/auth\/v1\/user/, async () => jsonResponse({ id: AUTH_USER_ID })],
    ['/rest/v1/ha_users?', async () => jsonResponse([{ id: USER_ID, auth_user_id: AUTH_USER_ID, organization_id: ORG_ID }])]
  ];
}

// ===========================================================================
// 1. Authentication -- no token, invalid token.
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
// 2. GET -- single-account mode scopes strictly to the server-derived
//    organization_id and normalizes the account name server-side; batch
//    mode (no accountName) returns every org's answers grouped by
//    normalized_company_name then cellKey.
// ===========================================================================
{
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    for(const [matcher, responder] of baseAuthRoutes()){
      if((typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u))) return responder(u);
    }
    if(u.includes('/rest/v1/ha_whitespace_cell_answers')){
      assert(u.includes(`organization_id=eq.${ORG_ID}`), `REQUIRED: the cell-answers read is scoped to the exact server-derived organization_id (got ${u})`);
      assert(u.includes('normalized_company_name=eq.acme'), `REQUIRED: "Acme Corp" is normalized server-side to "acme" before querying (got ${u})`);
      return jsonResponse([
        { buying_center: 'Marketing', category: 'Apparel', answer: 'covered' },
        { buying_center: 'HR / People', category: 'Onboarding / Recruiting', answer: 'not_applicable' }
      ]);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  try{
    const res = makeRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: { accountName: 'Acme Corp' } }, res);
    assert(res.statusCode === 200 && res.body?.ok === true, `REQUIRED: a valid single-account GET succeeds (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
    assert(res.body?.cellAnswers?.['Marketing||Apparel'] === 'covered', `REQUIRED: the real cell answer is returned, keyed by "buyingCenter||category" (got ${JSON.stringify(res.body?.cellAnswers)})`);
    assert(res.body?.cellAnswers?.['HR / People||Onboarding / Recruiting'] === 'not_applicable', 'REQUIRED: a second, distinct cell answer is returned independently');
  } finally { global.fetch = realFetch; }
}
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory([
    [/\/auth\/v1\/user/, async () => jsonResponse({ id: AUTH_USER_ID })],
    ['/rest/v1/ha_users?', async () => jsonResponse([{ id: USER_ID, auth_user_id: AUTH_USER_ID, organization_id: ORG_ID }])],
    [/\/rest\/v1\/ha_whitespace_cell_answers\?.*select=normalized_company_name,buying_center,category,answer/, async (u) => {
      assert(u.includes(`organization_id=eq.${ORG_ID}`), `REQUIRED: the batch cell-answers read is scoped to the exact server-derived organization_id (got ${u})`);
      return jsonResponse([
        { normalized_company_name: 'acme', buying_center: 'Marketing', category: 'Apparel', answer: 'covered' },
        { normalized_company_name: 'acme', buying_center: 'HR / People', category: 'Safety', answer: 'whitespace' },
        { normalized_company_name: 'globex', buying_center: 'Procurement', category: 'Drinkware', answer: 'not_applicable' }
      ]);
    }]
  ]);
  try{
    const res = makeRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {} }, res);
    assert(res.statusCode === 200 && res.body?.ok === true, `REQUIRED: a batch GET with no accountName succeeds, never 400s (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
    const answers = res.body?.answers;
    assert(answers && typeof answers === 'object' && !Array.isArray(answers), 'REQUIRED: the batch response is a map keyed by normalized_company_name');
    assert(answers?.acme?.['Marketing||Apparel'] === 'covered' && answers?.acme?.['HR / People||Safety'] === 'whitespace', `REQUIRED: acme's cell answers are grouped correctly, each under its own cellKey (got ${JSON.stringify(answers?.acme)})`);
    assert(answers?.globex?.['Procurement||Drinkware'] === 'not_applicable' && Object.keys(answers?.globex || {}).length === 1, `REQUIRED: globex's answers are grouped independently of acme's (got ${JSON.stringify(answers?.globex)})`);
  } finally { global.fetch = realFetch; }
}

// ===========================================================================
// 3. POST -- atomic upsert (on_conflict + merge-duplicates), never a
//    client-side existence-check-then-write. Validates all three fields.
// ===========================================================================
{
  let upsertUrl = null;
  let upsertBody = null;
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    for(const [matcher, responder] of baseAuthRoutes()){
      if((typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u))) return responder(u);
    }
    if(u.includes('/rest/v1/ha_whitespace_cell_answers')){
      if(options?.method === 'POST'){
        upsertUrl = u;
        upsertBody = JSON.parse(options.body);
        assert(options.headers?.Prefer?.includes('resolution=merge-duplicates'), `REQUIRED: the write is a real atomic upsert (Prefer: resolution=merge-duplicates), not a client-side existence-check-then-write (got Prefer: ${options.headers?.Prefer})`);
        return jsonResponse([], {status:201});
      }
      // Read-back after the upsert.
      return jsonResponse([{ buying_center: 'Marketing', category: 'Apparel', answer: 'covered' }]);
    }
    throw new Error(`unexpected fetch: ${u} ${options?.method || 'GET'}`);
  };
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { accountName: 'Acme Corp', buyingCenter: 'Marketing', category: 'Apparel', answer: 'covered' } }, res);
    assert(res.statusCode === 200 && res.body?.ok === true, `REQUIRED: a valid POST succeeds (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
    assert(upsertUrl?.includes('on_conflict=organization_id,normalized_company_name,buying_center,category'), `REQUIRED: the upsert targets the exact four-column unique constraint (got ${upsertUrl})`);
    assert(upsertBody?.organization_id === ORG_ID, 'REQUIRED: the upserted row carries the server-derived organization_id, never a client-supplied one');
    assert(upsertBody?.normalized_company_name === 'acme', 'REQUIRED: the upserted row is keyed by the server-normalized account name');
    assert(upsertBody?.buying_center === 'Marketing' && upsertBody?.category === 'Apparel' && upsertBody?.answer === 'covered', 'REQUIRED: the upserted row carries the requested buying center, category, and answer');
    assert(upsertBody?.confirmed_by_user_id === USER_ID, 'REQUIRED: the upserted row records who answered (accountability), via the server-resolved user id');
    assert(JSON.stringify(res.body?.cellAnswers) === '{"Marketing||Apparel":"covered"}', `REQUIRED: the response reflects the real post-upsert state, read back from the database (got ${JSON.stringify(res.body?.cellAnswers)})`);
  } finally { global.fetch = realFetch; }
}
{
  // Correcting an already-answered cell: the SAME upsert path, no delete,
  // "latest answer wins."
  let upsertBody = null;
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    const u = String(url);
    for(const [matcher, responder] of baseAuthRoutes()){
      if((typeof matcher === 'string' ? u.includes(matcher) : matcher.test(u))) return responder(u);
    }
    if(u.includes('/rest/v1/ha_whitespace_cell_answers')){
      if(options?.method === 'POST'){ upsertBody = JSON.parse(options.body); return jsonResponse([], {status:200}); }
      return jsonResponse([{ buying_center: 'Marketing', category: 'Apparel', answer: 'whitespace' }]);
    }
    throw new Error(`unexpected fetch: ${u} ${options?.method || 'GET'}`);
  };
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { accountName: 'Acme Corp', buyingCenter: 'Marketing', category: 'Apparel', answer: 'whitespace' } }, res);
    assert(res.statusCode === 200, `REQUIRED: correcting an already-answered cell (covered -> whitespace) still succeeds (got ${res.statusCode})`);
    assert(upsertBody?.answer === 'whitespace', 'REQUIRED: the correction is the exact new answer requested, not merged/ignored');
    assert(JSON.stringify(res.body?.cellAnswers) === '{"Marketing||Apparel":"whitespace"}', 'REQUIRED: the response reflects the corrected (latest) answer, not the prior one');
  } finally { global.fetch = realFetch; }
}
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory(baseAuthRoutes());
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { accountName: 'Acme Corp', buyingCenter: 'Not A Real Center', category: 'Apparel', answer: 'covered' } }, res);
    assert(res.statusCode === 400, `REQUIRED: an unrecognized buying center is rejected with 400 (got ${res.statusCode})`);
  } finally { global.fetch = realFetch; }
}
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory(baseAuthRoutes());
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { accountName: 'Acme Corp', buyingCenter: 'Marketing', category: 'Not A Real Category', answer: 'covered' } }, res);
    assert(res.statusCode === 400, `REQUIRED: an unrecognized category/offering is rejected with 400 (got ${res.statusCode})`);
  } finally { global.fetch = realFetch; }
}
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory(baseAuthRoutes());
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { accountName: 'Acme Corp', buyingCenter: 'Marketing', category: 'Apparel', answer: 'yes_probably' } }, res);
    assert(res.statusCode === 400, `REQUIRED: an unrecognized answer value is rejected with 400 -- only covered/whitespace/not_applicable are valid (got ${res.statusCode})`);
  } finally { global.fetch = realFetch; }
}
{
  const realFetch = global.fetch;
  global.fetch = mockFetchFactory(baseAuthRoutes());
  try{
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {}, body: { buyingCenter: 'Marketing', category: 'Apparel', answer: 'covered' } }, res);
    assert(res.statusCode === 400, `REQUIRED: a missing accountName is rejected with 400 (got ${res.statusCode})`);
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
    assert(res.statusCode === 200 && JSON.stringify(res.body?.cellAnswers) === '{}', `REQUIRED: a user with no organization gets an empty, safe result, never an error (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
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
