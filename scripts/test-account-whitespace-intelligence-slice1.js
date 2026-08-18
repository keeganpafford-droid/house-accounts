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
// Doctrine under test (V1 Covered truth rule, founder correction
// 2026-08-19, superseding an earlier same-row/single-category-
// discrimination rule that was STILL too inferential):
//   - A cell may render covered ONLY when (1) source data explicitly
//     proves a specific buying center purchased a specific offering, or
//     (2) a rep explicitly confirms they sell that offering into that
//     buying center. Neither exists in this codebase today, so
//     computeAccountWhitespaceMatrix() NEVER assigns 'covered' from real
//     data -- co-occurrence, uniqueness, single-category discrimination,
//     and any other correlation-based inference are all explicitly
//     insufficient, no matter how narrow. Zero automatic covered
//     intersections is the correct, accepted V1 result.
//   - Known-relationship context lives on the ROW label, never painted
//     across a whole row's cells, and never implies cell-level coverage.
//   - Only 'whitespace' ever renders from real evidence today --
//     'covered'/'not_applicable'/'active_play' have reserved markup but
//     are never assigned by computeAccountWhitespaceMatrix().
//   - Every real category purchase renders in the unattributed panel
//     outside the organizational grid, since no automatic attribution
//     exists -- never a fake buying-center row.
//   - Zero buying-center evidence renders the lightweight mapping prompt.
//   - Confirmations are durable/organization-scoped via api/whitespace-map.js
//     (fetch), never localStorage -- the client caches the server's
//     response and only ever trusts the server's authoritative return
//     value after a toggle.
//   - (organization_id, normalized_company_name) is a V1 resolution key,
//     not an immutable identifier -- a rename/re-upload that changes the
//     normalized key orphans old confirmations safely (re-ask, never
//     stale/wrong data), never silently misattributes them.
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
  'WHITESPACE_DEPARTMENTS', 'WHITESPACE_CATEGORIES',
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
    // addEventListener(): a no-op is sufficient here -- this file tests
    // computeAccountWhitespaceMatrix()/the render functions/the durable-
    // confirmation fetch helpers, not the Cell-Level Confirmation/
    // Correction V1 popover's click/keydown/scroll wiring or its
    // document.createElement()-based popover element (dedicated coverage
    // for that lives in scripts/test-whitespace-cell-answers-client.js and
    // the real-browser regression test) -- this sandbox only needs the
    // module's real top-level `window.addEventListener(...)` registration
    // call to not throw while the extracted source loads.
    window: { HouseAuth: houseAuth, addEventListener(){} },
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
// 2. computeAccountWhitespaceMatrix() -- V1 Covered truth rule: NO source-
//    data pattern, however narrow, is ever sufficient to mark a cell
//    covered. Every real category purchase always lands in the
//    unattributed panel; every cell is always whitespace.
// ===========================================================================
{
  // A generic HR contact repeated on every row, account happens to have
  // purchased only Apparel -- the exact scenario the founder cited. Must
  // NOT produce HR/People x Apparel = covered.
  const { dash } = makeSandbox();
  const account = {
    contacts: [{ name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager', department: 'HR' }],
    allRecords: [
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Apparel', revenue: 500, project: 'Jackets', dateStr: '2025-01-01', status: '' },
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', contactDepartment: 'HR', category: 'Apparel', revenue: 300, project: 'Polos', dateStr: '2025-02-01', status: '' }
    ],
    categoryTypes: ['Apparel']
  };
  const matrix = dash.computeAccountWhitespaceMatrix(account, []);
  const hr = matrix.rows.find(r => r.center === 'HR / People');
  assert(hr.cells.every(c => c.status === 'whitespace'), 'REQUIRED: HR / People x Apparel never reaches covered, even though HR is the only contact and Apparel is the only category purchased');
  assert(hr.metaLine === 'Jane Doe · known contact', 'REQUIRED: the contact still produces real row-level known-relationship metadata');
  assert(matrix.unattributed.length === 1 && matrix.unattributed.includes('Apparel'), `REQUIRED: Apparel still surfaces as an account-wide purchase not yet attributed, never as a false HR intersection (got ${JSON.stringify(matrix.unattributed)})`);
}
{
  // Even the PREVIOUS (now-superseded) standard's positive case -- a
  // contact evidenced against exactly ONE category across multiple
  // orders -- must NOT reach covered under the corrected V1 rule. Single-
  // category discrimination was explicitly rejected as still-insufficient
  // proof of a real buying-center x offering purchase.
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
  assert(onboarding.status === 'whitespace', `REQUIRED: single-category contact discrimination is no longer sufficient proof of covered -- this is the corrected rule superseding the prior (too permissive) standard (got ${onboarding.status})`);
  assert(matrix.unattributed.includes('Onboarding / Recruiting'), 'REQUIRED: the category still surfaces as unattributed rather than silently disappearing');
}
{
  // A durable, org-level buying-center CONFIRMATION (rep says "I have a
  // relationship in Marketing") is row-level metadata only -- it must
  // never, by itself, mark any cell in that row covered. Cell-level
  // coverage requires cell-level confirmation, which does not exist yet.
  const { dash } = makeSandbox();
  const account = { contacts: [], categoryTypes: ['Apparel'] };
  const matrix = dash.computeAccountWhitespaceMatrix(account, ['Marketing']);
  const marketing = matrix.rows.find(r => r.center === 'Marketing');
  assert(marketing.metaLine === 'Rep-confirmed relationship', 'sanity: the buying-center confirmation still produces row-level metadata');
  assert(marketing.cells.every(c => c.status === 'whitespace'), 'REQUIRED: a buying-center-level rep confirmation never marks any specific offering cell covered -- that would assume an intersection the rep was never asked about');
  assert(matrix.unattributed.includes('Apparel'), 'REQUIRED: Apparel remains unattributed regardless of the unrelated Marketing confirmation');
}
{
  const { dash } = makeSandbox();
  const matrix = dash.computeAccountWhitespaceMatrix({}, null);
  assert(matrix.hasAnyBuyingCenterEvidence === false && matrix.rows.length === 7 && matrix.unattributed.length === 0, 'a malformed/empty account never throws -- resolves to a full, empty, no-evidence matrix');
  assert(matrix.rows.every(r => r.cells.every(c => c.status === 'whitespace')), 'REQUIRED: every cell in a malformed/empty account is whitespace, never covered');
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

// ===========================================================================
// 7. Persistence identity -- (organization_id, normalized_company_name)
//    is a V1 resolution key, not an immutable account identifier. A
//    rename/re-upload that changes the normalized key must NEVER show
//    stale/wrong confirmations against the renamed account -- it must
//    gracefully fall back to "no confirmations known" (the same state as
//    an account that was never confirmed), never silently misattribute
//    another key's data.
// ===========================================================================
{
  const { dash } = makeSandbox({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, confirmations: { 'acme': ['Marketing', 'HR / People'] } }) })
  });
  await dash.loadWhitespaceConfirmations();
  assert(JSON.stringify(dash.confirmedCentersForAccount('Acme Corp')) === '["Marketing","HR / People"]', 'sanity: the account under its original name resolves its real confirmations');
  // Simulate a rename/re-upload: the SAME real company now appears under
  // a materially different name that normalizes to a different key. The
  // old confirmations were keyed to "acme" and are now inert -- they must
  // never leak onto the renamed account under any key match.
  const renamed = dash.confirmedCentersForAccount('Meridian Promotional Group');
  assert(JSON.stringify(renamed) === '[]', `REQUIRED: a renamed account (different normalized key) never inherits another key's confirmations -- it resolves to zero, the same safe state as never-confirmed (got ${JSON.stringify(renamed)})`);
  const matrix = dash.computeAccountWhitespaceMatrix({ contacts: [], categoryTypes: [] }, renamed);
  assert(matrix.hasAnyBuyingCenterEvidence === false, 'REQUIRED: the renamed account\'s matrix has zero buying-center evidence, so rendering falls back to the mapping prompt (a safe re-ask) rather than any stale state');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
