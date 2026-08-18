// Active Expansion Plays V1 (founder recon + decision, 2026-08-19). Extracts
// the REAL, verbatim source of computeActiveExpansionPlays()/
// renderActiveExpansionPlaysPanel()/activeExpansionPlayWhyNowText() plus
// their real dependencies via the shared semantic extractor and runs them
// in a vm sandbox -- same established pattern as
// scripts/test-account-whitespace-intelligence-slice1.js (which this file
// is a sibling to, not a replacement for -- that file still owns general
// matrix/confirmation coverage; this one owns the Active Expansion Plays
// eligibility gate and copy doctrine specifically).
//
// Doctrine under test (founder decision, 2026-08-19) -- an Active
// Expansion Play requires ALL THREE, together, per Buying Center x
// Offering cell:
//   1. An EXPLICIT confirmed whitespace answer (`answer === 'whitespace'`)
//      -- never a blank/unanswered cell.
//   2. Trustworthy relationship access -- an explicit team confirmation,
//      OR a known mapped contact (either alone is sufficient; a contact
//      is surfaced when one exists but never required when the team has
//      already confirmed the relationship).
//   3. A real, category-linked why-now trigger -- a qualifying Repeat/
//      Pattern opportunity (findRepeatPatternGroups()'s own real evidence
//      bar) whose category is the SAME offering as the whitespace cell.
//      A verified business signal is NEVER a valid trigger in V1 -- the
//      current department/buyingCategory classification on a signal-
//      derived opportunity isn't reliably linkable to a specific cell.
// Multiple qualifying cells sharing one trigger are never ranked/
// suppressed -- every one is a real, separate play; the panel groups them
// under their shared "why now" text purely to avoid stuttering identical
// copy, never to imply preference.
// Copy doctrine: state the facts, never overstate causality -- the
// trigger is real ACCOUNT-WIDE purchase history, never claimed to be
// "from" the specific Buying Center; "what to explore" is a question,
// never an assertion of need.
//
// Usage: node scripts/test-active-expansion-plays.js
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
  extractFn(DASHBOARD_SRC, 'parseMaybeDate'),
  extractFn(DASHBOARD_SRC, 'monthNameFromDate'),
  extractFn(DASHBOARD_SRC, 'averageRevenue'),
  extractFn(DASHBOARD_SRC, 'findRepeatPatternGroups'),
  extractFn(DASHBOARD_SRC, 'inferPurchaseMonth'),
  extractFn(DASHBOARD_SRC, 'monthDistanceFromNow'),
  extractFn(DASHBOARD_SRC, 'reorderWindowStatus'),
  extractRange(DASHBOARD_SRC, 'const WHITESPACE_DEPARTMENTS', 'function getOpportunityType(account, signalBased=false){')
].join('\n\n');

const EXPORT_NAMES = [
  'WHITESPACE_DEPARTMENTS', 'WHITESPACE_CATEGORIES', 'whitespaceCellKey',
  'contactsKnownForBuyingCenter', 'computeAccountWhitespaceMatrix',
  'computeActiveExpansionPlays', 'renderActiveExpansionPlaysPanel', 'activeExpansionPlayWhyNowText',
  'renderAccountWhitespaceSection', 'loadWhitespaceConfirmations', 'confirmedCentersForAccount',
  'loadWhitespaceCellAnswers', 'cellAnswersForAccount', 'findRepeatPatternGroups'
];

function d(dateStr){ return new Date(dateStr); }

