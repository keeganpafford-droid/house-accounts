// Founder QA, two confirmed outreach-state bugs (BrightPath Learning):
//
// 1) First-open hydration bug: the very first time Prepare for Call opened
//    for a genuinely never-outreached opportunity, the outreach row already
//    showed "Reached out ✓" plus an "I reached out" button -- a hybrid that
//    matches NEITHER of wireOutreachRow()'s three defined states (INITIAL/
//    DRAFT/SAVED).
// 2) Draft-state duplicate CTA: after clicking "I reached out", the draft
//    form opened correctly (textarea + Save/Cancel), but the original
//    "I reached out" button remained visible underneath it.
//
// Root cause for BOTH, confirmed by inspecting the actual persisted
// ha_signal_events rows for BrightPath Learning's Apparel Repeat Pattern
// opportunity (Supabase project zodtymrckbtbiomakupf) and by direct CSS
// review -- NOT a server-side event-model problem, NOT event-type
// misclassification, NOT history leaking from another opportunity instance
// (every row for that account belongs to the SAME opportunity_id), and NOT
// a JS logic bug (wireOutreachRow()'s renderInitial()/renderDraft()/
// renderSaved() correctly set statusEl.hidden/logBtn.hidden the whole time).
// It is a pure CSS cascade defect: dashboard/index.html sets
// `.sales-play-outreach-row .outreach-status{display:inline-block}` and the
// shared `.btn{display:inline-block}` (inherited by .outreach-log-btn) --
// both AUTHOR rules at specificity 0-1-0, the SAME specificity as the
// browser's OWN `[hidden]{display:none}` user-agent rule. An author rule
// beats a UA rule at equal specificity regardless of source order, so the
// `hidden` attribute wireOutreachRow() was setting correctly the whole time
// was silently ineffective for exactly these two elements. Same root cause,
// same fix, same class of defect scripts/test-help-dropdown-visibility.js
// already proved for the Help dropdown -- neither a vm-sandboxed fake DOM
// nor a source-string assertion can detect a CSS cascade defect; only a
// real browser's computed style can.
//
// Fix: two scoped `[hidden]{display:none}` overrides
// (.sales-play-outreach-row .outreach-status[hidden] and
// .sales-play-outreach-row .outreach-log-btn[hidden]) -- not a change to
// .btn or [hidden] generally, and no change to the event model, dedupe, or
// server-side logic at all.
//
// This file proves the REAL, unmodified wireOutreachRow()/hydrateOutreachRow()
// against the REAL, unmodified <style> block, in a real Chromium page, using
// getComputedStyle()/getBoundingClientRect() -- exactly the only kind of
// check that can catch or prove a fix for this class of defect.
//
// Usage: node scripts/test-outreach-row-hidden-state-css.js
// Prerequisite: same as test-help-dropdown-visibility.js (playwright +
// Chromium; see that file's own header comment for setup/CI notes).
import { writeFileSync, mkdtempSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { chromium } from 'playwright';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

// The real, unmodified <style> block, verbatim -- includes .btn, .sales-play-outreach-row,
// .outreach-status, .outreach-log-btn, .approach-note-* and everything else,
// exactly as production serves it. Extracting the whole block (rather than
// cherry-picking rules) is deliberate: cherry-picking is exactly how a
// cross-rule cascade interaction like this one goes unnoticed.
const styleStart = DASHBOARD_SRC.indexOf('<style>');
const styleEnd = DASHBOARD_SRC.indexOf('</style>');
if(styleStart === -1 || styleEnd === -1) throw new Error('Could not locate <style>...</style> in dashboard/index.html');
const DASHBOARD_CSS = DASHBOARD_SRC.slice(styleStart + '<style>'.length, styleEnd);

const JS_SRC = [
  extractFn(DASHBOARD_SRC, 'signalStateKey'),
  extractFn(DASHBOARD_SRC, 'generateClientEventId'),
  extractFn(DASHBOARD_SRC, 'logSignalEvent'),
  extractFn(DASHBOARD_SRC, 'fetchSignalEventStates'),
  extractFn(DASHBOARD_SRC, 'wireOutreachRow'),
  extractFn(DASHBOARD_SRC, 'hydrateOutreachRow'),
].join('\n\n');

// Verbatim copy of createSalesPlayPanel()'s outreach-row markup
// (dashboard/index.html, the IIFE building `.sales-play-outreach-row`) --
// one opportunity-family instance (data-outreach-opportunity-id, the
// BrightPath Learning shape) and one signal-family instance
// (data-outreach-signal-id), to also cover "existing Business Signal
// outreach behavior remains unchanged."
function outreachRowMarkup({ id, isOpportunity, fingerprint, accountName }){
  const attrs = isOpportunity
    ? `data-outreach-opportunity-id="opp-brightpath-apparel-1" data-outreach-template-key="repeat_pattern"`
    : `data-outreach-signal-id="sig-1"`;
  return `
    <div class="sales-play-outreach-row" id="${id}" ${attrs} data-outreach-fingerprint="${fingerprint}" data-account-name="${accountName}">
      <span class="outreach-status" hidden>Reached out ✓</span>
      <div class="approach-note-readonly" hidden></div>
      <div class="approach-note-wrap" hidden>
        <label class="approach-note-label">How did you approach this outreach?</label>
        <div class="approach-note-helper">Optional</div>
        <textarea class="approach-note-input" maxlength="500"></textarea>
        <button type="button" class="btn btn-ghost btn-mini approach-note-save" data-approach-save="1">Save outreach</button>
        <button type="button" class="btn btn-ghost btn-mini approach-note-cancel" data-approach-cancel="1">Cancel</button>
      </div>
      <button type="button" class="btn btn-ghost btn-mini outreach-log-btn" data-outreach-log="1">I reached out</button>
    </div>`;
}

const OPPORTUNITY_FINGERPRINT = 'opp:repeat_pattern:v1:brightpath learning|apparel|last:2025-08-16';
const OPPORTUNITY_ACCOUNT = 'BrightPath Learning';
const SIGNAL_FINGERPRINT = 'fp-signal-1';
const SIGNAL_ACCOUNT = 'Acme Co';

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${DASHBOARD_CSS}</style>
</head>
<body>
${outreachRowMarkup({ id: 'oppRow', isOpportunity: true, fingerprint: OPPORTUNITY_FINGERPRINT, accountName: OPPORTUNITY_ACCOUNT })}
${outreachRowMarkup({ id: 'signalRow', isOpportunity: false, fingerprint: SIGNAL_FINGERPRINT, accountName: SIGNAL_ACCOUNT })}
<script>
window.HouseAuth = { authHeadersAsync: async () => ({}) };
${JS_SRC}
window.__wireOutreachRow = wireOutreachRow;
window.__hydrateOutreachRow = hydrateOutreachRow;
</script>
</body></html>`;

function resolveChromiumExecutablePath(){
  const candidate = '/opt/pw-browsers/chromium';
  return existsSync(candidate) ? candidate : undefined;
}

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'ha-outreach-row-test-'));
const HARNESS_PATH = path.join(TMP_DIR, 'harness.html');
writeFileSync(HARNESS_PATH, PAGE_HTML);
const HARNESS_URL = 'file://' + HARNESS_PATH;

// getBackState: what /api/signal-events GET should return for the current
// scenario. saveResponse: what the POST should return. Both configurable
// per test via page.route(), matching test-help-dropdown-visibility.js's
// withPage() convention.
async function withPage({ getBackState = null, saveResponses = [] } = {}, run){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    let saveCallIndex = 0;
    await page.route('**/api/signal-events**', async (route) => {
      const req = route.request();
      if(req.method() === 'GET'){
        const states = getBackState || {};
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, states }) });
        return;
      }
      // POST -- Save outreach's outreach_made/opportunity_outreach_made and
      // approach_shared/opportunity_approach_shared calls, in order.
      const body = saveResponses[Math.min(saveCallIndex, saveResponses.length - 1)] || { id: `event-${saveCallIndex}` };
      saveCallIndex += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(HARNESS_URL, { waitUntil: 'load' });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function rowState(page, rowId){
  return page.evaluate((id) => {
    const row = document.getElementById(id);
    const statusEl = row.querySelector('.outreach-status');
    const logBtn = row.querySelector('.outreach-log-btn');
    const noteWrap = row.querySelector('.approach-note-wrap');
    const noteReadonly = row.querySelector('.approach-note-readonly');
    const cs = (el) => getComputedStyle(el);
    return {
      statusHiddenAttr: statusEl.hasAttribute('hidden'),
      statusDisplay: cs(statusEl).display,
      statusRectH: statusEl.getBoundingClientRect().height,
      logBtnHiddenAttr: logBtn.hasAttribute('hidden'),
      logBtnDisplay: cs(logBtn).display,
      logBtnRectH: logBtn.getBoundingClientRect().height,
      logBtnText: logBtn.textContent,
      noteWrapHiddenAttr: noteWrap.hasAttribute('hidden'),
      noteWrapDisplay: cs(noteWrap).display,
      noteReadonlyHiddenAttr: noteReadonly.hasAttribute('hidden'),
    };
  }, rowId);
}

function assertNotPainted(state, prefix, label){
  assert(state[`${prefix}HiddenAttr`] === true, `${label}: hidden attribute is present`);
  assert(state[`${prefix}Display`] === 'none', `${label}: computed display is "none" (got "${state[`${prefix}Display`]}")`);
  assert(state[`${prefix}RectH`] === 0, `${label}: rendered height is 0 -- no painted box (got ${state[`${prefix}RectH`]})`);
}
function assertPainted(state, prefix, label){
  assert(state[`${prefix}HiddenAttr`] === false, `${label}: hidden attribute is absent`);
  assert(state[`${prefix}Display`] !== 'none', `${label}: computed display is not "none" (got "${state[`${prefix}Display`]}")`);
  assert(state[`${prefix}RectH`] > 0, `${label}: rendered height is greater than 0 (got ${state[`${prefix}RectH`]})`);
}

async function main(){
  // ===========================================================================
  // REQUIRED test 1 (founder QA item 1): a first-ever Prepare for Call, with
  // NO outreach event on the server, must NOT show "Reached out ✓" -- and
  // the "I reached out" button must be the only thing visibly painted.
  // ===========================================================================
  await withPage({ getBackState: {} }, async (page) => {
    await page.evaluate(() => { window.__wireOutreachRow(document.getElementById('oppRow')); window.__hydrateOutreachRow(document.getElementById('oppRow')); });
    await page.waitForTimeout(50); // let the fire-and-forget hydrate GET resolve
    const state = await rowState(page, 'oppRow');
    assertNotPainted(state, 'status', 'REQUIRED test 1 (first-ever open, no outreach event anywhere)');
    assertPainted(state, 'logBtn', 'sanity (first-ever open): "I reached out" is the one visible action');
    assert(state.logBtnText.trim() === 'I reached out', `sanity: button reads "I reached out" on first open (got "${state.logBtnText.trim()}")`);
  });

  // ===========================================================================
  // REQUIRED test 2: opening/saving prepare_call_opened or opportunity_selected
  // cannot create outreach state -- the server having `selected:true` (an
  // opportunity_selected already logged) but outreachLogged:false must still
  // render as the clean INITIAL state, never "Reached out ✓".
  // ===========================================================================
  await withPage({ getBackState: { [`${OPPORTUNITY_FINGERPRINT}::${OPPORTUNITY_ACCOUNT}`]: { feedback: null, selected: true, outreachLogged: false, latestOutreachEventId: null, approachNote: null } } }, async (page) => {
    await page.evaluate(() => { window.__wireOutreachRow(document.getElementById('oppRow')); window.__hydrateOutreachRow(document.getElementById('oppRow')); });
    await page.waitForTimeout(50);
    const state = await rowState(page, 'oppRow');
    assertNotPainted(state, 'status', 'REQUIRED test 2 (opportunity_selected exists, but no outreach)');
    assertPainted(state, 'logBtn', 'sanity (selected but not outreached): "I reached out" is still the visible action');
  });

  // ===========================================================================
  // REQUIRED test 3 (founder QA item 2): clicking "I reached out" opens the
  // draft (textarea + Save + Cancel) and the original "I reached out" CTA
  // must NOT remain visibly painted underneath it.
  // ===========================================================================
  await withPage({ getBackState: {} }, async (page) => {
    await page.evaluate(() => window.__wireOutreachRow(document.getElementById('oppRow')));
    await page.click('#oppRow .outreach-log-btn');
    const state = await rowState(page, 'oppRow');
    assertNotPainted(state, 'logBtn', 'REQUIRED test 3 (draft state): the original "I reached out" CTA is not painted -- no duplicate button');
    assert(state.noteWrapHiddenAttr === false, 'sanity (draft state): the note form is shown');
    assertNotPainted(state, 'status', 'sanity (draft state): "Reached out ✓" is not shown while drafting');
  });

  // ===========================================================================
  // REQUIRED test 4: saved state remains read-only and exposes "Log another
  // outreach" -- after Save Outreach resolves, the row shows "Reached out ✓"
  // and the button relabels (this is the ONLY legitimate way to reach that
  // state -- an explicit Save, never merely opening the draft).
  // ===========================================================================
  await withPage({ getBackState: {}, saveResponses: [{ id: 'evt-outreach-real-1' }] }, async (page) => {
    await page.evaluate(() => window.__wireOutreachRow(document.getElementById('oppRow')));
    await page.click('#oppRow .outreach-log-btn');
    await page.click('#oppRow .approach-note-save');
    await page.waitForTimeout(50);
    const state = await rowState(page, 'oppRow');
    assertPainted(state, 'status', 'REQUIRED test 4 (saved state): "Reached out ✓" is genuinely visible');
    assert(state.noteWrapHiddenAttr === true, 'sanity (saved state): the draft form closes after saving');
    assert(state.logBtnText.trim() === 'Log another outreach', `REQUIRED test 4: the button relabels to "Log another outreach" (got "${state.logBtnText.trim()}")`);
  });

  // ===========================================================================
  // REQUIRED test 5: existing Business Signal (signal_*, not opportunity_*)
  // outreach behavior is unaffected by the CSS fix -- same shared row/CSS,
  // same proof.
  // ===========================================================================
  await withPage({ getBackState: {} }, async (page) => {
    await page.evaluate(() => { window.__wireOutreachRow(document.getElementById('signalRow')); window.__hydrateOutreachRow(document.getElementById('signalRow')); });
    await page.waitForTimeout(50);
    const state = await rowState(page, 'signalRow');
    assertNotPainted(state, 'status', 'REQUIRED test 5 (Business Signal, first-ever open): "Reached out ✓" is not shown');
    assertPainted(state, 'logBtn', 'REQUIRED test 5 (Business Signal): "I reached out" is visible');
  });
  await withPage({ getBackState: {} }, async (page) => {
    await page.evaluate(() => window.__wireOutreachRow(document.getElementById('signalRow')));
    await page.click('#signalRow .outreach-log-btn');
    const state = await rowState(page, 'signalRow');
    assertNotPainted(state, 'logBtn', 'REQUIRED test 5 (Business Signal, draft state): no duplicate "I reached out" CTA');
  });

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
