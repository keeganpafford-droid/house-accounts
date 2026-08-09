// FR3 round -- real-browser regression coverage for the Help dropdown
// visibility defect. Every existing test in this repo (25 files as of this
// round) either inspects extracted JS source text, or runs extracted JS in
// a Node `vm` sandbox against a FAKE DOM. Neither can ever detect a CSS
// cascade defect -- ".ha-help-dropdown{display:flex}" (an author-origin
// declaration) unconditionally overriding the browser's built-in
// "[hidden]{display:none}" user-agent rule, regardless of selector
// specificity. That defect was only found and proven by actually rendering
// the real site-header.css in a real browser and reading
// getComputedStyle()/getBoundingClientRect() -- exactly what this file
// does, for the real, unmodified, production-bound site-header.css,
// site-header.js, and the relevant dashboard/index.html tour/modal
// functions, extracted verbatim (same fail-loud-if-shifted convention as
// every other test in this repo).
//
// Scope note on modal coverage (items 9/10): rather than standing up the
// Add Customer Data / Manage Customer Accounts modals' full business logic
// (file parsing, live API calls, cachedLists rendering) -- none of which
// has any bearing on whether the Help dropdown paints -- this file extracts
// and runs their REAL open()/close() functions (which are what actually
// call window.HouseAccountsHeader.beginOverlay()/endOverlay(), the one
// mechanism this fix and this test care about) with their few external
// calls (a live fetch to /api/monitoring-lists, in the Manage Customer
// Accounts modal's load()) left completely unmocked -- that fetch fails
// safely in this file:// context and is caught internally by the real
// load()'s own try/catch, exactly as it would after a real network error in
// production, and does not affect the assertions below.
//
// Usage: node scripts/test-help-dropdown-visibility.js
// Prerequisite: `npm install` (installs the playwright devDependency) and,
// if /opt/pw-browsers is not present (only true inside this session's
// preconfigured sandbox), `npx playwright install chromium` once.
// CI: run in the same job/step as the rest of `npm test` (see
// scripts/run-all-tests.sh) after `npm ci`; no other setup is required --
// this file resolves its own Chromium executable path (see
// resolveChromiumExecutablePath() below) and needs no server, no database,
// and no network access beyond the one intentionally-failing fetch above.

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
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

const DASHBOARD_SRC = readFileSync(path.join(REPO_ROOT, 'dashboard', 'index.html'), 'utf8');
const DASHBOARD_LINES = DASHBOARD_SRC.split('\n');
const SITE_HEADER_JS = readFileSync(path.join(REPO_ROOT, 'site-header.js'), 'utf8');
const SITE_HEADER_CSS = readFileSync(path.join(REPO_ROOT, 'site-header.css'), 'utf8');