function makeSandbox({ confirmedCenters = {}, cellAnswers = {}, hasAuth = true } = {}){
  const houseAuth = hasAuth ? { authHeadersAsync: async (extra) => ({ ...extra, Authorization: 'Bearer test-token' }) } : undefined;
  const fetchFn = async (url) => {
    if(String(url).includes('/api/whitespace-cell-answers')) return { ok: true, json: async () => ({ ok: true, answers: cellAnswers }) };
    if(String(url).includes('/api/whitespace-map')) return { ok: true, json: async () => ({ ok: true, confirmations: confirmedCenters }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const sandbox = {
    window: { HouseAuth: houseAuth, addEventListener(){} },
    document: { addEventListener(){} },
    console,
    HouseAuth: houseAuth,
    fetch: fetchFn
  };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'active-expansion-plays-extract.js' }).runInContext(sandbox);
  return sandbox.__exports;
}

// Fixture: Anchor Brewing Supply -- a known Marketing contact, a team
// confirmation in Operations/Facilities (no contact there), and a real
// 2-year Apparel repeat pattern (2024 + 2025, same category, real dates)
// -- exactly the founder's own worked example, plus a second qualifying
// Buying Center to exercise the multi-cell case.
function baseAccount(overrides = {}){
  return {
    name: 'Anchor Brewing Supply',
    contacts: [{ name: 'Jordan Reyes', title: 'Marketing Manager', department: 'Marketing' }],
    purchases: [
      { category: 'Apparel', revenue: 2000, date: d('2024-03-10'), dateStr: '2024-03-10' },
      { category: 'Apparel', revenue: 2400, date: d('2025-03-15'), dateStr: '2025-03-15' }
    ],
    ...overrides
  };
}

async function renderedSection(dash, account, { confirmedCenters, cellAnswers } = {}){
  await dash.loadWhitespaceConfirmations();
  await dash.loadWhitespaceCellAnswers();
  return dash.renderAccountWhitespaceSection(account);
}

// ===========================================================================
// 1) The founder's own worked example qualifies: known relationship in
//    Marketing (contact) + explicit whitespace Apparel + a real Apparel
//    repeat pattern -> exactly one eligible play.
// ===========================================================================
{
  const dash = makeSandbox({
    confirmedCenters: { 'anchor brewing supply': [] },
    cellAnswers: { 'anchor brewing supply': { 'Marketing||Apparel': 'whitespace' } }
  });
  const account = baseAccount();
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], { 'Marketing||Apparel': 'whitespace' });
  const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
  assert(plays.length === 1, `1) REQUIRED: the worked example produces exactly one eligible play (got ${plays.length})`);
  assert(plays[0].center === 'Marketing' && plays[0].category === 'Apparel', '1) REQUIRED: the play is keyed to the exact qualifying cell (Marketing x Apparel)');
  assert(plays[0].contacts.length === 1 && plays[0].contacts[0].name === 'Jordan Reyes', '1) REQUIRED: the known contact is attached to the play');
}

// ===========================================================================
// 2) Condition 1 -- a BLANK (unanswered) cell never qualifies, even with
//    relationship + trigger both present. Blank means "we don't know,"
//    never "confirmed nothing sold here."
// ===========================================================================
{
  const dash = makeSandbox({ confirmedCenters: { 'anchor brewing supply': [] }, cellAnswers: { 'anchor brewing supply': {} } });
  const account = baseAccount();
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], {});
  const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
  assert(plays.length === 0, `2) REQUIRED: an unanswered (blank) cell never qualifies as a play, even with relationship + trigger present (got ${plays.length})`);
}

// ===========================================================================
// 3) Condition 1 -- an explicit 'not_applicable' or 'covered' answer never
//    qualifies either (only 'whitespace' does).
// ===========================================================================
{
  const dash = makeSandbox();
  const account = baseAccount();
  ['not_applicable', 'covered'].forEach(answer => {
    const matrix = dash.computeAccountWhitespaceMatrix(account, [], { 'Marketing||Apparel': answer });
    const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
    assert(plays.length === 0, `3) REQUIRED: an explicit '${answer}' answer never qualifies as a play (only 'whitespace' does) (got ${plays.length})`);
  });
}

// ===========================================================================
// 4) Condition 2 -- no relationship evidence at all (no contact, no team
//    confirmation) in that Buying Center never qualifies, even with
//    confirmed whitespace + a real trigger.
// ===========================================================================
{
  const dash = makeSandbox();
  const account = baseAccount({ contacts: [] }); // no known contact anywhere
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], { 'Marketing||Apparel': 'whitespace' });
  const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
  assert(plays.length === 0, `4) REQUIRED: no relationship evidence in the Buying Center never qualifies as a play (got ${plays.length})`);
}

// ===========================================================================
// 5) Condition 2 -- an explicit TEAM confirmation alone (no contact)
//    satisfies condition 2 -- a rep does not need a named contact once
//    the relationship itself is confirmed.
// ===========================================================================
{
  const dash = makeSandbox();
  const account = baseAccount({ contacts: [] });
  const matrix = dash.computeAccountWhitespaceMatrix(account, ['Marketing'], { 'Marketing||Apparel': 'whitespace' });
  const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
  assert(plays.length === 1, `5) REQUIRED: an explicit team confirmation alone (no contact) is sufficient relationship access (got ${plays.length})`);
  assert(plays[0].contacts.length === 0, '5) sanity: no contact is attached when none exists, even though the play still qualifies');
}

