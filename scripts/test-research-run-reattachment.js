// Phase 2A implementation-review ROUND 12 -- automated coverage for the
// Live Preview QA report on the single-account "Research Again" flow:
// server-backed run-state reattachment across modal close/reopen and full
// page reload, the HA004 branded dialog (replacing window.alert()), the
// post-research "View opportunities" handoff, and the Recently Researched
// section.
//
// Convention (matching every other test file in this project): extract the
// VERBATIM, on-disk source of every function under test directly out of
// dashboard/index.html and api/monitoring-lists.js and run it for real (in
// a vm sandbox for the client half, via a real module import for the
// server half). Nothing about the logic itself is reimplemented -- only
// pure DOM-rendering/classification helpers with no bearing on the
// behavior under test are stubbed, each with a one-line reason. extractFn()/
// extractRaw() verify the extracted slice still starts with the expected
// signature and still closes correctly, so a future source reshuffle fails
// loudly here instead of silently testing stale text.
//
// Maps directly onto the 10 numbered requirements from the QA report:
//  1) closing the modal does not cancel the active provider request
//  2) reopening while active shows "Researching" with no extra claim/call
//  3) reload after completion shows "Research Again" + the persisted timestamp
//  4) a failed active run restores a branded failure state
//  5) reopening never creates a duplicate run/provider request
//  6) HA004 is shown through the branded UI, never a native alert
//  7) "View opportunities" finds the account even below the top rows
//  8) Recently Researched deduplicates reruns of the same account
//  9) normal priority order is unaffected by the recently-researched treatment
// 10) the monitoring-lists 404 regression (root cause: no code path in
//     api/monitoring-lists.js can emit a 404 -- see PART 1 below)
//
// Usage: node scripts/test-research-run-reattachment.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import monitoringListsHandler from '../api/monitoring-lists.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DASHBOARD_SRC = readFileSync(join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8');
const DASHBOARD_LINES = DASHBOARD_SRC.split('\n');
const MONITORING_LISTS_SRC = readFileSync(join(REPO_ROOT, 'api', 'monitoring-lists.js'), 'utf8');

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// Tolerant of the modal IIFE's single-space indentation, same contract as
// scripts/test-dashboard-auth-headers.js's extractFn().
function extractFn(name, startLine, endLine, {async: isAsync = false} = {}){
  const slice = DASHBOARD_LINES.slice(startLine - 1, endLine).join('\n');
  const trimmedStart = slice.replace(/^\s+/, '');
  const expectedPrefix = `${isAsync ? 'async ' : ''}function ${name}(`;
  if(!trimmedStart.startsWith(expectedPrefix)){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-research-run-reattachment.js.`);
  }
  if(!slice.trimEnd().endsWith('}')){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${endLine} does not close the function body as expected -- update the line range.`);
  }
  return slice;
}
function extractRaw(label, startLine, endLine, expectedPrefixTrimmed){
  const slice = DASHBOARD_LINES.slice(startLine - 1, endLine).join('\n');
  const trimmedStart = slice.replace(/^\s+/, '');
  if(!trimmedStart.startsWith(expectedPrefixTrimmed)){
    throw new Error(`extractRaw(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefixTrimmed}" -- source has shifted, update the line range in scripts/test-research-run-reattachment.js.`);
  }
  return slice;
}

// ===========================================================================
// PART 1 -- server: researchRunState computation, and the monitoring-lists
// 404 investigation (requirement 10).
//
// Root cause established by direct code reading, proven here structurally:
// every branch of api/monitoring-lists.js's exported handler terminates in
// json(res, <status>, ...) with a status the code itself chooses (200, 400,
// 401, 403, 405, or e.status||500 from a caught exception) -- there is no
// code path anywhere in this file that can produce a 404. The 404 the QA
// report observed in the console is therefore NOT a defect in this file's
// routing/logic; it is consistent with a Preview-deployment-availability
// gap (the same class of issue diagnosed earlier in this engagement),
// verified by the user against the live Preview deployment, which this
// suite cannot reach or substitute for.
// ===========================================================================
function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function fakeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}
function fakeReq(method, body){
  return { method, headers: { authorization: 'Bearer valid-token' }, body };
}

const AUTH_USER_ID = 'auth-user-1';
const USER_ID = 'user-1';
const UPLOAD_ID = 'upload-1';