function extractLines(label, startLine, endLine, expectedFirst){
  const slice = DASHBOARD_LINES.slice(startLine - 1, endLine);
  const first = slice[0].trim();
  if(!first.startsWith(expectedFirst)){
    throw new Error(`extractLines(${label}): dashboard/index.html line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  return slice.join('\n');
}

// The real, unmodified guided-tour implementation -- covers
// isHelpRelatedGuidedTourTrigger, launchGuidedTour, closeGuidedTour,
// nextGuidedTourStep, backGuidedTourStep, skipGuidedTour, finishGuidedTour,
// wireGuidedTourControls, guidedTourKeydownHandler, and every state/DOM
// helper they depend on. Same block scripts/test-guided-tour-and-import-experience.js
// already extracts and keeps in sync.
const GUIDED_TOUR_SRC = extractLines('guided-tour', 3910, 4300, "const GUIDED_TOUR_STORAGE_PREFIX = 'ha_guided_tour_v1::';");

// The real, unmodified Add Customer Data modal open/close implementation.
const ADD_CUSTOMER_DATA_MODAL_SRC = extractLines('add-customer-data-modal', 3504, 3567, 'let addCustomerDataModalTriggerEl = null;');

// The real, unmodified Manage Customer Accounts modal subset needed for
// open()/close() to run -- see the file-level scope note above for why
// listCard()/accountRow()/researchRunBanner() (the actual per-row markup
// generators) are deliberately NOT extracted: cachedLists starts empty and
// stays empty (the one fetch load() attempts fails safely in this
// environment), so they are never invoked. Scaling round: renderManager()
// is now a real multi-line function (still safe to include whole -- it
// only ever calls cachedLists.map(listCard), which short-circuits on the
// empty array without listCard needing to be defined here), and
// open()/load() each grew a few lines of their own (expand-state-aware
// refresh, first-open loading state) -- extracted whole either way.
const MANAGE_MODAL_SRC = [
  extractLines('cachedLists', 11258, 11258, 'let cachedLists=[];'),
  extractLines('request', 11278, 11295, 'async function request(method,body){'),
  extractLines('renderManager', 11622, 11636, 'function renderManager(){'),
  extractLines('research-poll-block', 11645, 11669, 'const RESEARCH_POLL_INTERVAL_MS = 6000;'),
  extractLines('load', 11670, 11693, 'async function load(){'),
  extractLines('open-close', 11694, 11724, 'let accountManagerTriggerEl = null;'),
  extractLines('closeAllMenus', 11743, 11749, 'function closeAllMenus(){')
].join('\n');

// Real markup for the tour overlay, the Add Customer Data modal (minimal --
// just the elements open()/close() actually touch), and the Manage Customer
// Accounts modal, copied verbatim from dashboard/index.html.
const TOUR_MARKUP = `
  <div class="ha-tour-overlay" id="haTourOverlay" aria-hidden="true">
    <div class="ha-tour-spotlight" id="haTourSpotlight" hidden></div>
    <div class="ha-tour-card" id="haTourCard" role="dialog" aria-modal="true" aria-labelledby="haTourTitle" aria-describedby="haTourBody" tabindex="-1">
      <div class="ha-tour-eyebrow" id="haTourEyebrow"></div>
      <h3 id="haTourTitle"></h3>
      <p id="haTourBody"></p>
      <div class="ha-tour-dots" id="haTourDots"></div>
      <div class="ha-tour-actions">
        <button type="button" class="ha-tour-btn-skip" id="haTourSkipBtn">Skip Tour</button>
        <div class="ha-tour-actions-right">
          <button type="button" class="ha-tour-btn ha-tour-btn-secondary" id="haTourBackBtn">Back</button>
          <button type="button" class="ha-tour-btn ha-tour-btn-primary" id="haTourNextBtn">Next</button>
        </div>
      </div>
    </div>
  </div>`;
const ADD_CUSTOMER_DATA_MARKUP = `
  <div class="ha-modal-backdrop add-customer-data-backdrop" id="addCustomerDataModal" role="dialog" aria-modal="true" aria-labelledby="addCustomerDataModalTitle" hidden>
    <div>
      <button type="button" class="add-customer-data-modal-close" id="addCustomerDataModalClose" aria-label="Close">&times;</button>
      <input type="file" id="fileInput" accept=".csv">
    </div>
  </div>`;
const MANAGE_MODAL_MARKUP = `
  <button class="btn btn-secondary" id="manageCustomerAccountsBtn" type="button">Manage Customer Accounts</button>
  <div id="accountManagerModal" role="dialog" aria-modal="true" aria-labelledby="accountManagerTitle" style="display:none;position:fixed;inset:0;background:rgba(10,25,45,.55);z-index:9999;padding:24px;overflow:auto;">
    <div style="max-width:1050px;margin:4vh auto;background:#fff;border-radius:16px;padding:24px;">
      <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;"><div><h2 id="accountManagerTitle">Manage Customer Accounts</h2></div><button class="btn btn-secondary" type="button" id="closeAccountManagerBtn">Close</button></div>
      <div id="accountManagerContent"></div>
    </div>
  </div>`;

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${SITE_HEADER_CSS}</style>
</head>
<body>
${TOUR_MARKUP}
${ADD_CUSTOMER_DATA_MARKUP}
${MANAGE_MODAL_MARKUP}
<script>${SITE_HEADER_JS}</script>
<script>${GUIDED_TOUR_SRC}\n${ADD_CUSTOMER_DATA_MODAL_SRC}\n${MANAGE_MODAL_SRC}</script>
</body></html>`;

// This session's sandbox pre-installs Chromium at a fixed path outside
// Playwright's own managed-browser cache (see the environment's own
// guidance: launch with executablePath rather than downloading). A normal
// dev machine or CI runner that has run `npx playwright install chromium`
// has no such path and should use Playwright's own default resolution.
function resolveChromiumExecutablePath(){
  const candidate = '/opt/pw-browsers/chromium';
  return existsSync(candidate) ? candidate : undefined;
}

// page.setContent() produces a document with an opaque/null origin, where
// localStorage throws a SecurityError -- and site-header.js's hasSession()
// (which decides whether to render the authenticated header this dropdown
// only exists in) reads localStorage. A real file:// navigation has a real
// origin and genuinely supports localStorage, so the harness HTML is
// written once to a temp file and loaded via page.goto() instead.
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'ha-help-dropdown-test-'));
const HARNESS_PATH = path.join(TMP_DIR, 'harness.html');
writeFileSync(HARNESS_PATH, PAGE_HTML);
const HARNESS_URL = 'file://' + HARNESS_PATH;

async function withPage(run){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.addInitScript(() => {
      localStorage.setItem('haAuthSession', JSON.stringify({ access_token: 'fake-token' }));
      localStorage.setItem('haAuthUser', JSON.stringify({ email: 'test@example.com' }));
    });
    await page.goto(HARNESS_URL, { waitUntil: 'load' });
    await page.waitForSelector('#haHelpDropdown', { state: 'attached' });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function helpState(page){
  return page.evaluate(() => {
    const el = document.getElementById('haHelpDropdown');
    const cs = getComputedStyle(el);
    return {
      hiddenAttr: el.hasAttribute('hidden'),
      display: cs.display,
      rectH: el.getBoundingClientRect().height,
      ariaExpanded: document.getElementById('haHelpToggle').getAttribute('aria-expanded')
    };
  });
}
function assertHelpHidden(state, label){
  assert(state.display === 'none', `${label}: computed display is "none" (got "${state.display}")`);
  assert(state.rectH === 0, `${label}: rendered height is 0 -- no painted box (got ${state.rectH})`);
}
function assertHelpVisible(state, label){
  assert(state.display === 'flex', `${label}: computed display is "flex" (got "${state.display}")`);
  assert(state.rectH > 0, `${label}: rendered height is greater than 0 (got ${state.rectH})`);
}

async function main(){
  // 1) Initial page load: hidden Help is display:none with no rendered box.
  await withPage(async (page) => {
    const state = await helpState(page);
    assert(state.hiddenAttr === true, 'required test 1: hidden attribute is present on initial load');
    assertHelpHidden(state, 'required test 1 (initial page load, never touched Help)');
  });

  // 2) Clicking Help opens it.
  await withPage(async (page) => {
    await page.click('#haHelpToggle');
    const state = await helpState(page);
    assert(state.hiddenAttr === false, 'required test 2: hidden attribute is removed after clicking Help');
    assert(state.ariaExpanded === 'true', 'required test 2: aria-expanded is true after clicking Help');
    assertHelpVisible(state, 'required test 2 (clicking Help opens it)');
  });

  // 3) Outside click closes it visually.
  await withPage(async (page) => {
    await page.click('#haHelpToggle');
    await page.mouse.click(5, 5);
    const state = await helpState(page);
    assertHelpHidden(state, 'required test 3 (outside click closes Help)');
  });

  // 4) Escape closes it visually.
  await withPage(async (page) => {
    await page.click('#haHelpToggle');
    await page.keyboard.press('Escape');
    const state = await helpState(page);
    assertHelpHidden(state, 'required test 4 (Escape closes Help)');
  });

  // 5) Restart Product Tour hides it (simulated: open Help, then launch the
  // real tour exactly as the "Restart Product Tour" link does).
  await withPage(async (page) => {
    await page.click('#haHelpToggle');
    const openState = await helpState(page);
    assertHelpVisible(openState, 'sanity: Help is open before launching the tour');
    await page.evaluate(() => { window.__haHelpToggleWasFocused = document.activeElement === document.getElementById('haHelpToggle'); launchGuidedTour(); });
    const state = await helpState(page);
    assertHelpHidden(state, 'required test 5 (Restart Product Tour hides Help)');
  });

  // 6) Finish leaves it visually hidden.
  await withPage(async (page) => {
    await page.click('#haHelpToggle');
    await page.evaluate(() => { launchGuidedTour(); finishGuidedTour(); });
    const state = await helpState(page);
    assertHelpHidden(state, 'required test 6 (Finish leaves Help visually hidden)');
  });

  // 7) Skip leaves it visually hidden.
  await withPage(async (page) => {
    await page.click('#haHelpToggle');
    await page.evaluate(() => { launchGuidedTour(); skipGuidedTour(); });
    const state = await helpState(page);
    assertHelpHidden(state, 'required test 7 (Skip leaves Help visually hidden)');
  });

  // 8) Escape from the tour leaves it visually hidden.
  await withPage(async (page) => {
    await page.click('#haHelpToggle');
    await page.evaluate(() => { launchGuidedTour(); });
    await page.keyboard.press('Escape');
    const state = await helpState(page);
    assertHelpHidden(state, 'required test 8 (Escape from the tour leaves Help visually hidden)');
  });

  // 9) Closing Add Customer Data does not expose Help.
  await withPage(async (page) => {
    await page.click('#haHelpToggle');
    await page.evaluate(() => { openAddCustomerDataModal(); closeAddCustomerDataModal(); });
    const state = await helpState(page);
    assertHelpHidden(state, 'required test 9 (closing Add Customer Data does not expose Help)');
  });

  // 10) Closing Manage Customer Accounts does not expose Help.
  await withPage(async (page) => {
    await page.click('#haHelpToggle');
    await page.evaluate(() => { open(); close(); });
    const state = await helpState(page);
    assertHelpHidden(state, 'required test 10 (closing Manage Customer Accounts does not expose Help)');
  });

  // Extra: nested overlays (tour launched while Add Customer Data is
  // somehow already open -- beginOverlay()'s counter must still net to zero
  // once both close) never leave Help exposed either.
  await withPage(async (page) => {
    await page.evaluate(() => { openAddCustomerDataModal(); });
    await page.click('#haHelpToggle');
    await page.evaluate(() => { launchGuidedTour(); finishGuidedTour(); closeAddCustomerDataModal(); });
    const state = await helpState(page);
    assertHelpHidden(state, 'extra: nested overlay open/close (Add Customer Data + tour) still leaves Help hidden once both close');
  });

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  rmSync(TMP_DIR, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('FAIL: browser test harness threw an unexpected error:', err);
  rmSync(TMP_DIR, { recursive: true, force: true });
  process.exit(1);
});
