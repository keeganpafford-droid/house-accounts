// Account Expansion / Whitespace Intelligence -- matrix presentation
// (Buying Center x Offering) with durable, organization-scoped
// confirmation persistence. See BACKLOG.md's "Account Expansion /
// Whitespace Intelligence / Growth Map" entry. Extracts the REAL,
// verbatim source of computeAccountWhitespaceMatrix()/the render
// functions/the durable-confirmation client helpers (plus their real
// dependencies -- departmentFromText(), hasOrderHistoryEvidence(),
// escapeHtml(), normalizeCompanyNameForLimit()) via the shared semantic
// extractor and runs them in a vm sandbox with a fake fetch/HouseAuth,
// matching the established pattern in
// scripts/test-guided-tour-and-import-experience.js.
//
// Doctrine under test:
//   - A cell reaches covered only when a transaction-evidenced,
//     department-classified contact's OWN evidenced rows span EXACTLY
//     ONE category -- a contact repeated across multiple categories
//     (the real-export shape the founder flagged) never backs a
//     specific cell, even though it still contributes real row-level
//     "known relationship" metadata.
//   - Known-relationship context lives on the ROW label, never painted
//     across a whole row's cells.
//   - Only 'covered' and 'whitespace' ever render from real evidence --
//     'not_applicable'/'active_play' have reserved markup but are never
//     assigned by computeAccountWhitespaceMatrix().
//   - Real, unattributed category purchases render in a separate panel
//     outside the organizational grid, never as a fake buying-center row.
//   - Zero buying-center evidence renders the lightweight mapping prompt.
//   - Confirmations are durable/organization-scoped via api/whitespace-map.js
//     (fetch), never localStorage -- the client caches the server's
//     response and only ever trusts the server's authoritative return
//     value after a toggle.
//   - Sticky first column / fixed (never shrinking) column widths in CSS.
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
  extractFn(DASHBOARD_SRC, 'normalizeCompanyNameForLimit'),
  extractRange(DASHBOARD_SRC, 'const WHITESPACE_DEPARTMENTS', 'function getOpportunityType(account, signalBased=false){')
].join('\n\n');

const EXPORT_NAMES = [
  'departmentFromText', 'hasOrderHistoryEvidence', 'escapeHtml', 'normalizeCompanyNameForLimit',
  'WHITESPACE_DEPARTMENTS', 'WHITESPACE_CATEGORIES', 'contactIsTransactionLinked',
  'computeAccountWhitespaceMatrix', 'renderWhitespaceCell', 'renderWhitespaceMatrix',
  'renderWhitespaceMappingPrompt', 'renderUnattributedPurchasesPanel', 'renderAccountWhitespaceSection',
  'loadWhitespaceConfirmations', 'confirmedCentersForAccount', 'toggleWhitespaceMapConfirmation'
];

function makeSandbox({ fetchImpl, hasAuth = true } = {}){
  const calls = [];
  const fetchFn = fetchImpl || (async () => ({ ok: true, json: async () => ({ ok: true, confirmations: {} }) }));
  // The real code checks `window.HouseAuth && HouseAuth.authHeadersAsync`
  // -- in a real browser `window` IS the global object, so the bare
  // identifier and the window-qualified one are the same reference. This
  // sandbox mirrors that aliasing explicitly (a plain vm sandbox does not
  // do it automatically), matching the same fix this exact class of bug
  // required elsewhere in this test suite.
  const houseAuth = hasAuth ? { authHeadersAsync: async (extra) => ({ ...extra, Authorization: 'Bearer test-token' }) } : undefined;
  const sandbox = {
    window: { HouseAuth: houseAuth },
    document: { addEventListener(){} },
    console,
    HouseAuth: houseAuth,
    fetch: async (url, opts) => { calls.push({ url, opts }); return fetchFn(url, opts); }
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'whitespace-matrix-extract.js' }).runInContext(sandbox);
  return { dash: sandbox.__exports, calls };
}

{
  const { dash } = makeSandbox();
  for(const name of EXPORT_NAMES){
    assert(typeof dash[name] !== 'undefined', `dashboard/index.html export "${name}" extracted successfully`);
  }
}

// ===========================================================================
// 1. Taxonomy -- unchanged.
// ===========================================================================
{
  const { dash } = makeSandbox();
  assert(Array.isArray(dash.WHITESPACE_DEPARTMENTS) && dash.WHITESPACE_DEPARTMENTS.length === 7, 'REQUIRED: the department taxonomy has the expected 7 buying centers');
  assert(Array.isArray(dash.WHITESPACE_CATEGORIES) && dash.WHITESPACE_CATEGORIES.length === 11 && !dash.WHITESPACE_CATEGORIES.includes('Uncategorized'), 'REQUIRED: the category taxonomy has the expected 11 offerings, excluding "Uncategorized"');
}

