// Duplicate-company research control -- target-granularity correction round.
//
// Confirmed defect this round fixes: the original implementation inferred
// "companies currently being researched" by resolving another active run
// down to its upload_id, then treating EVERY account belonging to that
// upload as active -- even when the run itself only ever targeted ONE
// specific account. This overblocked unrelated accounts in the same upload.
//
// The fix: a claimed run's own exact target-company set (the normalized
// keys of the accounts it actually intends to research -- one for
// individual research, the selected subset for a list/batch) is persisted
// into ha_research_runs.result_summary (an existing jsonb column, no
// migration) at claim time, and kept current by the authoritative
// dispatch-time filter before any provider call. The collision check reads
// ONLY that stored set -- never every account belonging to the run's
// upload.
//
// This file validates the production-bound implementation (not a
// reimplementation) via mocked fetch:
//   - api/company-identity.js's normalizeCompanyName()
//   - api/research-batch.js's resolveDuplicateCheckScopeUserIds(),
//     sanitizeTargetCompanyKeys(), persistRunTargetCompanyKeys(),
//     findActiveDuplicateCompanyCollisions(), and the real
//     researchRunAction:'claim'/'check-duplicates' branches and dispatch-time
//     filter, all exercised through the actual default handler() export.
//   - dashboard/index.html's real checkDuplicateCompanyResearch(),
//     duplicateCompanyResearchMessage(), and claimAutomaticResearchRun(),
//     extracted verbatim and run in a vm sandbox.
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
  findActiveDuplicateCompanyCollisions,
  sanitizeTargetCompanyKeys
} from '../api/research-batch.js';
import { normalizeCompanyName } from '../api/company-identity.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Fixtures. Upload A belongs to user-1 (org-a) and holds ten accounts so the
// "3 of 10" scenario (item 5 / required scenario 4) is a real subset, not a
// trivial case. Upload B belongs to user-2 (org-a, same workspace as user-1)
// so cross-upload/cross-teammate detection is exercised. Upload C (org-b) is
// a different workspace entirely, for isolation proof.
// ===========================================================================
const FIXTURES = {
  users: {
    'auth-1': { id: 'user-1', email: 'rep1@org-a.com', organization_id: 'org-a' },
    'auth-2': { id: 'user-2', email: 'rep2@org-a.com', organization_id: 'org-a' },
    'auth-3': { id: 'user-3', email: 'rep1@org-b.com', organization_id: 'org-b' },
    'auth-4': { id: 'user-4', email: 'solo@example.com', organization_id: null },
    'auth-5': { id: 'user-5', email: 'solo2@example.com', organization_id: null }
  },
  orgMembers: { 'org-a': ['user-1', 'user-2'], 'org-b': ['user-3'] },
  uploads: {
    'upload-A': 'user-1',
    'upload-B': 'user-2',
    'upload-C': 'user-3',
    'upload-solo-1': 'user-4',
    'upload-solo-1b': 'user-4',
    'upload-solo-2': 'user-5'
  },
  accounts: {
    'upload-A': ['L.L.Bean', 'Nike', 'Acct3', 'Acct4', 'Acct5', 'Acct6', 'Acct7', 'Acct8', 'Acct9', 'Acct10'],
    'upload-B': ['L.L.Bean', 'Nike'],
    'upload-C': ['L.L.Bean'],
    'upload-solo-1': ['Acme Manufacturing Inc'],
    'upload-solo-1b': ['Acme Manufacturing, LLC'],
    'upload-solo-2': ['Acme Manufacturing Inc']
  }
};

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

