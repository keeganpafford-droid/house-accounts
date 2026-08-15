// Founder request (post live-QA-round-8 banking blocker): replace the
// stale "Sample Analysis / Acme Manufacturing" empty-state experience for a
// signed-in user with no uploaded customer data.
//
// This file exercises the REAL, unmodified default export of
// api/get-dashboard.js (not a reconstructed helper) -- same pattern as
// scripts/test-get-dashboard-authentication.js -- for the three
// server-side contract shapes renderEmptyWorkspaceState() (dashboard/
// index.html) now branches on:
//   1. 'my' view, zero personal uploads, team also has zero data (or no
//      team) -- personalEmpty:true, teamHasData:false.
//   2. 'my' view, zero personal uploads, but a TEAMMATE has uploaded real
//      accounts -- personalEmpty:true, teamHasData:true. teamHasData is
//      new this round: computed from the SAME org-wide account query the
//      handler already ran for the view switcher's own numbers
//      (teamCustomerCount), just now actually surfaced in the response.
//   3. 'team' view, the org has zero uploads/accounts/signals at all -- the
//      404 "No existing customer dashboard data found yet." shape (there is
//      no team-scoped personalEmpty response; this 404 IS team view's empty
//      contract).
//
// Usage: node scripts/test-live-qa-round9-empty-workspace.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler from '../api/get-dashboard.js';
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, {ok = true, status = 200} = {}){
  const text = JSON.stringify(data);
  return { ok, status, text: async () => text, json: async () => data };
}

function fakeReq({token, query = {}} = {}){
  return { method: 'GET', headers: token ? {authorization: `Bearer ${token}`} : {}, query };
}
function fakeRes(){
  return { _status: null, _body: null, status(code){ this._status = code; return this; }, json(body){ this._body = body; return this; } };
}

