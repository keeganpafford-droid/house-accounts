// Product Cohesion / Guided Activation -- Round 3 smallest simplification
// slice, live-navigation regression coverage (real Chromium, real
// dashboard/index.html, real site-header.js). Same harness convention as
// scripts/test-account-intelligence-live-navigation.js (see that file's own
// header comment for why file:// is not viable and why site-header.js is
// served for real, unstubbed).
//
// Proves the exact 9-row Round 3 before -> after table where it required
// real DOM/routing behavior, not just a copy/label change a deterministic
// vm-sandbox extraction can already prove:
//   - "View Account" (Manage Customer Accounts) is retired -- the account
//     name link is the sole entry point into Account Intelligence, and it
//     still works.
//   - "View Research" deep-links into Account Intelligence's own Business
//     Signal evidence, scrolled into view, instead of opening a separate
//     results view -- no duplicate Account/View Research destination
//     remains, and the underlying research evidence is still reachable.
//   - The return-visit monitoring empty state no longer tells a rep to
//     upload/refresh.
//   - Active Expansion Plays render with a distinct icon from Reasons to
//     Reach Out (no visual collision).
//   - The Whitespace Intelligence section now carries a "Relationships"
//     heading.
//
// Usage: node scripts/test-cohesion-navigation-live.js
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
const UPLOAD_ID = 'upload-cohesion-1';

// A real, sourced signal (View Research needs signalCount > 0 to render at
// all in Manage Customer Accounts) plus a real two-year Headwear repeat
// pattern and a Marketing contact -- the exact fixture shape
// test-whitespace-cell-answers-live.js's own section 11 already
// established for a real Active Expansion Play, reused here so the icon-
// distinctness assertion is proven against a genuinely eligible play, not
// a stub.
function getDashboardPayload(){
  return {
    accounts: [{
      name: ACCOUNT_NAME, industry: 'Promotional Products', revenue: 42000, orderCount: 6, uploadId: UPLOAD_ID,
      contacts: [{ name: 'Jordan Reyes', title: 'Marketing Manager', department: 'Marketing' }],
      categoryTypes: ['Apparel'],
      purchases: [
        { category: 'Headwear', revenue: 1500, date: '2024-03-10' },
        { category: 'Headwear', revenue: 1800, date: '2025-03-12' }
      ],
      futureOpportunities: [],
      signals: [{
        isReal: true, sourceUrl: 'https://example.com/news/anchor-brewing-facility',
        signalType: 'Expansion', title: 'Anchor Brewing Supply opens new production facility',
        signalDetail: 'Anchor Brewing Supply opens new production facility',
        confidenceScore: 85, confidence: 85, publishedDate: '2026-07-01'
      }],
      lastResearchedAt: '2026-08-10T12:00:00Z'
    }],
    signals: [], weeklyRuns: [],
    user: {email: 'qa@example.com', name: 'QA Tester', company: 'QA Test Co'},
    upload: {id: UPLOAD_ID, upload_name: 'QA Cohesion Fixture', updated_at: '2026-08-01T00:00:00Z'},
    canViewTeam: false, viewMode: 'my', orgPreferences: {}, personalEmpty: false
  };
}

let cellAnswerStore = { 'Marketing||Headwear': 'whitespace' };
let confirmedCenterStore = [];

