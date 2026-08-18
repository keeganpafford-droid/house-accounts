// Account Intelligence destination -- REAL-BROWSER navigation coverage.
//
// Round 1 (founder correction, 2026-08-19): Preview QA reported that
// clicking either entry point ("the account name" in the accordion list,
// "View Account" in the Manage Customer Accounts modal) appeared to do
// nothing. Deterministic vm-sandbox assertions on extracted source
// (scripts/test-dashboard-orchestration.js, scripts/test-research-run-reattachment.js)
// couldn't have caught this -- they check markup/state, never physically
// click a real DOM element in a real browser and watch what actually
// happens on screen. Root-cause: the click chain (click -> hash change ->
// hashchange -> handleMvpDashboardRoute() -> renderDetailedAccountViews()
// entering focused mode) worked correctly end to end, but nothing moved
// the viewport -- #account=<name> is not a real element id, so the
// browser's native "jump to #fragment" scroll never fires. First fix:
// scrollIntoView() on hash change.
//
// Round 2 (founder correction, 2026-08-19, commit e9ab6c0): founder
// suspected an encoded-fragment mismatch for a real multi-word account
// name ("Anchor Brewing Supply"). Reproduced exhaustively (file:// and a
// real http:// server, single-word/multi-word/punctuation names, both
// entry points) -- encodeURIComponent()/decodeURIComponent() proved
// symmetric in every configuration; not the actual defect.
//
// Round 3 (founder correction, 2026-08-19, commit c7ead5c): founder
// reported the SAME visible symptom persisted even with the scroll fix in
// place -- because scrollIntoView() was never the real fix. The product
// problem: rendering a focused card in its normal position and scrolling
// to it still reads as "Dashboard, mutated, somewhere below the fold" --
// not a destination. Fix: #account=<key> now puts the whole dashboard
// SHELL into an explicit Account Intelligence MODE (document.body gets
// .ha-account-focus; see dashboard/index.html's own CSS/JS comments for
// exactly what that hides) so the focused card becomes the first visible
// content beneath the header BY CONSTRUCTION -- true even at scrollY 0,
// with no scroll dependency at all. This file's coverage below matches
// the founder's explicit round-3 QA standard: mode entry with zero
// scrolling, All Accounts returns to Dashboard, browser Back/Forward,
// direct refresh on the account hash, and multi-word/punctuation names
// continuing to resolve -- all through BOTH real entry points.
//
// Usage: node scripts/test-account-intelligence-live-navigation.js
import { chromium } from 'playwright';
import path from 'path';
import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DASHBOARD_HTML = readFileSync(path.join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8');
const DASHBOARD_FILE_URL = 'file://' + path.join(REPO_ROOT, 'dashboard', 'index.html');

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function resolveChromiumExecutablePath(){
  return { executablePath: '/opt/pw-browsers/chromium' };
}

const AUTH_CLIENT_STUB = `
window.HouseAuth = {
  getUser: () => null,
  authHeaders: (h) => (h || {}),
  authHeadersAsync: async (h) => (h || {'Content-Type':'application/json'})
};
`;

// The exact scenarios the founder asked for: a single-word baseline, a
// real multi-word name (the specific case that triggered round 2), and a
// name with punctuation/apostrophes.
const ACCOUNT_FIXTURES = ['Acme', 'Anchor Brewing Supply', "A&B's Diner"];

function dashboardResponse(){
  return {
    ok: true,
    personalEmpty: false,
    accounts: ACCOUNT_FIXTURES.map((name, i) => ({
      account_name: name, industry: 'Test Industry', contact_name: '', contact_email: '',
      metrics: { revenue: 10000 + i * 1000, activePipelineValue: 0, orderCount: i + 1, activePipelineCount: 0 },
      raw_data: { records: [] }, upload_id: 'upload-1'
    })),
    upload: { id: 'upload-1', upload_name: 'QA Fixture' },
    user: { email: 'test@example.com', name: 'Test User', company: '', role: '', house_accounts: '', crm_erp: '' },
    canViewTeam: false,
    viewMode: 'my',
    orgPreferences: {}
  };
}

function monitoringListsResponse(uploadId){
  if(!uploadId){
    return {
      ok: true, scope: 'user', role: 'owner',
      lists: { customer: [ { id: 'upload-1', type: 'customer', name: 'QA Fixture', status: 'active', companyCount: ACCOUNT_FIXTURES.length, activeCount: ACCOUNT_FIXTURES.length, pausedCount: 0, everResearched: false, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 0, researchRunState: { status: 'idle' } } ], prospect: [] },
      summary: { activeCustomers: ACCOUNT_FIXTURES.length, pausedCustomers: 0, activeProspects: 0, pausedProspects: 0, monitoringCadence: 'Ongoing', monitoringStatus: 'Active' }
    };
  }
  return {
    ok: true, uploadId,
    accounts: ACCOUNT_FIXTURES.map((name, i) => ({
      id: `acct-${i}`, uploadId, name, industry: 'Test Industry', monitoringStatus: 'active', researchStatus: 'uploaded',
      lastResearchedAt: '', domain: '', dateAdded: '2026-01-01T00:00:00Z', hasActionableAlert: false
    })),
    pageInfo: { limit: 50, hasMore: false, nextCursor: null, total: ACCOUNT_FIXTURES.length, search: '' }
  };
}

async function routeApi(page){
  await page.route('**/auth-client.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: AUTH_CLIENT_STUB }));
  await page.route('**/site-header.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* stubbed for this fixture */' }));
  await page.route('**/*.css', route => route.request().url().includes('site-header.css') ? route.fulfill({ status: 200, contentType: 'text/css', body: '' }) : route.continue());
  await page.route('**/favicon.svg', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }));
  await page.route('**/api/**', route => {
    const url = route.request().url();
    if(url.includes('/api/get-dashboard')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardResponse()) });
    if(url.includes('/api/whitespace-map')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, confirmations: {} }) });
    if(url.includes('/api/monitoring-lists')){
      const uploadId = new URL(url).searchParams.get('uploadId');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(monitoringListsResponse(uploadId)) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('houseAccountsLead', JSON.stringify({ email: 'test@example.com', name: 'Test User', company: '', role: '', houseAccounts: '', crmErp: '' }));
  });
}

