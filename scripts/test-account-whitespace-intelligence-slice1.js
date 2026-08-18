// Account Expansion / Whitespace Intelligence, Slice 1 (read-only visibility
// only -- see BACKLOG.md's "Account Expansion / Whitespace Intelligence /
// Growth Map" entry). Extracts the REAL, verbatim source of
// computeAccountWhitespaceGrid()/contactIsTransactionLinked()/
// renderAccountWhitespaceSection() (plus their real dependencies --
// departmentFromText(), hasOrderHistoryEvidence(), escapeHtml()) via the
// shared semantic extractor and runs them in a vm sandbox. Also proves
// normalizeSavedAccount() now restores allRecords from rawData.records
// after a save/reload round-trip, which this slice's evidence lookups
// depend on for a previously-saved (not freshly-uploaded) account.
//
// Doctrine under test:
//   - A cell never renders 'covered' without real evidence, and never
//     collapses "no evidence" into a claim of confirmed absence.
//   - A known contact alone (no linked order) renders the honest, weaker
//     'known_contact' state, never 'covered'.
//   - Every cell's confirmation field is null this slice (no write path
//     exists yet).
//   - An account with no contacts and no purchase evidence renders
//     "not enough data yet", never a full grid of false gaps.
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
  'computeAccountWhitespaceGrid', 'whitespaceStatusMeta', 'renderWhitespaceCell',
  'renderAccountWhitespaceSection'
];
const sandbox = { window: {} };
vm.createContext(sandbox);
new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'whitespace-extract.js' }).runInContext(sandbox);
const dash = sandbox.__exports;
for(const name of EXPORT_NAMES){
  assert(typeof dash[name] !== 'undefined', `dashboard/index.html export "${name}" extracted successfully`);
}

// ===========================================================================
// 1. Taxonomy -- explicit, matches the reused classifiers' own vocabulary.
// ===========================================================================
assert(Array.isArray(dash.WHITESPACE_DEPARTMENTS) && dash.WHITESPACE_DEPARTMENTS.length === 7, `REQUIRED: the department taxonomy is explicit and has the expected 7 buckets (got ${JSON.stringify(dash.WHITESPACE_DEPARTMENTS)})`);
for(const dept of dash.WHITESPACE_DEPARTMENTS){
  assert(dash.departmentFromText(dept.toLowerCase()) === dept || dept === 'Sales / Client Experience', `sanity: department taxonomy entry "${dept}" round-trips through departmentFromText() classification vocabulary`);
}
assert(Array.isArray(dash.WHITESPACE_CATEGORIES) && dash.WHITESPACE_CATEGORIES.length === 11 && !dash.WHITESPACE_CATEGORIES.includes('Uncategorized'), `REQUIRED: the category taxonomy is explicit, has the expected 11 buckets, and excludes the "Uncategorized" fallback (got ${JSON.stringify(dash.WHITESPACE_CATEGORIES)})`);

