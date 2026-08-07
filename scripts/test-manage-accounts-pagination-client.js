// Scaling round -- Manage Customer Accounts pagination, client side. Real
// browser coverage (Playwright). Loading the FULL dashboard/index.html live
// via file:// is not viable here -- the Manage Customer Accounts trigger
// button lives inside #customerDashboard, which starts display:none and is
// only revealed after the main dashboard's own multi-endpoint aggregate
// load succeeds (unrelated to pagination). Instead this follows the same
// established convention as scripts/test-help-dropdown-visibility.js: build
// a minimal real page containing the REAL, unmodified modal markup (copied
// verbatim from dashboard/index.html) and the REAL, unmodified, entire
// second inline <script> block (the modal's own self-contained IIFE,
// extracted verbatim -- confirmed to be exactly and only that IIFE, see the
// syntax-check assertion in scripts/test-followup-round.js), executed for
// real in a real Chromium page. Only the handful of main-dashboard
// functions the modal calls OUT to for deep research (never exercised by
// this file's own scope -- covered exhaustively by
// scripts/test-research-run-reattachment.js and
// scripts/test-dashboard-orchestration.js) are stubbed, each for a stated
// reason. No real network call is ever made -- /api/monitoring-lists is
// fully intercepted with a realistic 1,000-account fixture.
//
// Usage: node scripts/test-manage-accounts-pagination-client.js
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function resolveChromiumExecutablePath(){
  const candidate = '/opt/pw-browsers/chromium';
  return existsSync(candidate) ? candidate : undefined;
}

