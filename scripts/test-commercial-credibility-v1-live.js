// Commercial Credibility V1 (2026-08-21): real-browser coverage for
// auth-aware header behavior on the two new/canonical pages and the
// homepage, plus the Product Tour's real step-2 spotlight correction (it
// now targets the permanent Help control, #haHelpToggle, rather than the
// old top-level nav link that moved into the collapsed Help dropdown).
// Static/content assertions live in scripts/test-commercial-credibility-v1.js;
// this file proves the parts that only a real DOM/routing stack can prove.
//
// Usage: node scripts/test-commercial-credibility-v1-live.js
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'
};
function startStaticServer(){
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try{
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        let filePath = path.join(REPO_ROOT, urlPath);
        if(urlPath.endsWith('/')) filePath = path.join(filePath, 'index.html');
        if(!filePath.startsWith(REPO_ROOT)){ res.writeHead(403); res.end(); return; }
        if(!existsSync(filePath)){ res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, {'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'});
        res.end(readFileSync(filePath));
      }catch(err){ res.writeHead(500); res.end(String(err)); }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const ACCOUNT_NAME = 'Anchor Brewing Supply';
const UPLOAD_ID = 'upload-ccv1-1';

function getDashboardPayload(){
  return {
    accounts: [{
      name: ACCOUNT_NAME, industry: 'Promotional Products', revenue: 42000, orderCount: 6, uploadId: UPLOAD_ID,
      contacts: [], categoryTypes: [], purchases: [], futureOpportunities: [], signals: [],
      lastResearchedAt: '2026-08-10T12:00:00Z'
    }],
    signals: [], weeklyRuns: [],
    user: {email: 'qa-ccv1@example.com', name: 'QA Tester', company: 'QA Test Co'},
    upload: {id: UPLOAD_ID, upload_name: 'CCV1 Fixture', updated_at: '2026-08-01T00:00:00Z'},
    canViewTeam: false, viewMode: 'my', orgPreferences: {}, personalEmpty: false
  };
}

async function withPage(baseUrl, {authenticated}, run){
  const browser = await chromium.launch({executablePath: resolveChromiumExecutablePath()});
  try{
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));

    if(authenticated){
      await page.addInitScript(() => {
        localStorage.setItem('haAuthSession', JSON.stringify({access_token: 'test-token-ccv1'}));
        localStorage.setItem('houseAccountsLead', JSON.stringify({email: 'qa-ccv1@example.com', name: 'QA Tester', company: 'QA Test Co'}));
        localStorage.setItem('houseAccountsBetaWelcomeDismissed', 'true');
      });
      await page.route('**/auth-client.js', route => route.fulfill({
        status: 200, contentType: 'text/javascript',
        body: `window.HouseAuth = {
          authHeadersAsync: async (h) => ({...(h||{}), Authorization: 'Bearer test-token-ccv1'}),
          authHeaders: (h) => ({...(h||{}), Authorization: 'Bearer test-token-ccv1'})
        };`
      }));
      await page.route('**/api/**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true})}));
      await page.route('**/api/get-dashboard**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(getDashboardPayload())}));
      await page.route('**/api/usage**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, organization: {plan: 'free'}, usage: {}})}));
      await page.route('**/api/unresolved-outreach**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, items: []})}));
      await page.route('**/api/monitoring-lists**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, scope: 'user', role: 'owner',
        lists: {customer: [{id: UPLOAD_ID, type: 'customer', name: 'CCV1 Fixture', status: 'active', companyCount: 1, activeCount: 1, pausedCount: 0, everResearched: true, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 0, researchRunState: {status: 'idle'}}], prospect: []},
        summary: {activeCustomers: 1, pausedCustomers: 0, activeProspects: 0, pausedProspects: 0, monitoringCadence: 'Ongoing', monitoringStatus: 'Active'}
      })}));
    }

    await run(page, pageErrors);
  } finally {
    await browser.close();
  }
}

async function assertNavHeaderText(page, label){
  const headerText = await page.locator('#haSharedHeader').innerText();
  assert(/Why House Accounts/.test(headerText), `${label}: header shows "Why House Accounts"`);
  assert(/Real-World Results/.test(headerText), `${label}: header shows "Real-World Results"`);
  assert(/Pricing/.test(headerText), `${label}: header shows "Pricing"`);
}