// A real, mutable ha_research_runs table -- claim/heartbeat/PATCH all
// operate on the SAME in-memory rows a real Postgres table would, so the
// full claim -> persist-targets -> dispatch -> re-filter -> update-targets
// lifecycle can be exercised end-to-end through the real handler(), not
// stubbed piecemeal.
function makeResearchRunsTable(initialRows = []){
  const rows = [...initialRows];
  let attemptSeq = 1;
  function findExact(userId, uploadId, researchRunId){
    return rows.find(r => r.user_id === userId && r.upload_id === uploadId && r.research_run_id === researchRunId);
  }
  function otherActive(uploadId, excludeId){
    const now = Date.now();
    return rows.find(r => r.upload_id === uploadId && r.id !== excludeId && r.status === 'running' && new Date(r.lease_expires_at).getTime() > now);
  }
  return {
    rows,
    async fetch(url, options = {}){
      const u = String(url);
      const method = options.method || 'GET';

      if(u.includes('/auth/v1/user')){
        const token = String((options.headers || {}).Authorization || '').replace(/^Bearer\s+/i, '');
        const authId = token.replace(/^token-/, '');
        return FIXTURES.users[authId] ? jsonResponse({ id: authId }) : jsonResponse({ error: 'invalid token' }, false, 401);
      }
      if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')){
        const authId = decodeURIComponent(u.split('auth_user_id=eq.')[1].split('&')[0]);
        const user = FIXTURES.users[authId];
        return jsonResponse(user ? [{ id: user.id, email: user.email, organization_id: user.organization_id }] : []);
      }
      if(u.includes('/rest/v1/ha_users?organization_id=eq.')){
        const orgId = decodeURIComponent(u.split('organization_id=eq.')[1].split('&')[0]);
        return jsonResponse((FIXTURES.orgMembers[orgId] || []).map(id => ({ id })));
      }
      if(u.includes('/rest/v1/ha_uploads?id=eq.')){
        const uploadId = decodeURIComponent(u.split('id=eq.')[1].split('&')[0]);
        const ownerId = FIXTURES.uploads[uploadId];
        return jsonResponse(ownerId ? [{ id: uploadId, user_id: ownerId }] : []);
      }
      if(u.includes('/rest/v1/ha_accounts?upload_id=eq.')){
        const uploadId = decodeURIComponent(u.split('upload_id=eq.')[1].split('&')[0]);
        return jsonResponse((FIXTURES.accounts[uploadId] || []).map(name => ({ account_name: name })));
      }
      if(u.includes('/rest/v1/rpc/claim_ha_research_run') && method === 'POST'){
        const body = JSON.parse(options.body);
        const { p_user_id: userId, p_upload_id: uploadId, p_research_run_id: researchRunId, p_lease_seconds: leaseSeconds = 300 } = body;
        const existing = findExact(userId, uploadId, researchRunId);
        const now = Date.now();
        if(existing){
          if(existing.status === 'completed') return jsonResponse({ outcome: 'completed', run: existing });
          if(existing.status === 'running' && new Date(existing.lease_expires_at).getTime() > now) return jsonResponse({ outcome: 'attached-active', run: existing });
          const other = otherActive(uploadId, existing.id);
          if(other) return jsonResponse({ message: 'a different research run is already in progress', code: '55P03' }, false, 400);
          const wasFailed = existing.status === 'failed';
          existing.status = 'running';
          existing.attempt_id = `attempt-${attemptSeq++}`;
          existing.lease_expires_at = new Date(now + leaseSeconds * 1000).toISOString();
          existing.completed_at = null;
          existing.error_message = null;
          // Deliberately NOT reset here -- mirrors the real RPC (see
          // supabase-schema.sql's claim_ha_research_run reclaim UPDATE,
          // which never touches result_summary). Stale target_company_keys
          // from a prior attempt on this row must be overwritten by the
          // application-level persistRunTargetCompanyKeys() write that
          // follows a successful claim, not by the RPC itself -- this is
          // exactly the "new attempt must not inherit stale targets"
          // requirement, and this fixture is what lets that be proven
          // end-to-end rather than assumed.
          return jsonResponse({ outcome: wasFailed ? 'reclaimed-after-failure' : 'reclaimed-after-expired-lease', run: existing });
        }
        const other = otherActive(uploadId, null);
        if(other) return jsonResponse({ message: 'a different research run is already in progress', code: '55P03' }, false, 400);
        const row = {
          id: `row-${rows.length + 1}`,
          user_id: userId, upload_id: uploadId, research_run_id: researchRunId,
          status: 'running', attempt_id: `attempt-${attemptSeq++}`, attempt_count: 1,
          lease_expires_at: new Date(now + leaseSeconds * 1000).toISOString(),
          result_summary: {}
        };
        rows.push(row);
        return jsonResponse({ outcome: 'claimed-new', run: row });
      }
      if(u.includes('/rest/v1/rpc/heartbeat_ha_research_run') && method === 'POST'){
        const body = JSON.parse(options.body);
        const row = findExact(body.p_user_id, body.p_upload_id, body.p_research_run_id);
        const now = Date.now();
        if(!row || row.status !== 'running' || row.attempt_id !== body.p_attempt_id || new Date(row.lease_expires_at).getTime() <= now){
          return jsonResponse({ ok: false, reason: 'not-current-attempt' });
        }
        row.lease_expires_at = new Date(now + (body.p_lease_seconds || 300) * 1000).toISOString();
        return jsonResponse({ ok: true, run: row });
      }
      if(u.includes('/rest/v1/ha_research_runs') && method === 'PATCH'){
        const params = new URLSearchParams(u.split('?')[1]);
        const userId = decodeURIComponent((params.get('user_id') || '').replace('eq.', ''));
        const uploadId = decodeURIComponent((params.get('upload_id') || '').replace('eq.', ''));
        const researchRunId = decodeURIComponent((params.get('research_run_id') || '').replace('eq.', ''));
        const attemptId = decodeURIComponent((params.get('attempt_id') || '').replace('eq.', ''));
        const status = decodeURIComponent((params.get('status') || '').replace('eq.', ''));
        const row = rows.find(r => r.user_id === userId && r.upload_id === uploadId && r.research_run_id === researchRunId && r.attempt_id === attemptId && r.status === status);
        if(!row) return jsonResponse([]);
        const patch = JSON.parse(options.body);
        Object.assign(row, patch);
        return jsonResponse([row]);
      }
      if(u.includes('/rest/v1/ha_research_runs') && (!method || method === 'GET')){
        const params = new URLSearchParams(u.split('?')[1]);
        const userFilter = params.get('user_id') || '';
        const excludeUploadId = (params.get('upload_id') || '').replace(/^neq\./, '');
        const scopeIds = userFilter.startsWith('in.(') ? userFilter.slice(4, -1).split(',').map(decodeURIComponent) : [];
        const now = Date.now();
        const matched = rows.filter(r => scopeIds.includes(r.user_id) && r.upload_id !== excludeUploadId && r.status === 'running' && new Date(r.lease_expires_at).getTime() > now);
        return jsonResponse(matched.map(r => ({ upload_id: r.upload_id, result_summary: r.result_summary })));
      }
      if(u.includes('api.openai.com')){
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ signals: [] }), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) };
      }
      throw new Error(`Unhandled mock fetch URL: ${u} (${method})`);
    }
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

