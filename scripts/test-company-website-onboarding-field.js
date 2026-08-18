// Company Website -- CSV/onboarding field (BACKLOG.md, "NOW" tier).
//
// The data pipeline this backlog item asked for -- a CSV website/domain
// column flowing through account aggregation into the target-identity
// resolution pipeline with the correct precedence -- ALREADY EXISTED
// end-to-end before this change (parseCSV()'s 'website' column-alias
// group, processData()'s account.website aggregation, and
// resolveTargetIdentity()'s uploaded-website precedence were all already
// live). This test proves that existing pipeline works correctly across
// the required scenarios, using the REAL, unmodified source -- it does
// not reimplement any of parseCSV()/processData()'s logic, and it imports
// resolveTargetIdentity()/normalizeDomain() directly from
// api/lib/monitoring-identity.js rather than re-deriving their behavior.
//
// What this sprint actually changed (the real, narrow, previously-missing
// gap): discoverability. Neither the downloadable sample CSV template nor
// the Add Customer Data modal's field-hint copy nor the five
// customer-order-history export guides ever mentioned Website at all, so
// a user had no signal to include one even though the pipeline would
// fully honor it. Those five static-content checks are included below
// alongside the pipeline-behavior proof.
//
// Usage: node scripts/test-company-website-onboarding-field.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';
import { resolveTargetIdentity, normalizeDomain } from '../api/lib/monitoring-identity.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

// ===========================================================================
// 1. parseCSV() -- real column-alias detection, real CSV parsing.
// ===========================================================================
const PARSE_SRC = [
  extractFn(DASHBOARD_SRC, 'parseCSV'),
  extractFn(DASHBOARD_SRC, 'isLikelyInvalidAccountName'),
  extractFn(DASHBOARD_SRC, 'inferPromoCategory')
].join('\n\n');
const parseSandbox = { window: {} };
vm.createContext(parseSandbox);
new vm.Script(`${PARSE_SRC}\n\nthis.__exports = { parseCSV, isLikelyInvalidAccountName, inferPromoCategory };`, { filename: 'parseCSV-extract.js' }).runInContext(parseSandbox);
const { parseCSV } = parseSandbox.__exports;
assert(typeof parseCSV === 'function', 'parseCSV() extracted successfully as a real function');

function csvOf(header, rows){
  return [header.join(','), ...rows.map(r => r.join(','))].join('\n');
}

{
  const csv = csvOf(
    ['Customer Name', 'Order Date', 'Revenue', 'Website'],
    [['Acme Corp', '2025-06-01', '5000', 'acme.com']]
  );
  const records = parseCSV(csv);
  assert(records.length === 1 && records[0].website === 'acme.com', `REQUIRED: a "Website" column is recognized and its value reaches the parsed record (got ${JSON.stringify(records[0]?.website)})`);
}
{
  const csv = csvOf(
    ['Customer Name', 'Order Date', 'Revenue', 'Company Website'],
    [['Acme Corp', '2025-06-01', '5000', 'https://www.acme.com/about']]
  );
  const records = parseCSV(csv);
  assert(records[0].website === 'https://www.acme.com/about', 'REQUIRED: the "Company Website" alias is recognized (parseCSV() passes the raw value through; normalization happens at identity-resolution time, not here)');
}
{
  const csv = csvOf(
    ['Customer Name', 'Order Date', 'Revenue', 'Domain'],
    [['Acme Corp', '2025-06-01', '5000', 'acme.com']]
  );
  const records = parseCSV(csv);
  assert(records[0].website === 'acme.com', 'REQUIRED: the "Domain" alias (a domain-only header, no scheme) is recognized');
}
{
  const csv = csvOf(
    ['Customer Name', 'Order Date', 'Revenue'],
    [['Acme Corp', '2025-06-01', '5000']]
  );
  const records = parseCSV(csv);
  assert(records[0].website === '', 'REQUIRED: a CSV with no website/domain column at all still parses successfully, with website defaulting to an empty string');
  assert(records[0].client === 'Acme Corp' && records[0].revenue === 5000, 'REQUIRED: every other existing field is completely unaffected by the presence/absence of a website column -- pre-existing CSV behavior is unchanged');
}
{
  const csv = csvOf(
    ['Customer Name', 'Order Date', 'Revenue', 'Website'],
    [['Acme Corp', '2025-06-01', '5000', '   ']]
  );
  const records = parseCSV(csv);
  assert(records[0].website === '', 'a blank/whitespace-only website cell parses to an empty string, not a crash or a garbage value');
}

// ===========================================================================
// 2. processData() -- real per-account aggregation, including website.
// ===========================================================================
// processData() pulls in a large dependency graph unrelated to website
// aggregation (revenue scoring, DOM/upload-modal side effects, etc.) --
// matching the pattern other tests already use for this exact function
// (see test-guided-tour-and-import-experience.js), this checks the real
// extracted source text rather than fighting that whole graph just to
// prove one already-existing, one-line aggregation.
const processDataSrc = extractFn(DASHBOARD_SRC, 'processData');
assert(
  /website:\s*allOrders\.find\(o\s*=>\s*o\.website\)\?\.website\s*\|\|\s*''/.test(processDataSrc),
  'REQUIRED: processData() aggregates the account-level website from whichever uploaded row supplied one, defaulting to an empty string (never undefined/null) when none did'
);

