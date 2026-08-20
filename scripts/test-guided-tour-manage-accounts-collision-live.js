// Release-candidate correction (2026-08-20, RC-4), real-browser regression
// coverage. Same harness convention as scripts/test-cohesion-navigation-live.js
// (see that file's own header for why file:// is not viable and why
// site-header.js is served for real, unstubbed).
//
// Confirmed founder-reported production collision: a brand-new rep runs the
// guided tour, which (with zero uploaded data) only completes steps 1-2 and
// leaves the workspace in a 'pending-resume' state (see GUIDED_TOUR_STEPS'
// own header comment). The rep then does their FIRST real upload. Two
// independently-built systems react to that same moment: the upload-success
// modal's "Research N accounts" CTA opens Manage Customer Accounts and starts
// research, while the aggregate dashboard refresh that also fires from that
// same upload calls applyPopulatedWorkspaceState() ->
// maybeResumeGuidedTourAfterPopulation(), which used to resume the tour
// immediately -- spotlighting Dashboard elements while Manage Customer
// Accounts' full-screen modal was still the rep's actual foreground. This
// proves the real fix: the tour now defers while the modal is open, and
// resumes automatically once it closes, using real DOM state (not a vm-sandbox
// stub of window.HouseAccountManager).
//
// Usage: node scripts/test-guided-tour-manage-accounts-collision-live.js
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

const ACCOUNT_NAME = 'Ridgeline Apparel Co';
const UPLOAD_ID = 'upload-rc4-1';

// window.HouseAuth is stubbed with no getUser(), so guidedTourNamespace()
// falls back to 'anonymous' -- the exact same key readGuidedTourState()/
// writeGuidedTourState() (dashboard/index.html) resolve to under that stub.
const TOUR_STORAGE_KEY = 'ha_guided_tour_v1::anonymous';