async function withPage(baseUrl, run){
  const browser = await chromium.launch({executablePath: resolveChromiumExecutablePath()});
  try{
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));

    await page.addInitScript(() => {
      localStorage.setItem('haAuthSession', JSON.stringify({access_token: 'test-token-cohesion'}));
      localStorage.setItem('houseAccountsLead', JSON.stringify({email: 'qa@example.com', name: 'QA Tester', company: 'QA Test Co'}));
      localStorage.setItem('houseAccountsBetaWelcomeDismissed', 'true');
    });

    await page.route('**/auth-client.js', route => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: `window.HouseAuth = {
        authHeadersAsync: async (h) => ({...(h||{}), Authorization: 'Bearer test-token-cohesion'}),
        authHeaders: (h) => ({...(h||{}), Authorization: 'Bearer test-token-cohesion'})
      };`
    }));

    // Registered first so every more specific route below (matched LIFO)
    // correctly overrides it.
    await page.route('**/api/**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true})}));
    await page.route('**/api/get-dashboard**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(getDashboardPayload())}));
    await page.route('**/api/usage**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, organization: {plan: 'free'}, usage: {}})}));
    await page.route('**/api/unresolved-outreach**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, items: []})}));
    await page.route('**/api/whitespace-map**', async route => {
      const req = route.request();
      if(req.method() === 'POST'){
        const body = JSON.parse(req.postData() || '{}');
        const idx = confirmedCenterStore.indexOf(body.buyingCenter);
        if(idx === -1) confirmedCenterStore.push(body.buyingCenter); else confirmedCenterStore.splice(idx, 1);
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, confirmedCenters: [...confirmedCenterStore]})});
      }
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, confirmations: {['anchor brewing supply']: [...confirmedCenterStore]}, confirmedCenters: [...confirmedCenterStore]})});
    });
    await page.route('**/api/whitespace-cell-answers**', async route => {
      const req = route.request();
      if(req.method() === 'GET') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, answers: {['anchor brewing supply']: {...cellAnswerStore}}})});
      return route.fulfill({status: 405, contentType: 'application/json', body: JSON.stringify({error: 'Method not allowed'})});
    });
    // Manage Customer Accounts' own row data -- researched, with a real
    // signal count, so "View Research" actually renders (signalCount > 0
    // gate) and the row reads "Refresh Research" (lastResearchedAt set).
    await page.route('**/api/monitoring-lists**', route => {
      const url = new URL(route.request().url());
      if(url.searchParams.get('uploadId')){
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: true, uploadId: UPLOAD_ID,
          accounts: [{ id: 'acct-cohesion-1', uploadId: UPLOAD_ID, name: ACCOUNT_NAME, industry: 'Promotional Products', monitoringStatus: 'active', researchStatus: 'complete', lastResearchedAt: '2026-08-10T12:00:00Z', domain: '', dateAdded: '2026-01-01T00:00:00Z', hasActionableAlert: false }],
          pageInfo: {limit: 50, hasMore: false, nextCursor: null, total: 1, search: ''}
        })});
      }
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, scope: 'user', role: 'owner',
        lists: {customer: [{id: UPLOAD_ID, type: 'customer', name: 'QA Cohesion Fixture', status: 'active', companyCount: 1, activeCount: 1, pausedCount: 0, everResearched: true, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 1, researchRunState: {status: 'idle'}}], prospect: []},
        summary: {activeCustomers: 1, pausedCustomers: 0, activeProspects: 0, pausedProspects: 0, monitoringCadence: 'Ongoing', monitoringStatus: 'Active'}
      })});
    });

    await run(page, pageErrors);
  } finally {
    await browser.close();
  }
}

async function gotoDashboard(page, {hash = ''} = {}){
  await page.goto(`${baseUrl_(page)}/dashboard/${hash}`, {waitUntil: 'load'});
  await page.waitForSelector('#manageCustomerAccountsBtn', {state: 'attached'});
}
function baseUrl_(page){ return page.__baseUrl; }

