// Release-candidate correction (2026-08-20, RC-2), real-browser regression
// coverage. Same harness convention as scripts/test-cohesion-navigation-live.js
// (see that file's own header for why file:// is not viable and why
// site-header.js is served for real, unstubbed).
//
// Confirmed founder-reported gap: initUnresolvedOutreachPanel() (the one
// function that fetches /api/unresolved-outreach and renders the Dashboard's
// "Outreach waiting on an update" panel) was wired only to DOMContentLoaded.
// A rep who saved a brand-new "I reached out" from inside an already-open
// Prepare for Call panel never saw the Dashboard panel reflect it until a
// full page reload -- even though the server-side isStillOpen semantics
// (api/lib/outcome-prompts.js) were already correct and immediate. The fix
// calls initUnresolvedOutreachPanel() again right after a successful save
// (dashboard/index.html's wireOutreachRow()). This proves the fix against
// the real DOM/network stack, in one continuous browser session, with no
// navigation or reload between the save and the panel update.
//
// Usage: node scripts/test-outreach-unresolved-panel-live-refresh.js
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

const ACCOUNT_NAME = 'Beacon Trophy & Awards';
const UPLOAD_ID = 'upload-rc2-1';
const OPPORTUNITY_ID = 'aoid-rc2-1';
const OPPORTUNITY_FINGERPRINT = 'fp-rc2-1';

// Known-good, fully-rendering durable-ref opportunity shape (matches
// scripts/test-dashboard-card-outreach-hydration.js's makeAccount(), same
// fixture scripts/test-cohesion-navigation-live.js reuses) -- renders the
// real Prepare for Call outreach row this test needs.
function getDashboardPayload(){
  return {
    accounts: [{
      name: ACCOUNT_NAME, industry: 'Promotional Products', revenue: 27000, orderCount: 4, uploadId: UPLOAD_ID,
      contacts: [{ name: 'Sam Okafor', title: 'Operations Manager', department: 'Operations' }],
      categoryTypes: ['Apparel'],
      purchases: [
        { category: 'Headwear', revenue: 1200, date: '2024-04-10' },
        { category: 'Headwear', revenue: 1400, date: '2025-04-12' }
      ],
      futureOpportunities: [{
        account: ACCOUNT_NAME, contact: 'Sam Okafor', years: [2025], category: 'Headwear',
        evidence: ['2 Headwear orders found'], industry: 'Promotional Products', confidence: 74,
        department: 'Operations', signalDate: '2025-08-16', opportunity: 'Headwear Program',
        templateKey: 'repeat_pattern', whyNowScore: 87, contactEmail: '', contactTitle: 'Operations Manager',
        purchaseMonth: 7, quickWinScore: 74, accountRevenue: 27000, buyingCategory: 'Headwear',
        estimatedValue: 4200, mostRecentDate: '2025-08-16', planningWindow: 'week', businessSignals: [],
        opportunityName: 'Headwear Program', opportunityType: 'REPEAT PATTERN', signalLayerType: 'Repeat / Pattern Signal',
        closeProbability: 74, opportunityScore: 87, reasonToReachOut: 'Headwear program may be coming up again',
        relationshipStrength: 86, accountDiversityScore: 1, accountFrequencyScore: 0.5,
        conversationStarter: 'Ask if the headwear program is happening again this year.', historicalPurchaseData: [],
        accountOpportunityId: OPPORTUNITY_ID, accountOpportunityFingerprint: OPPORTUNITY_FINGERPRINT
      }],
      signals: [],
      lastResearchedAt: '2026-08-10T12:00:00Z'
    }],
    signals: [], weeklyRuns: [],
    user: {email: 'qa-rc2@example.com', name: 'QA Tester', company: 'QA Test Co'},
    upload: {id: UPLOAD_ID, upload_name: 'RC-2 Fixture', updated_at: '2026-08-01T00:00:00Z'},
    canViewTeam: false, viewMode: 'my', orgPreferences: {}, personalEmpty: false
  };
}