async function main(){
  const server = await startStaticServer();
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({executablePath: resolveChromiumExecutablePath()});

  try{
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));

    // Starts empty (the real shape a genuinely new account's first
    // get-dashboard fetch returns) -- flipped to a real, populated payload
    // below to reproduce the exact moment a first upload's dashboard refresh
    // resolves.
    let dashboardPopulated = false;

    await page.addInitScript((tourKey) => {
      localStorage.setItem('haAuthSession', JSON.stringify({access_token: 'test-token-rc4'}));
      localStorage.setItem('houseAccountsLead', JSON.stringify({email: 'qa-rc4@example.com', name: 'QA Tester', company: 'QA Test Co'}));
      localStorage.setItem('houseAccountsBetaWelcomeDismissed', 'true');
      // A rep who already ran the empty-workspace tour (steps 1-2 only) and
      // is now waiting on steps 3-5 to resume the first time real data
      // exists -- the exact persisted state finishGuidedTour() writes for
      // that case (see GUIDED_TOUR_STEPS' own header comment).
      localStorage.setItem(tourKey, JSON.stringify({status: 'pending-resume', pendingResumeStep: 2, updatedAt: '2026-08-20T00:00:00.000Z'}));
    }, TOUR_STORAGE_KEY);

    await page.route('**/auth-client.js', route => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: `window.HouseAuth = {
        authHeadersAsync: async (h) => ({...(h||{}), Authorization: 'Bearer test-token-rc4'}),
        authHeaders: (h) => ({...(h||{}), Authorization: 'Bearer test-token-rc4'})
      };`
    }));

    await page.route('**/api/**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true})}));
    await page.route('**/api/get-dashboard**', route => {
      if(!dashboardPopulated){
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: true, personalEmpty: true, teamHasData: false,
          user: {email: 'qa-rc4@example.com', name: 'QA Tester', company: 'QA Test Co'}
        })});
      }
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true,
        accounts: [{
          name: ACCOUNT_NAME, industry: 'Promotional Products', revenue: 18000, orderCount: 3, uploadId: UPLOAD_ID,
          contacts: [], categoryTypes: [], purchases: [], futureOpportunities: [], signals: [],
          lastResearchedAt: ''
        }],
        signals: [], weeklyRuns: [],
        user: {email: 'qa-rc4@example.com', name: 'QA Tester', company: 'QA Test Co'},
        upload: {id: UPLOAD_ID, upload_name: 'RC-4 Fixture', updated_at: '2026-08-20T00:00:00Z'},
        canViewTeam: false, viewMode: 'my', orgPreferences: {}, personalEmpty: false
      })});
    });
    await page.route('**/api/usage**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, organization: {plan: 'free'}, usage: {}})}));
    await page.route('**/api/unresolved-outreach**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, items: []})}));
    // Manage Customer Accounts' own list -- one real, unresearched upload so
    // the modal renders a genuine account row while it's open.
    await page.route('**/api/monitoring-lists**', route => {
      const url = new URL(route.request().url());
      if(url.searchParams.get('uploadId')){
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: true, uploadId: UPLOAD_ID,
          accounts: [{ id: 'acct-rc4-1', uploadId: UPLOAD_ID, name: ACCOUNT_NAME, industry: 'Promotional Products', monitoringStatus: 'active', researchStatus: 'uploaded', lastResearchedAt: '', domain: '', dateAdded: '2026-08-20T00:00:00Z', hasActionableAlert: false, signalCount: 0 }],
          pageInfo: {limit: 50, hasMore: false, nextCursor: null, total: 1, search: ''}
        })});
      }
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, scope: 'user', role: 'owner',
        lists: {customer: [{id: UPLOAD_ID, type: 'customer', name: 'RC-4 Fixture', status: 'active', companyCount: 1, activeCount: 1, pausedCount: 0, everResearched: false, lastUpload: '2026-08-20T00:00:00Z', lastScan: '', signalCount: 0, researchRunState: {status: 'idle'}}], prospect: []},
        summary: {activeCustomers: 1, pausedCustomers: 0, activeProspects: 0, pausedProspects: 0, monitoringCadence: 'Ongoing', monitoringStatus: 'Active'}
      })});
    });

    await page.goto(`${baseUrl}/dashboard/`, {waitUntil: 'load'});
    await page.waitForSelector('#manageCustomerAccountsBtn', {state: 'attached'});

    // Sanity: the empty-workspace load must NOT have resumed the tour on its
    // own -- the pending-resume marker is only consumed the moment real data
    // populates (applyPopulatedWorkspaceState()).
    const tourActiveOnEmptyLoad = await page.evaluate(() => document.getElementById('haTourOverlay').classList.contains('active'));
    assert(!tourActiveOnEmptyLoad, 'sanity: the tour does not auto-resume on the initial empty-workspace load');

    // =========================================================================
    // 1) Reproduce the real collision: Manage Customer Accounts is open (the
    //    exact real modal a first upload's "Research N accounts" CTA opens)
    //    at the same moment the aggregate dashboard refresh resolves with
    //    real data -- the exact same refreshAggregateDashboard() a real
    //    upload success calls.
    //
    //    #manageCustomerAccountsBtn itself lives inside #customerDashboard,
    //    which is still display:none at this point (a genuinely brand-new,
    //    zero-data workspace) -- so this reproduces researchListAndFocus()'s
    //    own real entry point (dashboard/index.html:15644,
    //    `document.getElementById('manageCustomerAccountsBtn')?.click()`),
    //    not a Playwright-only shortcut: the button's own click handler
    //    opens the modal regardless of the button's own visibility.
    // =========================================================================
    await page.evaluate(() => document.getElementById('manageCustomerAccountsBtn').click());
    await page.waitForSelector('#accountManagerContent .acct-mgr-list', {state: 'attached'});
    const modalOpenBefore = await page.evaluate(() => window.HouseAccountManager.isOpen());
    assert(modalOpenBefore === true, 'sanity: Manage Customer Accounts is genuinely open before the populated refresh fires');

    dashboardPopulated = true;
    await page.evaluate(() => window.refreshAggregateDashboard());

    // 1) REQUIRED: the tour must NOT spotlight anything while Manage Customer
    //    Accounts still occupies the rep's foreground.
    const tourActiveWhileModalOpen = await page.evaluate(() => document.getElementById('haTourOverlay').classList.contains('active'));
    assert(!tourActiveWhileModalOpen, '1) REQUIRED: the guided tour does not spotlight Dashboard elements while Manage Customer Accounts is open');
    const stateWhileModalOpen = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), TOUR_STORAGE_KEY);
    assert(stateWhileModalOpen.status === 'pending-resume', `1) REQUIRED: the deferred tour stays 'pending-resume' (not silently lost) while the modal is open (got status "${stateWhileModalOpen.status}")`);

    // =========================================================================
    // 2) Once the rep closes Manage Customer Accounts, the tour resumes on
    //    its own, on the correct step (step 3: Your Accounts), without any
    //    further user action.
    // =========================================================================
    await page.click('#closeAccountManagerBtn');
    const modalOpenAfterClose = await page.evaluate(() => window.HouseAccountManager.isOpen());
    assert(modalOpenAfterClose === false, 'sanity: Manage Customer Accounts is genuinely closed');

    await page.waitForFunction(() => document.getElementById('haTourOverlay').classList.contains('active'), undefined, {timeout: 5000});
    const tourActiveAfterClose = await page.evaluate(() => document.getElementById('haTourOverlay').classList.contains('active'));
    assert(tourActiveAfterClose, '2) REQUIRED: the guided tour resumes automatically once Manage Customer Accounts closes');
    const resumedTitle = await page.locator('#haTourTitle').innerText();
    assert(resumedTitle === 'Your Accounts', `2) REQUIRED: the resumed tour lands on step 3 (Your Accounts), the step it deferred at (got "${resumedTitle}")`);
    const stateAfterResume = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), TOUR_STORAGE_KEY);
    assert(stateAfterResume.status === 'resumed-in-progress', `2) REQUIRED: the persisted state reflects the tour actually resumed (got status "${stateAfterResume.status}")`);

    assert(pageErrors.length === 0, `no uncaught page errors across the first-upload sequencing flow (got: ${JSON.stringify(pageErrors)})`);
  } finally {
    await browser.close();
    await server.close();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
