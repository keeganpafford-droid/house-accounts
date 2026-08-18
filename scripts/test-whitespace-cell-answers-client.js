// Cell-Level Buying Center x Offering Confirmation / Correction V1 --
// client-side matrix data model and durable-answer persistence (dashboard/
// index.html). Extracts the REAL, verbatim source of
// computeAccountWhitespaceMatrix()/renderWhitespaceCell()/the cell-answer
// fetch-cache-save helpers via the shared semantic extractor and runs them
// in a vm sandbox, matching scripts/test-account-whitespace-intelligence-slice1.js's
// established pattern. That file's own coverage (the V1 Covered truth
// rule's condition-1 side, buying-center confirmations, taxonomy,
// responsive CSS, persistence-identity) is untouched and still passes
// unmodified against these same functions -- this file adds ONLY the new
// cell-answer coverage (condition 2 of the rule: a real cell-level rep
// answer), including the popover's markup/positioning helpers.
//
// Doctrine under test:
//   - computeAccountWhitespaceMatrix(account, confirmedCenters, cellAnswers)
//     assigns 'covered'/'not_applicable' to a cell ONLY when cellAnswers
//     carries a real answer for that exact (buying center, category) --
//     never inferred from anything else. A 'whitespace' answer (an
//     explicit "we don't sell this here") renders IDENTICALLY to a
//     never-answered cell -- the distinction lives only in cell.answer /
//     the data-cell-answer attribute, never in a separate visual state.
//   - A cell-level answer implies row-level buying-center evidence (a rep
//     cannot answer a cell for a buying center that doesn't exist here) --
//     but never writes to ha_whitespace_confirmations, and a buying-center
//     confirmation never implies any cell answer.
//   - renderWhitespaceCell() emits data-buying-center/data-category/
//     data-cell-answer attributes (HTML-escaped) so the delegated click
//     listener can resolve which cell was clicked, and so reopening an
//     answered cell's popover can show its current selection -- the
//     reserved 'active_play' branch stays untouched (no attributes, not
//     interactive).
//   - saveWhitespaceCellAnswer() POSTs to the durable endpoint and trusts
//     only the server's authoritative response, never assumes the write
//     succeeded client-side.
//   - loadWhitespaceCellAnswers() fetches once per page load (never once
//     per account), fails safe to {} on any error, and is independent of
//     loadWhitespaceConfirmations() (migration 24's separate cache).
//
// Usage: node scripts/test-whitespace-cell-answers-client.js
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
  'WHITESPACE_DEPARTMENTS', 'WHITESPACE_CATEGORIES', 'WHITESPACE_CELL_ANSWERS', 'WHITESPACE_CELL_ANSWER_LABELS',
  'whitespaceCellKey', 'computeAccountWhitespaceMatrix', 'renderWhitespaceCell', 'renderWhitespaceMatrix',
  'renderAccountWhitespaceSection', 'renderUnattributedPurchasesPanel',
  'loadWhitespaceCellAnswers', 'cellAnswersForAccount', 'saveWhitespaceCellAnswer',
  'ensureWsCellPopover', 'openWsCellPopover', 'closeWsCellPopover', 'positionWsCellPopover'
];