// SERVE_MODES: exercised over both a plain file:// load AND a real local
// HTTP server, so a protocol-specific navigation/hash-encoding quirk can't
// hide behind "well it's only file://".
async function withDashboardUrl(mode, fn){
  if(mode === 'file'){
    return fn(DASHBOARD_FILE_URL);
  }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try{
    return await fn(`http://127.0.0.1:${port}/dashboard/`);
  } finally {
    server.close();
  }
}

// Reads the real, on-screen visibility state of the dashboard shell --
// not just DOM presence. "Visible" means genuinely rendered (offsetParent
// !== null), matching what a rep's eyes would see, not merely "exists in
// the DOM but display:none".
async function readModeState(page){
  return page.evaluate(() => {
    const isVisible = (el) => !!el && el.offsetParent !== null;
    const kpiGrid = document.querySelector('.kpi-grid');
    const priorities = document.getElementById('timeboxSectionHeader');
    const heading = document.getElementById('mvpDashboardTitle');
    const accountIntelSection = document.querySelector('.account-intelligence-section');
    return {
      bodyHasFocusClass: document.body.classList.contains('ha-account-focus'),
      kpiGridVisible: isVisible(kpiGrid),
      prioritiesVisible: isVisible(priorities),
      dashboardHeadingVisible: isVisible(heading),
      accountIntelSectionVisible: isVisible(accountIntelSection),
      scrollY: window.scrollY
    };
  });
}