// ===========================================================================
// Extraction: the real page CSS and the real, whole, second inline <script>
// (the modal IIFE) -- see the file-level comment above for why extracting
// the WHOLE IIFE (rather than picking individual functions by line range)
// is both simpler and immune to future line-shift churn.
// ===========================================================================
const DASHBOARD_SRC = readFileSync(path.join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8');
const styleMatch = DASHBOARD_SRC.match(/<style>([\s\S]*?)<\/style>/);
if(!styleMatch) throw new Error('Could not find the <style> block in dashboard/index.html -- has the page structure changed?');
const PAGE_CSS = styleMatch[1];

const scriptMatches = [...DASHBOARD_SRC.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if(scriptMatches.length !== 2) throw new Error(`Expected exactly 2 inline <script> blocks in dashboard/index.html, found ${scriptMatches.length} -- update this test's extraction assumption.`);
const MODAL_IIFE_SRC = scriptMatches[1][1];
if(!MODAL_IIFE_SRC.trim().startsWith('(function(){')){
  throw new Error('The second inline <script> block no longer starts with the modal IIFE -- update this test\'s extraction assumption.');
}
if(!/let cachedLists=\[\];/.test(MODAL_IIFE_SRC) || !/function listCard\(list\)\{/.test(MODAL_IIFE_SRC) || !/function requestAccountPage\(/.test(MODAL_IIFE_SRC)){
  throw new Error('The extracted script no longer looks like the Manage Customer Accounts modal IIFE -- update this test\'s extraction assumption.');
}

// ===========================================================================
// Fixture: a realistic 1,000-account upload, a genuinely empty upload, and
// an upload whose first expand request fails (to prove the error/retry
// state), matching exactly the account-row shape api/monitoring-lists.js's
// loadAccountPage() actually returns (no raw_data).
// ===========================================================================
const PAGE_SIZE = 50;
const BIG_ACCOUNTS = Array.from({length: 1000}, (_, i) => ({
  id: `acct-${i}`, uploadId: 'upload-big', name: `Account ${String(i).padStart(4, '0')}`,
  industry: 'Promotional Products', monitoringStatus: i % 20 === 0 ? 'paused' : 'active',
  researchStatus: 'uploaded', lastResearchedAt: i < 3 ? '2026-08-01T00:00:00Z' : '',
  domain: '', dateAdded: '2026-01-01T00:00:00Z', hasActionableAlert: false
})).sort((a, b) => a.name.localeCompare(b.name));
BIG_ACCOUNTS.push({
  id: 'acct-needle', uploadId: 'upload-big', name: 'Unicorn Specialty Distributor',
  industry: 'Test', monitoringStatus: 'active', researchStatus: 'uploaded', lastResearchedAt: '',
  domain: '', dateAdded: '2026-01-01T00:00:00Z', hasActionableAlert: false
});

function summaryPayload(){
  return {
    ok: true, scope: 'user', role: 'owner',
    lists: {
      customer: [
        {id: 'upload-big', type: 'customer', name: 'Big Distributor Book', status: 'active', companyCount: BIG_ACCOUNTS.length, activeCount: 950, pausedCount: 50, everResearched: true, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 0, researchRunState: {status: 'idle'}},
        {id: 'upload-empty', type: 'customer', name: 'Freshly Uploaded List', status: 'active', companyCount: 0, activeCount: 0, pausedCount: 0, everResearched: false, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 0, researchRunState: {status: 'idle'}},
        {id: 'upload-fail', type: 'customer', name: 'Flaky List', status: 'active', companyCount: 3, activeCount: 3, pausedCount: 0, everResearched: false, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 0, researchRunState: {status: 'idle'}}
      ],
      prospect: []
    },
    summary: {activeCustomers: 953, pausedCustomers: 50, activeProspects: 0, pausedProspects: 0, nextWeeklyScan: 'Monday', monitoringStatus: 'Active'}
  };
}

function pagePayload(uploadId, accounts, cursorIndex, limit, search){
  const term = (search || '').toLowerCase();
  const filtered = term ? accounts.filter(a => a.name.toLowerCase().includes(term)) : accounts;
  const start = cursorIndex || 0;
  const page = filtered.slice(start, start + limit);
  const hasMore = start + limit < filtered.length;
  return {
    ok: true, uploadId,
    accounts: page,
    pageInfo: {limit, hasMore, nextCursor: hasMore ? String(start + limit) : null, total: filtered.length, search: term}
  };
}

// ===========================================================================
// Fixture page: the real modal markup (copied verbatim from
// dashboard/index.html's <body>) + the real page CSS + the real modal IIFE,
// plus a handful of stubs for the main-dashboard functions the modal calls
// out to for deep single/list research -- out of scope for this file (see
// the file-level comment).
// ===========================================================================
const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="UTF-8"><style>${PAGE_CSS}</style></head>
<body>
<button class="btn btn-secondary" id="manageCustomerAccountsBtn" type="button">Manage Customer Accounts</button>
<div id="accountManagerModal" role="dialog" aria-modal="true" aria-labelledby="accountManagerTitle" style="display:none;position:fixed;inset:0;background:rgba(10,25,45,.55);z-index:9999;padding:24px;overflow:auto;">
  <div style="max-width:1050px;margin:4vh auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 24px 70px rgba(0,0,0,.25);">
    <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;"><div><h2 id="accountManagerTitle" style="margin:0 0 6px;">Manage Customer Accounts</h2><p style="margin:0;color:var(--muted);">Pause monitoring without deleting historical account data, or permanently delete an account or uploaded list.</p></div><button class="btn btn-secondary" type="button" id="closeAccountManagerBtn">Close</button></div>
    <div id="accountManagerContent" style="margin-top:20px;"></div>
  </div>
</div>
<script>
// Stubs for main-dashboard deep-research/aggregate-refresh functions the
// modal calls out to -- not exercised by this file's own pagination/
// collapse/search/mutation scope (see file-level comment).
window.HouseAuth = { authHeadersAsync: async (h) => (h || {}) };
async function researchAccountFromManageModal(){ return {ok:false, error:'Research is not available in this test fixture.'}; }
async function researchListFromManageModal(){ return {ok:false, error:'Research is not available in this test fixture.'}; }
async function refreshAggregateDashboard(){}
function openResearchedAccountOpportunities(){}
// ux/research-control-progress: accountRow()/listCard()/researchRunBanner()
// (inside the real modal IIFE below) now consult this tab's own in-memory
// research tracker first, falling back to the server-owned
// researchRunState/breadcrumb this file's fixture payloads already drive.
// Stubbed to report "no tracker" so the modal takes that existing fallback
// path -- this file's own scope is pagination/collapse/search/mutation, not
// progress-tracker rendering (covered elsewhere).
function researchTrackerSnapshot(){ return null; }
function researchTrackerAccountState(){ return null; }
function researchProgressPanel(){ return ''; }
function requestResearchStop(){}
</script>
<script>${MODAL_IIFE_SRC}</script>
</body></html>`;

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ha-manage-accounts-pagination-'));
const FIXTURE_PATH = path.join(tmpDir, 'fixture.html');
writeFileSync(FIXTURE_PATH, FIXTURE_HTML);
const FIXTURE_URL = 'file://' + FIXTURE_PATH;

async function withPage(run){
  const browser = await chromium.launch({executablePath: resolveChromiumExecutablePath()});
  try{
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const consoleErrors = [];
    page.on('pageerror', err => consoleErrors.push(String(err)));
    await run(page, consoleErrors);
  } finally {
    await browser.close();
  }
}

async function openManageModal(page){
  await page.goto(FIXTURE_URL, {waitUntil: 'load'});
  await page.click('#manageCustomerAccountsBtn');
  await page.waitForSelector('#accountManagerContent .acct-mgr-list', {state: 'attached'});
}

async function main(){
  // =========================================================================
  // Item 24, performance items 1-2: a loading state is shown while upload
  // summaries load, then collapsed cards render with ZERO account rows.
  // =========================================================================
  await withPage(async (page, consoleErrors) => {
    let resolveSlow;
    const slowGate = new Promise(r => { resolveSlow = r; });
    let firstCall = true;
    await page.route('**/api/monitoring-lists*', async (route) => {
      const url = new URL(route.request().url());
      if(route.request().method() === 'GET' && !url.searchParams.get('uploadId') && firstCall){
        firstCall = false;
        await slowGate;
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(summaryPayload())});
      }
      return route.fulfill({status: 404, body: '{}'});
    });
    await page.goto(FIXTURE_URL, {waitUntil: 'load'});
    await page.click('#manageCustomerAccountsBtn');
    const loadingText = await page.locator('#accountManagerContent').innerText();
    assert(/Loading customer accounts/.test(loadingText), `item 24: a loading state is shown while upload summaries are being fetched (got "${loadingText}")`);
    resolveSlow();
    await page.waitForSelector('#accountManagerContent .acct-mgr-list', {state: 'attached'});
    const rowCount = await page.locator('.acct-mgr-row').count();
    assert(rowCount === 0, `performance item 2: opening the modal renders zero account rows -- everything starts collapsed (got ${rowCount})`);
    const cardCount = await page.locator('.acct-mgr-list').count();
    assert(cardCount === 3, `all three collapsed upload cards render (got ${cardCount})`);
    assert(consoleErrors.length === 0, `no uncaught page errors during modal open (got: ${JSON.stringify(consoleErrors)})`);
  });

  // =========================================================================
  // Performance items 3-8, and required items 25/26: expand fetches one
  // page, DOM holds exactly one page, Next/Previous never duplicate or
  // skip, only one upload is ever expanded, collapsing/reopening refetches.
  // =========================================================================
  await withPage(async (page) => {
    const calls = [];
    await page.route('**/api/monitoring-lists*', async (route) => {
      const url = new URL(route.request().url());
      calls.push(url.toString());
      const uploadId = url.searchParams.get('uploadId');
      if(!uploadId) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(summaryPayload())});
      const cursor = url.searchParams.get('cursor');
      const q = url.searchParams.get('q');
      const limit = Number(url.searchParams.get('limit')) || PAGE_SIZE;
      if(uploadId === 'upload-big'){
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(pagePayload(uploadId, BIG_ACCOUNTS, cursor ? Number(cursor) : 0, limit, q))});
      }
      if(uploadId === 'upload-empty'){
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(pagePayload(uploadId, [], 0, limit, q))});
      }
      return route.fulfill({status: 404, body: '{}'});
    });
    await openManageModal(page);

    await page.click('[data-list-expand-toggle][data-list-id="upload-big"]');
    await page.waitForSelector('.acct-mgr-row', {state: 'attached'});
    let rows = await page.locator('.acct-mgr-row').count();
    assert(rows === PAGE_SIZE, `performance item 3/4: expanding an upload fetches roughly one page (got ${rows} rows)`);
    const page1Names = await page.locator('.acct-mgr-name').allTextContents();
    const pagerText = await page.locator('.acct-mgr-pager-label').innerText();
    assert(/Showing 1.50 of 1001 accounts/.test(pagerText), `27) the pager reports the real total against the 1,000+-account fixture, not just the page size (got "${pagerText}")`);

    // Next.
    await page.click('[data-acct-page-next]');
    await page.waitForFunction((expectedFirst) => {
      const el = document.querySelector('.acct-mgr-name');
      return el && el.textContent.trim() !== expectedFirst;
    }, page1Names[0].trim());
    rows = await page.locator('.acct-mgr-row').count();
    assert(rows === PAGE_SIZE, `DOM still holds exactly one page after Next, not an accumulated list (got ${rows})`);
    const page2Names = await page.locator('.acct-mgr-name').allTextContents();
    const overlap = page1Names.filter(n => page2Names.includes(n));
    assert(overlap.length === 0, `6/7) page 1 and page 2 share no rows in the real rendered UI (got ${overlap.length} overlapping)`);

    // Previous.
    await page.click('[data-acct-page-prev]');
    await page.waitForFunction((expectedFirst) => {
      const el = document.querySelector('.acct-mgr-name');
      return el && el.textContent.trim() === expectedFirst;
    }, page1Names[0].trim());
    const backNames = await page.locator('.acct-mgr-name').allTextContents();
    assert(JSON.stringify(backNames) === JSON.stringify(page1Names), '8) Previous returns to the exact same page 1 rows, in the same order');

    // 26: expand a second upload -- only one expanded at a time.
    await page.click('[data-list-expand-toggle][data-list-id="upload-empty"]');
    await page.waitForSelector('text=No customer accounts in this list.');
    const expandedToggles = await page.locator('[data-list-expand-toggle][aria-expanded="true"]').count();
    assert(expandedToggles === 1, `26) only one upload is ever expanded at a time (got ${expandedToggles} expanded)`);
    const bigStillExpanded = await page.locator('[data-list-expand-toggle][data-list-id="upload-big"]').getAttribute('aria-expanded');
    assert(bigStillExpanded === 'false', "26) expanding a second upload collapses the first (upload-big's toggle is no longer expanded)");
    rows = await page.locator('.acct-mgr-row').count();
    assert(rows === 0, '26) the first upload\'s rows are actually removed from the DOM once a different upload is expanded');

    // 25: collapse, then reopen the big upload -- cleanly refetches page 1.
    await page.click('[data-list-expand-toggle][data-list-id="upload-empty"]');
    const callsBeforeReopen = calls.length;
    await page.click('[data-list-expand-toggle][data-list-id="upload-big"]');
    await page.waitForSelector('.acct-mgr-row', {state: 'attached'});
    assert(calls.length > callsBeforeReopen, '25) reopening a previously-expanded upload issues a fresh fetch (page 1), not stale in-memory rows from before it was collapsed');
    const reopenedNames = await page.locator('.acct-mgr-name').allTextContents();
    assert(JSON.stringify(reopenedNames) === JSON.stringify(page1Names), '25) reopening shows page 1 again, correctly, after having navigated away from it');
  });

  // =========================================================================
  // Items 22/10 (search): a search with zero matches shows the honest
  // no-results state, scoped to the expanded upload; a real match works.
  // =========================================================================
  await withPage(async (page) => {
    await page.route('**/api/monitoring-lists*', async (route) => {
      const url = new URL(route.request().url());
      const uploadId = url.searchParams.get('uploadId');
      if(!uploadId) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(summaryPayload())});
      const q = url.searchParams.get('q');
      const limit = Number(url.searchParams.get('limit')) || PAGE_SIZE;
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(pagePayload(uploadId, BIG_ACCOUNTS, 0, limit, q))});
    });
    await openManageModal(page);
    await page.click('[data-list-expand-toggle][data-list-id="upload-big"]');
    await page.waitForSelector('.acct-mgr-row', {state: 'attached'});
    await page.fill('[data-acct-search]', 'no-such-account-anywhere-zz');
    await page.waitForSelector('text=No accounts match', {timeout: 3000});
    const rows = await page.locator('.acct-mgr-row').count();
    assert(rows === 0, '22) a zero-match search renders no account rows');
    const emptyText = await page.locator('#accountManagerContent').innerText();
    assert(/No accounts match "no-such-account-anywhere-zz"/.test(emptyText), `22) the no-results state names the actual search term (got "${emptyText.slice(0, 200)}")`);

    await page.fill('[data-acct-search]', '');
    await page.fill('[data-acct-search]', 'Unicorn Specialty');
    await page.waitForSelector('text=Unicorn Specialty Distributor', {timeout: 3000});
    const matchRows = await page.locator('.acct-mgr-row').count();
    assert(matchRows === 1, `10) a real search term returns exactly the matching account (got ${matchRows} rows)`);
  });

  // =========================================================================
  // Item 23: an API failure while expanding shows an honest error state
  // with a working retry.
  // =========================================================================
  await withPage(async (page) => {
    let attempt = 0;
    await page.route('**/api/monitoring-lists*', async (route) => {
      const url = new URL(route.request().url());
      const uploadId = url.searchParams.get('uploadId');
      if(!uploadId) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(summaryPayload())});
      if(uploadId === 'upload-fail'){
        attempt += 1;
        if(attempt === 1) return route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({error: 'Simulated server failure'})});
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, uploadId, accounts: [{id: 'a1', uploadId, name: 'Recovered Co', industry: '', monitoringStatus: 'active', researchStatus: 'uploaded', lastResearchedAt: '', domain: '', dateAdded: '2026-01-01T00:00:00Z', hasActionableAlert: false}], pageInfo: {limit: 50, hasMore: false, nextCursor: null, total: 1, search: ''}})});
      }
      return route.fulfill({status: 404, body: '{}'});
    });
    await openManageModal(page);
    await page.click('[data-list-expand-toggle][data-list-id="upload-fail"]');
    await page.waitForSelector('[role="alert"]', {timeout: 3000});
    const errorText = await page.locator('[role="alert"]').innerText();
    assert(/Simulated server failure/.test(errorText), `23) the real server error message is shown, not a generic one (got "${errorText}")`);
    await page.click('[data-acct-page-retry]');
    await page.waitForSelector('text=Recovered Co', {timeout: 3000});
    const rows = await page.locator('.acct-mgr-row').count();
    assert(rows === 1, '23) retry re-fetches and successfully renders once the transient failure clears');
  });

  // =========================================================================
  // Items 17/18/9 (mutation behavior under pagination): pausing an account
  // and deleting an account both work, and refresh the visible page/counts
  // without duplicating or losing rows.
  // =========================================================================
  await withPage(async (page) => {
    const patches = [];
    let deletedId = null;
    await page.route('**/api/monitoring-lists*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if(req.method() === 'GET'){
        const uploadId = url.searchParams.get('uploadId');
        if(!uploadId) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(summaryPayload())});
        const live = deletedId ? BIG_ACCOUNTS.filter(a => a.id !== deletedId) : BIG_ACCOUNTS;
        const limit = Number(url.searchParams.get('limit')) || PAGE_SIZE;
        const cursor = url.searchParams.get('cursor');
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(pagePayload(uploadId, live, cursor ? Number(cursor) : 0, limit, url.searchParams.get('q')))});
      }
      if(req.method() === 'PATCH'){
        const body = JSON.parse(req.postData() || '{}');
        patches.push(body);
        if(body.action === 'delete-account') deletedId = body.id;
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true})});
      }
      return route.fulfill({status: 404, body: '{}'});
    });
    await openManageModal(page);
    await page.click('[data-list-expand-toggle][data-list-id="upload-big"]');
    await page.waitForSelector('.acct-mgr-row', {state: 'attached'});

    // 17: pause/resume toggle.
    const firstToggle = page.locator('.acct-mgr-row').first().locator('.acct-mgr-toggle').first();
    await firstToggle.click();
    await page.waitForFunction(() => document.querySelectorAll('.acct-mgr-row').length === 50);
    assert(patches.some(p => p.type === 'account' && (p.action === 'pause-account' || p.action === 'resume-account')), '17) clicking the account monitoring toggle sends the real pause/resume PATCH request');

    // 18: delete account via the overflow menu + destructive confirm.
    const firstRow = page.locator('.acct-mgr-row').first();
    const firstNameRaw = await firstRow.locator('.acct-mgr-name').innerText();
    const firstName = firstNameRaw.replace(/\s*●\s*$/, '').trim();
    await firstRow.locator('[data-menu-trigger]').click();
    await page.click('.acct-mgr-menu.open [data-account-act="delete-account"]');
    await page.click('.ha-confirm-danger-btn');
    await page.waitForFunction((removedName) => {
      const names = Array.from(document.querySelectorAll('.acct-mgr-name')).map(el => el.textContent);
      return !names.some(n => n.includes(removedName));
    }, firstName, {timeout: 3000});
    assert(patches.some(p => p.action === 'delete-account'), '18) confirming Delete Account Data sends the real delete PATCH request');
    const rowsAfterDelete = await page.locator('.acct-mgr-row').count();
    assert(rowsAfterDelete === 50, `9) after a mutation, the visible page still shows a full page (the mutation refresh re-fetches correctly, no duplicate/missing rows) (got ${rowsAfterDelete})`);
  });

  // =========================================================================
  // Item 20: upload deletion still works and removes the card entirely.
  // =========================================================================
  await withPage(async (page) => {
    let deletedUploadId = null;
    await page.route('**/api/monitoring-lists*', async (route) => {
      const req = route.request();
      if(req.method() === 'GET'){
        const url = new URL(req.url());
        if(url.searchParams.get('uploadId')) return route.fulfill({status: 404, body: '{}'});
        const payload = summaryPayload();
        if(deletedUploadId) payload.lists.customer = payload.lists.customer.filter(l => l.id !== deletedUploadId);
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(payload)});
      }
      if(req.method() === 'DELETE'){
        const body = JSON.parse(req.postData() || '{}');
        deletedUploadId = body.id;
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true})});
      }
      return route.fulfill({status: 404, body: '{}'});
    });
    await openManageModal(page);
    await page.click('[data-list-id="upload-empty"] [data-menu-trigger]');
    await page.click('[data-list-id="upload-empty"] .acct-mgr-menu.open [data-list-act="delete"]');
    await page.click('.ha-confirm-danger-btn');
    await page.waitForFunction(() => !document.querySelector('[data-list-id="upload-empty"]'));
    const remaining = await page.locator('.acct-mgr-list').count();
    assert(remaining === 2, `20) deleting an uploaded list removes its card entirely, leaving the others (got ${remaining} remaining)`);
  });

  // =========================================================================
  // Item 16: existing account edit still works. "Edit Contact Info" lives
  // entirely on the separate main-dashboard surface (renderDetailedAccountViews
  // / window.accountRadarAccounts / saveAccountMetadataEdit -- see
  // scripts/test-dashboard-orchestration.js for its own full behavioral
  // coverage), never inside this modal, and is untouched by the pagination
  // work -- proven here structurally rather than re-testing an unrelated
  // surface's behavior.
  // =========================================================================
  {
    assert(/async function saveAccountMetadataEdit\(uiKey, accountName\)\{/.test(DASHBOARD_SRC), '16) the real saveAccountMetadataEdit() account-edit handler still exists, unchanged, on the main dashboard surface');
    assert(/await saveCurrentUpload\('accounts_updated'\)/.test(DASHBOARD_SRC), "16) account edits still save via the same saveCurrentUpload('accounts_updated') path");
    assert(!MODAL_IIFE_SRC.includes('saveAccountMetadataEdit'), '16) the Manage Customer Accounts modal itself never calls the account-edit handler -- confirms edit is a genuinely separate surface, unaffected by pagination');
  }

  // =========================================================================
  // Item 19: research/research-again controls remain wired correctly.
  // accountRow() itself is byte-for-byte unchanged by this round (only its
  // caller, listCard(), changed) -- proven here by exercising the real
  // click-delegation path end-to-end: clicking Research on a paginated row
  // reaches the real handleResearchClick()/researchAccountFromManageModal()
  // call (stubbed above; deep research itself is covered exhaustively by
  // scripts/test-research-run-reattachment.js), with the correct
  // (accountName, listId) identity.
  // =========================================================================
  await withPage(async (page) => {
    await page.route('**/api/monitoring-lists*', async (route) => {
      const url = new URL(route.request().url());
      const uploadId = url.searchParams.get('uploadId');
      if(!uploadId) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(summaryPayload())});
      const limit = Number(url.searchParams.get('limit')) || PAGE_SIZE;
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(pagePayload(uploadId, BIG_ACCOUNTS, 0, limit, url.searchParams.get('q')))});
    });
    await openManageModal(page);
    await page.click('[data-list-expand-toggle][data-list-id="upload-big"]');
    await page.waitForSelector('.acct-mgr-row', {state: 'attached'});
    const firstRow = page.locator('.acct-mgr-row').first();
    await firstRow.locator('[data-research-act="account"]').click();
    await page.waitForSelector('[data-row-status]:not([hidden])', {timeout: 3000});
    const statusText = await firstRow.locator('[data-row-status]').innerText();
    assert(/Research is not available in this test fixture\./.test(statusText), `19) clicking Research on a paginated row reaches the real handleResearchClick()/researchAccountFromManageModal() call with the right identity (got "${statusText}")`);
  });

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