async function claimAction(table, { token, uploadId, targetAccountNames, runIntent = 'manual-rerun', researchRunIdOverride }){
  return withFetch(table.fetch.bind(table), async () => {
    const req = makeReq({ token, uploadId, body: { researchRunAction: 'claim', runIntent, targetAccountNames } });
    const res = makeRes();
    await handler(req, res);
    return res;
  });
}

async function checkDuplicatesAction(table, { token, uploadId, accountNames }){
  return withFetch(table.fetch.bind(table), async () => {
    const req = makeReq({ token, uploadId, body: { researchRunAction: 'check-duplicates', accountNames } });
    const res = makeRes();
    await handler(req, res);
    return res;
  });
}

async function dispatchResearch(table, { token, uploadId, accounts, researchRunId, attemptId }){
  return withFetch(table.fetch.bind(table), async () => {
    const req = makeReq({ token, uploadId, body: { accounts, mode: 'ranked', researchRunId, attemptId } });
    const res = makeRes();
    await handler(req, res);
    return res;
  });
}

async function run(){

// ===========================================================================
// normalizeCompanyName + shared-module regression proof (items 1/2/3/16 --
// unaffected by this round; carried forward to confirm the correction did
// not touch normalization).
// ===========================================================================
{
  assert(normalizeCompanyName('Acme Manufacturing Inc') === normalizeCompanyName('ACME MANUFACTURING'), '2) legal-suffix + case variations normalize to the same key');
  assert(normalizeCompanyName('Acme Manufacturing Inc') === normalizeCompanyName('Acme Manufacturing, LLC'), '2) a different legal suffix (LLC vs Inc) still normalizes to the same key');
  assert(normalizeCompanyName('Nike') !== normalizeCompanyName('L.L.Bean'), '3) genuinely different companies never collapse to the same key');
  assert(normalizeCompanyName('') === '' && normalizeCompanyName(undefined) === '', 'normalizeCompanyName() never throws on empty/undefined input');
  const saveUploadSrc = readFileSync(new URL('../api/save-upload.js', import.meta.url), 'utf8');
  const settingsSrc = readFileSync(new URL('../api/settings.js', import.meta.url), 'utf8');
  const researchBatchSrc = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
  assert(/import\s*\{\s*normalizeCompanyName\s*\}\s*from\s*'\.\/company-identity\.js'/.test(saveUploadSrc) && !/function\s+normalizeCompanyName\s*\(/.test(saveUploadSrc), '16) api/save-upload.js still imports the shared normalizeCompanyName(), no local copy -- free-plan company counting is unaffected by this round');
  assert(/import\s*\{\s*normalizeCompanyName\s*\}\s*from\s*'\.\/company-identity\.js'/.test(settingsSrc), '16) api/settings.js still imports the shared normalizeCompanyName() -- organization usage/account-limit enforcement is unaffected by this round');
  assert(/import\s*\{\s*normalizeCompanyName\s*\}\s*from\s*'\.\/company-identity\.js'/.test(researchBatchSrc), '16) api/research-batch.js still imports the shared normalizeCompanyName() for the duplicate-company check itself');
  assert(!/fuzzy|levenshtein|similarity|soundex/i.test(researchBatchSrc.slice(researchBatchSrc.indexOf('findActiveDuplicateCompanyCollisions'), researchBatchSrc.indexOf('findActiveDuplicateCompanyCollisions') + 3000)), '16) no fuzzy/similarity matching was introduced -- exact normalized-key comparison only');
}

// ===========================================================================
// sanitizeTargetCompanyKeys() -- item 6: array-only, strings-only, server
// re-normalization (never trusts a client-supplied normalized value),
// empty-value removal, deduplication, count limits.
// ===========================================================================
{
  assert(JSON.stringify(sanitizeTargetCompanyKeys(['Nike', 'NIKE', 'Nike Inc.'])) === JSON.stringify(['nike']), '6) sanitizeTargetCompanyKeys() re-normalizes and deduplicates case/suffix variants of the same company down to one key');
  assert(JSON.stringify(sanitizeTargetCompanyKeys(['L.L.Bean', 'Nike'])) === JSON.stringify(['l l bean', 'nike']), '6) sanitizeTargetCompanyKeys() normalizes multiple distinct company names correctly');
  assert(sanitizeTargetCompanyKeys('not an array').length === 0, '6) a non-array input is rejected -- returns empty, never throws');
  assert(sanitizeTargetCompanyKeys([123, null, undefined, {}, ['nested'], 'Nike']).length === 1, '6) non-string entries are dropped -- only the one real string survives');
  assert(sanitizeTargetCompanyKeys(['', '   ', 'Nike']).length === 1, '6) empty/whitespace-only entries are dropped');
  assert(sanitizeTargetCompanyKeys(['already normalized key', 'ALREADY NORMALIZED KEY, Inc.']).length === 1, '6) even an already-normalized-looking client value is re-normalized server-side, never trusted as-is, and still collapses correctly with a raw variant');
  const oversized = Array.from({ length: 800 }, (_, i) => `Company ${i}`);
  assert(sanitizeTargetCompanyKeys(oversized).length <= 500, '6) an oversized input is capped at a reasonable count limit');
  assert(sanitizeTargetCompanyKeys(['x'.repeat(400)]).length === 0, '6) an unreasonably long single entry is rejected by the defensive length bound');
}

// ===========================================================================
// resolveDuplicateCheckScopeUserIds -- unaffected by this round, carried
// forward (items 14/15).
// ===========================================================================
{
  const table = makeResearchRunsTable();
  await withFetch(table.fetch.bind(table), async () => {
    const solo = await resolveDuplicateCheckScopeUserIds('user-4', null);
    assert(solo.length === 1 && solo[0] === 'user-4', '15) a user with no organization resolves to solo scope');
    const orgA = await resolveDuplicateCheckScopeUserIds('user-1', 'org-a');
    assert(orgA.sort().join(',') === 'user-1,user-2' && !orgA.includes('user-3'), '14) org-a resolves to its real member scope and never includes an org-b user id');
  });
}

// ===========================================================================
// Required scenario 1: individual research targets Nike ONLY in Upload A
// (which also contains L.L.Bean). Upload B's L.L.Bean must proceed; only
// Nike is considered active from Upload A. This is the exact defect the
// review confirmed and this round corrects.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  const claim = await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['Nike'] });
  assert(claim.statusCode === 200 && claim.body.outcome === 'claimed-new', `scenario 1 setup: individual Nike claim in Upload A succeeds (got ${claim.statusCode}, ${JSON.stringify(claim.body)})`);

  const checkLLBean = await checkDuplicatesAction(table, { token: 'auth-2', uploadId: 'upload-B', accountNames: ['L.L.Bean'] });
  assert(!checkLLBean.body.duplicateAccountNames.includes('L.L.Bean'), 'scenario 1: L.L.Bean in Upload B proceeds -- it is NOT reported as a duplicate merely because it exists in Upload A while a Nike-only run is active there (the confirmed overblocking defect)');

  const checkNike = await checkDuplicatesAction(table, { token: 'auth-2', uploadId: 'upload-B', accountNames: ['Nike'] });
  assert(checkNike.body.duplicateAccountNames.includes('Nike'), 'scenario 1: Nike in Upload B IS correctly blocked -- it is the one company genuinely active in Upload A');

  const collisions = await withFetch(table.fetch.bind(table), () => findActiveDuplicateCompanyCollisions({ userId: 'user-2', organizationId: 'org-a', uploadId: 'upload-B' }));
  assert(collisions.size === 1 && collisions.has('nike'), `scenario 1: only Nike is considered active from Upload A -- the collision set contains exactly one entry (got ${JSON.stringify([...collisions])})`);
}

// ===========================================================================
// Required scenario 2: list-level research targets both L.L.Bean and Nike
// in Upload A. Upload B's L.L.Bean must be skipped.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['L.L.Bean', 'Nike'] });
  const check = await checkDuplicatesAction(table, { token: 'auth-2', uploadId: 'upload-B', accountNames: ['L.L.Bean'] });
  assert(check.body.duplicateAccountNames.includes('L.L.Bean'), 'scenario 2: L.L.Bean in Upload B is skipped -- it is genuinely active as part of Upload A\'s list-level run');
}

