// Billing-count correction round: api/monitoring-lists.js's GET summary
// used to fold activeProspects into monitoringStatus/nextWeeklyScan --
// "Active"/"Monday" -- even when an org had zero active CUSTOMER lists,
// implying prospect research snapshots are under the same continuous
// weekly re-scan customer accounts get. They are not (see
// api/lib/entitlement.js's usageFor(), traced against api/weekly-scan.js,
// which never touches ha_prospect_accounts). This mocks global.fetch and
// invokes the real exported handler to prove the actual GET response, not
// a source-text pattern match.
//
// Usage: node scripts/test-monitoring-lists-prospect-terminology.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler from '../api/monitoring-lists.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200, headers = {}){
  return { ok, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function countResponse(n){
  return jsonResponse([], true, 200, { 'content-range': `0-0/${n}` });
}
function fakeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}
function fakeReq(){
  return { method: 'GET', headers: { authorization: 'Bearer valid-token' }, query: {} };
}

const USER = { id: 'user-1', auth_user_id: 'auth-1', email: 'rep@example.com', app_role: 'owner', organization_id: null, status: 'active' };

function mockFetch({ customerUploads, prospectUploads, prospectAccounts, prospectSignals }){
  return async (url) => {
    const u = String(url);
    if(u.includes('/auth/v1/user')) return jsonResponse({ id: USER.auth_user_id, email: USER.email });
    if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([USER]);
    if(u.includes('/rest/v1/ha_uploads?user_id=')) return jsonResponse(customerUploads);
    if(u.includes('/rest/v1/ha_prospect_uploads?user_email=')) return jsonResponse(prospectUploads);
    if(u.includes('/rest/v1/ha_prospect_accounts?upload_id=')) return jsonResponse(prospectAccounts);
    if(u.includes('/rest/v1/ha_prospect_signals?upload_id=')) return jsonResponse(prospectSignals);
    throw new Error(`Unhandled mock fetch URL in test: ${u}`);
  };
}

const originalFetch = global.fetch;

async function run(){
  // 1. REQUIRED: an org with ONLY active prospect lists (zero customer
  // lists at all) must NOT be reported as "Active"/"next scan Monday" --
  // there is nothing for weekly-scan.js to actually process.
  {
    global.fetch = mockFetch({
      customerUploads: [],
      prospectUploads: [{ id: 'pu-1', user_email: 'rep@example.com', filename: 'Leads June', account_count: 3, status: 'active', created_at: new Date().toISOString() }],
      prospectAccounts: [{ id: 'pa-1', company_name: 'Acme', last_scanned_at: new Date().toISOString(), status: 'active' }, { id: 'pa-2', company_name: 'Nike', last_scanned_at: new Date().toISOString(), status: 'active' }, { id: 'pa-3', company_name: 'L.L.Bean', last_scanned_at: new Date().toISOString(), status: 'active' }],
      prospectSignals: []
    });
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert(res.statusCode === 200, 'the GET summary request succeeds');
    assert(res.body.summary.activeProspects === 3, 'the 3 active prospect accounts are still counted and reported (got ' + res.body.summary.activeProspects + ')');
    assert(res.body.summary.monitoringStatus === 'No active lists', `REQUIRED: with zero active customer lists, monitoringStatus is "No active lists" even though 3 prospect accounts are active (got "${res.body.summary.monitoringStatus}")`);
    assert(res.body.summary.nextWeeklyScan === null, `REQUIRED: nextWeeklyScan is null when there is no active customer list for weekly-scan.js to actually process, regardless of active prospects (got ${JSON.stringify(res.body.summary.nextWeeklyScan)})`);
  }

  // 2. A genuinely active customer list still reports Active/Monday, same
  // as before this correction.
  {
    let customerUploadsCall = [{ id: 'cu-1', user_id: 'user-1', upload_name: 'Q3 Customers', stage: 'uploaded', updated_at: new Date().toISOString(), created_at: new Date().toISOString() }];
    global.fetch = async (url) => {
      const u = String(url);
      if(u.includes('/auth/v1/user')) return jsonResponse({ id: USER.auth_user_id, email: USER.email });
      if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([USER]);
      if(u.includes('/rest/v1/ha_uploads?user_id=')) return jsonResponse(customerUploadsCall);
      if(u.includes('/rest/v1/ha_prospect_uploads?user_email=')) return jsonResponse([]);
      if(u.includes('/rest/v1/ha_research_runs?upload_id=')) return jsonResponse([]);
      if(u.includes('/rest/v1/ha_accounts?upload_id=') && u.includes('monitoring_status=eq.paused')) return countResponse(0);
      if(u.includes('/rest/v1/ha_accounts?upload_id=') && u.includes('last_researched_at')) return jsonResponse([]);
      if(u.includes('/rest/v1/ha_accounts?upload_id=')) return countResponse(5);
      if(u.includes('/rest/v1/ha_signals?upload_id=')) return jsonResponse([]);
      throw new Error(`Unhandled mock fetch URL in test: ${u}`);
    };
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert(res.statusCode === 200, 'the GET summary request succeeds with an active customer list');
    assert(res.body.summary.activeCustomers === 5, 'the 5 active customer accounts are reported (got ' + res.body.summary.activeCustomers + ')');
    assert(res.body.summary.monitoringStatus === 'Active', 'with a genuinely active customer list, monitoringStatus is "Active" -- unchanged from before this correction');
    assert(res.body.summary.nextWeeklyScan === 'Monday', 'with a genuinely active customer list, nextWeeklyScan is still "Monday" -- unchanged from before this correction');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
