// Product Cohesion Round 4 -- final last-mile corrections before the
// release-candidate founder smoke test, deterministic coverage for the
// parts of the founder's real-Preview QA list that a vm-sandbox extraction
// can prove directly (the real-browser routing/visual-affordance proof for
// items 1-3 lives in scripts/test-cohesion-navigation-live.js; this file
// covers item 3's feedSummary()/TIMEBOX_CONFIG source text, item 2's
// renderRepOpportunityCard() link structure, item 4's two toast call
// sites, and the item 1/2 link-affordance CSS rule's presence).
//
// Usage: node scripts/test-cohesion-round4-corrections-v1.js
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

// ===========================================================================
// Item 3: every timebox heading now reads "This [Horizon]'s Priorities" --
// the founder's normalization of what was four visibly different-sounding
// headings for the identical ranked-attention surface.
// ===========================================================================
{
  const TIMEBOX_CONFIG_SRC = extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG');
  const sandbox = { console };
  vm.createContext(sandbox);
  new vm.Script(`${TIMEBOX_CONFIG_SRC}\n\nthis.__exports = { TIMEBOX_CONFIG };`, { filename: 'round4-timebox-extract.js' }).runInContext(sandbox);
  const cfg = sandbox.__exports.TIMEBOX_CONFIG;
  assert(cfg.week.header === "This Week's Priorities", `REQUIRED: week header is "This Week's Priorities" (got "${cfg.week.header}")`);
  assert(cfg.month.header === "This Month's Priorities", `REQUIRED: month header is "This Month's Priorities" (got "${cfg.month.header}")`);
  assert(cfg.quarter.header === "This Quarter's Priorities", `REQUIRED: quarter header is "This Quarter's Priorities" (got "${cfg.quarter.header}")`);
  assert(cfg.annual.header === "This Year's Priorities", `REQUIRED: annual header is "This Year's Priorities" (got "${cfg.annual.header}")`);
  // Sanity: helper text (a different, un-scoped surface per the founder's
  // own "immediately associated summary-line nouns" framing) is untouched.
  assert(cfg.week.helper === "Who should I contact this week, and why?", 'sanity: week helper text is unchanged by this round');
}