// A minimal fake DOM element -- just enough for document.createElement()/
// appendChild()/querySelector()/querySelectorAll()/classList/dataset/
// getBoundingClientRect() to support ensureWsCellPopover()/
// openWsCellPopover()'s real, extracted code. Deliberately narrower than
// scripts/test-dashboard-orchestration.js's FakeEl -- this file only
// exercises the popover's own DOM operations, not the delegated click
// listener (that requires a real event target chain; covered instead by
// the real-browser regression test), so `querySelector`/`querySelectorAll`
// only need to support the plain attribute-selector shapes this code
// actually issues (`[data-ws-popover-title]`, `.ws-cell-popover-option`).
function makeFakeElement(tag){
  const el = {
    tag,
    attrs: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(c){ this._set.add(c); },
      remove(c){ this._set.delete(c); },
      contains(c){ return this._set.has(c); },
      toggle(c, force){ const has = this._set.has(c); const want = force === undefined ? !has : !!force; if(want) this._set.add(c); else this._set.delete(c); return want; }
    },
    children: [],
    style: {},
    _innerHTML: '',
    get innerHTML(){ return this._innerHTML; },
    set innerHTML(v){
      this._innerHTML = v;
      // Parses just enough of the real popover markup (one title div plus
      // three option buttons, each carrying data-cell-answer-choice) to
      // support querySelector('[data-ws-popover-title]')/
      // querySelectorAll('.ws-cell-popover-option') below -- a hand-built
      // shallow structure, not a real HTML parser.
      const titleEl = makeFakeElement('div');
      titleEl.attrs['data-ws-popover-title'] = '';
      const optionMatches = [...v.matchAll(/data-cell-answer-choice="([^"]*)"/g)];
      const optionEls = optionMatches.map(m => {
        const opt = makeFakeElement('button');
        opt.dataset.cellAnswerChoice = m[1];
        opt._classes = new Set(['ws-cell-popover-option']);
        opt.classList = {
          _set: opt._classes,
          add(c){ this._set.add(c); },
          remove(c){ this._set.delete(c); },
          contains(c){ return this._set.has(c); },
          toggle(c, force){ const has = this._set.has(c); const want = force === undefined ? !has : !!force; if(want) this._set.add(c); else this._set.delete(c); return want; }
        };
        opt.setAttribute = (k, val) => { opt.attrs[k] = val; };
        return opt;
      });
      this.__title = titleEl;
      this.__options = optionEls;
    },
    querySelector(sel){
      if(sel === '[data-ws-popover-title]') return this.__title;
      return null;
    },
    querySelectorAll(sel){
      if(sel === '.ws-cell-popover-option') return this.__options || [];
      return [];
    },
    appendChild(child){ this.children.push(child); return child; },
    closest(sel){
      // Only ever called on a fake "cell" element in these tests, looking
      // for its owning `.account-whitespace-section` -- see the cell
      // fixture built in section 5 below.
      if(sel === '.account-whitespace-section' && this.__section) return this.__section;
      return null;
    },
    getBoundingClientRect(){ return this.__rect || { left: 100, right: 140, top: 200, bottom: 238, width: 40, height: 38 }; },
    get offsetWidth(){ return 220; },
    get offsetHeight(){ return 160; },
    setAttribute(k, v){ this.attrs[k] = v; },
    getAttribute(k){ return this.attrs[k]; }
  };
  return el;
}

function makeSandbox({ fetchImpl, hasAuth = true } = {}){
  const calls = [];
  const fetchFn = fetchImpl || (async () => ({ ok: true, json: async () => ({ ok: true, answers: {} }) }));
  const houseAuth = hasAuth ? { authHeadersAsync: async (extra) => ({ ...extra, Authorization: 'Bearer test-token' }) } : undefined;
  const bodyEl = makeFakeElement('body');
  const sandbox = {
    window: { HouseAuth: houseAuth, addEventListener(){}, innerWidth: 1400, innerHeight: 1000 },
    document: {
      addEventListener(){},
      body: bodyEl,
      createElement: (tag) => makeFakeElement(tag),
      documentElement: { clientWidth: 1400, clientHeight: 1000 }
    },
    console,
    HouseAuth: houseAuth,
    CSS: { escape: (s) => String(s) },
    fetch: async (url, opts) => { calls.push({ url, opts }); return fetchFn(url, opts); }
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'whitespace-cell-answers-extract.js' }).runInContext(sandbox);
  return { dash: sandbox.__exports, calls, bodyEl };
}

{
  const { dash } = makeSandbox();
  for(const name of EXPORT_NAMES){
    assert(typeof dash[name] !== 'undefined', `dashboard/index.html export "${name}" extracted successfully`);
  }
}

// ===========================================================================
// 1. Answer taxonomy.
// ===========================================================================
{
  const { dash } = makeSandbox();
  assert(JSON.stringify(dash.WHITESPACE_CELL_ANSWERS) === '["covered","whitespace","not_applicable"]', `REQUIRED: exactly the three founder-specified answers, in a stable order (got ${JSON.stringify(dash.WHITESPACE_CELL_ANSWERS)})`);
  assert(dash.whitespaceCellKey('Marketing', 'Apparel') === 'Marketing||Apparel', 'REQUIRED: whitespaceCellKey() matches the server-side cellKey() format exactly');
}