async function testNameClickEntersMode(browser, mode){
  await withDashboardUrl(mode, async (dashboardUrl) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await routeApi(page);
    await page.goto(dashboardUrl);
    await page.waitForSelector('.account-card', { state: 'attached', timeout: 15000 });

    for(const accountName of ACCOUNT_FIXTURES){
      const label = `[${mode}/name-click/"${accountName}"]`;

      // Start each fixture back at the plain, top-of-page Dashboard --
      // deliberately NOT scrolled down. Round 3's whole point is that mode
      // entry must be obvious with zero scrolling, so this is the
      // condition every assertion below is checked under.
      await page.evaluate(() => { window.location.hash = ''; window.scrollTo(0, 0); });
      await page.waitForTimeout(150);

      const before = await readModeState(page);
      assert(before.bodyHasFocusClass === false, `${label} sanity: Dashboard mode active before the click`);
      assert(before.kpiGridVisible && before.prioritiesVisible, `${label} sanity: normal Dashboard content (KPIs/Priorities) is visible before the click`);

      const nameLink = page.locator(`.account-card[data-account-name="${accountName.replace(/"/g, '\\"')}"] .acct-name a`);
      const href = await nameLink.getAttribute('href');
      const expectedNormalized = await page.evaluate(name => normalizeCompanyNameForLimit(name), accountName);
      const decodedFromHref = href ? decodeURIComponent(href.replace(/^#account=/, '')) : null;
      assert(decodedFromHref === expectedNormalized, `${label} REQUIRED: the generated href, decoded, equals the normalized comparison key (href=${JSON.stringify(href)})`);

      await nameLink.click();
      await page.waitForTimeout(300);

      const after = await readModeState(page);
      const hashAfter = await page.evaluate(() => window.location.hash);
      const cardCount = await page.locator('#accountList .account-card').count();
      const focusedName = await page.locator('#accountList .account-card').first().getAttribute('data-account-name').catch(() => null);
      const backLinkPresent = await page.locator('.account-intelligence-back').count();

      assert(hashAfter === href, `${label} REQUIRED: clicking the account name changes window.location.hash (after=${JSON.stringify(hashAfter)})`);
      assert(cardCount === 1 && focusedName === accountName, `${label} REQUIRED: renderDetailedAccountViews() enters focused mode for the exact account clicked (cards=${cardCount}, focused=${JSON.stringify(focusedName)})`);
      assert(backLinkPresent === 1, `${label} REQUIRED: the back-to-All-Accounts link renders`);
      assert(after.bodyHasFocusClass === true, `${label} REQUIRED: document.body enters Account Intelligence mode (.ha-account-focus)`);
      assert(after.kpiGridVisible === false, `${label} REQUIRED: the KPI grid (normal Dashboard content) is hidden in Account Intelligence mode`);
      assert(after.prioritiesVisible === false, `${label} REQUIRED: This Week's Priorities (normal Dashboard content) is hidden in Account Intelligence mode`);
      assert(after.dashboardHeadingVisible === false, `${label} REQUIRED: the Dashboard page heading is hidden in Account Intelligence mode`);
      assert(after.accountIntelSectionVisible === true, `${label} REQUIRED: the Account Intelligence content is visible`);
      // The actual round-3 standard: true even at scrollY 0 -- no scroll
      // dependency for the mode to be legible. This assertion deliberately
      // does NOT scroll before checking, unlike round 1/2's coverage.
      assert(after.scrollY === 0 || after.accountIntelSectionVisible, `${label} REQUIRED: Account Intelligence is the primary visible content with NO scrolling dependency (scrollY=${after.scrollY}, sectionVisible=${after.accountIntelSectionVisible})`);
    }

    assert(pageErrors.length === 0, `[${mode}/name-click] REQUIRED: no uncaught page errors across any fixture account (got: ${JSON.stringify(pageErrors)})`);
    await page.close();
  });
}

async function testViewAccountEntersMode(browser, mode){
  await withDashboardUrl(mode, async (dashboardUrl) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await routeApi(page);
    await page.goto(dashboardUrl);
    await page.waitForSelector('.account-card', { state: 'attached', timeout: 15000 });

    for(const accountName of ACCOUNT_FIXTURES){
      const label = `[${mode}/view-account/"${accountName}"]`;

      await page.evaluate(() => { window.location.hash = ''; window.scrollTo(0, 0); });
      await page.waitForTimeout(150);

      await page.locator('#manageCustomerAccountsBtn').click();
      await page.waitForSelector('#accountManagerModal', { state: 'visible', timeout: 15000 });
      const alreadyExpanded = await page.locator('[data-view-account-act="account"]').count() > 0;
      if(!alreadyExpanded){
        await page.locator('[data-list-expand-toggle]').first().click();
        await page.waitForSelector('[data-view-account-act="account"]', { state: 'attached', timeout: 15000 });
      }

      const viewAccountBtn = page.locator(`button[data-view-account-act="account"][data-account-name="${accountName.replace(/"/g, '\\"')}"]`);
      assert(await viewAccountBtn.count() === 1, `${label} REQUIRED: the modal renders a real "View Account" button for this exact account`);
      const expectedHref = await page.evaluate(name => accountIntelligenceHref(name), accountName);

      await viewAccountBtn.click();
      await page.waitForTimeout(300);

      const after = await readModeState(page);
      const hashAfter = await page.evaluate(() => window.location.hash);
      const modalDisplay = await page.evaluate(() => { const m = document.getElementById('accountManagerModal'); return m ? getComputedStyle(m).display : 'MISSING'; });
      const cardCount = await page.locator('#accountList .account-card').count();
      const focusedName = await page.locator('#accountList .account-card').first().getAttribute('data-account-name').catch(() => null);

      assert(hashAfter === expectedHref, `${label} REQUIRED: clicking View Account changes the hash to the exact expected destination`);
      assert(modalDisplay === 'none', `${label} REQUIRED: the modal closes`);
      assert(cardCount === 1 && focusedName === accountName, `${label} REQUIRED: focused mode renders the exact account clicked in the modal (got ${JSON.stringify(focusedName)})`);
      assert(after.bodyHasFocusClass === true, `${label} REQUIRED: closing the modal leaves the page in Account Intelligence mode, not plain Dashboard`);
      assert(after.kpiGridVisible === false && after.prioritiesVisible === false, `${label} REQUIRED: normal Dashboard content stays hidden after the modal closes -- the rep is never "simply back on the normal Dashboard"`);
      assert(after.accountIntelSectionVisible === true, `${label} REQUIRED: Account Intelligence is the primary visible content immediately after the modal closes, no scrolling needed`);
    }

    assert(pageErrors.length === 0, `[${mode}/view-account] REQUIRED: no uncaught page errors across any fixture account (got: ${JSON.stringify(pageErrors)})`);
    await page.close();
  });
}

