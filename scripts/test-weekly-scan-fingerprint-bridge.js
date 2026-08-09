// Foundation freeze, Phase 1B -- weekly scan v1->v2 legacy compatibility
// bridge parity. api/weekly-scan.js writes to ha_signals through the exact
// same resolveOpportunityEvents() -> event_fingerprint path api/save-upload.js
// uses, but previously had no legacy compatibility bridge at all -- meaning
// an unattended weekly rediscovery of an event that already has a legacy-
// format row could reinsert exactly the v1->v2 duplicate the bridge exists
// to prevent. This test proves the real exported `handler` now reuses
// api/save-upload.js's own tested fetchLegacySignalsForAccounts()/
// applyLegacyFingerprintBridge() primitives (not a second, divergent
// implementation) via the same batched-mock-fetch + real-handler pattern
// scripts/test-weekly-scan-reliability.js already established.
//
// Usage: node scripts/test-weekly-scan-fingerprint-bridge.js
import handler from '../api/weekly-scan.js';

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
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}

function setEnv(){
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  process.env.RESEND_API_KEY = 'fake-resend-key';
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE;
}

async function run(){
  // =========================================================================
  // 1) A legacy event (real Dover-Honda-shaped fixture: bare year, no
  // anchor resolvable, no exact date) is rediscovered by the weekly scan.
  // Required: the existing legacy row is refreshed in place, no v2 duplicate
  // is inserted.
  // =========================================================================
  {
    setEnv();
    const userId = 'user-weekly-bridge-1';
    const upload = { id: 'upload-bridge-1', user_id: userId, upload_name: 'Bridge List', summary: {}, created_at: new Date().toISOString(), ha_users: { id: userId, email: 'rep@example.com', name: 'Rep', company: '' } };
    const account = { id: 'acct-bridge-1', account_name: 'Dover Honda', industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const legacyRow = {
      id: 'legacy-parade-1', user_id: userId, account_name: 'Dover Honda',
      event_fingerprint: 'dover honda|EVENT_COMMUNITY||2026', confidence: 45, first_seen_at: '2026-08-09T15:42:38.065251+00:00',
      source_url: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026',
      title: 'Dover Honda Signs on as Dover Holiday Parade Sponsor',
      payload: {
        accountName: 'Dover Honda',
        headline: 'Dover Honda Signs on as Dover Holiday Parade Sponsor',
        whatChanged: 'Dover Honda signs on as Dover Holiday Parade sponsor.',
        sourceUrl: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026'
      }
    };

    const signalGetCalls = [];
    const insertedRows = [];
    const realFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      const method = options.method || 'GET';
      if (u.includes('/rest/v1/ha_uploads')) return jsonResponse([upload]);
      if (u.includes('/rest/v1/ha_accounts')) return jsonResponse([account]);
      if (u.includes('/rest/v1/ha_weekly_runs') && method === 'GET') return jsonResponse([]);
      if (u.includes('/rest/v1/ha_weekly_runs') && method === 'POST') return jsonResponse([{ id: 'run-bridge-1', ...JSON.parse(options.body)[0] }]);
      if (u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH') return jsonResponse([{ id: 'run-patched', ...JSON.parse(options.body) }]);
      if (u.includes('/rest/v1/ha_signals') && method === 'GET') {
        signalGetCalls.push(u);
        return jsonResponse([legacyRow]);
      }
      if (u.includes('/rest/v1/ha_signals') && method === 'POST') {
        const rows = JSON.parse(options.body);
        const prefer = String((options.headers || {}).Prefer || '');
        if (prefer.includes('merge-duplicates')) return jsonResponse(rows);
        insertedRows.push(...rows);
        return jsonResponse(rows);
      }
      if (u.includes('/api/research-batch')) {
        return jsonResponse({
          signals: [{
            accountName: 'Dover Honda', signalType: 'Community / CSR',
            signalTitle: 'Lead Platinum Sponsor for the 2026 Dover Holiday Parade',
            whatChanged: 'Dover Honda is the lead Platinum Sponsor for the 2026 Dover Holiday Parade, taking place November 29, 2026.',
            sourceUrl: legacyRow.source_url, confidenceScore: 48
          }],
          diagnostics: { structuredSummary: { eligibleAccounts: 1, processedAccounts: 1, failedAccounts: 0 } }
        });
      }
      throw new Error(`Unhandled fetch in weekly-scan bridge test mock: ${method} ${u}`);
    };

    const req = { method: 'GET', headers: { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` }, query: { limit: '25' } };
    const res = makeRes();
    try { await handler(req, res); } finally { global.fetch = realFetch; }

    assert(res.statusCode === 200, `1) the weekly-scan invocation succeeds (got status ${res.statusCode}, body ${JSON.stringify(res.body)})`);
    assert(signalGetCalls.length === 1, `1) exactly one batched ha_signals GET pre-flight query runs -- no N+1 (got ${signalGetCalls.length})`);
    assert(insertedRows.length === 1, `1) exactly one row was submitted to the ignore-duplicates insert (got ${insertedRows.length})`);
    assert(insertedRows[0]?.event_fingerprint === legacyRow.event_fingerprint, `REQUIRED: the legacy Dover Holiday Parade row is refreshed in place -- the submitted fingerprint matches the existing legacy row's own literal fingerprint, not a fresh v2 string (got "${insertedRows[0]?.event_fingerprint}")`);
    assert(!insertedRows.some(r => String(r.event_fingerprint || '').startsWith('v2|')), 'REQUIRED: no v2-format duplicate row was created for this rediscovered legacy event');
  }

  // =========================================================================
  // 2) Multiple legacy rows match one rediscovered event (Presidents' Award
  // shape): deterministic winner (highest confidence) is refreshed; the
  // non-winner is left completely untouched (never appears in any insert or
  // update call at all).
  // =========================================================================
  {
    setEnv();
    const userId = 'user-weekly-bridge-2';
    const upload = { id: 'upload-bridge-2', user_id: userId, upload_name: 'Bridge List 2', summary: {}, created_at: new Date().toISOString(), ha_users: { id: userId, email: 'rep2@example.com', name: 'Rep', company: '' } };
    const account = { id: 'acct-bridge-2', account_name: 'Dover Honda', industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const legacyRowLow = {
      id: 'legacy-award-low', user_id: userId, account_name: 'Dover Honda',
      event_fingerprint: 'dover honda|LEADERSHIP_APPOINTMENT||unknown', confidence: 22, first_seen_at: '2026-08-09T04:32:26.924787+00:00',
      payload: { accountName: 'Dover Honda', headline: 'Dover Honda Team Named for Presidents Award', whatChanged: 'Dover Honda was named as a recipient of the Presidents Award this year.' }
    };
    const legacyRowHigh = {
      id: 'legacy-award-high', user_id: userId, account_name: 'Dover Honda',
      event_fingerprint: 'dover honda|EVENT_AWARD||unknown', confidence: 45, first_seen_at: '2026-08-09T15:42:38.065251+00:00',
      payload: { accountName: 'Dover Honda', headline: 'Dover Honda Wins Presidents Award', whatChanged: 'Dover Honda received the Presidents Award for outstanding service.' }
    };

    const insertedRows = [];
    const realFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      const method = options.method || 'GET';
      if (u.includes('/rest/v1/ha_uploads')) return jsonResponse([upload]);
      if (u.includes('/rest/v1/ha_accounts')) return jsonResponse([account]);
      if (u.includes('/rest/v1/ha_weekly_runs') && method === 'GET') return jsonResponse([]);
      if (u.includes('/rest/v1/ha_weekly_runs') && method === 'POST') return jsonResponse([{ id: 'run-bridge-2', ...JSON.parse(options.body)[0] }]);
      if (u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH') return jsonResponse([{ id: 'run-patched', ...JSON.parse(options.body) }]);
      if (u.includes('/rest/v1/ha_signals') && method === 'GET') return jsonResponse([legacyRowLow, legacyRowHigh]);
      if (u.includes('/rest/v1/ha_signals') && method === 'POST') {
        const rows = JSON.parse(options.body);
        const prefer = String((options.headers || {}).Prefer || '');
        if (prefer.includes('merge-duplicates')) return jsonResponse(rows);
        insertedRows.push(...rows);
        return jsonResponse(rows);
      }
      if (u.includes('/api/research-batch')) {
        return jsonResponse({
          signals: [{
            accountName: 'Dover Honda', signalType: 'Award / Recognition',
            signalTitle: 'Dover Honda Receives Presidents Award', whatChanged: 'Dover Honda was honored with the Presidents Award this year.',
            sourceUrl: 'https://example.com/dover-honda-award-story', confidenceScore: 50
          }],
          diagnostics: { structuredSummary: { eligibleAccounts: 1, processedAccounts: 1, failedAccounts: 0 } }
        });
      }
      throw new Error(`Unhandled fetch in weekly-scan multi-match bridge test mock: ${method} ${u}`);
    };

    const req = { method: 'GET', headers: { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` }, query: { limit: '25' } };
    const res = makeRes();
    try { await handler(req, res); } finally { global.fetch = realFetch; }

    assert(res.statusCode === 200, `2) the multi-match weekly-scan invocation succeeds (got status ${res.statusCode})`);
    assert(insertedRows.length === 1, `2) exactly one row submitted -- no third row created (got ${insertedRows.length})`);
    assert(insertedRows[0]?.event_fingerprint === legacyRowHigh.event_fingerprint, `REQUIRED: the deterministic winner (highest confidence) is refreshed (got "${insertedRows[0]?.event_fingerprint}")`);
    assert(insertedRows[0]?.event_fingerprint !== legacyRowLow.event_fingerprint, 'REQUIRED: the non-winning legacy row is never targeted by any write');
  }

  // =========================================================================
  // 3) A genuinely new event (no legacy match at all) still persists as an
  // explicit v2|... fingerprint -- the bridge does not suppress or corrupt
  // ordinary new-event persistence.
  // =========================================================================
  {
    setEnv();
    const userId = 'user-weekly-bridge-3';
    const upload = { id: 'upload-bridge-3', user_id: userId, upload_name: 'Bridge List 3', summary: {}, created_at: new Date().toISOString(), ha_users: { id: userId, email: 'rep3@example.com', name: 'Rep', company: '' } };
    const account = { id: 'acct-bridge-3', account_name: 'Acme Corp', industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

    const insertedRows = [];
    const realFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      const method = options.method || 'GET';
      if (u.includes('/rest/v1/ha_uploads')) return jsonResponse([upload]);
      if (u.includes('/rest/v1/ha_accounts')) return jsonResponse([account]);
      if (u.includes('/rest/v1/ha_weekly_runs') && method === 'GET') return jsonResponse([]);
      if (u.includes('/rest/v1/ha_weekly_runs') && method === 'POST') return jsonResponse([{ id: 'run-bridge-3', ...JSON.parse(options.body)[0] }]);
      if (u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH') return jsonResponse([{ id: 'run-patched', ...JSON.parse(options.body) }]);
      if (u.includes('/rest/v1/ha_signals') && method === 'GET') return jsonResponse([]); // no legacy rows for this account at all
      if (u.includes('/rest/v1/ha_signals') && method === 'POST') {
        const rows = JSON.parse(options.body);
        const prefer = String((options.headers || {}).Prefer || '');
        if (prefer.includes('merge-duplicates')) return jsonResponse(rows);
        insertedRows.push(...rows);
        return jsonResponse(rows);
      }
      if (u.includes('/api/research-batch')) {
        return jsonResponse({
          signals: [{
            accountName: 'Acme Corp', signalType: 'Business Activity',
            signalTitle: 'Acme Corp opens new distribution center', whatChanged: 'Acme Corp opened a new distribution center',
            sourceUrl: 'https://example.com/acme-corp-new-center', confidenceScore: 70
          }],
          diagnostics: { structuredSummary: { eligibleAccounts: 1, processedAccounts: 1, failedAccounts: 0 } }
        });
      }
      throw new Error(`Unhandled fetch in weekly-scan new-event bridge test mock: ${method} ${u}`);
    };

    const req = { method: 'GET', headers: { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` }, query: { limit: '25' } };
    const res = makeRes();
    try { await handler(req, res); } finally { global.fetch = realFetch; }

    assert(res.statusCode === 200, `3) the new-event weekly-scan invocation succeeds (got status ${res.statusCode})`);
    assert(insertedRows.length === 1, `3) exactly one row submitted for the genuinely new event (got ${insertedRows.length})`);
    assert(String(insertedRows[0]?.event_fingerprint || '').startsWith('v2|'), `REQUIRED: a genuinely new event still persists with an explicit v2|... fingerprint (got "${insertedRows[0]?.event_fingerprint}")`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  if (failures) process.exitCode = 1;
}

run();
