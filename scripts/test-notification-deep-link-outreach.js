// Notification Deep Links (bounded scope, Part A3): a notification's
// "Report outcome ->" link carries ?outreach=<outreachEventId> -- the exact
// stable ha_signal_events primary key /api/unresolved-outreach already
// returns and dashboard/index.html's own panel already keys everything on.
// initUnresolvedOutreachPanel() is the one place this list is fetched AND
// rendered, so it's also the correct, self-contained place to check for a
// matching item and bring it into view once rendering is done -- no new
// routing architecture, no durable navigation state, nothing that depends
// on the much larger/async priorities-feed render pipeline (that's exactly
// why the per-signal "View opportunity ->" deep link is NOT built here --
// see BACKLOG.md's "Notification Deep Links / Actionable Re-entry" entry).
//
// This file proves the REAL, unmodified renderUnresolvedOutreachItem()/
// initUnresolvedOutreachPanel() against a real DOM in a real Chromium page.
//
// Usage: node scripts/test-notification-deep-link-outreach.js
// Prerequisite: playwright + Chromium (same as the other dashboard
// Playwright tests in this suite).
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

const JS_SRC = [
  extractFn(DASHBOARD_SRC, 'OUTCOME_STATUS_LABELS'),
  extractFn(DASHBOARD_SRC, 'OUTCOME_CONFIRMATION_TEXT'),
  extractFn(DASHBOARD_SRC, 'daysSinceIso'),
  extractFn(DASHBOARD_SRC, 'generateClientEventId'),
  extractFn(DASHBOARD_SRC, 'logSignalEvent'),
  extractFn(DASHBOARD_SRC, 'fetchUnresolvedOutreach'),
  extractFn(DASHBOARD_SRC, 'renderUnresolvedOutreachItem'),
  extractFn(DASHBOARD_SRC, 'initUnresolvedOutreachPanel'),
].join('\n\n');

const styleStart = DASHBOARD_SRC.indexOf('<style>');
const styleEnd = DASHBOARD_SRC.indexOf('</style>');
if(styleStart === -1 || styleEnd === -1) throw new Error('Could not locate <style>...</style> in dashboard/index.html');
const DASHBOARD_CSS = DASHBOARD_SRC.slice(styleStart + '<style>'.length, styleEnd);

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<section id="unresolvedOutreachPanel" hidden>
  <div id="unresolvedOutreachList"></div>
</section>
<script>
window.HouseAuth = { authHeadersAsync: async () => ({}) };
${JS_SRC}
</script>
</body></html>`;

function resolveChromiumExecutablePath(){
  const candidate = '/opt/pw-browsers/chromium';
  return existsSync(candidate) ? candidate : undefined;
}

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'ha-notification-deep-link-'));
const HARNESS_PATH = path.join(TMP_DIR, 'harness.html');
writeFileSync(HARNESS_PATH, PAGE_HTML);
const HARNESS_URL = 'file://' + HARNESS_PATH;

function unresolvedItem(overrides = {}){
  return {
    outreachEventId: 'outreach-1', accountName: 'Acme Co', eventFingerprint: 'fp-signal-1',
    signalId: 'sig-1', opportunityId: null, outreachCreatedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
    currentStatus: null, isEligibleForPrompt: true, isStillOpen: true, latestOutcomeReportedAt: null,
    ...overrides
  };
}

async function withPanelPage(items, queryString, run){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
    await page.route('**/api/unresolved-outreach**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items }) });
    });
    await page.goto(HARNESS_URL + queryString, { waitUntil: 'load' });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function main(){
  // REQUIRED: a matching ?outreach=<id> stamps the correct row with a
  // highlight and brings it into view -- proves the deep link actually
  // lands on the SPECIFIC item, not just the general panel.
  await withPanelPage(
    [unresolvedItem({ outreachEventId: 'outreach-1', accountName: 'Acme Co' }), unresolvedItem({ outreachEventId: 'outreach-2', accountName: 'Beta Co' })],
    '?outreach=outreach-2',
    async (page) => {
      await page.evaluate(() => window.initUnresolvedOutreachPanel());
      await page.waitForTimeout(80);
      const rows = await page.$$eval('#unresolvedOutreachList .unresolved-outreach-item', els => els.map(el => ({
        outreachEventId: el.dataset.outreachEventId,
        highlighted: el.classList.contains('unresolved-outreach-item-highlight')
      })));
      const target = rows.find(r => r.outreachEventId === 'outreach-2');
      const other = rows.find(r => r.outreachEventId === 'outreach-1');
      assert(!!target && target.highlighted === true, `REQUIRED: the row matching ?outreach=outreach-2 is highlighted (got ${JSON.stringify(rows)})`);
      assert(!!other && other.highlighted === false, 'REQUIRED: a non-matching row is never highlighted');
    }
  );

  // REQUIRED: the dataset identifier is stamped on every rendered row,
  // even with no deep-link param present -- proves the identifier itself
  // (not just the highlight behavior) is always available.
  await withPanelPage([unresolvedItem({ outreachEventId: 'outreach-3' })], '', async (page) => {
    await page.evaluate(() => window.initUnresolvedOutreachPanel());
    await page.waitForTimeout(80);
    const stamped = await page.$eval('#unresolvedOutreachList .unresolved-outreach-item', el => el.dataset.outreachEventId);
    assert(stamped === 'outreach-3', `REQUIRED: every rendered unresolved-outreach row carries its own outreachEventId as data-outreach-event-id (got ${JSON.stringify(stamped)})`);
  });

  // REQUIRED: a deep link to an item that no longer exists (already
  // resolved, or simply not this rep's) must never break the page -- the
  // rep still lands on a normal, working panel.
  await withPanelPage([unresolvedItem({ outreachEventId: 'outreach-1' })], '?outreach=does-not-exist', async (page) => {
    let pageError = null;
    page.on('pageerror', (err) => { pageError = err; });
    await page.evaluate(() => window.initUnresolvedOutreachPanel());
    await page.waitForTimeout(80);
    assert(pageError === null, `REQUIRED: a deep link to a non-existent/already-resolved item never throws or breaks the page (got ${pageError})`);
    const panelHidden = await page.evaluate(() => document.getElementById('unresolvedOutreachPanel').hidden);
    assert(panelHidden === false, 'REQUIRED: the panel still renders normally (with the real, unrelated item) when the deep-link target is not found');
  });

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