// ===========================================================================
// 2. computeAccountWhitespaceMatrix() -- cell answers are the ONLY thing
//    that can produce 'covered'/'not_applicable' from real data; every
//    prior insufficient-inference case (known contact, account-wide
//    purchase, buying-center confirmation alone) still fails to produce
//    them, exactly as scripts/test-account-whitespace-intelligence-slice1.js
//    already proves with a 2-arg call -- this section proves the NEW
//    3-arg behavior specifically.
// ===========================================================================
{
  const { dash } = makeSandbox();
  const account = { contacts: [{ name: 'Jane Doe', title: 'Marketing Manager' }], categoryTypes: ['Apparel'] };
  const cellAnswers = { [dash.whitespaceCellKey('Marketing', 'Apparel')]: 'covered' };
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], cellAnswers);
  const marketing = matrix.rows.find(r => r.center === 'Marketing');
  const apparelIdx = dash.WHITESPACE_CATEGORIES.indexOf('Apparel');
  assert(marketing.cells[apparelIdx].status === 'covered', 'REQUIRED: a real cell-level "covered" answer produces a covered cell');
  assert(marketing.cells[apparelIdx].answer === 'covered', 'REQUIRED: the cell carries its raw answer value, not just the derived visual status');
  const otherIdx = dash.WHITESPACE_CATEGORIES.indexOf('Headwear');
  assert(marketing.cells[otherIdx].status === 'whitespace', 'REQUIRED: an answer for ONE cell never bleeds into a sibling cell in the same row');
}
{
  const { dash } = makeSandbox();
  const account = { contacts: [], categoryTypes: [] };
  const cellAnswers = { [dash.whitespaceCellKey('Procurement', 'Drinkware')]: 'not_applicable' };
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], cellAnswers);
  const proc = matrix.rows.find(r => r.center === 'Procurement');
  const idx = dash.WHITESPACE_CATEGORIES.indexOf('Drinkware');
  assert(proc.cells[idx].status === 'not_applicable', 'REQUIRED: a real cell-level "not_applicable" answer produces a not-applicable cell');
}
{
  // Confirmed whitespace: a REAL recorded answer, but visually identical
  // to a never-answered cell -- founder requirement: "may continue looking
  // like ordinary quiet whitespace ... do not create another loud visual
  // state merely to prove we stored an answer."
  const { dash } = makeSandbox();
  const account = { contacts: [], categoryTypes: [] };
  const cellAnswers = { [dash.whitespaceCellKey('Events', 'Client Gifts')]: 'whitespace' };
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], cellAnswers);
  const events = matrix.rows.find(r => r.center === 'Events');
  const idx = dash.WHITESPACE_CATEGORIES.indexOf('Client Gifts');
  assert(events.cells[idx].status === 'whitespace', 'REQUIRED: an explicit "whitespace" answer renders the SAME visual status as no answer at all');
  assert(events.cells[idx].answer === 'whitespace', 'REQUIRED: the explicit answer is still distinguishable in the data (cell.answer), just not visually');
  const neverAskedIdx = dash.WHITESPACE_CATEGORIES.indexOf('Apparel');
  assert(events.cells[neverAskedIdx].answer === null, 'sanity: a genuinely never-answered cell in the same row has no answer at all, distinct from an explicit "whitespace" answer');
}
{
  // Row-level evidence: a cell-level answer alone (no known contact, no
  // buying-center confirmation) still counts as evidence for that row --
  // "a rep cannot meaningfully answer a cell for a buying center that
  // doesn't exist at this account" (founder note).
  const { dash } = makeSandbox();
  const account = { contacts: [], categoryTypes: [] };
  const cellAnswers = { [dash.whitespaceCellKey('Leadership', 'Client Gifts')]: 'covered' };
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], cellAnswers);
  assert(matrix.hasAnyBuyingCenterEvidence === true, 'REQUIRED: a cell-level answer alone is sufficient row-level evidence for the matrix to render (not fall back to the mapping prompt)');
  const leadership = matrix.rows.find(r => r.center === 'Leadership');
  assert(leadership.metaLine === 'Known relationship', `REQUIRED: the row's PRIMARY visible copy is the same plain-language "Known relationship" text as every other non-contact evidence source -- never internal phrasing like "offering mapping" (got "${leadership.metaLine}")`);
  assert(leadership.metaTitle === 'Known from your account mapping', `REQUIRED: the offering-mapping evidence source is preserved as a secondary tooltip (metaTitle), distinguishable from a known contact or a buying-center confirmation, just never the default-visible text (got "${leadership.metaTitle}")`);
  assert(leadership.metaKind === 'relationship', 'REQUIRED: metaKind marks this as the relationship (non-contact) case, so rendering applies the subtle teal treatment, not the plain contact styling');
}
{
  // A malformed/omitted cellAnswers argument (every pre-existing call
  // site) must behave exactly as before -- backward compatible.
  const { dash } = makeSandbox();
  const account = { contacts: [], categoryTypes: [] };
  const matrixNoArg = dash.computeAccountWhitespaceMatrix(account, []);
  const matrixNullArg = dash.computeAccountWhitespaceMatrix(account, [], null);
  const matrixArrayArg = dash.computeAccountWhitespaceMatrix(account, [], ['not', 'an', 'object']);
  for(const matrix of [matrixNoArg, matrixNullArg, matrixArrayArg]){
    assert(matrix.rows.every(r => r.cells.every(c => c.status === 'whitespace' && c.answer === null)), 'REQUIRED: an omitted/malformed cellAnswers argument never throws and never fabricates an answer');
  }
}

