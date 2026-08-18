// Account Expansion / Whitespace Intelligence -- matrix presentation
// (Buying Center x Offering). Replaces the earlier two-list chip view --
// see BACKLOG.md's "Account Expansion / Whitespace Intelligence / Growth
// Map" entry. Extracts the REAL, verbatim source of
// computeAccountWhitespaceMatrix()/the render functions/the localStorage
// confirmation helpers (plus their real dependencies -- departmentFromText(),
// hasOrderHistoryEvidence(), escapeHtml()) via the shared semantic
// extractor and runs them in a vm sandbox with a fake localStorage/
// HouseAuth, matching the established pattern in
// scripts/test-guided-tour-and-import-experience.js.
//
// Doctrine under test:
//   - Covered requires SAME-ROW co-occurrence (a transaction-evidenced
//     row with both a classifiable department and a matching category)
//     -- never two independent account-level facts stitched together.
//   - Known-relationship context lives on the ROW label, never painted
//     across a whole row's cells.
//   - Only 'covered' and 'whitespace' ever render from real evidence --
//     'not_applicable'/'active_play' have reserved markup but are never
//     assigned by computeAccountWhitespaceMatrix().
//   - Real, unattributed category purchases render in a separate panel
//     outside the organizational grid, never as a fake buying-center row.
//   - Zero buying-center evidence (real Production data's current shape)
//     renders the lightweight mapping prompt, not a near-empty matrix.
//   - The mapping-prompt confirmation is client-local (localStorage)
//     only -- fails safe on corrupt/missing storage, never crashes.
//
// Usage: node scripts/test-account-whitespace-intelligence-slice1.js
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

const SRC = [
  extractFn(DASHBOARD_SRC, 'departmentFromText'),
  extractFn(DASHBOARD_SRC, 'hasOrderHistoryEvidence'),
  extractFn(DASHBOARD_SRC, 'escapeHtml'),
  extractRange(DASHBOARD_SRC, 'const WHITESPACE_DEPARTMENTS', 'function getOpportunityType(account, signalBased=false){')
].join('\n\n');

const EXPORT_NAMES = [
  'departmentFromText', 'hasOrderHistoryEvidence', 'escapeHtml',
  'WHITESPACE_DEPARTMENTS', 'WHITESPACE_CATEGORIES', 'contactIsTransactionLinked',
  'computeAccountWhitespaceMatrix', 'renderWhitespaceCell', 'renderWhitespaceMatrix',
  'renderWhitespaceMappingPrompt', 'renderUnattributedPurchasesPanel', 'renderAccountWhitespaceSection',
  'whitespaceMapStorageKey', 'readWhitespaceMapConfirmations', 'writeWhitespaceMapConfirmations', 'toggleWhitespaceMapConfirmation'
];

function makeSandbox(){
  const store = {};
  const fakeLocalStorage = {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  // document.addEventListener is stubbed as a no-op -- the click-delegated
  // confirm/correct wiring at the end of the extracted range is exercised
  // via direct calls to toggleWhitespaceMapConfirmation()/
  // renderAccountWhitespaceSection() below, not via a simulated DOM click.
  const sandbox = { window: {}, document: { addEventListener(){} }, localStorage: fakeLocalStorage, HouseAuth: { getUser: () => ({ id: 'user-1', email: 'rep@example.com' }) } };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'whitespace-matrix-extract.js' }).runInContext(sandbox);
  return { dash: sandbox.__exports, store };
}

{
  const { dash } = makeSandbox();
  for(const name of EXPORT_NAMES){
    assert(typeof dash[name] !== 'undefined', `dashboard/index.html export "${name}" extracted successfully`);
  }
}

// ===========================================================================
// 1. Taxonomy -- unchanged from the prior slice.
// ===========================================================================
{
  const { dash } = makeSandbox();
  assert(Array.isArray(dash.WHITESPACE_DEPARTMENTS) && dash.WHITESPACE_DEPARTMENTS.length === 7, 'REQUIRED: the department taxonomy has the expected 7 buying centers');
  assert(Array.isArray(dash.WHITESPACE_CATEGORIES) && dash.WHITESPACE_CATEGORIES.length === 11 && !dash.WHITESPACE_CATEGORIES.includes('Uncategorized'), 'REQUIRED: the category taxonomy has the expected 11 offerings, excluding "Uncategorized"');
}

