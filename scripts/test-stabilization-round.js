// Stabilization round: application-shell and upload-flow defects found in
// Preview QA -- Help/menu closing behind every overlay, the Sample Analysis
// flash during dashboard loading, the disappearing Add Customer Data
// uploader, post-upload actions hiding the dashboard, account-level research
// button clarity, restored Pricing/footer navigation, the simplified
// dashboard heading row, and the pricing-page redundancy cleanup.
//
// Follows this repo's established test pattern: real, on-disk source is
// read and asserted against directly (both via targeted regex/text checks
// and, for one self-contained function, real vm execution against a fake
// DOM) -- never a reimplementation of the logic under test. Functions/ranges
// are located via the shared semantic extractor (extractFn/extractRange),
// which throws loudly on ambiguity rather than silently testing stale code.
//
// Usage: node scripts/test-stabilization-round.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const dashboardHtml = DASHBOARD_SRC;
const siteHeaderJs = readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
const pricingHtml = readFileSync(new URL('../pricing.html', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Required test 1 & 2: every overlay-opening function closes the Help
// dropdown (and mobile nav) via window.HouseAccountsHeader.closeMenus()
// before presenting itself, so Help can never remain visibly open behind
// the guided tour, the Welcome modal, Add Customer Data, Manage Customer
// Accounts, the Sales Play panel, or the branded confirm/info dialogs.
// ---------------------------------------------------------------------------
const overlayOpeners = [
  { name: 'openAddCustomerDataModal (Add Customer Data modal)', re: /function openAddCustomerDataModal\(\)\{[\s\S]{0,600}?closeMenus\(\)/ },
  { name: 'launchGuidedTour (guided tour)', re: /function launchGuidedTour\(\)\{[\s\S]{0,400}?closeMenus\(\)/ },
  { name: 'showBetaWelcomeModal (Welcome modal)', re: /function showBetaWelcomeModal\(\)\{[\s\S]{0,600}?closeMenus\(\)/ },
  { name: 'createSalesPlayPanel (Prepare for Call panel)', re: /window\.createSalesPlayPanel = function\(opp, opts\)\{[\s\S]{0,400}?closeMenus\(\)/ },
  { name: 'Manage Customer Accounts modal open()', re: /function open\(\)\{[\s\S]{0,400}?closeMenus\(\)/ },
  { name: 'showDestructiveConfirm (delete confirm dialog)', re: /function showDestructiveConfirm\(\{title, bodyHtml, confirmLabel\}\)\{[\s\S]{0,400}?closeMenus\(\)/ },
  { name: 'showInfoDialog (info dialog)', re: /function showInfoDialog\(\{title, bodyHtml, okLabel\}\)\{[\s\S]{0,400}?closeMenus\(\)/ }
];
for(const opener of overlayOpeners){
  assert(opener.re.test(dashboardHtml), `${opener.name} calls window.HouseAccountsHeader.closeMenus() before opening`);
}

// ---------------------------------------------------------------------------
// Required test 3: closing every open menu explicitly blurs the Help
// trigger (so focus is never left on a control about to be visually
// superseded), and closeMenus() itself always requests that blur.
// ---------------------------------------------------------------------------
assert(
  /const closeHelp=\(blurToggle\)=>\{[\s\S]{0,200}?if\(blurToggle && typeof helpToggle\.blur==='function'\) helpToggle\.blur\(\);/.test(siteHeaderJs),
  'site-header.js closeHelp(blurToggle) blurs the Help toggle when an overlay is about to take focus elsewhere'
);
assert(
  /closeMenus\(\)\{\s*closeHelp\(true\);/.test(siteHeaderJs),
  'site-header.js closeMenus() always calls closeHelp(true), guaranteeing the blur on every overlay open'
);

// ---------------------------------------------------------------------------
// Required tests 4 & 5: Sample Analysis (#exampleOpportunity) starts hidden
// by default, a neutral skeleton is shown while a saved lead's dashboard is
// unresolved, and Sample Analysis is only revealed once loading is confirmed
// complete AND confirmed empty.
// ---------------------------------------------------------------------------
assert(
  /<section class="example-opportunity" id="exampleOpportunity"[^>]*style="display:none;"/.test(dashboardHtml),
  '#exampleOpportunity is hidden by default in the page markup (never a flash-visible default)'
);
assert(
  dashboardHtml.includes('<div class="dashboard-loading-skeleton" id="dashboardLoadingSkeleton"'),
  '#dashboardLoadingSkeleton neutral branded loading state exists in the page markup'
);
const setLeadGateSrc = extractFn(DASHBOARD_SRC, 'setLeadGateState');
assert(
  /if\(skeleton\) skeleton\.classList\.add\('active'\);/.test(setLeadGateSrc) && !/example\.style\.display = 'block';[\s\S]*if\(saved && saved\.email\)/.test(setLeadGateSrc),
  'setLeadGateState() shows the loading skeleton (not Sample Analysis) whenever a saved lead exists'
);
// Follow-up round: loadSavedDashboard()'s fetch+render body was extracted
// into fetchAndRenderAggregateDashboard() (the shared core also used by
// refreshAggregateDashboard() for post-upload/post-research) -- the
// personalEmpty/noData/skeleton logic these tests verify all now lives
// there; loadSavedDashboard() itself is a thin email-validation wrapper.
const loadSavedDashboardSrc = extractFn(DASHBOARD_SRC, 'fetchAndRenderAggregateDashboard');
assert(
  /if\(skeleton\) skeleton\.classList\.add\('active'\);/.test(loadSavedDashboardSrc),
  'fetchAndRenderAggregateDashboard() shows the skeleton immediately on every call (a no-op when silent, since skeleton is null then), before any network round trip resolves'
);
assert(
  (loadSavedDashboardSrc.match(/if\(skeleton\) skeleton\.classList\.remove\('active'\);/g) || []).length >= 3,
  'fetchAndRenderAggregateDashboard() hides the skeleton in every resolution branch (personalEmpty, success, and the catch/noData path)'
);
// Live QA round 8: the personalEmpty/noData branches' actual DOM-clearing
// (including revealing Sample Analysis) was factored out into one shared
// applyEmptyWorkspaceState() helper, called by both branches -- see its own
// header comment. The ordering guarantee these tests check (skeleton
// removed / branch confirmed BEFORE Sample Analysis can show) now lives in
// that helper's call-site ordering, not literal example.style.display text
// inside each branch.
const applyEmptyWorkspaceStateSrc = extractFn(DASHBOARD_SRC, 'applyEmptyWorkspaceState');
const renderEmptyWorkspaceStateSrc = extractFn(DASHBOARD_SRC, 'renderEmptyWorkspaceState');
// Live QA round 9: the hardcoded "Sample Analysis / Acme Manufacturing"
// example card is no longer revealed for this signed-in path -- replaced
// by renderEmptyWorkspaceState()'s modern empty-state copy, called from
// applyEmptyWorkspaceState() as part of the same shared transition.
assert(
  /renderEmptyWorkspaceState\(\{viewMode, teamHasData\}\);/.test(applyEmptyWorkspaceStateSrc),
  'applyEmptyWorkspaceState() fills in the modern empty-state copy (renderEmptyWorkspaceState()) as part of the shared empty-workspace transition'
);
assert(
  /No customer data yet/.test(renderEmptyWorkspaceStateSrc),
  'renderEmptyWorkspaceState() sets the modern "No customer data yet" empty-state headline'
);
{
  const personalEmptyBlock = loadSavedDashboardSrc.slice(loadSavedDashboardSrc.indexOf('if(data.personalEmpty === true){'), loadSavedDashboardSrc.indexOf('const accounts = (data.accounts || [])'));
  const skeletonRemoveIdx = personalEmptyBlock.indexOf("skeleton.classList.remove('active')");
  const applyCallIdx = personalEmptyBlock.indexOf('applyEmptyWorkspaceState(');
  assert(
    skeletonRemoveIdx !== -1 && applyCallIdx !== -1 && skeletonRemoveIdx < applyCallIdx,
    'loadSavedDashboard() reveals Sample Analysis in the personalEmpty branch only after skeleton removal (confirmed loading complete + confirmed empty)'
  );
}
{
  const noDataBlock = loadSavedDashboardSrc.slice(loadSavedDashboardSrc.indexOf('}catch(err){'));
  const noDataIdx = noDataBlock.indexOf('if(noData){');
  // The actual CALL, not the applyEmptyWorkspaceState() mention inside this
  // branch's own header comment (which would otherwise match earlier in
  // the block and falsely appear to precede the noData check).
  const applyCallIdx = noDataBlock.indexOf('applyEmptyWorkspaceState({silent, banner, viewMode: dashboardViewMode || defaultDashboardView()});');
  assert(
    noDataIdx !== -1 && applyCallIdx !== -1 && noDataIdx < applyCallIdx,
    'loadSavedDashboard() reveals Sample Analysis in the catch/noData branch only after loading is confirmed complete and empty'
  );
}
assert(
  /if\(example\) example\.style\.display = 'none';/.test(loadSavedDashboardSrc),
  'loadSavedDashboard() explicitly hides Sample Analysis on the success (has-data) path, so an existing user never sees it'
);

// ---------------------------------------------------------------------------
// Required test 4 (race guard): a slow/late "no data yet" response can never
// clobber dashboard state a fresh client-side upload already rendered this
// same visit.
// ---------------------------------------------------------------------------
assert(
  /let freshUploadRenderedThisSession = false;/.test(dashboardHtml),
  'freshUploadRenderedThisSession guard flag exists'
);
assert(
  (loadSavedDashboardSrc.match(/if\(freshUploadRenderedThisSession\) return \{/g) || []).length === 2,
  'fetchAndRenderAggregateDashboard() checks the freshUploadRenderedThisSession guard in both the personalEmpty and catch/noData branches, before mutating any dashboard DOM'
);
assert(
  /freshUploadRenderedThisSession = true;/.test(dashboardHtml),
  'processData() (the fresh-upload render path) sets freshUploadRenderedThisSession = true after rendering'
);

// ---------------------------------------------------------------------------
// Required tests 6, 7 & 8: the Add Customer Data uploader/dropzone is a
// stable, permanently-mounted part of the modal -- never independently
// hidden/moved by dashboard initialization -- and the canonical URL action
// opens it exactly once, after required init completes.
// ---------------------------------------------------------------------------
assert(
  /<div class="upload-zone" id="dropzone">/.test(dashboardHtml) && !/<div class="upload-zone locked" id="dropzone">/.test(dashboardHtml),
  '#dropzone no longer carries the .locked class that used to permanently hide it via CSS'
);
assert(
  !/\.upload-zone\.locked\{display:none;\}/.test(dashboardHtml),
  'the .upload-zone.locked{display:none;} CSS rule has been removed entirely'
);
assert(
  !/const dz = document\.getElementById\('dropzone'\);\s*if\(dz\) dz\.style\.display = 'none';/.test(loadSavedDashboardSrc),
  'loadSavedDashboard() no longer independently mutates #dropzone.style.display -- the outer modal\'s hidden attribute is the sole visibility authority'
);
assert(
  /<div class="ha-modal-backdrop add-customer-data-backdrop" id="addCustomerDataModal"[^>]*hidden>[\s\S]{0,700}?<div class="upload-zone" id="dropzone">/.test(dashboardHtml),
  '#dropzone is permanently mounted as a direct descendant of #addCustomerDataModal in the page markup (not moved/borrowed elsewhere)'
);
const addDataModalSrc = extractRange(DASHBOARD_SRC, 'let addCustomerDataModalTriggerEl = null;', 'function handleMvpDashboardRoute(){');
assert(
  /function openAddCustomerDataModalWhenReady\(\)\{\s*const ready = \(window\.HouseAuth && typeof HouseAuth\.authHeadersAsync/.test(addDataModalSrc),
  'openAddCustomerDataModalWhenReady() waits for HouseAuth.authHeadersAsync() (required init) before opening the modal'
);
assert(
  /let addCustomerDataModalOpenedForAction = false;/.test(addDataModalSrc) &&
  /if\(params\.get\('action'\) === 'add-data' && !addCustomerDataModalOpenedForAction\)\{\s*addCustomerDataModalOpenedForAction = true;/.test(addDataModalSrc),
  'the canonical /dashboard/?action=add-data route consumes the action exactly once, guarded by addCustomerDataModalOpenedForAction'
);
assert(
  /url\.searchParams\.delete\('action'\);\s*window\.history\.replaceState/.test(addDataModalSrc),
  'the action param is stripped from the URL via replaceState immediately, so a refresh never re-triggers the modal'
);

// ---------------------------------------------------------------------------
// Required tests 9, 10, 11 & 12: post-upload actions never hide/replace the
// dashboard, and closing either modal restores it unchanged.
//
// Live QA round 5: View Priorities/Manage Customer Accounts/Upload Another
// List were removed from the upload-success surface entirely (per the
// founder's explicit request -- "those already exist elsewhere in the
// product") in favor of a focused modal (showUploadSuccessModal()) with
// Research/Not now actions and a low-emphasis "View uploaded accounts"
// link, which does the one remaining equivalent thing: open the real
// Manage Customer Accounts modal, never a dashboard reset.
// ---------------------------------------------------------------------------
const uploadSuccessWiringSrc = extractFn(DASHBOARD_SRC, 'showUploadSuccessModal');
assert(
  /viewAccountsBtn\.addEventListener\('click', \(\) => \{\s*close\(\);\s*document\.getElementById\('manageCustomerAccountsBtn'\)\?\.click\(\);/.test(uploadSuccessWiringSrc),
  '"View uploaded accounts" only closes the upload-success modal and opens the real Manage Customer Accounts modal -- no dashboard reset call'
);
const accountManagerOpenCloseSrc = extractRange(DASHBOARD_SRC, 'let accountManagerTriggerEl = null;', 'function close(){');
assert(
  /function open\(\)\{[\s\S]*document\.getElementById\('accountManagerModal'\)\.style\.display='block';/.test(accountManagerOpenCloseSrc) &&
  !/results'\)\.style\.display|customerDashboard'\)\.style\.display|exampleOpportunity/.test(accountManagerOpenCloseSrc),
  'Manage Customer Accounts modal open() only toggles its own modal display -- it never hides #results, #customerDashboard, or reveals #exampleOpportunity'
);
assert(
  /function close\(\)\{[\s\S]*document\.getElementById\('accountManagerModal'\)\.style\.display='none';/.test(accountManagerOpenCloseSrc) &&
  !/results'\)\.style\.display|customerDashboard'\)\.style\.display/.test(accountManagerOpenCloseSrc.split('function close(){')[1]),
  'Manage Customer Accounts modal close() only hides its own modal -- the dashboard underneath is left untouched, so it is restored unchanged'
);
assert(
  /function closeAddCustomerDataModal\(\)\{\s*const modal = document\.getElementById\('addCustomerDataModal'\);\s*if\(!modal \|\| modal\.hidden\) return;\s*modal\.hidden = true;/.test(addDataModalSrc) &&
  !/results'\)\.style\.display|customerDashboard'\)\.style\.display|exampleOpportunity/.test(addDataModalSrc.split("function closeAddCustomerDataModal(){")[1].split('function wireAddCustomerDataModalControls')[0]),
  'closeAddCustomerDataModal() only hides the modal itself -- it never touches #results/#customerDashboard/#exampleOpportunity, so the dashboard behind it is restored unchanged'
);

// ---------------------------------------------------------------------------
// Required test 9-11 (dashboard preservation, positive proof): the shared
// panel-populator that post-upload/post-research flows call to update the
// "Your Accounts" summary genuinely writes into the real DOM nodes, via a
// real vm execution against a minimal fake DOM -- not a reimplementation.
// ---------------------------------------------------------------------------
{
  const panelSrc = extractFn(DASHBOARD_SRC, 'showCustomerDashboardPanel');
  const registry = new Map();
  function fakeEl(id, tag){
    const el = { id, tagName: (tag || 'div').toUpperCase(), style: {}, _text: '' };
    Object.defineProperty(el, 'textContent', { get(){ return el._text; }, set(v){ el._text = String(v); } });
    registry.set(id, el);
    return el;
  }
  fakeEl('customerDashboard');
  fakeEl('customerDashboardSubtitle');
  fakeEl('dashNewThisWeek');
  fakeEl('dashSavedAccounts');
  fakeEl('dashSavedSignals');
  fakeEl('dashLastScan');
  const sandbox = {
    document: { getElementById: id => registry.get(id) || null },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(`${panelSrc}\nthis.showCustomerDashboardPanel = showCustomerDashboardPanel;`, sandbox);
  sandbox.showCustomerDashboardPanel({
    subtitleText: 'My list is saved.',
    newCount: 4,
    accountCount: 12,
    signalCount: 3,
    lastScanLabel: 'Today'
  });
  assert(registry.get('customerDashboard').style.display === 'block', 'showCustomerDashboardPanel() reveals the real #customerDashboard panel');
  assert(registry.get('customerDashboardSubtitle').textContent === 'My list is saved.', 'showCustomerDashboardPanel() writes the real subtitle text');
  assert(String(registry.get('dashNewThisWeek').textContent) === '4', 'showCustomerDashboardPanel() writes newCount into #dashNewThisWeek without altering the caller-computed value');
  assert(String(registry.get('dashSavedAccounts').textContent) === '12', 'showCustomerDashboardPanel() writes accountCount into #dashSavedAccounts');
  assert(String(registry.get('dashSavedSignals').textContent) === '3', 'showCustomerDashboardPanel() writes signalCount into #dashSavedSignals');
  assert(registry.get('dashLastScan').textContent === 'Today', 'showCustomerDashboardPanel() writes lastScanLabel into #dashLastScan');
}

// ---------------------------------------------------------------------------
// Required tests 13, 14 & 15: account-level research row action labels and
// cross-list scoping.
// ---------------------------------------------------------------------------
const accountRowSrc = extractFn(DASHBOARD_SRC, 'accountRow');
assert(
  /researched \? 'Research Again' : 'Research Account'/.test(accountRowSrc),
  'accountRow() labels never-researched accounts "Research Account" and previously-researched accounts "Research Again"'
);
assert(
  !/inScope/.test(accountRowSrc),
  'accountRow() no longer gates the research button on an "inScope"/currentUploadId check -- every row\'s button is live'
);
assert(
  /data-research-act="account" data-account-name="\$\{esc\(a\.name\)\}" data-list-id="\$\{esc\(list\.id\)\}"/.test(accountRowSrc),
  'the research button carries the specific account name and its own list id, so the action always operates on the exact row selected'
);
// ux/research-control-progress: researchDisabled now also exempts the one
// case where this row can be genuinely, individually stopped instead of
// merely disabled (a standalone single-account tracker) -- the underlying
// "disabled only while a run is active for THIS list, never due to list
// scope" guarantee is unchanged, just refined with that one exception.
assert(
  /const researchDisabled = runActive && !canStopThisRow;/.test(accountRowSrc),
  'the row action is disabled only while a run is active for that list (and only that exact account shows "Researching…"), never due to list scope'
);
const researchFromModalSrc = extractFn(DASHBOARD_SRC, 'researchAccountFromManageModal');
assert(
  researchFromModalSrc.includes('async function researchAccountFromManageModal(accountName, listId){'),
  'researchAccountFromManageModal(accountName, listId) still takes an explicit listId, so scoping happens automatically without the user re-finding/activating the list'
);
assert(
  !/outOfScope/.test(dashboardHtml.slice(dashboardHtml.indexOf('async function researchAccountFromManageModal'), dashboardHtml.indexOf('async function researchAccountFromManageModal') + 4000)),
  'researchAccountFromManageModal() no longer returns an outOfScope refusal -- every account row can be researched directly from Manage Customer Accounts'
);
assert(
  /const expectedUploadId = listId;/.test(dashboardHtml) && /fetchUploadScopedSnapshot\(expectedUploadId\)/.test(dashboardHtml),
  'research still fetches/saves scoped strictly to the row\'s own listId (fetchUploadScopedSnapshot(expectedUploadId)), preserving upload identity/account-scoping protections'
);

// ---------------------------------------------------------------------------
// Required test 16: Pricing appears exactly once in the authenticated
// header nav, alongside Dashboard and Export Guides, with Add Customer Data
// remaining the separate teal CTA (not a plain nav link).
// ---------------------------------------------------------------------------
{
  const appLinksMatch = siteHeaderJs.match(/const appLinks=\[([\s\S]*?)\];/);
  assert(Boolean(appLinksMatch), 'site-header.js defines an appLinks array for the authenticated nav');
  const appLinksBlock = appLinksMatch ? appLinksMatch[1] : '';
  const pricingOccurrences = (appLinksBlock.match(/label:'Pricing'/g) || []).length;
  assert(pricingOccurrences === 1, `Pricing appears exactly once in appLinks (found ${pricingOccurrences})`);
  assert(/label:'Dashboard'/.test(appLinksBlock) && /label:'Export Guides'/.test(appLinksBlock), 'Dashboard and Export Guides remain in the authenticated nav alongside Pricing');
  assert(
    /id="haAddCustomerDataCta"/.test(siteHeaderJs) && !/appLinksBlock.*Add Customer Data/.test(appLinksBlock),
    'Add Customer Data remains the dedicated teal CTA, rendered separately from the plain nav links array'
  );
}

// ---------------------------------------------------------------------------
// Required test 17: the shared authenticated footer includes Pricing,
// Export Guides, Upload Troubleshooting, Data Security, Privacy, Terms, and
// a Contact/Feedback route.
// ---------------------------------------------------------------------------
{
  const footerLinksMatch = siteHeaderJs.match(/const footerLinks=\[([\s\S]*?)\];/);
  assert(Boolean(footerLinksMatch), 'site-header.js defines a footerLinks array for the shared authenticated footer');
  const footerBlock = footerLinksMatch ? footerLinksMatch[1] : '';
  for(const required of ["label:'Pricing'", "label:'Export Guides'", "label:'Upload Troubleshooting'", "label:'Data Security'", "label:'Privacy'", "label:'Terms'", "label:'Contact / Feedback'"]){
    assert(footerBlock.includes(required), `footerLinks includes ${required}`);
  }
  for(const href of ['/pricing.html', '/export-guides/', '/export-guides/#troubleshooting', '/security.html', '/privacy.html', '/terms.html', '/contact.html']){
    assert(footerBlock.includes(`href:'${href}'`), `footerLinks uses the existing real route ${href} (no placeholder)`);
  }
}

// ---------------------------------------------------------------------------
// Required test 18: the dashboard heading row's right side is a compact
// trial-status pill plus the My View/Team View segmented control, with the
// standalone "Team View" heading and its explanatory line removed.
// ---------------------------------------------------------------------------
assert(
  !/id="dashboardViewTitle"/.test(dashboardHtml),
  'the standalone "Team View" heading (#dashboardViewTitle) has been removed from the dashboard heading row'
);
assert(
  !/id="dashboardTeamSnapshot"/.test(dashboardHtml),
  'the "Showing all organization recommendations" explanatory line (#dashboardTeamSnapshot) has been removed'
);
assert(
  !/\.team-snapshot-note\{/.test(dashboardHtml),
  'the now-dead .team-snapshot-note CSS rule has been removed'
);
assert(
  /<div class="dashboard-trial-status" id="dashboardTrialStatus">/.test(dashboardHtml),
  'the compact trial-status pill (#dashboardTrialStatus) remains in the heading row'
);
assert(
  /<div class="view-toggle-buttons" id="dashboardViewButtons" role="group" aria-label="Dashboard view">/.test(dashboardHtml),
  'the My View/Team View segmented control (#dashboardViewButtons) remains, with a group role/label for accessibility'
);
assert(
  /\.view-toggle-buttons\{\s*display:flex;\s*background:#F0F2F5;/.test(dashboardHtml) && /\.view-toggle-btn\.active\{\s*background:#fff;/.test(dashboardHtml),
  'the view switcher is styled as a true segmented control (shared background/border, active option highlighted)'
);
const renderSwitcherSrc = extractFn(DASHBOARD_SRC, 'renderDashboardViewSwitcher');
assert(
  !/hasCanonicalSnapshot|customerCount|prospectCount|dashboardTeamSnapshot/.test(renderSwitcherSrc),
  'renderDashboardViewSwitcher() no longer computes/writes the removed snapshot-description text'
);
assert(
  /canTeam/.test(renderSwitcherSrc),
  'renderDashboardViewSwitcher() preserves the existing canTeam permission gating for who can see the Team View option'
);

// ---------------------------------------------------------------------------
// Required test 19 & 20: the Pricing page bottom retains exactly the
// required content (Free/Solo $99/Team $299, one >25-users contact route,
// the shared footer) with the identified redundancy removed.
// ---------------------------------------------------------------------------
// Strip HTML comments before checking for redundant content -- the
// stabilization-round comment explaining what was removed necessarily
// mentions the old class name/text, and must not itself count as a
// leftover occurrence.
const pricingHtmlNoComments = pricingHtml.replace(/<!--[\s\S]*?-->/g, '');
assert(pricingHtml.includes('<div class="price">$0</div>'), 'pricing.html retains the Free ($0) plan card');
assert(pricingHtml.includes('<div class="price">$99'), 'pricing.html retains the Solo $99/mo plan card');
assert(pricingHtml.includes('<div class="price">$299'), 'pricing.html retains the Team $299/mo plan card');
{
  const contactRouteOccurrences = (pricingHtmlNoComments.match(/Need more than 25 users\?/g) || []).length;
  assert(contactRouteOccurrences === 1, `pricing.html has exactly one "Need more than 25 users? Contact us." route (found ${contactRouteOccurrences})`);
}
assert(!/class="pricing-trust"/.test(pricingHtml) && !/\.pricing-trust\{/.test(pricingHtml), 'pricing.html no longer has the redundant .pricing-trust callout box (its claim duplicated the hero lead and the Free card)');
assert(
  (pricingHtmlNoComments.match(/Need help choosing a plan\?/g) || []).length === 0,
  'pricing.html no longer has the second, redundant "Need help choosing a plan?" contact prompt directly beneath the required one'
);
assert(
  /<footer><div>House Accounts helps promotional products reps/.test(pricingHtml),
  'pricing.html retains its shared closing footer, unduplicated, directly after the single closing CTA'
);

// ---------------------------------------------------------------------------
// Required test 21: syntax/inline-script sanity on every file touched this
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
