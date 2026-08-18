// Cell-Level Buying Center x Offering Confirmation / Correction V1 --
// live-navigation regression coverage (real Chromium, real
// dashboard/index.html, real site-header.js). Same harness convention as
// scripts/test-account-intelligence-live-navigation.js (see that file's
// own header comment for why file:// is not viable and why site-header.js
// is served for real, unstubbed) -- this file exercises the cell popover
// specifically: opening it, choosing an answer, the resulting visual
// state, reopening an answered cell to show its saved selection, and
// correcting an answer.
//
// Explicitly required by the founder (verbatim):
//   - clicking a cell opens a compact contextual popover/menu (We sell
//     this here / We don't sell this here / Not relevant), not three
//     buttons crammed into every cell
//   - re-clicking an answered cell allows correcting the answer
//   - Covered renders visually distinct (green/teal); Not Applicable is
//     quiet gray/N/A; Confirmed Whitespace looks like ordinary quiet
//     whitespace -- no extra loud state just to prove an answer was saved
//   - reopening the cell menu clearly indicates the saved selection
//   - horizontal matrix scrolling / sticky Buying Center column still work
//   - the "Account-wide purchases not fully attributed" evidence panel
//     stays visible even after a cell becomes Covered
//
// Usage: node scripts/test-whitespace-cell-answers-live.js
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

// A Marketing contact gives the matrix real row-level evidence for the
// Marketing row (so it renders the matrix, not the mapping prompt), and a
// real Apparel purchase gives the unattributed-purchases panel something
// real to show throughout.
const ACCOUNT_NAME = 'Anchor Brewing Supply';
function getDashboardPayload(){
  return {
    accounts: [{
      name: ACCOUNT_NAME, industry: 'Promotional Products', revenue: 42000, orderCount: 6,
      contacts: [{ name: 'Jordan Reyes', title: 'Marketing Manager', department: 'Marketing' }],
      categoryTypes: ['Apparel'],
      futureOpportunities: [], signals: [], purchases: []
    }],
    signals: [], weeklyRuns: [],
    user: {email: 'qa@example.com', name: 'QA Tester', company: 'QA Test Co'},
    upload: {id: 'upload-ws-1', upload_name: 'QA Whitespace Fixture', updated_at: '2026-08-01T00:00:00Z'},
    canViewTeam: false, viewMode: 'my', orgPreferences: {}, personalEmpty: false
  };
}

let cellAnswerStore = {}; // cellKey -> answer, mutated by the mocked POST route
let confirmedCenterStore = []; // buying centers, mutated by the mocked /api/whitespace-map POST route

