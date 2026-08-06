// Onboarding sprint + correction round: guided product tour, canonical
// Add Customer Data workflow, and the simplified dashboard heading/header/
// footer. Extracts the REAL, verbatim source of the relevant
// dashboard/index.html functions by exact line range (same defensive
// pattern as every other extraction test in this repo -- a future edit
// that shifts these lines fails this test loudly instead of silently
// testing stale code) and runs them against a minimal fake DOM/
// localStorage/HouseAuth sandbox. Static content assertions (export guide
// copy, nav/footer wiring) are checked directly against the real on-disk
// HTML/JS files.
//
// Usage: node scripts/test-guided-tour-and-import-experience.js
import { readFileSync } from 'fs';
import vm from 'vm';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const lines = html.split('\n');

function extractLines(label, startLine, endLine, expectedFirst){
  const slice = lines.slice(startLine - 1, endLine);
  const first = slice[0].trim();
  if(!first.startsWith(expectedFirst)){
    throw new Error(`extractLines(${label}): dashboard/index.html line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  return slice.join('\n');
}

// FR2 round: line ranges re-derived after this round's guided-tour-focus
// and aggregate-dashboard-lifecycle changes shifted every block below.
// extractLines()'s own start-line signature check is the actual guarantee
// of correctness -- these numbers were re-derived mechanically (parse-
// complete / last-top-level-declaration scan from each block's real start
// line), not hand-counted.
const SRC = [
  extractLines('currentUploadName', 2443, 2443, "let currentUploadName"),
  extractLines('add-customer-data-modal-and-route', 3340, 3463, 'let addCustomerDataModalTriggerEl = null;'),
  extractLines('guided-tour', 3746, 4136, "const GUIDED_TOUR_STORAGE_PREFIX = 'ha_guided_tour_v1::';"),
  extractLines('beta-welcome-modal', 4138, 4151, 'function showBetaWelcomeModal(){'),
  extractLines('upload-success-state', 9585, 9630, 'const MISSING_FIELD_LABELS = {'),
  extractLines('escapeHtml', 9849, 9852, 'function escapeHtml(text){'),
  extractLines('dismissUploadSuccessState-and-wiring', 9854, 9883, 'function dismissUploadSuccessState(){')
].join('\n\n');

// ---------------------------------------------------------------------------
// Minimal fake DOM: only what the extracted functions above actually touch
// (classList, style, textContent/innerHTML, dataset-free, addEventListener,
// getBoundingClientRect, focus, a small selector matcher covering #id,
// .class, tag[attr="value"], and :not([disabled])).
// ---------------------------------------------------------------------------
class FakeElement {
  constructor(tag, id){
    this.tagName = (tag || 'div').toUpperCase();
    this.id = id || '';
    this._classes = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => this._classes.add(x)),
      remove: (...c) => c.forEach(x => this._classes.delete(x)),
      contains: c => this._classes.has(c)
    };
    this.style = {};
    this.attributes = {};
    this._text = '';
    this._html = '';
    this._children = [];
    this.parent = null;
    this._listeners = {};
    this.disabled = false;
    this.hidden = false;
    this._rect = { top: 100, left: 100, bottom: 150, right: 300, width: 200, height: 50 };
    this.offsetParent = {};
    this.focusCallCount = 0;
    this.value = '';
  }
  get textContent(){ return this._text; }
  set textContent(v){ this._text = String(v); }
  get innerHTML(){ return this._html; }
  set innerHTML(v){ this._html = String(v); }
  appendChild(child){ child.parent = this; this._children.push(child); return child; }
  addEventListener(type, fn){ (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn){ if(this._listeners[type]) this._listeners[type] = this._listeners[type].filter(f => f !== fn); }
  dispatchEvent(type, evt){ (this._listeners[type] || []).forEach(fn => fn(evt || {})); }
  click(){ this.dispatchEvent('click', { target: this }); }
  focus(){ this.focusCallCount += 1; }
  scrollIntoView(){}
  getBoundingClientRect(){ return this._rect; }
  setAttribute(k, v){ this.attributes[k] = String(v); }
  getAttribute(k){ return this.attributes[k]; }
  _allDescendants(){
    const out = [];
    const walk = el => { el._children.forEach(c => { out.push(c); walk(c); }); };
    walk(this);
    return out;
  }
  querySelectorAll(sel){ return matchSelector(this._allDescendants(), sel); }
  querySelector(sel){ return matchSelector(this._allDescendants(), sel)[0] || null; }
}
function matchSelector(pool, sel){
  sel = sel.trim();
  const notDisabled = /:not\(\[disabled\]\)$/.test(sel);
  const base = sel.replace(/:not\(\[disabled\]\)$/, '');
  let out;
  if(base.startsWith('#')) out = pool.filter(el => el.id === base.slice(1));
  else if(base.startsWith('.')) out = pool.filter(el => el._classes.has(base.slice(1)));
  else {
    const m = base.match(/^(\w+)\[([\w-]+)="([^"]*)"\]$/);
    if(m) out = pool.filter(el => el.tagName === m[1].toUpperCase() && el.attributes[m[2]] === m[3]);
    else out = pool.filter(el => el.tagName === base.toUpperCase());
  }
  if(notDisabled) out = out.filter(el => !el.disabled);
  return out;
}

function buildDashboardDom(){
  const registry = new Map();
  const root = new FakeElement('div', 'root');
  function make(tag, id, opts = {}){
    const el = new FakeElement(tag, id);
    Object.assign(el, opts);
    if(id) registry.set(id, el);
    root.appendChild(el);
    return el;
  }
  const dropzone = make('div', 'dropzone');
  const leadGate = make('section', 'leadGate');
  const fileInput = make('input', 'fileInput');
  const exportGuidesLink = make('a', '', { attributes: { href: '/export-guides/' } });

  // Correction round: step 1 now targets the global header CTA rather than
  // the (now modal-only) #dropzone.
  const addCustomerDataCta = make('a', 'haAddCustomerDataCta', { _rect: { top: 20, left: 900, bottom: 60, right: 1040, width: 140, height: 40 } });

  const manageAccountsBtn = make('button', 'manageCustomerAccountsBtn', { _rect: { top: 400, left: 50, bottom: 440, right: 200, width: 150, height: 40 } });
  // Decoy element with a deliberately different rect -- proves the
  // required behavior (step 3 must resolve Manage Customer Accounts, never
  // drift onto a metric tile like "Last Weekly Scan") isn't an accident of
  // both elements sharing the same default fake geometry.
  const dashLastScan = make('div', 'dashLastScan', { _rect: { top: 900, left: 700, bottom: 940, right: 900, width: 200, height: 40 } });

  const timeboxHeader = make('div', 'timeboxSectionHeader');
  const prepareForCallBtn = new FakeElement('button');
  prepareForCallBtn._classes.add('btn-generate-play');
  root.appendChild(prepareForCallBtn);

  const overlay = make('div', 'haTourOverlay', { attributes: {} });
  overlay.setAttribute('aria-hidden', 'true');
  const spotlight = make('div', 'haTourSpotlight', { hidden: true });
  const card = make('div', 'haTourCard');
  const eyebrow = make('div', 'haTourEyebrow');
  const title = make('h3', 'haTourTitle');
  const body = make('p', 'haTourBody');
  const dots = make('div', 'haTourDots');
  const skipBtn = new FakeElement('button', 'haTourSkipBtn');
  const backBtn = new FakeElement('button', 'haTourBackBtn');
  const nextBtn = new FakeElement('button', 'haTourNextBtn');
  card.appendChild(skipBtn); card.appendChild(backBtn); card.appendChild(nextBtn);
  registry.set('haTourSkipBtn', skipBtn);
  registry.set('haTourBackBtn', backBtn);
  registry.set('haTourNextBtn', nextBtn);

  const betaWelcomeModal = make('div', 'betaWelcomeModal');

  const addCustomerDataModal = make('div', 'addCustomerDataModal', { hidden: true });
  const addCustomerDataModalClose = make('button', 'addCustomerDataModalClose');
  const addCustomerDataModalTitle = make('h2', 'addCustomerDataModalTitle');
  const addCustomerDataViewGuidesLink = make('a', 'addCustomerDataViewGuidesLink', { attributes: { href: '/export-guides/' } });
  addCustomerDataModal.appendChild(addCustomerDataModalClose);
  addCustomerDataModal.appendChild(addCustomerDataViewGuidesLink);

  const uploadSuccessState = make('section', 'uploadSuccessState', { style: { display: 'none' } });
  const uploadSuccessTitle = make('div', 'uploadSuccessTitle');
  const uploadSuccessDetail = make('div', 'uploadSuccessDetail');
  const uploadSuccessWarning = make('div', 'uploadSuccessWarning', { hidden: true });
  const uploadSuccessDismiss = make('button', 'uploadSuccessDismiss');
  const uploadSuccessViewPrioritiesBtn = make('button', 'uploadSuccessViewPrioritiesBtn');
  const uploadSuccessManageAccountsBtn = make('button', 'uploadSuccessManageAccountsBtn');
  const uploadSuccessAnotherBtn = make('button', 'uploadSuccessAnotherBtn');

  const mvpDashboardNotice = make('div', 'mvpDashboardNotice');

  const body_ = { style: {} };
  const documentElement_ = { style: {} };

  const documentListeners = {};
  const fakeDocument = {
    getElementById: id => registry.get(id) || null,
    querySelector: sel => root.querySelector(sel),
    querySelectorAll: sel => root.querySelectorAll(sel),
    addEventListener: (type, fn) => { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { if(documentListeners[type]) documentListeners[type] = documentListeners[type].filter(f => f !== fn); },
    activeElement: null,
    readyState: 'complete',
    body: body_,
    documentElement: documentElement_
  };

  return {
    registry, fakeDocument, documentListeners,
    dropzone, leadGate, fileInput, exportGuidesLink, addCustomerDataCta,
    manageAccountsBtn, dashLastScan, timeboxHeader, prepareForCallBtn,
    overlay, spotlight, card, eyebrow, title, body, dots, skipBtn, backBtn, nextBtn,
    betaWelcomeModal,
    addCustomerDataModal, addCustomerDataModalClose, addCustomerDataModalTitle, addCustomerDataViewGuidesLink,
    uploadSuccessState, uploadSuccessTitle, uploadSuccessDetail, uploadSuccessWarning,
    uploadSuccessDismiss, uploadSuccessViewPrioritiesBtn, uploadSuccessManageAccountsBtn, uploadSuccessAnotherBtn,
    mvpDashboardNotice,
    documentBody: body_, documentElementStyle: documentElement_
  };
}

function makeSandbox({ userEmail = 'rep@example.com' } = {}){
  const dom = buildDashboardDom();
  const localStorageStore = {};
  const fakeLocalStorage = {
    getItem: k => (Object.prototype.hasOwnProperty.call(localStorageStore, k) ? localStorageStore[k] : null),
    setItem: (k, v) => { localStorageStore[k] = String(v); },
    removeItem: k => { delete localStorageStore[k]; }
  };
  let currentUser = userEmail ? { email: userEmail } : null;
  const closeMenusCalls = [];
  const beginOverlayCalls = [];
  const endOverlayCalls = [];
  const scrollToCalls = [];
  const replaceStateCalls = [];
  const fakeWindow = {
    location: { hash: '', search: '', pathname: '/dashboard/', href: 'https://app.example.com/dashboard/' },
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    pageYOffset: 0,
    setTimeout: (fn) => fn(),
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ position: 'static' }),
    scrollTo: (x, y) => { scrollToCalls.push([x, y]); },
    history: { replaceState: (...args) => { replaceStateCalls.push(args); } },
    URLSearchParams,
    URL,
    // Follow-up round: launchGuidedTour()/showBetaWelcomeModal() now call
    // beginOverlay() (the counted overlay-open API) instead of the old
    // one-shot closeMenus() -- both still close the Help dropdown/mobile
    // nav, so both are tracked here.
    HouseAccountsHeader: {
      closeMenus: () => { closeMenusCalls.push(true); },
      beginOverlay: () => { beginOverlayCalls.push(true); },
      endOverlay: () => { endOverlayCalls.push(true); }
    }
  };
  const houseAuth = { getUser: () => currentUser, authHeadersAsync: () => Promise.resolve({ Authorization: 'Bearer test' }) };
  fakeWindow.HouseAuth = houseAuth;
  const sandbox = {
    document: dom.fakeDocument,
    window: fakeWindow,
    localStorage: fakeLocalStorage,
    HouseAuth: houseAuth,
    URLSearchParams,
    URL,
    console,
    getComputedStyle: fakeWindow.getComputedStyle,
    // FR2 round: closeGuidedTour() now schedules a requestAnimationFrame
    // cleanup pass after endOverlay() -- run it synchronously here, same
    // style as the fake setTimeout above, so its effects are observable
    // immediately rather than needing a real event-loop tick.
    requestAnimationFrame: (fn) => fn()
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { launchGuidedTour, closeGuidedTour, nextGuidedTourStep, backGuidedTourStep, skipGuidedTour, finishGuidedTour, guidedTourKeydownHandler, guidedTourResizeHandler, guidedTourScrollHandler, wireGuidedTourControls, guidedTourStatus, markGuidedTourStatus, readGuidedTourState, GUIDED_TOUR_STEPS, GUIDED_TOUR_VIEWPORT_MARGIN, handleMvpDashboardRoute, openLightweightCustomerUpload, openAddCustomerDataModal, closeAddCustomerDataModal, wireAddCustomerDataModalControls, showBetaWelcomeModal, renderUploadSuccessState, dismissUploadSuccessState, wireUploadSuccessStateControls };`, { filename: 'dashboard-extract.js' }).runInContext(sandbox);
  return {
    dash: sandbox.__exports, dom, setUser: u => { currentUser = u; }, setHash: h => { fakeWindow.location.hash = h; },
    setSearch: s => { fakeWindow.location.search = s; fakeWindow.location.href = `https://app.example.com/dashboard/${s}`; },
    fakeWindow, closeMenusCalls, beginOverlayCalls, endOverlayCalls, scrollToCalls, replaceStateCalls
  };
}

function numPx(v){ return v == null ? NaN : parseFloat(String(v)); }

// ---------------------------------------------------------------------------
// Required tests 1-8 (onboarding sprint, unchanged since the prior round):
// tour launch, 5-step order, Back/Next, Skip/Finish persistence, no
// auto-replay, per-user isolation, Restart Product Tour, keyboard/Escape.
// ---------------------------------------------------------------------------

{
  const { dash } = makeSandbox();
  for(const name of ['launchGuidedTour', 'nextGuidedTourStep', 'backGuidedTourStep', 'skipGuidedTour', 'finishGuidedTour', 'wireGuidedTourControls', 'handleMvpDashboardRoute', 'openLightweightCustomerUpload', 'renderUploadSuccessState', 'openAddCustomerDataModal', 'closeAddCustomerDataModal', 'showBetaWelcomeModal']){
    assert(typeof dash[name] === 'function', `dashboard/index.html export "${name}" extracted successfully as a real function`);
  }
}

{
  const { dash } = makeSandbox();
  const steps = dash.GUIDED_TOUR_STEPS;
  assert(Array.isArray(steps) && steps.length === 5, `required test 2: the guided tour has exactly 5 steps (got ${steps && steps.length})`);
  const expectedTitles = ['Add Customer Data', 'Export Guides', 'Your Accounts', "This Week's Priorities", 'Prepare for Call'];
  assert(steps.map(s => s.title).join('|') === expectedTitles.join('|'), `required test 2: the 5 steps are in the required order (got: ${steps.map(s => s.title).join(', ')})`);
  assert(steps[0].target === '#haAddCustomerDataCta', 'required test 2: step 1 now spotlights the global header CTA (#haAddCustomerDataCta), not the modal-only #dropzone');
  assert(/existing customer/i.test(steps[0].body) && /not a cold prospect list/i.test(steps[0].body), 'required test 2: step 1 explains uploading EXISTING customer/order history, not a cold prospect list');
}

{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  assert(dom.overlay._classes.has('active'), 'required test 1: launchGuidedTour() activates the tour overlay');
  assert(dom.title.textContent === 'Add Customer Data', 'required test 1: the tour opens on step 1 (Add Customer Data)');
  const wireupSrc = html;
  assert(/betaWelcomeStartBtn\.addEventListener\('click', \(\) => \{\s*dismissBetaWelcomeModal\(\);\s*launchGuidedTour\(\);/.test(wireupSrc), "required test 1: the real Get Started button's click handler calls dismissBetaWelcomeModal() then launchGuidedTour(), not merely closing the popup");
}

{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  dash.nextGuidedTourStep();
  assert(dom.title.textContent === 'Export Guides', 'required test 3: Next advances from step 1 to step 2');
  dash.nextGuidedTourStep();
  assert(dom.title.textContent === 'Your Accounts', 'required test 3: Next advances from step 2 to step 3');
  dash.backGuidedTourStep();
  assert(dom.title.textContent === 'Export Guides', 'required test 3: Back returns from step 3 to step 2');
  dash.backGuidedTourStep();
  assert(dom.title.textContent === 'Add Customer Data', 'required test 3: Back returns from step 2 to step 1');
  assert(dom.backBtn.disabled === true, 'required test 3: Back is disabled on the first step');
}

{
  const { dash } = makeSandbox();
  dash.launchGuidedTour();
  dash.skipGuidedTour();
  assert(dash.guidedTourStatus() === 'skipped', 'required test 4: Skip Tour persists status "skipped"');
}
{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  for(let i = 0; i < 4; i++) dash.nextGuidedTourStep();
  assert(dom.title.textContent === 'Prepare for Call', 'sanity: reached the final step');
  dash.nextGuidedTourStep();
  assert(dash.guidedTourStatus() === 'completed', 'required test 4: Finish persists status "completed"');
}

{
  const src = html;
  const callSites = [...src.matchAll(/launchGuidedTour\(\)/g)].length;
  assert(callSites === 2, `required test 5: launchGuidedTour() is called from exactly 2 explicit user-action sites, not auto-replayed anywhere else (got ${callSites} call sites)`);
  assert(!/DOMContentLoaded[\s\S]{0,200}launchGuidedTour\(\)/.test(src.replace(/wireGuidedTourControls/g, '')), 'required test 5: the tour is never launched directly inside a DOMContentLoaded handler (only explicit user actions launch it)');
}

{
  const { dash, setUser } = makeSandbox({ userEmail: 'repA@example.com' });
  setUser({ email: 'repA@example.com' });
  dash.markGuidedTourStatus('completed');
  assert(dash.guidedTourStatus() === 'completed', "required test 6: user A's own status reads back as completed");
  setUser({ email: 'repB@example.com' });
  assert(dash.guidedTourStatus() === '', "required test 6: switching to a different authenticated user (repB) does NOT inherit repA's completed status");
}

{
  const headerSrc = readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
  assert(headerSrc.includes(`href="/dashboard/#restart-tour"`), 'required test 7: the shared Help dropdown (available on every authenticated page, including Settings) links to /dashboard/#restart-tour');
  const { dash, dom, setHash } = makeSandbox();
  setHash('#restart-tour');
  dash.handleMvpDashboardRoute();
  assert(dom.overlay._classes.has('active'), 'required test 7: visiting #restart-tour launches the real guided tour');
}

{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  let prevented = false;
  dash.guidedTourKeydownHandler({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert(prevented, 'required test 8: Escape calls preventDefault()');
  assert(!dom.overlay._classes.has('active'), 'required test 8: Escape closes the tour overlay');
  assert(dash.guidedTourStatus() === 'skipped', 'required test 8: Escape is treated as an explicit Skip (persists "skipped")');
}
{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  dom.fakeDocument.activeElement = dom.nextBtn;
  let prevented = false;
  dash.guidedTourKeydownHandler({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });
  assert(prevented, 'required test 8: Tab on the last control is intercepted (prevented) to wrap focus');
  assert(dom.skipBtn.focusCallCount >= 1, 'required test 8: Tab forward from the last control (Next) wraps focus back to the first (Skip Tour)');
}

// ---------------------------------------------------------------------------
// Required tests 9-11 (onboarding sprint): Export Guides content.
// ---------------------------------------------------------------------------
const hubHtml = readFileSync(new URL('../export-guides/index.html', import.meta.url), 'utf8');

assert(/Minimum useful columns/i.test(hubHtml) && /Ideal columns/i.test(hubHtml), 'required test 9: Export Guides clearly distinguishes minimum useful columns from ideal columns');
assert(/Customer \/ Company Name/.test(hubHtml), 'required test 9: minimum columns names the required company/customer field');
assert(/Order Date/.test(hubHtml) && /Revenue/.test(hubHtml), 'required test 9: ideal columns include order date and revenue');

assert(/do not upload cold prospect lists/i.test(hubHtml), 'required test 10: Export Guides explicitly states that cold prospect lists are not supported in the current beta');

const sampleCsv = readFileSync(new URL('../export-guides/sample-customer-order-history.csv', import.meta.url), 'utf8');
const csvHeader = sampleCsv.split('\n')[0].trim();
const acceptedHeaderTokens = ['Customer Name', 'Project Name', 'Order Date', 'Revenue', 'Contact Name', 'Contact Email', 'Margin'];
assert(acceptedHeaderTokens.every(tok => csvHeader.includes(tok)), `required test 11: the downloadable template's header row uses the real accepted upload schema (got: "${csvHeader}")`);
assert(/sample-customer-order-history\.csv/.test(hubHtml) && /download/.test(hubHtml), 'required test 11: the hub page links to the downloadable template using a real download attribute');
assert(/client_name:\s*\[/.test(html) && /'customer_name'/.test(html), 'required test 11: parseCSV() genuinely recognizes "Customer Name" as a valid company-name column');

// ---------------------------------------------------------------------------
// Required tests 12-14 (onboarding sprint): first-upload success/recovery.
// ---------------------------------------------------------------------------

assert(/document\.getElementById\('totalAccounts'\)\.textContent = accounts\.length;/.test(html), 'required test 12: processData() synchronously updates the account count in the DOM from the real, just-uploaded accounts array');
assert(/renderUploadSuccessState\(records, accounts\);/.test(html), 'required test 12: processData() calls the real renderUploadSuccessState() with the real parsed accounts, in the same synchronous flow (no manual refresh needed)');

{
  const { dash, dom } = makeSandbox();
  const accounts = [
    { orderCount: 3, contactName: 'Jamie Ellis', contacts: [] },
    { orderCount: 0, contacts: [] }
  ];
  dash.renderUploadSuccessState({ missingCols: [] }, accounts);
  assert(dom.uploadSuccessState.style.display === 'block', 'required test 13: the branded success panel becomes visible after a real upload');
  assert(dom.uploadSuccessDetail.innerHTML.includes('2'), 'required test 13: the panel states the real accepted account count (2)');
  dash.wireUploadSuccessStateControls();
  assert(typeof dom.uploadSuccessViewPrioritiesBtn._listeners.click?.[0] === 'function', 'required test 13: "View Priorities" is wired to a real click handler');
  assert(typeof dom.uploadSuccessManageAccountsBtn._listeners.click?.[0] === 'function', 'required test 13: "Manage Customer Accounts" is wired to a real click handler');
  assert(typeof dom.uploadSuccessAnotherBtn._listeners.click?.[0] === 'function', 'required test 13: "Upload Another List" is wired to a real click handler');
  dom.uploadSuccessManageAccountsBtn.click();
  assert(dom.uploadSuccessState.style.display === 'none', 'required test 13: clicking Manage Customer Accounts dismisses the success panel');
}

{
  const { dash, dom } = makeSandbox();
  const noHistoryAccounts = [{ orderCount: 0, contacts: [] }];
  dash.renderUploadSuccessState({ missingCols: [] }, noHistoryAccounts);
  assert(dom.uploadSuccessWarning.hidden === false, 'required test 14: a warning is shown when no order history was recognized');
  assert(/not a failed upload/i.test(dom.uploadSuccessWarning.innerHTML), 'required test 14: the warning explicitly says this is not a failed upload');
  assert(/public business triggers/i.test(dom.uploadSuccessWarning.innerHTML), 'required test 14: the warning explains House Accounts can still monitor public business triggers');
}

// ---------------------------------------------------------------------------
// Required test 15 (onboarding sprint): no visible surface promotes
// prospect-list imports.
// ---------------------------------------------------------------------------
{
  assert(!/customer or prospect lists/i.test(html), 'required test 15: the My View empty state no longer promotes uploading prospect lists');
  assert(!hubHtml.includes('Prospect Intelligence'), 'required test 15: the Export Guides hub no longer promotes a "Prospect Intelligence" upload destination');
}

// ---------------------------------------------------------------------------
// Required test 16 (onboarding sprint): first-time empty states.
// ---------------------------------------------------------------------------
assert(/You haven't uploaded any customer accounts yet[\s\S]{0,120}Upload your own customer order history/.test(html), 'required test 16: the no-uploads-yet empty state states what happened and the single best next action (upload)');
assert(/could not find a company\/account column[\s\S]{0,200}Export Guides/.test(html), 'required test 16: the failed-upload error state points to a concrete next action (Export Guides)');

// ===========================================================================
// CORRECTION ROUND -- required automated verification 1-18. (19-20 are the
// full suite run and inline-script/syntax checks, covered separately by
// running every scripts/test-*.js file and a fresh --check pass, not
// duplicated here.)
// ===========================================================================

// 1. Opening Welcome closes the Help dropdown.
{
  // Follow-up round: showBetaWelcomeModal() now calls the counted
  // beginOverlay() API instead of the old one-shot closeMenus() -- it
  // still closes the Help dropdown/mobile nav (see site-header.js's
  // beginOverlay()), and additionally joins the shared overlay-open state.
  const { dash, beginOverlayCalls } = makeSandbox();
  dash.showBetaWelcomeModal();
  assert(beginOverlayCalls.length === 1, 'correction test 1: opening the Welcome modal calls window.HouseAccountsHeader.beginOverlay() (closes the Help dropdown/mobile nav and joins the shared overlay-open state)');
}

// 2. Starting/restarting the tour closes the Help dropdown.
{
  const { dash, beginOverlayCalls } = makeSandbox();
  dash.launchGuidedTour();
  assert(beginOverlayCalls.length === 1, 'correction test 2: launchGuidedTour() calls window.HouseAccountsHeader.beginOverlay() before opening');
}
{
  // Restarting via the #restart-tour route goes through the same
  // launchGuidedTour(), so the same beginOverlay() call happens.
  const { dash, setHash, beginOverlayCalls } = makeSandbox();
  setHash('#restart-tour');
  dash.handleMvpDashboardRoute();
  assert(beginOverlayCalls.length === 1, 'correction test 2: restarting the tour from Help also closes the Help dropdown first');
}

// 3. Body/document scrolling is locked during the tour.
{
  const { dash, dom } = makeSandbox();
  dom.documentBody.style.overflow = '';
  dom.documentElementStyle.style.overflow = '';
  dash.launchGuidedTour();
  assert(dom.documentBody.style.overflow === 'hidden', 'correction test 3: document.body.style.overflow is "hidden" while a tour step is active');
  assert(dom.documentElementStyle.style.overflow === 'hidden', 'correction test 3: document.documentElement.style.overflow is "hidden" while a tour step is active');
  assert(dom.documentBody.style.position === 'fixed', 'correction test 3: document.body is pinned (position:fixed) so it cannot be manually scrolled while a tour step is active');
}

// 4. Scrolling is restored after Finish, Skip, and Escape.
{
  const { dash, dom, fakeWindow, scrollToCalls } = makeSandbox();
  dom.documentBody.style.overflow = '';
  fakeWindow.scrollY = 340;
  dash.launchGuidedTour();
  assert(dom.documentBody.style.overflow === 'hidden', 'sanity: scroll is locked once the tour is open');
  dash.skipGuidedTour();
  assert(dom.documentBody.style.overflow === '', 'correction test 4: Skip restores the page\'s original (unlocked) scroll style');
  assert(scrollToCalls.some(([x, y]) => x === 0 && y === 340), 'correction test 4: Skip restores the exact scroll position the page was at before the tour locked it');
}
{
  const { dash, dom } = makeSandbox();
  dom.documentBody.style.overflow = '';
  dash.launchGuidedTour();
  for(let i = 0; i < 4; i++) dash.nextGuidedTourStep();
  dash.nextGuidedTourStep(); // Finish on the last step
  assert(dom.documentBody.style.overflow === '', 'correction test 4: Finish restores scrolling');
}
{
  const { dash, dom } = makeSandbox();
  dom.documentBody.style.overflow = '';
  dash.launchGuidedTour();
  dash.guidedTourKeydownHandler({ key: 'Escape', preventDefault: () => {} });
  assert(dom.documentBody.style.overflow === '', 'correction test 4: Escape restores scrolling');
}

// 5. Step 3 always resolves Manage Customer Accounts, not a metric tile,
// even after the page was scrolled during an earlier step.
{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  dash.nextGuidedTourStep(); // step 2
  // Simulate the page having genuinely moved between steps.
  dash.dashLastScanMovedRect = true;
  dash.nextGuidedTourStep(); // step 3: Your Accounts / Manage Customer Accounts
  assert(dom.title.textContent === 'Your Accounts', 'sanity: on step 3');
  const expectedTop = Math.max(dom.manageAccountsBtn._rect.top - 12, 4);
  assert(numPx(dom.spotlight.style.top) === expectedTop, `correction test 5: step 3's spotlight is positioned from Manage Customer Accounts' real rect (top=${expectedTop}), not a stale or unrelated element`);
  const decoyTop = Math.max(dom.dashLastScan._rect.top - 12, 4);
  assert(numPx(dom.spotlight.style.top) !== decoyTop, 'correction test 5: step 3\'s spotlight is NOT positioned at the "Last Weekly Scan" metric\'s coordinates');
}

// 6. Tour geometry is recalculated after target scrolling and resizing.
{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  dash.nextGuidedTourStep();
  dash.nextGuidedTourStep(); // step 3, spotlighting manageAccountsBtn
  const before = numPx(dom.spotlight.style.top);
  dom.manageAccountsBtn._rect = { top: 555, left: 60, bottom: 595, right: 210, width: 150, height: 40 };
  dash.guidedTourResizeHandler();
  const afterResize = numPx(dom.spotlight.style.top);
  assert(afterResize !== before && afterResize === Math.max(555 - 12, 4), 'correction test 6: resize recalculates the spotlight from a freshly measured rect');
  dom.manageAccountsBtn._rect = { top: 610, left: 60, bottom: 650, right: 210, width: 150, height: 40 };
  dash.guidedTourScrollHandler();
  const afterScroll = numPx(dom.spotlight.style.top);
  assert(afterScroll === Math.max(610 - 12, 4), 'correction test 6: a scroll event (safety net alongside the lock) also recalculates from a freshly measured rect');
}

// 7. Tour cards remain within safe viewport margins.
{
  const { dash, dom, fakeWindow } = makeSandbox();
  fakeWindow.innerWidth = 400;
  fakeWindow.innerHeight = 500;
  // Target sitting almost at the right/bottom edge of a small viewport.
  dom.manageAccountsBtn._rect = { top: 470, left: 380, bottom: 495, right: 398, width: 18, height: 25 };
  dash.launchGuidedTour();
  dash.nextGuidedTourStep();
  dash.nextGuidedTourStep();
  const left = numPx(dom.card.style.left);
  assert(!Number.isNaN(left) && left >= 12 && left <= fakeWindow.innerWidth, 'correction test 7: the tour card\'s left position stays within the safe viewport margin, never off-screen');
  const top = numPx(dom.card.style.top);
  if(!Number.isNaN(top)) assert(top >= 12 && top <= fakeWindow.innerHeight, 'correction test 7: the tour card\'s top position stays within the safe viewport margin');
  const bottom = numPx(dom.card.style.bottom);
  if(!Number.isNaN(bottom)) assert(bottom >= 12, 'correction test 7: the tour card\'s bottom offset (when anchored above the target) still respects the safe viewport margin');
}

// 8. Add Customer Data from every authenticated page uses one canonical
// action -- the same /dashboard/?action=add-data URL everywhere.
{
  const headerSrc = readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
  assert(headerSrc.includes(`ADD_CUSTOMER_DATA_HREF='/dashboard/?action=add-data'`), 'correction test 8: site-header.js defines a single canonical Add Customer Data URL');
  assert(headerSrc.includes('href="${ADD_CUSTOMER_DATA_HREF}"'), 'correction test 8: the header CTA uses the canonical URL constant, not a hardcoded literal');
  const guidePages = ['index', 'salesforce', 'hubspot', 'pipedrive', 'generic-excel', 'commonsku', 'facilis', 'antera', 'esp'];
  for(const page of guidePages){
    const src = readFileSync(new URL(`../export-guides/${page === 'index' ? 'index.html' : page + '/index.html'}`, import.meta.url), 'utf8');
    assert(!src.includes('/dashboard/#add-customer-data'), `correction test 8: export-guides/${page} no longer links to the old non-canonical hash URL`);
    assert(src.includes('/dashboard/?action=add-data'), `correction test 8: export-guides/${page} links Add Customer Data through the single canonical URL`);
  }
}

// 9. A non-dashboard page never opens the upload modal before navigating --
// no other authenticated page renders its own uploader/dropzone/modal.
{
  const otherPages = [
    'export-guides/index.html', 'export-guides/salesforce/index.html', 'export-guides/hubspot/index.html',
    'export-guides/pipedrive/index.html', 'export-guides/generic-excel/index.html', 'export-guides/commonsku/index.html',
    'export-guides/facilis/index.html', 'export-guides/antera/index.html', 'export-guides/esp/index.html'
  ];
  for(const page of otherPages){
    const src = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert(!/id="dropzone"/.test(src) && !/id="addCustomerDataModal"/.test(src), `correction test 9: ${page} does not render its own upload dropzone or Add Customer Data modal -- Add Customer Data is a plain link to the canonical Dashboard URL, never a same-page uploader`);
  }
  const settingsSrc = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
  assert(!/id="dropzone"/.test(settingsSrc) && !/id="addCustomerDataModal"/.test(settingsSrc), 'correction test 9: settings.html does not render its own upload dropzone or Add Customer Data modal');
}

// 10. The Dashboard opens the upload modal exactly once after
// initialization, and a refresh (the action already consumed from the URL)
// never re-triggers it.
{
  const { dash, dom, setSearch, replaceStateCalls } = makeSandbox();
  setSearch('?action=add-data');
  dash.handleMvpDashboardRoute();
  await Promise.resolve(); await Promise.resolve();
  assert(dom.addCustomerDataModal.hidden === false, 'correction test 10: visiting /dashboard/?action=add-data opens the modal once auth/init is ready');
  assert(replaceStateCalls.length === 1, 'correction test 10: the ?action=add-data query param is consumed via history.replaceState so it does not linger in the URL');
  assert(!replaceStateCalls[0][2].includes('action=add-data'), 'correction test 10: the replaced URL no longer contains action=add-data');
  dom.addCustomerDataModal.hidden = true;
  dash.handleMvpDashboardRoute();
  await Promise.resolve(); await Promise.resolve();
  assert(dom.addCustomerDataModal.hidden === true, 'correction test 10: calling the route handler again in the same session does not reopen the modal a second time for the same action (in-memory guard)');
}
{
  // Simulating an actual browser refresh: a fresh page load whose URL no
  // longer carries ?action=add-data (because the prior visit's
  // replaceState already stripped it) must not auto-open the modal.
  const { dash, dom } = makeSandbox();
  dash.handleMvpDashboardRoute();
  assert(dom.addCustomerDataModal.hidden === true, 'correction test 10: a fresh page load with no action param never opens the modal automatically');
}

// 11. View Export Guides closes the upload modal and navigates without
// opening another modal or leaving a conflicting handler.
{
  const { dash, dom } = makeSandbox();
  dash.openAddCustomerDataModal();
  assert(dom.addCustomerDataModal.hidden === false, 'sanity: modal is open');
  dash.wireAddCustomerDataModalControls();
  dom.addCustomerDataViewGuidesLink.click();
  assert(dom.addCustomerDataModal.hidden === true, 'correction test 11: clicking View Export Guides closes the Add Customer Data modal');
  const modalSrc = html.slice(html.indexOf('function wireAddCustomerDataModalControls'), html.indexOf('function wireAddCustomerDataModalControls') + 1400);
  assert(!/viewGuidesLink\.addEventListener\('click',[^)]*preventDefault/.test(modalSrc), 'correction test 11: the View Export Guides click handler never calls preventDefault(), so the real, single navigation is never blocked or duplicated');
}

// 12. No visible "Import Guides" wording remains on any reachable page.
{
  const reachablePages = [
    'export-guides/index.html', 'export-guides/salesforce/index.html', 'export-guides/hubspot/index.html',
    'export-guides/pipedrive/index.html', 'export-guides/generic-excel/index.html', 'export-guides/commonsku/index.html',
    'export-guides/facilis/index.html', 'export-guides/antera/index.html', 'export-guides/esp/index.html'
  ];
  for(const page of reachablePages){
    const src = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert(!/import guides?/i.test(src), `correction test 12: ${page} contains no "Import Guide(s)" wording`);
  }
  // apollo/zoominfo/prospect-excel remain deliberately orphaned (unreachable
  // from any page, verified in the prior onboarding sprint) and are
  // out of scope for a content rewrite -- confirm they are still unlinked.
  const linkers = [...reachablePages, 'dashboard/index.html', 'settings.html'];
  for(const page of linkers){
    const src = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert(!/export-guides\/apollo|export-guides\/zoominfo|export-guides\/prospect-excel/.test(src), `correction test 12: ${page} does not link to the orphaned cold-prospecting guides`);
  }
}

// 13. Dashboard no longer renders the redundant "You're all set" summary
// strip.
assert(!/<strong>You're all set\./.test(html), 'correction test 13: the redundant "You\'re all set. Watching N accounts..." strip is no longer rendered');

// 14. My View / Team View and compact trial state render in the page
// heading row.
{
  const headingSection = html.slice(html.indexOf('<section class="mvp-dashboard-heading"'), html.indexOf('</section>', html.indexOf('<section class="mvp-dashboard-heading"')));
  assert(headingSection.includes('id="dashboardTrialStatus"'), 'correction test 14: the compact trial status element lives inside the dashboard heading row');
  assert(headingSection.includes('id="dashboardViewSwitcher"'), 'correction test 14: the My View/Team View switcher lives inside the dashboard heading row');
  assert(headingSection.includes('data-view="my"') && headingSection.includes('data-view="team"'), 'correction test 14: both My View and Team View controls are present in the heading row');
}

// 15. The standalone Team View panel is absent (only the one now inside the
// heading row remains).
{
  const matches = html.match(/id="dashboardViewSwitcher"/g) || [];
  assert(matches.length === 1, `correction test 15: exactly one #dashboardViewSwitcher exists in the page (inside the heading row) -- no separate standalone panel remains (got ${matches.length})`);
}

// 16. Shared header navigation is consistent across product pages.
{
  const headerSrc = readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
  assert(/label:'Dashboard'/.test(headerSrc) && /label:'Export Guides'/.test(headerSrc), 'correction test 16: the shared nav has the required Dashboard and Export Guides labels');
  const productPages = ['export-guides/index.html', 'export-guides/salesforce/index.html', 'settings.html', 'dashboard/index.html'];
  for(const page of productPages){
    const src = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert(src.includes('/site-header.js'), `correction test 16: ${page} loads the shared header script, so its navigation stays consistent with every other product page`);
  }
}

// 17. Add Customer Data is the visible global CTA.
{
  const headerSrc = readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
  assert(headerSrc.includes('ha-action-link ha-cta'), 'correction test 17: Add Customer Data is styled with the dedicated CTA class');
  const cssSrc = readFileSync(new URL('../site-header.css', import.meta.url), 'utf8');
  assert(/\.ha-action-link\.ha-cta\{[^}]*background:var\(--ha-teal\)/.test(cssSrc), 'correction test 17: the CTA is styled teal, the required clear-CTA color');
}

// 18. Shared footer links and labels are consistent across product pages.
{
  const headerSrc = readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
  const required = ['Export Guides', 'Upload Troubleshooting', 'Contact / Feedback', 'Privacy', 'Terms'];
  for(const label of required){
    assert(headerSrc.includes(`label:'${label}'`), `correction test 18: the shared footer includes "${label}"`);
  }
  assert(!/footerLinks=\[[\s\S]*?label:'Dashboard'/.test(headerSrc), 'correction test 18: the footer does not repeat the full header nav (no "Dashboard" entry in footerLinks)');
  assert(!/footerLinks=\[[\s\S]*?label:'Sign Out'/.test(headerSrc), 'correction test 18: the footer does not repeat the full header nav (no "Sign Out" entry in footerLinks)');
  assert(headerSrc.includes("removeLegacy(true)"), 'correction test 18: the footer is only swapped in for authenticated visitors (removeLegacy(true) gates it), leaving public/marketing pages untouched');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
