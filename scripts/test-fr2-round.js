// FR2 round ("final narrow functional correction"): Help staying closed
// after the guided tour ends, duplicate-account-name-safe research identity
// and response parsing, eliminating the remaining post-upload single-list
// dashboard flash, and the zero/one/multiple-account list-research
// completion workflow. Extracts the REAL, verbatim source of the relevant
// dashboard/index.html functions by exact line range (same defensive
// pattern as every other extraction test in this repo -- a future edit that
// shifts these lines fails this test loudly instead of silently testing
// stale code).
//
// Usage: node scripts/test-fr2-round.js
import { readFileSync } from 'fs';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const dashboardHtml = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const dashboardLines = dashboardHtml.split('\n');

function extractLines(label, startLine, endLine, expectedFirst){
  const slice = dashboardLines.slice(startLine - 1, endLine);
  const first = slice[0].trim();
  if(!first.startsWith(expectedFirst)){
    throw new Error(`extractLines(${label}): dashboard/index.html line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  return slice.join('\n');
}

// ---------------------------------------------------------------------------
// Item 1: Help stays closed after the guided tour ends (Finish/Skip/Escape),
// and focus never returns to a Help-menu trigger.
// ---------------------------------------------------------------------------
const isHelpRelatedSrc = extractLines('isHelpRelatedGuidedTourTrigger', 4096, 4099, 'function isHelpRelatedGuidedTourTrigger(el){');
assert(
  /el\.id === 'haHelpToggle' \|\| Boolean\(el\.closest\('#haHelpDropdown, \.ha-help-dropdown'\)\)/.test(isHelpRelatedSrc),
  'isHelpRelatedGuidedTourTrigger() detects both the Help toggle button itself and anything inside the Help dropdown (e.g. the "Restart Product Tour" link)'
);

const launchGuidedTourSrc = extractLines('launchGuidedTour', 4101, 4134, 'function launchGuidedTour(){');
assert(
  /if\(window\.location\.hash === '#restart-tour'\)\{\s*const url = new URL\(window\.location\.href\);\s*url\.hash = '';\s*window\.history\.replaceState\(null, '', url\.pathname \+ url\.search\);\s*\}/.test(launchGuidedTourSrc),
  'required test 4 support: launchGuidedTour() consumes/clears the #restart-tour hash immediately, so a later hashchange (browser back/forward, another same-page hash link) cannot silently re-trigger the tour a second time'
);

const closeGuidedTourSrc = extractLines('closeGuidedTour', 4136, 4180, 'function closeGuidedTour(){');
assert(
  /const cameFromHelp = isHelpRelatedGuidedTourTrigger\(guidedTourTriggerEl\);/.test(closeGuidedTourSrc),
  'closeGuidedTour() determines whether the tour was launched from a Help-menu control before doing anything else'
);
assert(
  /if\(window\.HouseAccountsHeader && typeof window\.HouseAccountsHeader\.closeMenus === 'function'\)\{\s*window\.HouseAccountsHeader\.closeMenus\(\);\s*\}/.test(closeGuidedTourSrc),
  'required tests 1/2/3: closeGuidedTour() explicitly re-asserts the closed Help/mobile-nav menu state (via the shared closeMenus()) on every exit path (Finish, Skip, and Escape all funnel through this one function), not just relying on state set at tour start'
);
{
  const closeMenusCallIndex = closeGuidedTourSrc.indexOf('window.HouseAccountsHeader.closeMenus();');
  const neutralFocusIndex = closeGuidedTourSrc.indexOf("document.getElementById('mvpDashboardTitle')");
  assert(
    closeMenusCallIndex !== -1 && neutralFocusIndex !== -1 && closeMenusCallIndex < neutralFocusIndex,
    'menu-state cleanup happens before any focus is restored'
  );
}
assert(
  /if\(cameFromHelp\)\{[\s\S]{0,500}?const neutralTarget = document\.getElementById\('mvpDashboardTitle'\);[\s\S]{0,150}?neutralTarget\.focus\(\);/.test(closeGuidedTourSrc),
  'required test 4: when the tour was launched through a Help-menu control, focus is redirected to the neutral Dashboard heading instead of back to the Help trigger'
);
assert(
  /\} else if\(guidedTourTriggerEl && typeof guidedTourTriggerEl\.focus === 'function'\)\{\s*guidedTourTriggerEl\.focus\(\);\s*\}/.test(closeGuidedTourSrc),
  'a tour launched from anywhere else (e.g. the Welcome modal\'s "Get Started" button) still restores focus to its real trigger, unchanged -- accepted behavior is preserved'
);
assert(
  /if\(wasActive\)\{\s*requestAnimationFrame\(\(\) => \{\s*if\(window\.HouseAccountsHeader && typeof window\.HouseAccountsHeader\.closeMenus === 'function'\)\{\s*window\.HouseAccountsHeader\.closeMenus\(\);\s*\}\s*\}\);\s*\}/.test(closeGuidedTourSrc),
  'required tests 1/2/3 (event-ordering safety): after endOverlay() removes body.ha-overlay-open, a requestAnimationFrame repeats the same menu-state cleanup one more time, so no event fired during teardown can land after the CSS safety net is gone but before the underlying menu state is reasserted'
);
{
  const endOverlayIndex = closeGuidedTourSrc.indexOf('window.HouseAccountsHeader.endOverlay();');
  const rafIndex = closeGuidedTourSrc.indexOf('requestAnimationFrame(() => {');
  assert(
    endOverlayIndex !== -1 && rafIndex !== -1 && endOverlayIndex < rafIndex,
    'the requestAnimationFrame cleanup pass is scheduled AFTER endOverlay() runs, not before'
  );
}
assert(
  /h2 id="mvpDashboardTitle" tabindex="-1"/.test(dashboardHtml),
  'the neutral focus target (#mvpDashboardTitle) is programmatically focusable via tabindex="-1", preserving keyboard accessibility for the redirected focus'
);

// ---------------------------------------------------------------------------
// Item 2: duplicate-account-name-safe identity + safe (non-blind) response
// parsing for every account research call site.
// ---------------------------------------------------------------------------
const safeParseSrc = extractLines('safeParseResearchResponse', 6156, 6191, 'async function safeParseResearchResponse(res, context){');
assert(
  /const rawBody = await res\.text\(\);\s*let parsed = null;\s*try\{ parsed = JSON\.parse\(rawBody\); \}catch\(parseErr\)\{/.test(safeParseSrc),
  'required tests 7/8: safeParseResearchResponse() reads the body once as text and attempts JSON.parse itself -- it never calls response.json() blindly, so a non-JSON body can never surface a raw parser SyntaxError to the user'
);
assert(
  /const err = new Error\('Research could not be completed\. Please try again\.'\);/.test(safeParseSrc),
  'required test 7: a non-JSON response produces one concise branded error message, never the raw parser error or response body'
);
assert(
  /console\.error\('\[Research\] non-JSON response', \{[\s\S]{0,400}?httpStatus: res\.status,[\s\S]{0,120}?contentType,[\s\S]{0,120}?vercelId: vercelId \|\| null,[\s\S]{0,120}?uploadId:[\s\S]{0,120}?accountId:[\s\S]{0,120}?accountName:[\s\S]{0,120}?correlationId:[\s\S]{0,120}?bodyPreview/.test(safeParseSrc),
  'a non-JSON response is logged with endpoint, HTTP status, content-type, uploadId, accountId, accountName, correlation id, and a bounded body preview -- diagnosable without exposing the raw error to the user'
);
assert(
  /bodyPreview = rawBody\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.slice\(0, 300\);/.test(safeParseSrc),
  'the logged body preview is bounded to 300 characters, never the full response body'
);

const researchAccountModalSrc = extractLines('researchAccountFromManageModal', 6193, 6346, 'async function researchAccountFromManageModal(accountName, listId){');
assert(
  /const snapshot = await fetchUploadScopedSnapshot\(expectedUploadId\);/.test(researchAccountModalSrc) &&
  /const account = freshUploadScopedAccounts\.find\(a => a\.name === targetAccountName\);/.test(researchAccountModalSrc),
  'required tests 5/6: the account is looked up only within a snapshot already scoped to the EXACT selected upload/list ID -- two accounts named identically in different uploads can never resolve to the wrong one'
);
assert(
  /const data = await safeParseResearchResponse\(res, \{endpoint, uploadId: expectedUploadId, accountId: account\.id, accountName: account\.name\}\);/.test(researchAccountModalSrc),
  'required tests 7/8/9: the individual research call site uses the safe parser (never a blind response.json()), passing the exact uploadId/accountId/accountName identity for logging'
);
assert(
  !/const data = await res\.json\(\);/.test(researchAccountModalSrc),
  'no blind res.json() call remains in the individual research path'
);

const researchListModalSrc = extractLines('researchListFromManageModal', 6361, 6587, 'async function researchListFromManageModal(listId, options = {}){');
assert(
  !/const data = await res\.json\(\);/.test(researchListModalSrc),
  'no blind res.json() call remains in the list-level research path (neither the batched warm/mixed call nor the per-account historical loop)'
);
assert(
  /const data = await safeParseResearchResponse\(res, \{endpoint:'\/api\/research-batch', uploadId: expectedUploadId, accountName: `\$\{enhancedGroup\.length\} accounts`\}\);/.test(researchListModalSrc),
  'the batched warm/mixed research call uses the safe parser'
);
assert(
  /const data = await safeParseResearchResponse\(res, \{endpoint:'\/api\/research-account', uploadId: expectedUploadId, accountId: account\.id, accountName: account\.name\}\);/.test(researchListModalSrc),
  'required test 9: the per-account historical research loop uses the safe parser scoped to that exact account, and a parse failure is caught per-account (only incrementing failures) -- it never marks that account researched or persists its (nonexistent) signals'
);
// ux/research-control-progress: the catch block now also distinguishes a
// genuine failure from a user-requested Stop (AbortError) for progress/
// tracker purposes, but a non-stop failure still only increments
// `failures` -- it never touches account.signals/account.lastResearchedAt,
// preserving the original guarantee.
assert(
  /\}catch\(err\)\{\s*unregisterResearchAbort\(expectedUploadId, account\.name\);\s*if\(err && err\.name === 'AbortError'\)\{\s*stopped \+= 1;\s*markResearchAccountDone\(expectedUploadId, account\.name, \{stopped:true\}\);\s*\} else \{\s*failures \+= 1;\s*markResearchAccountDone\(expectedUploadId, account\.name, \{failed:true\}\);\s*\}\s*\}/.test(researchListModalSrc),
  'required test 8: a failed historical-account request in a list run is caught individually -- it does not mark account.signals/account.lastResearchedAt, and the account remains eligible for a manual Retry via the normal Research Again control afterward'
);
assert(
  /accountResults\.push\(\{uploadId: expectedUploadId, accountId: account\.id, accountName: account\.name, signalCount: account\.signals\.length, opportunityCount: \(account\.futureOpportunities \|\| \[\]\)\.length\}\);/.test(researchListModalSrc),
  'required test 17: every researched account\'s result is tracked with its full (uploadId, accountId, accountName) identity, preserving duplicate-name distinguishability into the completion workflow'
);
assert(
  /accountsWithOpportunities: accountResults\.filter\(a => a\.opportunityCount > 0\)/.test(researchListModalSrc),
  'the list run returns exactly the set of accounts that produced a real opportunity, distinct from the raw attempted/withSignals totals'
);

// ---------------------------------------------------------------------------
// Item 3: never render a single-upload dashboard snapshot after save.
// ---------------------------------------------------------------------------
const buildingPlaceholderSrc = extractLines('showBuildingDashboardPanelPlaceholder', 3617, 3628, 'function showBuildingDashboardPanelPlaceholder(){');
assert(
  /subtitle\.textContent = 'Building your dashboard…';/.test(buildingPlaceholderSrc),
  'required test 12: a neutral "Building your dashboard…" placeholder exists, showing no fabricated single-upload numbers'
);

const fetchAggregateSrc = extractLines('fetchAndRenderAggregateDashboard', 3669, 3774, "async function fetchAndRenderAggregateDashboard(email, {silent = false} = {}){");
assert(
  /aggregateDashboardEverLoaded = true;/.test(fetchAggregateSrc),
  'fetchAndRenderAggregateDashboard() marks that a real aggregate has successfully loaded once it renders one -- the single source of truth processData() reads to decide whether an aggregate is already safely on screen'
);

const processDataSrc = extractLines('processData', 10357, 10574, 'function processData(records){');
assert(
  /if\(!aggregateDashboardEverLoaded\)\{\s*\/\/ Render the focused recommendation feed\s*renderWeeklyPrioritiesFeed\(futureOpportunities, accounts, \{/.test(processDataSrc),
  'required test 10: processData() only writes this single upload\'s own accounts/opportunities into the main #results/priorities feed when no aggregate dashboard has ever loaded yet this session -- it never overwrites an existing aggregate with a single-upload snapshot'
);
assert(
  /if\(!aggregateDashboardEverLoaded\)\{\s*showBuildingDashboardPanelPlaceholder\(\);\s*\}/.test(processDataSrc),
  'required test 12: a true first upload shows the neutral placeholder instead of the old immediate single-upload accountCount/signalCount:0 snapshot'
);
assert(
  !/showCustomerDashboardPanel\(\{\s*subtitleText: `\$\{currentUploadName/.test(processDataSrc),
  'the old unconditional showCustomerDashboardPanel() call with single-upload-only numbers (accountCount: accounts.length of just this upload, signalCount: 0) has been removed from processData()'
);
assert(
  /renderUploadSuccessState\(records, accounts\);/.test(processDataSrc),
  'required test 11: the upload-success panel is still rendered and stays visible regardless of which branch above ran'
);
assert(
  /saveCurrentUpload\('uploaded'\)\.then\(async \(\) => \{\s*let refreshResult = null;\s*if\(typeof refreshAggregateDashboard === 'function'\) refreshResult = await refreshAggregateDashboard\(\);/.test(processDataSrc),
  'required test 10: the post-upload save chain awaits/tracks the aggregate refresh through the same production refreshAggregateDashboard() -> fetchAndRenderAggregateDashboard() path page load uses'
);
assert(
  /if\(refreshResult && !refreshResult\.ok && !aggregateDashboardEverLoaded\)\{\s*showDashboardRefreshRetryState\(\);\s*\}/.test(processDataSrc),
  'required test 13: a failed aggregate refresh on a true first upload (no prior aggregate to fall back to) shows a retryable, non-destructive failure state instead of leaving "Building your dashboard…" stuck forever; when a prior aggregate already exists, it is simply left untouched (nothing to retry into)'
);

const retryStateSrc = extractLines('showDashboardRefreshRetryState', 3635, 3655, 'function showDashboardRefreshRetryState(){');
assert(
  /retryBtn\.addEventListener\('click', async \(\) => \{\s*showBuildingDashboardPanelPlaceholder\(\);\s*const result = await refreshAggregateDashboard\(\);/.test(retryStateSrc),
  'required test 13: the failure state offers a real Retry action that re-attempts the same aggregate refresh, not just static text'
);

// ---------------------------------------------------------------------------
// Item 4: zero/one/multiple-account list-research completion workflow.
// ---------------------------------------------------------------------------
const handleListResearchClickSrc = extractLines('handleListResearchClick', 11258, 11370, 'async function handleListResearchClick(btn){');
assert(
  /const opportunityAccounts = Array\.isArray\(result\.accountsWithOpportunities\) \? result\.accountsWithOpportunities : \[\];/.test(handleListResearchClickSrc),
  'handleListResearchClick() branches on the exact set of accounts from this run that produced an opportunity'
);
assert(
  /if\(opportunityAccounts\.length === 0\)\{\s*statusEl\.append\(document\.createTextNode\(' No verified opportunities were found\.'\)\);\s*\}/.test(handleListResearchClickSrc),
  'required test 14: zero accounts with opportunities shows the completed run summary stating none were found, with no View Opportunities/Review Opportunities action rendered'
);
{
  const zeroBranch = handleListResearchClickSrc.split('if(opportunityAccounts.length === 0){')[1]?.split("} else if(opportunityAccounts.length === 1){")[0] || '';
  assert(
    !/HouseAccountManager\.close/.test(zeroBranch),
    'required test 14: the zero-opportunities branch never closes Manage Customer Accounts -- it stays open'
  );
}
assert(
  /\} else if\(opportunityAccounts\.length === 1\)\{\s*const only = opportunityAccounts\[0\];/.test(handleListResearchClickSrc),
  'exactly one account with opportunities is handled as its own distinct branch'
);
assert(
  /viewBtn\.textContent = 'View Opportunity';\s*viewBtn\.addEventListener\('click', \(\) => \{\s*if\(typeof openResearchedAccountOpportunities === 'function'\) openResearchedAccountOpportunities\(only\.uploadId, only\.accountName\);/.test(handleListResearchClickSrc),
  'required test 15: the single-result "View Opportunity" action opens Prepare for Call directly via the same production openResearchedAccountOpportunities() the individual-research and Recently Researched flows use (which itself closes Manage Customer Accounts and does not depend on timebox eligibility)'
);
assert(
  /\} else \{\s*statusEl\.append\(document\.createTextNode\(' '\)\);\s*const reviewBtn = document\.createElement\('button'\);/.test(handleListResearchClickSrc),
  'multiple accounts with opportunities is handled as its own distinct branch, separate from the exactly-one case'
);
assert(
  /reviewBtn\.textContent = 'Review Opportunities';/.test(handleListResearchClickSrc),
  'required test 16: the multi-account branch offers a "Review Opportunities" action, distinct from the single-account "View Opportunity" label'
);
assert(
  /reviewBtn\.addEventListener\('click', async \(\) => \{[\s\S]{0,800}?if\(typeof refreshAggregateDashboard === 'function'\) await refreshAggregateDashboard\(\);[\s\S]{0,300}?window\.HouseAccountManager\.close\(\);[\s\S]{0,300}?section\.scrollIntoView\(\{behavior:'smooth', block:'start'\}\);/.test(handleListResearchClickSrc),
  'required test 16: clicking Review Opportunities refreshes the aggregate dashboard, closes Manage Customer Accounts, and scrolls to Recently Researched -- one row per account with new opportunities, each with its own View Opportunities action (Recently Researched\'s existing per-row rendering, reused rather than duplicated), never forcing an arbitrary first account open and never depending on timebox eligibility (required test 18, since openResearchedAccountOpportunities() is timebox-independent by construction)'
);
assert(
  /if\(typeof refreshAggregateDashboard === 'function'\) await refreshAggregateDashboard\(\);\s*\/\/ FR2 round item 4/.test(handleListResearchClickSrc),
  'the aggregate dashboard (and therefore saved signal totals / Recently Researched) is refreshed immediately on completion, before the zero/one/multiple branch is even chosen -- individual and list-level research both update aggregate totals without a browser refresh'
);

// ---------------------------------------------------------------------------
// Required test 19: prior rounds' behavior remains intact -- spot-check a
// handful of load-bearing markers from earlier rounds that this round's
// edits sit directly next to, so a careless edit here would show up as a
// regression immediately.
// ---------------------------------------------------------------------------
assert(
  /body\.ha-overlay-open \.ha-help-dropdown,\s*body\.ha-overlay-open \.ha-site-header\.is-open \.ha-nav-shell\{display:none !important;\}/.test(
    readFileSync(new URL('../site-header.css', import.meta.url), 'utf8')
  ),
  'required test 19: the global overlay-open CSS force-hide rule from the follow-up round is untouched'
);
assert(
  /window\.HouseAccountsHeader=\{[\s\S]{0,80}?closeMenus\(\)\{/.test(readFileSync(new URL('../site-header.js', import.meta.url), 'utf8')),
  'required test 19: site-header.js still exposes closeMenus()/beginOverlay()/endOverlay() unchanged'
);
assert(
  /async function openResearchedAccountOpportunities\(uploadId, accountName\)\{/.test(dashboardHtml),
  'required test 19: the direct View Opportunities workflow from the follow-up round is untouched'
);

// ---------------------------------------------------------------------------
// Required test 20: syntax/inline-script checks -- every <script> block in
// dashboard/index.html must still parse as valid JavaScript after this
// round's edits.
// ---------------------------------------------------------------------------
{
  const scripts = [...dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert(scripts.length >= 2, 'dashboard/index.html still contains its expected inline <script> blocks');
  let allParse = true;
  scripts.forEach((s, i) => {
    try{ new Function(s); }
    catch(err){ allParse = false; console.error(`  inline script block ${i} failed to parse: ${err.message}`); }
  });
  assert(allParse, 'required test 20: every inline <script> block in dashboard/index.html parses as valid JavaScript');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
