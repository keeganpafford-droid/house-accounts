// Founder QA: after Save Outreach succeeds (confirmed: Prepare for Call
// hydrates the saved/read-only state correctly, note persists, "Log another
// outreach" appears), the PRIMARY DASHBOARD CARD still never showed
// "Reached out ✓" -- not immediately after save, and not after a full page
// refresh. This rules out a local post-save re-render bug (a full refresh
// re-fetches everything from scratch) and points at a genuine read-back
// asymmetry between the modal's hydration path and the card grid's.
//
// Root cause, confirmed by inspecting the real persisted ha_signal_events
// rows for BrightPath Learning's Apparel Repeat Pattern opportunity
// (Supabase project zodtymrckbtbiomakupf: opportunity_outreach_made exists,
// correct opportunity_id) and tracing the client call graph:
// hydrateSignalFeedbackButtons() -- the ONE function that reads
// /api/signal-events and reveals the "Used ✓"/"Reached out ✓" badges -- was
// called for the research-signal panel, the "Your Accounts" detail section,
// and a modal backdrop, but NEVER for the primary priorities grid
// (#opportunitiesGrid). createSalesPlayPanel() explicitly calls
// wireOutreachRow()/hydrateOutreachRow() at modal-open time, which is why
// the modal correctly hydrates; renderWeeklyPrioritiesFeed() (the function
// that builds every primary card) had no equivalent call anywhere in its
// own body or either of its two real callers (refreshOpportunityViews(),
// processData()'s own direct pre-aggregate render). /api/get-dashboard.js
// never queries ha_signal_events at all -- by design, hydration state was
// always meant to be a separate client-side pass, and that pass simply
// never ran against this grid.
//
// Fix: renderWeeklyPrioritiesFeed() now calls hydrateSignalFeedbackButtons(grid)
// right after building the grid's HTML -- the one place that covers both
// real callers.
//
// This file proves the fix against the REAL persisted-event -> dashboard
// read-back -> card hydration path end to end, NOT a fixture that injects
// outreachLogged:true directly:
//   1. A real Chromium page runs the REAL, extracted renderWeeklyPrioritiesFeed()/
//      refreshOpportunityViews()/hydrateSignalFeedbackButtons()/
//      fetchSignalEventStates() (dashboard/index.html) -- genuine DOM,
//      genuine hidden-attribute state, not a hand-rolled DOM mock.
//   2. The page's actual GET /api/signal-events network request is
//      intercepted (Playwright route) and answered by calling the REAL,
//      unmodified server handler (api/signal-events.js) against a mocked
//      Supabase REST layer holding a REAL opportunity_outreach_made row --
//      written by that SAME real handler via a real POST before the page
//      ever loads, exactly like a genuine "Save Outreach" followed by a
//      full page refresh.
//   3. Assertions read the real DOM.
//
// Usage: node scripts/test-dashboard-card-outreach-hydration.js
// Prerequisite: same as test-help-dropdown-visibility.js (playwright + Chromium).
import { writeFileSync, mkdtempSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { chromium } from 'playwright';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';
import handler from '../api/signal-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Mocked Supabase REST layer for the REAL server handler -- same convention
// as scripts/test-opportunity-events.js.
// ===========================================================================
function jsonResponse(data, ok = true, status = 200){
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function makeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}
function makeReq({ method = 'POST', token = 'valid-token-a1', body, query } = {}){
  return { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body, query };
}
function parseQuery(url){
  const qIndex = url.indexOf('?');
  const query = qIndex === -1 ? '' : url.slice(qIndex + 1);
  const params = new URLSearchParams(query);
  const filters = {};
  for(const [key, value] of params.entries()){
    if(key === 'select' || key === 'order' || key === 'limit') continue;
    filters[key] = value;
  }
  return { params, filters };
}
function matchValue(rowValue, filterValue){
  if(filterValue.startsWith('eq.')) return String(rowValue ?? '') === decodeURIComponent(filterValue.slice(3));
  if(filterValue.startsWith('in.(')){
    const inner = filterValue.slice(4, -1);
    const values = inner.split(',').map(v => decodeURIComponent(v.replace(/^"|"$/g, '')));
    return values.includes(String(rowValue ?? ''));
  }
  return true;
}
function filterRows(rows, filters){
  return rows.filter(row => Object.entries(filters).every(([key, value]) => matchValue(row[key], value)));
}
function applyOrderLimit(rows, params){
  let out = [...rows];
  const order = params.get('order');
  if(order){
    const [field, dir] = order.split('.');
    out.sort((a, b) => {
      if(a[field] === b[field]) return 0;
      return (a[field] > b[field] ? 1 : -1) * (dir === 'desc' ? -1 : 1);
    });
  }
  const limit = params.get('limit');
  if(limit) out = out.slice(0, Number(limit));
  return out;
}

const ACCOUNT_NAME = 'BrightPath Learning';
const OPPORTUNITY_ID = 'opp-brightpath-apparel-1';
const OPPORTUNITY_FINGERPRINT = 'opp:repeat_pattern:v1:brightpath learning|apparel|last:2025-08-16';

function baseState(){
  return {
    nextEventId: 1,
    authUsers: new Map([['valid-token-a1', { id: 'auth-a1', email: 'rep@example.com' }]]),
    haUsers: [{ id: 'user-a1', auth_user_id: 'auth-a1', email: 'rep@example.com', organization_id: 'org-a' }],
    haAccountOpportunities: [
      { id: OPPORTUNITY_ID, user_id: 'user-a1', account_name: ACCOUNT_NAME, opportunity_type: 'repeat_pattern', category: 'Apparel', fingerprint: OPPORTUNITY_FINGERPRINT, status: 'active' }
    ],
    haSignalEvents: []
  };
}
function makeMockFetch(state){
  return async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if(u.includes('/auth/v1/user')){
      const token = String((options.headers || {}).Authorization || '').replace(/^Bearer\s+/, '');
      const authUser = state.authUsers.get(token);
      if(!authUser) return jsonResponse(null, false, 401);
      return jsonResponse(authUser);
    }
    const { filters, params } = parseQuery(u);
    if(u.includes('/rest/v1/ha_users')) return jsonResponse(applyOrderLimit(filterRows(state.haUsers, filters), params));
    if(u.includes('/rest/v1/ha_account_opportunities')) return jsonResponse(applyOrderLimit(filterRows(state.haAccountOpportunities, filters), params));
    if(u.includes('/rest/v1/ha_signal_events')){
      if(method === 'POST'){
        const body = JSON.parse(options.body);
        const inserted = body.map(row => {
          const full = { id: `event-${state.nextEventId++}`, created_at: new Date(Date.now() + state.nextEventId).toISOString(), ...row };
          state.haSignalEvents.push(full);
          return full;
        });
        return jsonResponse(inserted);
      }
      return jsonResponse(applyOrderLimit(filterRows(state.haSignalEvents, filters), params));
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
}
async function withState(fn){
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  const state = baseState();
  const realFetch = global.fetch;
  global.fetch = makeMockFetch(state);
  try{ return await fn(state); }
  finally{ global.fetch = realFetch; }
}

// ===========================================================================
// Browser harness: the REAL, extracted render/hydration chain.
// ===========================================================================
const DASHBOARD_SRC = loadDashboardSource();
function fn(name){ return extractFn(DASHBOARD_SRC, name); }
const REAL_SOURCE = [
  fn('normalizeSavedAccount'), fn('dedupeOpportunities'), fn('opportunityDedupeKey'),
  fn('buyingOpportunityIdentity'), fn('cleanOpportunityToken'),
  fn('mergeBusinessSignalInitiatives'), fn('clusterBusinessSignalOpportunities'),
  fn('isWebResearchSignal'), fn('signalLayerLabel'), fn('normalizeSignalLayerType'),
  fn('isRecentAccountActivity'), fn('assignOpportunityScore'), fn('getOpportunityScore'),
  fn('currentOrgPreferences'), fn('ORG_PREFERENCE_FAMILY_BY_SIGNAL_LAYER'), fn('getOrgPreferenceAdjustmentForOpportunity'),
  fn('calculateOpportunityScore'), fn('normalizedConfidenceValue'), fn('scoreFromFreshness'),
  fn('evidenceCount'), fn('getOpportunityPlanningWindow'), fn('classifyMonthWindow'),
  fn('inferPurchaseMonth'), fn('monthIndexFromName'), fn('monthDistanceFromNow'),
  fn('getRecommendationType'), fn('isRelationshipExpansionOpportunity'), fn('clampScore'),
  fn('sortDailyReasons'), fn('getDailyReasonScore'),
  fn('collapseDuplicateAccountHistorySignals'), fn('collapseDuplicateFollowUps'),
  fn('collapseDuplicateGenericRepeatSignals'), fn('followUpCollapseKey'),
  fn('genericRepeatCollapseKey'), fn('primaryCategoryFromOpportunity'),
  fn('priorityEligibleOpportunities'), fn('isPriorityEligibleOpportunity'),
  fn('hasConfirmedOrLegacyIdentity'), fn('hasCredibleActivationPlay'),
  fn('hasStrongStandaloneSignal'), fn('isPossibleMatchIdentity'), fn('isRoutineFinancialNoise'),
  fn('daysSinceDate'), fn('limitReasonsPerAccount'), fn('prepareAllOpportunities'),
  fn('prepareTimeboxReasons'), fn('opportunityMatchesTimebox'), fn('TIMEBOX_CONFIG'),
  fn('renderWeeklyPrioritiesFeed'), fn('renderRepOpportunityCard'),
  fn('renderAccountHistoryOpportunityFeedback'), fn('renderPrepareForCallButton'),
  fn('escapeHtml'), fn('refreshOpportunityViews'), fn('feedSummary'),
  fn('hydrateSignalFeedbackButtons'), fn('fetchSignalEventStates'), fn('signalStateKey'),
].join('\n\n');

const STUB_SOURCE = `
function renderDetailedAccountViews(){}
function applyFreeCompanyLocksToCustomerAccounts(accounts){ return accounts; }
function calculateRevenueContext(){ return {historicalRevenue:0, historicalOpps:0, newBusinessOpps:0, totalReasons:0}; }
function renderResearchDiagnostics(){}
function renderRecentlyResearchedSection(){}
function recommendationBadgeMeta(o){ return {label:'Reach Out', cls:'', icon:''}; }
function mailtoHref(email){ return email ? ('mailto:' + email) : ''; }
function renderOpportunitySection(o){ return ''; }
function renderActivationIdeasSection(o, n){ return ''; }
function signalDateAndActionabilityLine(o){ return 'Recent'; }
function renderSuggestedContactCompact(o){ return ''; }
function getSuggestedOpener(o){ return 'opener'; }
function lockedAccountMessageHtml(){ return ''; }
function opportunityHeadline(o){ return o.opportunity || o.opportunityName || 'Opportunity'; }
function likelyDepartmentFromOpportunity(o){ return o.department || ''; }
function departmentFromText(t){ return t || ''; }
function likelyKnownBuyer(o){ return o.buyer || o.contact || ''; }
function likelySuggestedContact(o){ return o.suggestedContact || ''; }
function dedupeFoundSignals(signals){ return signals || []; }
function fmtMoney(n){ return String(n); }
function pluralize(n, s, p){ return n + ' ' + (n === 1 ? s : (p || s + 's')); }
function toggleWeeklyPrioritiesView(){}
var activeTimebox = 'week';
var showAllWeeklyPriorities = false;
window.HouseAuth = { authHeadersAsync: async () => ({ Authorization: 'Bearer valid-token-a1' }) };
`;

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
<div id="opportunitiesGrid"></div>
<div id="resultCount"></div>
<div id="totalAccounts"></div>
<div id="totalOppValue"></div>
<div id="highConfidenceCount"></div>
<div id="avgConfidence"></div>
<div id="timeboxSectionHeader"></div>
<div id="timeboxHelper"></div>
<script>
${STUB_SOURCE}
${REAL_SOURCE}
window.__refreshOpportunityViews = refreshOpportunityViews;
window.__normalizeSavedAccount = normalizeSavedAccount;
</script>
</body></html>`;

function resolveChromiumExecutablePath(){
  const candidate = '/opt/pw-browsers/chromium';
  return existsSync(candidate) ? candidate : undefined;
}
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'ha-dashboard-card-outreach-hydration-'));
const HARNESS_PATH = path.join(TMP_DIR, 'harness.html');
writeFileSync(HARNESS_PATH, PAGE_HTML);
const HARNESS_URL = 'file://' + HARNESS_PATH;

function makeAccount(){
  return {
    name: ACCOUNT_NAME, uploadId: 'upload-1', accountHistoryOpportunityRefs: null,
    monitoringStatus: 'active', industry: 'General Business', contactName: 'Contact 1', contactEmail: 'buyer@brightpath.example',
    revenue: 40000, orderCount: 3, confidence: 74, relationshipStrength: 86, mostRecentDate: '2025-08-16',
    activePipelineValue: 0, activePipelineCount: 0, subscores: { revenue: 0.4, frequency: 0.3, recency: 0.3, diversity: 0.5 },
    purchases: [], projects: [], allProjects: [], activePipeline: [], categoryTypes: [], signals: [],
    futureOpportunities: [{
      account: ACCOUNT_NAME, contact: 'Contact 1', years: [2025], category: 'Apparel',
      evidence: ['2 apparel orders found'], industry: 'General Business', confidence: 74,
      department: 'HR / People', signalDate: '2025-08-16', opportunity: 'Apparel Program',
      templateKey: 'repeat_pattern', whyNowScore: 87, contactEmail: 'buyer@brightpath.example',
      contactTitle: 'Marketing Manager', purchaseMonth: 7, quickWinScore: 74, accountRevenue: 40000,
      buyingCategory: 'Apparel', estimatedValue: 11000, mostRecentDate: '2025-08-16', planningWindow: 'week',
      businessSignals: [], opportunityName: 'Apparel Program', opportunityType: 'REPEAT PATTERN',
      signalLayerType: 'Repeat / Pattern Signal', closeProbability: 74, opportunityScore: 87,
      reasonToReachOut: 'Apparel Program may be coming up again', relationshipStrength: 86,
      accountDiversityScore: 1, accountFrequencyScore: 0.5,
      conversationStarter: 'Ask if the apparel program is happening again this year.', historicalPurchaseData: [],
      // The exact real refs api/get-dashboard.js's stampAccountHistoryOpportunityRefs()
      // would have stamped, matching the real ha_account_opportunities row.
      accountOpportunityId: OPPORTUNITY_ID, accountOpportunityFingerprint: OPPORTUNITY_FINGERPRINT
    }]
  };
}

async function runScenario({ token = 'valid-token-a1' } = {}){
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try{
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    // Bridges the page's real GET /api/signal-events network request to the
    // REAL server handler, run in THIS Node process against the mocked
    // Supabase REST layer -- not a canned response.
    await page.route('**/api/signal-events**', async (route) => {
      const req = route.request();
      if(req.method() !== 'GET'){ await route.abort(); return; }
      const url = new URL(req.url());
      const keys = url.searchParams.get('keys');
      const authHeader = req.headers()['authorization'] || '';
      const reqToken = authHeader.replace(/^Bearer\s+/, '');
      const handlerReq = makeReq({ method: 'GET', token: reqToken, query: { keys } });
      const handlerRes = makeRes();
      await handler(handlerReq, handlerRes);
      await route.fulfill({ status: handlerRes.statusCode, contentType: 'application/json', body: JSON.stringify(handlerRes.body) });
    });
    await page.goto(HARNESS_URL, { waitUntil: 'load' });
    await page.evaluate((account) => {
      const normalized = window.__normalizeSavedAccount(account);
      window.accountRadarAccounts = [normalized];
      window.__refreshOpportunityViews();
    }, makeAccount());
    // hydrateSignalFeedbackButtons() is fire-and-forget -- give its real GET
    // round trip (through the route above, into the real handler) a moment
    // to resolve, exactly like a real page load would.
    await page.waitForTimeout(150);
    return await page.evaluate(() => {
      const grid = document.getElementById('opportunitiesGrid');
      const outreachStatus = grid.querySelector('.opportunity-outreach-status');
      const usedStatus = grid.querySelector('.opportunity-used-status');
      return {
        gridHtmlIncludesAccount: grid.innerHTML.includes('BrightPath Learning'),
        outreachStatusExists: !!outreachStatus,
        outreachStatusHidden: outreachStatus ? outreachStatus.hasAttribute('hidden') : null,
        usedStatusExists: !!usedStatus,
        usedStatusHidden: usedStatus ? usedStatus.hasAttribute('hidden') : null,
      };
    });
  } finally {
    await browser.close();
  }
}

async function main(){
  // ===========================================================================
  // REQUIRED test: the real persisted-event -> dashboard read-back -> card
  // hydration path. A real POST opportunity_outreach_made against the real
  // handler (simulating "Save Outreach"), then a real page load
  // (normalizeSavedAccount + refreshOpportunityViews, exactly like a full
  // dashboard refresh) must reveal "Reached out ✓" on the exact originating card.
  // ===========================================================================
  await withState(async (state) => {
    const outreachRes = makeRes();
    await handler(makeReq({ body: { eventType: 'opportunity_outreach_made', opportunityId: OPPORTUNITY_ID, clientEventId: 'c-outreach-1' } }), outreachRes);
    assert(outreachRes.statusCode === 200 && !!outreachRes.body?.id, `sanity: the real handler accepted the opportunity_outreach_made POST (status ${outreachRes.statusCode})`);
    const persisted = state.haSignalEvents.find(r => r.id === outreachRes.body.id);
    assert(persisted?.event_type === 'opportunity_outreach_made' && persisted?.opportunity_id === OPPORTUNITY_ID, 'sanity: the real row was actually persisted against the correct opportunity_id');

    const result = await runScenario();
    assert(result.gridHtmlIncludesAccount, 'sanity: the card actually rendered');
    assert(result.outreachStatusExists, 'sanity: the "Reached out ✓" badge markup exists on the card');
    assert(result.outreachStatusHidden === false, 'REQUIRED (founder QA): a real, persisted opportunity_outreach_made event hydrates "Reached out ✓" on the primary dashboard card after a full page load -- not a fixture, the real GET round trip through the real server handler');
  });

  // ===========================================================================
  // REQUIRED: prepare_call_opened + opportunity_selected alone (no real
  // outreach event) must still leave the card's "Reached out ✓" hidden,
  // through this SAME real end-to-end path -- "Used ✓" hydrating proves
  // hydration genuinely ran (not that it silently no-op'd).
  // ===========================================================================
  await withState(async () => {
    await handler(makeReq({ body: { eventType: 'prepare_call_opened', opportunityId: OPPORTUNITY_ID, clientEventId: 'c-open-1' } }), makeRes());
    await handler(makeReq({ body: { eventType: 'opportunity_selected', opportunityId: OPPORTUNITY_ID, clientEventId: 'c-select-1' } }), makeRes());

    const result = await runScenario();
    assert(result.usedStatusHidden === false, 'sanity: "Used ✓" DOES hydrate (a real opportunity_selected exists) -- proves hydration genuinely ran');
    assert(result.outreachStatusHidden === true, 'REQUIRED (founder QA): prepare_call_opened + opportunity_selected alone must NEVER reveal "Reached out ✓" on the card, even through the real end-to-end path');
  });

  // ===========================================================================
  // REQUIRED: no events at all (a genuinely never-opened opportunity
  // instance) starts clean.
  // ===========================================================================
  await withState(async () => {
    const result = await runScenario();
    assert(result.outreachStatusHidden === true, 'REQUIRED: a never-opened opportunity instance never shows "Reached out ✓"');
    assert(result.usedStatusHidden === true, 'sanity: a never-opened opportunity instance never shows "Used ✓" either');
  });

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