// ===========================================================================
// Required scenario 3: list-level research in Upload A selects Nike ONLY
// because L.L.Bean is paused/excluded (i.e. the client never included it in
// targetAccountNames at claim time, exactly like researchListFromManageModal()
// filtering paused accounts out of researchableAccounts before claiming).
// Upload B's L.L.Bean must proceed.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['Nike'] });
  const check = await checkDuplicatesAction(table, { token: 'auth-2', uploadId: 'upload-B', accountNames: ['L.L.Bean'] });
  assert(!check.body.duplicateAccountNames.includes('L.L.Bean'), '4) scenario 3: a paused/excluded account (never part of the claimed target set) is not placed in the active target set, and does not block elsewhere');
}

// ===========================================================================
// Required scenario 4: Upload A has ten accounts; the batch explicitly
// targets three. Only those three are active -- one of the other seven must
// not be blocked elsewhere.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  const claim = await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['Acct3', 'Acct4', 'Acct5'] });
  assert(claim.statusCode === 200, `scenario 4 setup: batch claim of 3 of 10 succeeds (got ${claim.statusCode})`);
  const collisions = await withFetch(table.fetch.bind(table), () => findActiveDuplicateCompanyCollisions({ userId: 'user-2', organizationId: 'org-a', uploadId: 'upload-B' }));
  assert(collisions.size === 3 && collisions.has('acct3') && collisions.has('acct4') && collisions.has('acct5'), `5) scenario 4: exactly the 3 explicitly-requested accounts are active (got ${JSON.stringify([...collisions])})`);
  assert(!collisions.has('acct6') && !collisions.has('l l bean') && !collisions.has('nike'), '5) scenario 4: none of the other 7 accounts in Upload A (including L.L.Bean/Nike, unrelated to this batch) are treated as active');
}

