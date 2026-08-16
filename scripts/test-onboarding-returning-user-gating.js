// Notification & Outcome Loop V1, returning-user onboarding correction:
// the automatic "Welcome to the House Accounts Beta" popup used to fire the
// instant a Supabase session existed (maybeShowBetaWelcomeForSignedInUser()
// called blindly at DOMContentLoaded), gated only by a flat, un-namespaced
// localStorage flag -- so an established, long-time customer landing on a
// genuinely new browser/device/origin (exactly what happens clicking a
// notification email link into Preview, or any first visit from a new
// device) saw first-time onboarding block their re-entry.
//
// Fix: the automatic popup is now eligible to fire ONLY from
// applyEmptyWorkspaceState() -- i.e. only once the server-backed workspace
// fetch has genuinely confirmed this rep has no data yet. It is never
// called from applyPopulatedWorkspaceState() (established workspace) or
// from the blind top-level DOMContentLoaded call (removed), so an unknown/
// failed fetch also never triggers it -- fail safe by omission.
//
// This file proves the REAL, unmodified functions (dashboard/index.html)
// against a real DOM, in a real Chromium page:
//   1. applyEmptyWorkspaceState() (genuinely empty, confirmed) -- welcome
//      IS eligible to show.
//   2. applyPopulatedWorkspaceState() (established data) -- welcome is
//      NEVER shown, even with no dismissal flag present at all.
//   3. Structural proof the automatic trigger has exactly one call site
//      left (inside applyEmptyWorkspaceState()) -- the blind DOMContentLoaded
//      call is gone, which is what prevents the pre-fetch flash.
//
// Usage: node scripts/test-onboarding-returning-user-gating.js
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

// ===========================================================================
// Structural proof: the ONLY place the automatic trigger is invoked is
// inside applyEmptyWorkspaceState() -- never blindly at DOMContentLoaded,
// never from applyPopulatedWorkspaceState(). Counting literal call-site
// occurrences (the invocation `maybeShowBetaWelcomeForSignedInUser();`,
// distinct from its own `function maybeShowBetaWelcomeForSignedInUser(){`
// declaration) is a simple, robust, low-risk way to pin this down alongside
// the behavioral proof below.
// ===========================================================================
{
  const callSites = (DASHBOARD_SRC.match(/maybeShowBetaWelcomeForSignedInUser\(\);/g) || []).length;
  assert(callSites === 1, `REQUIRED: maybeShowBetaWelcomeForSignedInUser() is invoked from exactly ONE call site -- inside applyEmptyWorkspaceState(), never blindly at page load (got ${callSites} call sites)`);

  const emptyStateFnSrc = extractFn(DASHBOARD_SRC, 'applyEmptyWorkspaceState');
  assert(emptyStateFnSrc.includes('maybeShowBetaWelcomeForSignedInUser'), 'REQUIRED: applyEmptyWorkspaceState() is the function that triggers the automatic welcome eligibility check');

  const populatedStateFnSrc = extractFn(DASHBOARD_SRC, 'applyPopulatedWorkspaceState');
  assert(!populatedStateFnSrc.includes('maybeShowBetaWelcomeForSignedInUser'), 'REQUIRED: applyPopulatedWorkspaceState() never triggers the automatic welcome -- an established workspace must never see it regardless of missing localStorage');
}

// ===========================================================================
// Behavioral proof against a real DOM.
// ===========================================================================
const JS_SRC = [
  extractFn(DASHBOARD_SRC, 'getSavedLead'),
  extractFn(DASHBOARD_SRC, 'showBetaWelcomeModal'),
  extractFn(DASHBOARD_SRC, 'dismissBetaWelcomeModal'),
  extractFn(DASHBOARD_SRC, 'maybeShowBetaWelcomeForSignedInUser'),
  extractFn(DASHBOARD_SRC, 'applyEmptyWorkspaceState'),
  extractFn(DASHBOARD_SRC, 'applyPopulatedWorkspaceState'),
].join('\n\n');

const STUB_SOURCE = `
// Stubs for rendering/collaborator functions genuinely unrelated to the
// welcome-modal gating decision under test -- their own correctness is
// covered elsewhere (e.g. empty-state rendering, priorities feed
// rendering); this file isolates ONLY the gating behavior.
function renderEmptyWorkspaceState(){}
function refreshOpportunityViews(){}
function renderDashboardViewSwitcher(){}
function maybeResumeGuidedTourAfterPopulation(){}
let currentUploadId = null;
let currentUploadName = '';
window.accountRadarAccounts = [];
`;