// ===========================================================================
// 3. renderWhitespaceCell() -- interactive attributes on real states,
//    reserved active_play branch left untouched.
// ===========================================================================
{
  const { dash } = makeSandbox();
  const html = dash.renderWhitespaceCell({ status: 'covered', answer: 'covered', center: 'Marketing', category: 'Apparel' });
  assert(/data-buying-center="Marketing"/.test(html), 'REQUIRED: a covered cell carries its buying center as a data attribute');
  assert(/data-category="Apparel"/.test(html), 'REQUIRED: a covered cell carries its category as a data attribute');
  assert(/data-cell-answer="covered"/.test(html), 'REQUIRED: a covered cell carries its current answer as a data attribute, so reopening its popover can show the saved selection');
  assert(/role="button"/.test(html) && /tabindex="0"/.test(html), 'REQUIRED: a covered cell is keyboard-reachable (role=button, tabindex=0), not mouse-only');
}
{
  const { dash } = makeSandbox();
  const html = dash.renderWhitespaceCell({ status: 'whitespace', answer: null, center: 'Events', category: 'Safety' });
  assert(/data-cell-answer=""/.test(html), 'REQUIRED: a never-answered whitespace cell carries an EMPTY data-cell-answer, distinguishable from an explicit "whitespace" answer');
  assert(/data-buying-center="Events"/.test(html) && /data-category="Safety"/.test(html), 'REQUIRED: a whitespace cell is still fully addressable (buying center + category attributes present) so it can be answered');
}
{
  const { dash } = makeSandbox();
  const html = dash.renderWhitespaceCell({ status: 'active_play' });
  assert(!/data-buying-center/.test(html) && !/role="button"/.test(html), 'REQUIRED: the reserved, still-unassigned active_play branch stays non-interactive -- no data attributes, not a click target');
  assert(/EXPAND/.test(html), 'sanity: the reserved active_play markup itself is untouched');
}
{
  // Escaping: a hostile buying-center/category string (hypothetical --
  // real values are always from the fixed taxonomy, but renderWhitespaceCell()
  // itself must not assume that) never breaks out of the attribute.
  const { dash } = makeSandbox();
  const html = dash.renderWhitespaceCell({ status: 'whitespace', answer: null, center: `"><script>alert(1)</script>`, category: 'Apparel' });
  assert(!html.includes('<script>alert(1)</script>'), 'REQUIRED: renderWhitespaceCell() HTML-escapes an arbitrary center/category value, never trusting it as safe markup');
}

// ===========================================================================
// 4. Durable, organization-scoped cell answers -- fetch-backed, never
//    localStorage, independent of migration 24's confirmations cache.
// ===========================================================================
{
  const { dash, calls } = makeSandbox({
    fetchImpl: async (url) => {
      assert(url === '/api/whitespace-cell-answers', `REQUIRED: the cell-answers fetch targets the durable endpoint (got ${url})`);
      return { ok: true, json: async () => ({ ok: true, answers: { 'acme': { 'Marketing||Apparel': 'covered' } } }) };
    }
  });
  await dash.loadWhitespaceCellAnswers();
  assert(calls.length === 1, 'REQUIRED: exactly one GET request loads cell answers for the whole org, never one per account');
  const answers = dash.cellAnswersForAccount('Acme Corp');
  assert(answers['Marketing||Apparel'] === 'covered', `REQUIRED: cellAnswersForAccount() resolves through normalizeCompanyNameForLimit() so "Acme Corp" matches the server's "acme" key (got ${JSON.stringify(answers)})`);
  await dash.loadWhitespaceCellAnswers();
  assert(calls.length === 1, 'REQUIRED: a second call is a no-op -- cell answers are fetched once per page load, not re-fetched on every render');
}
{
  const { dash } = makeSandbox({ fetchImpl: async () => { throw new Error('network down'); } });
  await dash.loadWhitespaceCellAnswers();
  assert(JSON.stringify(dash.cellAnswersForAccount('Acme Corp')) === '{}', 'REQUIRED: a failed cell-answers fetch fails safe to an empty map, never throws');
}
{
  const { dash, calls } = makeSandbox({
    fetchImpl: async (url, opts) => {
      if(opts.method === 'GET') return { ok: true, json: async () => ({ ok: true, answers: {} }) };
      assert(url === '/api/whitespace-cell-answers' && opts.method === 'POST', 'REQUIRED: saveWhitespaceCellAnswer() POSTs to the durable endpoint');
      const body = JSON.parse(opts.body);
      assert(body.accountName === 'Acme Corp' && body.buyingCenter === 'Marketing' && body.category === 'Apparel' && body.answer === 'covered', `REQUIRED: the save request carries the real account name, buying center, category, and answer (got ${opts.body})`);
      return { ok: true, json: async () => ({ ok: true, cellAnswers: { 'Marketing||Apparel': 'covered' } }) };
    }
  });
  const result = await dash.saveWhitespaceCellAnswer('Acme Corp', 'Marketing', 'Apparel', 'covered');
  assert(JSON.stringify(result) === '{"Marketing||Apparel":"covered"}', 'REQUIRED: saveWhitespaceCellAnswer() returns exactly the server\'s authoritative cellAnswers map');
  assert(JSON.stringify(dash.cellAnswersForAccount('Acme Corp')) === '{"Marketing||Apparel":"covered"}', 'REQUIRED: the local cache is updated from the server response so the next render reflects it without a GET round-trip');
}
{
  const { dash, calls } = makeSandbox({ hasAuth: false });
  await dash.loadWhitespaceCellAnswers();
  assert(calls.length === 0, 'REQUIRED: with no auth session, no cell-answers request is sent at all');
  assert(JSON.stringify(dash.cellAnswersForAccount('Acme Corp')) === '{}', 'REQUIRED: cellAnswersForAccount() is still safe to call with nothing loaded');
}

