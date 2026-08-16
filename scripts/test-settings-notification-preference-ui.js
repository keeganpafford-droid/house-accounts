// Notification & Outcome Loop V1, Part A4: settings.html's new
// Notifications control -- a plain Daily/Weekly/In-app only <select> that
// auto-saves via the existing POST /api/settings action pattern
// (action:'update-notification-preference'), no new settings architecture.
//
// This file proves the REAL, unmodified settings.html markup/script in a
// real Chromium page: the select is populated from the real GET /api/settings
// response, and changing it POSTs the exact expected body and shows a
// brief "Saved" confirmation.
//
// Usage: node scripts/test-settings-notification-preference-ui.js
// Prerequisite: playwright + Chromium (same as the other browser tests in
// this suite).
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { chromium } from 'playwright';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const SETTINGS_SRC = readFileSync(path.join(REPO_ROOT, 'settings.html'), 'utf8');

// Real settings.html markup/script, verbatim, with the external
// /auth-client.js and /site-header.js <script> tags replaced by a minimal
// inline HouseAuth stub -- the same substitution technique used elsewhere
// in this suite to run a real static page's own inline script in a
// standalone harness without a live server or Supabase.
const HARNESS_HTML = SETTINGS_SRC
  .replace('<script src="/auth-client.js"></script>', `<script>
    window.HouseAuth = {
      requireAuth: async () => true,
      authHeadersAsync: async () => ({ Authorization: 'Bearer test-token' })
    };
  </script>`)
  .replace('<script src="/site-header.js" defer></script>', '');

function resolveChromiumExecutablePath(){
  const candidate = '/opt/pw-browsers/chromium';
  return existsSync(candidate) ? candidate : undefined;
}

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'ha-settings-notification-pref-'));
const HARNESS_PATH = path.join(TMP_DIR, 'harness.html');
writeFileSync(HARNESS_PATH, HARNESS_HTML);
const HARNESS_URL = 'file://' + HARNESS_PATH;

async function withPage({ initialPreference = 'weekly', postFails = false } = {}, run){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const postBodies = [];
    await page.route('**/api/settings**', async (route) => {
      const req = route.request();
      if(req.method() === 'GET'){
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          user: { name: 'Rep One', email: 'rep@example.com', app_role: 'owner', notification_preference: initialPreference, created_at: '2026-01-01T00:00:00Z' },
          organization: { name: 'Acme Co', plan: 'free' },
          usage: { companyLimit: 10, trialActive: false, totalMonitoredCompanies: 3, seatsUsed: 1 }
        }) });
        return;
      }
      const body = JSON.parse(req.postData() || '{}');
      postBodies.push(body);
      if(body.action === 'update-notification-preference'){
        if(postFails){ await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { notification_preference: body.notificationPreference } }) });
        return;
      }
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'unexpected action in test' }) });
    });
    await page.route('**/api/team**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seatsUsed: 1, pendingInviteCount: 0, users: [], pendingInvitations: [] }) });
    });
    await page.goto(HARNESS_URL, { waitUntil: 'load' });
    await page.waitForTimeout(150); // let load()'s async GET /api/settings resolve and populate the select
    await run(page, postBodies);
  } finally {
    await browser.close();
  }
}

async function main(){
  // REQUIRED: the select is populated from the real fetched preference, not
  // always defaulting to the same value.
  await withPage({ initialPreference: 'daily' }, async (page) => {
    const value = await page.$eval('#notificationPreferenceSelect', el => el.value);
    assert(value === 'daily', `REQUIRED: the select reflects the real fetched notification_preference (got ${JSON.stringify(value)})`);
  });
  await withPage({ initialPreference: 'in_app_only' }, async (page) => {
    const value = await page.$eval('#notificationPreferenceSelect', el => el.value);
    assert(value === 'in_app_only', `REQUIRED: the select reflects in_app_only when that is the real fetched value (got ${JSON.stringify(value)})`);
  });

  // REQUIRED: only the three plain-language options exist -- no SMS, Slack,
  // instant, custom-time, or any other advanced notification knob.
  await withPage({}, async (page) => {
    const options = await page.$$eval('#notificationPreferenceSelect option', els => els.map(el => ({ value: el.value, label: el.textContent.trim() })));
    assert(options.length === 3, `REQUIRED: exactly three options exist, no extra notification knobs (got ${JSON.stringify(options)})`);
    assert(options.some(o => o.value === 'daily' && o.label === 'Daily'), 'a plain-language "Daily" option exists');
    assert(options.some(o => o.value === 'weekly' && o.label === 'Weekly'), 'a plain-language "Weekly" option exists');
    assert(options.some(o => o.value === 'in_app_only' && o.label === 'In-app only'), 'a plain-language "In-app only" option exists');
  });

  // REQUIRED: changing the select saves via the exact existing action
  // pattern, and shows a brief confirmation.
  await withPage({ initialPreference: 'weekly' }, async (page, postBodies) => {
    await page.selectOption('#notificationPreferenceSelect', 'daily');
    await page.waitForTimeout(80);
    assert(postBodies.length === 1, `REQUIRED: changing the select triggers exactly one save request (got ${postBodies.length})`);
    assert(postBodies[0]?.action === 'update-notification-preference' && postBodies[0]?.notificationPreference === 'daily', `REQUIRED: the save request uses the existing action pattern with the newly selected value (got ${JSON.stringify(postBodies[0])})`);
    const savedVisible = await page.isVisible('#notificationPreferenceSaved');
    assert(savedVisible === true, 'REQUIRED: a "Saved" confirmation appears after a successful save');
  });

  // A failed save does not crash the page or falsely show "Saved".
  await withPage({ postFails: true }, async (page) => {
    await page.selectOption('#notificationPreferenceSelect', 'in_app_only');
    await page.waitForTimeout(80);
    const savedVisible = await page.isVisible('#notificationPreferenceSaved');
    assert(savedVisible === false, 'REQUIRED: a failed save never shows the "Saved" confirmation');
  });

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
