// Billing-count correction (final round): api/weekly-scan.js's per-account
// eligibility filter has always checked accountPayload(row).monitoringStatus,
// but accountPayload() never actually set that field -- the real per-account
// pause flag api/monitoring-lists.js's pause-account action writes lives at
// ha_accounts.raw_data.monitoring_status (snake_case). The filter was a
// permanent no-op: an individually-paused account was still re-researched
// every week. Fixed by having accountPayload() read the real field. This
// proves the fix end-to-end through the REAL exported handler (mocked
// Supabase + research-batch fetch), not a source-text pattern match --
// same integration-test convention scripts/test-weekly-scan-reliability.js
// already uses.
//
// Usage: node scripts/test-weekly-scan-account-pause.js
import handler, { accountPayload } from '../api/weekly-scan.js';

const TEST_CRON_SECRET = 'test-cron-secret-do-not-log-1234567890';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function makeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// --- accountPayload(): the real field mapping, in isolation -------------
assert(accountPayload({ account_name: 'Acme', raw_data: {} }).monitoringStatus === 'active', 'accountPayload() defaults monitoringStatus to "active" when raw_data.monitoring_status is absent');
assert(accountPayload({ account_name: 'Acme', raw_data: { monitoring_status: 'paused' } }).monitoringStatus === 'paused', 'REQUIRED: accountPayload() reads the REAL raw_data.monitoring_status field (paused)');
assert(accountPayload({ account_name: 'Acme', raw_data: { monitoring_status: 'active' } }).monitoringStatus === 'active', 'accountPayload() reads an explicit "active" monitoring_status correctly (the resumed-account case)');

// --- End-to-end through the real handler: which accounts actually get ---
// sent to /api/research-batch for weekly re-research.
async function runScenario(accounts){
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  delete process.env.RESEND_API_KEY;
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE;

  const uploadId = 'upload-1', userId = 'user-1';
  const uploadRow = { id: uploadId, user_id: userId, upload_name: 'Test List', summary: {}, created_at: new Date().toISOString(), ha_users: { id: userId, email: 'test@example.com', name: 'Test User', company: '' } };
  let researchBatchCallAccounts = null;
  let runIdCounter = 0;
  const staleServed = { done: false };

  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if(u.includes('/rest/v1/ha_uploads') && method === 'GET') return jsonResponse([uploadRow]);
    if(u.includes('/rest/v1/ha_accounts')) return jsonResponse(accounts);
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'GET' && u.includes('limit=1')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'GET'){
      if(!staleServed.done){ staleServed.done = true; return jsonResponse([]); }
      return jsonResponse([]);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'POST'){
      runIdCounter += 1;
      const body = JSON.parse(options.body)[0];
      return jsonResponse([{ id: `run-${runIdCounter}`, ...body }]);
    }
    if(u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH') return jsonResponse([{ id: 'run-1' }]);
    if(u.includes('/rest/v1/ha_signals') && method === 'POST') return jsonResponse([]);
    if(u.includes('/api/research-batch')){
      const body = JSON.parse(options.body);
      researchBatchCallAccounts = body.accounts || [];
      return jsonResponse({ signals: [], byAccount: {} });
    }
    if(u.includes('/rest/v1/ha_monitoring_targets')) return jsonResponse([]);
    throw new Error(`Unhandled fetch in test mock: ${method} ${u}`);
  };

  const req = { method: 'GET', headers: { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` }, query: { limit: '25' } };
  const res = makeRes();
  try{ await handler(req, res); } finally { global.fetch = realFetch; }
  return { res, researchedNames: (researchBatchCallAccounts || []).map(a => a.name) };
}

function accountRow(name, monitoringStatus){
  return { id: `acct-${name}`, account_name: name, industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: monitoringStatus ? { monitoring_status: monitoringStatus } : {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

async function run(){
  // REQUIRED: an active account (no monitoring_status set, the common
  // case) is scanned.
  {
    const { res, researchedNames } = await runScenario([accountRow('Active Co')]);
    assert(res.statusCode === 200, 'the invocation succeeds');
    assert(researchedNames.includes('Active Co'), 'REQUIRED: an active customer account is included in the weekly research batch (scanned)');
  }

  // REQUIRED: an individually paused account is excluded from research.
  {
    const { researchedNames } = await runScenario([accountRow('Active Co'), accountRow('Paused Co', 'paused')]);
    assert(researchedNames.includes('Active Co'), 'the active sibling account is still scanned');
    assert(!researchedNames.includes('Paused Co'), 'REQUIRED: an individually paused customer account is excluded from the weekly research batch (not scanned)');
  }

  // REQUIRED: a resumed account (explicitly set back to "active") is
  // scanned again.
  {
    const { researchedNames } = await runScenario([accountRow('Resumed Co', 'active')]);
    assert(researchedNames.includes('Resumed Co'), 'REQUIRED: a resumed customer account (monitoring_status explicitly "active" again) is scanned again');
  }

  // An archived account is excluded too, same as paused.
  {
    const { researchedNames } = await runScenario([accountRow('Archived Co', 'archived')]);
    assert(!researchedNames.includes('Archived Co'), 'an archived customer account is excluded from the weekly research batch');
  }

  // If every account in the only upload is paused, the upload is skipped
  // entirely (no research-batch call at all) -- same "zero eligible
  // accounts" behavior as before this fix, now correctly triggered by a
  // real pause state instead of never triggering.
  {
    const { researchedNames } = await runScenario([accountRow('Only Co', 'paused')]);
    assert(researchedNames.length === 0, 'an upload whose only account is paused sends nothing to research-batch');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
