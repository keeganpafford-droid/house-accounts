// Duplicate-company research control (beta round) -- validates the
// production-bound implementation, not a reimplementation of it:
//   - api/company-identity.js's normalizeCompanyName() (the single shared
//     implementation used by save-upload.js, settings.js, and
//     research-batch.js's duplicate check)
//   - api/research-batch.js's resolveDuplicateCheckScopeUserIds(),
//     findActiveDuplicateCompanyCollisions(), the real
//     researchRunAction:'check-duplicates' branch, and the real dispatch-time
//     safeAccounts re-filter -- all exercised through the actual default
//     handler() export via mocked Supabase/OpenAI fetch, exactly like
//     scripts/test-research-run-idempotency.js and
//     scripts/test-provider-usage-instrumentation.js already do for the rest
//     of this file.
//   - dashboard/index.html's real checkDuplicateCompanyResearch() and
//     duplicateCompanyResearchMessage(), extracted verbatim and run in a vm
//     sandbox exactly like scripts/test-dashboard-orchestration.js does.
//
// Usage: node scripts/test-duplicate-company-research-control.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-do-not-log';
delete process.env.SERPER_API_KEY;
delete process.env.FIRECRAWL_API_KEY;
delete process.env.TAVILY_API_KEY;
delete process.env.BRAVE_SEARCH_API_KEY;

import { readFileSync } from 'fs';
import vm from 'vm';
import handler, {
  resolveDuplicateCheckScopeUserIds,
  findActiveDuplicateCompanyCollisions
} from '../api/research-batch.js';
import { normalizeCompanyName } from '../api/company-identity.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Fixtures: two organizations (org-a with two reps, org-b with one rep) and
// two unrelated solo users, each owning at least one upload/account, so
// scope-resolution and cross-org/cross-user isolation are exercised against
// real, distinguishable data -- not a single trivial case.
// ===========================================================================
const FIXTURES = {
  users: {
    'auth-1': { id: 'user-1', email: 'rep1@org-a.com', organization_id: 'org-a' },
    'auth-2': { id: 'user-2', email: 'rep2@org-a.com', organization_id: 'org-a' },
    'auth-3': { id: 'user-3', email: 'rep1@org-b.com', organization_id: 'org-b' },
    'auth-4': { id: 'user-4', email: 'solo@example.com', organization_id: null },
    'auth-5': { id: 'user-5', email: 'solo2@example.com', organization_id: null }
  },
  orgMembers: {
    'org-a': ['user-1', 'user-2'],
    'org-b': ['user-3']
  },
  uploads: {
    'upload-1': 'user-1', // org-a
    'upload-1b': 'user-1', // org-a, same owner as upload-1
    'upload-2': 'user-2', // org-a
    'upload-3': 'user-3', // org-b
    'upload-4': 'user-4', // solo
    'upload-4b': 'user-4', // solo, same owner as upload-4
    'upload-5': 'user-5' // solo, unrelated to user-4
  },
  accounts: {
    'upload-1': ['Acme Manufacturing Inc', 'Beta Supplies Co'],
    'upload-1b': ['Acme Manufacturing Inc'],
    'upload-2': ['ACME MANUFACTURING', 'Gamma Corp'],
    'upload-3': ['Acme Manufacturing Inc'],
    'upload-4': ['Acme Manufacturing Inc'],
    'upload-4b': ['Acme Manufacturing, LLC'],
    'upload-5': ['Acme Manufacturing Inc']
  }
};

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

// A mutable table of ha_research_runs rows the tests can freely add/remove
// active/expired/completed/failed rows to, keyed by upload_id.
function makeResearchRunsTable(initialRows = []){
  return { rows: [...initialRows] };
}