// ===========================================================================
// 5. Popover: opens against the clicked cell, positions itself, and marks
//    the cell's current answer as selected so reopening an answered cell
//    shows its existing choice.
// ===========================================================================
{
  const { dash, bodyEl } = makeSandbox();
  const section = makeFakeElement('div');
  section.dataset.accountName = 'Acme Corp';
  const cell = makeFakeElement('div');
  cell.__section = section;
  cell.dataset.buyingCenter = 'Marketing';
  cell.dataset.category = 'Apparel';
  cell.dataset.cellAnswer = 'covered';

  const popover = dash.ensureWsCellPopover();
  assert(bodyEl.children.includes(popover), 'REQUIRED: the popover is created once and appended to document.body');
  const popoverAgain = dash.ensureWsCellPopover();
  assert(popoverAgain === popover, 'REQUIRED: ensureWsCellPopover() reuses the same element on subsequent calls, never creates a second one');

  dash.openWsCellPopover(cell);
  assert(popover.classList.contains('open'), 'REQUIRED: opening the popover against a cell makes it visible (the .open class)');
  assert(popover.__title.textContent === 'Marketing × Apparel' || popover.querySelector('[data-ws-popover-title]').textContent === 'Marketing × Apparel', 'REQUIRED: the popover title names the exact buying center and category being answered');
  const selected = popover.querySelectorAll('.ws-cell-popover-option').find(o => o.classList.contains('selected'));
  assert(selected && selected.dataset.cellAnswerChoice === 'covered', `REQUIRED: reopening an answered cell's popover marks its CURRENT answer as selected, not a blank/default state (got ${selected && selected.dataset.cellAnswerChoice})`);

  dash.closeWsCellPopover();
  assert(!popover.classList.contains('open'), 'REQUIRED: closeWsCellPopover() hides the popover');
}
{
  // A never-answered cell opens the popover with NO option pre-selected.
  const { dash } = makeSandbox();
  const section = makeFakeElement('div');
  section.dataset.accountName = 'Acme Corp';
  const cell = makeFakeElement('div');
  cell.__section = section;
  cell.dataset.buyingCenter = 'Events';
  cell.dataset.category = 'Safety';
  cell.dataset.cellAnswer = '';
  dash.openWsCellPopover(cell);
  const popover = dash.ensureWsCellPopover();
  const anySelected = popover.querySelectorAll('.ws-cell-popover-option').some(o => o.classList.contains('selected'));
  assert(!anySelected, 'REQUIRED: a never-answered cell opens the popover with no option pre-selected');
}
{
  // Missing context (no owning section, e.g. a detached/stale cell) never
  // throws -- it just declines to open.
  const { dash } = makeSandbox();
  const orphanCell = makeFakeElement('div');
  orphanCell.dataset.buyingCenter = 'Marketing';
  orphanCell.dataset.category = 'Apparel';
  let threw = false;
  try{ dash.openWsCellPopover(orphanCell); }catch(e){ threw = true; }
  assert(!threw, 'REQUIRED: opening the popover against a cell with no owning .account-whitespace-section never throws');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