// ===========================================================================
// Item 3: feedSummary()'s two renamed nouns -- "business trigger(s)" ->
// "business signal(s)", "reorder opportunity/-ies" -> "repeat buying
// pattern(s)" -- a bounded vocabulary correction, not a sweep of every
// "opportunity" occurrence. Classification logic itself is untouched.
// ===========================================================================
{
  const SRC = [
    extractFn(DASHBOARD_SRC, 'pluralize'),
    extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
    extractFn(DASHBOARD_SRC, 'signalLayerLabel'),
    extractFn(DASHBOARD_SRC, 'feedSummary')
  ].join('\n\n');
  const sandbox = { console };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { feedSummary };`, { filename: 'round4-feedsummary-extract.js' }).runInContext(sandbox);
  const { feedSummary } = sandbox.__exports;

  const businessOpp = { signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true };
  const repeatOpp = { signalLayerType: 'Repeat / Pattern Signal', opportunityType: 'REPEAT PATTERN' };
  const followUpOpp = { signalLayerType: 'Follow-Up Signal' };

  const summary = feedSummary([businessOpp, repeatOpp, repeatOpp, followUpOpp]);
  assert(/1 business signal\b/.test(summary), `REQUIRED: feedSummary() reads "1 business signal" (got "${summary}")`);
  assert(/2 repeat buying patterns\b/.test(summary), `REQUIRED: feedSummary() reads "2 repeat buying patterns" (got "${summary}")`);
  assert(!/business trigger/.test(summary), 'REQUIRED: the retired "business trigger" noun never appears');
  assert(!/reorder opportunit/.test(summary), 'REQUIRED: the retired "reorder opportunity/-ies" noun never appears');
}

// ===========================================================================
// Item 2: the Dashboard priority card's company name is a real link into
// Account Intelligence -- but ONLY the name, never the whole card. The
// locked-card variant renders plain text (paywalled cards get no link).
// ===========================================================================
{
  // Same verified-working extraction ranges as
  // scripts/test-commercial-intelligence-card-ux.js, which already
  // exercises renderRepOpportunityCard() end-to-end.
  const TIMEBOX_CONFIG_SRC = extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG');
  const IS_RELATIONSHIP_EXPANSION_SRC = extractFn(DASHBOARD_SRC, 'isRelationshipExpansionOpportunity');
  const DEDUPE_AND_IDENTITY_BLOCK = extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(', 'function isWebResearchSignal(opp){');
  const CARD_AND_MODAL_BLOCK = extractRange(DASHBOARD_SRC, 'function confidenceLabel(', 'function addSignalDerivedOpportunities(');
  const OPPORTUNITY_GENERATION_BLOCK = extractRange(DASHBOARD_SRC, 'function estimateFutureValue(account, opportunityType){', 'function getPriorityTier(');
  const SALES_PLAY_BLOCK = extractRange(DASHBOARD_SRC, 'function salesPlayModeFromOpp(', 'function renderPipelineTable(');
  const SCORING_AND_TIMEBOX_BLOCK = extractRange(DASHBOARD_SRC, 'function normalizeSignalLayerType(', 'function feedSummary(');
  const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
  const FMT_MONEY_SRC = extractFn(DASHBOARD_SRC, 'fmtMoney');
  const CLAMP_SCORE_SRC = extractFn(DASHBOARD_SRC, 'clampScore');
  const ACCOUNT_INTELLIGENCE_HREF_SRC = extractFn(DASHBOARD_SRC, 'accountIntelligenceHref');
  const NORMALIZE_COMPANY_NAME_FOR_LIMIT_SRC = extractFn(DASHBOARD_SRC, 'normalizeCompanyNameForLimit');
  const REASON_AND_STARTER_BLOCK = extractRange(DASHBOARD_SRC, 'function getReasonToReachOutTitle(opp){', 'function getConversationStarterText(');
  const DASHBOARD_USAGE_INFO_SRC = extractFn(DASHBOARD_SRC, 'dashboardUsageInfo');
  const SIGNAL_EVENTS_STUB_SOURCE = `
function logSignalEvent(){ return Promise.resolve(null); }
function generateClientEventId(){ return 'test-client-event-id'; }
function fetchSignalEventStates(){ return Promise.resolve({}); }
function hydrateSignalFeedbackButtons(){}
function wireOutreachRow(){}
function hydrateOutreachRow(){ return Promise.resolve(); }
function resolveSignalEventTarget(){ return null; }
function logOpportunityAwareEvent(){ return Promise.resolve(null); }
`;
  const SRC = [
    TIMEBOX_CONFIG_SRC, `let activeTimebox = 'week';`, `let showAllWeeklyPriorities = false;`, `let dashboardUsage = null;`,
    IS_RELATIONSHIP_EXPANSION_SRC, ESCAPE_HTML_SRC, FMT_MONEY_SRC, CLAMP_SCORE_SRC,
    ACCOUNT_INTELLIGENCE_HREF_SRC, NORMALIZE_COMPANY_NAME_FOR_LIMIT_SRC,
    DEDUPE_AND_IDENTITY_BLOCK, CARD_AND_MODAL_BLOCK, OPPORTUNITY_GENERATION_BLOCK,
    REASON_AND_STARTER_BLOCK, DASHBOARD_USAGE_INFO_SRC, SALES_PLAY_BLOCK, SCORING_AND_TIMEBOX_BLOCK, SIGNAL_EVENTS_STUB_SOURCE
  ].join('\n\n');
  const fakeModal = { querySelector: () => ({ focus(){} }), querySelectorAll: () => [] };
  const sandbox = {
    console,
    window: { addEventListener(){}, accountRadarAccounts: [], HouseAccountsHeader: { beginOverlay(){} } },
    document: {
      getElementById: () => ({ textContent: '', innerHTML: '', style: {} }),
      querySelectorAll: () => [],
      addEventListener(){},
      body: { insertAdjacentHTML(){}, get lastElementChild(){ return fakeModal; } }
    },
    isWarmAccount: () => false,
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { renderRepOpportunityCard };`, { filename: 'round4-card-extract.js' }).runInContext(sandbox);
  const { renderRepOpportunityCard } = sandbox.__exports;

  const opp = { account: 'Atlas Precision', signalTitle: 'Atlas Precision opens new facility', signalLayerType: 'Business Activity Signal' };
  const html = renderRepOpportunityCard(opp);
  const titleMatch = html.match(/<div class="opp-card-title">([\s\S]*?)<\/div>/);
  assert(!!titleMatch, 'sanity: the card renders an opp-card-title block');
  assert(/^<a href="[^"]*">Atlas Precision<\/a>$/.test((titleMatch && titleMatch[1] || '').trim()), `REQUIRED: the opp-card-title contains ONLY a link wrapping the company name, no extra markup (got "${titleMatch && titleMatch[1]}")`);
  assert(/<a href="#account=atlas%20precision">/.test(html), `REQUIRED: the link's href is the canonical accountIntelligenceHref() route (got href from: ${html.match(/<a href="[^"]*">Atlas Precision/)})`);
  assert(!/<div class="opportunity-card[^"]*"><a /.test(html), 'REQUIRED: the outer card container itself is never a link -- only the name is');

  const lockedHtml = renderRepOpportunityCard({ account: 'Locked Co', _locked: true });
  assert(/<div class="opp-card-title">Locked Co<\/div>/.test(lockedHtml), 'REQUIRED: a locked/paywalled card renders the company name as plain text, no link');
}