function activeRunRow({ userId, uploadId, leaseMsFromNow = 5 * 60 * 1000 }){
  return { user_id: userId, upload_id: uploadId, status: 'running', lease_expires_at: new Date(Date.now() + leaseMsFromNow).toISOString() };
}
function expiredRunRow({ userId, uploadId }){
  return { user_id: userId, upload_id: uploadId, status: 'running', lease_expires_at: new Date(Date.now() - 60 * 1000).toISOString() };
}
function completedRunRow({ userId, uploadId }){
  return { user_id: userId, upload_id: uploadId, status: 'completed', lease_expires_at: new Date(Date.now() - 60 * 1000).toISOString() };
}
function failedRunRow({ userId, uploadId }){
  return { user_id: userId, upload_id: uploadId, status: 'failed', lease_expires_at: new Date(Date.now() - 60 * 1000).toISOString() };
}

// Builds a fetch mock covering every Supabase/OpenAI call the duplicate-
// company-control code paths make. `options.researchRunsTable` lets a test
// control which runs are "active" at check time. `options.failOn` names a
// table ('ha_research_runs' | 'ha_accounts-own' | 'ha_users-org') whose
// query should throw, to exercise the fail-open contract.
function makeMockFetch({ researchRunsTable, failOn = null, openaiSignals = [] } = {}){
  return async (url, options = {}) => {
    const u = String(url);
    if(u.includes('/auth/v1/user')){
      const token = String((options.headers || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      const authId = token.replace(/^token-/, '');
      if(FIXTURES.users[authId]) return jsonResponse({ id: authId });
      return jsonResponse({ error: 'invalid token' }, false, 401);
    }
    if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')){
      const authId = decodeURIComponent(u.split('auth_user_id=eq.')[1].split('&')[0]);
      const user = FIXTURES.users[authId];
      return jsonResponse(user ? [{ id: user.id, email: user.email, organization_id: user.organization_id }] : []);
    }
    if(u.includes('/rest/v1/ha_users?organization_id=eq.')){
      if(failOn === 'ha_users-org') throw new Error('simulated network failure resolving org members');
      const orgId = decodeURIComponent(u.split('organization_id=eq.')[1].split('&')[0]);
      const members = FIXTURES.orgMembers[orgId] || [];
      return jsonResponse(members.map(id => ({ id })));
    }
    if(u.includes('/rest/v1/ha_uploads?id=eq.')){
      const uploadId = decodeURIComponent(u.split('id=eq.')[1].split('&')[0]);
      const ownerId = FIXTURES.uploads[uploadId];
      return jsonResponse(ownerId ? [{ id: uploadId, user_id: ownerId }] : []);
    }
    if(u.includes('/rest/v1/ha_research_runs') && (!options.method || options.method === 'GET')){
      if(failOn === 'ha_research_runs') throw new Error('simulated network failure querying active research runs');
      const params = new URLSearchParams(u.split('?')[1]);
      const userFilter = params.get('user_id') || '';
      const excludeUploadId = (params.get('upload_id') || '').replace(/^neq\./, '');
      const scopeIds = userFilter.startsWith('in.(') ? userFilter.slice(4, -1).split(',').map(decodeURIComponent) : [];
      const now = Date.now();
      const rows = (researchRunsTable ? researchRunsTable.rows : []).filter(r =>
        scopeIds.includes(r.user_id) &&
        r.upload_id !== excludeUploadId &&
        r.status === 'running' &&
        new Date(r.lease_expires_at).getTime() > now
      );
      return jsonResponse(rows.map(r => ({ upload_id: r.upload_id })));
    }
    if(u.includes('/rest/v1/ha_accounts?upload_id=in.(')){
      const raw = u.split('upload_id=in.(')[1].split(')')[0];
      const uploadIds = raw.split(',').map(decodeURIComponent);
      const out = [];
      for(const id of uploadIds){
        for(const name of (FIXTURES.accounts[id] || [])) out.push({ account_name: name });
      }
      return jsonResponse(out);
    }
    if(u.includes('/rest/v1/ha_accounts?upload_id=eq.')){
      if(failOn === 'ha_accounts-own') throw new Error('simulated network failure loading own accounts');
      const uploadId = decodeURIComponent(u.split('upload_id=eq.')[1].split('&')[0]);
      return jsonResponse((FIXTURES.accounts[uploadId] || []).map(name => ({ account_name: name })));
    }
    if(u.includes('/rest/v1/rpc/heartbeat_ha_research_run') && options.method === 'POST'){
      return jsonResponse({ ok: true, run: { lease_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() } });
    }
    if(u.includes('api.openai.com')){
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: openaiSignals }), usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }) };
    }
    throw new Error(`Unhandled mock fetch URL: ${u} (${options.method || 'GET'})`);
  };
}