async function main(){
  const server = await startStaticServer();
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // =========================================================================
  // 1) Dashboard routes correctly into a customer via the account name
  //    link -- the SAME entry point as before, still working after the
  //    separate "View Account" button was retired.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    page.__baseUrl = baseUrl;
    await gotoDashboard(page);
    await page.waitForSelector('#manageCustomerAccountsBtn', {state: 'visible'});
    await page.click('#manageCustomerAccountsBtn');
    await page.waitForSelector('#accountManagerContent .acct-mgr-list', {state: 'attached'});
    await page.click(`[data-list-expand-toggle][data-list-id="${UPLOAD_ID}"]`);
    await page.waitForSelector('.acct-mgr-row', {state: 'attached'});

    // 2) REQUIRED: no separate "View Account" button remains -- the
    //    account name is the sole [data-view-account-act="account"]
    //    control, and it is a real <a>, not a <button>.
    const viewAccountMarkers = page.locator('.acct-mgr-row [data-view-account-act="account"]');
    assert(await viewAccountMarkers.count() === 1, `2) REQUIRED: exactly one data-view-account-act control remains per row (got ${await viewAccountMarkers.count()})`);
    const tagName = await viewAccountMarkers.first().evaluate(el => el.tagName.toLowerCase());
    assert(tagName === 'a', `2) REQUIRED: the sole entry point is the account name link, not a separate button (got <${tagName}>)`);
    const rowText = await page.locator('.acct-mgr-row').first().innerText();
    assert(!/View Account/.test(rowText), '2) REQUIRED: the row never shows the retired "View Account" label');

    await viewAccountMarkers.first().click();
    await page.waitForSelector('#accountIntelligenceView .account-card', {state: 'visible'});
    const modalStillOpen = await page.locator('#accountManagerModal').evaluate(el => getComputedStyle(el).display !== 'none');
    assert(!modalStillOpen, '1) REQUIRED: clicking the account name closes Manage Customer Accounts and lands in Account Intelligence');
    const cardText = await page.locator('#accountIntelligenceView .account-card').innerText();
    assert(new RegExp(ACCOUNT_NAME).test(cardText), '1) REQUIRED: Account Intelligence shows the correct account');

    assert(pageErrors.length === 0, `1/2) no uncaught page errors (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 3/4) "View Research" deep-links into Account Intelligence's own
  //      Business Signal evidence instead of opening a separate results
  //      view -- no duplicate destination, and the underlying research
  //      evidence (the real signal) is still fully reachable.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    page.__baseUrl = baseUrl;
    await gotoDashboard(page);
    await page.click('#manageCustomerAccountsBtn');
    await page.waitForSelector('#accountManagerContent .acct-mgr-list', {state: 'attached'});
    await page.click(`[data-list-expand-toggle][data-list-id="${UPLOAD_ID}"]`);
    await page.waitForSelector('.acct-mgr-row', {state: 'attached'});

    // .acct-mgr-action applies text-transform:uppercase visually --
    // compare case-insensitively against the real underlying label.
    const researchLabel = await page.locator('.acct-mgr-row [data-research-act="account"]').innerText();
    assert(researchLabel.toLowerCase() === 'refresh research', `3) sanity: a previously-researched account shows "Refresh Research" (got "${researchLabel}")`);

    const viewResearchBtn = page.locator('.acct-mgr-row [data-view-research-act="account"]');
    assert(await viewResearchBtn.count() === 1, '3) sanity: "View Research" renders for a real, signal-bearing account');
    await viewResearchBtn.click();

    // 4) REQUIRED: no duplicate destination -- Manage Customer Accounts
    //    closes, Account Intelligence becomes visible, and no separate
    //    research-results modal/overlay ever appears.
    await page.waitForSelector('#accountIntelligenceView .account-card', {state: 'visible'});
    const modalStillOpen = await page.locator('#accountManagerModal').evaluate(el => getComputedStyle(el).display !== 'none');
    assert(!modalStillOpen, '4) REQUIRED: "View Research" closes Manage Customer Accounts rather than layering a second view on top');
    const legacyResearchModalCount = await page.locator('.research-results-modal, #researchResultsModal, .prepare-for-call-modal:visible').count().catch(() => 0);
    assert(!legacyResearchModalCount, '4) REQUIRED: no separate research-results/Prepare-for-Call modal is opened -- Account Intelligence itself is the destination');

    // 3) REQUIRED: the underlying research evidence (the real signal) is
    //    still fully exposed -- nothing was deleted, only the destination
    //    changed -- and the section is scrolled into view/highlighted.
    //    highlightResultElement() fades this class after 4s (see its own
    //    doc comment/CSS animation) -- bounded well under that so a slow
    //    check never confuses "already faded" with "never applied".
    await page.waitForFunction(() => {
      const el = document.querySelector('.account-business-signals-title');
      return !!el && el.classList.contains('ha-just-researched-highlight');
    }, undefined, {timeout: 2500}).catch(() => {});
    const highlighted = await page.evaluate(() => {
      const el = document.querySelector('.account-business-signals-title');
      return !!el && el.classList.contains('ha-just-researched-highlight');
    });
    assert(highlighted, '3) REQUIRED: the Business Signal section is scrolled into view and visually highlighted after the deep-link');
    const signalsPanelText = await page.locator('.signal-research-panel').innerText();
    assert(/Anchor Brewing Supply opens new production facility/.test(signalsPanelText), `3) REQUIRED: the real, previously-found signal is still visible inside Account Intelligence after the "View Research" deep-link (got "${signalsPanelText}")`);
    assert(!/No external signals found/.test(signalsPanelText), '3) REQUIRED: the real signal renders, not an empty state');

    assert(pageErrors.length === 0, `3/4) no uncaught page errors on the View Research deep-link (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 5/6) Signal / Reason to Reach Out / Priority remain semantically
  //      distinct sections, and Active Expansion Plays render with a
  //      DISTINCT icon from Reasons to Reach Out -- no visual collision.
  //      Also: the Whitespace Intelligence section now carries a
  //      "Relationships" heading.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    page.__baseUrl = baseUrl;
    cellAnswerStore = { 'Marketing||Headwear': 'whitespace' };
    confirmedCenterStore = [];
    await gotoDashboard(page, {hash: '#account=anchor%20brewing%20supply'});
    await page.waitForSelector('.account-card', {state: 'visible'});

    const cardHtml = await page.locator('#accountIntelligenceView .account-card').innerHTML();
    assert(/Business Signals Found/.test(cardHtml), '5) REQUIRED: Business Signals (evidence) remains its own labeled section');
    assert(/Reasons To Reach Out/i.test(cardHtml), '5) REQUIRED: Reasons to Reach Out (commercial interpretation) remains its own labeled section, distinct from Business Signals');

    // 6) An eligible whitespace cell + real relationship + real repeat
    //    pattern makes a genuine Active Expansion Play -- same fixture
    //    shape test-whitespace-cell-answers-live.js's own section 11
    //    established.
    assert(await page.locator('.aep-panel').count() === 1, '6) sanity: a real, eligible Active Expansion Play renders');
    const aepIcon = await page.locator('.aep-panel .section-title').innerText();
    assert(/🧭/.test(aepIcon), `6) REQUIRED: Active Expansion Plays renders its own distinct icon (got "${aepIcon}")`);
    assert(!/🎯/.test(aepIcon), '6) REQUIRED: Active Expansion Plays no longer shares the 🎯 icon');
    const reasonsTitleMatch = cardHtml.match(/section-title">([^<]*Reasons To Reach Out)/i);
    assert(reasonsTitleMatch && /🎯/.test(reasonsTitleMatch[1]), '6) sanity: Reasons to Reach Out keeps its original 🎯 icon -- the two sections are now visually distinguishable from each other');

    assert(/Relationships/.test(cardHtml) && /who your team already knows/i.test(cardHtml), '7) REQUIRED: the Whitespace Intelligence section now carries a "Relationships" heading naming the row-level relationship evidence');

    assert(pageErrors.length === 0, `5/6/7) no uncaught page errors (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 7) The return-visit monitoring empty state no longer tells a rep to
  //    unnecessarily re-upload/refresh -- confirms monitoring is active
  //    instead, on a quiet account with no futureOpportunities this week.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    page.__baseUrl = baseUrl;
    await gotoDashboard(page);
    await page.waitForSelector('#resultCount', {state: 'visible'});
    await page.waitForSelector('.no-signals-message', {state: 'visible'});

    const emptyStateText = await page.locator('.no-signals-message').first().innerText();
    assert(!/upload or refresh/i.test(emptyStateText), `7) REQUIRED: the empty state no longer tells a returning rep to upload or refresh (got "${emptyStateText}")`);
    assert(/being monitored/i.test(emptyStateText) && /automatically/i.test(emptyStateText), `7) REQUIRED: the empty state confirms monitoring is active and automatic (got "${emptyStateText}")`);

    assert(pageErrors.length === 0, `7) no uncaught page errors on the quiet-week empty state (got: ${JSON.stringify(pageErrors)})`);
  });

  await server.close();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