// ===========================================================================
// Item 4: both single-account research-completion toasts (Manage Customer
// Accounts' handleResearchClick() and the Dashboard card's own
// researchAccountFromCard()) now use signal-oriented CTA language and
// deep-link into Business Signals -- never the old "View opportunities" ->
// Prepare-for-Call/Verified-Opportunity handoff, which could fire even
// when no recommended play existed (the founder's "Atlas Precision"
// real-Preview repro).
// ===========================================================================
{
  const handleResearchClickSrc = extractFn(DASHBOARD_SRC, 'handleResearchClick');
  assert(/label: `View signal\$\{signalCount === 1 \? '' : 's'\} →`/.test(handleResearchClickSrc), 'REQUIRED: handleResearchClick()\'s toast CTA reads "View signal(s) ->"');
  assert(/deepLinkToAccountResearch\(accountName\)/.test(handleResearchClickSrc), 'REQUIRED: handleResearchClick()\'s toast action deep-links via deepLinkToAccountResearch(accountName)');
  assert(!/openResearchedAccountOpportunities/.test(handleResearchClickSrc), 'REQUIRED: handleResearchClick() no longer calls the old Prepare-for-Call/Verified-Opportunity handoff at all');

  const researchAccountFromCardSrc = extractFn(DASHBOARD_SRC, 'researchAccountFromCard');
  assert(/label: `View signal\$\{signalCount === 1 \? '' : 's'\} →`/.test(researchAccountFromCardSrc), 'REQUIRED: researchAccountFromCard()\'s toast CTA reads "View signal(s) ->"');
  assert(/deepLinkToAccountResearch\(accountName\)/.test(researchAccountFromCardSrc), 'REQUIRED: researchAccountFromCard()\'s toast action deep-links via deepLinkToAccountResearch(accountName)');
  assert(!/openResearchedAccountOpportunities/.test(researchAccountFromCardSrc), 'REQUIRED: researchAccountFromCard() no longer calls the old Prepare-for-Call/Verified-Opportunity handoff at all');

  // Preserve the important behavior: the CTA is gated purely on real
  // evidence (signalCount), never on whether a Reason to Reach Out/play
  // was manufactured -- research may find credible secondary evidence
  // without a recommended play existing.
  assert(/showToast\(toastMessage, signalCount \?/.test(handleResearchClickSrc), 'REQUIRED: handleResearchClick()\'s toast action is gated on signalCount alone, not on any manufactured play/reason');
  assert(/toastFn\(toastMessage, signalCount \?/.test(researchAccountFromCardSrc), 'REQUIRED: researchAccountFromCard()\'s toast action is gated on signalCount alone, not on any manufactured play/reason');

  // Cohesion round 4 correction #2 (founder real-Preview QA follow-up,
  // reproduced via a real click in a real browser): showToast() lives
  // entirely inside the Manage Customer Accounts modal's own IIFE.
  // handleResearchClick() is declared in that SAME IIFE, so its bare
  // `showToast` call always worked -- but researchAccountFromCard() is a
  // main-script function that called a bare `showToast` identifier that
  // does not exist in its scope chain. typeof of an out-of-scope
  // identifier safely returns 'undefined' rather than throwing, so this
  // failed completely silently: no error, no toast at all, ever, for the
  // "Research Account"/"Refresh Research" button on a Dashboard or
  // Account Intelligence card. Now routed through the same
  // window.HouseAccountManager export handleResearchClick()'s own modal
  // already uses for close()/showResearchResults().
  assert(!/(?<!\.)\bshowToast\(toastMessage/.test(researchAccountFromCardSrc), 'REQUIRED: researchAccountFromCard() never calls a bare, out-of-scope showToast() again');
  assert(/window\.HouseAccountManager && typeof window\.HouseAccountManager\.showToast === 'function'/.test(researchAccountFromCardSrc), 'REQUIRED: researchAccountFromCard() reaches the toast through window.HouseAccountManager.showToast, the one real implementation');
  assert(/showToast\(message, action, durationMs\){ return showToast\(message, action, durationMs\); }/.test(DASHBOARD_SRC), 'REQUIRED: window.HouseAccountManager exports showToast() so code outside the modal IIFE can reach it');

  // Founder real-Preview QA follow-up root cause: the toast's own
  // durationMs auto-dismiss (a fixed setTimeout tearing the button out of
  // the DOM) is what actually broke "View signal(s) ->" -- the toast text
  // rendered correctly, but by the time the founder clicked, the button no
  // longer existed. Both call sites now give a deliberate navigation
  // decision a longer window (15s, was 8s), and showToast() itself now
  // pauses/resumes the dismiss timer on hover/focus so a toast being
  // actively read or hovered can never expire out from under the user --
  // proven via a real, physical click in scripts/test-cohesion-navigation-live.js.
  assert(/\} : null, 15000\);/.test(handleResearchClickSrc), 'REQUIRED: handleResearchClick()\'s toast stays up 15s, not the old 8s window');
  assert(/\} : null, 15000\);/.test(researchAccountFromCardSrc), 'REQUIRED: researchAccountFromCard()\'s toast stays up 15s, not the old 8s window');
  const showToastSrc = extractFn(DASHBOARD_SRC, 'showToast');
  assert(/addEventListener\('mouseenter', pauseDismissTimer\)/.test(showToastSrc) && /addEventListener\('mouseleave', resumeDismissTimer\)/.test(showToastSrc), 'REQUIRED: showToast() pauses its auto-dismiss timer on hover and resumes it on mouseleave');
  assert(/addEventListener\('focusin', pauseDismissTimer\)/.test(showToastSrc) && /addEventListener\('focusout', resumeDismissTimer\)/.test(showToastSrc), 'REQUIRED: showToast() pauses its auto-dismiss timer on keyboard focus too, not just pointer hover');
}

// ===========================================================================
// Items 1/2: the account-name link CSS rule exists and covers both entry
// points (Manage Customer Accounts and the Dashboard priority card) with
// the same brand-consistent teal/green treatment -- proven directly on
// source text since jsdom cannot resolve a real CSS cascade the way the
// live-browser computed-style assertions in
// test-cohesion-navigation-live.js already do.
// ===========================================================================
{
  assert(/\.acct-mgr-name a, \.opp-card-title a\{[^}]*color:var\(--radar\)/.test(DASHBOARD_SRC), 'REQUIRED: both account-name link entry points share one CSS rule using the HA brand teal/green (--radar)');
  assert(/\.acct-mgr-name a:hover, \.opp-card-title a:hover\{[^}]*text-decoration:underline/.test(DASHBOARD_SRC), 'REQUIRED: both account-name link entry points underline on hover');
  assert(/\.acct-mgr-name a:focus-visible, \.opp-card-title a:focus-visible\{/.test(DASHBOARD_SRC), 'REQUIRED: both account-name link entry points keep a visible keyboard-focus outline');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
