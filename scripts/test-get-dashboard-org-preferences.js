// Behavioral Learning V1, Phase 2 (dashboard-only wiring) -- server-side
// integration: api/get-dashboard.js's own org-preference fetch/attach/
// fail-closed behavior, exercised against the REAL, unmodified default
// export (same convention as scripts/test-get-dashboard-authentication.js),
// not a reconstructed helper. The pure aggregation math itself is already
// proven in isolation by scripts/test-org-preference-learning.js; the
// client-side score integration is proven by
// scripts/test-behavioral-learning-dashboard-integration.js -- this file
// covers the piece neither of those can: does the REAL HTTP handler fetch
// from the correct (server-derived) organization, attach the right
// metadata, and fail closed to a 200 with unchanged dashboard data when
// the preference computation itself breaks.
//
// Usage: node scripts/test-get-dashboard-org-preferences.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler, { fetchOrgSignalPreferences, orgPreferenceMetadataFor, rowToSignal } from '../api/get-dashboard.js';

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
// 1. orgPreferenceMetadataFor() -- the pure per-signal metadata helper.
// ===========================================================================
{
  const orgPreferences = { BUSINESS_ACTIVITY: { adjustment: 5, sufficientEvidence: true, totalEvidenceCount: 9, qualityPositiveCount: 7, qualityNegativeCount: 2, outcomePositiveCount: 0 } };
  const meta = orgPreferenceMetadataFor({ signalType: 'Hiring Activity' }, orgPreferences);
  assert(meta?.family === 'BUSINESS_ACTIVITY', `REQUIRED: metadata resolves the correct canonical family for a real signalType (got ${JSON.stringify(meta)})`);
  assert(meta?.adjustment === 5 && meta?.sufficientEvidence === true && meta?.totalEvidenceCount === 9 && meta?.qualityPositiveCount === 7 && meta?.qualityNegativeCount === 2 && meta?.outcomePositiveCount === 0, 'REQUIRED: every required field (adjustment, sufficientEvidence, totalEvidenceCount, qualityPositiveCount, qualityNegativeCount, outcomePositiveCount) is present and correct');
}
{
  assert(orgPreferenceMetadataFor({ signalType: 'Hiring Activity' }, {}) === null, 'REQUIRED: no computed entry for the family at all resolves to null (not a fabricated zero object)');
  assert(orgPreferenceMetadataFor({}, { BUSINESS_ACTIVITY: { adjustment: 5, sufficientEvidence: true } }) === null, 'REQUIRED: a payload with no resolvable family (empty payload) resolves to null regardless of what preferences exist');
  assert(orgPreferenceMetadataFor({ signalType: 'Hiring Activity' }, undefined) === null, 'REQUIRED: an undefined orgPreferences table never throws, resolves to null');
}

// ===========================================================================
// 2. rowToSignal() -- attaches orgPreference metadata when supplied,
//    defaults to null (and stays fully backward compatible) when not.
// ===========================================================================
{
  const row = { id: 'sig-1', account_name: 'Acme', signal_type: 'Hiring Activity', payload: {}, first_seen_at: '2026-08-01T00:00:00Z', last_seen_at: '2026-08-01T00:00:00Z' };
  const withPrefs = rowToSignal(row, { BUSINESS_ACTIVITY: { adjustment: 5, sufficientEvidence: true, totalEvidenceCount: 9, qualityPositiveCount: 7, qualityNegativeCount: 2, outcomePositiveCount: 0 } });
  assert(withPrefs.orgPreference?.family === 'BUSINESS_ACTIVITY' && withPrefs.orgPreference?.adjustment === 5, `REQUIRED: rowToSignal(row, orgPreferences) attaches the resolved metadata (got ${JSON.stringify(withPrefs.orgPreference)})`);
  const withoutSecondArg = rowToSignal(row);
  assert(withoutSecondArg.orgPreference === null, 'REQUIRED: rowToSignal(row) called with no second argument (every pre-existing call site/test) still works and defaults orgPreference to null -- fully backward compatible');
  assert(withoutSecondArg.signalType === row.signal_type && withoutSecondArg.accountName === row.account_name, 'sanity: every pre-existing rowToSignal() field is unaffected by this change');
}

// ===========================================================================
// 3. fetchOrgSignalPreferences() -- correct organization-scoped fetch/
//    aggregation, and safe defaults for a missing organization.
// ===========================================================================
{
  const result = await fetchOrgSignalPreferences(null);
  assert(JSON.stringify(result) === '{}', 'REQUIRED: no organizationId at all returns {} without ever calling fetch');
}
{
  const orgId = 'org-fetch-test';
  const calledUrls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    calledUrls.push(String(url));
    const u = String(url);
    assert(u.includes(`organization_id=eq.${encodeURIComponent(orgId)}`), `REQUIRED: every ha_signal_events query is scoped to the exact organizationId passed in (got ${u})`);
    if (u.includes("event_type=in.(signal_useful,signal_not_useful,opportunity_useful,opportunity_not_useful,outcome_reported)")) {
      return jsonResponse([
        { id: 'e1', organization_id: orgId, user_id: 'u1', event_type: 'signal_useful', event_fingerprint: 'fp1', parent_event_id: null, payload: { signalType: 'Hiring Activity' }, created_at: new Date().toISOString() }
      ]);
    }
    if (u.includes('event_type=in.(outreach_made,opportunity_outreach_made)')) {
      return jsonResponse([]);
    }
    throw new Error(`unexpected fetch in fetchOrgSignalPreferences test: ${u}`);
  };
  try {
    const result = await fetchOrgSignalPreferences(orgId);
    assert(calledUrls.length === 2, `REQUIRED: exactly two bounded queries are made (evidence window + parent window), never a per-opportunity call (got ${calledUrls.length})`);
    // A single event is below the 5-event floor, so this proves the real
    // computeOrgSignalPreferences() pipeline actually ran (not a stub) --
    // sufficientEvidence:false, matching the real evidence-floor doctrine.
    assert(result.BUSINESS_ACTIVITY?.sufficientEvidence === false && result.BUSINESS_ACTIVITY?.totalEvidenceCount === 1, `REQUIRED: the real computeOrgSignalPreferences() pipeline ran against the fetched event (got ${JSON.stringify(result)})`);
  } finally {
    global.fetch = realFetch;
  }
}