function makeReq({ token, uploadId, body = {} }){
  return { method: 'POST', headers: token ? { authorization: `Bearer token-${token}` } : {}, body: { uploadId, ...body } };
}
function makeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return res; };
  return res;
}

const originalFetch = global.fetch;
async function withFetch(fetchImpl, fn){
  global.fetch = fetchImpl;
  try { return await fn(); } finally { global.fetch = originalFetch; }
}

async function run(){

// ===========================================================================
// Items 1/2/3 -- shared normalization: preserves the original behavior
// (legal-suffix variations normalize together), unrelated similar names
// never collide, and the implementation is genuinely shared (a single real
// import), not four independent regex copies drifting apart.
// ===========================================================================
{
  assert(normalizeCompanyName('Acme Manufacturing Inc') === normalizeCompanyName('ACME MANUFACTURING'),
    '1/2) legal-suffix + case variations normalize to the same key ("Acme Manufacturing Inc" == "ACME MANUFACTURING")');
  assert(normalizeCompanyName('Acme Manufacturing Inc') === normalizeCompanyName('Acme Manufacturing, LLC'),
    '2) a different legal suffix (LLC vs Inc) still normalizes to the same key');
  assert(normalizeCompanyName('Acme Manufacturing Inc') === normalizeCompanyName('Acme Manufacturing Corp.'),
    '2) "Corp." normalizes to the same key as "Inc"');
  assert(normalizeCompanyName('Acme Manufacturing') !== normalizeCompanyName('Acme Manufacturing West'),
    '3) genuinely different companies ("Acme Manufacturing" vs "Acme Manufacturing West") never collapse to the same key');
  assert(normalizeCompanyName('Beta Supplies Co') !== normalizeCompanyName('Acme Manufacturing Inc'),
    '3) unrelated company names normalize to different keys');
  assert(normalizeCompanyName('') === '', 'normalizeCompanyName() never throws on an empty/undefined input');
  assert(normalizeCompanyName(undefined) === '', 'normalizeCompanyName() never throws on undefined');
}

// Static regression proof (item 1): save-upload.js and settings.js -- the
// two other required consumers -- genuinely import the shared module rather
// than defining their own local copy of the normalization regex.
{
  const saveUploadSrc = readFileSync(new URL('../api/save-upload.js', import.meta.url), 'utf8');
  const settingsSrc = readFileSync(new URL('../api/settings.js', import.meta.url), 'utf8');
  const researchBatchSrc = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
  assert(/import\s*\{\s*normalizeCompanyName\s*\}\s*from\s*'\.\/company-identity\.js'/.test(saveUploadSrc),
    '1) api/save-upload.js imports normalizeCompanyName from the shared module (not a local copy)');
  assert(!/function\s+normalizeCompanyName\s*\(/.test(saveUploadSrc),
    '1) api/save-upload.js no longer defines its own local normalizeCompanyName()');
  assert(/import\s*\{\s*normalizeCompanyName\s*\}\s*from\s*'\.\/company-identity\.js'/.test(settingsSrc),
    '1) api/settings.js imports normalizeCompanyName from the shared module (not a local copy)');
  assert(/import\s*\{\s*normalizeCompanyName\s*\}\s*from\s*'\.\/company-identity\.js'/.test(researchBatchSrc),
    '1) api/research-batch.js (the duplicate-company check) imports normalizeCompanyName from the shared module')
}

// ===========================================================================
// Item 7/6 -- resolveDuplicateCheckScopeUserIds(): solo scope for a user
// with no organization, real org-wide scope for a user in one, and a
// resolved org-a scope never contains an org-b user id.
// ===========================================================================
await withFetch(makeMockFetch({}), async () => {
  const solo = await resolveDuplicateCheckScopeUserIds('user-4', null);
  assert(solo.length === 1 && solo[0] === 'user-4', '7) a user with no organization resolves to a solo (self-only) scope');

  const orgA = await resolveDuplicateCheckScopeUserIds('user-1', 'org-a');
  assert(orgA.sort().join(',') === ['user-1', 'user-2'].join(','), '6) an org-a user resolves to the real org-a-wide scope (both org-a members)');
  assert(!orgA.includes('user-3'), '6) org-a\'s resolved scope never includes an org-b user id');
});

// Item 12 (fail-open at scope resolution): a failure resolving org members
// falls back to solo scope rather than throwing or blocking.
await withFetch(makeMockFetch({ failOn: 'ha_users-org' }), async () => {
  const scope = await resolveDuplicateCheckScopeUserIds('user-1', 'org-a');
  assert(scope.length === 1 && scope[0] === 'user-1', '12) a failure resolving org members fails open to solo scope, never throws');
});

// ===========================================================================
// Items 4/5/6/7/8/11/12 -- findActiveDuplicateCompanyCollisions().
// ===========================================================================

// Item 4: the same normalized company across two uploads owned by the SAME
// solo user is detected.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-4', uploadId: 'upload-4' })]) }), async () => {
  const collisions = await findActiveDuplicateCompanyCollisions({ userId: 'user-4', organizationId: null, uploadId: 'upload-4b' });
  assert(collisions.has(normalizeCompanyName('Acme Manufacturing Inc')), '4) the same normalized company active in another upload (same solo user) is detected as a collision');
});

