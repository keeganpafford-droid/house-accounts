// Account Intelligence destination -- REAL-BROWSER navigation coverage.
//
// Round 1 (founder correction, 2026-08-19): Preview QA reported that
// clicking either entry point ("the account name" in the accordion list,
// "View Account" in the Manage Customer Accounts modal) appeared to do
// nothing. Deterministic vm-sandbox assertions on extracted source
// (scripts/test-dashboard-orchestration.js, scripts/test-research-run-reattachment.js)
// couldn't have caught this -- they check markup/state, never physically
// click a real DOM element in a real browser and watch what actually
// happens on screen.
//
// Root-cause reproduction (this file's method): load the REAL, unmodified
// dashboard/index.html, stub only the network boundary (auth-client.js,
// /api/get-dashboard, /api/monitoring-lists, /api/whitespace-map) so the
// page boots through its own real code path, then physically click the
// real rendered elements and observe window.location.hash, the hashchange
// event, the resulting DOM, and window.scrollY -- exactly what a rep's
// browser does. Tested against BOTH file:// and a real local http://
// server (see SERVE_MODES below) to rule out any protocol-specific
// navigation quirk.
//
// Finding (round 1): the click chain itself (click -> hash change ->
// hashchange event -> handleMvpDashboardRoute() -> renderDetailedAccountViews()
// entering focused mode) worked correctly end to end. The actual defect:
// nothing ever moved the viewport. #account=<name> is not a real element
// id, so the browser's native "jump to #fragment" scroll never fires
// (unlike an ordinary named-anchor link), #accountList can sit far down
// the page below Priorities/KPIs, and closing the modal reveals the
// background page at ITS OWN prior scroll position. The DOM genuinely
// updated; the viewport never moved -- indistinguishable from the click
// doing nothing. Fixed with an explicit scrollIntoView() when entering
// focus mode (see handleMvpDashboardRoute()'s own comment).
//
// Round 2 (founder correction, 2026-08-19, commit e9ab6c0): founder
// suspected an encoded-fragment mismatch (encodeURIComponent('anchor
// brewing supply') producing anchor%20brewing%20supply vs. an un-decoded
// comparison) for a real multi-word account name. Reproduced with
// multi-word ("Anchor Brewing Supply") and punctuation ("A&B's Diner")
// names specifically, over both file:// and a real http:// server, for
// BOTH entry points -- accountIntelligenceHref()'s encodeURIComponent()
// and currentAccountIntelligenceFocusKey()'s decodeURIComponent() proved
// symmetric in every configuration tested; the match, focused render, and
// scroll all succeeded. This file's ACCOUNT_FIXTURES below codify exactly
// those three names (plus the original single-word Acme case) as
// permanent regression coverage, run against both entry points and both
// serve modes, so this class of bug is caught here even if a future
// change breaks the symmetry.
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
// HTTP server, so a protocol-specific navigation/hash-encoding quirk (the
// founder's suspicion) can't hide behind "well it's only file://".
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

async function testEntryPoint1(browser, mode){
  await withDashboardUrl(mode, async (dashboardUrl) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));
    await routeApi(page);
    await page.goto(dashboardUrl);
    await page.waitForSelector('.account-card', { state: 'attached', timeout: 15000 });

    for(const accountName of ACCOUNT_FIXTURES){
      const label = `[${mode}/name-click/"${accountName}"]`;

      // Reset to All Accounts and land scrolled down at the account list,
      // matching a real rep who has scrolled past Priorities/KPIs -- the
      // exact condition that hid the round-1 bug from a screenshot taken
      // at scrollY=0.
      await page.evaluate(() => { window.location.hash = ''; });
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        document.getElementById('accountList')?.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -50);
      });
      const scrollYBefore = await page.evaluate(() => window.scrollY);

      const nameLink = page.locator(`.account-card[data-account-name="${accountName.replace(/"/g, '\\"')}"] .acct-name a`);
      const href = await nameLink.getAttribute('href');
      // Round 2 REQUIRED check: the href must be a validly percent-encoded
      // fragment whose decoded form round-trips to the exact normalized key
      // -- proves encodeURIComponent() at generation time is symmetric with
      // decodeURIComponent() at parse time for real multi-word/punctuation
      // names, not just single-word ones.
      const expectedNormalized = await page.evaluate(name => normalizeCompanyNameForLimit(name), accountName);
      const decodedFromHref = href ? decodeURIComponent(href.replace(/^#account=/, '')) : null;
      assert(decodedFromHref === expectedNormalized, `${label} REQUIRED: the generated href, decoded, equals the normalized comparison key (href=${JSON.stringify(href)}, decoded=${JSON.stringify(decodedFromHref)}, expected=${JSON.stringify(expectedNormalized)})`);

      await page.evaluate(() => { window.__hashchangeFired = false; window.addEventListener('hashchange', () => { window.__hashchangeFired = true; }, { once: true }); });
      await nameLink.click();
      await page.waitForTimeout(500);

      const hashAfter = await page.evaluate(() => window.location.hash);
      const hashchangeFired = await page.evaluate(() => window.__hashchangeFired);
      const cardCount = await page.locator('#accountList .account-card').count();
      const focusedName = await page.locator('#accountList .account-card').first().getAttribute('data-account-name').catch(() => null);
      const backLinkPresent = await page.locator('.account-intelligence-back').count();
      const scrollYAfter = await page.evaluate(() => window.scrollY);

      assert(hashAfter === href, `${label} REQUIRED: clicking the account name changes window.location.hash to the link's own href (after=${JSON.stringify(hashAfter)}, expected=${JSON.stringify(href)})`);
      assert(hashchangeFired === true, `${label} REQUIRED: a real hashchange event fires as a result of the click`);
      assert(cardCount === 1, `${label} REQUIRED: renderDetailedAccountViews() enters focused mode -- exactly one card renders (got ${cardCount})`);
      assert(focusedName === accountName, `${label} REQUIRED: the focused card is for the EXACT account that was clicked, not a different one (got ${JSON.stringify(focusedName)})`);
      assert(backLinkPresent === 1, `${label} REQUIRED: the back-to-All-Accounts link renders once focused mode is active`);
      assert(scrollYAfter !== scrollYBefore, `${label} REQUIRED: the viewport scrolls to the destination (before=${scrollYBefore}, after=${scrollYAfter})`);
    }

    assert(pageErrors.length === 0, `[${mode}/name-click] REQUIRED: no uncaught page errors across any fixture account (got: ${JSON.stringify(pageErrors)})`);
    await page.close();
  });
}

