// Support UX correction round -- real-browser coverage proving the native
// window.alert() success/error copy on contact.html has been replaced with
// a branded, accessible inline panel, per form (Feedback / Bug / Feature
// Request). Loads the actual, unmodified contact.html via a real file://
// navigation (a real origin, so the page's own script runs exactly as in
// production) and intercepts the /api/feedback POST so no real network
// call -- and no real email -- is ever made.
//
// Usage: node scripts/test-contact-success-panel-browser.js
import { existsSync } from 'fs';
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

const CONTACT_PATH = path.join(REPO_ROOT, 'contact.html');
const CONTACT_URL = 'file://' + CONTACT_PATH;

async function withPage(run){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // Records every window.alert() call instead of letting it block a
    // headless run -- this IS the regression trip-wire: if any code path
    // still calls the native alert, this array will be non-empty.
    await page.addInitScript(() => {
      window.__alertCalls = [];
      window.alert = (msg) => { window.__alertCalls.push(String(msg)); };
    });
    for(const asset of ['site-header.js', 'site-header.css', 'auth-client.js', 'favicon.svg']){
      await page.route(`**/${asset}`, route => route.fulfill({ path: path.join(REPO_ROOT, asset) }));
    }
    await page.goto(CONTACT_URL, { waitUntil: 'load' });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function submitForm(page, formSelector, fieldSelector, text){
  await page.fill(`${formSelector} ${fieldSelector}`, text);
  await page.click(`${formSelector} button[type="submit"]`);
}

const FORM_CASES = [
  { type: 'Feedback', formSelector: 'form[data-feedback-type="Feedback"]', fieldSelector: '#generalFeedback', expectedTitle: 'Feedback submitted' },
  { type: 'Bug', formSelector: 'form[data-feedback-type="Bug"]', fieldSelector: '#bugWhatHappened', expectedTitle: 'Bug report submitted' },
  { type: 'Feature Request', formSelector: 'form[data-feedback-type="Feature Request"]', fieldSelector: '#featureSuggestion', expectedTitle: 'Feature request submitted' }
];

async function main(){
  // Items 1-4: successful submission for each of the three types shows a
  // branded panel with type-specific wording, and window.alert() is never
  // invoked.
  for(const testCase of FORM_CASES){
    await withPage(async (page) => {
      await page.route('**/api/feedback', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ success: true })
      }));

      await submitForm(page, testCase.formSelector, testCase.fieldSelector, 'A real test message for the ' + testCase.type + ' form.');
      const statusEl = page.locator(`${testCase.formSelector} .form-status`);
      await statusEl.waitFor({ state: 'visible' });

      const title = await statusEl.locator('strong').textContent();
      assert(title.trim() === testCase.expectedTitle, `item 1-4 (${testCase.type}): branded success panel shows "${testCase.expectedTitle}" (got "${title.trim()}")`);
      const subtitle = await statusEl.locator('span').textContent();
      assert(/received it/i.test(subtitle), `item 1-4 (${testCase.type}): branded panel includes a short confirmation line (got "${subtitle}")`);
      assert(await statusEl.evaluate(el => el.classList.contains('form-status--success')), `item 1-4 (${testCase.type}): success panel carries the success visual class`);

      const alertCalls = await page.evaluate(() => window.__alertCalls);
      assert(alertCalls.length === 0, `item 1-3 (${testCase.type}): window.alert() was never called for a successful submission (got ${JSON.stringify(alertCalls)})`);

      // Form clears only after confirmed success.
      const fieldValue = await page.locator(`${testCase.formSelector} ${testCase.fieldSelector}`).inputValue();
      assert(fieldValue === '', `item (${testCase.type}): the form field is cleared after a confirmed successful submission`);

      // Does not navigate away.
      assert(page.url().startsWith('file://') && page.url().includes('contact.html'), `item (${testCase.type}): submitting does not navigate the user away from contact.html`);
    });
  }

  // Item 5: a failed submission shows an honest error state, never success.
  await withPage(async (page) => {
    await page.route('**/api/feedback', route => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Simulated failure' })
    }));
    await submitForm(page, 'form[data-feedback-type="Bug"]', '#bugWhatHappened', 'This submission will fail.');
    const statusEl = page.locator('form[data-feedback-type="Bug"] .form-status');
    await statusEl.waitFor({ state: 'visible' });
    assert(await statusEl.evaluate(el => el.classList.contains('form-status--error')), 'item 5: a failed submission shows the error visual state');
    assert(!(await statusEl.evaluate(el => el.classList.contains('form-status--success'))), 'item 5: a failed submission never shows the success visual state');
    const role = await statusEl.getAttribute('role');
    assert(role === 'alert', `item 5/6: the error panel uses role="alert" for an assertive accessible announcement (got "${role}")`);
    const alertCalls = await page.evaluate(() => window.__alertCalls);
    assert(alertCalls.length === 0, `item 5: window.alert() was never called for a failed submission either (got ${JSON.stringify(alertCalls)})`);
    // The field is NOT cleared on failure.
    const fieldValue = await page.locator('form[data-feedback-type="Bug"] #bugWhatHappened').inputValue();
    assert(fieldValue === 'This submission will fail.', 'item 5: the form is not reset when submission fails');
  });

  // Item 6: accessible announcement semantics + keyboard accessibility --
  // the success panel uses role="status"/aria-live="polite", and the whole
  // flow (fill via keyboard focus, submit via Enter) works with no mouse.
  await withPage(async (page) => {
    await page.route('**/api/feedback', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ success: true })
    }));
    await page.locator('#generalFeedback').focus();
    await page.keyboard.type('Keyboard-only submission test.');
    // Tab from the textarea to the email field, then to the submit button,
    // and activate it with Enter -- no mouse click anywhere in this test.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement.tagName + ':' + document.activeElement.type);
    assert(focused === 'BUTTON:submit', `item 6: Tab order reaches the submit button from the message field without a mouse (got "${focused}")`);
    await page.keyboard.press('Enter');

    const statusEl = page.locator('form[data-feedback-type="Feedback"] .form-status');
    await statusEl.waitFor({ state: 'visible' });
    const role = await statusEl.getAttribute('role');
    const ariaLive = await statusEl.getAttribute('aria-live');
    assert(role === 'status', `item 6: the success panel exposes role="status" for accessible announcement (got "${role}")`);
    assert(ariaLive === 'polite', `item 6: the success panel exposes aria-live="polite" (got "${ariaLive}")`);
  });

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