// ===========================================================================
// 2. computeAccountWhitespaceMatrix() -- same-row co-occurrence only.
// ===========================================================================
{
  const { dash } = makeSandbox();
  const account = {
    contacts: [
      { name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager', department: 'HR' },
      { name: 'John Roe', email: 'john@acme.com', title: 'Marketing Director', department: '' }
    ],
    allRecords: [
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Onboarding / Recruiting', revenue: 500, project: 'Welcome Kits', dateStr: '2025-01-01', status: '' },
      { contactName: 'John Roe', contactEmail: 'john@acme.com', contactTitle: 'Marketing Director', contactDepartment: '', category: '', revenue: 0, project: '', dateStr: '', status: '' },
      { contactName: '', contactEmail: '', contactTitle: '', contactDepartment: '', category: 'Apparel', revenue: 800, project: 'Field Jackets', dateStr: '2025-03-14', status: 'Closed' }
    ],
    categoryTypes: ['Onboarding / Recruiting', 'Apparel']
  };
  const matrix = dash.computeAccountWhitespaceMatrix(account, []);
  assert(matrix.hasAnyBuyingCenterEvidence === true, 'REQUIRED: an account with a known contact classified into a buying center has buying-center evidence');
  const hr = matrix.rows.find(r => r.center === 'HR / People');
  const hrOnboarding = hr.cells[dash.WHITESPACE_CATEGORIES.indexOf('Onboarding / Recruiting')];
  assert(hrOnboarding.status === 'covered', `REQUIRED: HR/People x Onboarding/Recruiting is covered -- same-row department+category+evidence (got ${hrOnboarding.status})`);
  assert(hr.cells.filter(c => c.status === 'covered').length === 1, 'REQUIRED: exactly ONE covered cell in the HR row -- covered evidence never spreads to every category just because the department is known');
  assert(hr.metaLine === 'Jane Doe · known contact', `REQUIRED: HR/People row label carries the real known-contact name (got "${hr.metaLine}")`);
  const marketing = matrix.rows.find(r => r.center === 'Marketing');
  assert(marketing.cells.every(c => c.status === 'whitespace'), 'REQUIRED: Marketing has a known contact but NO linked order -- every cell stays whitespace, never painted covered/known across the row');
  assert(marketing.metaLine === 'John Roe · known contact', 'REQUIRED: Marketing row label still carries the real known-contact name even though no cell is covered');
  const procurement = matrix.rows.find(r => r.center === 'Procurement');
  assert(procurement.metaLine === '' && procurement.cells.every(c => c.status === 'whitespace'), 'REQUIRED: a buying center with zero evidence has no row label and every cell is whitespace, never a claim of confirmed absence');
  assert(matrix.unattributed.includes('Apparel') && !matrix.unattributed.includes('Onboarding / Recruiting'), `REQUIRED: Apparel (real purchase, no attributable department) is unattributed; Onboarding/Recruiting (linked) is not (got ${JSON.stringify(matrix.unattributed)})`);
}
{
  // Two different real order rows: one has BOTH a department and a
  // category on it, the OTHER independently has an unrelated department.
  // A cell must never be covered merely because "an HR contact exists
  // somewhere AND an Apparel purchase exists somewhere" on DIFFERENT rows.
  const { dash } = makeSandbox();
  const account = {
    contacts: [{ name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager', department: 'HR' }],
    allRecords: [
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: '', revenue: 500, project: 'HR Consulting Fee', dateStr: '2025-01-01', status: '' },
      { contactName: '', contactEmail: '', contactTitle: '', contactDepartment: '', category: 'Apparel', revenue: 800, project: 'Field Jackets', dateStr: '2025-03-14', status: 'Closed' }
    ],
    categoryTypes: ['Apparel']
  };
  const matrix = dash.computeAccountWhitespaceMatrix(account, []);
  const hr = matrix.rows.find(r => r.center === 'HR / People');
  assert(hr.cells.every(c => c.status === 'whitespace'), 'REQUIRED: no cell is covered when the department-carrying row and the category-carrying row are DIFFERENT rows -- cross-row inference is never allowed');
  assert(matrix.unattributed.includes('Apparel'), 'REQUIRED: the Apparel purchase still surfaces as unattributed, not silently dropped');
}
{
  // Malformed/empty input fails safe.
  const { dash } = makeSandbox();
  const matrix = dash.computeAccountWhitespaceMatrix({}, null);
  assert(matrix.hasAnyBuyingCenterEvidence === false && matrix.rows.length === 7 && matrix.unattributed.length === 0, 'a malformed/empty account never throws -- resolves to a full, empty, no-evidence matrix');
}

// ===========================================================================
// 3. Rendering -- only covered/whitespace ever appear from real data;
//    not_applicable/active_play markup exists but is unreachable.
// ===========================================================================
{
  const { dash } = makeSandbox();
  assert(/class="ws-cell covered"/.test(dash.renderWhitespaceCell({ status: 'covered' })), 'covered cell renders the covered class');
  assert(/class="ws-cell whitespace"/.test(dash.renderWhitespaceCell({ status: 'whitespace' })), 'whitespace cell renders the whitespace class, no icon');
  assert(!/[✓?●◐◎]/.test(dash.renderWhitespaceCell({ status: 'whitespace' })), 'REQUIRED: a whitespace cell has no icon/mark -- meaning comes from styling alone');
  assert(/N\/A/.test(dash.renderWhitespaceCell({ status: 'not_applicable' })) && /class="ws-cell not-applicable"/.test(dash.renderWhitespaceCell({ status: 'not_applicable' })), 'REQUIRED: reserved not_applicable markup uses explicit "N/A" text, not a mystery icon, for when a later slice starts assigning it');
  assert(/EXPAND/.test(dash.renderWhitespaceCell({ status: 'active_play' })), 'REQUIRED: reserved active_play markup uses explicit "EXPAND" text, not a mystery icon');
}
{
  const { dash } = makeSandbox();
  const account = {
    contacts: [{ name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager', department: 'HR' }],
    allRecords: [{ contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Onboarding / Recruiting', revenue: 500, project: 'Welcome Kits', dateStr: '2025-01-01', status: '' }],
    categoryTypes: ['Onboarding / Recruiting']
  };
  const html = dash.renderAccountWhitespaceSection(account);
  assert(/Account Whitespace/.test(html), 'REQUIRED: the rendered section has the Account Whitespace heading');
  assert(/See where you have business today.*room to grow/.test(html), 'REQUIRED: the subtitle matches the approved copy');
  assert(!/whitespace-legend|ws-legend/i.test(html), 'REQUIRED: no legend block is rendered');
  assert(/ws-matrix/.test(html) && !/ws-map-prompt/.test(html), 'REQUIRED: an account with real buying-center evidence renders the matrix, not the mapping prompt');
}
{
  const { dash } = makeSandbox();
  const html = dash.renderAccountWhitespaceSection({ name: 'Acme Corp', contacts: [], allRecords: [], categoryTypes: [] });
  assert(/data-account-name="Acme Corp"/.test(html), 'REQUIRED: the section carries the real account name for the click handler to target');
  assert(/ws-map-prompt/.test(html) && !/ws-matrix/.test(html), 'REQUIRED: zero buying-center evidence renders the lightweight mapping prompt, not a near-empty matrix');
  assert(/Help House Accounts map this customer/.test(html), 'REQUIRED: the mapping prompt has the approved headline');
  assert(/Which parts of this account do you currently have relationships with/.test(html), 'REQUIRED: the mapping prompt has the approved subcopy');
  for(const center of dash.WHITESPACE_DEPARTMENTS){
    assert(html.includes(`data-buying-center="${center}"`), `REQUIRED: the mapping prompt offers a chip for "${center}"`);
  }
}
{
  const { dash } = makeSandbox();
  const account = {
    name: 'Acme Corp',
    contacts: [],
    allRecords: [{ contactName: '', contactEmail: '', contactTitle: '', contactDepartment: '', category: 'Apparel', revenue: 800, project: 'Field Jackets', dateStr: '2025-03-14', status: 'Closed' }],
    categoryTypes: ['Apparel']
  };
  const html = dash.renderAccountWhitespaceSection(account);
  assert(/Account-wide purchases not yet attributed/.test(html), 'REQUIRED: an unattributed real purchase renders its own panel, outside the organizational grid');
  assert(/>Apparel</.test(html), 'REQUIRED: the unattributed panel names the real category');
  assert(!/Unassigned \/ Unknown Buying Center/.test(html), 'REQUIRED: unattributed purchases are never rendered as if they were another buying-center row');
}
{
  const { dash } = makeSandbox();
  const html = dash.renderAccountWhitespaceSection({ name: 'Empty Co', contacts: [], allRecords: [], categoryTypes: [] });
  assert(!/Account-wide purchases not yet attributed/.test(html), 'an account with zero purchase evidence at all shows no unattributed panel (nothing to show)');
}

// ===========================================================================
// 4. Client-local mapping-prompt confirmations -- fail-safe, never a
//    durable/server claim.
// ===========================================================================
{
  const { dash } = makeSandbox();
  const next = dash.toggleWhitespaceMapConfirmation('Acme Corp', 'HR / People');
  assert(Array.isArray(next) && next.includes('HR / People'), 'REQUIRED: toggling a buying center on for the first time adds it');
  assert(dash.readWhitespaceMapConfirmations('Acme Corp').includes('HR / People'), 'REQUIRED: the confirmation round-trips through storage');
  const after = dash.toggleWhitespaceMapConfirmation('Acme Corp', 'HR / People');
  assert(!after.includes('HR / People'), 'REQUIRED: toggling the same buying center again removes it -- a rep can correct a misclick');
}
{
  const { dash } = makeSandbox();
  dash.toggleWhitespaceMapConfirmation('Acme Corp', 'Marketing');
  assert(dash.readWhitespaceMapConfirmations('Beta Co').length === 0, 'REQUIRED: confirmations are scoped per account -- a different account name never sees another account\'s confirmations');
}
{
  const { dash, store } = makeSandbox();
  const key = dash.whitespaceMapStorageKey('Acme Corp');
  store[key] = 'not valid json{{{';
  assert(JSON.stringify(dash.readWhitespaceMapConfirmations('Acme Corp')) === '[]', 'REQUIRED: corrupt stored data fails safe to no confirmations, never throws');
}
{
  const { dash, store } = makeSandbox();
  const key = dash.whitespaceMapStorageKey('Acme Corp');
  store[key] = JSON.stringify(['HR / People', 'Not A Real Center']);
  assert(JSON.stringify(dash.readWhitespaceMapConfirmations('Acme Corp')) === '["HR / People"]', 'REQUIRED: a stale/unknown buying-center name from a taxonomy change is silently dropped, never crashes or renders an unlabeled chip');
}
{
  // The confirmation actually flips an account from "insufficient" to
  // "sufficient" on the very next render -- the real end-to-end doctrine
  // requirement ("HA builds the map wherever it has evidence; the rep
  // supplies only small corrections").
  const { dash } = makeSandbox();
  const account = { name: 'Acme Corp', contacts: [], allRecords: [], categoryTypes: [] };
  const before = dash.renderAccountWhitespaceSection(account);
  assert(/ws-map-prompt/.test(before), 'before confirming, the account shows the mapping prompt');
  dash.toggleWhitespaceMapConfirmation('Acme Corp', 'Marketing');
  const after = dash.renderAccountWhitespaceSection(account);
  assert(/ws-matrix/.test(after) && !/ws-map-prompt/.test(after), 'REQUIRED: after a rep confirms one buying center, the SAME account now renders the matrix, not the prompt, on next render');
  assert(/Rep-confirmed relationship/.test(after), 'REQUIRED: the confirmed row shows "Rep-confirmed relationship" metadata, distinguishable from a real known-contact name');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