// ===========================================================================
// 3. resolveTargetIdentity() / normalizeDomain() -- the real identity-
//    pipeline handoff (api/lib/monitoring-identity.js, unmodified). Proves
//    an aggregated account.website value receives its documented
//    strongest-precedence treatment, and that malformed input fails safe.
// ===========================================================================
{
  const result = resolveTargetIdentity({ current: {}, uploadedWebsite: 'acme.com', contacts: [] });
  assert(result && result.status === 'derived' && result.domain === 'acme.com' && result.source === 'uploaded-website', `REQUIRED: a domain-only uploaded website resolves to a derived identity with the strongest source ("uploaded-website") (got ${JSON.stringify(result)})`);
}
{
  const result = resolveTargetIdentity({ current: {}, uploadedWebsite: 'https://www.acme.com/about-us', contacts: [] });
  assert(result && result.domain === 'acme.com', `REQUIRED: a full URL with scheme, www, and a path normalizes to the bare hostname (got ${JSON.stringify(result?.domain)})`);
}
{
  // Uploaded website must win over contact-derived identity -- the exact
  // precedence this backlog item exists to give resolveTargetIdentity().
  const result = resolveTargetIdentity({
    current: { status: 'derived', domain: 'otherbiz.com', source: 'contact-derived' },
    uploadedWebsite: 'acme.com',
    contacts: [{ email: 'sales@otherbiz.com' }]
  });
  assert(result && result.domain === 'acme.com' && result.source === 'uploaded-website', 'REQUIRED: an uploaded website takes precedence over an existing contact-derived identity, even when contacts still point elsewhere');
}
{
  const result = resolveTargetIdentity({ current: {}, uploadedWebsite: '', contacts: [] });
  assert(result === null, 'REQUIRED: a missing website (empty string) with no contacts produces no identity change -- absence of data never forces a change');
}
{
  const result = resolveTargetIdentity({ current: {}, uploadedWebsite: '   ', contacts: [] });
  assert(result === null, 'REQUIRED: a whitespace-only website value fails safe -- treated as no uploaded website, never a crash or a bogus domain');
}
{
  const result = resolveTargetIdentity({ current: {}, uploadedWebsite: 'not a url $$$ not-a-domain', contacts: [] });
  assert(result === null, 'REQUIRED: a malformed/garbage website value fails safe -- normalizeDomain() cannot parse it, so resolveTargetIdentity() treats it as no usable website, never throws');
}
{
  const result = resolveTargetIdentity({ current: {}, uploadedWebsite: 'http://', contacts: [] });
  assert(result === null, 'a scheme with no host fails safe the same way');
}
{
  assert(normalizeDomain('') === '', 'normalizeDomain() on an empty string returns an empty string, not a throw');
  assert(normalizeDomain('   ') === '', 'normalizeDomain() on whitespace returns an empty string');
  assert(normalizeDomain('ACME.COM') === 'acme.com', 'normalizeDomain() lowercases a bare domain, matching existing convention');
}

// ===========================================================================
// 4. Discoverability -- the actual gap this sprint closed. Static content
//    checks only; no behavior claims.
// ===========================================================================
{
  const csvText = readFileSync(new URL('../export-guides/sample-customer-order-history.csv', import.meta.url), 'utf8');
  const header = csvText.split('\n')[0];
  assert(/\bWebsite\b/i.test(header), 'REQUIRED: the downloadable sample CSV template now includes a Website column');
  const dataRows = csvText.trim().split('\n').slice(1);
  const websiteColIdx = header.split(',').findIndex(h => h.trim().toLowerCase() === 'website');
  assert(websiteColIdx !== -1 && dataRows.every(r => (r.split(',')[websiteColIdx] || '').trim().length > 0), 'REQUIRED: every sample row has a real, non-empty example website value');
}
{
  assert(/Company website is strongly recommended/i.test(DASHBOARD_SRC), 'REQUIRED: the Add Customer Data modal now tells the user Company Website is strongly recommended');
}
{
  const guides = ['antera', 'commonsku', 'esp', 'facilis', 'generic-excel'];
  for(const g of guides){
    const html = readFileSync(new URL(`../export-guides/${g}/index.html`, import.meta.url), 'utf8');
    assert(/Strongly recommended.*Company Website/s.test(html), `REQUIRED: the ${g} export guide's "Recommended fields" section now calls out Company Website as strongly recommended`);
  }
}
{
  // The prospect-list guides (a different, unrelated future feature) must
  // NOT have been touched by this change -- confirms scope discipline.
  const prospectGuides = ['apollo', 'hubspot', 'pipedrive', 'salesforce', 'zoominfo'];
  for(const g of prospectGuides){
    const html = readFileSync(new URL(`../export-guides/${g}/index.html`, import.meta.url), 'utf8');
    assert(!/Strongly recommended.*Company Website/s.test(html), `sanity: the unrelated ${g} prospect-list guide was correctly left untouched`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