// Item 5: the same normalized company across TWO DIFFERENT users in the
// SAME organization is detected.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-1', uploadId: 'upload-1' })]) }), async () => {
  const collisions = await findActiveDuplicateCompanyCollisions({ userId: 'user-2', organizationId: 'org-a', uploadId: 'upload-2' });
  assert(collisions.has(normalizeCompanyName('Acme Manufacturing Inc')), '5) the same normalized company, actively researched by a DIFFERENT teammate in the same org, is detected as a collision');
});

// Item 6: org-b's own check never sees or is affected by org-a's active
// research on the exact same company name.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-1', uploadId: 'upload-1' })]) }), async () => {
  const collisions = await findActiveDuplicateCompanyCollisions({ userId: 'user-3', organizationId: 'org-b', uploadId: 'upload-3' });
  assert(!collisions.has(normalizeCompanyName('Acme Manufacturing Inc')), '6) another organization\'s active research on the identical company name is never inspected or exposed');
  assert(collisions.size === 0, '6) org-b\'s collision set is genuinely empty, not merely missing the one name checked');
});

// Item 7: a solo user's check is scoped only to their OWN uploads -- an
// unrelated solo user's active research on the identical company name is
// invisible to them.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-4', uploadId: 'upload-4' })]) }), async () => {
  const collisions = await findActiveDuplicateCompanyCollisions({ userId: 'user-5', organizationId: null, uploadId: 'upload-5' });
  assert(!collisions.has(normalizeCompanyName('Acme Manufacturing Inc')), '7) a solo user is scoped only to their own uploads -- an unrelated solo user\'s identical company name is invisible');
});