async function withPage(baseUrl, run){
  const browser = await chromium.launch({executablePath: resolveChromiumExecutablePath()});
  try{
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));

    await page.addInitScript(() => {
      localStorage.setItem('haAuthSession', JSON.stringify({access_token: 'test-token-ws-cell'}));
      localStorage.setItem('houseAccountsLead', JSON.stringify({email: 'qa@example.com', name: 'QA Tester', company: 'QA Test Co'}));
      localStorage.setItem('houseAccountsBetaWelcomeDismissed', 'true');
    });

    await page.route('**/auth-client.js', route => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: `window.HouseAuth = {
        authHeadersAsync: async (h) => ({...(h||{}), Authorization: 'Bearer test-token-ws-cell'}),
        authHeaders: (h) => ({...(h||{}), Authorization: 'Bearer test-token-ws-cell'})
      };`
    }));

    // Registered first so every more specific route below (matched LIFO)
    // correctly overrides it -- same ordering lesson as
    // test-account-intelligence-live-navigation.js.
    await page.route('**/api/**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true})}));
    await page.route('**/api/get-dashboard**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(getDashboardPayload())}));
    await page.route('**/api/usage**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, organization: {plan: 'free'}, usage: {}})}));
    await page.route('**/api/unresolved-outreach**', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, items: []})}));
    // Stateful, matching the real api/whitespace-map.js toggle contract --
    // GET (batch, no accountName) returns the current org-wide map; POST
    // toggles the requested buying center and returns the account's
    // updated confirmedCenters, exactly like the real endpoint.
    await page.route('**/api/whitespace-map**', async route => {
      const req = route.request();
      if(req.method() === 'POST'){
        const body = JSON.parse(req.postData() || '{}');
        const idx = confirmedCenterStore.indexOf(body.buyingCenter);
        if(idx === -1) confirmedCenterStore.push(body.buyingCenter); else confirmedCenterStore.splice(idx, 1);
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, confirmedCenters: [...confirmedCenterStore]})});
      }
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, confirmations: {[ 'anchor brewing supply' ]: [...confirmedCenterStore]}, confirmedCenters: [...confirmedCenterStore]})});
    });
    await page.route('**/api/monitoring-lists**', route => {
      const url = new URL(route.request().url());
      if(url.searchParams.get('uploadId')){
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: true, uploadId: 'upload-ws-1',
          accounts: [{ id: 'acct-ws-1', uploadId: 'upload-ws-1', name: ACCOUNT_NAME, industry: 'Promotional Products', monitoringStatus: 'active', researchStatus: 'uploaded', lastResearchedAt: '', domain: '', dateAdded: '2026-01-01T00:00:00Z', hasActionableAlert: false }],
          pageInfo: {limit: 50, hasMore: false, nextCursor: null, total: 1, search: ''}
        })});
      }
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, scope: 'user', role: 'owner',
        lists: {customer: [{id: 'upload-ws-1', type: 'customer', name: 'QA Whitespace Fixture', status: 'active', companyCount: 1, activeCount: 1, pausedCount: 0, everResearched: false, lastUpload: '2026-08-01T00:00:00Z', lastScan: '', signalCount: 0, researchRunState: {status: 'idle'}}], prospect: []},
        summary: {activeCustomers: 1, pausedCustomers: 0, activeProspects: 0, pausedProspects: 0, monitoringCadence: 'Ongoing', monitoringStatus: 'Active'}
      })});
    });
    // The real durable cell-answer endpoint under test -- GET returns the
    // current in-memory store (batch mode, matching the real API's
    // response shape); POST upserts into it and returns the updated
    // per-account map, exactly like the real api/whitespace-cell-answers.js.
    await page.route('**/api/whitespace-cell-answers**', async route => {
      const req = route.request();
      if(req.method() === 'GET'){
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, answers: {'anchor brewing supply': {...cellAnswerStore}}})});
      }
      if(req.method() === 'POST'){
        const body = JSON.parse(req.postData() || '{}');
        const key = `${body.buyingCenter}||${body.category}`;
        cellAnswerStore[key] = body.answer;
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, cellAnswers: {...cellAnswerStore}})});
      }
      return route.fulfill({status: 405, contentType: 'application/json', body: JSON.stringify({error: 'Method not allowed'})});
    });

    await run(page, pageErrors);
  } finally {
    await browser.close();
  }
}

async function gotoFocusedAccount(page, baseUrl){
  await page.goto(`${baseUrl}/dashboard/#account=${encodeURIComponent('anchor brewing supply')}`, {waitUntil: 'load'});
  await page.waitForSelector('#accountIntelligenceView .account-card', {state: 'visible'});
  await page.waitForSelector('.ws-matrix', {state: 'visible'});
}

