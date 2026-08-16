// Notification & Outcome Loop V1, UX audit follow-up: two smallest-possible
// rep-facing improvements the founder's read-only audit called for --
// (1) the latest outcome_reported status is now visible wherever the prior
// outreach state is already shown (the Prepare for Call outreach row), and
// (2) a lightweight, non-modal confirmation appears immediately after a
// successful outcome click, before the unresolved-outreach row disappears.
// Neither adds a new table, event type, or scoring/CRM concept -- both reuse
// existing read-back (api/signal-events.js) and UI surfaces verbatim.
//
// This file proves the REAL, unmodified dashboard/index.html source (via
// dashboard-extract.js) in a real Chromium page -- same convention as
// scripts/test-outreach-row-hidden-state-css.js and
// scripts/test-dashboard-card-outreach-hydration.js -- because both
// behaviors depend on real DOM/hidden-attribute/CSS rendering and a real
// setTimeout-driven removal, none of which a source-string assertion alone
// can prove.
//
// Usage: node scripts/test-outcome-visibility-and-confirmation.js
// Prerequisite: same as test-outreach-row-hidden-state-css.js (playwright +
// Chromium).
import { writeFileSync, mkdtempSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { chromium } from 'playwright';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

const styleStart = DASHBOARD_SRC.indexOf('<style>');
const styleEnd = DASHBOARD_SRC.indexOf('</style>');
if(styleStart === -1 || styleEnd === -1) throw new Error('Could not locate <style>...</style> in dashboard/index.html');
const DASHBOARD_CSS = DASHBOARD_SRC.slice(styleStart + '<style>'.length, styleEnd);

function resolveChromiumExecutablePath(){
  const candidate = '/opt/pw-browsers/chromium';
  return existsSync(candidate) ? candidate : undefined;
}

// ===========================================================================
// Part A: outcome visibility on the outreach row (wireOutreachRow's
// renderSaved()/hydrateOutreachRow(), same shape as
// test-outreach-row-hidden-state-css.js).
// ===========================================================================
const OUTREACH_ROW_JS_SRC = [
  extractFn(DASHBOARD_SRC, 'OUTCOME_DISPLAY_TEXT'),
  extractFn(DASHBOARD_SRC, 'signalStateKey'),
  extractFn(DASHBOARD_SRC, 'generateClientEventId'),
  extractFn(DASHBOARD_SRC, 'logSignalEvent'),
  extractFn(DASHBOARD_SRC, 'fetchSignalEventStates'),
  extractFn(DASHBOARD_SRC, 'wireOutreachRow'),
  extractFn(DASHBOARD_SRC, 'hydrateOutreachRow'),
].join('\n\n');

function outreachRowMarkup({ id, fingerprint, accountName }){
  return `
    <div class="sales-play-outreach-row" id="${id}" data-outreach-signal-id="sig-1" data-outreach-fingerprint="${fingerprint}" data-account-name="${accountName}">
      <span class="outreach-status" hidden>Reached out ✓</span>
      <span class="outreach-outcome-status" hidden></span>
      <div class="approach-note-readonly" hidden></div>
      <div class="approach-note-wrap" hidden>
        <label class="approach-note-label">How did you approach this outreach?</label>
        <textarea class="approach-note-input" maxlength="500"></textarea>
        <button type="button" class="btn btn-ghost btn-mini approach-note-save" data-approach-save="1">Save outreach</button>
        <button type="button" class="btn btn-ghost btn-mini approach-note-cancel" data-approach-cancel="1">Cancel</button>
      </div>
      <button type="button" class="btn btn-ghost btn-mini outreach-log-btn" data-outreach-log="1">I reached out</button>
    </div>`;
}

const SIGNAL_FINGERPRINT = 'fp-signal-1';
const SIGNAL_ACCOUNT = 'Acme Co';

const ROW_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${DASHBOARD_CSS}</style>
</head>
<body>
${outreachRowMarkup({ id: 'signalRow', fingerprint: SIGNAL_FINGERPRINT, accountName: SIGNAL_ACCOUNT })}
<script>
window.HouseAuth = { authHeadersAsync: async () => ({}) };
${OUTREACH_ROW_JS_SRC}
window.__wireOutreachRow = wireOutreachRow;
window.__hydrateOutreachRow = hydrateOutreachRow;
</script>
</body></html>`;

const ROW_TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'ha-outcome-visibility-'));
const ROW_HARNESS_PATH = path.join(ROW_TMP_DIR, 'harness.html');
writeFileSync(ROW_HARNESS_PATH, ROW_PAGE_HTML);
const ROW_HARNESS_URL = 'file://' + ROW_HARNESS_PATH;

async function withRowPage(getBackState, run){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.route('**/api/signal-events**', async (route) => {
      const req = route.request();
      if(req.method() === 'GET'){
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, states: getBackState }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'event-x' }) });
    });
    await page.goto(ROW_HARNESS_URL, { waitUntil: 'load' });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function outcomeStatusState(page){
  return page.evaluate(() => {
    const el = document.querySelector('#signalRow .outreach-outcome-status');
    return { hidden: el.hasAttribute('hidden'), display: getComputedStyle(el).display, text: el.textContent };
  });
}

// ===========================================================================
// Part B: post-click confirmation on the unresolved-outreach panel
// (renderUnresolvedOutreachItem()/initUnresolvedOutreachPanel()).
// ===========================================================================
const PANEL_JS_SRC = [
  extractFn(DASHBOARD_SRC, 'OUTCOME_STATUS_LABELS'),
  extractFn(DASHBOARD_SRC, 'OUTCOME_CONFIRMATION_TEXT'),
  extractFn(DASHBOARD_SRC, 'daysSinceIso'),
  extractFn(DASHBOARD_SRC, 'generateClientEventId'),
  extractFn(DASHBOARD_SRC, 'logSignalEvent'),
  extractFn(DASHBOARD_SRC, 'fetchUnresolvedOutreach'),
  extractFn(DASHBOARD_SRC, 'renderUnresolvedOutreachItem'),
  extractFn(DASHBOARD_SRC, 'initUnresolvedOutreachPanel'),
].join('\n\n');

const PANEL_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
<section id="unresolvedOutreachPanel" hidden>
  <div id="unresolvedOutreachList"></div>
</section>
<script>
window.HouseAuth = { authHeadersAsync: async () => ({}) };
${PANEL_JS_SRC}
</script>
</body></html>`;

const PANEL_TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'ha-outcome-confirmation-'));
const PANEL_HARNESS_PATH = path.join(PANEL_TMP_DIR, 'harness.html');
writeFileSync(PANEL_HARNESS_PATH, PANEL_PAGE_HTML);
const PANEL_HARNESS_URL = 'file://' + PANEL_HARNESS_PATH;

