// Follow-up round: list-level research, the direct View Opportunities
// workflow, the aggregate post-upload/post-research dashboard refresh, and
// the counted global overlay-open state that guarantees Help cannot be
// visibly open behind any application overlay. Extracts the REAL, verbatim
// source of the relevant dashboard/index.html and site-header.js functions
// by exact line range (same defensive pattern as every other extraction
// test in this repo -- a future edit that shifts these lines fails this
// test loudly instead of silently testing stale code). A small number of
// self-contained functions (the overlay-depth counter itself) are run for
// real in a vm sandbox; everything else is proven via static source
// assertions against the real on-disk files, consistent with this
// codebase's established testing convention.
//
// Usage: node scripts/test-followup-round.js
import { readFileSync } from 'fs';
import vm from 'vm';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const dashboardHtml = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const dashboardLines = dashboardHtml.split('\n');
const siteHeaderJs = readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
const siteHeaderCss = readFileSync(new URL('../site-header.css', import.meta.url), 'utf8');
// Scaling round: everResearched/activeCount moved server-side (see
// api/monitoring-lists.js's loadLists()) since cachedLists no longer
// carries a full .accounts array for listCard() to derive them from.
const dashboardApiMonitoringListsSrc = readFileSync(new URL('../api/monitoring-lists.js', import.meta.url), 'utf8');

