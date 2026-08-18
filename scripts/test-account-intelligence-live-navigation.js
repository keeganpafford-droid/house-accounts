// Account Intelligence destination -- REAL-BROWSER navigation coverage.
// Founder correction (2026-08-19): Preview QA reported that clicking either
// entry point ("the account name" in the accordion list, "View Account" in
// the Manage Customer Accounts modal) appeared to do nothing. Deterministic
// vm-sandbox assertions on extracted source (scripts/test-dashboard-orchestration.js,
// scripts/test-research-run-reattachment.js) couldn't have caught this --
// they check markup/state, never physically click a real DOM element in a
// real browser and watch what actually happens on screen.
//
// Root-cause reproduction (this file's method): load the REAL, unmodified
// dashboard/index.html via file://, stub only the network boundary
// (auth-client.js, /api/get-dashboard, /api/monitoring-lists,
// /api/whitespace-map) so the page boots through its own real code path,
// then physically click the real rendered elements and observe
// window.location.hash, the hashchange event, the resulting DOM, and
// window.scrollY -- exactly what a rep's browser does.
//
// Finding: the click chain itself (click -> hash change -> hashchange event
// -> handleMvpDashboardRoute() -> renderDetailedAccountViews() entering
// focused mode) worked correctly end to end. The actual defect: nothing
// ever moved the viewport. #account=<name> is not a real element id, so
// the browser's native "jump to #fragment" scroll never fires (unlike an
// ordinary named-anchor link), #accountList can sit far down the page below
// Priorities/KPIs, and closing the modal reveals the background page at ITS
// OWN prior scroll position. The DOM genuinely updated; the viewport never
// moved -- indistinguishable from the click doing nothing. Fixed with an
// explicit scrollIntoView() when entering focus mode (see
// handleMvpDashboardRoute()'s own comment).
//
// Usage: node scripts/test-account-intelligence-live-navigation.js
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DASHBOARD_URL = 'file://' + path.join(REPO_ROOT, 'dashboard', 'index.html');

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function resolveChromiumExecutablePath(){
  const candidate = '/opt/pw-browsers/chromium';
  return { executablePath: candidate };
}

const AUTH_CLIENT_STUB = `
window.HouseAuth = {
  getUser: () => null,
  authHeaders: (h) => (h || {}),
  authHeadersAsync: async (h) => (h || {'Content-Type':'application/json'})
};
`;

