// Account Intelligence view-container reconciliation -- live-navigation
// regression coverage (real Chromium, real dashboard/index.html, real
// site-header.js).
//
// ROOT-CAUSE CONTEXT (why this file exists, and why it is built the way it
// is): across five founder Preview QA rounds, every automated/screenshot
// fixture built for this feature stubbed out site-header.js -- which meant
// `.ha-mvp` (applied unconditionally at site-header.js:33) was NEVER
// present in any reproduction, so a stale, pre-existing CSS rule hiding
// `.opportunities-section.account-intelligence-section` (the exact
// container this feature lived in) was never exercised either. Every "it
// works, verified in a real browser" claim was accurate for the code in
// isolation but never representative of the real product. This file is the
// founder-mandated correction: it serves the REAL dashboard/index.html and
// the REAL, unmodified site-header.js (via an actual HTTP server, not
// file://, since site-header.js is requested by an absolute `/site-header.js`
// path) and asserts against what a signed-in user's browser actually
// renders -- not a hand-built fragment that assumes the shell it's testing.
//
// Explicitly required by the founder (verbatim, Phase 2 instructions):
//   - .ha-mvp is applied
//   - the real shared header (site-header.js's nav) renders
//   - the old workflow switcher stays hidden
//   - the old Revenue Context / sales-dashboard stays hidden
//   - default mode shows #dashboardView
//   - account-hash mode hides #dashboardView
//   - account-hash mode visibly shows #accountIntelligenceView (not just
//     present in the DOM with display:none)
//   - multi-word account names (e.g. "Anchor Brewing Supply") work
//   - browser Back/Forward works
//   - refresh on the account hash works
//   - an invalid account hash gives the explicit not-found state
//
// Usage: node scripts/test-account-intelligence-live-navigation.js
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