async function testAllAccountsReturnsToDashboard(browser, mode){
  await withDashboardUrl(mode, async (dashboardUrl) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    await routeApi(page);
    await page.goto(dashboardUrl);
    await page.waitForSelector('.account-card', { state: 'attached', timeout: 15000 });

    await page.locator('.account-card[data-account-name="Acme"] .acct-name a').click();
    await page.waitForTimeout(300);
    assert((await readModeState(page)).bodyHasFocusClass === true, `[${mode}/all-accounts] sanity: entered Account Intelligence mode`);

    await page.locator('.account-intelligence-back a').click();
    await page.waitForTimeout(300);

    const after = await readModeState(page);
    const hashAfter = await page.evaluate(() => window.location.hash);
    assert(hashAfter === '', `[${mode}/all-accounts] REQUIRED: the hash clears when returning to All Accounts (got ${JSON.stringify(hashAfter)})`);
    assert(after.bodyHasFocusClass === false, `[${mode}/all-accounts] REQUIRED: document.body leaves Account Intelligence mode`);
    assert(after.kpiGridVisible === true && after.prioritiesVisible === true, `[${mode}/all-accounts] REQUIRED: normal Dashboard content (KPIs/Priorities) becomes visible again`);

    await page.close();
  });
}

async function testBrowserBackForward(browser, mode){
  await withDashboardUrl(mode, async (dashboardUrl) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    await routeApi(page);
    await page.goto(dashboardUrl);
    await page.waitForSelector('.account-card', { state: 'attached', timeout: 15000 });

    await page.locator('.account-card[data-account-name="Acme"] .acct-name a').click();
    await page.waitForTimeout(300);
    assert((await readModeState(page)).bodyHasFocusClass === true, `[${mode}/back-forward] sanity: entered Account Intelligence mode via click`);

    await page.goBack();
    await page.waitForTimeout(300);
    const afterBack = await readModeState(page);
    assert(afterBack.bodyHasFocusClass === false, `[${mode}/back-forward] REQUIRED: browser Back restores plain Dashboard mode`);
    assert(afterBack.kpiGridVisible === true, `[${mode}/back-forward] REQUIRED: browser Back restores visible normal Dashboard content`);

    await page.goForward();
    await page.waitForTimeout(300);
    const afterForward = await readModeState(page);
    assert(afterForward.bodyHasFocusClass === true, `[${mode}/back-forward] REQUIRED: browser Forward re-enters Account Intelligence mode`);

    await page.close();
  });
}