// ===========================================================================
// 4. Full-handler fail-closed proof: the ha_signal_events query itself
//    fails, but the dashboard request as a whole must still succeed (200)
//    with real accounts/signals intact and orgPreferences:{} -- never a 500,
//    never stale/fabricated preference data.
// ===========================================================================
{
  const AUTH_TOKEN = 'valid-token-orgpref';
  const AUTH_USER_ID = 'auth-user-orgpref';
  const USER_ID = 'user-orgpref';
  const ORG_ID = 'org-orgpref';
  const UPLOAD_ID = 'upload-orgpref';

  const HA_USERS = [{ id: USER_ID, auth_user_id: AUTH_USER_ID, email: 'orgpref@example.com', app_role: 'member', organization_id: ORG_ID, status: 'active' }];
  const HA_UPLOADS = [{ id: UPLOAD_ID, user_id: USER_ID, updated_at: new Date().toISOString(), summary: {} }];
  const HA_ACCOUNTS = [{ id: 'acct-1', user_id: USER_ID, upload_id: UPLOAD_ID, account_name: 'Acme Fixtures', updated_at: new Date().toISOString(), raw_data: {} }];
  const HA_SIGNALS = [{ id: 'sig-1', user_id: USER_ID, upload_id: UPLOAD_ID, account_name: 'Acme Fixtures', signal_type: 'Hiring Activity', payload: {}, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }];

  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonResponse({ id: AUTH_USER_ID, email: 'orgpref@example.com' });
    if (u.includes('/rest/v1/ha_users?select=*&auth_user_id=eq.')) return jsonResponse(HA_USERS);
    if (u.includes('/rest/v1/ha_organizations')) return jsonResponse([{ id: ORG_ID, name: 'Org Pref Test' }]);
    if (u.includes('/rest/v1/ha_uploads')) return jsonResponse(HA_UPLOADS);
    if (u.includes('/rest/v1/ha_accounts?select=account_name')) return jsonResponse([]); // teamCustomerCount side query
    if (u.includes('/rest/v1/ha_accounts')) return jsonResponse(HA_ACCOUNTS);
    if (u.includes('/rest/v1/ha_signals')) return jsonResponse(HA_SIGNALS);
    if (u.includes('/rest/v1/ha_weekly_runs')) return jsonResponse([]);
    if (u.includes('/rest/v1/ha_account_opportunities')) return jsonResponse([]);
    if (u.includes('/rest/v1/ha_monitoring_targets')) return jsonResponse([]);
    if (u.includes('/rest/v1/ha_users?organization_id=eq.')) return jsonResponse(HA_USERS);
    if (u.includes('/rest/v1/ha_prospect_')) return jsonResponse([]);
    // The org-preference fetch itself: simulate a genuine failure (bad
    // query / Supabase outage / anything) -- this is the ONE thing this
    // test deliberately breaks.
    if (u.includes('/rest/v1/ha_signal_events')) throw new Error('simulated Supabase outage for ha_signal_events');
    throw new Error(`unexpected fetch in fail-closed handler test: ${u}`);
  };

  function makeReq(){ return { method: 'GET', headers: { authorization: `Bearer ${AUTH_TOKEN}` }, query: {} }; }
  function makeRes(){
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
  }

  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert(res.statusCode === 200, `REQUIRED: a failed org-preference query never fails the whole dashboard request -- still 200 (got ${res.statusCode}, body ${JSON.stringify(res.body)})`);
    assert(res.body?.ok === true, 'REQUIRED: the response is a genuine success, not a disguised error');
    assert(Array.isArray(res.body?.accounts) && res.body.accounts.length === 1, 'REQUIRED: real account data is still present and correct -- the failure is isolated to preferences only');
    assert(Array.isArray(res.body?.signals) && res.body.signals.length === 1, 'REQUIRED: real signal data is still present and correct');
    assert(res.body?.signals?.[0]?.orgPreference === null, 'REQUIRED: the signal\'s own orgPreference metadata safely defaults to null when the computation failed, never stale/fabricated data');
    assert(JSON.stringify(res.body?.orgPreferences) === '{}', `REQUIRED: the top-level orgPreferences field is exactly {} on failure -- every downstream lookup resolves to "no adjustment" (got ${JSON.stringify(res.body?.orgPreferences)})`);
  } finally {
    global.fetch = realFetch;
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