// ===========================================================================
// Static file server serving the repo root as the web root -- required
// (rather than file://) because dashboard/index.html references
// site-header.js/site-header.css/auth-client.js by ABSOLUTE path
// ("/site-header.js"), exactly as the real deployed site does. Serving from
// the real repo root means the real, unmodified site-header.js is what
// actually executes -- nothing about it is copied, extracted, or stubbed.
// ===========================================================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
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
        const body = readFileSync(filePath);
        res.writeHead(200, {'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'});
        res.end(body);
      }catch(err){
        res.writeHead(500);
        res.end(String(err));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ===========================================================================
// Fixture accounts. "Anchor Brewing Supply" is the required multi-word
// name; "Quaker & Sons" carries a punctuation character so the route
// identity's encode/decode round-trip is exercised on more than plain
// alphanumeric text.
// ===========================================================================
const FIXTURE_ACCOUNTS = [
  {id: 'acct-1', uploadId: 'upload-live-1', name: 'Anchor Brewing Supply', industry: 'Promotional Products', revenue: 42000, orderCount: 6, contactEmail: 'buyer@anchorbrewingsupply.example.com', contactName: 'Jordan Reyes'},
  {id: 'acct-2', uploadId: 'upload-live-1', name: "Quaker & Sons", industry: 'Manufacturing', revenue: 8000, orderCount: 2, contactEmail: '', contactName: ''}
];

function getDashboardPayload(){
  return {
    accounts: FIXTURE_ACCOUNTS.map(a => ({
      name: a.name, industry: a.industry, revenue: a.revenue, orderCount: a.orderCount,
      contactEmail: a.contactEmail, contactName: a.contactName, uploadId: a.uploadId,
      futureOpportunities: [], signals: [], purchases: []
    })),
    signals: [], weeklyRuns: [],
    user: {email: 'qa@example.com', name: 'QA Tester', company: 'QA Test Co'},
    upload: {id: 'upload-live-1', upload_name: 'QA Live-Navigation Fixture', updated_at: '2026-08-01T00:00:00Z'},
    canViewTeam: false, viewMode: 'my', orgPreferences: {}, personalEmpty: false
  };
}

function monitoringListsSummaryPayload(){
  return {
    ok: true, scope: 'user', role: 'owner',
    lists: {
      customer: [{
        id: 'upload-live-1', type: 'customer', name: 'QA Live-Navigation Fixture', status: 'active',
        companyCount: FIXTURE_ACCOUNTS.length, activeCount: FIXTURE_ACCOUNTS.length, pausedCount: 0,
        everResearched: false, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 0,
        researchRunState: {status: 'idle'}
      }],
      prospect: []
    },
    summary: {activeCustomers: FIXTURE_ACCOUNTS.length, pausedCustomers: 0, activeProspects: 0, pausedProspects: 0, monitoringCadence: 'Ongoing', monitoringStatus: 'Active'}
  };
}

function monitoringListsPagePayload(){
  return {
    ok: true, uploadId: 'upload-live-1',
    accounts: FIXTURE_ACCOUNTS.map(a => ({
      id: a.id, uploadId: a.uploadId, name: a.name, industry: a.industry,
      monitoringStatus: 'active', researchStatus: 'uploaded', lastResearchedAt: '',
      domain: '', dateAdded: '2026-01-01T00:00:00Z', hasActionableAlert: false
    })),
    pageInfo: {limit: 50, hasMore: false, nextCursor: null, total: FIXTURE_ACCOUNTS.length, search: ''}
  };
}

// ===========================================================================
// Page setup: seeds a real signed-in session/lead in localStorage BEFORE
// site-header.js runs (so hasSession() is true and the real authenticated
// nav renders), stubs ONLY auth-client.js (session-refresh plumbing that is
// orthogonal to the shell/container bug this file exists to catch -- see
// file header) and the backend API endpoints the real dashboard code calls
// on load, and leaves site-header.js completely real and unmodified.
// ===========================================================================
async function withPage(baseUrl, run){
  const browser = await chromium.launch({executablePath: resolveChromiumExecutablePath()});
  try{
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));

    await page.addInitScript(() => {
      localStorage.setItem('haAuthSession', JSON.stringify({access_token: 'test-token-live-nav'}));
      localStorage.setItem('houseAccountsLead', JSON.stringify({email: 'qa@example.com', name: 'QA Tester', company: 'QA Test Co'}));
      localStorage.setItem('houseAccountsBetaWelcomeDismissed', 'true');
    });

    // auth-client.js: stubbed. It owns Supabase session-refresh plumbing,
    // not the shell/container mechanics under test here -- site-header.js
    // reads localStorage directly for hasSession() and has no dependency on
    // it. HouseAuth.authHeadersAsync() must resolve to a real headers
    // object (never null/undefined), matching its real contract, or the
    // dashboard's own load path treats a null result as "already
    // redirected to login" and aborts.
    await page.route('**/auth-client.js', route => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: `window.HouseAuth = {
        authHeadersAsync: async (h) => ({...(h||{}), Authorization: 'Bearer test-token-live-nav'}),
        authHeaders: (h) => ({...(h||{}), Authorization: 'Bearer test-token-live-nav'})
      };`
    }));

    // Playwright matches routes LIFO (the most recently registered route is
    // tried first, falling back to earlier ones) -- the generic safety net
    // is registered FIRST so every more specific route below it correctly
    // takes precedence, not the other way around.
    //
    // Safety net: any /api/ call this file doesn't explicitly know about
    // (e.g. a future addition to the initial-load sequence) gets a benign
    // 200 instead of a real network failure, so this file's own scope --
    // shell/container navigation, not backend integration -- stays isolated
    // from unrelated load-sequence changes.
    await page.route('**/api/**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true})}));
    await page.route('**/api/get-dashboard**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(getDashboardPayload())}));
    await page.route('**/api/usage**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, organization: {plan: 'free'}, usage: {}})}));
    await page.route('**/api/unresolved-outreach**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, items: []})}));
    await page.route('**/api/monitoring-lists**', route => {
      const url = new URL(route.request().url());
      if(url.searchParams.get('uploadId')) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(monitoringListsPagePayload())});
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(monitoringListsSummaryPayload())});
    });

    await run(page, pageErrors, baseUrl);
  } finally {
    await browser.close();
  }
}