// ===========================================================================
// 6) Condition 3 -- category mismatch never activates the cell. A
//    Drinkware repeat pattern must never activate an Apparel cell.
// ===========================================================================
{
  const dash = makeSandbox();
  const account = baseAccount({
    purchases: [
      { category: 'Drinkware', revenue: 500, date: d('2024-02-01'), dateStr: '2024-02-01' },
      { category: 'Drinkware', revenue: 550, date: d('2025-02-05'), dateStr: '2025-02-05' }
    ]
  });
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], { 'Marketing||Apparel': 'whitespace' });
  const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
  assert(plays.length === 0, `6) REQUIRED: a Drinkware repeat pattern must never activate an Apparel whitespace cell (got ${plays.length})`);
}

// ===========================================================================
// 7) Condition 3 -- no qualifying repeat pattern at all (e.g. only 1
//    purchase, below findRepeatPatternGroups()'s own real evidence bar)
//    never qualifies, even with relationship + confirmed whitespace.
// ===========================================================================
{
  const dash = makeSandbox();
  const account = baseAccount({ purchases: [{ category: 'Apparel', revenue: 2000, date: d('2025-03-10'), dateStr: '2025-03-10' }] });
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], { 'Marketing||Apparel': 'whitespace' });
  const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
  assert(plays.length === 0, `7) REQUIRED: a single purchase (below the real repeat-pattern evidence bar) never qualifies as a why-now trigger (got ${plays.length})`);
}

// ===========================================================================
// 8) A priority verified business signal is NEVER a valid trigger by
//    itself -- computeActiveExpansionPlays() doesn't even look at
//    account.signals/futureOpportunities, only real purchase-derived
//    repeat patterns. Confirms this by construction: a "signal-only"
//    account (real relationship + confirmed whitespace, but the only
//    purchase evidence is a single non-qualifying order) produces no play
//    regardless of how many signals/opportunities are attached.
// ===========================================================================
{
  const dash = makeSandbox();
  const account = baseAccount({
    purchases: [{ category: 'Apparel', revenue: 2000, date: d('2025-03-10'), dateStr: '2025-03-10' }],
    signals: [{ isReal: true, sourceUrl: 'https://example.com/news', signalType: 'Expansion', confidenceScore: 90 }],
    futureOpportunities: [{ signalLayerType: 'Business Activity Signal', department: 'Marketing', buyingCategory: 'Apparel', isVerifiedSignalOpportunity: true }]
  });
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], { 'Marketing||Apparel': 'whitespace' });
  const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
  assert(plays.length === 0, `8) REQUIRED: a priority verified business signal never activates a cell by itself, even one whose department/buyingCategory happen to name the exact same cell (got ${plays.length})`);
}

// ===========================================================================
// 9) Multiple-cell decision: the SAME qualifying Apparel trigger can
//    legitimately match two different Buying Centers -- both are real,
//    separate plays; neither is suppressed, neither is ranked above the
//    other.
// ===========================================================================
{
  const dash = makeSandbox();
  const account = baseAccount({ contacts: [{ name: 'Jordan Reyes', title: 'Marketing Manager', department: 'Marketing' }] });
  const matrix = dash.computeAccountWhitespaceMatrix(account, ['Operations / Facilities'], {
    'Marketing||Apparel': 'whitespace',
    'Operations / Facilities||Apparel': 'whitespace'
  });
  const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
  assert(plays.length === 2, `9) REQUIRED: two independently qualifying Buying Centers for the same trigger both produce real, separate plays (got ${plays.length})`);
  const centers = plays.map(p => p.center).sort();
  assert(centers[0] === 'Marketing' && centers[1] === 'Operations / Facilities', '9) REQUIRED: both qualifying centers are present, neither suppressed');
  assert(plays[0].trigger === plays[1].trigger, '9) sanity: both plays share the exact same trigger object (same underlying evidence)');
}