// ===========================================================================
// Item 7: the claim action stores target keys BEFORE returning success --
// verified by inspecting the in-memory row's own result_summary directly
// right after a successful claim response.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  const claim = await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['Nike', 'NIKE Inc.'] });
  const row = table.rows.find(r => r.upload_id === 'upload-A' && r.research_run_id === claim.body.researchRunId);
  assert(!!row, '7) the claimed row exists in the store');
  assert(Array.isArray(row.result_summary.target_company_keys) && row.result_summary.target_company_keys.length === 1 && row.result_summary.target_company_keys[0] === 'nike', `7) the claim action persisted the sanitized, deduplicated target key set into result_summary before returning success (got ${JSON.stringify(row.result_summary)})`);
  assert(row.result_summary.target_account_count === 1 && row.result_summary.target_scope_version === 1, '7) result_summary carries the documented target_account_count/target_scope_version shape');
}

// ===========================================================================
// Item 8: target metadata writes are guarded by attempt_id + status=running
// -- a write against a superseded attempt matches zero rows and fails open
// (does not throw, claim/dispatch still succeeds).
// ===========================================================================
{
  const table = makeResearchRunsTable([
    { id: 'row-x', user_id: 'user-1', upload_id: 'upload-A', research_run_id: 'manual-1', status: 'completed', attempt_id: 'attempt-old', lease_expires_at: new Date(Date.now() - 1000).toISOString(), result_summary: {} }
  ]);
  // A claim for a DIFFERENT research_run_id succeeds normally even though an
  // unrelated completed row exists -- proves the guarded write only ever
  // touches the exact row/attempt it targets, never a stray match.
  const claim = await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['Nike'] });
  assert(claim.statusCode === 200, `8) a claim proceeds normally alongside an unrelated completed row (got ${claim.statusCode})`);
  const newRow = table.rows.find(r => r.status === 'running');
  assert(newRow && newRow.result_summary.target_company_keys.includes('nike'), '8) the new attempt\'s own target metadata was written, guarded correctly to its own row');
}

// ===========================================================================
// Item 13: a new attempt on a reused run row must not inherit stale
// target_company_keys from a prior attempt. Simulated by claiming Nike,
// letting the lease expire (simulating failure/expiry), then reclaiming
// with a DIFFERENT target (L.L.Bean only) -- the stale 'nike' key must be
// completely gone afterward, not merged.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  // runIntent:'auto' is used for BOTH claims -- it always resolves to the
  // same fixed research_run_id ('auto') for a given upload, which is the
  // only way two claims land on the exact same row (a fresh 'manual-rerun'
  // always mints a brand-new id/row by design, see claimAutomaticResearchRun()'s
  // own docs). Reusing the same row is required to prove stale-target
  // non-inheritance on a genuine reclaim, not just on two unrelated rows.
  await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['Nike'], runIntent: 'auto' });
  const row = table.rows[0];
  assert(row.result_summary.target_company_keys.includes('nike'), '13) sanity: the first attempt\'s target is recorded as nike');
  row.lease_expires_at = new Date(Date.now() - 1000).toISOString(); // simulate expiry, making it reclaimable
  const reclaim = await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['L.L.Bean'], runIntent: 'auto' });
  assert(reclaim.statusCode === 200 && reclaim.body.outcome === 'reclaimed-after-expired-lease', `13) the second claim genuinely reclaims the expired row (got ${JSON.stringify(reclaim.body)})`);
  assert(!row.result_summary.target_company_keys.includes('nike'), '13) the reclaimed attempt\'s target set no longer contains the PRIOR attempt\'s stale key (nike)');
  assert(row.result_summary.target_company_keys.includes('l l bean'), '13) the reclaimed attempt\'s target set reflects only its OWN new target (L.L.Bean)');
}