function extractLines(label, startLine, endLine, expectedFirst){
  const slice = dashboardLines.slice(startLine - 1, endLine);
  const first = slice[0].trim();
  if(!first.startsWith(expectedFirst)){
    throw new Error(`extractLines(${label}): dashboard/index.html line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  return slice.join('\n');
}

// ---------------------------------------------------------------------------
// Required tests 1-5: list-level research labels, active-account scoping,
// disabled-while-running, and Delete Uploaded List staying separate.
// ---------------------------------------------------------------------------
// Scaling round: listCard() no longer receives a full .accounts array to
// derive everResearched/activeAccounts from client-side -- cachedLists now
// holds upload SUMMARIES only. Both are now server-computed in
// api/monitoring-lists.js's loadLists() (everResearched via a cheap
// existence check, activeCount via Prefer: count=exact) and read directly
// off the list object; the underlying required-test guarantees (labels,
// active-only confirmation count) are proven against the new mechanism
// instead.
const listCardSrc = extractLines('listCard', 10956, 10996, 'function listCard(list){');
assert(
  /const listResearchLabel = list\.everResearched \? 'Research All Accounts Again' : 'Research All Accounts';/.test(listCardSrc),
  'required tests 1 & 2: never-researched lists show "Research All Accounts", previously-researched lists show "Research All Accounts Again" -- now driven by the server-computed list.everResearched'
);
assert(
  /everResearched:Array\.isArray\(researchedRows\)&&researchedRows\.length>0/.test(dashboardApiMonitoringListsSrc),
  'required test 1 & 2 (server side): everResearched is computed from a real existence check against ha_accounts, not assumed'
);
assert(
  /activeCount:Math\.max\(0,totalCount-pausedCount\)/.test(dashboardApiMonitoringListsSrc),
  'required test 3: the server computes activeCount (total minus paused) via Prefer: count=exact, excluding paused accounts from the confirmation-dialog count without ever fetching the accounts themselves'
);
// ux/research-control-progress: disabledAttr/disabledTitle are now shared,
// precomputed variables (`const disabledAttr = runActive ? ' disabled' : '';`)
// reused by BOTH the "Research All Accounts" and "Research Unresearched
// Accounts" menu items, rather than inlined ternaries repeated per button --
// the underlying requirement (disabled exactly when runActive) is proven by
// checking the variable's own definition, not a literal button string.
assert(
  /const disabledAttr = runActive \? ' disabled' : '';/.test(listCardSrc) &&
  /data-list-research-act="research" data-list-id="\$\{esc\(list\.id\)\}" data-list-name="\$\{esc\(list\.name\)\}"\$\{disabledAttr\}\$\{disabledTitle\}/.test(listCardSrc),
  'required test 4: the Research All Accounts button is disabled exactly when runActive is true (the same server-owned researchRunState accountRow() uses)'
);
{
  const menuOrder = listCardSrc.indexOf('data-list-research-act="research"');
  const separatorOrder = listCardSrc.indexOf('acct-mgr-menu-separator');
  const deleteOrder = listCardSrc.indexOf('data-list-act="delete"');
  assert(
    menuOrder !== -1 && separatorOrder !== -1 && deleteOrder !== -1 && menuOrder < separatorOrder && separatorOrder < deleteOrder,
    'required test 5: Research Entire List sits above a visual separator, itself above Delete Uploaded List -- the destructive action stays last and visually separated'
  );
  assert(
    /class="acct-mgr-danger-item"/.test(listCardSrc.slice(deleteOrder - 200, deleteOrder + 50)),
    'Delete Uploaded List keeps its own distinct danger styling, unshared with the new research action'
  );
}
assert(
  /\.acct-mgr-menu-separator\{height:1px;background:var\(--line\);margin:5px 4px;\}/.test(dashboardHtml),
  'a real visual separator rule (.acct-mgr-menu-separator) exists in the page CSS'
);

// ---------------------------------------------------------------------------
// Required test 3 (continued) & "use existing production path, no second
// engine": researchListFromManageModal() reuses the same primitives
// researchAccountFromManageModal() uses -- fetchUploadScopedSnapshot(),
// claimAutomaticResearchRun(), the same /api/research-batch and
// /api/research-account endpoints/payload shapes, addSignalDerivedOpportunities(),
// persistScopedResearchResult() -- and excludes paused accounts before
// ever claiming a run or building a provider payload.
// ---------------------------------------------------------------------------
const researchListSrc = extractLines('researchListFromManageModal', 6361, 6587, 'async function researchListFromManageModal(listId, options = {}){');
assert(
  /let activeAccounts = allAccounts\.filter\(a => a\.monitoringStatus !== 'paused'\);/.test(researchListSrc),
  'required test 3: researchListFromManageModal() excludes paused accounts from the snapshot before doing anything else'
);
assert(
  /if\(!activeAccounts\.length\) return \{ok:false, error: options\.onlyUnresearched \? '[\s\S]{0,120}?' : 'This list has no active accounts to research\.'\};/.test(researchListSrc),
  'a list with zero active accounts is refused honestly, never silently claiming a run for nothing'
);
assert(
  /const snapshot = await fetchUploadScopedSnapshot\(expectedUploadId\);/.test(researchListSrc) &&
  /const claim = await claimAutomaticResearchRun\('manual-rerun', expectedUploadId, researchableAccounts\.map\(a => a\.name\)\);/.test(researchListSrc),
  'researchListFromManageModal() reuses the exact same scoped-snapshot and claim primitives as the single-account path -- no second research engine'
);
assert(
  /accounts: batchPayloadForAccounts\(enhancedGroup\)/.test(researchListSrc),
  'warm/mixed accounts in the list are sent through ONE batched /api/research-batch call, reusing batchPayloadForAccounts() exactly like a single-account request would with one more account in the array'
);
assert(
  /await fetch\('\/api\/research-account', \{method:'POST', headers, signal: controller\.signal, body: JSON\.stringify\(payload\)\}\);/.test(researchListSrc),
  'historical accounts in the list are researched via the same /api/research-account endpoint the single-account path uses'
);
assert(
  /addSignalDerivedOpportunities\(account, account\.signals\);/.test(researchListSrc),
  'every researched account (batched or per-account) has its opportunities derived via the real addSignalDerivedOpportunities() before the save -- the same fix applied to the single-account path'
);
assert(
  /const saveResult = await persistScopedResearchResult\(\{[\s\S]{0,200}?accounts: allAccounts,/.test(researchListSrc),
  'the final save persists the FULL allAccounts snapshot (paused accounts included, unmodified) via the same persistScopedResearchResult() the single-account path uses'
);

// ---------------------------------------------------------------------------
// Required tests: confirmation naming the list and active-account count,
// explaining it may take a few minutes; disabled-while-running is server-
// truth driven via an early re-render; and completion reports
// attempted/with-signals/signals-found/failures.
// ---------------------------------------------------------------------------
const handleListResearchClickSrc = extractLines("handleListResearchClick", 11258, 11370, "async function handleListResearchClick(btn){");
// Scaling round: the active-account count in the confirmation dialog now
// comes from the server-computed list.activeCount (Prefer: count=exact) --
// cachedLists no longer carries a full .accounts array to filter
// client-side. See api/monitoring-lists.js's loadLists().
// ux/research-control-progress: handleListResearchClick() now branches on
// onlyUnresearched (Research Unresearched Accounts vs. Research All
// Accounts) -- the required "names the list + active-account count"
// guarantee is proven against the "Research All Accounts" branch, which
// still shows the count exactly as before.
assert(
  /showResearchConfirm\(onlyUnresearched \? \{[\s\S]*?\} : \{[\s\S]{0,50}?title: `Research \$\{esc\(listName\)\}\?`,[\s\S]{0,300}?\$\{activeCount\} account/.test(handleListResearchClickSrc),
  'the confirmation dialog names the list and states its server-computed active-account count'
);
assert(
  /This may take a few minutes/.test(handleListResearchClickSrc),
  'the confirmation dialog explains that research may take a few minutes'
);
assert(
  /if\(!confirmed\) return;/.test(handleListResearchClickSrc),
  'declining the confirmation dialog aborts before any claim/research call'
);
assert(
  /result\.attempted[\s\S]{0,30}account.*attempted.*result\.withSignals[\s\S]{0,30}with signal/.test(handleListResearchClickSrc.replace(/\n/g, ' ')),
  'required test 6/completion reporting: the summary reports accounts attempted and accounts with signals'
);
assert(
  /\$\{result\.totalSignals\} signal\$\{result\.totalSignals===1\?'':'s'\} found\)\$\{result\.failures/.test(handleListResearchClickSrc),
  'the summary also reports total signals found and any failures'
);
assert(
  /if\(result\.ok\)\{[\s\S]*?if\(typeof refreshAggregateDashboard === 'function'\) await refreshAggregateDashboard\(\);/.test(handleListResearchClickSrc),
  'required test 6: successful list completion refreshes the aggregate dashboard (Your Accounts/totals/Recently Researched/priorities) via the shared refreshAggregateDashboard()'
);
assert(
  /^\s*load\(\);$/m.test(handleListResearchClickSrc.split('if(!confirmed) return;')[1].split('let result;')[0]),
  'an early, unawaited load() kicks a re-render immediately after confirming, so account rows can pick up the running state via the existing server-truth researchRunState without waiting for the next poll tick'
);

// ---------------------------------------------------------------------------
// Required tests 7, 8 & 9: the direct View Opportunities workflow --
// independent of timebox eligibility, opens Prepare for Call for the top
// result, and relies on the existing Additional Opportunities section for
// the rest.
// ---------------------------------------------------------------------------
const openResearchedSrc = extractLines('openResearchedAccountOpportunities', 7646, 7741, 'async function openResearchedAccountOpportunities(uploadId, accountName){');
assert(
  !/opportunityMatchesTimebox|findTimeboxForAccountOpportunity|activeTimebox|showAllWeeklyPriorities/.test(openResearchedSrc),
  'required test 8: openResearchedAccountOpportunities() never calls any TIMEBOX-matching helper (This Week/Month/Quarter/Year) -- it is independent of timebox eligibility (comments discussing the requirement do not count as a dependency)'
);
assert(
  /const refresh = typeof refreshAggregateDashboard === 'function' \? await refreshAggregateDashboard\(\) : \{ok:false\};/.test(openResearchedSrc),
  'step 1: the aggregate saved-dashboard state is refreshed before anything else, so the researched account\'s persisted opportunities are current'
);
assert(
  /if\(window\.HouseAccountManager[\s\S]{0,150}?window\.HouseAccountManager\.close\(\);/.test(openResearchedSrc),
  'required test: Manage Customer Accounts is closed as part of this shared handoff, whether or not it happens to be open'
);
assert(
  /const rawOpportunities = \(account\.futureOpportunities \|\| \[\]\)\.slice\(\);/.test(openResearchedSrc) &&
  /const dedupedCluster = sortDailyReasons\(dedupeOpportunities\(collapseDuplicateAccountHistorySignals\(rawOpportunities\)\)\);/.test(openResearchedSrc) &&
  /const opportunities = priorityEligibleOpportunities\(dedupedCluster\);/.test(openResearchedSrc),
  'temporal-integrity/follow-up round: every one of the account\'s persisted opportunities is deduped/merged (dedupeOpportunities(collapseDuplicateAccountHistorySignals(...))) and ranked by score through the SAME canonical pipeline accountOpportunityCluster() uses, then passed through the SAME centralized priorityEligibleOpportunities() actionability gate -- this path can no longer open a stale/expired/"no longer current" opportunity as an active Verified Opportunity merely because it scored highest, and can no longer select from a different (unmerged) representation than Additional Opportunities uses'
);
assert(
  /if\(typeof createSalesPlayPanel === 'function'\) createSalesPlayPanel\(opportunities\[0\]\);/.test(openResearchedSrc),
  'required test 7: the highest-ranked opportunity opens through the existing, real Prepare for Call experience (createSalesPlayPanel), not a bespoke summary'
);
assert(
  /Additional Opportunities Found/.test(dashboardHtml) && /additionalOpportunitiesFor\(opp\)/.test(dashboardHtml),
  'required test 9: createSalesPlayPanel() already renders every OTHER opportunity for the same account under "Additional Opportunities Found" via the existing additionalOpportunitiesFor()/accountOpportunityCluster() pipeline, reading the exact window.accountRadarAccounts this handoff just refreshed -- no separate list is threaded through'
);
assert(
  /if\(!opportunities\.length\)\{[\s\S]{0,400}?window\.HouseAccountManager\.showError/.test(openResearchedSrc),
  'required test 10 (honest error path): a genuinely empty opportunity list shows a clear message rather than opening a blank Prepare for Call panel'
);
assert(
  /if\(!refresh\.ok && !refresh\.empty\)\{[\s\S]{0,200}?showUnresolvable\(\);/.test(openResearchedSrc) &&
  /okLabel: 'Refresh Dashboard'/.test(openResearchedSrc),
  'required test 10: if the results can no longer be resolved (aggregate refresh failed), an honest error is shown with a "Refresh Dashboard" recovery action'
);

// ---------------------------------------------------------------------------
// Required test 10: the toast and the Recently Researched row use the same
// production function -- not two independent implementations.
// ---------------------------------------------------------------------------
assert(
  /fn: \(\) => \{ if\(typeof openResearchedAccountOpportunities === 'function'\) openResearchedAccountOpportunities\(listId, accountName\); \}/.test(dashboardHtml),
  'the research-completion toast\'s "View opportunities" action calls openResearchedAccountOpportunities()'
);
assert(
  /if\(event\.target\.closest\('\.rr-view-btn'\)\)\{\s*if\(typeof openResearchedAccountOpportunities === 'function'\) openResearchedAccountOpportunities\(uploadId, accountName\);/.test(dashboardHtml),
  'the Recently Researched row\'s "View opportunities" button calls the SAME openResearchedAccountOpportunities() function, not a separate scroll-only implementation'
);
assert(
  !/scrollToAccountResult\(listId, accountName\)/.test(dashboardHtml) && !/if\(event\.target\.closest\('\.rr-view-btn'\)\)\{ scrollToAccountResult/.test(dashboardHtml),
  'neither View Opportunities call site still merely scrolls to/highlights the Recently Researched row'
);

// ---------------------------------------------------------------------------
// Required tests 11, 12 & 13: post-upload aggregate refresh renders every
// uploaded list, the upload-success panel stays visible throughout, and
// post-research totals update without a manual refresh.
// ---------------------------------------------------------------------------
const fetchAggregateSrc = extractLines('fetchAndRenderAggregateDashboard', 3669, 3774, "async function fetchAndRenderAggregateDashboard(email, {silent = false} = {}){");
assert(
  /fetch\(`\/api\/get-dashboard\?email=\$\{encodeURIComponent\(e\)\}&view=\$\{encodeURIComponent\(dashboardViewMode \|\| defaultDashboardView\(\)\)\}`/.test(fetchAggregateSrc),
  'required test 11: fetchAndRenderAggregateDashboard() calls the real /api/get-dashboard aggregate endpoint (every uploaded list the user owns), the exact same source loadSavedDashboard() has always used -- never a single-upload-scoped request'
);
assert(
  !/silent[\s\S]{0,40}?uploadSuccessState/.test(fetchAggregateSrc) && !/uploadSuccessState/.test(fetchAggregateSrc),
  'required test 12: fetchAndRenderAggregateDashboard() never references #uploadSuccessState at all, in silent or non-silent mode -- the upload-success panel is left completely untouched by this refresh'
);
{
  const processDataSaveChain = dashboardHtml.slice(dashboardHtml.indexOf("saveCurrentUpload('uploaded').then(async () => {"), dashboardHtml.indexOf("saveCurrentUpload('uploaded').then(async () => {") + 400);
  assert(
    /if\(typeof refreshAggregateDashboard === 'function'\) refreshResult = await refreshAggregateDashboard\(\);/.test(processDataSaveChain),
    'required test 11: processData() calls the shared refreshAggregateDashboard() immediately after the fresh upload\'s save resolves, so the aggregate (every uploaded list) replaces the transient single-upload snapshot without a manual refresh (FR2 round: the result is now also captured to drive the retryable-failure state)'
  );
}
assert(
  /if\(typeof refreshAggregateDashboard === 'function'\) await refreshAggregateDashboard\(\);\s*const toastMessage/.test(dashboardHtml),
  'required test 13: handleResearchClick() (single-account research from Manage Customer Accounts) calls refreshAggregateDashboard() unconditionally after research completes, before ever showing the toast -- dashboard counts/saved signals update whether or not View Opportunities is ever clicked'
);
assert(
  /async function refreshAggregateDashboard\(\)\{/.test(dashboardHtml) &&
  /return fetchAndRenderAggregateDashboard\(email, \{silent:true\}\);/.test(dashboardHtml),
  'refreshAggregateDashboard() (the one shared entry point for post-upload/post-research) always calls the silent variant, so it never flashes the loading skeleton or Sample Analysis over whatever success UI the caller has on screen'
);

// ---------------------------------------------------------------------------
// Required tests 14, 15, 16 & 17: the global counted overlay-open state.
// ---------------------------------------------------------------------------
assert(
  /body\.ha-overlay-open \.ha-help-dropdown,\s*body\.ha-overlay-open \.ha-site-header\.is-open \.ha-nav-shell\{display:none !important;\}/.test(siteHeaderCss),
  'required test 15: a CSS rule forces the Help dropdown and the mobile nav shell hidden whenever body.ha-overlay-open is set, regardless of their own hidden attribute/open class or any JS event-ordering race'
);
{
  const overlayCallers = [
    ['openAddCustomerDataModal (Add Customer Data)', /function openAddCustomerDataModal\(\)\{[\s\S]{0,700}?beginOverlay\(\);/],
    ['launchGuidedTour (guided tour)', /function launchGuidedTour\(\)\{[\s\S]{0,600}?beginOverlay\(\);/],
    ['showBetaWelcomeModal (Welcome)', /function showBetaWelcomeModal\(\)\{[\s\S]{0,700}?beginOverlay\(\);/],
    ['createSalesPlayPanel (Prepare for Call)', /window\.createSalesPlayPanel = function\(opp, opts\)\{[\s\S]{0,800}?beginOverlay\(\);/],
    ['Manage Customer Accounts open()', /function open\(\)\{[\s\S]{0,400}?beginOverlay\(\);/],
    ['showDestructiveConfirm', /function showDestructiveConfirm\(\{title, bodyHtml, confirmLabel\}\)\{[\s\S]{0,900}?beginOverlay\(\);/],
    ['showResearchConfirm (Research Entire List confirm)', /function showResearchConfirm\(\{title, bodyHtml, confirmLabel\}\)\{[\s\S]{0,200}?beginOverlay\(\);/],
    ['showInfoDialog', /function showInfoDialog\(\{title, bodyHtml, okLabel\}\)\{[\s\S]{0,400}?beginOverlay\(\);/]
  ];
  for(const [name, re] of overlayCallers){
    assert(re.test(dashboardHtml), `required test 14: ${name} calls window.HouseAccountsHeader.beginOverlay() before presenting itself, joining the shared overlay-open state`);
  }
}
{
  const overlayClosers = [
    ['closeAddCustomerDataModal', /function closeAddCustomerDataModal\(\)\{[\s\S]{0,700}?endOverlay\(\);/],
    ['closeGuidedTour', /function closeGuidedTour\(\)\{[\s\S]{0,2000}?endOverlay\(\);/],
    ['dismissBetaWelcomeModal', /function dismissBetaWelcomeModal\(\)\{[\s\S]{0,400}?endOverlay\(\);/],
    ['closeSalesPlayModal', /window\.closeSalesPlayModal = function\(el\)\{[\s\S]{0,400}?endOverlay\(\);/],
    ['Manage Customer Accounts close()', /function close\(\)\{[\s\S]{0,500}?endOverlay\(\);/]
  ];
  for(const [name, re] of overlayClosers){
    assert(re.test(dashboardHtml), `every overlay-closing counterpart (${name}) calls window.HouseAccountsHeader.endOverlay(), so the shared state is correctly decremented on close`);
  }
}

// Required test 16: the overlay counter is real (not just present in
// source) -- proven by running the actual beginOverlay()/endOverlay()
// closures from site-header.js in a vm sandbox and driving them through a
// nested open/close sequence.
{
  const siteHeaderLines = siteHeaderJs.split('\n');
  const startIdx = siteHeaderLines.findIndex(l => l.trim() === 'let overlayDepth=0;');
  if(startIdx === -1) throw new Error('overlayDepth counter block not found in site-header.js -- source has shifted, update this test.');
  // beginOverlay and endOverlay are each a simple arrow function whose body
  // closes on its own "};" line -- the second such line after startIdx is
  // the end of endOverlay(), i.e. the end of the whole counter block.
  let closingLinesSeen = 0, sliceEnd = -1;
  for(let i = startIdx + 1; i < siteHeaderLines.length; i++){
    if(siteHeaderLines[i].trim() === '};'){
      closingLinesSeen += 1;
      if(closingLinesSeen === 2){ sliceEnd = i; break; }
    }
  }
  if(sliceEnd === -1) throw new Error('could not find the end of the beginOverlay/endOverlay block -- source has shifted, update this test.');
  const counterSrc = siteHeaderLines.slice(startIdx, sliceEnd + 1).join('\n');
  assert(counterSrc.includes('const beginOverlay') && counterSrc.includes('const endOverlay'), 'extracted the real beginOverlay()/endOverlay() closures from site-header.js');

  const classes = new Set();
  const fakeBody = { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } };
  const sandbox = {
    document: { body: fakeBody },
    closeHelp: () => {},
    closeMobileNav: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(`${counterSrc}\nthis.beginOverlay = beginOverlay; this.endOverlay = endOverlay;`, sandbox);

  assert(!classes.has('ha-overlay-open'), 'sanity: body starts without ha-overlay-open');
  sandbox.beginOverlay();
  assert(classes.has('ha-overlay-open'), 'required test 14: a single beginOverlay() call adds body.ha-overlay-open');
  sandbox.beginOverlay();
  assert(classes.has('ha-overlay-open'), 'required test 16: a SECOND, nested beginOverlay() call (e.g. a confirm dialog opened over an already-open modal) keeps the class present');
  sandbox.endOverlay();
  assert(classes.has('ha-overlay-open'), 'required test 16: closing only the inner (second) overlay does NOT remove the class while the outer overlay is still open');
  sandbox.endOverlay();
  assert(!classes.has('ha-overlay-open'), 'required test 16: only once the FINAL overlay closes does the class get removed');
  // Defensive: endOverlay() never goes negative / never throws when called
  // with no matching beginOverlay() (e.g. a stray call after a bug fix).
  sandbox.endOverlay();
  assert(!classes.has('ha-overlay-open'), 'endOverlay() is safe to call with depth already at 0 -- it does not go negative or reopen anything');
}

// Required test 17: Help does not remain visible behind any of the five
// named overlays -- proven by required test 14's beginOverlay() call-site
// proof (every one of them calls it) combined with required test 15's CSS
// force-hide (every one of them therefore forces the dropdown hidden while
// open), plus the direct blur/aria-expanded proof already covered by
// test-stabilization-round.js's required tests 1-3 (still green -- see the
// full suite run).
assert(
  /const closeHelp=\(blurToggle\)=>\{\s*if\(!helpToggle\|\|!helpDropdown\) return;\s*helpDropdown\.hidden=true;\s*helpToggle\.setAttribute\('aria-expanded','false'\);/.test(siteHeaderJs),
  'required test 17: closeHelp() (called by beginOverlay() on every overlay open) sets aria-expanded=false and hides the dropdown, on top of the CSS force-hide'
);

// ---------------------------------------------------------------------------
// Required test 19: syntax/inline-script sanity on every file touched this
// round.
// ---------------------------------------------------------------------------
{
  const scriptBlocks = [...dashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert(scriptBlocks.length >= 2, `dashboard/index.html has its expected inline <script> blocks (found ${scriptBlocks.length})`);
  let allOk = true;
  for(const block of scriptBlocks){
    try{ new Function(block); }
    catch(err){ allOk = false; console.error(`  inline script syntax error: ${err.message}`); }
  }
  assert(allOk, 'every inline <script> block in dashboard/index.html parses without a syntax error');
}
try{ new Function(siteHeaderJs.replace(/^\(function\(\)\{/, '').replace(/\}\)\(\);\s*$/, '')); assert(true, 'site-header.js parses without a syntax error'); }
catch(err){ assert(false, `site-header.js parses without a syntax error (${err.message})`); }

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