// ===========================================================================
// 10) Panel rendering: grouping, copy doctrine, and the multi-cell case
//     rendered together without duplicating the "why now" text per cell.
// ===========================================================================
{
  const dash = makeSandbox();
  const account = baseAccount();
  const matrix = dash.computeAccountWhitespaceMatrix(account, ['Operations / Facilities'], {
    'Marketing||Apparel': 'whitespace',
    'Operations / Facilities||Apparel': 'whitespace'
  });
  const plays = dash.computeActiveExpansionPlays(account, matrix.rows);
  const html = dash.renderActiveExpansionPlaysPanel(plays, account);

  assert(/Active Expansion Plays/.test(html), '10) REQUIRED: the panel announces itself');
  assert(/Marketing × Apparel/.test(html), '10) REQUIRED: "Where to grow" shows Marketing x Apparel');
  assert(/Operations \/ Facilities × Apparel/.test(html), '10) REQUIRED: "Where to grow" shows Operations / Facilities x Apparel');
  assert((html.match(/repeat apparel buying pattern/g) || []).length === 1, '10) REQUIRED: the shared "why now" trigger text is grouped, rendered ONCE, never stuttered per qualifying cell');
  assert(/Your position/.test(html) && /you've confirmed Apparel is whitespace there/.test(html), '10) REQUIRED: "Your position" states the two independent facts plainly');
  assert(/Who you know/.test(html) && /Jordan Reyes/.test(html), '10) REQUIRED: "Who you know" surfaces the real contact where available');
  assert(/Explore whether Marketing has an upcoming apparel need/.test(html), '10) REQUIRED: "What to explore" is phrased as a restrained question, matching the founder\'s own example');

  assert(!/Marketing needs apparel/i.test(html), '10) REQUIRED: never overstate as a flat need claim ("Marketing needs apparel")');
  assert(!/Marketing (has|had) (bought|purchased|ordered)/i.test(html), '10) REQUIRED: never claim the historical purchase came through the specific Buying Center -- the evidence is account-wide, not Buying-Center-specific');
}

// ===========================================================================
// 10b) Reload-safety regression: a RELOADED account's purchases[].date is
//      a plain ISO string, never a real Date object -- normalizeSavedAccount()
//      round-trips purchases exactly as saved, with no date re-hydration.
//      findRepeatPatternGroups()'s only pre-existing call site
//      (generateFutureOpportunities()) never hit this, since it only ever
//      runs against a freshly-parsed CSV upload where parseCSV() already
//      produced real Date objects -- computeActiveExpansionPlays() is the
//      first call site to run against reloaded data, and must not throw
//      (caught during this slice's own screenshot verification: a
//      string-dated fixture threw "o.date.getFullYear is not a function"
//      before this was fixed).
// ===========================================================================
{
  const dash = makeSandbox();
  const account = baseAccount({
    purchases: [
      { category: 'Apparel', revenue: 2000, date: '2024-03-10', dateStr: '2024-03-10' },
      { category: 'Apparel', revenue: 2400, date: '2025-03-15', dateStr: '2025-03-15' }
    ]
  });
  const matrix = dash.computeAccountWhitespaceMatrix(account, [], { 'Marketing||Apparel': 'whitespace' });
  let threw = null;
  let plays = [];
  try{ plays = dash.computeActiveExpansionPlays(account, matrix.rows); }catch(e){ threw = e; }
  assert(!threw, `10b) REQUIRED: a reloaded account with STRING purchase dates (not Date objects) never throws (got ${threw && threw.message})`);
  assert(plays.length === 1, `10b) REQUIRED: the string-dated purchases still correctly qualify the play once coerced (got ${plays.length})`);
}

// ===========================================================================
// 11) No plays -> the panel renders nothing at all (no empty shell, no
//     "no plays" message cluttering the account card).
// ===========================================================================
{
  const dash = makeSandbox();
  const html = dash.renderActiveExpansionPlaysPanel([], baseAccount());
  assert(html === '', '11) REQUIRED: zero eligible plays renders nothing -- no empty panel shell');
}

// ===========================================================================
// 12) End-to-end through renderAccountWhitespaceSection(): the real
//     durable-fetch-backed path produces the active-play matrix cell AND
//     the panel together, from the real account object with no manual
//     matrix construction.
// ===========================================================================
{
  const dash = makeSandbox({
    confirmedCenters: { 'anchor brewing supply': [] },
    cellAnswers: { 'anchor brewing supply': { 'Marketing||Apparel': 'whitespace' } }
  });
  const account = baseAccount();
  const html = await renderedSection(dash, account);
  assert(/ws-cell active-play/.test(html), '12) REQUIRED: the real end-to-end render path assigns the active-play cell class from real durable data, not a stub');
  assert(/EXPAND/.test(html), '12) REQUIRED: the active-play cell shows the real EXPAND mark');
  assert(/Active Expansion Plays/.test(html), '12) REQUIRED: the plays panel renders in the same real end-to-end pass');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