// ===========================================================================
// Item 11: a row with missing/malformed target metadata (e.g. its claim-time
// write failed, or an old row predating this round) contributes ZERO
// collisions -- and, critically, is never used as a signal to fall back to
// querying that upload's full account list. Upload A here has ten real
// accounts in ha_accounts, but its active run's result_summary carries no
// target_company_keys at all.
// ===========================================================================
{
  const table = makeResearchRunsTable([
    { id: 'row-1', user_id: 'user-1', upload_id: 'upload-A', research_run_id: 'auto', status: 'running', attempt_id: 'attempt-1', lease_expires_at: new Date(Date.now() + 300000).toISOString(), result_summary: {} }
  ]);
  const collisions = await withFetch(table.fetch.bind(table), () => findActiveDuplicateCompanyCollisions({ userId: 'user-2', organizationId: 'org-a', uploadId: 'upload-B' }));
  assert(collisions.size === 0, `11) missing target metadata on an active run contributes zero collisions -- it is never used to infer "every account in that upload" (got ${JSON.stringify([...collisions])}, would be 10 entries under the old, confirmed-defective behavior)`);

  const malformedTable = makeResearchRunsTable([
    { id: 'row-1', user_id: 'user-1', upload_id: 'upload-A', research_run_id: 'auto', status: 'running', attempt_id: 'attempt-1', lease_expires_at: new Date(Date.now() + 300000).toISOString(), result_summary: { target_company_keys: 'not-an-array' } }
  ]);
  const collisions2 = await withFetch(malformedTable.fetch.bind(malformedTable), () => findActiveDuplicateCompanyCollisions({ userId: 'user-2', organizationId: 'org-a', uploadId: 'upload-B' }));
  assert(collisions2.size === 0, '11) malformed (non-array) target_company_keys is also ignored, not coerced or fallen back from');
}

// ===========================================================================
// Item 12: completed, failed, and expired-lease runs never block -- carried
// forward, now against the target-key-based query shape.
// ===========================================================================
{
  const now = Date.now();
  const table = makeResearchRunsTable([
    { id: 'r1', user_id: 'user-1', upload_id: 'upload-A', research_run_id: 'a', status: 'completed', attempt_id: 'x1', lease_expires_at: new Date(now - 1000).toISOString(), result_summary: { target_company_keys: ['nike'] } },
    { id: 'r2', user_id: 'user-1', upload_id: 'upload-A', research_run_id: 'b', status: 'failed', attempt_id: 'x2', lease_expires_at: new Date(now - 1000).toISOString(), result_summary: { target_company_keys: ['nike'] } },
    { id: 'r3', user_id: 'user-1', upload_id: 'upload-A', research_run_id: 'c', status: 'running', attempt_id: 'x3', lease_expires_at: new Date(now - 1000).toISOString(), result_summary: { target_company_keys: ['nike'] } }
  ]);
  const collisions = await withFetch(table.fetch.bind(table), () => findActiveDuplicateCompanyCollisions({ userId: 'user-2', organizationId: 'org-a', uploadId: 'upload-B' }));
  assert(collisions.size === 0, '12) completed, failed, and expired-lease runs never block, even when they carry real target metadata');
}

// ===========================================================================
// Item 14/6: another organization's active, fully-targeted run is never
// inspected or exposed, even for the identical company name.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['L.L.Bean'] });
  const check = await checkDuplicatesAction(table, { token: 'auth-3', uploadId: 'upload-C', accountNames: ['L.L.Bean'] });
  assert(!check.body.duplicateAccountNames.includes('L.L.Bean'), '14) org-b never sees org-a\'s active research, even for the identical company name');
}