// ===========================================================================
// 2. contactIsTransactionLinked() -- known contact vs. transaction-linked
//    contact, the core Correction 1 distinction.
// ===========================================================================
{
  const contact = { name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager' };
  const allRecords = [{ contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', revenue: 500, project: 'Welcome Kits', dateStr: '2025-01-01', status: '' }];
  assert(dash.contactIsTransactionLinked(contact, allRecords) === true, 'REQUIRED: a contact whose source row carries real order evidence (revenue) is transaction-linked');
}
{
  const contact = { name: 'John Roe', email: 'john@acme.com', title: 'Marketing Director' };
  const allRecords = [{ contactName: 'John Roe', contactEmail: 'john@acme.com', contactTitle: 'Marketing Director', revenue: 0, project: '', dateStr: '', status: '' }];
  assert(dash.contactIsTransactionLinked(contact, allRecords) === false, 'REQUIRED: a contact whose ONLY source row has no revenue/project/status/date is NOT transaction-linked -- known contact only');
}
{
  assert(dash.contactIsTransactionLinked({ name: 'Nobody', email: '', title: '' }, []) === false, 'a contact with no matching records at all is safely not transaction-linked, never throws');
}

// ===========================================================================
// 3. computeAccountWhitespaceGrid() -- the full per-cell state model.
// ===========================================================================
{
  const account = {
    contacts: [
      { name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager', department: 'HR' },
      { name: 'John Roe', email: 'john@acme.com', title: 'Marketing Director', department: '' }
    ],
    allRecords: [
      { contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', revenue: 500, project: 'Welcome Kits', dateStr: '2025-01-01', status: '' },
      { contactName: 'John Roe', contactEmail: 'john@acme.com', contactTitle: 'Marketing Director', revenue: 0, project: '', dateStr: '', status: '' }
    ],
    purchases: [{ revenue: 500 }],
    categoryTypes: ['Onboarding / Recruiting']
  };
  const grid = dash.computeAccountWhitespaceGrid(account);
  assert(grid.dataSufficiency === 'sufficient', 'REQUIRED: an account with real contacts/purchases has sufficient data');
  const hr = grid.departments.find(d => d.key === 'HR / People');
  assert(hr && hr.status === 'covered' && hr.evidence?.type === 'contact_transaction_linked', `REQUIRED: HR/People is 'covered' -- Jane Doe is transaction-linked (got ${JSON.stringify(hr)})`);
  const marketing = grid.departments.find(d => d.key === 'Marketing');
  assert(marketing && marketing.status === 'known_contact' && marketing.evidence?.type === 'contact_known', `REQUIRED: Marketing is 'known_contact', NOT 'covered' -- John Roe is a known contact with no linked order (got ${JSON.stringify(marketing)})`);
  const procurement = grid.departments.find(d => d.key === 'Procurement');
  assert(procurement && procurement.status === 'unknown' && procurement.evidence === null, 'REQUIRED: Procurement is "unknown" (potential whitespace) -- no contact matched, never rendered as confirmed absence');
  assert(grid.departments.every(d => d.confirmation === null), 'REQUIRED: every department cell has confirmation:null this slice -- no write path exists yet');
  const onboarding = grid.categories.find(c => c.key === 'Onboarding / Recruiting');
  assert(onboarding && onboarding.status === 'covered' && onboarding.evidence?.type === 'purchase_history', 'REQUIRED: a category present in categoryTypes (real observed purchase evidence) is covered');
  const drinkware = grid.categories.find(c => c.key === 'Drinkware');
  assert(drinkware && drinkware.status === 'unknown', 'REQUIRED: a category never purchased is "unknown" (potential whitespace), never confirmed absent');
  assert(grid.categories.every(c => c.confirmation === null), 'REQUIRED: every category cell has confirmation:null this slice');
}
{
  // Insufficient-data gate.
  const empty = dash.computeAccountWhitespaceGrid({ contacts: [], allRecords: [], purchases: [], categoryTypes: [] });
  assert(empty.dataSufficiency === 'insufficient', 'REQUIRED: an account with zero contacts and zero purchase evidence is flagged insufficient, not rendered as a full grid of gaps');
}
{
  // Fail-safe: unclassifiable department/title text never crashes and is
  // simply excluded, never force-mapped to a wrong bucket.
  const account = {
    contacts: [{ name: 'Mystery Person', email: 'x@acme.com', title: 'Ombudsperson', department: 'Miscellany' }],
    allRecords: [],
    purchases: [{ revenue: 10 }],
    categoryTypes: []
  };
  const grid = dash.computeAccountWhitespaceGrid(account);
  assert(grid.departments.every(d => d.status === 'unknown'), 'REQUIRED: an unclassifiable contact title/department never gets force-mapped into any department bucket -- every bucket stays unknown, no crash');
}
{
  // Malformed/null-shaped account input fails safe.
  const grid = dash.computeAccountWhitespaceGrid({});
  assert(grid.dataSufficiency === 'insufficient' && grid.departments.length === 7 && grid.categories.length === 11, 'a malformed/empty account object never throws -- resolves to a full, empty, insufficient-data grid');
}

// ===========================================================================
// 4. Rendering -- correct chip states, and the insufficient-data message.
// ===========================================================================
{
  const account = {
    contacts: [{ name: 'Jane Doe', email: 'jane@acme.com', title: 'HR Manager', department: 'HR' }],
    allRecords: [{ contactName: 'Jane Doe', contactEmail: 'jane@acme.com', contactTitle: 'HR Manager', revenue: 500, project: 'Kits', dateStr: '2025-01-01', status: '' }],
    purchases: [{ revenue: 500 }],
    categoryTypes: ['Onboarding / Recruiting']
  };
  const html = dash.renderAccountWhitespaceSection(account);
  assert(/Account Whitespace/.test(html), 'REQUIRED: the rendered section has the Account Whitespace heading');
  assert(/ws-covered/.test(html) && />Jane Doe/.test(html) === false, 'REQUIRED: a covered cell renders with the ws-covered class'); // contact name lives in the title attr, not visible text
  assert(/ws-unknown/.test(html), 'REQUIRED: unknown/potential-whitespace cells render with the ws-unknown class');
  assert(/Potential whitespace \(no evidence either way\)/.test(html), 'REQUIRED: the legend truthfully frames unknown as "no evidence either way", never confirmed absence');
}
{
  const html = dash.renderAccountWhitespaceSection({ contacts: [], allRecords: [], purchases: [], categoryTypes: [] });
  assert(/Not enough uploaded contact or order data yet/.test(html), 'REQUIRED: an account with no evidence at all shows the honest insufficient-data message, not an empty/misleading grid');
  assert(!/ws-chip/.test(html), 'REQUIRED: no chips render at all in the insufficient-data state');
}

// ===========================================================================
// 5. normalizeSavedAccount() -- allRecords now survives a save/reload
//    round-trip (required for this slice's evidence lookups to work on a
//    previously-saved, not just freshly-uploaded, account). Checked as a
//    source-pattern assertion against the real extracted function, the
//    same precedent other tests already use for this exact function
//    (e.g. test-guided-tour-and-import-experience.js's processData()
//    checks) -- normalizeSavedAccount() pulls in a large, unrelated
//    dependency graph (dedupeOpportunities and beyond) that would need to
//    be fully stood up just to prove one small, additive fallback line.
// ===========================================================================
{
  const normalizeSrc = extractFn(DASHBOARD_SRC, 'normalizeSavedAccount');
  assert(
    /a\.allRecords\s*=\s*Array\.isArray\(a\.allRecords\)\s*\?\s*a\.allRecords\s*:\s*\(Array\.isArray\(raw\.records\)\s*\?\s*raw\.records\s*:\s*\[\]\)/.test(normalizeSrc),
    'REQUIRED: normalizeSavedAccount() restores allRecords from rawData.records (falling back to [] when absent, never overwriting an already-present allRecords) so a RELOADED account\'s whitespace evidence is not silently empty'
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