// ===========================================================================
// 2. computeAccountWhitespaceMatrix() -- corrected source-semantics
//    discipline: a contact must be genuinely discriminating (evidenced
//    against exactly one category) to back a covered cell.
// ===========================================================================
{
  // The exact real-world failure mode the founder flagged: one HR contact
  // repeated across Apparel, Onboarding, and Drinkware rows. This must
  // NEVER produce a covered cell for any of those categories -- only
  // row-level "known relationship" metadata.
  const { dash } = makeSandbox();
  const account = {
    contacts: [{ name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager', department: 'HR' }],
    allRecords: [
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Apparel', revenue: 500, project: 'Jackets', dateStr: '2025-01-01', status: '' },
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Onboarding / Recruiting', revenue: 300, project: 'Welcome Kits', dateStr: '2025-02-01', status: '' },
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Drinkware', revenue: 150, project: 'Mugs', dateStr: '2025-03-01', status: '' }
    ],
    categoryTypes: ['Apparel', 'Onboarding / Recruiting', 'Drinkware']
  };
  const matrix = dash.computeAccountWhitespaceMatrix(account, []);
  const hr = matrix.rows.find(r => r.center === 'HR / People');
  assert(hr.cells.every(c => c.status === 'whitespace'), 'REQUIRED: a contact repeated across multiple categories never backs ANY covered cell -- this is the real-export "static account contact" shape, not genuine per-purchase evidence');
  assert(hr.metaLine === 'Jane Doe · known contact', 'REQUIRED: the repeated contact still produces real row-level known-relationship metadata, even though no cell is covered');
  assert(matrix.unattributed.length === 3 && ['Apparel','Onboarding / Recruiting','Drinkware'].every(c => matrix.unattributed.includes(c)), `REQUIRED: all three real purchases fall to unattributed since none has genuinely discriminating evidence (got ${JSON.stringify(matrix.unattributed)})`);
}
{
  // The positive case: a contact evidenced against exactly ONE category
  // IS genuinely discriminating and should still produce a covered cell.
  const { dash } = makeSandbox();
  const account = {
    contacts: [{ name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager', department: 'HR' }],
    allRecords: [
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Onboarding / Recruiting', revenue: 500, project: 'Welcome Kits A', dateStr: '2025-01-01', status: '' },
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Onboarding / Recruiting', revenue: 300, project: 'Welcome Kits B', dateStr: '2025-06-01', status: '' }
    ],
    categoryTypes: ['Onboarding / Recruiting']
  };
  const matrix = dash.computeAccountWhitespaceMatrix(account, []);
  const hr = matrix.rows.find(r => r.center === 'HR / People');
  const onboarding = hr.cells[dash.WHITESPACE_CATEGORIES.indexOf('Onboarding / Recruiting')];
  assert(onboarding.status === 'covered', `REQUIRED: a contact evidenced against exactly one category (even across multiple orders) is genuinely discriminating and reaches covered (got ${onboarding.status})`);
  assert(matrix.unattributed.length === 0, 'REQUIRED: the covered category is not also listed as unattributed');
}
{
  // Two DIFFERENT contacts in the same department: one narrow (covers a
  // cell), one repeated/general (does not) -- each evaluated independently.
  const { dash } = makeSandbox();
  const account = {
    contacts: [
      { name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager', department: 'HR' },
      { name: 'Sam Reed', email: 'sam@acme.com', title: 'HR Coordinator', department: 'HR' }
    ],
    allRecords: [
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Onboarding / Recruiting', revenue: 500, project: 'Welcome Kits', dateStr: '2025-01-01', status: '' },
      { contactName: 'Sam Reed', contactEmail: 'sam@acme.com', contactTitle: 'HR Coordinator', contactDepartment: 'HR', category: 'Apparel', revenue: 200, project: 'Shirts', dateStr: '2025-02-01', status: '' },
      { contactName: 'Sam Reed', contactEmail: 'sam@acme.com', contactTitle: 'HR Coordinator', contactDepartment: 'HR', category: 'Safety', revenue: 100, project: 'Vests', dateStr: '2025-03-01', status: '' }
    ],
    categoryTypes: ['Onboarding / Recruiting', 'Apparel', 'Safety']
  };
  const matrix = dash.computeAccountWhitespaceMatrix(account, []);
  const hr = matrix.rows.find(r => r.center === 'HR / People');
  assert(hr.cells[dash.WHITESPACE_CATEGORIES.indexOf('Onboarding / Recruiting')].status === 'covered', 'REQUIRED: the narrow contact (Jane Doe, one category) still covers her cell, unaffected by the other contact in the same department');
  assert(hr.cells[dash.WHITESPACE_CATEGORIES.indexOf('Apparel')].status === 'whitespace' && hr.cells[dash.WHITESPACE_CATEGORIES.indexOf('Safety')].status === 'whitespace', 'REQUIRED: the repeated contact (Sam Reed, two categories) covers neither of his cells');
  assert(hr.metaLine.includes('known contact'), 'sanity: row-level metadata still reflects real known contacts');
}
{
  // Cross-row inference is still never allowed (regression from the prior
  // same-row-only rule).
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
  assert(hr.cells.every(c => c.status === 'whitespace'), 'REQUIRED: no cell is covered when the department-carrying row and the category-carrying row are DIFFERENT rows');
  assert(matrix.unattributed.includes('Apparel'), 'REQUIRED: the Apparel purchase still surfaces as unattributed');
}
{
  const { dash } = makeSandbox();
  const matrix = dash.computeAccountWhitespaceMatrix({}, null);
  assert(matrix.hasAnyBuyingCenterEvidence === false && matrix.rows.length === 7 && matrix.unattributed.length === 0, 'a malformed/empty account never throws -- resolves to a full, empty, no-evidence matrix');
}

// ===========================================================================
// 3. Rendering -- only covered/whitespace ever appear from real data.
// ===========================================================================
{
  const { dash } = makeSandbox();
  assert(/class="ws-cell covered"/.test(dash.renderWhitespaceCell({ status: 'covered' })), 'covered cell renders the covered class');
  assert(/class="ws-cell whitespace"/.test(dash.renderWhitespaceCell({ status: 'whitespace' })), 'whitespace cell renders the whitespace class, no icon');
  assert(!/[✓?●◐◎]/.test(dash.renderWhitespaceCell({ status: 'whitespace' })), 'REQUIRED: a whitespace cell has no icon/mark -- meaning comes from styling alone');
  assert(/N\/A/.test(dash.renderWhitespaceCell({ status: 'not_applicable' })), 'REQUIRED: reserved not_applicable markup uses explicit "N/A" text, not a mystery icon');
  assert(/EXPAND/.test(dash.renderWhitespaceCell({ status: 'active_play' })), 'REQUIRED: reserved active_play markup uses explicit "EXPAND" text, not a mystery icon');
}
{
  const { dash } = makeSandbox();
  const html = dash.renderWhitespaceMatrix([{ center: 'HR / People', metaLine: '', cells: dash.WHITESPACE_CATEGORIES.map(() => ({ status: 'whitespace' })) }]);
  assert(/class="ws-corner"/.test(html), 'REQUIRED: the matrix header includes the sticky corner cell for the row-label column');
}

// ===========================================================================
// 4. Durable, organization-scoped confirmations -- fetch-backed, never
//    localStorage. The client only ever trusts the server's authoritative
//    response.
// ===========================================================================
{
  const { dash, calls } = makeSandbox({
    fetchImpl: async (url) => {
      assert(url === '/api/whitespace-map', `REQUIRED: the confirmations fetch targets the durable endpoint (got ${url})`);
      return { ok: true, json: async () => ({ ok: true, confirmations: { 'acme': ['Marketing'] } }) };
    }
  });
  await dash.loadWhitespaceConfirmations();
  assert(calls.length === 1, 'REQUIRED: exactly one GET request loads confirmations for the whole org, never one per account');
  const centers = dash.confirmedCentersForAccount('Acme Corp');
  assert(centers.includes('Marketing'), `REQUIRED: confirmedCentersForAccount() resolves through normalizeCompanyNameForLimit() so "Acme Corp" matches the server's "acme corp" key (got ${JSON.stringify(centers)})`);
  await dash.loadWhitespaceConfirmations();
  assert(calls.length === 1, 'REQUIRED: a second call is a no-op -- confirmations are fetched once per page load, not re-fetched on every render');
}
{
  // Fail-safe: a failed/malformed fetch never throws and never fabricates
  // confirmed centers.
  const { dash } = makeSandbox({ fetchImpl: async () => { throw new Error('network down'); } });
  await dash.loadWhitespaceConfirmations();
  assert(JSON.stringify(dash.confirmedCentersForAccount('Acme Corp')) === '[]', 'REQUIRED: a failed confirmations fetch fails safe to zero confirmations, never throws');
}
{
  // A stale/unknown buying-center name in the server response is dropped,
  // never rendered as an unlabeled chip.
  const { dash } = makeSandbox({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, confirmations: { 'acme': ['Marketing', 'Not A Real Center'] } }) }) });
  await dash.loadWhitespaceConfirmations();
  assert(JSON.stringify(dash.confirmedCentersForAccount('Acme Corp')) === '["Marketing"]', 'REQUIRED: an unrecognized buying-center name from the server is silently dropped');
}
{
  // toggleWhitespaceMapConfirmation() POSTs and trusts only the server's
  // authoritative returned list -- never assumes the toggle direction
  // client-side.
  const { dash, calls } = makeSandbox({
    fetchImpl: async (url, opts) => {
      if(opts.method === 'GET') return { ok: true, json: async () => ({ ok: true, confirmations: {} }) };
      assert(url === '/api/whitespace-map' && opts.method === 'POST', 'REQUIRED: the toggle POSTs to the durable endpoint');
      const body = JSON.parse(opts.body);
      assert(body.accountName === 'Acme Corp' && body.buyingCenter === 'HR / People', `REQUIRED: the toggle request carries the real account name and buying center (got ${opts.body})`);
      return { ok: true, json: async () => ({ ok: true, confirmedCenters: ['HR / People'] }) };
    }
  });
  const result = await dash.toggleWhitespaceMapConfirmation('Acme Corp', 'HR / People');
  assert(JSON.stringify(result) === '["HR / People"]', 'REQUIRED: the toggle returns exactly the server\'s authoritative confirmedCenters list');
  assert(JSON.stringify(dash.confirmedCentersForAccount('Acme Corp')) === '["HR / People"]', 'REQUIRED: the local cache is updated from the server response so the next render reflects it without a GET round-trip');
}
{
  // No auth session -- fails safe, never throws, never sends a request.
  const { dash, calls } = makeSandbox({ hasAuth: false });
  await dash.loadWhitespaceConfirmations();
  assert(calls.length === 0, 'REQUIRED: with no auth session, no request is sent at all');
  assert(JSON.stringify(dash.confirmedCentersForAccount('Acme Corp')) === '[]', 'REQUIRED: confirmedCentersForAccount() is still safe to call with nothing loaded');
}

// ===========================================================================
// 5. End-to-end: a confirmation flips an account from "insufficient" to
//    "sufficient" on the very next render, sourced from the durable cache.
// ===========================================================================
{
  const { dash } = makeSandbox({
    fetchImpl: async (url, opts) => {
      if(opts.method === 'GET') return { ok: true, json: async () => ({ ok: true, confirmations: {} }) };
      return { ok: true, json: async () => ({ ok: true, confirmedCenters: ['Marketing'] }) };
    }
  });
  const account = { name: 'Acme Corp', contacts: [], allRecords: [], categoryTypes: [] };
  const before = dash.renderAccountWhitespaceSection(account);
  assert(/ws-map-prompt/.test(before), 'before confirming, the account shows the mapping prompt');
  await dash.toggleWhitespaceMapConfirmation('Acme Corp', 'Marketing');
  const after = dash.renderAccountWhitespaceSection(account);
  assert(/ws-matrix/.test(after) && !/ws-map-prompt/.test(after), 'REQUIRED: after a rep confirms one buying center, the SAME account now renders the matrix, not the prompt, on next render');
  assert(/Rep-confirmed relationship/.test(after), 'REQUIRED: the confirmed row shows "Rep-confirmed relationship" metadata, distinguishable from a real known-contact name');
}

// ===========================================================================
// 6. Responsive CSS -- fixed column widths (never shrinking to illegible),
//    horizontal scroll, and a sticky Buying Center column.
// ===========================================================================
{
  assert(/\.ws-matrix-scroll\{[^}]*overflow-x:\s*auto/.test(DASHBOARD_SRC), 'REQUIRED: the matrix scrolls horizontally rather than shrinking to fit');
  assert(/\.ws-matrix\{[^}]*width:\s*max-content/.test(DASHBOARD_SRC), 'REQUIRED: the matrix grid sizes to its real (fixed-width) content rather than being squeezed into the container');
  assert(/\.ws-rowhead\{[^}]*position:\s*sticky/.test(DASHBOARD_SRC) && /\.ws-corner\{[^}]*position:\s*sticky/.test(DASHBOARD_SRC), 'REQUIRED: the Buying Center row-label column (and its header corner) is pinned via position:sticky while scrolling horizontally');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