function unresolvedItem(overrides = {}){
  return {
    outreachEventId: 'outreach-1', accountName: 'Acme Co', eventFingerprint: 'fp-signal-1',
    signalId: 'sig-1', opportunityId: null, outreachCreatedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
    currentStatus: null, isEligibleForPrompt: true, isStillOpen: true, latestOutcomeReportedAt: null,
    ...overrides
  };
}

async function withPanelPage(items, run){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.route('**/api/unresolved-outreach**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items }) });
    });
    await page.route('**/api/signal-events**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'outcome-event-1' }) });
    });
    await page.goto(PANEL_HARNESS_URL, { waitUntil: 'load' });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function main(){
  // =========================================================================
  // Part A -- outcome visibility.
  // =========================================================================
  await withRowPage({}, async (page) => {
    await page.evaluate(() => { window.__wireOutreachRow(document.getElementById('signalRow')); window.__hydrateOutreachRow(document.getElementById('signalRow')); });
    await page.waitForTimeout(50);
    const state = await outcomeStatusState(page);
    assert(state.hidden === true, 'REQUIRED: no outreach at all -- the outcome line stays hidden');
  });

  const OUTCOME_KEY = `fp-signal-1::${SIGNAL_ACCOUNT}`;
  await withRowPage({ [OUTCOME_KEY]: { feedback: null, selected: false, outreachLogged: true, latestOutreachEventId: 'evt-1', approachNote: null, outcomeStatus: null, latestOutcomeReportedAt: null } }, async (page) => {
    await page.evaluate(() => { window.__wireOutreachRow(document.getElementById('signalRow')); window.__hydrateOutreachRow(document.getElementById('signalRow')); });
    await page.waitForTimeout(50);
    const state = await outcomeStatusState(page);
    assert(state.hidden === true, 'REQUIRED: outreach logged but no outcome reported yet -- the outcome line stays hidden (never a false "still waiting")');
  });

  const CASES = [
    ['engaged', 'Outcome: Engaged'],
    ['progressed', 'Outcome: Real progress'],
    ['went_nowhere', 'Outcome: Went nowhere'],
    ['no_response_yet', 'Still waiting for a response'],
  ];
  for(const [status, expectedText] of CASES){
    await withRowPage({ [OUTCOME_KEY]: { feedback: null, selected: false, outreachLogged: true, latestOutreachEventId: 'evt-1', approachNote: null, outcomeStatus: status, latestOutcomeReportedAt: '2026-08-15T00:00:00Z' } }, async (page) => {
      await page.evaluate(() => { window.__wireOutreachRow(document.getElementById('signalRow')); window.__hydrateOutreachRow(document.getElementById('signalRow')); });
      await page.waitForTimeout(50);
      const state = await outcomeStatusState(page);
      assert(state.hidden === false, `REQUIRED: a reported outcome ("${status}") is visibly shown on the existing outreach surface`);
      assert(state.display !== 'none', `REQUIRED: computed display is not "none" for outcome "${status}" (got "${state.display}")`);
      assert(state.text === expectedText, `REQUIRED: outcome "${status}" renders the exact founder-specified copy (got "${state.text}", want "${expectedText}")`);
    });
  }

  // =========================================================================
  // Part B -- post-click confirmation.
  // =========================================================================
  const CONFIRMATION_CASES = [
    ['engaged', 'Got it — they engaged. We’ll stop asking about this outreach and keep the result with this account.'],
    ['progressed', 'Got it — real progress. We’ll stop asking about this outreach and keep the result with this account.'],
    ['went_nowhere', 'Got it — it went nowhere. We’ll stop asking about this outreach and keep the result with this account.'],
    ['no_response_yet', 'Got it — no response yet. We’ll check back in about a week.'],
  ];
  for(const [status, expectedText] of CONFIRMATION_CASES){
    await withPanelPage([unresolvedItem()], async (page) => {
      await page.evaluate(() => window.initUnresolvedOutreachPanel());
      await page.waitForTimeout(50);
      const buttons = await page.$$('#unresolvedOutreachList button');
      // Buttons render in Object.keys(OUTCOME_STATUS_LABELS) order: no_response_yet, engaged, progressed, went_nowhere.
      const order = ['no_response_yet', 'engaged', 'progressed', 'went_nowhere'];
      const btnIndex = order.indexOf(status);
      await buttons[btnIndex].click();
      await page.waitForTimeout(80);
      const rowText = await page.textContent('#unresolvedOutreachList .unresolved-outreach-item');
      assert(rowText.includes(expectedText), `REQUIRED: clicking "${status}" shows the exact founder-specified confirmation immediately (got "${rowText}")`);
      assert(!rowText.toLowerCase().includes('improve') && !rowText.toLowerCase().includes('recommendation'), `REQUIRED: the confirmation for "${status}" never claims House Accounts will improve future recommendations from this result`);
      // REQUIRED (founder QA correction): the unresolved action buttons
      // (the four outcome-status choices) are gone immediately -- only the
      // Close action remains -- and the row does NOT disappear on its own
      // no matter how long it sits there, since there is no auto-dismiss
      // timer anymore.
      const statusButtonsRemaining = await page.$$eval('#unresolvedOutreachList .unresolved-outreach-item button', btns => btns.filter(b => !b.classList.contains('unresolved-outreach-confirmation-close')).length);
      assert(statusButtonsRemaining === 0, `REQUIRED: the unresolved outcome-status buttons disappear immediately once the outcome is saved (got ${statusButtonsRemaining} remaining)`);
      const closeBtn = await page.$('#unresolvedOutreachList .unresolved-outreach-confirmation-close');
      assert(!!closeBtn && (await closeBtn.textContent()).trim() === 'Close', 'REQUIRED: a lightweight Close action is present on the confirmation');
      await page.waitForTimeout(3200); // well past the OLD 2600ms auto-dismiss window
      const stillPresentAfterWait = await page.$('#unresolvedOutreachList .unresolved-outreach-item');
      assert(!!stillPresentAfterWait, `REQUIRED: no timer-based auto-dismiss remains -- the confirmation for "${status}" is still visible after waiting well past the old dismiss window`);
    });
  }

  // Clicking Close removes the row and hides the panel once empty -- the
  // rep's own explicit action, not a timer.
  await withPanelPage([unresolvedItem()], async (page) => {
    await page.evaluate(() => window.initUnresolvedOutreachPanel());
    await page.waitForTimeout(50);
    await page.click('#unresolvedOutreachList button:has-text("They engaged")');
    await page.waitForTimeout(80);
    const presentAfterClick = await page.$('#unresolvedOutreachList .unresolved-outreach-item');
    assert(!!presentAfterClick, 'sanity: row still present immediately after the outcome click (confirmation showing)');
    await page.click('#unresolvedOutreachList .unresolved-outreach-confirmation-close');
    const presentAfterClose = await page.$('#unresolvedOutreachList .unresolved-outreach-item');
    assert(!presentAfterClose, 'REQUIRED: clicking Close removes the row');
    const panelHidden = await page.evaluate(() => document.getElementById('unresolvedOutreachPanel').hidden);
    assert(panelHidden === true, 'REQUIRED: the panel hides itself once its last item is removed via Close');
  });

  // Ephemeral, not persisted: a fresh panel load (simulating a page
  // refresh/revisit) never shows a leftover confirmation -- the server's
  // own /api/unresolved-outreach simply no longer returns a resolved item,
  // which is what actually keeps the confirmation from reappearing (not any
  // local "confirmation dismissed" flag).
  await withPanelPage([], async (page) => {
    await page.evaluate(() => window.initUnresolvedOutreachPanel());
    await page.waitForTimeout(50);
    const panelHidden = await page.evaluate(() => document.getElementById('unresolvedOutreachPanel').hidden);
    assert(panelHidden === true, 'REQUIRED: once the outcome is resolved server-side, a fresh load (refresh/revisit) never shows the item or its confirmation again');
  });

  // No modal, no required note, no extra workflow: a single click resolves
  // the item -- no additional element (dialog/textarea/select) is ever
  // introduced by a successful click, and Close is a plain inline button,
  // not a second confirmation step.
  await withPanelPage([unresolvedItem()], async (page) => {
    await page.evaluate(() => window.initUnresolvedOutreachPanel());
    await page.waitForTimeout(50);
    await page.click('#unresolvedOutreachList button:has-text("They engaged")');
    await page.waitForTimeout(80);
    const hasModalOrForm = await page.evaluate(() => !!document.querySelector('dialog, .modal, textarea, select'));
    assert(hasModalOrForm === false, 'REQUIRED: the confirmation stays lightweight -- no modal, textarea, or select is introduced');
  });

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
