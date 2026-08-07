// Paid-beta-readiness sprint -- real-browser regression coverage for the
// restored What's New page (item 8 of the required test list: syntax AND
// browser tests). Loads the actual, unmodified whats-new.html file via a
// real file:// navigation (a real origin, so localStorage genuinely works,
// unlike page.setContent()'s opaque-origin document), routing its
// root-relative asset requests (/site-header.js, /site-header.css,
// /auth-client.js, /favicon.svg) to the real on-disk files so the real,
// unmodified site-header.js actually runs and mutates the real DOM --
// exactly what a production page load does.
//
// Usage: node scripts/test-whats-new-browser.js
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
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

const WHATS_NEW_PATH = path.join(REPO_ROOT, 'whats-new.html');
const WHATS_NEW_URL = 'file://' + WHATS_NEW_PATH;

async function withPage(authenticated, run){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const consoleErrors = [];
    page.on('console', msg => { if(msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push(String(err)));
    for(const asset of ['site-header.js', 'site-header.css', 'auth-client.js', 'favicon.svg']){
      await page.route(`**/${asset}`, route => route.fulfill({ path: path.join(REPO_ROOT, asset) }));
    }
    if(authenticated){
      await page.addInitScript(() => {
        localStorage.setItem('haAuthSession', JSON.stringify({ access_token: 'fake-token' }));
        localStorage.setItem('haAuthUser', JSON.stringify({ email: 'test@example.com' }));
      });
    }
    await page.goto(WHATS_NEW_URL, { waitUntil: 'load' });
    await run(page, consoleErrors);
  } finally {
    await browser.close();
  }
}

async function main(){
  // Item 1: the page route loads without error, for a signed-out visitor.
  await withPage(false, async (page, consoleErrors) => {
    const title = await page.title();
    assert(title === "What's New | House Accounts", `item 1: whats-new.html loads with the expected title (got "${title}")`);
    assert(consoleErrors.length === 0, `item 1/8: no console errors on page load (got: ${JSON.stringify(consoleErrors)})`);
  });

  // Item 4: Recently Shipped, Up Next, and Exploring all actually paint as
  // distinct, visible sections in a real browser.
  await withPage(false, async (page) => {
    for(const label of ['Recently Shipped', 'Up Next', 'Exploring']){
      const box = await page.locator(`.badge:has-text("${label}")`).first().boundingBox();
      assert(box && box.height > 0, `item 4: the "${label}" badge/section is visibly rendered (got ${JSON.stringify(box)})`);
    }
  });

  // Item 3/6: for an authenticated visitor, the real site-header.js
  // replaces the static header with the dynamic one, and the Help
  // dropdown -- containing the new What's New link, plus every
  // pre-existing item -- opens correctly, same as on every other
  // authenticated page.
  await withPage(true, async (page) => {
    await page.waitForSelector('#haHelpDropdown', { state: 'attached' });
    await page.click('#haHelpToggle');
    const helpLink = page.locator('#haHelpDropdown a', { hasText: "What's New" });
    await helpLink.waitFor({ state: 'visible' });
    const href = await helpLink.getAttribute('href');
    assert(href === '/whats-new.html', `item 2/6: the Help dropdown's "What's New" link points to /whats-new.html (got "${href}")`);
    for(const existingLabel of ['Restart Product Tour', 'Export Help', 'Upload Troubleshooting', 'Contact / Feedback']){
      const visible = await page.locator('#haHelpDropdown a', { hasText: existingLabel }).isVisible();
      assert(visible, `item 6: existing Help item "${existingLabel}" is still visible alongside the new link`);
    }
  });

  // Item 3: mobile navigation remains functional -- at a mobile viewport,
  // the hamburger menu still opens the nav shell (which contains the Help
  // menu / What's New link) exactly as it does on every other page.
  await withPage(true, async (page) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForSelector('.ha-menu-button', { state: 'attached' });
    const menuButton = page.locator('.ha-menu-button');
    await menuButton.click();
    const expanded = await menuButton.getAttribute('aria-expanded');
    assert(expanded === 'true', `item 3: the mobile menu button opens the nav shell (aria-expanded="${expanded}")`);
    const navShellVisible = await page.locator('.ha-nav-shell').isVisible();
    assert(navShellVisible, 'item 3: the nav shell (containing the Help menu and the new What\'s New link) is visible after opening the mobile menu');
  });

  // Item 7: for a SIGNED-OUT visitor, no Help menu (and therefore no
  // What's New link) renders at all -- authentication behavior is
  // unchanged, matching every other authenticated-only surface.
  await withPage(false, async (page) => {
    const helpMenuCount = await page.locator('#haHelpDropdown').count();
    assert(helpMenuCount === 0, 'item 7: no Help dropdown (and therefore no What\'s New link) renders for a signed-out visitor -- authentication gating is unchanged');
    const loginVisible = await page.locator('a:has-text("Log In")').first().isVisible();
    assert(loginVisible, 'item 7: signed-out visitors still see the standard Log In link');
  });

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