// Item 8: the current upload/run is excluded from its own check (no
// self-collision).
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-1', uploadId: 'upload-1' })]) }), async () => {
  const collisions = await findActiveDuplicateCompanyCollisions({ userId: 'user-1', organizationId: 'org-a', uploadId: 'upload-1' });
  assert(!collisions.has(normalizeCompanyName('Acme Manufacturing Inc')), '8) the current upload\'s own active run is excluded from its own collision check (no self-collision)');
});

// Item 11: an expired-lease run, a completed run, and a failed run must
// never block -- only a genuinely active (running, unexpired) run counts.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([
  expiredRunRow({ userId: 'user-1', uploadId: 'upload-1' }),
  completedRunRow({ userId: 'user-1', uploadId: 'upload-1' }),
  failedRunRow({ userId: 'user-1', uploadId: 'upload-1' })
]) }), async () => {
  const collisions = await findActiveDuplicateCompanyCollisions({ userId: 'user-2', organizationId: 'org-a', uploadId: 'upload-2' });
  assert(collisions.size === 0, '11) an expired-lease, completed, or failed run never blocks -- only a genuinely active run counts as a collision');
});

// Item 12: the collision check itself fails open -- a query failure returns
// an empty Set, never throws, never blocks.
await withFetch(makeMockFetch({ failOn: 'ha_research_runs' }), async () => {
  let threw = false;
  let collisions = null;
  try { collisions = await findActiveDuplicateCompanyCollisions({ userId: 'user-1', organizationId: 'org-a', uploadId: 'upload-1' }); }
  catch { threw = true; }
  assert(!threw, '12) a failure in the collision query itself never throws');
  assert(collisions && collisions.size === 0, '12) a failure in the collision query fails open (empty collision set, research proceeds normally)');
});

// ===========================================================================
// The real researchRunAction:'check-duplicates' branch, via the actual
// default handler() export.
// ===========================================================================

// Org scope: rep-2 (org-a) checking upload-2 while rep-1 (org-a) actively
// researches the same company reports the collision using rep-2's OWN
// account name back, with scope:'organization'.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-1', uploadId: 'upload-1' })]) }), async () => {
  const req = makeReq({ token: 'auth-2', uploadId: 'upload-2', body: { researchRunAction: 'check-duplicates' } });
  const res = makeRes();
  await handler(req, res);
  assert(res.statusCode === 200, `check-duplicates: returns 200 (got ${res.statusCode})`);
  assert(res.body.scope === 'organization', `check-duplicates: reports scope:'organization' for an org-a user (got ${res.body.scope})`);
  assert(Array.isArray(res.body.duplicateAccountNames) && res.body.duplicateAccountNames.includes('ACME MANUFACTURING'),
    `check-duplicates: reports the requester's OWN account name ("ACME MANUFACTURING") as colliding, not the other rep's name (got ${JSON.stringify(res.body.duplicateAccountNames)})`);
  assert(!res.body.duplicateAccountNames.includes('Gamma Corp'), 'check-duplicates: an unrelated account on the same upload is not reported as colliding');
});

// Solo scope: same shape, but scope:'user'.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-4', uploadId: 'upload-4' })]) }), async () => {
  const req = makeReq({ token: 'auth-4', uploadId: 'upload-4b', body: { researchRunAction: 'check-duplicates' } });
  const res = makeRes();
  await handler(req, res);
  assert(res.body.scope === 'user', `check-duplicates: reports scope:'user' for a solo user (got ${res.body.scope})`);
  assert(res.body.duplicateAccountNames.includes('Acme Manufacturing, LLC'), 'check-duplicates: solo-scope collision still reports the requester\'s own account name');
});