// ===========================================================================
// Scenario 1: a solo owner (no organization at all) with zero uploads.
// ===========================================================================
{
  const FIX = {
    token: 'token-solo-owner', authUserId: 'auth-solo-owner', userId: 'user-solo-owner', email: 'solo@example.com'
  };
  const HA_USERS = [{id: FIX.userId, auth_user_id: FIX.authUserId, email: FIX.email, app_role: 'owner', organization_id: null, status: 'active'}];
  const fetchImpl = async (url, init = {}) => {
    if(url.includes('/auth/v1/user')){
      const token = String((init.headers || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      if(token !== FIX.token) return jsonResponse({error:'invalid'}, {ok:false, status:401});
      return jsonResponse({id: FIX.authUserId});
    }
    if(url.includes('/rest/v1/ha_users') && url.includes('auth_user_id=eq.')) return jsonResponse(HA_USERS);
    if(url.includes('/rest/v1/ha_uploads')) return jsonResponse([]); // owns zero uploads
    if(url.includes('/rest/v1/ha_accounts')) return jsonResponse([]); // solo -- no teammates, own accounts also zero
    if(url.includes('/rest/v1/ha_signals')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_weekly_runs')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_prospect_uploads')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_prospect_accounts')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_account_opportunities')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_monitoring_targets')) return jsonResponse([]);
    throw new Error(`unexpected fetch (scenario 1): ${url}`);
  };
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  const req = fakeReq({token: FIX.token, query: {email: FIX.email, view: 'my'}});
  const res = fakeRes();
  await handler(req, res);
  global.fetch = originalFetch;

  assert(res._status === 200, `sanity: scenario 1 (solo owner, zero uploads) returns 200 (got ${res._status})`);
  assert(res._body?.personalEmpty === true, 'REQUIRED (scenario 1): a solo owner with zero personal uploads gets personalEmpty:true');
  assert(res._body?.teamHasData === false, `REQUIRED (scenario 1): teamHasData is false when there is no team/no teammate data (got ${res._body?.teamHasData})`);
}

// ===========================================================================
// Scenario 2: an owner in an org whose TEAMMATE has uploaded real accounts,
// but the owner personally has zero uploads.
// ===========================================================================
{
  const FIX = {
    token: 'token-owner-with-team', authUserId: 'auth-owner-with-team', userId: 'user-owner-with-team', email: 'owner@example.com',
    orgId: 'org-round9', teammateId: 'user-teammate', teammateUploadId: 'upload-teammate'
  };
  const HA_USERS = [
    {id: FIX.userId, auth_user_id: FIX.authUserId, email: FIX.email, app_role: 'owner', organization_id: FIX.orgId, status: 'active'},
    {id: FIX.teammateId, auth_user_id: null, email: 'teammate@example.com', app_role: 'member', organization_id: FIX.orgId, status: 'active'}
  ];
  const HA_UPLOADS = [
    {id: FIX.teammateUploadId, user_id: FIX.teammateId, upload_name: 'Teammate List', stage: 'researched', updated_at: '2026-08-01T00:00:00Z', summary: {}}
  ];
  const HA_ACCOUNTS = [
    {id: 'acct-teammate1', upload_id: FIX.teammateUploadId, user_id: FIX.teammateId, account_name: 'Teammate Account', industry: 'Test', raw_data: {}, metrics: {}, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z'}
  ];
  const fetchImpl = async (url, init = {}) => {
    if(url.includes('/auth/v1/user')){
      const token = String((init.headers || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      if(token !== FIX.token) return jsonResponse({error:'invalid'}, {ok:false, status:401});
      return jsonResponse({id: FIX.authUserId});
    }
    if(url.includes('/rest/v1/ha_users') && url.includes('auth_user_id=eq.')) return jsonResponse(HA_USERS.filter(u => u.auth_user_id === FIX.authUserId));
    if(url.includes('/rest/v1/ha_users') && url.includes('organization_id=eq.')) return jsonResponse(HA_USERS);
    if(url.includes('/rest/v1/ha_organizations')) return jsonResponse([{id: FIX.orgId, name: 'Round 9 Org'}]);
    if(url.includes('/rest/v1/ha_uploads')){
      // The owner personally owns zero uploads -- scoped to just the
      // owner's own id, HA_UPLOADS (all owned by the teammate) never matches.
      const uidsMatch = url.match(/user_id=in\.\(([^)]*)\)/);
      const allowedIds = uidsMatch ? uidsMatch[1].split(',').map(decodeURIComponent) : [];
      return jsonResponse(HA_UPLOADS.filter(u => allowedIds.includes(u.user_id)));
    }
    if(url.includes('/rest/v1/ha_accounts')){
      // teamCustomerCount's own org-wide query -- select=account_name,
      // scoped to every active org user (owner + teammate). This is the
      // real query api/get-dashboard.js already ran before this round; the
      // fix only starts surfacing its result.
      if(url.includes('select=account_name')){
        const uidsMatch = url.match(/user_id=in\.\(([^)]*)\)/);
        const allowedIds = uidsMatch ? uidsMatch[1].split(',').map(decodeURIComponent) : [];
        return jsonResponse(HA_ACCOUNTS.filter(a => allowedIds.includes(a.user_id)).map(a => ({account_name: a.account_name})));
      }
      return jsonResponse([]); // owner's own scoped ha_accounts query -- zero
    }
    if(url.includes('/rest/v1/ha_signals')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_weekly_runs')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_prospect_uploads')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_prospect_accounts')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_account_opportunities')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_monitoring_targets')) return jsonResponse([]);
    throw new Error(`unexpected fetch (scenario 2): ${url}`);
  };
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  const req = fakeReq({token: FIX.token, query: {email: FIX.email, view: 'my'}});
  const res = fakeRes();
  await handler(req, res);
  global.fetch = originalFetch;

  assert(res._status === 200, `sanity: scenario 2 (owner, zero personal uploads, teammate has data) returns 200 (got ${res._status})`);
  assert(res._body?.personalEmpty === true, 'REQUIRED (scenario 2): the owner personally still gets personalEmpty:true (my view is genuinely empty for THEM)');
  assert(res._body?.teamHasData === true, `REQUIRED (scenario 2): teamHasData is true -- their teammate has real uploaded accounts (got ${res._body?.teamHasData})`);
}

// ===========================================================================
// Scenario 3: team view, the org has zero uploads/accounts/signals at all.
// ===========================================================================
{
  const FIX = {
    token: 'token-owner-empty-team', authUserId: 'auth-owner-empty-team', userId: 'user-owner-empty-team', email: 'owner-empty@example.com',
    orgId: 'org-round9-empty'
  };
  const HA_USERS = [{id: FIX.userId, auth_user_id: FIX.authUserId, email: FIX.email, app_role: 'owner', organization_id: FIX.orgId, status: 'active'}];
  const fetchImpl = async (url, init = {}) => {
    if(url.includes('/auth/v1/user')){
      const token = String((init.headers || {}).Authorization || '').replace(/^Bearer\s+/i, '');
      if(token !== FIX.token) return jsonResponse({error:'invalid'}, {ok:false, status:401});
      return jsonResponse({id: FIX.authUserId});
    }
    if(url.includes('/rest/v1/ha_users') && url.includes('auth_user_id=eq.')) return jsonResponse(HA_USERS);
    if(url.includes('/rest/v1/ha_users') && url.includes('organization_id=eq.')) return jsonResponse(HA_USERS);
    if(url.includes('/rest/v1/ha_organizations')) return jsonResponse([{id: FIX.orgId, name: 'Empty Org'}]);
    if(url.includes('/rest/v1/ha_uploads')) return jsonResponse([]); // nobody in the org has ever uploaded
    if(url.includes('/rest/v1/ha_accounts')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_signals')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_weekly_runs')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_prospect_uploads')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_prospect_accounts')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_account_opportunities')) return jsonResponse([]);
    if(url.includes('/rest/v1/ha_monitoring_targets')) return jsonResponse([]);
    throw new Error(`unexpected fetch (scenario 3): ${url}`);
  };
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  const req = fakeReq({token: FIX.token, query: {email: FIX.email, view: 'team'}});
  const res = fakeRes();
  await handler(req, res);
  global.fetch = originalFetch;

  assert(res._status === 404, `REQUIRED (scenario 3): team view with a genuinely empty org returns the 404 "no existing customer dashboard data" shape (got ${res._status})`);
  assert(/No existing customer dashboard data found yet/.test(res._body?.error || ''), `REQUIRED (scenario 3): the exact error text the client's noData regex matches is present (got "${res._body?.error}")`);
}