async function main(){
  const server = await startStaticServer();
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({executablePath: resolveChromiumExecutablePath()});

  // Server-side truth the mocked /api/unresolved-outreach and /api/signal-events
  // routes share -- a brand-new outreach_made POST appends a real, immediately
  // isStillOpen item here, exactly matching the real
  // api/signal-events.js -> api/unresolved-outreach.js relationship (see
  // that file's own :99 isStillOpen filter, unmodified by this correction).
  let unresolvedItems = [];
  let nextEventId = 1;

  try{
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));

    await page.addInitScript(() => {
      localStorage.setItem('haAuthSession', JSON.stringify({access_token: 'test-token-rc2'}));
      localStorage.setItem('houseAccountsLead', JSON.stringify({email: 'qa-rc2@example.com', name: 'QA Tester', company: 'QA Test Co'}));
      localStorage.setItem('houseAccountsBetaWelcomeDismissed', 'true');
    });

    await page.route('**/auth-client.js', route => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: `window.HouseAuth = {
        authHeadersAsync: async (h) => ({...(h||{}), Authorization: 'Bearer test-token-rc2'}),
        authHeaders: (h) => ({...(h||{}), Authorization: 'Bearer test-token-rc2'})
      };`
    }));

    await page.route('**/api/**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true})}));
    await page.route('**/api/get-dashboard**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(getDashboardPayload())}));
    await page.route('**/api/usage**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, organization: {plan: 'free'}, usage: {}})}));
    await page.route('**/api/monitoring-lists**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, scope: 'user', role: 'owner',
      lists: {customer: [{id: UPLOAD_ID, type: 'customer', name: 'RC-2 Fixture', status: 'active', companyCount: 1, activeCount: 1, pausedCount: 0, everResearched: true, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 0, researchRunState: {status: 'idle'}}], prospect: []},
      summary: {activeCustomers: 1, pausedCustomers: 0, activeProspects: 0, pausedProspects: 0, monitoringCadence: 'Ongoing', monitoringStatus: 'Active'}
    })}));
    // The real signal-event-state read-back Prepare for Call's own
    // hydrateOutreachRow() calls on open -- returns "never logged" so the
    // row renders in its default "I reached out" state.
    await page.route('**/api/signal-events?**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, states: {}})}));
    // The real write endpoint outreach_made/approach_shared POST to --
    // appends a genuinely new, immediately isStillOpen unresolved item, the
    // same server-side effect a real save has (api/lib/outcome-prompts.js's
    // isStillOpen is immediate/untouched by this correction; this mock only
    // stands in for the actual Postgres round-trip).
    await page.route('**/api/signal-events', async route => {
      if(route.request().method() !== 'POST') return route.fallback();
      const body = JSON.parse(route.request().postData() || '{}');
      const id = `evt-${nextEventId++}`;
      if(body.eventType === 'opportunity_outreach_made' || body.eventType === 'outreach_made'){
        unresolvedItems.push({
          outreachEventId: id, eventFingerprint: body.eventFingerprint, accountName: body.accountName,
          outreachCreatedAt: new Date(0).toISOString()
        });
      }
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, id})});
    });
    await page.route('**/api/unresolved-outreach**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, items: unresolvedItems})}));

    await page.goto(`${baseUrl}/dashboard/`, {waitUntil: 'load'});
    await page.waitForSelector('.opportunity-card', {state: 'visible'});

    // =========================================================================
    // 1) Sanity: the Dashboard's unresolved-outreach panel starts hidden --
    //    no outreach has been logged yet in this session.
    // =========================================================================
    const panelHiddenInitially = await page.evaluate(() => document.getElementById('unresolvedOutreachPanel').hidden);
    assert(panelHiddenInitially === true, '1) sanity: the unresolved-outreach panel is hidden before any outreach is logged');

    // =========================================================================
    // 2/3) REQUIRED: saving a brand-new "I reached out" inside the real,
    //      already-open Prepare for Call panel makes the Dashboard's
    //      unresolved-outreach panel reflect it in the SAME session -- no
    //      page.reload(), no navigation, no polling wait beyond the fix's
    //      own immediate re-fetch.
    // =========================================================================
    await page.click('.account-history-prepare-btn');
    await page.waitForSelector('.sales-play-outreach-row .outreach-log-btn', {state: 'visible'});
    await page.click('.sales-play-outreach-row .outreach-log-btn');
    await page.waitForSelector('.sales-play-outreach-row .approach-note-save', {state: 'visible'});
    await page.click('.sales-play-outreach-row .approach-note-save');
    await page.waitForSelector('.sales-play-outreach-row .outreach-log-btn.outreach-logged', {state: 'visible'});

    await page.waitForFunction(() => document.getElementById('unresolvedOutreachPanel').hidden === false, undefined, {timeout: 5000});
    const panelVisibleAfterSave = await page.evaluate(() => document.getElementById('unresolvedOutreachPanel').hidden);
    assert(panelVisibleAfterSave === false, '2) REQUIRED: the unresolved-outreach panel becomes visible in-session, immediately after the outreach save -- no reload');

    const panelText = await page.locator('#unresolvedOutreachList').innerText();
    assert(new RegExp(ACCOUNT_NAME).test(panelText), `3) REQUIRED: the panel's new item names the correct account (got "${panelText}")`);
    assert(unresolvedItems.length === 1, `3) sanity: exactly one real outreach_made write occurred (got ${unresolvedItems.length})`);

    // 3) REQUIRED: this was a genuine re-fetch, not a stale render -- the
    //    server-recorded item's own fingerprint is the one actually shown.
    const rowEventId = await page.locator('.unresolved-outreach-item').first().getAttribute('data-outreach-event-id');
    assert(rowEventId === unresolvedItems[0].outreachEventId, `3) REQUIRED: the rendered panel reflects the real server state fetched in this session (got row id "${rowEventId}", server id "${unresolvedItems[0].outreachEventId}")`);

    assert(pageErrors.length === 0, `no uncaught page errors across the in-session outreach-save/panel-refresh flow (got: ${JSON.stringify(pageErrors)})`);
  } finally {
    await browser.close();
    await server.close();
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