async function main(){
  const server = await startStaticServer();
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // =========================================================================
  // 1) Signed-out nav: Why House Accounts | Real-World Results | Pricing +
  //    Log In / Start Free, on the homepage and on both new/canonical pages
  //    -- never FAQ/Security/Feedback in primary nav.
  // =========================================================================
  for(const [pageName, pagePath] of [['Homepage', '/'], ['Why House Accounts', '/why-house-accounts.html'], ['Real-World Results', '/real-world-results.html']]){
    await withPage(baseUrl, {authenticated: false}, async (page, pageErrors) => {
      await page.goto(`${baseUrl}${pagePath}`, {waitUntil: 'load'});
      await page.waitForSelector('#haSharedHeader', {state: 'attached'});
      await assertNavHeaderText(page, `1) ${pageName} (signed-out)`);
      const headerText = await page.locator('#haSharedHeader').innerText();
      assert(!/\bFAQ\b/.test(headerText), `1) ${pageName} (signed-out): REQUIRED -- FAQ is not in the primary nav`);
      assert(!/\bSecurity\b/.test(headerText), `1) ${pageName} (signed-out): REQUIRED -- Security is not in the primary nav`);
      assert(/Log In/.test(headerText) && /Start Free/.test(headerText), `1) ${pageName} (signed-out): Log In / Start Free CTAs present`);
      assert(!/Help/.test(headerText), `1) ${pageName} (signed-out): REQUIRED -- no Help menu for a signed-out visitor`);
      assert(pageErrors.length === 0, `1) ${pageName} (signed-out): no uncaught page errors (got: ${JSON.stringify(pageErrors)})`);
    });
  }

  // =========================================================================
  // 2) Signed-in nav: Dashboard | Why House Accounts | Real-World Results |
  //    Pricing + Help (with Upload Guides inside it) + Add Customer
  //    Data/Settings/Sign Out, on the homepage and both new/canonical pages.
  //    Never a separate conceptual home for these pages based on auth state.
  // =========================================================================
  for(const [pageName, pagePath] of [['Homepage', '/'], ['Why House Accounts', '/why-house-accounts.html'], ['Real-World Results', '/real-world-results.html']]){
    await withPage(baseUrl, {authenticated: true}, async (page, pageErrors) => {
      await page.goto(`${baseUrl}${pagePath}`, {waitUntil: 'load'});
      await page.waitForSelector('#haSharedHeader', {state: 'attached'});
      await assertNavHeaderText(page, `2) ${pageName} (signed-in)`);
      const headerText = await page.locator('#haSharedHeader').innerText();
      assert(/Dashboard/.test(headerText), `2) ${pageName} (signed-in): REQUIRED -- Dashboard leads the authenticated nav`);
      assert(!/\bUpload Guides\b/.test(headerText.split('Help')[0]), `2) ${pageName} (signed-in): sanity -- Upload Guides is not visible in primary nav before Help is opened`);
      assert(/Add Customer Data/.test(headerText) && /Settings/.test(headerText) && /Sign Out/.test(headerText), `2) ${pageName} (signed-in): authenticated utilities are present`);

      await page.click('#haHelpToggle');
      const dropdownText = await page.locator('#haHelpDropdown').innerText();
      assert(/Upload Guides/.test(dropdownText), `2) ${pageName} (signed-in): REQUIRED -- Upload Guides is reachable inside Help`);
      assert(!/Why House Accounts/.test(dropdownText) && !/Real-World Results/.test(dropdownText), `2) ${pageName} (signed-in): REQUIRED -- Why House Accounts/Real-World Results are never added to Help`);
      const uploadGuidesHref = await page.locator('#haHelpDropdown a', {hasText: 'Upload Guides'}).getAttribute('href');
      assert(uploadGuidesHref === '/export-guides/', `2) ${pageName} (signed-in): Upload Guides in Help links to /export-guides/ (got "${uploadGuidesHref}")`);

      assert(pageErrors.length === 0, `2) ${pageName} (signed-in): no uncaught page errors (got: ${JSON.stringify(pageErrors)})`);
    });
  }

  // =========================================================================
  // 3) Homepage bridge links actually navigate to the two new destinations.
  // =========================================================================
  await withPage(baseUrl, {authenticated: false}, async (page, pageErrors) => {
    await page.goto(`${baseUrl}/`, {waitUntil: 'load'});
    await page.waitForSelector('.bridge-grid', {state: 'visible'});
    const bridgeText = await page.locator('.bridge-grid').innerText();
    assert(/Why we built this/i.test(bridgeText), '3) homepage bridge section is visible with the "why" module');
    assert(/Does it work\?/i.test(bridgeText), '3) homepage bridge section is visible with the proof module');

    await page.click('.bridge-grid a[href="/why-house-accounts.html"]');
    await page.waitForSelector('#page-title, h2', {state: 'visible'});
    assert(page.url().includes('/why-house-accounts.html'), '3) REQUIRED: clicking the "why" bridge link navigates to Why House Accounts');
    assert((await page.locator('h2').first().innerText()).includes('Who should I contact next'), '3) REQUIRED: Why House Accounts renders its real content after navigating from the homepage bridge');

    await page.goBack({waitUntil: 'load'});
    await page.waitForSelector('.bridge-grid', {state: 'visible'});
    await page.click('.bridge-grid a[href="/real-world-results.html"]');
    await page.waitForSelector('#page-title', {state: 'visible'});
    assert(page.url().includes('/real-world-results.html'), '3) REQUIRED: clicking the proof bridge link navigates to Real-World Results');
    assert((await page.locator('#page-title').innerText()).includes('Real'), '3) REQUIRED: Real-World Results renders its real content after navigating from the homepage bridge');

    assert(pageErrors.length === 0, `3) no uncaught page errors on the homepage bridge flow (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 4) Product Tour step 2: real spotlight on #haHelpToggle, real copy,
  //    and the Help dropdown itself stays closed while the step displays
  //    (no programmatic open just to preserve the old target).
  // =========================================================================
  await withPage(baseUrl, {authenticated: true}, async (page, pageErrors) => {
    await page.goto(`${baseUrl}/dashboard/#restart-tour`, {waitUntil: 'load'});
    await page.waitForSelector('#haTourCard', {state: 'visible'});
    const step1Title = await page.locator('#haTourTitle').innerText();
    assert(step1Title === 'Add Customer Data', `4) sanity: the tour opens on step 1 (got "${step1Title}")`);

    await page.click('#haTourNextBtn');
    await page.waitForFunction(() => document.getElementById('haTourTitle')?.textContent === 'Upload Guides');
    const step2Body = await page.locator('#haTourBody').innerText();
    assert(step2Body === 'Need help preparing or uploading customer data? Upload Guides are always available under Help.', `4) REQUIRED: tour step 2 uses the exact approved copy (got "${step2Body}")`);

    // REQUIRED: the spotlight is really anchored on the Help toggle, not
    // centered/fallback -- and the Help dropdown itself never opens.
    const spotlightHidden = await page.locator('#haTourSpotlight').isHidden();
    assert(!spotlightHidden, '4) REQUIRED: the tour spotlight is visible (not the centered-card fallback) for step 2');
    const cardIsCentered = await page.locator('#haTourCard').evaluate(el => el.classList.contains('centered'));
    assert(!cardIsCentered, '4) REQUIRED: step 2 spotlights a real, visible element -- it never falls back to the centered-card state');
    const helpToggleRect = await page.locator('#haHelpToggle').boundingBox();
    const spotlightRect = await page.locator('#haTourSpotlight').boundingBox();
    assert(!!helpToggleRect && !!spotlightRect && Math.abs(helpToggleRect.x - spotlightRect.x) < 40 && Math.abs(helpToggleRect.y - spotlightRect.y) < 40, `4) REQUIRED: the spotlight is positioned over the real Help toggle (help: ${JSON.stringify(helpToggleRect)}, spotlight: ${JSON.stringify(spotlightRect)})`);
    const helpDropdownHidden = await page.locator('#haHelpDropdown').isHidden();
    assert(helpDropdownHidden, '4) REQUIRED: the Help dropdown itself stays closed while this step displays -- the tour never programmatically opens it');

    assert(pageErrors.length === 0, `4) no uncaught page errors on the tour step-2 correction (got: ${JSON.stringify(pageErrors)})`);
  });

  await server.close();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