function dashboardResponse(){
  return {
    ok: true,
    personalEmpty: false,
    accounts: [
      { account_name: 'Acme Corp', industry: 'Promotional Products', contact_name: '', contact_email: '', metrics: { revenue: 45210, activePipelineValue: 8200, orderCount: 12, activePipelineCount: 2 }, raw_data: { records: [] }, upload_id: 'upload-1' },
      { account_name: 'Globex Inc', industry: 'Industrial', contact_name: '', contact_email: '', metrics: { revenue: 12000, activePipelineValue: 0, orderCount: 4, activePipelineCount: 0 }, raw_data: { records: [] }, upload_id: 'upload-1' }
    ],
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
      lists: { customer: [ { id: 'upload-1', type: 'customer', name: 'QA Fixture', status: 'active', companyCount: 2, activeCount: 2, pausedCount: 0, everResearched: false, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 0, researchRunState: { status: 'idle' } } ], prospect: [] },
      summary: { activeCustomers: 2, pausedCustomers: 0, activeProspects: 0, pausedProspects: 0, monitoringCadence: 'Ongoing', monitoringStatus: 'Active' }
    };
  }
  return {
    ok: true, uploadId,
    accounts: [
      { id: 'acct-1', uploadId, name: 'Acme Corp', industry: 'Promotional Products', monitoringStatus: 'active', researchStatus: 'uploaded', lastResearchedAt: '', domain: '', dateAdded: '2026-01-01T00:00:00Z', hasActionableAlert: false },
      { id: 'acct-2', uploadId, name: 'Globex Inc', industry: 'Industrial', monitoringStatus: 'active', researchStatus: 'uploaded', lastResearchedAt: '', domain: '', dateAdded: '2026-01-01T00:00:00Z', hasActionableAlert: false }
    ],
    pageInfo: { limit: 50, hasMore: false, nextCursor: null, total: 2, search: '' }
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

async function main(){
  const browser = await chromium.launch(resolveChromiumExecutablePath());

  // =========================================================================
  // Entry point 1: clicking the account name in the accordion list.
  // =========================================================================
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await routeApi(page);
    await page.goto(DASHBOARD_URL);
    await page.waitForSelector('.account-card', { state: 'attached', timeout: 15000 });

    // Land scrolled down at the account list, matching a real rep who has
    // scrolled past Priorities/KPIs -- the exact condition that hid the bug
    // from a screenshot taken at scrollY=0.
    await page.evaluate(() => {
      document.getElementById('accountList')?.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -50);
    });
    const scrollYBefore = await page.evaluate(() => window.scrollY);

    const nameLink = page.locator('.account-card .acct-name a').first();
    const href = await nameLink.getAttribute('href');
    assert(/^#account=/.test(href || ''), `REQUIRED: the account name is a real link to the Account Intelligence destination (got href=${JSON.stringify(href)})`);

    const hashBefore = await page.evaluate(() => window.location.hash);
    assert(hashBefore === '', `sanity: no #account= hash before the click (got ${JSON.stringify(hashBefore)})`);

    await page.evaluate(() => { window.__hashchangeFired = false; window.addEventListener('hashchange', () => { window.__hashchangeFired = true; }, { once: true }); });
    await nameLink.click();
    await page.waitForTimeout(500);

    const hashAfter = await page.evaluate(() => window.location.hash);
    const hashchangeFired = await page.evaluate(() => window.__hashchangeFired);
    const cardCount = await page.locator('#accountList .account-card').count();
    const backLinkPresent = await page.locator('.account-intelligence-back').count();
    const scrollYAfter = await page.evaluate(() => window.scrollY);

    assert(hashAfter === href, `REQUIRED: clicking the account name actually changes window.location.hash to the link's own href (before=${JSON.stringify(hashBefore)}, after=${JSON.stringify(hashAfter)})`);
    assert(hashchangeFired === true, 'REQUIRED: a real hashchange event fires as a result of the click (proves handleMvpDashboardRoute() runs, not just a same-document href rewrite)');
    assert(cardCount === 1, `REQUIRED: renderDetailedAccountViews() enters focused mode -- exactly one card renders, not the full list (got ${cardCount})`);
    assert(backLinkPresent === 1, 'REQUIRED: the back-to-All-Accounts link renders once focused mode is active');
    assert(scrollYAfter !== scrollYBefore, `REQUIRED (the actual founder-reported bug): the viewport scrolls to the destination -- a click that only changes the DOM off-screen is indistinguishable from doing nothing (scrollY before=${scrollYBefore}, after=${scrollYAfter})`);
    assert(pageErrors.length === 0, `REQUIRED: no uncaught page errors during this flow (got: ${JSON.stringify(pageErrors)})`);

    await page.close();
  }

  // =========================================================================
  // Entry point 2: "View Account" inside the Manage Customer Accounts modal.
  // =========================================================================
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await routeApi(page);
    await page.goto(DASHBOARD_URL);
    await page.waitForSelector('.account-card', { state: 'attached', timeout: 15000 });

    await page.locator('#manageCustomerAccountsBtn').click();
    await page.waitForSelector('#accountManagerModal', { state: 'visible', timeout: 15000 });
    await page.locator('[data-list-expand-toggle]').first().click();
    await page.waitForSelector('[data-view-account-act="account"]', { state: 'attached', timeout: 15000 });

    const viewAccountBtn = page.locator('button[data-view-account-act="account"]').first();
    assert(await viewAccountBtn.count() === 1, 'REQUIRED: the Manage Customer Accounts modal renders a real "View Account" button');

    await page.evaluate(() => window.scrollTo(0, 0));
    const hashBefore = await page.evaluate(() => window.location.hash);
    await page.evaluate(() => { window.__hashchangeFired = false; window.addEventListener('hashchange', () => { window.__hashchangeFired = true; }, { once: true }); });
    await viewAccountBtn.click();
    await page.waitForTimeout(500);

    const hashAfter = await page.evaluate(() => window.location.hash);
    const hashchangeFired = await page.evaluate(() => window.__hashchangeFired);
    const modalDisplay = await page.evaluate(() => { const m = document.getElementById('accountManagerModal'); return m ? getComputedStyle(m).display : 'MISSING'; });
    const cardCount = await page.locator('#accountList .account-card').count();
    const scrollYAfter = await page.evaluate(() => window.scrollY);

    assert(hashBefore === '' && /^#account=/.test(hashAfter), `REQUIRED: clicking View Account changes the hash to a real #account= destination (before=${JSON.stringify(hashBefore)}, after=${JSON.stringify(hashAfter)})`);
    assert(hashchangeFired === true, 'REQUIRED: a real hashchange event fires as a result of clicking View Account');
    assert(modalDisplay === 'none', 'REQUIRED: the modal closes so the destination is actually visible, not left behind the backdrop');
    assert(cardCount === 1, `REQUIRED: the underlying page enters focused mode for the clicked account (got ${cardCount} cards)`);
    assert(scrollYAfter > 0, `REQUIRED (the actual founder-reported bug): the page scrolls down to reveal the focused card after the modal closes -- otherwise the rep is left staring at whatever was behind the modal, with no visible sign anything happened (scrollY after=${scrollYAfter})`);
    assert(pageErrors.length === 0, `REQUIRED: no uncaught page errors during this flow (got: ${JSON.stringify(pageErrors)})`);

    await page.close();
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