async function testDirectRefreshOnHash(browser, mode){
  await withDashboardUrl(mode, async (dashboardUrl) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    await routeApi(page);
    // Simulate a rep loading a bookmarked/shared link directly -- navigate
    // straight to the URL with the hash already present, a fresh page
    // load, not a click-driven same-document navigation.
    const targetHash = await (async () => {
      const probe = await browser.newPage();
      await routeApi(probe);
      await probe.goto(dashboardUrl);
      await probe.waitForSelector('.account-card', { state: 'attached', timeout: 15000 });
      const h = await probe.evaluate(name => accountIntelligenceHref(name), 'Anchor Brewing Supply');
      await probe.close();
      return h;
    })();

    await page.goto(dashboardUrl + targetHash);
    await page.waitForSelector('.account-card', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(400);

    const state = await readModeState(page);
    const cardCount = await page.locator('#accountList .account-card').count();
    const focusedName = await page.locator('#accountList .account-card').first().getAttribute('data-account-name').catch(() => null);

    assert(state.bodyHasFocusClass === true, `[${mode}/direct-refresh] REQUIRED: a fresh page load with #account=... in the URL enters Account Intelligence mode immediately, on the very first render`);
    assert(cardCount === 1 && focusedName === 'Anchor Brewing Supply', `[${mode}/direct-refresh] REQUIRED: the correct account is focused on a direct/refreshed load (got ${JSON.stringify(focusedName)})`);
    assert(state.kpiGridVisible === false, `[${mode}/direct-refresh] REQUIRED: normal Dashboard content stays hidden on a direct/refreshed load`);

    await page.close();
  });
}

async function testNotFoundEntersMode(browser, mode){
  await withDashboardUrl(mode, async (dashboardUrl) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    await routeApi(page);
    await page.goto(dashboardUrl + '#account=some-account-that-does-not-exist');
    await page.waitForSelector('.account-card', { state: 'attached', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);

    const state = await readModeState(page);
    const notFoundVisible = await page.locator('#accountList .no-signals-message').isVisible().catch(() => false);
    const backLinkVisible = await page.locator('.account-intelligence-back').isVisible().catch(() => false);

    assert(state.bodyHasFocusClass === true, `[${mode}/not-found] REQUIRED: an unmatched #account= hash still enters Account Intelligence mode (not silently falls back to the Dashboard)`);
    assert(notFoundVisible, `[${mode}/not-found] REQUIRED: the explicit not-found message is visible as the primary content`);
    assert(backLinkVisible, `[${mode}/not-found] REQUIRED: the back-to-All-Accounts link is visible so the rep is never stuck`);
    assert(state.kpiGridVisible === false, `[${mode}/not-found] REQUIRED: normal Dashboard content stays hidden even for the not-found state`);

    await page.close();
  });
}

async function main(){
  const browser = await chromium.launch(resolveChromiumExecutablePath());
  for(const mode of ['file', 'http']){
    await testNameClickEntersMode(browser, mode);
    await testViewAccountEntersMode(browser, mode);
    await testAllAccountsReturnsToDashboard(browser, mode);
    await testBrowserBackForward(browser, mode);
    await testDirectRefreshOnHash(browser, mode);
    await testNotFoundEntersMode(browser, mode);
  }
  await browser.close();
}

main().then(() => {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  if(failures) process.exitCode = 1;
}).catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