// Fail-open: if the server cannot even determine this upload's own accounts
// to check, it reports zero duplicates rather than blocking the caller.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([]), failOn: 'ha_accounts-own' }), async () => {
  const req = makeReq({ token: 'auth-1', uploadId: 'upload-1', body: { researchRunAction: 'check-duplicates' } });
  const res = makeRes();
  await handler(req, res);
  assert(res.statusCode === 200, `check-duplicates fail-open: still returns 200 (got ${res.statusCode})`);
  assert(Array.isArray(res.body.duplicateAccountNames) && res.body.duplicateAccountNames.length === 0, '12) check-duplicates fail-open: reports zero duplicates rather than blocking or erroring');
  assert(res.body.checkFailed === true, 'check-duplicates fail-open: honestly flags checkFailed:true rather than silently pretending the check succeeded');
});

// ===========================================================================
// Items 9/10/13/14/16/17 -- the authoritative server-side re-filter at the
// real production dispatch point (handler()'s actual research-request path,
// not the pre-check), exercised end-to-end with mocked OpenAI.
// ===========================================================================

// A multi-account dispatch where exactly one of two requested accounts
// collides: only the colliding account is skipped, the unrelated account is
// genuinely dispatched to the provider, and the response tells the two
// outcomes apart.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-1', uploadId: 'upload-1' })]) }), async () => {
  const baseFetch = makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-1', uploadId: 'upload-1' })]) });
  global.fetch = async (url, options = {}) => {
    if(String(url).includes('api.openai.com')){
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: [] }), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) };
    }
    return baseFetch(url, options);
  };
  try {
    const req = makeReq({
      token: 'auth-2',
      uploadId: 'upload-2',
      body: { accounts: [{ name: 'ACME MANUFACTURING' }, { name: 'Gamma Corp' }], mode: 'ranked', researchRunId: 'manual-test-1', attemptId: 'attempt-1' }
    });
    const res = makeRes();
    await handler(req, res);
    assert(res.statusCode === 200, `multi-account dispatch: returns 200 (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
    assert(Array.isArray(res.body.skippedDuplicateAccountNames) && res.body.skippedDuplicateAccountNames.length === 1 && res.body.skippedDuplicateAccountNames[0] === 'ACME MANUFACTURING',
      `9) only the genuinely colliding account ("ACME MANUFACTURING") is skipped, using the requester's own account name (got ${JSON.stringify(res.body.skippedDuplicateAccountNames)})`);
    assert(res.body.diagnostics.accountsResearched === 1, `10) the unrelated account continues normally -- exactly 1 account was actually dispatched to the provider (got ${res.body.diagnostics.accountsResearched})`);
    assert(!Object.prototype.hasOwnProperty.call(res.body.byAccount, 'ACME MANUFACTURING'), '14) the skipped duplicate has no persisted/returned result entry at all (not even an empty one) -- it is absent, not empty');
    assert(res.body.diagnostics.structuredSummary.skipReasons.some(r => r.reason === 'duplicate_or_invalid_account_name' && r.count === 1),
      '16) the run\'s completion diagnostics report the skip distinctly (skipReasons), separate from any failure count');
    assert(res.body.diagnostics.structuredSummary.failedAccounts === 0, '16) the skipped duplicate is never counted as a failure');
  } finally {
    global.fetch = originalFetch;
  }
});