// ===========================================================================
// Item 15: solo-user scope remains correct.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  await claimAction(table, { token: 'auth-4', uploadId: 'upload-solo-1', targetAccountNames: ['Acme Manufacturing Inc'] });
  const ownCheck = await checkDuplicatesAction(table, { token: 'auth-4', uploadId: 'upload-solo-1b', accountNames: ['Acme Manufacturing, LLC'] });
  assert(ownCheck.body.duplicateAccountNames.includes('Acme Manufacturing, LLC'), '15) a solo user\'s own second upload is correctly blocked for the same normalized company');
  const otherSoloCheck = await checkDuplicatesAction(table, { token: 'auth-5', uploadId: 'upload-solo-2', accountNames: ['Acme Manufacturing Inc'] });
  assert(!otherSoloCheck.body.duplicateAccountNames.includes('Acme Manufacturing Inc'), '15) an unrelated solo user is unaffected -- solo scope never leaks across users');
}

// ===========================================================================
// Item 9: dispatch-time authoritative filtering updates the stored target
// set to the FINAL researchable companies -- if the server-side re-check
// removes a colliding account from the request, the run's own stored
// targets shrink to match, so it stops blocking that company elsewhere.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  // Upload A's run originally claims Nike + L.L.Bean...
  const claim = await claimAction(table, { token: 'auth-1', uploadId: 'upload-A', targetAccountNames: ['Nike', 'L.L.Bean'] });
  // ...but a DIFFERENT, already-active run elsewhere in the SAME workspace
  // (upload-B, same org) is genuinely researching L.L.Bean first, so when
  // upload-A's own dispatch call actually goes out, the authoritative
  // server-side re-filter must drop L.L.Bean from what upload-A really
  // researches.
  table.rows.push({ id: 'row-b', user_id: 'user-2', upload_id: 'upload-B', research_run_id: 'auto', status: 'running', attempt_id: 'attempt-b', lease_expires_at: new Date(Date.now() + 300000).toISOString(), result_summary: { target_company_keys: ['l l bean'] } });

  const dispatch = await dispatchResearch(table, {
    token: 'auth-1', uploadId: 'upload-A',
    accounts: [{ name: 'Nike' }, { name: 'L.L.Bean' }],
    researchRunId: claim.body.researchRunId, attemptId: claim.body.attemptId
  });
  assert(dispatch.statusCode === 200, `9) dispatch succeeds (got ${dispatch.statusCode}, ${JSON.stringify(dispatch.body)})`);
  assert(dispatch.body.skippedDuplicateAccountNames.includes('L.L.Bean') && !dispatch.body.skippedDuplicateAccountNames.includes('Nike'), '9) the authoritative dispatch-time re-check skips only the genuinely colliding account (L.L.Bean), Nike proceeds');

  const uploadARow = table.rows.find(r => r.upload_id === 'upload-A' && r.status === 'running');
  assert(Array.isArray(uploadARow.result_summary.target_company_keys) && uploadARow.result_summary.target_company_keys.length === 1 && uploadARow.result_summary.target_company_keys[0] === 'nike', `9) after dispatch-time filtering, Upload A's own stored target set was updated to reflect only what it will actually research (Nike) -- L.L.Bean is no longer part of it (got ${JSON.stringify(uploadARow.result_summary.target_company_keys)})`);

  // A third upload can now research L.L.Bean once Upload B's run releases it
  // -- prove Upload A no longer blocks it, since Upload A never actually
  // researched it.
  table.rows = table.rows.filter(r => r.upload_id !== 'upload-B');
  const followupCheck = await checkDuplicatesAction(table, { token: 'auth-3', uploadId: 'upload-C', accountNames: ['L.L.Bean'] });
  assert(!followupCheck.body.duplicateAccountNames.includes('L.L.Bean'), '9) Upload A no longer blocks L.L.Bean anywhere, since it never actually held it as a target after the update');
}

// ===========================================================================
// Item 10: a fully-skipped dispatch (every requested account collides)
// stores an empty target set, never calls a provider, and returns the
// honest structured skip result.
// ===========================================================================
{
  const table = makeResearchRunsTable();
  const claim = await claimAction(table, { token: 'auth-2', uploadId: 'upload-B', targetAccountNames: ['L.L.Bean'] });
  table.rows.push({ id: 'row-a', user_id: 'user-1', upload_id: 'upload-A', research_run_id: 'auto', status: 'running', attempt_id: 'attempt-a', lease_expires_at: new Date(Date.now() + 300000).toISOString(), result_summary: { target_company_keys: ['l l bean'] } });

  const originalFetchForTable = table.fetch.bind(table);
  let openaiWasCalled = false;
  const guardedFetch = async (url, options = {}) => {
    if(String(url).includes('api.openai.com')){ openaiWasCalled = true; }
    return originalFetchForTable(url, options);
  };
  const dispatch = await withFetch(guardedFetch, async () => {
    const req = makeReq({ token: 'auth-2', uploadId: 'upload-B', body: { accounts: [{ name: 'L.L.Bean' }], mode: 'ranked', researchRunId: claim.body.researchRunId, attemptId: claim.body.attemptId } });
    const res = makeRes();
    await handler(req, res);
    return res;
  });

  assert(dispatch.statusCode === 200 && dispatch.body.allAccountsSkippedAsDuplicates === true, `10) a fully-duplicate dispatch is an honest 200, not an error (got ${dispatch.statusCode}, ${JSON.stringify(dispatch.body)})`);
  assert(!openaiWasCalled, '10) no provider call was made for a fully-duplicate dispatch');
  const uploadBRow = table.rows.find(r => r.upload_id === 'upload-B' && r.status === 'running');
  assert(Array.isArray(uploadBRow.result_summary.target_company_keys) && uploadBRow.result_summary.target_company_keys.length === 0, `10) the stored target set was updated to an explicit empty array, releasing the block entirely (got ${JSON.stringify(uploadBRow.result_summary.target_company_keys)})`);
}