// ===========================================================================
// Client-side render coverage: the REAL, verbatim-extracted
// fetchAndRenderAggregateDashboard()/applyEmptyWorkspaceState()/
// renderEmptyWorkspaceState() (dashboard/index.html), exercised end-to-end
// for the same three scenarios, asserting the exact rendered title/body/CTA
// text a user would see -- not just that a flag or field was set.
// ===========================================================================
{
  const DASHBOARD_SRC = loadDashboardSource();
  const SRC = [extractFn(DASHBOARD_SRC, 'renderEmptyWorkspaceState'), extractFn(DASHBOARD_SRC, 'applyEmptyWorkspaceState'), extractFn(DASHBOARD_SRC, 'fetchAndRenderAggregateDashboard')].join('\n\n');

  function makeEl(){ return { style:{display:''}, textContent:'', innerHTML:'', hidden:false, classList:{ _c:new Set(), add(...c){c.forEach(x=>this._c.add(x));}, remove(...c){c.forEach(x=>this._c.delete(x));}, contains(c){return this._c.has(c);} } }; }

  function buildClientScenario(){
    const els = {
      savedDashboardBanner: makeEl(), dashboardLoadingSkeleton: makeEl(), memberEmptyState: makeEl(),
      leadGate: makeEl(), exampleOpportunity: makeEl(), results: makeEl(), customerDashboard: makeEl(),
      emptyWorkspaceTitle: makeEl(), emptyWorkspaceBody: makeEl(), emptyWorkspaceSwitchTeam: makeEl()
    };
    els.results.style.display = 'block';
    els.customerDashboard.style.display = 'block';
    els.emptyWorkspaceSwitchTeam.hidden = true;
    let nextResponse = null;
    const houseAuth = { authHeadersAsync: async () => ({Authorization:'Bearer test'}) };
    const sandbox = {
      console,
      window: { accountRadarAccounts: [{name:'Stale Account'}], HouseAuth: houseAuth },
      HouseAuth: houseAuth,
      document: { getElementById: id => els[id] || null },
      fetch: async () => ({ ok: nextResponse.ok !== false, status: nextResponse.status || 200, json: async () => nextResponse.body }),
      currentDashboardData: null, dashboardCanViewTeam: true, dashboardViewMode: nextResponse?.requestedView,
      defaultDashboardView: () => 'team', renderDashboardViewSwitcher: () => {}, showJoinedWelcomeIfNeeded: () => {},
      normalizeSavedAccount: a => a,
      currentUploadId: 'stale-upload', currentUploadName: 'Stale.csv', currentLead: { email:'rep@example.com' },
      localStorage: { setItem(){}, getItem(){ return null; } },
      renderCustomerDashboard: () => {}, refreshOpportunityViews: () => {},
      aggregateDashboardEverLoaded: true, freshUploadRenderedThisSession: false, dashboardFetchGeneration: 0,
      escapeHtml: s => String(s || ''), canCurrentUserViewTeam: () => true
    };
    vm.createContext(sandbox);
    new vm.Script(`${SRC}\nthis.__exports = { fetchAndRenderAggregateDashboard };`, { filename: 'round9-client-render.js' }).runInContext(sandbox);
    return { sandbox, els, setNext: (body, opts = {}) => { nextResponse = {body, ...opts}; sandbox.dashboardViewMode = opts.requestedView || sandbox.dashboardViewMode; } };
  }

  // Client scenario 1: 'my' view, personalEmpty, teamHasData:false.
  {
    const { sandbox, els, setNext } = buildClientScenario();
    setNext({ personalEmpty:true, teamHasData:false }, { requestedView:'my' });
    const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:false});
    assert(result.ok === true && result.empty === true, 'sanity: client scenario 1 (my view, no personal or team data) resolves as a real empty state');
    assert(els.emptyWorkspaceTitle.textContent === 'No customer data yet', `REQUIRED (client 1): title reads "No customer data yet" (got "${els.emptyWorkspaceTitle.textContent}")`);
    assert(els.emptyWorkspaceBody.textContent === 'Upload a customer order history to start getting repeat buying opportunities, follow-up reminders, and business trigger insights.', `REQUIRED (client 1): body matches the founder-specified default copy exactly (got "${els.emptyWorkspaceBody.textContent}")`);
    assert(els.emptyWorkspaceSwitchTeam.hidden === true, 'REQUIRED (client 1): no "Switch to Team View" link when the team also has no data');
    assert(els.exampleOpportunity.style.display !== 'block', 'REQUIRED (client 1): the old Sample Analysis / Acme Manufacturing card is not shown');
  }

  // Client scenario 2: 'my' view, personalEmpty, but teamHasData:true.
  {
    const { sandbox, els, setNext } = buildClientScenario();
    setNext({ personalEmpty:true, teamHasData:true }, { requestedView:'my' });
    const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:false});
    assert(result.ok === true && result.empty === true, 'sanity: client scenario 2 (my view empty, team has data) resolves as a real empty state');
    assert(els.emptyWorkspaceTitle.textContent === 'No customer data yet', `REQUIRED (client 2): title still reads "No customer data yet" (got "${els.emptyWorkspaceTitle.textContent}")`);
    assert(els.emptyWorkspaceBody.textContent === "You haven't uploaded your own customer accounts yet. Switch to Team View to see shared team opportunities, or upload your own data to get personal recommendations.", `REQUIRED (client 2): body points the user at Team View as an alternative (got "${els.emptyWorkspaceBody.textContent}")`);
    assert(els.emptyWorkspaceSwitchTeam.hidden === false, 'REQUIRED (client 2): the "Switch to Team View" action is visible when the team genuinely has data');
  }

  // Client scenario 3: 'team' view, the org has zero data (404 noData shape).
  {
    const { sandbox, els, setNext } = buildClientScenario();
    setNext(undefined, { requestedView:'team', ok:false, status:404 });
    // fetchAndRenderAggregateDashboard() reads res.json() even on a non-ok
    // response and throws data.error -- match the real 404 body shape.
    sandbox.fetch = async () => ({ ok:false, status:404, json: async () => ({ error:'No existing customer dashboard data found yet.' }) });
    const result = await sandbox.__exports.fetchAndRenderAggregateDashboard('rep@example.com', {silent:false});
    assert(result.ok === true && result.empty === true, 'sanity: client scenario 3 (team view, empty org) resolves as a real empty state, not a raw error');
    assert(els.emptyWorkspaceTitle.textContent === 'No customer data yet', `REQUIRED (client 3): title still reads "No customer data yet" (got "${els.emptyWorkspaceTitle.textContent}")`);
    assert(els.emptyWorkspaceBody.textContent === "Your team hasn't uploaded customer data yet. Upload a customer order history to start getting repeat buying opportunities, follow-up reminders, and business trigger insights.", `REQUIRED (client 3): body uses team-context copy per the founder's spec (got "${els.emptyWorkspaceBody.textContent}")`);
    assert(els.emptyWorkspaceSwitchTeam.hidden === true, 'REQUIRED (client 3): no "Switch to Team View" link while already in Team View');
  }
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