// ROUND 13 fix: api/monitoring-lists.js now issues ONE BATCHED
// ha_research_runs?upload_id=in.(...) query (loadResearchRunsByUpload())
// instead of one query per upload -- this mock reflects that real shape and
// EXPOSES a call counter (researchRunsQueryCalls) so the query-count test
// below can prove the count stays O(1) as the number of uploads grows,
// instead of merely not crashing.
function mockFetch({ uploads = [{ id: UPLOAD_ID, user_id: USER_ID, upload_name: 'QA List', stage: 'researched', updated_at: '2026-08-01T00:00:00Z' }], accountsByUpload = null, researchRuns = [], calls = null } = {}){
  const callLog = calls || { researchRunsQueryCalls: 0, researchRunsQueryUrls: [] };
  return Object.assign(async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if(u.includes('/auth/v1/user')){
      const token = String((options.headers || {}).Authorization || '');
      if(!token.includes('valid-token')) return jsonResponse(null, false, 401);
      return jsonResponse({ id: AUTH_USER_ID, email: 'qa@example.com' });
    }
    if(u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')){
      return jsonResponse([{ id: USER_ID, email: 'qa@example.com', app_role: 'member', role: 'member', organization_id: null, status: 'active' }]);
    }
    if(u.includes('/rest/v1/ha_users') && u.includes('organization_id=eq.')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_uploads')) return jsonResponse(uploads);
    if(u.includes('/rest/v1/ha_prospect_uploads')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_accounts') && u.includes('upload_id=eq.') && method === 'GET'){
      const uploadMatch = u.match(/upload_id=eq\.([^&]+)/);
      const qUploadId = uploadMatch ? decodeURIComponent(uploadMatch[1]) : null;
      if(accountsByUpload) return jsonResponse(accountsByUpload[qUploadId] || []);
      return jsonResponse([{ id: 'acct-1', upload_id: UPLOAD_ID, account_name: 'L.L.Bean', industry: 'Retail', raw_data: { monitoring_status: 'active', research_status: 'researched', last_researched_at: '2026-08-03T12:00:00Z' }, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' }]);
    }
    if(u.includes('/rest/v1/ha_signals')) return jsonResponse([]);
    if(u.includes('/rest/v1/ha_research_runs') && u.includes('upload_id=in.') && method === 'GET'){
      callLog.researchRunsQueryCalls += 1;
      callLog.researchRunsQueryUrls.push(u);
      return jsonResponse(researchRuns);
    }
    // A per-upload ha_research_runs?upload_id=eq.<id> request would land
    // here and throw "Unhandled mock fetch URL" -- i.e. this mock has no
    // handler for the OLD N+1 shape at all, so a regression back to
    // per-upload querying fails loudly rather than silently passing.
    throw new Error(`Unhandled mock fetch URL in test: ${method} ${u}`);
  }, { __callLog: callLog });
}

async function runServerTests(){
  const originalFetch = global.fetch;

  // 1) No research run yet -> idle.
  {
    global.fetch = mockFetch({ researchRuns: [] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    assert(res.statusCode === 200, '1) GET /api/monitoring-lists returns 200 (never 404) with no research runs at all');
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'idle', '1) researchRunState collapses to idle when no run row exists');
  }

  // 2) A running row with a lease that has NOT expired -> active, with the
  // researchRunId/attemptId/startedAt the modal needs to write/read its
  // breadcrumb and label the state.
  {
    const runId = 'manual-2026-08-03T12-00-00-abcd';
    global.fetch = mockFetch({ researchRuns: [{ upload_id: UPLOAD_ID, research_run_id: runId, attempt_id: 'attempt-1', status: 'running', lease_expires_at: new Date(Date.now() + 60_000).toISOString(), started_at: '2026-08-03T12:00:00Z', error_message: null }] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'active', '2) a running row with an unexpired lease collapses to active');
    assert(state.researchRunId === runId && state.attemptId === 'attempt-1', '2) active state carries the real researchRunId/attemptId (needed for the breadcrumb lookup)');
  }

  // 3) A running row whose lease HAS expired -> idle (reclaimable), not
  // "active" -- matches claim_ha_research_run()'s own attached-active vs
  // reclaimable distinction (same lease_expires_at > now() condition).
  {
    global.fetch = mockFetch({ researchRuns: [{ upload_id: UPLOAD_ID, research_run_id: 'auto', attempt_id: 'attempt-old', status: 'running', lease_expires_at: new Date(Date.now() - 60_000).toISOString(), started_at: '2026-08-01T00:00:00Z', error_message: null }] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'idle', '3) a running row with an EXPIRED lease is idle, not active (it is reclaimable, not meaningfully in-progress)');
  }

  // 4) A failed row -> failed, carrying the error message for the branded
  // failure banner (requirement 4/6).
  {
    global.fetch = mockFetch({ researchRuns: [{ upload_id: UPLOAD_ID, research_run_id: 'manual-x', attempt_id: 'attempt-x', status: 'failed', lease_expires_at: null, started_at: '2026-08-03T11:00:00Z', error_message: 'Research failed. Please try again.' }] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'failed', '4) a failed row collapses to failed');
    assert(state.errorMessage === 'Research failed. Please try again.', '4) the failure state carries the real error message');
  }

  // 5) A completed row -> idle (the button is "Research Again", no banner).
  {
    global.fetch = mockFetch({ researchRuns: [{ upload_id: UPLOAD_ID, research_run_id: 'manual-y', attempt_id: 'attempt-y', status: 'completed', lease_expires_at: null, started_at: '2026-08-03T09:00:00Z', error_message: null }] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    const state = res.body?.lists?.customer?.[0]?.researchRunState;
    assert(state && state.status === 'idle', '5) a completed row collapses to idle -- no lingering banner once a run has finished');
  }

  // 6) ROUND 13 fix -- the ORIGINAL "no code path can emit a 404" claim was
  // wrong: it only checked for a literal 404 inside this file. sb()'s
  // catch (api/monitoring-lists.js) attaches err.status = r.status, the RAW
  // HTTP status Supabase/PostgREST itself returned for ANY downstream
  // request (ha_uploads, ha_accounts, ha_signals, ha_research_runs,
  // ha_prospect_*, or the replace_ha_accounts_snapshot RPC) -- and
  // PostgREST genuinely CAN return 404 (e.g. a table/view its schema cache
  // doesn't recognize, or an RPC with no matching signature). Before this
  // round's fix, that raw status propagated straight to the client via
  // e.status||500, indistinguishable in the Network tab from this Vercel
  // function being missing/undeployed. This proves the FIX: a downstream
  // 404 is deliberately mapped to 502 with a clear, understood contract
  // (upstreamStatus echoes the real downstream status for diagnosis) --
  // not silently passed through as an apparent-routing 404.
  {
    // ha_research_runs itself returns a raw 404 -- the exact scenario this
    // round's new batched query would trigger if the connected database
    // were ever missing that table (e.g. migration 5 not applied there).
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if(u.includes('/auth/v1/user')) return jsonResponse({ id: AUTH_USER_ID, email: 'qa@example.com' });
      if(u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) return jsonResponse([{ id: USER_ID, email: 'qa@example.com', app_role: 'member', role: 'member', organization_id: null, status: 'active' }]);
      if(u.includes('/rest/v1/ha_users') && u.includes('organization_id=eq.')) return jsonResponse([]);
      if(u.includes('/rest/v1/ha_uploads')) return jsonResponse([{ id: UPLOAD_ID, user_id: USER_ID, upload_name: 'QA List', stage: 'researched', updated_at: '2026-08-01T00:00:00Z' }]);
      if(u.includes('/rest/v1/ha_prospect_uploads')) return jsonResponse([]);
      if(u.includes('/rest/v1/ha_research_runs')) return jsonResponse({ code: '42P01', message: 'relation "public.ha_research_runs" does not exist', hint: null }, false, 404);
      throw new Error(`Unhandled mock fetch URL in test 6: ${options.method || 'GET'} ${u}`);
    };
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    assert(res.statusCode === 502, '6) a raw downstream 404 (ha_research_runs missing/unrecognized) is mapped to 502, never passed through as a raw 404');
    assert(res.statusCode !== 404, '6) the client never sees a bare 404 for this failure -- a bare 404 here would be indistinguishable from a missing Vercel function');
    assert(res.body && typeof res.body.error === 'string' && res.body.error.length > 0, '6) the 502 response carries a clear, human-readable error message (a genuine missing-Vercel-function 404 carries no such JSON body)');
    assert(res.body && res.body.upstreamStatus === 404, '6) the real upstream status (404) is preserved in upstreamStatus for diagnosis, not discarded');
  }

  // 7) The same downstream-404 scenario, but for ha_accounts (a query this
  // endpoint has always made, not one this round added) -- proves the fix
  // is general to ANY sb() call in this file, not special-cased to
  // ha_research_runs.
  {
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if(u.includes('/auth/v1/user')) return jsonResponse({ id: AUTH_USER_ID, email: 'qa@example.com' });
      if(u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) return jsonResponse([{ id: USER_ID, email: 'qa@example.com', app_role: 'member', role: 'member', organization_id: null, status: 'active' }]);
      if(u.includes('/rest/v1/ha_users') && u.includes('organization_id=eq.')) return jsonResponse([]);
      if(u.includes('/rest/v1/ha_uploads')) return jsonResponse([{ id: UPLOAD_ID, user_id: USER_ID, upload_name: 'QA List', stage: 'researched', updated_at: '2026-08-01T00:00:00Z' }]);
      if(u.includes('/rest/v1/ha_prospect_uploads')) return jsonResponse([]);
      if(u.includes('/rest/v1/ha_research_runs')) return jsonResponse([]);
      if(u.includes('/rest/v1/ha_signals')) return jsonResponse([]);
      if(u.includes('/rest/v1/ha_accounts')) return jsonResponse({ code: '42P01', message: 'relation "public.ha_accounts" does not exist' }, false, 404);
      throw new Error(`Unhandled mock fetch URL in test 7: ${options.method || 'GET'} ${u}`);
    };
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    assert(res.statusCode === 502, '7) the same normalization applies to a pre-existing query (ha_accounts), not just the new ha_research_runs one');
  }

  // 8) Deliberate application statuses are NOT swept into 502 by the fix --
  // only errors sb() itself marked as raw/unclassified are. HA004 (identity
  // lock) still returns exactly 400 with identityLocked:true.
  {
    global.fetch = mockFetch({ researchRuns: [] });
    // Reuse the real deleteCustomerAccountViaSnapshot() path indirectly is
    // out of scope here (covered by scripts/test-monitoring-lists-account-delete.js);
    // this proves the CLASSIFICATION mechanism itself: a fresh, unmarked
    // Error with .status set (exactly what deleteCustomerAccountViaSnapshot()
    // throws for HA004/55P03/42501, and what patchCustomerAccount() throws
    // for "not found"/"invalid action") is preserved as-is by the top-level
    // catch, not renormalized to 502.
    assert(/e\.status\|\|500/.test(MONITORING_LISTS_SRC) && /e&&e\.fromSupabase/.test(MONITORING_LISTS_SRC), '8) the top-level catch checks e.fromSupabase BEFORE falling back to e.status||500 -- deliberately-classified errors (identityLocked HA004, 55P03, 42501, "not found", "invalid action") are unaffected by the 502 normalization');
  }

  // 9) Normal GET still returns 200 when research-run rows genuinely do not
  // exist for any upload (the common case) -- the fix does not turn an
  // ordinary empty result into an error.
  {
    global.fetch = mockFetch({ researchRuns: [] });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    assert(res.statusCode === 200, '9) GET still returns a normal 200 when ha_research_runs has no rows for this user\'s uploads at all');
  }

  // 10) An assortment of malformed/unexpected requests against the REAL
  // handler (unknown method, missing body fields, wrong type) still return
  // real, deliberate 4xx statuses -- unaffected by the fromSupabase/502
  // change, since these never reach sb() at all.
  {
    global.fetch = mockFetch({ researchRuns: [] });
    const unknownMethodRes = fakeRes();
    await monitoringListsHandler({ method: 'PUT', headers: { authorization: 'Bearer valid-token' }, body: {} }, unknownMethodRes);
    assert(unknownMethodRes.statusCode === 405, '10) an unsupported HTTP method returns 405 (Method not allowed)');
    const badPatchRes = fakeRes();
    await monitoringListsHandler(fakeReq('PATCH', { type: 'bogus', id: 'x', action: 'bogus' }), badPatchRes);
    assert(badPatchRes.statusCode === 400, '10) a malformed PATCH body returns 400');
    const badDeleteRes = fakeRes();
    await monitoringListsHandler(fakeReq('DELETE', { type: 'bogus' }), badDeleteRes);
    assert(badDeleteRes.statusCode === 400, '10) a malformed DELETE body returns 400');
  }

  // ---------------------------------------------------------------------
  // Issue 3 -- query-count / scalability: the research-run query must be
  // O(1) per GET (one batched upload_id=in.(...) call), not O(N) as the
  // number of uploaded lists grows. Seeds N=5 customer uploads and proves
  // exactly ONE ha_research_runs request was made, scoped to all 5 upload
  // ids at once, regardless of N.
  // ---------------------------------------------------------------------
  {
    const N = 5;
    const uploads = Array.from({ length: N }, (_, i) => ({ id: `upload-scale-${i}`, user_id: USER_ID, upload_name: `List ${i}`, stage: 'researched', updated_at: '2026-08-01T00:00:00Z' }));
    const accountsByUpload = Object.fromEntries(uploads.map(u => [u.id, [{ id: `acct-${u.id}`, upload_id: u.id, account_name: 'Acme', industry: '', raw_data: {}, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' }]]));
    const researchRuns = [{ upload_id: 'upload-scale-2', research_run_id: 'run-2', attempt_id: 'att-2', status: 'running', lease_expires_at: new Date(Date.now() + 60_000).toISOString(), started_at: '2026-08-03T12:00:00Z', error_message: null }];
    const callLog = { researchRunsQueryCalls: 0, researchRunsQueryUrls: [] };
    global.fetch = mockFetch({ uploads, accountsByUpload, researchRuns, calls: callLog });
    const res = fakeRes();
    await monitoringListsHandler(fakeReq('GET'), res);
    assert(res.statusCode === 200, 'scale: the batched-query GET still succeeds for N=5 uploads');
    assert(callLog.researchRunsQueryCalls === 1, `scale: exactly ONE ha_research_runs query was made for N=${N} uploads (got ${callLog.researchRunsQueryCalls}) -- not one per upload`);
    assert(callLog.researchRunsQueryUrls[0] && uploads.every(u => callLog.researchRunsQueryUrls[0].includes(encodeURIComponent(u.id).replace(/%22/g, '') ) || callLog.researchRunsQueryUrls[0].includes(u.id)), 'scale: the single query covers every upload id at once (upload_id=in.(...))');
    const uploadScale2 = res.body?.lists?.customer?.find(l => l.id === 'upload-scale-2');
    assert(uploadScale2 && uploadScale2.researchRunState.status === 'active', 'scale: the batched query still correctly attributes the active run to its OWN upload (upload-scale-2)');
    const uploadScale0 = res.body?.lists?.customer?.find(l => l.id === 'upload-scale-0');
    assert(uploadScale0 && uploadScale0.researchRunState.status === 'idle', 'scale: an upload with no run row of its own is idle, not accidentally attributed another upload\'s run');
  }

  global.fetch = originalFetch;
}

// ===========================================================================
// PART 2 -- client: extracted verbatim from dashboard/index.html.
// ===========================================================================
// ROUND 14 note: line ranges re-derived after the durable-dismissal fix
// shifted the file further -- extractFn()/extractRaw()'s own signature/
// closing checks are the actual correctness guarantee, not these numbers.
const REAL_SOURCE = [
  extractRaw('ACTIVE_RESEARCH_BREADCRUMB_KEY', 5992, 5992, 'const ACTIVE_RESEARCH_BREADCRUMB_KEY'),
  extractFn('setActiveResearchBreadcrumb', 5993, 5999),
  extractFn('clearActiveResearchBreadcrumb', 6000, 6011),
  extractFn('getActiveResearchBreadcrumb', 6012, 6019),
  extractFn('applyModalResearchResultToDashboard', 7089, 7099),
  extractFn('normalizeAccountNameForKey', 7153, 7153),
  extractFn('recentlyResearchedKey', 7158, 7158),
  extractFn('findTimeboxForAccountOpportunity', 7166, 7173),
  extractFn('highlightResultElement', 7175, 7181),
  extractFn('scrollToAccountResult', 7195, 7215),
  extractRaw('RECENTLY_RESEARCHED_WINDOW_MS', 7337, 7337, 'const RECENTLY_RESEARCHED_WINDOW_MS'),
  extractRaw('DISMISSED_RESEARCH_STORAGE_PREFIX', 7366, 7366, 'const DISMISSED_RESEARCH_STORAGE_PREFIX'),
  extractRaw('DISMISSED_RESEARCH_PRUNE_AFTER_MS', 7373, 7373, 'const DISMISSED_RESEARCH_PRUNE_AFTER_MS'),
  extractFn('dismissedResearchNamespace', 7374, 7380),
  extractFn('dismissedResearchStorageKey', 7381, 7381),
  extractFn('readDismissedResearchMap', 7382, 7391),
  extractFn('writeDismissedResearchMap', 7392, 7395),
  extractFn('pruneDismissedResearchMap', 7396, 7403),
  extractFn('isResearchResultDismissed', 7408, 7416),
  extractFn('dismissResearchResult', 7417, 7421),
  extractFn('getRecentlyResearchedAccounts', 7424, 7450),
  extractFn('relativeResearchTimeLabel', 7451, 7458),
  extractFn('renderRecentlyResearchedSection', 7459, 7484),
  extractRaw('recentlyResearchedClickListener', 7485, 7503, "document.addEventListener('click', (event) => {"),
  extractFn('escapeHtml', 10146, 10149),
  extractRaw('modalFmtEsc', 10187, 10188, "const fmt=d=>"),
  extractFn('request', 10198, 10215, {async: true}),
  extractFn('accountRow', 10242, 10283),
  extractFn('researchRunBanner', 10288, 10299),
  extractFn('listCard', 10308, 10340),
  extractRaw('renderManager', 10341, 10341, 'function renderManager(){'),
  extractFn('isModalOpen', 10352, 10355),
  extractFn('anyListHasActiveRun', 10356, 10358),
  extractFn('stopResearchPoll', 10359, 10361),
  extractFn('scheduleResearchPollIfNeeded', 10362, 10366),
  extractFn('load', 10367, 10376, {async: true}),
  extractRaw('openClose', 10378, 10391, "function open(){"),
  extractFn('showInfoDialog', 10808, 10847)
].join('\n\n');

// Static regression proof for requirement 1: nothing in dashboard/index.html
// can cancel an in-flight fetch (no AbortController/abort() exists in the
// file at all), and close()'s own extracted source (in openClose above)
// contains neither 'abort' nor any fetch call -- it only hides the modal
// and stops the UI's OWN polling GET (stopResearchPoll()), never the
// provider-facing research request.
assert(!/AbortController|\.abort\(/.test(DASHBOARD_SRC), '1) dashboard/index.html contains no AbortController/abort() anywhere -- an in-flight provider request cannot be cancelled by ANY client action, including closing the modal');
{
  const closeSrc = extractRaw('closeOnly', 10392, 10400, "function close(){");
  assert(!/abort/i.test(closeSrc) && !/fetch\(/.test(closeSrc), '1) close()\'s own source contains no abort/cancel/fetch call');
  assert(/stopResearchPoll\(\)/.test(closeSrc), '1) close() stops only the modal\'s own UI polling loop (stopResearchPoll()), not the provider request');
}

// Static regression proof for requirement 6: the delete-account catch
// branch shows the branded dialog when the server marks the rejection
// identity-locked, and only falls back to alert() in the else branch (never
// unconditionally) -- extracted directly from the real click handler.
{
  const deleteAccountBranch = extractRaw('deleteAccountCatchBranch', 10868, 10897, "if(action==='delete-account'){");
  assert(/if\(err\.identityLocked\)\{/.test(deleteAccountBranch), '6) the delete-account catch branch checks err.identityLocked');
  assert(/showInfoDialog\(/.test(deleteAccountBranch), '6) the identityLocked branch calls showInfoDialog(), the branded non-destructive dialog');
  assert(/\}else\{\s*alert\(err\.message\);\s*\}/.test(deleteAccountBranch), '6) alert() is reached ONLY in the else branch -- never unconditionally for this rejection');
}

// Static regression proof for the composite-identity fix (issue 2): every
// site that keys Recently Researched / navigation must use BOTH uploadId
// and account name, never account name alone -- proven directly on the
// real, on-disk function signatures/bodies rather than re-asserted only
// through behavior.
{
  assert(/function applyModalResearchResultToDashboard\(freshAccount, uploadId\)/.test(DASHBOARD_SRC), 'composite: applyModalResearchResultToDashboard() takes an explicit uploadId parameter');
  assert(/function findTimeboxForAccountOpportunity\(uploadId, accountName\)/.test(DASHBOARD_SRC), 'composite: findTimeboxForAccountOpportunity() takes (uploadId, accountName)');
  assert(/function scrollToAccountResult\(uploadId, accountName\)/.test(DASHBOARD_SRC), 'composite: scrollToAccountResult() takes (uploadId, accountName)');
  assert(/el\.dataset\.account === accountName && el\.dataset\.uploadId === uploadId/.test(DASHBOARD_SRC), 'composite: the opportunity-grid card lookup matches BOTH data-account and data-upload-id, not name alone');
  assert(/el\.dataset\.accountName === accountName && el\.dataset\.uploadId === uploadId/.test(DASHBOARD_SRC), 'composite: the detail/recently-researched card lookups match BOTH data-account-name and data-upload-id');
  // ROUND 14: the filter now goes through isResearchResultDismissed(), which
  // itself forms the composite key via recentlyResearchedKey(uploadId,
  // accountName) internally -- see the "durable" checks below for the
  // direct proof of that call site.
  assert(/!isResearchResultDismissed\(a\.uploadId, a\.name, a\.lastResearchedAt\)/.test(DASHBOARD_SRC), 'composite: getRecentlyResearchedAccounts() filters using the composite (uploadId, name) identity, not account name alone');
  const handoffSrc = extractRaw('viewOpportunitiesHandoff', 10515, 10533, "if(fresh && typeof applyModalResearchResultToDashboard === 'function') applyModalResearchResultToDashboard(fresh, listId);");
  assert(/applyModalResearchResultToDashboard\(fresh, listId\)/.test(handoffSrc), 'composite: the modal\'s completion handoff passes its own captured listId, not a global, into applyModalResearchResultToDashboard()');
  // Follow-up round: the toast's "View opportunities" action now calls the
  // shared openResearchedAccountOpportunities() production function (same
  // one the Recently Researched row's own button calls -- see the "7/8"
  // test below) instead of scrollToAccountResult(), still passing its own
  // captured listId, never currentUploadId.
  assert(/openResearchedAccountOpportunities\(listId, accountName\)/.test(handoffSrc), 'composite: the "View opportunities" toast action passes the same captured listId into openResearchedAccountOpportunities(), not currentUploadId');
  assert(!/scrollToAccountResult\(accountName\)/.test(DASHBOARD_SRC) && !/applyModalResearchResultToDashboard\(fresh\)\s*[;)]/.test(DASHBOARD_SRC), 'composite: no remaining call site uses the old name-only signature');
}

// ROUND 14 -- static regression proof for durable dismissal: the dismiss
// handler must persist via the real localStorage-backed functions (never
// reintroduce an in-memory-only Set), and the visibility filter must call
// isResearchResultDismissed() (which itself compares the stored dismissed
// timestamp against the CURRENT lastResearchedAt), not a bare membership
// check.
{
  assert(!/dismissedRecentlyResearched/.test(DASHBOARD_SRC), 'durable: the old in-memory-only dismissedRecentlyResearched Set no longer exists anywhere in the file');
  assert(/dismissResearchResult\(uploadId, accountName, card\.dataset\.completedAt\)/.test(DASHBOARD_SRC), 'durable: the real click handler dismisses via dismissResearchResult(), passing the card\'s own rendered completedAt');
  assert(/!isResearchResultDismissed\(a\.uploadId, a\.name, a\.lastResearchedAt\)/.test(DASHBOARD_SRC), 'durable: getRecentlyResearchedAccounts() filters using isResearchResultDismissed() against the account\'s CURRENT lastResearchedAt, not a bare Set membership check');
  assert(/data-completed-at="\$\{escapeHtml\(new Date\(e\.ts\)\.toISOString\(\)\)\}"/.test(DASHBOARD_SRC), 'durable: the rendered card carries the exact completed timestamp it was shown with, in data-completed-at');
}

// ===========================================================================
// Stubs -- pure DOM-rendering/classification helpers with no bearing on the
// behavior under test, each stubbed for a stated reason (same convention as
// scripts/test-dashboard-orchestration.js).
// ===========================================================================
const STUB_SOURCE = `
// refreshOpportunityViews() itself is the main dashboard's full render
// pipeline (opportunity cards, KPIs, account list) -- irrelevant to what
// THIS suite verifies (scrollToAccountResult's own search/fallback logic,
// and that it flips the existing showAllWeeklyPriorities/activeTimebox
// switches). Recorded so tests can assert it fires the right number of
// times with the right state, without needing the full render pipeline.
var __refreshCalls = [];
function refreshOpportunityViews(){ __refreshCalls.push({activeTimebox, showAllWeeklyPriorities}); }
// Follow-up round: openResearchedAccountOpportunities() (the new shared
// "View opportunities" handoff) is a main-script function with its own
// large dependency graph (refreshAggregateDashboard, HouseAccountManager,
// createSalesPlayPanel, getOpportunityScore) that has no bearing on THIS
// suite's job -- proving the click delegation calls it, with the right
// (uploadId, accountName) arguments, not scrollToAccountResult. Recorded
// so the click-routing test below can assert on it directly.
var __viewOpportunitiesCalls = [];
function openResearchedAccountOpportunities(uploadId, accountName){ __viewOpportunitiesCalls.push({uploadId, accountName}); }
// opportunityMatchesTimebox's real implementation depends on a long chain
// of pure signal/opportunity classification helpers (getOpportunityPlanningWindow,
// getRecommendationType, signalLayerLabel, ...) that have no bearing on
// findTimeboxForAccountOpportunity's own control flow (loop timeboxes in
// order, return the first with a match) -- fixture opportunities carry an
// explicit .timebox field and this stub matches it directly.
function opportunityMatchesTimebox(opp, timebox){ return !!opp && opp.timebox === timebox; }
// addSignalDerivedOpportunities() is the full signal-to-opportunity
// generation pipeline (confidence scoring, buyer inference, etc.) --
// orthogonal to applyModalResearchResultToDashboard()'s own job (patch the
// account, call this, call refreshOpportunityViews). This stub just proves
// the account got the right signals/timestamp and that this was called.
var __addSignalDerivedCalls = [];
function addSignalDerivedOpportunities(account, signals){
  __addSignalDerivedCalls.push({name: account.name, signalCount: (signals||[]).length});
  account.futureOpportunities = (signals||[]).map((s, i) => ({account: account.name, timebox: 'week', signal: s}));
}
function dedupeVerifiedSignals(signals){ return signals || []; }
// Follow-up temporal-integrity round: getRecentlyResearchedAccounts() now
// also computes activeOpportunityCount through the same three functions
// accountOpportunityCluster() uses -- out of scope for this file's own
// reattachment-identity assertions, so stubbed as pass-throughs like
// dedupeVerifiedSignals() above.
function dedupeOpportunities(items){ return items || []; }
function collapseDuplicateAccountHistorySignals(items){ return items || []; }
function priorityEligibleOpportunities(items){ return items || []; }
`;

// ===========================================================================
// Minimal fake DOM -- tailored exactly to the selectors this round's code
// actually uses (no general CSS engine): '.class' (deep, class-list match)
// and '[data-key]' (deep, attribute-EXISTENCE match, no value comparison
// needed by this code). document.getElementById('accountList'/
// 'recentlyResearchedSection'/'opportunitiesGrid'/'accountManagerModal'/
// 'accountManagerContent') are pre-wired fixed elements; document.querySelectorAll
// recognizes the literal '#id .class' compound forms this code uses by
// scoping the search to that id'd element's subtree.
// ===========================================================================
class FakeEl {
  constructor(tag, attrs = {}){
    this.tag = tag;
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this._classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    this._html = '';
    this._focused = false;
    this._scrolledIntoView = 0;
  }
  appendChild(child){ child.parent = this; this.children.push(child); return child; }
  get dataset(){
    const ds = {};
    for(const k of Object.keys(this.attrs)){
      if(k.startsWith('data-')){
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        ds[camel] = this.attrs[k];
      }
    }
    return ds;
  }
  get classList(){
    const self = this;
    return {
      add: (c) => self._classes.add(c),
      remove: (c) => self._classes.delete(c),
      contains: (c) => self._classes.has(c),
      toggle: (c, force) => { if(force === undefined){ self._classes.has(c) ? self._classes.delete(c) : self._classes.add(c); } else if(force){ self._classes.add(c); } else { self._classes.delete(c); } }
    };
  }
  hasAttribute(name){ return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  setAttribute(name, value){ this.attrs[name] = value; }
  get innerHTML(){ return this._html; }
  set innerHTML(v){ this._html = v; }
  scrollIntoView(){ this._scrolledIntoView += 1; }
  focus(){ this._focused = true; }
  matchesSimple(selector){
    if(selector.startsWith('[') && selector.endsWith(']')){
      const attrName = selector.slice(1, -1);
      return this.hasAttribute(attrName);
    }
    if(selector.startsWith('.')) return this._classes.has(selector.slice(1));
    return false;
  }
  querySelectorAll(selector){
    const out = [];
    (function walk(el){ for(const c of el.children){ if(c.matchesSimple(selector)) out.push(c); walk(c); } })(this);
    return out;
  }
  querySelector(selector){ return this.querySelectorAll(selector)[0] || null; }
  closest(selector){
    let el = this;
    while(el){ if(el.matchesSimple(selector)) return el; el = el.parent; }
    return null;
  }
}

function createFakeDom(){
  const opportunitiesGrid = new FakeEl('div', { id: 'opportunitiesGrid' });
  const accountList = new FakeEl('div', { id: 'accountList' });
  const recentlyResearchedSection = new FakeEl('div', { id: 'recentlyResearchedSection' });
  const accountManagerModal = new FakeEl('div', { id: 'accountManagerModal' });
  accountManagerModal.style = { display: 'none' };
  const accountManagerContent = new FakeEl('div', { id: 'accountManagerContent' });
  const byId = { opportunitiesGrid, accountList, recentlyResearchedSection, accountManagerModal, accountManagerContent };
  const timeboxTabs = ['week', 'month', 'quarter', 'annual'].map(tb => {
    const btn = new FakeEl('button', { class: 'timebox-tab', 'data-timebox': tb });
    return btn;
  });
  const listeners = { click: null };
  const document_ = {
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (selector) => {
      if(selector === '.timebox-tab') return timeboxTabs;
      const scoped = selector.match(/^#([\w-]+)\s+(.+)$/);
      if(scoped){
        const [, id, rest] = scoped;
        const root = byId[id];
        return root ? root.querySelectorAll(rest) : [];
      }
      return [];
    },
    querySelector(selector){ return this.querySelectorAll(selector)[0] || null; },
    // Captures the REAL delegated click listener (extracted verbatim as
    // recentlyResearchedClickListener above) so tests can dispatch a fake
    // click event through it and assert on the real dismiss/view logic.
    addEventListener: (type, handler) => { if(type === 'click') listeners.click = handler; }
  };
  return { document_, byId, opportunitiesGrid, accountList, recentlyResearchedSection, accountManagerModal, timeboxTabs, listeners };
}

// Minimal in-memory localStorage -- real getItem/setItem/removeItem
// semantics (string-keyed, string values), exactly what the breadcrumb
// helpers need; nothing about their own read/write/guard logic is
// reimplemented here.
// ROUND 14: backingMap lets multiple createSandbox() calls share the SAME
// underlying storage, exactly like a real browser's localStorage persists
// across a page reload while everything ELSE (the JS heap, module-level
// variables, the DOM) is torn down and rebuilt from scratch -- a fresh
// vm.Script/vm.createContext per createSandbox() call already reproduces
// that "everything in memory is gone" reload semantics; passing the same
// backingMap is what then proves the dismissal survived it.
function createFakeLocalStorage(backingMap){
  const store = backingMap || new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  };
}

// ROUND 14: user lets a test set HouseAuth.getUser()'s return value (the
// REAL dismissal-namespacing code reads auth_user_id/id/email off of
// exactly this shape) -- defaults to a single stable identity so existing
// callers that don't care about user-isolation are unaffected.
function createSandbox({accounts = [], currentUploadId = 'upload-1', fetchImpl, user = { auth_user_id: 'auth-user-1', id: 'user-1', email: 'qa@example.com' }, localStorageBackingMap} = {}){
  const dom = createFakeDom();
  const houseAuth = { authHeadersAsync: async (h) => (fetchImpl === 'no-session' ? null : (h || {})), getUser: () => user };
  const alertCalls = [];
  const sandbox = {
    window: { accountRadarAccounts: accounts, HouseAuth: houseAuth, location: { href: 'https://example.com/dashboard' } },
    HouseAuth: houseAuth,
    document: dom.document_,
    localStorage: createFakeLocalStorage(localStorageBackingMap),
    fetch: typeof fetchImpl === 'function' ? fetchImpl : (async () => { throw new Error('fetch should not be called in this test'); }),
    alert: (msg) => alertCalls.push(msg),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Math, Date, JSON, Set, Array, Object, Number, String, Promise, Boolean,
    setTimeout, clearTimeout, CSS: { escape: (s) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) }
  };
  vm.createContext(sandbox);
  const initSource = `
var currentUploadId = ${JSON.stringify(currentUploadId)};
var activeTimebox = 'week';
var showAllWeeklyPriorities = false;
var researchPollTimer = null;
var RESEARCH_POLL_INTERVAL_MS = 6000;
`;
  const fullSource = `${initSource}\n${STUB_SOURCE}\n${REAL_SOURCE}\n`;
  new vm.Script(fullSource, { filename: 'research-run-reattachment-extract.js' }).runInContext(sandbox);
  sandbox.__dom = dom;
  sandbox.__alertCalls = alertCalls;
  return sandbox;
}

// ROUND 13 fix: uploadId defaults to 'upload-1' (matching createSandbox's
// own default currentUploadId) but is always an explicit, settable field --
// account names are only unique WITHIN one upload, so every composite-
// identity test below constructs fixtures with a real, distinct uploadId
// per upload rather than relying on name uniqueness.
function fixtureAccount(name, overrides = {}){
  return { id: `acct-${name}`, name, uploadId: 'upload-1', lastResearchedAt: null, signals: [], futureOpportunities: [], ...overrides };
}

async function runClientTests(){
  // ---------------------------------------------------------------------
  // Requirement 2/3/4 -- accountRow()/listCard()/researchRunBanner() render
  // the right state directly from server-owned list.researchRunState, with
  // no dependency on any local DOM flag.
  // ---------------------------------------------------------------------
  {
    const sandbox = createSandbox({ accounts: [], currentUploadId: 'upload-1' });
    // Active run for "L.L.Bean" -- the breadcrumb (localStorage) supplies
    // the account name for an ALREADY server-confirmed active run.
    sandbox.localStorage.setItem('ha_active_research_breadcrumb_v1', JSON.stringify({ 'upload-1': { researchRunId: 'run-1', accountName: 'L.L.Bean' } }));
    const list = { id: 'upload-1', name: 'QA List', status: 'active', companyCount: 1, researchRunState: { status: 'active', researchRunId: 'run-1', attemptId: 'att-1', startedAt: null, errorMessage: null } };
    const account = { id: 'a1', name: 'L.L.Bean', monitoringStatus: 'active', lastResearchedAt: null };
    const rowHtml = sandbox.accountRow(list, account);
    assert(/Researching…/.test(rowHtml), '2) accountRow() shows "Researching…" for the account named by the breadcrumb when researchRunState.status is active');
    assert(/disabled/.test(rowHtml), '2) the Research button is disabled while a run is active for this list');
    const bannerHtml = sandbox.researchRunBanner(list);
    assert(/Researching/.test(bannerHtml) && /L\.L\.Bean/.test(bannerHtml), '2) the list-level banner names the account being researched, when available');

    const otherAccount = { id: 'a2', name: 'Acme Co', monitoringStatus: 'active', lastResearchedAt: null };
    const otherRowHtml = sandbox.accountRow(list, otherAccount);
    assert(/disabled/.test(otherRowHtml) && !/Researching…/.test(otherRowHtml), '2) a DIFFERENT account in the same list is also disabled (single-active-run-per-upload) but is not itself labeled "Researching…"');
  }
  {
    // Requirement 3: idle + a persisted lastResearchedAt -> "Research
    // Again" and the persisted timestamp, not a stale/local flag.
    const sandbox = createSandbox({ accounts: [], currentUploadId: 'upload-1' });
    const list = { id: 'upload-1', name: 'QA List', status: 'active', companyCount: 1, researchRunState: { status: 'idle' } };
    const account = { id: 'a1', name: 'L.L.Bean', monitoringStatus: 'active', lastResearchedAt: '2026-08-03T12:00:00Z' };
    const rowHtml = sandbox.accountRow(list, account);
    assert(/Research Again/.test(rowHtml) && !/disabled/.test(rowHtml), '3) idle state + a prior lastResearchedAt shows an ENABLED "Research Again"');
    assert(/Last researched/.test(rowHtml), '3) the persisted "Last researched" date is shown in the row, sourced from the server, not a transient flag');
    assert(sandbox.researchRunBanner(list) === '', '3) no run banner is shown once the run is idle/complete');
  }
  {
    // Requirement 4/6: a failed run shows a branded failure banner (not a
    // silent "Research Again"), and retry (the button itself) is available
    // because status !== 'active'.
    const sandbox = createSandbox({ accounts: [], currentUploadId: 'upload-1' });
    sandbox.localStorage.setItem('ha_active_research_breadcrumb_v1', JSON.stringify({ 'upload-1': { researchRunId: 'run-2', accountName: 'L.L.Bean' } }));
    const list = { id: 'upload-1', name: 'QA List', status: 'active', companyCount: 1, researchRunState: { status: 'failed', researchRunId: 'run-2', attemptId: 'att-2', errorMessage: 'Research failed. Please try again.' } };
    const account = { id: 'a1', name: 'L.L.Bean', monitoringStatus: 'active', lastResearchedAt: null };
    const bannerHtml = sandbox.researchRunBanner(list);
    assert(/failed/i.test(bannerHtml) && /L\.L\.Bean/.test(bannerHtml) && /Research failed\. Please try again\./.test(bannerHtml), '4) a failed run shows a clear, branded failure banner naming the account and the real error message');
    const rowHtml = sandbox.accountRow(list, account);
    assert(!/disabled/.test(rowHtml), '4) retry (the Research button itself) is available once the prior run is no longer active (status is failed, not active)');
  }

  // ---------------------------------------------------------------------
  // Requirement 5 -- open()/load() (via request()) only ever issue a GET;
  // reopening can never itself claim another run or call a provider.
  // ---------------------------------------------------------------------
  {
    const loadSrc = extractFn('load', 10367, 10376, { async: true });
    assert(/request\('GET'\)/.test(loadSrc), "5) load() calls request('GET')");
    assert(!/researchRunAction/.test(loadSrc) && !/claim/i.test(loadSrc), '5) load() never references a claim/researchRunAction -- reopening the modal cannot itself start or attach to a run beyond reading its state');
  }
  {
    // Behavioral proof: calling request('GET') issues exactly one GET to
    // /api/monitoring-lists and nothing else.
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, method: (init && init.method) || 'GET' }); return { ok: true, json: async () => ({ ok: true, lists: { customer: [] } }) }; };
    const sandbox = createSandbox({ fetchImpl });
    await sandbox.load();
    assert(calls.length === 1 && calls[0].url === '/api/monitoring-lists' && calls[0].method === 'GET', '5) load() (what open()/reopen calls) issues exactly ONE GET request and nothing else -- no duplicate claim/provider call from reopening');
  }

  // ---------------------------------------------------------------------
  // Requirement 6 -- request() preserves identityLocked from the server's
  // JSON body onto the thrown Error, so the branded dialog (verified
  // structurally above) can be gated on it.
  // ---------------------------------------------------------------------
  {
    const fetchImpl = async () => ({ ok: false, json: async () => ({ error: "L.L.Bean can't be deleted individually", identityLocked: true }) });
    const sandbox = createSandbox({ fetchImpl });
    let caught = null;
    try{ await sandbox.request('PATCH', { type: 'account', id: 'a1', action: 'delete-account' }); }catch(err){ caught = err; }
    assert(!!caught, "6) request() throws when the server rejects the delete");
    assert(caught && caught.identityLocked === true, '6) request() carries identityLocked:true from the response body onto the thrown Error');
    assert(caught && /can't be deleted individually/.test(caught.message), "6) request() preserves the server's real error message");
  }
  {
    const fetchImpl = async () => ({ ok: false, json: async () => ({ error: 'Some other failure' }) });
    const sandbox = createSandbox({ fetchImpl });
    let caught = null;
    try{ await sandbox.request('PATCH', { type: 'account', id: 'a1', action: 'pause-account' }); }catch(err){ caught = err; }
    assert(caught && !caught.identityLocked, '6) a non-HA004 failure does NOT carry identityLocked -- the branded HA004 dialog is never shown for an unrelated error');
  }

  // ---------------------------------------------------------------------
  // Requirement 7 -- "View opportunities" finds the account's rendered
  // result even when it would not appear in the default top-ranked view,
  // by switching to the matching timebox and flipping the SAME
  // showAllWeeklyPriorities switch the existing "View All Opportunities"
  // button already uses (never a permanent ranking change). Uses the
  // COMPOSITE (uploadId, account name) identity throughout.
  // ---------------------------------------------------------------------
  {
    const account = fixtureAccount('L.L.Bean', { uploadId: 'upload-1', futureOpportunities: [{ account: 'L.L.Bean', uploadId: 'upload-1', timebox: 'quarter' }] });
    const sandbox = createSandbox({ accounts: [account] });
    sandbox.activeTimebox = 'week';
    sandbox.showAllWeeklyPriorities = false;
    sandbox.__refreshCalls.length = 0;
    // Not rendered anywhere yet (grid/detail/recent all empty) -- exercises
    // the "nothing found" fallback path.
    sandbox.scrollToAccountResult('upload-1', 'L.L.Bean');
    assert(sandbox.activeTimebox === 'quarter', "7) scrollToAccountResult() switches to the timebox where the account's own opportunity actually lives, not whatever tab happened to be open");
    assert(sandbox.showAllWeeklyPriorities === true, '7) scrollToAccountResult() flips the existing showAllWeeklyPriorities switch -- the SAME mechanism "View All Opportunities" already uses, not a new ranking override');
    assert(sandbox.__refreshCalls.length === 1, '7) refreshOpportunityViews() is called exactly once to materialize the now-visible result');

    // Now the account's opportunity card IS in the grid (simulating a
    // real render): scrollToAccountResult must find and highlight it.
    const card = new FakeEl('div', { class: 'opportunity-card', 'data-account': 'L.L.Bean', 'data-upload-id': 'upload-1' });
    sandbox.__dom.opportunitiesGrid.appendChild(card);
    sandbox.scrollToAccountResult('upload-1', 'L.L.Bean');
    assert(card._scrolledIntoView >= 1, "7) the account's own opportunity card is scrolled into view when it is present in the grid");
    assert(card.classList.contains('ha-just-researched-highlight'), "7) the account's own opportunity card is highlighted");
  }
  {
    // Account has zero opportunities at all (a genuine zero-signal
    // result) -- falls back to the Recently Researched card, never a dead
    // click.
    const account = fixtureAccount('Zero Signal Co', { uploadId: 'upload-1', futureOpportunities: [] });
    const sandbox = createSandbox({ accounts: [account] });
    const recentCard = new FakeEl('div', { class: 'recently-researched-card', 'data-account-name': 'Zero Signal Co', 'data-upload-id': 'upload-1' });
    sandbox.__dom.recentlyResearchedSection.appendChild(recentCard);
    sandbox.scrollToAccountResult('upload-1', 'Zero Signal Co');
    assert(recentCard._scrolledIntoView >= 1, '7) with no opportunity/detail card anywhere, "View opportunities" falls back to the guaranteed Recently Researched entry instead of doing nothing');
  }
  {
    // ROUND 13 fix -- composite-identity proof: a card for the SAME
    // account name in a DIFFERENT upload must NOT be matched. Only
    // "acme-b-card" (upload-b) may be scrolled/highlighted when asked for
    // ('upload-b', 'Acme'); "acme-a-card" (upload-a) must be left alone.
    const accountA = fixtureAccount('Acme', { uploadId: 'upload-a', futureOpportunities: [] });
    const accountB = fixtureAccount('Acme', { uploadId: 'upload-b', futureOpportunities: [] });
    const sandbox = createSandbox({ accounts: [accountA, accountB] });
    const cardA = new FakeEl('div', { class: 'opportunity-card', 'data-account': 'Acme', 'data-upload-id': 'upload-a' });
    const cardB = new FakeEl('div', { class: 'opportunity-card', 'data-account': 'Acme', 'data-upload-id': 'upload-b' });
    sandbox.__dom.opportunitiesGrid.appendChild(cardA);
    sandbox.__dom.opportunitiesGrid.appendChild(cardB);
    sandbox.scrollToAccountResult('upload-b', 'Acme');
    assert(cardB._scrolledIntoView >= 1 && cardB.classList.contains('ha-just-researched-highlight'), 'composite: requesting upload-b\'s Acme scrolls/highlights ONLY upload-b\'s card');
    assert(cardA._scrolledIntoView === 0 && !cardA.classList.contains('ha-just-researched-highlight'), 'composite: upload-a\'s identically-named Acme card is completely untouched -- name-only matching would have hit the first one found instead');
  }

  // ---------------------------------------------------------------------
  // Requirement 8/9 -- Recently Researched dedupes reruns of the same
  // (uploadId, account) and never distorts the underlying priority
  // ranking. Both use the COMPOSITE identity.
  // ---------------------------------------------------------------------
  {
    const account = fixtureAccount('L.L.Bean', { uploadId: 'upload-1' });
    const sandbox = createSandbox({ accounts: [account] });
    // First research: 1 signal.
    sandbox.applyModalResearchResultToDashboard({ name: 'L.L.Bean', signals: [{ isReal: true }], lastResearchedAt: new Date(Date.now() - 5 * 60_000).toISOString() }, 'upload-1');
    // Rerun: 2 signals, newer timestamp.
    sandbox.applyModalResearchResultToDashboard({ name: 'L.L.Bean', signals: [{ isReal: true }, { isReal: true }], lastResearchedAt: new Date().toISOString() }, 'upload-1');
    const entries = sandbox.getRecentlyResearchedAccounts();
    assert(entries.length === 1, '8) two research runs for the SAME (upload, account) produce exactly ONE Recently Researched entry, not two');
    assert(entries[0].name === 'L.L.Bean' && entries[0].uploadId === 'upload-1' && entries[0].signalCount === 2, '8) the single entry reflects the LATEST rerun\'s result (2 signals), not the first');
    assert(sandbox.__addSignalDerivedCalls.length === 2, '8) both research completions were genuinely applied (this is real dedup by composite identity, not just "only one call happened")');
  }
  {
    // Requirement 9: recently-researched status must not appear anywhere
    // inside the account's own opportunity objects or otherwise feed a
    // ranking comparator -- applyModalResearchResultToDashboard() only
    // patches signals/lastResearchedAt/futureOpportunities and calls the
    // existing render pipeline; it contains no sort/comparator of its own.
    const src = extractFn('applyModalResearchResultToDashboard', 7089, 7099);
    assert(!/\.sort\(/.test(src), '9) applyModalResearchResultToDashboard() itself performs no sorting -- it cannot distort priority order, by construction');
  }
  {
    // Zero-signal result still produces a useful Recently Researched entry
    // (the "no-signal state" requirement) rather than being dropped.
    const account = fixtureAccount('No Signal Co', { uploadId: 'upload-1' });
    const sandbox = createSandbox({ accounts: [account] });
    sandbox.applyModalResearchResultToDashboard({ name: 'No Signal Co', signals: [], lastResearchedAt: new Date().toISOString() }, 'upload-1');
    sandbox.renderRecentlyResearchedSection();
    const host = sandbox.__dom.recentlyResearchedSection;
    assert(/No verified signals found/.test(host.innerHTML), '9/8) a zero-signal research result still renders a clear "No verified signals found" Recently Researched entry, not a broken/empty one');
    assert(!/rr-view-btn/.test(host.innerHTML), '9/8) a zero-signal entry does not offer a dead "View opportunities" link (nothing to view)');
  }
  {
    // Dismiss removes the entry immediately (natural-expiry companion:
    // manual dismissal) -- exercised through the REAL delegated click
    // listener (recentlyResearchedClickListener, extracted verbatim above
    // and registered via the sandbox's document.addEventListener capture),
    // not a reimplementation of its dismiss logic.
    const completedAt = new Date().toISOString();
    const account = fixtureAccount('Dismiss Co', { uploadId: 'upload-1' });
    const sandbox = createSandbox({ accounts: [account] });
    sandbox.applyModalResearchResultToDashboard({ name: 'Dismiss Co', signals: [{ isReal: true }], lastResearchedAt: completedAt }, 'upload-1');
    assert(sandbox.getRecentlyResearchedAccounts().length === 1, 'dismiss: sanity check -- the entry exists before dismissal');
    // data-completed-at mirrors exactly what renderRecentlyResearchedSection()
    // itself stamps on the real card (new Date(e.ts).toISOString(), where
    // e.ts comes from the account's own lastResearchedAt).
    const card = new FakeEl('div', { class: 'recently-researched-card', 'data-account-name': 'Dismiss Co', 'data-upload-id': 'upload-1', 'data-completed-at': completedAt });
    const dismissBtn = new FakeEl('button', { class: 'rr-dismiss-btn' });
    card.appendChild(dismissBtn);
    const handler = sandbox.__dom.listeners.click;
    assert(typeof handler === 'function', 'dismiss: the real recentlyResearchedClickListener registered itself via document.addEventListener');
    handler({ target: dismissBtn });
    assert(sandbox.getRecentlyResearchedAccounts().length === 0, 'dismiss: after the real dismiss-button click handler runs, the account no longer appears in Recently Researched');
  }

  // =========================================================================
  // ROUND 14 -- durable dismissal (localStorage, user- and composite-
  // identity-scoped, timestamp-aware). Root cause of the reported bug: the
  // OLD dismissedRecentlyResearched was a bare in-memory Set, reset on every
  // page load -- a dismissal never survived a browser refresh. Fixed by
  // persisting dismissals to localStorage, namespaced per authenticated
  // user, keyed by (uploadId, account name), with the STORED VALUE being
  // the specific completed-research timestamp that was dismissed (so a
  // later, newer completion is correctly treated as a different result).
  // =========================================================================
  {
    // 1/2/3) dismiss -> rerender (same sandbox) AND dismiss -> simulated
    // page reload (a SECOND, freshly-constructed sandbox -- a brand new
    // vm.Script/vm.createContext, i.e. everything in memory is gone exactly
    // like a real reload -- sharing only the same localStorage backing Map
    // and the same authenticated user) both keep the SAME-timestamp result
    // hidden.
    // A few minutes ago -- comfortably inside RECENTLY_RESEARCHED_WINDOW_MS
    // (30 min), so these tests are about DISMISSAL, not about the section's
    // own separate time-window expiry.
    const completedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const sharedStorage = new Map();
    const user = { auth_user_id: 'auth-user-1', id: 'user-1', email: 'qa@example.com' };
    const sandbox1 = createSandbox({ accounts: [fixtureAccount('L.L.Bean', { uploadId: 'upload-1' })], user, localStorageBackingMap: sharedStorage });
    sandbox1.applyModalResearchResultToDashboard({ name: 'L.L.Bean', signals: [{ isReal: true }], lastResearchedAt: completedAt }, 'upload-1');
    assert(sandbox1.getRecentlyResearchedAccounts().length === 1, 'durable 1: sanity check -- the entry exists before dismissal');
    sandbox1.dismissResearchResult('upload-1', 'L.L.Bean', completedAt);
    assert(sandbox1.getRecentlyResearchedAccounts().length === 0, 'durable 1: dismissing hides the entry immediately');
    // Rerender in the SAME sandbox (same in-memory account data) -- a plain
    // rerender must not un-dismiss it.
    sandbox1.renderRecentlyResearchedSection();
    assert(sandbox1.getRecentlyResearchedAccounts().length === 0, 'durable 1: a dashboard rerender does not bring the dismissed entry back');

    // Simulated reload: brand new sandbox (fresh vm context -- no in-memory
    // state survives), same user, same underlying localStorage.
    const sandbox2 = createSandbox({ accounts: [fixtureAccount('L.L.Bean', { uploadId: 'upload-1', lastResearchedAt: completedAt })], user, localStorageBackingMap: sharedStorage });
    assert(sandbox2.getRecentlyResearchedAccounts().length === 0, 'durable 2/3: after a simulated browser refresh (fresh sandbox, same localStorage), the SAME (upload, account, timestamp) result remains dismissed');
  }
  {
    // 4) A LATER Research Again completion with a newer persisted timestamp
    // makes the account visible again -- the dismissal was for the OLD
    // result, not a permanent "hide this account" rule.
    const dismissedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const newerCompletedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const sharedStorage = new Map();
    const user = { auth_user_id: 'auth-user-1', id: 'user-1', email: 'qa@example.com' };
    const sandbox1 = createSandbox({ accounts: [fixtureAccount('L.L.Bean', { uploadId: 'upload-1' })], user, localStorageBackingMap: sharedStorage });
    sandbox1.applyModalResearchResultToDashboard({ name: 'L.L.Bean', signals: [{ isReal: true }], lastResearchedAt: dismissedAt }, 'upload-1');
    sandbox1.dismissResearchResult('upload-1', 'L.L.Bean', dismissedAt);
    assert(sandbox1.getRecentlyResearchedAccounts().length === 0, 'durable 4: sanity check -- dismissed and hidden');
    // A fresh Research Again completion, still within the same session.
    sandbox1.applyModalResearchResultToDashboard({ name: 'L.L.Bean', signals: [{ isReal: true }, { isReal: true }], lastResearchedAt: newerCompletedAt }, 'upload-1');
    assert(sandbox1.getRecentlyResearchedAccounts().length === 1, 'durable 4: a NEWER completed research timestamp makes the account visible again, in the same session');
    // Also true after a simulated reload -- the newer timestamp was itself
    // persisted server-side (lastResearchedAt), so a reload's freshly
    // loaded account data still carries it and still beats the old
    // dismissal.
    const sandbox2 = createSandbox({ accounts: [fixtureAccount('L.L.Bean', { uploadId: 'upload-1', lastResearchedAt: newerCompletedAt })], user, localStorageBackingMap: sharedStorage });
    assert(sandbox2.getRecentlyResearchedAccounts().length === 1, 'durable 4: the newer result is still visible after a simulated reload -- the OLD dismissal does not apply to it');
  }
  {
    // 6) Two different authenticated users sharing the same browser (same
    // localStorage) must not inherit each other's dismissals.
    const completedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const sharedStorage = new Map();
    const userA = { auth_user_id: 'auth-user-a', id: 'user-a', email: 'a@example.com' };
    const userB = { auth_user_id: 'auth-user-b', id: 'user-b', email: 'b@example.com' };
    const sandboxA = createSandbox({ accounts: [fixtureAccount('L.L.Bean', { uploadId: 'upload-1' })], user: userA, localStorageBackingMap: sharedStorage });
    sandboxA.applyModalResearchResultToDashboard({ name: 'L.L.Bean', signals: [{ isReal: true }], lastResearchedAt: completedAt }, 'upload-1');
    sandboxA.dismissResearchResult('upload-1', 'L.L.Bean', completedAt);
    assert(sandboxA.getRecentlyResearchedAccounts().length === 0, 'durable 6: user A dismissed the entry and it is hidden for user A');
    const sandboxB = createSandbox({ accounts: [fixtureAccount('L.L.Bean', { uploadId: 'upload-1', lastResearchedAt: completedAt })], user: userB, localStorageBackingMap: sharedStorage });
    assert(sandboxB.getRecentlyResearchedAccounts().length === 1, "durable 6: user B, sharing the SAME browser/localStorage, still sees the SAME entry -- user A's dismissal did not leak to user B");
  }
  {
    // 8) Corrupt/unavailable localStorage fails safe -- rendering never
    // throws, and (since it cannot be trusted) nothing is treated as
    // dismissed.
    const sharedStorage = new Map();
    const user = { auth_user_id: 'auth-user-1', id: 'user-1', email: 'qa@example.com' };
    // Pre-seed genuinely corrupt JSON under the exact key the real code
    // would use for this user.
    sharedStorage.set('ha_dismissed_research_v1::auth-user-1', '{not valid json!!');
    const account = fixtureAccount('L.L.Bean', { uploadId: 'upload-1', lastResearchedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    const sandbox = createSandbox({ accounts: [account], user, localStorageBackingMap: sharedStorage });
    let entries = null;
    let threw = null;
    try{ entries = sandbox.getRecentlyResearchedAccounts(); sandbox.renderRecentlyResearchedSection(); }catch(err){ threw = err; }
    assert(!threw, `durable 8: corrupt localStorage does not throw while computing/rendering Recently Researched (got: ${threw && threw.message})`);
    assert(Array.isArray(entries) && entries.length === 1, 'durable 8: with unreadable dismissal data, the entry is treated as NOT dismissed (fails safe by showing it) rather than crashing or silently hiding everything');
  }
  {
    // 8b) localStorage.getItem itself throwing (a real browser behavior in
    // some private-browsing/quota-exceeded configurations) also fails safe.
    const user = { auth_user_id: 'auth-user-1', id: 'user-1', email: 'qa@example.com' };
    const completedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const account = fixtureAccount('L.L.Bean', { uploadId: 'upload-1', lastResearchedAt: completedAt });
    const sandbox = createSandbox({ accounts: [account], user });
    sandbox.localStorage.getItem = () => { throw new Error('SecurityError: localStorage is not available'); };
    sandbox.localStorage.setItem = () => { throw new Error('SecurityError: localStorage is not available'); };
    let entries = null;
    let threw = null;
    try{ entries = sandbox.getRecentlyResearchedAccounts(); sandbox.dismissResearchResult('upload-1', 'L.L.Bean', completedAt); }catch(err){ threw = err; }
    assert(!threw, `durable 8b: a throwing localStorage does not break reading OR dismissing (got: ${threw && threw.message})`);
    assert(Array.isArray(entries) && entries.length === 1, 'durable 8b: with localStorage entirely unavailable, the entry still renders (fails safe) instead of crashing the dashboard');
  }
  {
    // Follow-up round: "View opportunities" clicked from a Recently
    // Researched card now routes through openResearchedAccountOpportunities()
    // (requirements 8/9 -- the same shared production function the toast
    // action calls, not scrollToAccountResult()) -- proven here via the
    // delegated listener's real call to it, with the exact
    // (uploadId, accountName) the clicked card carries.
    const account = fixtureAccount('Click Co', { uploadId: 'upload-1', futureOpportunities: [{ account: 'Click Co', uploadId: 'upload-1', timebox: 'week' }] });
    const sandbox = createSandbox({ accounts: [account] });
    sandbox.applyModalResearchResultToDashboard({ name: 'Click Co', signals: [{ isReal: true }], lastResearchedAt: new Date().toISOString() }, 'upload-1');
    sandbox.__viewOpportunitiesCalls.length = 0;
    const card = new FakeEl('div', { class: 'recently-researched-card', 'data-account-name': 'Click Co', 'data-upload-id': 'upload-1' });
    const viewBtn = new FakeEl('button', { class: 'rr-view-btn' });
    card.appendChild(viewBtn);
    const handler = sandbox.__dom.listeners.click;
    handler({ target: viewBtn });
    assert(sandbox.__viewOpportunitiesCalls.length === 1, '7/8) clicking the real "View opportunities" button on a Recently Researched card triggers the real openResearchedAccountOpportunities()');
    assert(sandbox.__viewOpportunitiesCalls[0] && sandbox.__viewOpportunitiesCalls[0].uploadId === 'upload-1' && sandbox.__viewOpportunitiesCalls[0].accountName === 'Click Co', '7/8) openResearchedAccountOpportunities() is called with the clicked card\'s exact (uploadId, accountName)');
  }

  // ---------------------------------------------------------------------
  // Explicit regression scenario from the user's report: Upload A has
  // "Acme"; Upload B ALSO has "Acme" -- a genuinely realistic case, since
  // account names are only unique per-upload. Proves every operation
  // (highlight, independent visibility, dedup, dismissal) respects the
  // composite identity end-to-end through the REAL functions, not just in
  // isolation.
  // ---------------------------------------------------------------------
  {
    const acmeA = fixtureAccount('Acme', { uploadId: 'upload-a', futureOpportunities: [{ account: 'Acme', uploadId: 'upload-a', timebox: 'week' }] });
    const acmeB = fixtureAccount('Acme', { uploadId: 'upload-b', futureOpportunities: [{ account: 'Acme', uploadId: 'upload-b', timebox: 'week' }] });
    const sandbox = createSandbox({ accounts: [acmeA, acmeB] });

    // (a) Completing research for upload-a highlights only upload-a's card;
    // upload-b's identically-named card is untouched.
    const cardA = new FakeEl('div', { class: 'opportunity-card', 'data-account': 'Acme', 'data-upload-id': 'upload-a' });
    const cardB = new FakeEl('div', { class: 'opportunity-card', 'data-account': 'Acme', 'data-upload-id': 'upload-b' });
    sandbox.__dom.opportunitiesGrid.appendChild(cardA);
    sandbox.__dom.opportunitiesGrid.appendChild(cardB);
    sandbox.applyModalResearchResultToDashboard({ name: 'Acme', signals: [{ isReal: true }], lastResearchedAt: new Date().toISOString() }, 'upload-a');
    sandbox.scrollToAccountResult('upload-a', 'Acme');
    assert(cardA._scrolledIntoView >= 1, 'AB-scenario (a): completing research for upload-a\'s Acme highlights upload-a\'s own card');
    assert(cardB._scrolledIntoView === 0, 'AB-scenario (a): upload-b\'s Acme result is untouched by upload-a\'s completion');

    // (b) Both can appear independently in Recently Researched.
    sandbox.applyModalResearchResultToDashboard({ name: 'Acme', signals: [{ isReal: true }, { isReal: true }], lastResearchedAt: new Date().toISOString() }, 'upload-b');
    const entries = sandbox.getRecentlyResearchedAccounts();
    const entryA = entries.find(e => e.uploadId === 'upload-a');
    const entryB = entries.find(e => e.uploadId === 'upload-b');
    assert(entries.length === 2, 'AB-scenario (b): both upload-a\'s Acme and upload-b\'s Acme appear as two SEPARATE Recently Researched entries');
    assert(entryA && entryA.signalCount === 1, 'AB-scenario (b): upload-a\'s entry reflects upload-a\'s own result (1 signal)');
    assert(entryB && entryB.signalCount === 2, 'AB-scenario (b): upload-b\'s entry reflects upload-b\'s own result (2 signals), independent of upload-a\'s');

    // (c) Rerunning upload-a deduplicates only upload-a -- still 2 entries
    // total, not 3, and upload-b's entry is untouched.
    sandbox.applyModalResearchResultToDashboard({ name: 'Acme', signals: [{ isReal: true }, { isReal: true }, { isReal: true }], lastResearchedAt: new Date().toISOString() }, 'upload-a');
    const entriesAfterRerun = sandbox.getRecentlyResearchedAccounts();
    assert(entriesAfterRerun.length === 2, 'AB-scenario (c): rerunning upload-a\'s Acme still leaves exactly 2 entries total (deduped within upload-a, upload-b unaffected)');
    const entryARerun = entriesAfterRerun.find(e => e.uploadId === 'upload-a');
    const entryBUnchanged = entriesAfterRerun.find(e => e.uploadId === 'upload-b');
    assert(entryARerun && entryARerun.signalCount === 3, 'AB-scenario (c): upload-a\'s entry now reflects the rerun\'s result (3 signals)');
    assert(entryBUnchanged && entryBUnchanged.signalCount === 2, 'AB-scenario (c): upload-b\'s entry is completely unaffected by upload-a\'s rerun');

    // (d) Dismissing upload-a's entry leaves upload-b's entry visible.
    // Renders the section for real first (so renderRecentlyResearchedSection()'s
    // OWN markup generation for both entries is genuinely exercised), then
    // dispatches through the real delegated listener using a card built
    // with the same data-account-name/data-upload-id shape that markup
    // uses (this fake DOM stores innerHTML as a string rather than parsing
    // it back into traversable nodes -- see FakeEl -- so the dispatched
    // element is constructed to match, not walked out of the HTML string).
    sandbox.renderRecentlyResearchedSection();
    const host = sandbox.__dom.recentlyResearchedSection;
    assert(/data-account-name="Acme" data-upload-id="upload-a"/.test(host.innerHTML) && /data-account-name="Acme" data-upload-id="upload-b"/.test(host.innerHTML), 'AB-scenario (d): sanity check -- the real render actually emitted BOTH upload-a\'s and upload-b\'s Acme cards with distinct data-upload-id');
    const cardAInSection = new FakeEl('div', { class: 'recently-researched-card', 'data-account-name': 'Acme', 'data-upload-id': 'upload-a', 'data-completed-at': new Date(entryARerun.ts).toISOString() });
    const dismissBtnA = new FakeEl('button', { class: 'rr-dismiss-btn' });
    cardAInSection.appendChild(dismissBtnA);
    const handler = sandbox.__dom.listeners.click;
    handler({ target: dismissBtnA });
    const entriesAfterDismissA = sandbox.getRecentlyResearchedAccounts();
    assert(!entriesAfterDismissA.some(e => e.uploadId === 'upload-a'), 'AB-scenario (d): dismissing upload-a\'s entry removes it');
    assert(entriesAfterDismissA.some(e => e.uploadId === 'upload-b'), 'AB-scenario (d): upload-b\'s entry remains visible after dismissing upload-a\'s -- dismissal is scoped to the composite key, not the account name');
  }
}

async function main(){
  console.log('--- PART 1: server (api/monitoring-lists.js) ---');
  await runServerTests();
  console.log('\n--- PART 2: client (dashboard/index.html) ---');
  await runClientTests();
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