// ===========================================================================
// Client wiring: claimAutomaticResearchRun() sends targetAccountNames;
// checkDuplicateCompanyResearch()/duplicateCompanyResearchMessage() wording
// and fail-open behavior (unaffected by this round, carried forward).
// ===========================================================================
{
  const DASHBOARD_LINES = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8').split('\n');
  function extractFn(name, startLine, endLine, { async: isAsync = false } = {}){
    const slice = DASHBOARD_LINES.slice(startLine - 1, endLine).join('\n');
    const expectedPrefix = `${isAsync ? 'async ' : ''}function ${name}(`;
    if(!slice.startsWith(expectedPrefix)) throw new Error(`extractFn(${name}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range.`);
    if(!slice.trimEnd().endsWith('}')) throw new Error(`extractFn(${name}): dashboard/index.html line ${endLine} does not close the function body as expected -- update the line range.`);
    return slice;
  }
  const REAL_SOURCE = [
    extractFn('claimAutomaticResearchRun', 2482, 2492, { async: true }),
    extractFn('checkDuplicateCompanyResearch', 2506, 2522, { async: true }),
    extractFn('duplicateCompanyResearchMessage', 2532, 2535)
  ].join('\n\n');

  function makeSandbox(fetchImpl, houseAuthOverride){
    const houseAuth = houseAuthOverride || { authHeadersAsync: async (h) => h || {} };
    const sandbox = { window: { HouseAuth: houseAuth, currentUploadId: 'fallback-upload' }, HouseAuth: houseAuth, fetch: fetchImpl, console, JSON, Array, String };
    vm.createContext(sandbox);
    new vm.Script(REAL_SOURCE, { filename: 'duplicate-company-client-extract.js' }).runInContext(sandbox);
    return sandbox;
  }

  let capturedBody = null;
  const sandbox = makeSandbox(async (url, options) => { capturedBody = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ ok: true, outcome: 'claimed-new', researchRunId: 'r1', attemptId: 'a1' }) }; });
  await sandbox.claimAutomaticResearchRun('manual-rerun', 'upload-A', ['Nike', 'L.L.Bean']);
  assert(capturedBody && capturedBody.researchRunAction === 'claim' && Array.isArray(capturedBody.targetAccountNames) && capturedBody.targetAccountNames.join(',') === 'Nike,L.L.Bean', `7) the real claimAutomaticResearchRun() sends targetAccountNames as part of the claim request body (got ${JSON.stringify(capturedBody)})`);

  const sandbox2 = makeSandbox(async (url, options) => { capturedBody = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ ok: true, outcome: 'claimed-new', researchRunId: 'r1', attemptId: 'a1' }) }; });
  await sandbox2.claimAutomaticResearchRun('manual-rerun', 'upload-A');
  assert(capturedBody.targetAccountNames === undefined, 'claimAutomaticResearchRun() omits targetAccountNames entirely (not an empty array) when no target list is supplied -- distinguishable from "explicitly zero targets"');

  const wordingSandbox = makeSandbox(async () => { throw new Error('unused'); });
  assert(wordingSandbox.duplicateCompanyResearchMessage('L.L.Bean', 'organization') === 'L.L.Bean is already being researched from another uploaded list in this workspace. We skipped duplicate research for now. Try again after that run finishes.', '15) org-scope wording matches exactly');
  assert(wordingSandbox.duplicateCompanyResearchMessage('L.L.Bean', 'user') === 'L.L.Bean is already being researched from another uploaded list. We skipped duplicate research for now. Try again after that run finishes.', '15) solo-scope wording matches exactly, omitting "in this workspace"');

  const failOpenSandbox = makeSandbox(async () => { throw new Error('network down'); });
  const failResult = await failOpenSandbox.checkDuplicateCompanyResearch('upload-A', ['Nike']);
  assert(failResult.ok === true && failResult.duplicateAccountNames.length === 0, '12) client-side checkDuplicateCompanyResearch() fails open on a thrown fetch');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
}

run();