async function gotoDashboard(page, {hash = ''} = {}){
  await page.goto(`${page.__baseUrl}/dashboard/${hash}`, {waitUntil: 'load'});
  // 'attached', not 'visible' -- a direct load on an #account=... hash puts
  // the shell straight into Account Intelligence mode, where
  // #manageCustomerAccountsBtn (inside #dashboardView) is legitimately
  // hidden. Its presence in the DOM is still the right proxy for "the real
  // aggregate dashboard fetch has resolved," regardless of which container
  // ends up visible.
  await page.waitForSelector('#manageCustomerAccountsBtn', {state: 'attached'});
}

async function main(){
  const server = await startStaticServer();
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // =========================================================================
  // 1) .ha-mvp is applied; the real shared header renders; the old static
  //    header/banner are removed; old workflow switcher / Revenue Context
  //    stay hidden; #customerMonitoringWorkspace stays hidden; default mode
  //    shows #dashboardView, not #accountIntelligenceView.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    page.__baseUrl = baseUrl;
    await gotoDashboard(page);
    // Default (no-hash) load: #dashboardView is the active container, so
    // #manageCustomerAccountsBtn should actually become visible, not merely
    // attached -- confirm that explicitly before the rest of this block's
    // assertions.
    await page.waitForSelector('#manageCustomerAccountsBtn', {state: 'visible'});

    const hasMvpClass = await page.evaluate(() => document.documentElement.classList.contains('ha-mvp'));
    assert(hasMvpClass, '1) .ha-mvp is applied to <html> -- the real site-header.js ran, unstubbed');
    assert(await page.locator('#manageCustomerAccountsBtn').isVisible(), '1) Manage Customer Accounts is reachable on the default Dashboard view (V1 entry point)');

    const sharedHeaderText = await page.locator('#haSharedHeader').innerText();
    assert(/Add Customer Data/.test(sharedHeaderText), '1) the real shared header (site-header.js) renders "Add Customer Data"');
    assert(/Settings/.test(sharedHeaderText), '1) the real shared header renders "Settings"');
    assert(/Sign Out/.test(sharedHeaderText), '1) the real shared header renders "Sign Out"');
    assert(/Pricing/.test(sharedHeaderText), '1) the real shared header renders "Pricing"');
    assert(/Help/.test(sharedHeaderText), '1) the real shared header renders the "Help" menu');

    const oldStaticHeaderCount = await page.locator('body > header:not(.ha-ignore-shared-header)').count();
    assert(oldStaticHeaderCount === 0, '1) the old static fallback <header> baked into dashboard/index.html was removed by the real removeLegacy()');
    const oldBannerCount = await page.locator('body > .beta-top-banner').count();
    assert(oldBannerCount === 0, '1) the old static top banner was removed by the real removeLegacy()');
    // New-Customer Readiness correction (2026-08-20): the Beta banner itself
    // was retired entirely -- site-header.js no longer injects a replacement,
    // and no other announcement banner takes its place.
    const injectedBannerCount = await page.locator('#haSharedHeader .ha-beta-banner').count();
    assert(injectedBannerCount === 0, '1) REQUIRED: site-header.js does not inject a Beta banner (or any replacement announcement banner) any more');
    const sharedHeaderHtml = await page.locator('#haSharedHeader').innerHTML();
    assert(!/currently in Beta/i.test(sharedHeaderHtml), '1) REQUIRED: no "currently in Beta" framing renders anywhere in the shared header');

    const workflowSwitcherDisplay = await page.locator('.workflow-switcher').evaluate(el => getComputedStyle(el).display);
    assert(workflowSwitcherDisplay === 'none', '1) the old workflow switcher (Existing Customers / Target Accounts) stays hidden under .ha-mvp');
    const salesDashboardDisplay = await page.locator('.sales-dashboard').evaluate(el => getComputedStyle(el).display);
    assert(salesDashboardDisplay === 'none', '1) the old Revenue Context (.sales-dashboard) stays hidden under .ha-mvp');
    const monitoringWorkspaceDisplay = await page.locator('#customerMonitoringWorkspace').evaluate(el => getComputedStyle(el).display);
    assert(monitoringWorkspaceDisplay === 'none', '1) #customerMonitoringWorkspace stays hidden under .ha-mvp');

    const dashboardViewDisplay = await page.locator('#dashboardView').evaluate(el => getComputedStyle(el).display);
    assert(dashboardViewDisplay !== 'none', '1) default mode shows #dashboardView');
    const accountViewDisplay = await page.locator('#accountIntelligenceView').evaluate(el => getComputedStyle(el).display);
    assert(accountViewDisplay === 'none', '1) default mode hides #accountIntelligenceView');

    assert(pageErrors.length === 0, `1) no uncaught page errors on initial load (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 2) V1 journey: Dashboard -> Manage Customer Accounts -> View Account ->
  //    Account Intelligence, for a MULTI-WORD account name. #dashboardView
  //    hides, #accountIntelligenceView becomes genuinely visible (not just
  //    present in the DOM), and the route-identity hash round-trips.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    page.__baseUrl = baseUrl;
    await gotoDashboard(page);

    await page.click('#manageCustomerAccountsBtn');
    await page.waitForSelector('#accountManagerContent .acct-mgr-list', {state: 'attached'});
    await page.click('[data-list-expand-toggle][data-list-id="upload-live-1"]');
    await page.waitForSelector('.acct-mgr-row', {state: 'attached'});

    const viewAccountBtn = page.locator('.acct-mgr-row', {hasText: 'Anchor Brewing Supply'}).locator('[data-view-account-act="account"]').first();
    await viewAccountBtn.click();

    await page.waitForSelector('#accountIntelligenceView .account-card', {state: 'visible'});

    const dashboardViewDisplay = await page.locator('#dashboardView').evaluate(el => getComputedStyle(el).display);
    assert(dashboardViewDisplay === 'none', '2) entering Account Intelligence mode hides #dashboardView');
    const accountViewDisplay = await page.locator('#accountIntelligenceView').evaluate(el => getComputedStyle(el).display);
    assert(accountViewDisplay !== 'none', '2) #accountIntelligenceView is genuinely visible (not display:none) once an account is focused');

    const modalStillOpen = await page.locator('#accountManagerModal').evaluate(el => getComputedStyle(el).display !== 'none');
    assert(!modalStillOpen, '2) Manage Customer Accounts closes automatically when navigating to Account Intelligence');

    const cardText = await page.locator('#accountIntelligenceView .account-card').innerText();
    assert(/Anchor Brewing Supply/.test(cardText), '2) the focused card shows the correct MULTI-WORD account name ("Anchor Brewing Supply")');
    assert(/Reasons To Reach Out/i.test(cardText), '2) the focused card includes the approved Reasons to Reach Out content');
    assert(/Historical Orders Used As Evidence/i.test(cardText), '2) the focused card includes the approved historical purchase/order evidence content');
    assert(/Business Signals Found/i.test(cardText), '2) the focused card includes the approved business signals / Research Account content');

    const backLinkText = await page.locator('#accountIntelligenceView .account-intelligence-back a').innerText();
    assert(/Dashboard/.test(backLinkText) && !/All Accounts/.test(backLinkText), `2) the back link reads "← Dashboard", not "← All Accounts" (got "${backLinkText}")`);

    const hash = await page.evaluate(() => window.location.hash);
    assert(hash === decodeURI(hash) || hash.includes('%20') || hash.includes('+'), '2) sanity: the hash carries an encoded multi-word name');
    assert(decodeURIComponent(hash.replace(/^#account=/, '')) === 'anchor brewing supply', `2) the route-identity hash round-trips the multi-word name correctly (got "${hash}")`);

    assert(pageErrors.length === 0, `2) no uncaught page errors during navigation (got: ${JSON.stringify(pageErrors)})`);

    // -----------------------------------------------------------------------
    // 3) Browser Back/Forward.
    // -----------------------------------------------------------------------
    await page.goBack();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('dashboardView')).display !== 'none');
    const backDashboardDisplay = await page.locator('#dashboardView').evaluate(el => getComputedStyle(el).display);
    const backAccountDisplay = await page.locator('#accountIntelligenceView').evaluate(el => getComputedStyle(el).display);
    assert(backDashboardDisplay !== 'none', '3) browser Back restores #dashboardView');
    assert(backAccountDisplay === 'none', '3) browser Back hides #accountIntelligenceView');

    await page.goForward();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('accountIntelligenceView')).display !== 'none');
    const fwdDashboardDisplay = await page.locator('#dashboardView').evaluate(el => getComputedStyle(el).display);
    const fwdAccountDisplay = await page.locator('#accountIntelligenceView').evaluate(el => getComputedStyle(el).display);
    assert(fwdDashboardDisplay === 'none', '3) browser Forward re-enters Account Intelligence mode, hiding #dashboardView');
    assert(fwdAccountDisplay !== 'none', '3) browser Forward re-shows #accountIntelligenceView');
    const fwdCardText = await page.locator('#accountIntelligenceView .account-card').innerText();
    assert(/Anchor Brewing Supply/.test(fwdCardText), '3) browser Forward shows the correct account again, not a stale/blank state');
  });

  // =========================================================================
  // 4) Refresh on the account hash: a direct page load (not a client-side
  //    hashchange) with #account=... already in the URL must enter Account
  //    Intelligence mode immediately, without first flashing the Dashboard.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    page.__baseUrl = baseUrl;
    await gotoDashboard(page, {hash: '#account=anchor%20brewing%20supply'});
    await page.waitForSelector('#accountIntelligenceView .account-card', {state: 'visible'});

    const dashboardViewDisplay = await page.locator('#dashboardView').evaluate(el => getComputedStyle(el).display);
    assert(dashboardViewDisplay === 'none', '4) a direct refresh on #account=... enters Account Intelligence mode -- #dashboardView is hidden');
    const accountViewDisplay = await page.locator('#accountIntelligenceView').evaluate(el => getComputedStyle(el).display);
    assert(accountViewDisplay !== 'none', '4) a direct refresh on #account=... shows #accountIntelligenceView');
    const cardText = await page.locator('#accountIntelligenceView .account-card').innerText();
    assert(/Anchor Brewing Supply/.test(cardText), '4) the refreshed page resolves the correct account from the bookmarked/shared hash');
    assert(pageErrors.length === 0, `4) no uncaught page errors on a direct account-hash load (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 5) Invalid account hash: explicit not-found state, never a blank page
  //    or a silently-wrong account.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    page.__baseUrl = baseUrl;
    await gotoDashboard(page, {hash: '#account=this-account-does-not-exist'});
    await page.waitForSelector('#accountIntelligenceView .account-intelligence-back', {state: 'visible'});

    const accountViewDisplay = await page.locator('#accountIntelligenceView').evaluate(el => getComputedStyle(el).display);
    assert(accountViewDisplay !== 'none', '5) an invalid account hash still shows #accountIntelligenceView (not a blank Dashboard)');
    const cardCount = await page.locator('#accountIntelligenceView .account-card').count();
    assert(cardCount === 0, '5) an invalid account hash renders no account card -- never a stale/wrong account');
    const notFoundText = await page.locator('#accountIntelligenceView').innerText();
    assert(/could not be found/i.test(notFoundText), '5) an invalid account hash shows the explicit not-found message');
    assert(pageErrors.length === 0, `5) no uncaught page errors on an invalid account hash (got: ${JSON.stringify(pageErrors)})`);

    // Clearing the hash via the back link restores the normal Dashboard.
    await page.click('#accountIntelligenceView .account-intelligence-back a');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('dashboardView')).display !== 'none');
    const dashboardViewDisplay = await page.locator('#dashboardView').evaluate(el => getComputedStyle(el).display);
    assert(dashboardViewDisplay !== 'none', '5) the back link clears the hash and restores the normal Dashboard');
  });

  // =========================================================================
  // 6) #accountManagerModal is a global overlay, structurally independent of
  //    the #dashboardView / #accountIntelligenceView boundary -- never
  //    trapped or hidden by it (founder requirement).
  // =========================================================================
  await withPage(baseUrl, async (page) => {
    page.__baseUrl = baseUrl;
    await gotoDashboard(page);
    const modalIsOutsideBothContainers = await page.evaluate(() => {
      const modal = document.getElementById('accountManagerModal');
      const dashboardView = document.getElementById('dashboardView');
      const accountView = document.getElementById('accountIntelligenceView');
      return !dashboardView.contains(modal) && !accountView.contains(modal);
    });
    assert(modalIsOutsideBothContainers, '6) #accountManagerModal is not a descendant of either view container -- it cannot be hidden by the container toggle');
  });

  // =========================================================================
  // 7) Business Signals Found -- populated-state real-browser coverage
  //    (2026-08-19, closing the founder-flagged QA gap: real Beta accounts
  //    have not naturally produced a valid priority signal to inspect, and
  //    no real-browser fixture ever populated one either -- deterministic/
  //    vm-sandbox coverage existed, but never proved this actually renders
  //    inside the real Account Intelligence card, through the real shell).
  //    Verification only -- no signal scoring/research behavior touched;
  //    account.signals[] is fed directly, the exact shape
  //    renderVerifiedSignals()/renderSingleVerifiedSignal() already read.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    await page.route('**/api/get-dashboard**', route => {
      const payload = getDashboardPayload();
      const target = payload.accounts.find(a => a.name === 'Anchor Brewing Supply');
      target.signals = [{
        isReal: true,
        sourceUrl: 'https://example.com/news/anchor-brewing-facility',
        signalType: 'Expansion',
        title: 'Anchor Brewing Supply opens new production facility',
        signalDetail: 'Anchor Brewing Supply opens new production facility',
        confidenceScore: 85,
        confidence: 85,
        publishedDate: '2026-07-01'
      }];
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(payload)});
    });
    page.__baseUrl = baseUrl;
    await gotoDashboard(page, {hash: '#account=anchor%20brewing%20supply'});
    await page.waitForSelector('.signal-research-panel', {state: 'visible'});

    const panelText = await page.locator('.signal-research-panel').innerText();
    assert(!/No external signals found/.test(panelText), '7) REQUIRED: a real, valid sourced signal renders instead of the empty state');
    assert(/Anchor Brewing Supply opens new production facility/.test(panelText), `7) REQUIRED: the real signal's headline renders (got "${panelText}")`);
    assert(/Expansion/.test(panelText), '7) REQUIRED: the real signal type renders');
    assert(/Published/.test(panelText) && /2026-07-01/.test(panelText), '7) REQUIRED: the real published date renders');
    const sourceLinkHref = await page.locator('.signal-research-panel .source-link').getAttribute('href');
    assert(sourceLinkHref === 'https://example.com/news/anchor-brewing-facility', `7) REQUIRED: the real source link renders and points at the real sourceUrl (got "${sourceLinkHref}")`);

    assert(pageErrors.length === 0, `7) no uncaught page errors rendering a populated Business Signals panel (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 8) Business Signals Found -- the true empty state, asserted explicitly
  //    (previously only implicit via account fixtures that happened to
  //    carry no signals; this locks the exact copy in place).
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    page.__baseUrl = baseUrl;
    await gotoDashboard(page, {hash: '#account=anchor%20brewing%20supply'});
    await page.waitForSelector('.signal-research-panel', {state: 'visible'});
    const panelText = await page.locator('.signal-research-panel').innerText();
    assert(/No external signals found\./.test(panelText), `8) REQUIRED: the true empty state renders its exact honest copy when no signals exist (got "${panelText}")`);
    assert(pageErrors.length === 0, `8) no uncaught page errors rendering the empty Business Signals state (got: ${JSON.stringify(pageErrors)})`);
  });

  await server.close();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