async function main(){
  const server = await startStaticServer();
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // =========================================================================
  // 1) The matrix renders (real Marketing-contact evidence), cells are
  //    keyboard/mouse interactive, and the unattributed-purchases panel
  //    shows the real Apparel purchase from the start.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    cellAnswerStore = {};
    confirmedCenterStore = [];
    await gotoFocusedAccount(page, baseUrl);

    const hasMvpClass = await page.evaluate(() => document.documentElement.classList.contains('ha-mvp'));
    assert(hasMvpClass, '1) .ha-mvp is applied -- the real site-header.js ran, unstubbed');

    const cellCount = await page.locator('.ws-cell[data-buying-center]').count();
    assert(cellCount === 7 * 11, `1) the full 7x11 matrix renders with every real cell interactive (got ${cellCount})`);

    const unattributedText = await page.locator('.ws-unattributed-panel').innerText();
    assert(/Apparel/.test(unattributedText), '1) the real Apparel purchase shows in the unattributed-purchases panel from the start');
    assert(/not fully attributed/i.test(unattributedText), '1) the panel uses the corrected "not fully attributed" title');

    assert(pageErrors.length === 0, `1) no uncaught page errors on initial matrix render (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 2) Clicking a cell opens a compact popover with exactly the three
  //    founder-specified options, none pre-selected for a never-answered
  //    cell.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    cellAnswerStore = {};
    confirmedCenterStore = [];
    await gotoFocusedAccount(page, baseUrl);

    const marketingRow = page.locator('.ws-rowhead', {hasText: 'Marketing'});
    const marketingRowIndex = await marketingRow.evaluate(el => [...el.parentElement.querySelectorAll('.ws-rowhead')].indexOf(el));
    const apparelColIndex = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('.ws-colhead')].map(h => h.textContent.trim());
      return heads.indexOf('Apparel');
    });
    assert(apparelColIndex !== -1, '2) sanity: the Apparel column exists');

    const targetCell = page.locator('.ws-cell[data-buying-center="Marketing"][data-category="Apparel"]');
    await targetCell.click();
    await page.waitForSelector('.ws-cell-popover.open', {state: 'visible'});

    const optionTexts = await page.locator('.ws-cell-popover-option').allTextContents();
    assert(optionTexts.some(t => /We sell this here/.test(t)), '2) the popover offers "We sell this here"');
    assert(optionTexts.some(t => /We don.t sell this here/.test(t)), '2) the popover offers "We don\'t sell this here"');
    assert(optionTexts.some(t => /Not relevant/.test(t)), '2) the popover offers "Not relevant"');
    assert(optionTexts.length === 3, `2) the popover has exactly three options, not a fourth "clear" state (got ${optionTexts.length})`);

    const selectedCount = await page.locator('.ws-cell-popover-option.selected').count();
    assert(selectedCount === 0, '2) a never-answered cell opens with no option pre-selected');

    const titleText = await page.locator('.ws-cell-popover-title').innerText();
    assert(/marketing/i.test(titleText) && /apparel/i.test(titleText), `2) the popover clearly names which cell it is answering (got "${titleText}")`);

    assert(pageErrors.length === 0, `2) no uncaught page errors opening the popover (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 3) Choosing "We sell this here" answers the cell: it persists (a real
  //    POST to the durable endpoint), the cell turns visually
  //    Covered (green/teal), and reopening the SAME cell shows "We sell
  //    this here" as the saved selection.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    cellAnswerStore = {};
    confirmedCenterStore = [];
    await gotoFocusedAccount(page, baseUrl);

    const cell = page.locator('.ws-cell[data-buying-center="Marketing"][data-category="Apparel"]');
    await cell.click();
    await page.waitForSelector('.ws-cell-popover.open');
    await page.click('.ws-cell-popover-option[data-cell-answer-choice="covered"]');

    await page.waitForSelector('.ws-cell-popover', {state: 'hidden'});
    await page.waitForFunction(() => {
      const c = document.querySelector('.ws-cell[data-buying-center="Marketing"][data-category="Apparel"]');
      return c && c.classList.contains('covered');
    });

    assert(JSON.stringify(cellAnswerStore) === '{"Marketing||Apparel":"covered"}', `3) the answer reached the real durable endpoint and persisted server-side (got ${JSON.stringify(cellAnswerStore)})`);

    const coveredCell = page.locator('.ws-cell[data-buying-center="Marketing"][data-category="Apparel"]');
    assert(await coveredCell.evaluate(el => el.classList.contains('covered')), '3) the answered cell now renders the visually distinct Covered (green/teal) state');
    const bg = await coveredCell.evaluate(el => getComputedStyle(el).backgroundColor);
    assert(bg !== 'rgb(255, 255, 255)', `3) the Covered cell is visually distinguishable from plain white (got background ${bg})`);

    const unattributedText = await page.locator('.ws-unattributed-panel').innerText();
    assert(/Apparel/.test(unattributedText), '3) REQUIRED: Apparel still shows in the not-fully-attributed panel even after Marketing x Apparel became Covered -- one cell does not prove every historical purchase in that category');

    // Reopen the SAME cell -- its saved selection must be clearly shown.
    await coveredCell.click();
    await page.waitForSelector('.ws-cell-popover.open');
    const selected = page.locator('.ws-cell-popover-option.selected');
    assert(await selected.count() === 1, '3) REQUIRED: reopening an answered cell shows exactly one selected option');
    assert(/We sell this here/.test(await selected.innerText()), '3) REQUIRED: reopening the cell clearly indicates the saved selection ("We sell this here")');

    assert(pageErrors.length === 0, `3) no uncaught page errors answering/reopening a cell (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 4) Correcting an answer: re-clicking an answered cell and choosing a
  //    different option updates it -- "latest answer wins," never stacks
  //    or duplicates.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    cellAnswerStore = {'Marketing||Apparel': 'covered'};
    await gotoFocusedAccount(page, baseUrl);

    const cell = page.locator('.ws-cell[data-buying-center="Marketing"][data-category="Apparel"]');
    assert(await cell.evaluate(el => el.classList.contains('covered')), '4) sanity: the cell starts Covered, from the durable store');

    await cell.click();
    await page.waitForSelector('.ws-cell-popover.open');
    const preSelected = page.locator('.ws-cell-popover-option.selected');
    assert(/We sell this here/.test(await preSelected.innerText()), '4) sanity: reopening shows the existing Covered answer selected');

    await page.click('.ws-cell-popover-option[data-cell-answer-choice="not_applicable"]');
    await page.waitForFunction(() => {
      const c = document.querySelector('.ws-cell[data-buying-center="Marketing"][data-category="Apparel"]');
      return c && c.classList.contains('not-applicable');
    });
    assert(cellAnswerStore['Marketing||Apparel'] === 'not_applicable', '4) REQUIRED: correcting the answer overwrites the durable record -- latest answer wins');
    const naCell = page.locator('.ws-cell[data-buying-center="Marketing"][data-category="Apparel"]');
    assert(!(await naCell.evaluate(el => el.classList.contains('covered'))), '4) the corrected cell is no longer visually Covered');
    assert((await naCell.locator('.ws-mark.small').innerText()) === 'N/A', '4) the corrected cell renders the quiet gray N/A mark');

    assert(pageErrors.length === 0, `4) no uncaught page errors correcting a cell answer (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 5) Confirmed Whitespace: choosing "We don't sell this here" persists a
  //    real answer, but the cell visually looks like ordinary, unanswered
  //    whitespace -- no fourth loud visual state.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    cellAnswerStore = {};
    confirmedCenterStore = [];
    await gotoFocusedAccount(page, baseUrl);

    const cell = page.locator('.ws-cell[data-buying-center="Marketing"][data-category="Headwear"]');
    const neverAnsweredClasses = await cell.evaluate(el => el.className);

    await cell.click();
    await page.waitForSelector('.ws-cell-popover.open');
    await page.click('.ws-cell-popover-option[data-cell-answer-choice="whitespace"]');
    await page.waitForSelector('.ws-cell-popover', {state: 'hidden'});

    assert(cellAnswerStore['Marketing||Headwear'] === 'whitespace', '5) REQUIRED: "We don\'t sell this here" persists a real, explicit whitespace answer server-side');

    const answeredClasses = await cell.evaluate(el => el.className);
    assert(answeredClasses === neverAnsweredClasses, `5) REQUIRED: a confirmed-whitespace cell renders with the IDENTICAL class list to a never-answered cell -- no extra visual state just to prove an answer was saved (before: "${neverAnsweredClasses}", after: "${answeredClasses}")`);

    // Reopening still shows the real saved selection, even though the
    // visual state didn't change.
    await cell.click();
    await page.waitForSelector('.ws-cell-popover.open');
    const selected = page.locator('.ws-cell-popover-option.selected');
    assert(/We don.t sell this here/.test(await selected.innerText()), '5) REQUIRED: reopening a confirmed-whitespace cell still shows its real saved answer, even though the cell itself looks unanswered');

    assert(pageErrors.length === 0, `5) no uncaught page errors on the confirmed-whitespace flow (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 6) Popover dismissal: outside click and Escape both close it without
  //    saving anything.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    cellAnswerStore = {};
    confirmedCenterStore = [];
    await gotoFocusedAccount(page, baseUrl);

    const cell = page.locator('.ws-cell[data-buying-center="Marketing"][data-category="Safety"]');
    await cell.click();
    await page.waitForSelector('.ws-cell-popover.open');
    await page.mouse.click(10, 10);
    await page.waitForSelector('.ws-cell-popover', {state: 'hidden'});
    assert(Object.keys(cellAnswerStore).length === 0, '6) REQUIRED: an outside click closes the popover without saving any answer');

    await cell.click();
    await page.waitForSelector('.ws-cell-popover.open');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ws-cell-popover', {state: 'hidden'});
    assert(Object.keys(cellAnswerStore).length === 0, '6) REQUIRED: Escape closes the popover without saving any answer');

    assert(pageErrors.length === 0, `6) no uncaught page errors dismissing the popover (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 7) Responsive behavior is unaffected: horizontal scroll container and
  //    sticky Buying Center column still present with real cell content.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    cellAnswerStore = {};
    confirmedCenterStore = [];
    await gotoFocusedAccount(page, baseUrl);
    const overflowX = await page.locator('.ws-matrix-scroll').evaluate(el => getComputedStyle(el).overflowX);
    assert(overflowX === 'auto', '7) the matrix still scrolls horizontally rather than shrinking to fit');
    const rowheadPosition = await page.locator('.ws-rowhead').first().evaluate(el => getComputedStyle(el).position);
    assert(rowheadPosition === 'sticky', '7) the Buying Center row-label column is still pinned via position:sticky');
    assert(pageErrors.length === 0, `7) no uncaught page errors (got: ${JSON.stringify(pageErrors)})`);
  });

  // =========================================================================
  // 8) Founder copy/interaction correction (2026-08-19): the row's
  //    PRIMARY visible copy is plain-language ("Known relationship"/
  //    "+ Add relationship"), never internal evidence-model phrasing --
  //    and the "+ Add relationship" control is a real, working entry point
  //    into the SAME durable buying-center confirmation the mapping
  //    prompt already uses.
  // =========================================================================
  await withPage(baseUrl, async (page, pageErrors) => {
    cellAnswerStore = {};
    confirmedCenterStore = [];
    await gotoFocusedAccount(page, baseUrl);

    // Marketing has a real contact fixture -- untouched by this
    // correction, still the plain contact treatment.
    const marketingMeta = await page.locator('.ws-rowhead', {hasText: 'Marketing'}).locator('.ws-rowhead-meta').innerText();
    assert(/Jordan Reyes/.test(marketingMeta) && /known contact/.test(marketingMeta), `8) sanity: a known-contact row is untouched by this correction (got "${marketingMeta}")`);

    // Procurement has no evidence at all -- shows the quiet, discoverable
    // "+ Add relationship" control, never a blank space.
    const procurementRow = page.locator('.ws-rowhead', {hasText: 'Procurement'});
    const addRelationshipBtn = procurementRow.locator('.ws-rowhead-add-relationship');
    assert((await addRelationshipBtn.innerText()) === '+ Add relationship', '8) REQUIRED: an unmapped row shows the exact "+ Add relationship" copy');
    assert(!(await procurementRow.locator('.ws-rowhead-meta').count()), '8) REQUIRED: an unmapped row never shows a negative "No relationship" claim -- no metadata line at all until confirmed');

    // Clicking it confirms the buying center via the REAL durable
    // migration-24 endpoint (api/whitespace-map.js) -- the same one the
    // mapping prompt's chips already use.
    await addRelationshipBtn.click();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.ws-rowhead')];
      const row = rows.find(r => r.textContent.includes('Procurement'));
      return row && row.querySelector('.ws-rowhead-known-relationship');
    });
    assert(confirmedCenterStore.includes('Procurement'), '8) REQUIRED: clicking "+ Add relationship" persists a real buying-center confirmation server-side, via the existing migration-24 endpoint');

    const procurementMetaEl = procurementRow.locator('.ws-rowhead-meta');
    assert((await procurementMetaEl.innerText()) === '✓ Known relationship', `8) REQUIRED: after confirming, the row shows the founder-specified "✓ Known relationship" text, never "Rep-confirmed relationship" or similar internal phrasing (got "${await procurementMetaEl.innerText()}")`);
    const tooltip = await procurementMetaEl.getAttribute('title');
    assert(tooltip === 'Confirmed by your team', `8) REQUIRED: the evidence source ("who confirmed this") is available as a secondary tooltip, not the primary text (got "${tooltip}")`);

    assert(pageErrors.length === 0, `8) no uncaught page errors on the relationship-copy flow (got: ${JSON.stringify(pageErrors)})`);
  });

  await server.close();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
