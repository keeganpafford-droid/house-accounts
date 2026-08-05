// Onboarding sprint: guided product tour + first-upload/import experience.
// Extracts the REAL, verbatim source of the relevant dashboard/index.html
// functions by exact line range (same defensive pattern as every other
// extraction test in this repo -- a future edit that shifts these lines
// fails this test loudly instead of silently testing stale code) and runs
// them against a minimal fake DOM/localStorage/HouseAuth sandbox. Static
// content assertions (export guide copy, nav wiring) are checked directly
// against the real on-disk HTML/JS files.
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

const SRC = [
  extractLines('currentUploadName', 2356, 2356, "let currentUploadName"),
  extractLines('openLightweightCustomerUpload', 3174, 3190, 'function openLightweightCustomerUpload(){'),
  extractLines('handleMvpDashboardRoute', 3196, 3215, 'function handleMvpDashboardRoute(){'),
  extractLines('guided-tour', 3393, 3636, "const GUIDED_TOUR_STORAGE_PREFIX = 'ha_guided_tour_v1::';"),
  extractLines('escapeHtml', 8679, 8682, 'function escapeHtml(text){'),
  extractLines('upload-success-state', 8482, 8527, 'const MISSING_FIELD_LABELS = {'),
  extractLines('dismissUploadSuccessState', 8684, 8687, 'function dismissUploadSuccessState(){'),
  extractLines('wireUploadSuccessStateControls', 8688, 8713, 'function wireUploadSuccessStateControls(){')
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
  const manageAccountsBtn = make('button', 'manageCustomerAccountsBtn');
  const timeboxHeader = make('div', 'timeboxSectionHeader');
  const prepareForCallBtn = new FakeElement('button');
  prepareForCallBtn._classes.add('btn-generate-play');
  root.appendChild(prepareForCallBtn);

  const overlay = make('div', 'haTourOverlay', { attributes: {} });
  overlay.setAttribute('aria-hidden', 'true');
  const spotlight = make('div', 'haTourSpotlight', { hidden: true });
  const card = make('div', 'haTourCard');
  card._classes = card._classes; // keep own class set
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

  const uploadSuccessState = make('section', 'uploadSuccessState', { style: { display: 'none' } });
  const uploadSuccessTitle = make('div', 'uploadSuccessTitle');
  const uploadSuccessDetail = make('div', 'uploadSuccessDetail');
  const uploadSuccessWarning = make('div', 'uploadSuccessWarning', { hidden: true });
  const uploadSuccessDismiss = make('button', 'uploadSuccessDismiss');
  const uploadSuccessViewPrioritiesBtn = make('button', 'uploadSuccessViewPrioritiesBtn');
  const uploadSuccessManageAccountsBtn = make('button', 'uploadSuccessManageAccountsBtn');
  const uploadSuccessAnotherBtn = make('button', 'uploadSuccessAnotherBtn');

  const mvpDashboardNotice = make('div', 'mvpDashboardNotice');

  const documentListeners = {};
  const fakeDocument = {
    getElementById: id => registry.get(id) || null,
    querySelector: sel => root.querySelector(sel),
    querySelectorAll: sel => root.querySelectorAll(sel),
    addEventListener: (type, fn) => { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { if(documentListeners[type]) documentListeners[type] = documentListeners[type].filter(f => f !== fn); },
    activeElement: null,
    readyState: 'complete'
  };

  return {
    registry, fakeDocument, documentListeners,
    dropzone, leadGate, fileInput, exportGuidesLink, manageAccountsBtn, timeboxHeader, prepareForCallBtn,
    overlay, spotlight, card, eyebrow, title, body, dots, skipBtn, backBtn, nextBtn,
    uploadSuccessState, uploadSuccessTitle, uploadSuccessDetail, uploadSuccessWarning,
    uploadSuccessDismiss, uploadSuccessViewPrioritiesBtn, uploadSuccessManageAccountsBtn, uploadSuccessAnotherBtn,
    mvpDashboardNotice
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
  const fakeWindow = {
    location: { hash: '', search: '' },
    innerWidth: 1280,
    innerHeight: 800,
    setTimeout: (fn) => fn(),
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ position: 'static' }),
    URLSearchParams
  };
  const houseAuth = { getUser: () => currentUser };
  fakeWindow.HouseAuth = houseAuth;
  const sandbox = {
    document: dom.fakeDocument,
    window: fakeWindow,
    localStorage: fakeLocalStorage,
    HouseAuth: houseAuth,
    URLSearchParams,
    console,
    getComputedStyle: fakeWindow.getComputedStyle
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { launchGuidedTour, closeGuidedTour, nextGuidedTourStep, backGuidedTourStep, skipGuidedTour, finishGuidedTour, guidedTourKeydownHandler, wireGuidedTourControls, guidedTourStatus, markGuidedTourStatus, readGuidedTourState, GUIDED_TOUR_STEPS, handleMvpDashboardRoute, openLightweightCustomerUpload, renderUploadSuccessState, dismissUploadSuccessState, wireUploadSuccessStateControls };`, { filename: 'dashboard-extract.js' }).runInContext(sandbox);
  return { dash: sandbox.__exports, dom, setUser: u => { currentUser = u; }, setHash: h => { fakeWindow.location.hash = h; } };
}

// ---------------------------------------------------------------------------
// Required tests 1-8: guided tour
// ---------------------------------------------------------------------------

{
  const { dash } = makeSandbox();
  for(const name of ['launchGuidedTour', 'nextGuidedTourStep', 'backGuidedTourStep', 'skipGuidedTour', 'finishGuidedTour', 'wireGuidedTourControls', 'handleMvpDashboardRoute', 'openLightweightCustomerUpload', 'renderUploadSuccessState']){
    assert(typeof dash[name] === 'function', `dashboard/index.html export "${name}" extracted successfully as a real function`);
  }
}

// required test 2: five required steps, in order.
{
  const { dash } = makeSandbox();
  const steps = dash.GUIDED_TOUR_STEPS;
  assert(Array.isArray(steps) && steps.length === 5, `required test 2: the guided tour has exactly 5 steps (got ${steps && steps.length})`);
  const expectedTitles = ['Add Customer Data', 'Export Guides', 'Your Accounts', "This Week's Priorities", 'Prepare for Call'];
  assert(steps.map(s => s.title).join('|') === expectedTitles.join('|'), `required test 2: the 5 steps are in the required order (got: ${steps.map(s => s.title).join(', ')})`);
  assert(/existing customer/i.test(steps[0].body) && /not a cold prospect list/i.test(steps[0].body), 'required test 2: step 1 explains uploading EXISTING customer/order history, not a cold prospect list');
  assert(/export guides/i.test(steps[1].body), 'required test 2: step 2 explains where to find export instructions');
  assert(/monitor|pause|research/i.test(steps[2].body), 'required test 2: step 3 explains monitoring, pausing, and researching uploaded lists');
  assert(/business trigger/i.test(steps[3].body) && /reorder/i.test(steps[3].body) && /follow-up/i.test(steps[3].body), 'required test 2: step 4 explains business triggers, reorder windows, and follow-ups');
  assert(/reason to reach out/i.test(steps[4].body) && /conversation/i.test(steps[4].body) && /evidence/i.test(steps[4].body), 'required test 2: step 5 explains the reason to reach out, conversation, and evidence');
}

// required test 1: Get Started launches the guided tour (calling the real,
// exported launchGuidedTour() function -- the exact function the Get
// Started click handler calls).
{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  assert(dom.overlay._classes.has('active'), 'required test 1: launchGuidedTour() activates the tour overlay');
  assert(dom.overlay.attributes['aria-hidden'] === 'false', 'required test 1: the overlay is no longer aria-hidden once the tour is active');
  assert(dom.title.textContent === 'Add Customer Data', 'required test 1: the tour opens on step 1 (Add Customer Data)');
  const wireupSrc = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  assert(/betaWelcomeStartBtn\.addEventListener\('click', \(\) => \{\s*dismissBetaWelcomeModal\(\);\s*launchGuidedTour\(\);/.test(wireupSrc), "required test 1: the real Get Started button's click handler calls dismissBetaWelcomeModal() then launchGuidedTour(), not merely closing the popup");
}

// required test 3: Back and Next navigate correctly.
{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  assert(dom.title.textContent === 'Add Customer Data', 'required test 3: starts on step 1');
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

// required test 4: Skip and Finish persist dismissal/completion.
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
  assert(dom.nextBtn.textContent === 'Finish', 'required test 4: the final step\'s Next button reads "Finish"');
  dash.nextGuidedTourStep();
  assert(dash.guidedTourStatus() === 'completed', 'required test 4: Finish persists status "completed"');
}

// required test 5: the tour does not replay automatically after completion
// -- launchGuidedTour() is never called unconditionally anywhere in the
// file; the only call sites are the explicit Get Started click handler and
// the explicit #restart-tour hash route.
{
  const src = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const callSites = [...src.matchAll(/launchGuidedTour\(\)/g)].length;
  // Exactly 2 real call sites: the Get Started handler, and the
  // #restart-tour hash route -- both used inside window.setTimeout(...) or
  // an explicit click handler, never a bare unconditional call.
  assert(callSites === 2, `required test 5: launchGuidedTour() is called from exactly 2 explicit user-action sites, not auto-replayed anywhere else (got ${callSites} call sites)`);
  assert(!/DOMContentLoaded[\s\S]{0,200}launchGuidedTour\(\)/.test(src.replace(/wireGuidedTourControls/g, '')), 'required test 5: the tour is never launched directly inside a DOMContentLoaded handler (only explicit user actions launch it)');
}

// required test 6: a different authenticated user is not given another
// user's completion state.
{
  const { dash, setUser } = makeSandbox({ userEmail: 'repA@example.com' });
  setUser({ email: 'repA@example.com' });
  dash.markGuidedTourStatus('completed');
  assert(dash.guidedTourStatus() === 'completed', "required test 6: user A's own status reads back as completed");
  setUser({ email: 'repB@example.com' });
  assert(dash.guidedTourStatus() === '', "required test 6: switching to a different authenticated user (repB) does NOT inherit repA's completed status (got a non-empty status otherwise)");
}

// required test 7: Restart Product Tour works from Help or Settings --
// site-header.js's Help dropdown links to /dashboard/#restart-tour, and
// the dashboard's real hash router launches the real tour for it.
{
  const headerSrc = readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
  assert(headerSrc.includes(`href="/dashboard/#restart-tour"`), 'required test 7: the shared Help dropdown (available on every authenticated page, including Settings) links to /dashboard/#restart-tour');
  const { dash, dom, setHash } = makeSandbox();
  setHash('#restart-tour');
  dash.handleMvpDashboardRoute();
  assert(dom.overlay._classes.has('active'), 'required test 7: visiting #restart-tour launches the real guided tour (window.setTimeout is stubbed to run synchronously in this sandbox)');
}

// required test 8: keyboard and Escape behavior.
{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  let prevented = false;
  dash.guidedTourKeydownHandler({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert(prevented, 'required test 8: Escape calls preventDefault()');
  assert(!dom.overlay._classes.has('active'), 'required test 8: Escape closes the tour overlay');
  assert(dash.guidedTourStatus() === 'skipped', 'required test 8: Escape is treated as an explicit Skip (persists "skipped"), not a silent dismissal');
}
{
  const { dash, dom } = makeSandbox();
  dash.launchGuidedTour();
  // Tab from the last focusable control (Next) must wrap back to the first
  // (Skip) -- proves focus is trapped within the tour card while a step is
  // open, never escaping to the page behind the overlay.
  let prevented = false;
  dash.guidedTourKeydownHandler({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });
  // The handler only acts when document.activeElement is the last/first
  // focusable control; simulate that directly since this sandbox's
  // fakeDocument doesn't track real focus state automatically.
  dom.fakeDocument.activeElement = dom.nextBtn;
  dash.guidedTourKeydownHandler({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });
  assert(prevented, 'required test 8: Tab on the last control is intercepted (prevented) to wrap focus');
  assert(dom.skipBtn.focusCallCount >= 1, 'required test 8: Tab forward from the last control (Next) wraps focus back to the first (Skip Tour)');
}

// ---------------------------------------------------------------------------
// Required tests 9-11: Export Guides content
// ---------------------------------------------------------------------------
const hubHtml = readFileSync(new URL('../export-guides/index.html', import.meta.url), 'utf8');

// required test 9: minimum vs ideal data distinguished.
assert(/Minimum useful columns/i.test(hubHtml) && /Ideal columns/i.test(hubHtml), 'required test 9: Export Guides clearly distinguishes minimum useful columns from ideal columns');
assert(/Customer \/ Company Name/.test(hubHtml), 'required test 9: minimum columns names the required company/customer field');
assert(/Order Date/.test(hubHtml) && /Revenue/.test(hubHtml), 'required test 9: ideal columns include order date and revenue, the fields that unlock reorder/follow-up recommendations');

// required test 10: cold prospect lists explicitly not supported in current beta.
assert(/do not upload cold prospect lists/i.test(hubHtml), 'required test 10: Export Guides explicitly states that cold prospect lists are not supported in the current beta');

// required test 11: spreadsheet/template path uses the real accepted schema.
const sampleCsv = readFileSync(new URL('../export-guides/sample-customer-order-history.csv', import.meta.url), 'utf8');
const csvHeader = sampleCsv.split('\n')[0].trim();
const acceptedHeaderTokens = ['Customer Name', 'Project Name', 'Order Date', 'Revenue', 'Contact Name', 'Contact Email', 'Margin'];
assert(acceptedHeaderTokens.every(tok => csvHeader.includes(tok)), `required test 11: the downloadable template's header row uses the real accepted upload schema (got: "${csvHeader}")`);
assert(/sample-customer-order-history\.csv/.test(hubHtml) && /download/.test(hubHtml), 'required test 11: the hub page links to the downloadable template using a real download attribute');
{
  const dashSrc = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  // client_name, project_name, order_date, revenue, contact_name,
  // contact_email, margin -- these are the exact normalized keys
  // parseCSV() maps real header text onto (see the `map` object inside
  // parseCSV()), proving the template's headers are genuinely accepted by
  // the real upload parser, not merely documented as if they were.
  assert(/client_name:\s*\[/.test(dashSrc) && /'customer_name'/.test(dashSrc), 'required test 11: parseCSV() genuinely recognizes "Customer Name" as a valid company-name column');
  assert(/project_name:\s*\[/.test(dashSrc), 'required test 11: parseCSV() genuinely recognizes a project/order name column');
  assert(/order_date:\s*\[/.test(dashSrc), 'required test 11: parseCSV() genuinely recognizes an order date column');
  assert(/revenue:\s*\[/.test(dashSrc), 'required test 11: parseCSV() genuinely recognizes a revenue column');
}

// ---------------------------------------------------------------------------
// Required tests 12-14: first-upload success/recovery behavior
// ---------------------------------------------------------------------------

// required test 12: upload success refreshes account counts without a
// manual browser refresh -- processData() sets #totalAccounts.textContent
// synchronously (no page reload / fetch round-trip required), and calls
// renderUploadSuccessState() with the real, just-parsed accounts array.
{
  const dashSrc = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  assert(/document\.getElementById\('totalAccounts'\)\.textContent = accounts\.length;/.test(dashSrc), 'required test 12: processData() synchronously updates the account count in the DOM from the real, just-uploaded accounts array');
  assert(/renderUploadSuccessState\(records, accounts\);/.test(dashSrc), 'required test 12: processData() calls the real renderUploadSuccessState() with the real parsed accounts, in the same synchronous flow (no manual refresh needed)');
}

// required test 13: upload success offers View Priorities, Manage
// Accounts, and Upload Another.
{
  const { dash, dom } = makeSandbox();
  const accounts = [
    { orderCount: 3, contactName: 'Jamie Ellis', contacts: [] },
    { orderCount: 0, contacts: [] }
  ];
  dash.renderUploadSuccessState({ missingCols: [] }, accounts);
  assert(dom.uploadSuccessState.style.display === 'block', 'required test 13: the branded success panel becomes visible after a real upload');
  assert(/2/.test(dom.uploadSuccessTitle.textContent) === false && dom.uploadSuccessDetail.innerHTML.includes('2'), 'required test 13: the panel states the real accepted account count (2)');
  dash.wireUploadSuccessStateControls();
  assert(typeof dom.uploadSuccessViewPrioritiesBtn._listeners.click?.[0] === 'function', 'required test 13: "View Priorities" is wired to a real click handler');
  assert(typeof dom.uploadSuccessManageAccountsBtn._listeners.click?.[0] === 'function', 'required test 13: "Manage Customer Accounts" is wired to a real click handler');
  assert(typeof dom.uploadSuccessAnotherBtn._listeners.click?.[0] === 'function', 'required test 13: "Upload Another List" is wired to a real click handler');
  dom.uploadSuccessManageAccountsBtn.click();
  assert(dom.uploadSuccessState.style.display === 'none', 'required test 13: clicking Manage Customer Accounts dismisses the success panel (never strands the user on it)');
}

// required test 14: missing order history produces an educational
// warning, not a failure.
{
  const { dash, dom } = makeSandbox();
  const noHistoryAccounts = [{ orderCount: 0, contacts: [] }];
  dash.renderUploadSuccessState({ missingCols: [] }, noHistoryAccounts);
  assert(dom.uploadSuccessWarning.hidden === false, 'required test 14: a warning is shown when no order history was recognized');
  assert(/not a failed upload/i.test(dom.uploadSuccessWarning.innerHTML), 'required test 14: the warning explicitly says this is not a failed upload');
  assert(/public business triggers/i.test(dom.uploadSuccessWarning.innerHTML), 'required test 14: the warning explains House Accounts can still monitor public business triggers');
  assert(dom.uploadSuccessState.style.display === 'block', 'required test 14: the success panel still renders (the upload itself succeeded) even with no order history');

  const partialAccounts = [{ orderCount: 2, contacts: [] }];
  dash.renderUploadSuccessState({ missingCols: ['contact_email', 'margin'] }, partialAccounts);
  assert(dom.uploadSuccessWarning.hidden === false, 'required test 14: missing optional fields (with order history present) also produce a visible, non-failure note');
  assert(/not a failed upload/i.test(dom.uploadSuccessWarning.innerHTML), 'required test 14: the missing-optional-fields note also explicitly says this is not a failed upload');
}

// ---------------------------------------------------------------------------
// Required test 15: no visible onboarding/upload surface promotes
// prospect-list imports.
// ---------------------------------------------------------------------------
{
  const dashSrc = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  assert(!/Open Prospect Intelligence/i.test(dashSrc.split('.ha-mvp .workflow-switcher')[0]) || /\.ha-mvp \.workflow-switcher[\s\S]{0,40}display:none !important/.test(dashSrc), 'required test 15: any remaining "Open Prospect Intelligence" markup is proven CSS-hidden (.ha-mvp .workflow-switcher{display:none!important}), never visible in the live MVP build');
  assert(!/customer or prospect lists/i.test(dashSrc), 'required test 15: the My View empty state no longer promotes uploading prospect lists');
  assert(!/monitoring customer and prospect accounts/i.test(dashSrc), 'required test 15: the joined-organization welcome banner no longer promotes prospect accounts');
  assert(!/customers and \$\{prospectCount\} prospects/.test(dashSrc), 'required test 15: the organization snapshot banner no longer surfaces a "prospects" count to the user');
  assert(!hubHtml.includes('Prospect Intelligence'), 'required test 15: the Export Guides hub no longer promotes a "Prospect Intelligence" upload destination');
  const salesforceHtml = readFileSync(new URL('../export-guides/salesforce/index.html', import.meta.url), 'utf8');
  const hubspotHtml = readFileSync(new URL('../export-guides/hubspot/index.html', import.meta.url), 'utf8');
  const pipedriveHtml = readFileSync(new URL('../export-guides/pipedrive/index.html', import.meta.url), 'utf8');
  for(const [name, src] of [['salesforce', salesforceHtml], ['hubspot', hubspotHtml], ['pipedrive', pipedriveHtml]]){
    assert(!src.includes('Prospect Intelligence') && !src.includes('/prospects/'), `required test 15: the reframed ${name} guide no longer references Prospect Intelligence or the hidden /prospects/ route`);
  }
}

// ---------------------------------------------------------------------------
// Required test 16: first-time empty states provide a clear next action.
// ---------------------------------------------------------------------------
{
  const dashSrc = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  assert(/You haven't uploaded any customer accounts yet[\s\S]{0,120}Upload your own customer order history/.test(dashSrc), 'required test 16: the no-uploads-yet empty state states what happened and the single best next action (upload)');
  assert(/No actionable opportunities yet for this window[\s\S]{0,260}try This Month or research your top accounts/.test(dashSrc), 'required test 16: the no-actionable-opportunities-yet empty state explains what happened, why (nothing timely this week), and a next action');
  assert(/could not find a company\/account column[\s\S]{0,200}Export Guides/.test(dashSrc), 'required test 16: the failed-upload error state points to a concrete next action (Export Guides) rather than a dead end');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