async function testEntryPoint2(browser, mode){
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
      // Expand only if not already expanded from a prior fixture in this
      // same page/loop -- the toggle flips state, so clicking it while
      // already expanded would collapse the list instead.
      const alreadyExpanded = await page.locator('[data-view-account-act="account"]').count() > 0;
      if(!alreadyExpanded){
        await page.locator('[data-list-expand-toggle]').first().click();
        await page.waitForSelector('[data-view-account-act="account"]', { state: 'attached', timeout: 15000 });
      }

      const viewAccountBtn = page.locator(`button[data-view-account-act="account"][data-account-name="${accountName.replace(/"/g, '\\"')}"]`);
      assert(await viewAccountBtn.count() === 1, `${label} REQUIRED: the modal renders a real "View Account" button for this exact account`);

      const expectedHref = await page.evaluate(name => accountIntelligenceHref(name), accountName);

      await page.evaluate(() => { window.__hashchangeFired = false; window.addEventListener('hashchange', () => { window.__hashchangeFired = true; }, { once: true }); });
      await viewAccountBtn.click();
      await page.waitForTimeout(500);

      const hashAfter = await page.evaluate(() => window.location.hash);
      const hashchangeFired = await page.evaluate(() => window.__hashchangeFired);
      const modalDisplay = await page.evaluate(() => { const m = document.getElementById('accountManagerModal'); return m ? getComputedStyle(m).display : 'MISSING'; });
      const cardCount = await page.locator('#accountList .account-card').count();
      const focusedName = await page.locator('#accountList .account-card').first().getAttribute('data-account-name').catch(() => null);
      const scrollYAfter = await page.evaluate(() => window.scrollY);

      assert(hashAfter === expectedHref, `${label} REQUIRED: clicking View Account changes the hash to the exact expected destination (after=${JSON.stringify(hashAfter)}, expected=${JSON.stringify(expectedHref)})`);
      assert(hashchangeFired === true, `${label} REQUIRED: a real hashchange event fires as a result of clicking View Account`);
      assert(modalDisplay === 'none', `${label} REQUIRED: the modal closes so the destination is actually visible, not left behind the backdrop`);
      assert(cardCount === 1, `${label} REQUIRED: the underlying page enters focused mode for the clicked account (got ${cardCount} cards)`);
      assert(focusedName === accountName, `${label} REQUIRED: the focused card is for the EXACT account clicked in the modal, not a different one (got ${JSON.stringify(focusedName)})`);
      assert(scrollYAfter > 0, `${label} REQUIRED: the page scrolls down to reveal the focused card after the modal closes (scrollY after=${scrollYAfter})`);
    }

    assert(pageErrors.length === 0, `[${mode}/view-account] REQUIRED: no uncaught page errors across any fixture account (got: ${JSON.stringify(pageErrors)})`);
    await page.close();
  });
}

async function main(){
  const browser = await chromium.launch(resolveChromiumExecutablePath());
  for(const mode of ['file', 'http']){
    await testEntryPoint1(browser, mode);
    await testEntryPoint2(browser, mode);
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