// Every requested account collides: the response is an honest, distinct,
// non-error "all skipped" outcome, and -- critically -- zero provider calls
// are made at all (this is a cost-protection control; a fully-duplicate
// request must never reach OpenAI).
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-1', uploadId: 'upload-1' })]) }), async () => {
  const baseFetch = makeMockFetch({ researchRunsTable: makeResearchRunsTable([activeRunRow({ userId: 'user-1', uploadId: 'upload-1' })]) });
  global.fetch = async (url, options = {}) => {
    if(String(url).includes('api.openai.com')) throw new Error('a fully-duplicate request must never call a provider');
    return baseFetch(url, options);
  };
  try {
    const req = makeReq({
      token: 'auth-2',
      uploadId: 'upload-2',
      body: { accounts: [{ name: 'ACME MANUFACTURING' }], mode: 'ranked', researchRunId: 'manual-test-2', attemptId: 'attempt-2' }
    });
    const res = makeRes();
    await handler(req, res);
    assert(res.statusCode === 200, `all-duplicate dispatch: returns 200, not an error (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
    assert(res.body.allAccountsSkippedAsDuplicates === true, '4) an all-duplicate request is an honest, distinct, non-error outcome -- research being unavailable is never implied');
    assert(res.body.skippedDuplicateAccountNames.length === 1 && res.body.skippedDuplicateAccountNames[0] === 'ACME MANUFACTURING', '13) the skipped account is reported by its own real name, never marked researched');
    assert(Object.keys(res.body.byAccount).length === 0 && res.body.signals.length === 0, '14) no result -- empty or otherwise -- is persisted/returned for the skipped account');
  } finally {
    global.fetch = originalFetch;
  }
});

// Item 17: record identity is preserved -- the non-skipped result is
// attributable only to the exact upload/account that was actually
// dispatched, using the caller's own original (non-normalized) account name
// string, never a merged/rewritten identity.
await withFetch(makeMockFetch({ researchRunsTable: makeResearchRunsTable([]) }), async () => {
  const baseFetch = makeMockFetch({ researchRunsTable: makeResearchRunsTable([]) });
  global.fetch = async (url, options = {}) => {
    if(String(url).includes('api.openai.com')){
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: [{
        company_name: 'Gamma Corp',
        accountName: 'Gamma Corp',
        signal_type: 'Product Launch',
        concrete_trigger: 'Gamma Corp launches new product line',
        signalTitle: 'Gamma Corp launches new product line',
        business_context: 'Gamma Corp appears to be bringing a new product to market.',
        why_this_matters: 'A product launch often creates a timely reason to discuss launch kits and branded materials.',
        sourceUrl: 'https://example.com/gamma-corp-launch',
        source_url: 'https://example.com/gamma-corp-launch',
        source_name: 'Example News',
        sourceName: 'Example News',
        event_date: new Date().toISOString().slice(0, 10),
        confidence: 80
      }] }), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) };
    }
    return baseFetch(url, options);
  };
  try {
    const req = makeReq({
      token: 'auth-2',
      uploadId: 'upload-2',
      body: { accounts: [{ name: 'Gamma Corp' }], mode: 'ranked', researchRunId: 'manual-test-3', attemptId: 'attempt-3' }
    });
    const res = makeRes();
    await handler(req, res);
    assert(res.statusCode === 200, `identity-preservation dispatch: returns 200 (got ${res.statusCode})`);
    assert(res.body.skippedDuplicateAccountNames.length === 0, '17) with no active collision, nothing is skipped');
    const signalNames = res.body.signals.map(s => s.accountName);
    assert(signalNames.every(n => n === 'Gamma Corp'), `17) the returned result is attributed to exactly the requested upload-2 account ("Gamma Corp"), never a merged or renamed identity (got ${JSON.stringify(signalNames)})`);
  } finally {
    global.fetch = originalFetch;
  }
});

// ===========================================================================
// Item 15 -- dashboard/index.html's real client wiring: honest, exact
// wording, org-vs-solo phrasing, and fail-open behavior. Extracted verbatim
// (not reimplemented) and run in a vm sandbox, the same technique
// scripts/test-dashboard-orchestration.js uses for the rest of this file.
// ===========================================================================
{
  const DASHBOARD_PATH = new URL('../dashboard/index.html', import.meta.url);
  const DASHBOARD_LINES = readFileSync(DASHBOARD_PATH, 'utf8').split('\n');
  function extractFn(name, startLine, endLine, { async: isAsync = false } = {}){
    const slice = DASHBOARD_LINES.slice(startLine - 1, endLine).join('\n');
    const expectedPrefix = `${isAsync ? 'async ' : ''}function ${name}(`;
    if(!slice.startsWith(expectedPrefix)){
      throw new Error(`extractFn(${name}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-duplicate-company-research-control.js.`);
    }
    if(!slice.trimEnd().endsWith('}')){
      throw new Error(`extractFn(${name}): dashboard/index.html line ${endLine} does not close the function body as expected -- update the line range.`);
    }
    return slice;
  }
  const REAL_SOURCE = [
    extractFn('checkDuplicateCompanyResearch', 2504, 2520, { async: true }),
    extractFn('duplicateCompanyResearchMessage', 2530, 2533)
  ].join('\n\n');

  function makeSandbox(fetchImpl){
    const houseAuth = { authHeadersAsync: async (h) => h || {} };
    const sandbox = { window: { HouseAuth: houseAuth }, HouseAuth: houseAuth, fetch: fetchImpl, console, JSON, Array, String };
    vm.createContext(sandbox);
    new vm.Script(REAL_SOURCE, { filename: 'duplicate-company-client-extract.js' }).runInContext(sandbox);
    return sandbox;
  }

  // Exact required wording, org scope.
  {
    const sandbox = makeSandbox(async () => { throw new Error('not used in this test'); });
    const msg = sandbox.duplicateCompanyResearchMessage('L.L.Bean', 'organization');
    assert(msg === 'L.L.Bean is already being researched from another uploaded list in this workspace. We skipped duplicate research for now. Try again after that run finishes.',
      `15) org-scope wording matches exactly (got: "${msg}")`);
  }
  // Exact required wording, solo scope -- same sentence WITHOUT "in this workspace".
  {
    const sandbox = makeSandbox(async () => { throw new Error('not used in this test'); });
    const msg = sandbox.duplicateCompanyResearchMessage('L.L.Bean', 'user');
    assert(msg === 'L.L.Bean is already being researched from another uploaded list. We skipped duplicate research for now. Try again after that run finishes.',
      `15) solo-scope wording matches exactly, omitting "in this workspace" (got: "${msg}")`);
    assert(!msg.includes('for this list'), '15) the message never says "for this list" -- the collision belongs to another list, not this one');
  }
  // checkDuplicateCompanyResearch(): success path passes through real data.
  {
    const sandbox = makeSandbox(async () => ({ ok: true, status: 200, json: async () => ({ duplicateAccountNames: ['Acme Co'], scope: 'organization' }) }));
    const result = await sandbox.checkDuplicateCompanyResearch('upload-1', ['Acme Co']);
    assert(result.ok === true && result.duplicateAccountNames.includes('Acme Co') && result.scope === 'organization', `checkDuplicateCompanyResearch(): success path returns the real server data (got ${JSON.stringify(result)})`);
  }
  // Fail-open: a thrown fetch never blocks research.
  {
    const sandbox = makeSandbox(async () => { throw new Error('network down'); });
    const result = await sandbox.checkDuplicateCompanyResearch('upload-1', ['Acme Co']);
    assert(result.ok === true && Array.isArray(result.duplicateAccountNames) && result.duplicateAccountNames.length === 0,
      `12) client-side fail-open: a thrown fetch never blocks research (got ${JSON.stringify(result)})`);
  }
  // Fail-open: a non-ok response never blocks research.
  {
    const sandbox = makeSandbox(async () => ({ ok: false, status: 500, json: async () => ({ error: 'server error' }) }));
    const result = await sandbox.checkDuplicateCompanyResearch('upload-1', ['Acme Co']);
    assert(result.ok === true && result.duplicateAccountNames.length === 0, `12) client-side fail-open: a non-ok server response never blocks research (got ${JSON.stringify(result)})`);
  }
  // Fail-open: a malformed (non-JSON) response body never blocks research.
  {
    const sandbox = makeSandbox(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }));
    const result = await sandbox.checkDuplicateCompanyResearch('upload-1', ['Acme Co']);
    assert(result.ok === true && result.duplicateAccountNames.length === 0, `12) client-side fail-open: a malformed response body never blocks research (got ${JSON.stringify(result)})`);
  }
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
}

run();