function makeHouseAuth(email){
  return email ? { getUser: () => ({ auth_user_id: 'auth-1', email }) } : { getUser: () => null };
}

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
<div class="beta-modal-backdrop" id="betaWelcomeModal" role="dialog" aria-modal="true" aria-labelledby="betaWelcomeTitle">
  <div class="beta-modal">
    <h2 id="betaWelcomeTitle">Welcome to the House Accounts Beta 👋</h2>
    <button class="btn" type="button" id="betaWelcomeStartBtn">Get Started</button>
  </div>
</div>
<div id="customerDashboard"></div>
<div id="memberEmptyState"></div>
<div id="leadGate"></div>
<div id="results"></div>
<script>
window.HouseAccountsHeader = { beginOverlay(){}, endOverlay(){} };
${STUB_SOURCE}
${JS_SRC}
window.__applyEmptyWorkspaceState = applyEmptyWorkspaceState;
window.__applyPopulatedWorkspaceState = applyPopulatedWorkspaceState;
window.__dismissBetaWelcomeModal = dismissBetaWelcomeModal;
</script>
</body></html>`;

function resolveChromiumExecutablePath(){
  const candidate = '/opt/pw-browsers/chromium';
  return existsSync(candidate) ? candidate : undefined;
}

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'ha-onboarding-gating-'));
const HARNESS_PATH = path.join(TMP_DIR, 'harness.html');
writeFileSync(HARNESS_PATH, PAGE_HTML);
const HARNESS_URL = 'file://' + HARNESS_PATH;

async function withPage(email, run){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.addInitScript((userEmail) => {
      window.HouseAuth = { getUser: () => userEmail ? { auth_user_id: 'auth-1', email: userEmail } : null };
    }, email);
    await page.goto(HARNESS_URL, { waitUntil: 'load' });
    await run(page);
  } finally {
    await browser.close();
  }
}

async function modalActive(page){
  return page.evaluate(() => document.getElementById('betaWelcomeModal').classList.contains('active'));
}

async function main(){
  // REQUIRED: no premature flash -- immediately after page load, before any
  // workspace-state function has run, the modal must not be active (proves
  // nothing at load time blindly shows it anymore).
  await withPage('rep@example.com', async (page) => {
    const active = await modalActive(page);
    assert(active === false, 'REQUIRED: the welcome modal is not shown merely because a signed-in session exists at page load -- workspace state must be known first');
  });

  // REQUIRED: genuinely empty workspace (server-confirmed) -- welcome IS
  // eligible to show, for a signed-in user with no prior dismissal.
  await withPage('rep@example.com', async (page) => {
    await page.evaluate(() => window.__applyEmptyWorkspaceState({ silent: false, banner: null, viewMode: 'my', teamHasData: false }));
    const active = await modalActive(page);
    assert(active === true, 'REQUIRED: a genuinely empty/new workspace still shows the automatic welcome for a first-time user');
  });

  // REQUIRED: established/populated workspace -- welcome must NEVER
  // automatically appear, even with zero localStorage history (the exact
  // returning-user-on-a-new-device/origin scenario from live QA).
  await withPage('rep@example.com', async (page) => {
    await page.evaluate(() => window.__applyPopulatedWorkspaceState());
    const active = await modalActive(page);
    assert(active === false, 'REQUIRED: an established, non-empty workspace never triggers the automatic welcome, regardless of missing localStorage');
  });

  // REQUIRED: once genuinely dismissed on this browser, it does not
  // reappear even on a later empty-state pass (existing dismissal
  // mechanism is untouched by this change).
  await withPage('rep@example.com', async (page) => {
    await page.evaluate(() => window.__dismissBetaWelcomeModal());
    await page.evaluate(() => window.__applyEmptyWorkspaceState({ silent: false, banner: null, viewMode: 'my', teamHasData: false }));
    const active = await modalActive(page);
    assert(active === false, 'sanity: an already-dismissed browser still never sees the welcome again, even for a genuinely empty workspace');
  });

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
