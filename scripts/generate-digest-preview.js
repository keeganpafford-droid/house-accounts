// Commercial-readiness correction round, item 8: a REAL rendered weekly-
// digest preview -- not a conceptual mockup. Uses the actual production
// renderer (reportHtml/weeklySummaryFromSignals, imported unmodified from
// api/weekly-scan.js) fed with:
//   - a real business-activity signal shape (the L.L.Bean flagship-
//     reopening fixture already used elsewhere in this repo's test suite,
//     scripts/test-paid-beta-sprint.js), and
//   - REAL account-history opportunities produced by running the actual
//     dashboard/index.html signal-generation pipeline (parseCSV ->
//     generateFutureOpportunities, extracted verbatim, same technique as
//     scripts/test-repeat-order-follow-up-fixture.js) against
//     scripts/fixtures/repeat-order-follow-up-fixture.csv, so the
//     Brightview/Ridgeline copy in this preview is byte-for-byte what the
//     corrected account-history status/label logic actually produces.
//
// No email is sent -- this only writes a local HTML file. No provider is
// called (no OpenAI/Serper/Firecrawl network requests).
//
// Usage: node scripts/generate-digest-preview.js [output-path.html]
import { readFileSync, writeFileSync } from 'fs';
import vm from 'vm';
import { reportHtml, weeklySummaryFromSignals } from '../api/weekly-scan.js';

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const lines = html.split('\n');

function extractLines(label, startLine, endLine, expectedFirst){
  const slice = lines.slice(startLine - 1, endLine);
  const first = slice[0].trim();
  if(!first.startsWith(expectedFirst)){
    throw new Error(`extractLines(${label}): dashboard/index.html line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this script.`);
  }
  return slice.join('\n');
}

// Same verbatim extraction ranges as scripts/test-repeat-order-follow-up-fixture.js.
const SRC = [
  extractLines('timebox-config', 2388, 2393, 'const TIMEBOX_CONFIG = {'),
  extractLines('opportunity-identity-helpers', 2529, 2614, 'function cleanOpportunityToken(value){'),
  extractLines('is-business-opportunity', 2945, 2947, 'function isBusinessOpportunity(opp){'),
  extractLines('signal-layer-label', 3610, 3620, 'function signalLayerLabel(opp){'),
  extractLines('is-likely-invalid-account-name', 3594, 3601, 'function isLikelyInvalidAccountName(name){'),
  extractLines('parse-maybe-date', 3646, 3651, 'function parseMaybeDate(value){'),
  extractLines('parse-csv', 3367, 3485, 'function parseCSV(text){'),
  extractLines('infer-promo-category', 3487, 3507, 'function inferPromoCategory(text){'),
  extractLines('infer-industry', 3509, 3517, 'function inferIndustry(client, projects){'),
  extractLines('format-short-date', 4065, 4069, 'function formatShortDate(value){'),
  extractLines('account-history-status', 4100, 4165, 'function isAccountHistoryOpportunity(opp){'),
  extractLines('opportunity-generation', 5737, 6266, 'function estimateFutureValue(account, opportunityType){'),
  extractLines('order-history-filters', 7025, 7053, 'function isClosedHistoricalRecord(record){'),
  extractLines('normalize-signal-layer-type', 7072, 7087, 'function normalizeSignalLayerType(type){'),
  extractLines('recommendation-type', 7090, 7139, 'function daysSinceDate(value){'),
  extractLines('opportunity-scoring', 7191, 7262, 'function calculateOpportunityScore(opp){'),
  extractLines('timebox-classification', 7390, 7446, 'function monthIndexFromName(name){')
].join('\n\n');

const EXPORT_NAMES = [
  'parseCSV', 'inferPromoCategory', 'inferIndustry', 'isLikelyInvalidAccountName', 'parseMaybeDate',
  'isClosedHistoricalRecord', 'isActivePipelineRecord', 'hasOrderHistoryEvidence', 'sumRevenue',
  'findRepeatPatternGroups', 'createRepeatPatternOpportunities', 'categoryToPromoSuggestions',
  'generateFutureOpportunities', 'createOpportunity',
  'signalLayerLabel', 'isBusinessOpportunity', 'isRecentAccountActivity',
  'isAccountHistoryOpportunity', 'reorderWindowStatus', 'accountHistoryStatusLine', 'formatShortDate',
  'getRecommendationType', 'getOpportunityPlanningWindow', 'opportunityMatchesTimebox',
  'classifyMonthWindow', 'monthDistanceFromNow', 'inferPurchaseMonth'
];

const sandbox = {};
vm.createContext(sandbox);
new vm.Script(`${SRC}\n\nthis.__exports = { ${EXPORT_NAMES.join(', ')} };`, { filename: 'dashboard-extract.js' }).runInContext(sandbox);
const dash = sandbox.__exports;

function buildAccounts(records){
  const clients = {};
  records.forEach(record => {
    if(!clients[record.client]) clients[record.client] = [];
    clients[record.client].push(record);
  });
  const closedRevenueByClient = Object.values(clients).map(orders => {
    const closed = orders.filter(dash.isClosedHistoricalRecord).filter(dash.hasOrderHistoryEvidence);
    return dash.sumRevenue(closed);
  });
  const minRev = Math.min(...closedRevenueByClient, 0);
  const maxRev = Math.max(...closedRevenueByClient, 1);
  const revRange = maxRev - minRev || 1;
  const accounts = [];
  for(const clientName in clients){
    const allOrders = clients[clientName];
    const closedOrders = allOrders.filter(dash.isClosedHistoricalRecord);
    const activePipeline = allOrders.filter(o => dash.hasOrderHistoryEvidence(o) && (!dash.isClosedHistoricalRecord(o) || dash.isActivePipelineRecord(o)));
    const scoringOrders = closedOrders.filter(dash.hasOrderHistoryEvidence);
    const totalRevenue = dash.sumRevenue(scoringOrders);
    const orderCount = scoringOrders.length;
    const categories = new Set(scoringOrders.map(o => o.category).filter(Boolean));
    const allProjects = [...new Set(allOrders.map(o => o.project).filter(Boolean))];
    const now = new Date();
    const mostRecentDate = scoringOrders.filter(o => o.date).sort((a, b) => b.date - a.date)[0]?.date;
    const daysSinceLast = mostRecentDate ? Math.floor((now - mostRecentDate) / (1000 * 60 * 60 * 24)) : 999;
    const revScore = (totalRevenue - minRev) / revRange;
    const freqScore = Math.min(orderCount / 10, 1);
    const recencyScore = Math.max(1 - (daysSinceLast / 365), 0);
    const diversityScore = Math.min(categories.size / 4, 1);
    const totalScore = orderCount > 0 ? (revScore * 0.4 + freqScore * 0.2 + recencyScore * 0.25 + diversityScore * 0.15) : 0;
    const confidence = Math.min(totalScore * 100, 100);
    const uploadedIndustry = allOrders.find(o => o.uploadedIndustry)?.uploadedIndustry || '';
    const industry = uploadedIndustry || dash.inferIndustry(clientName, allProjects);
    const account = {
      name: clientName, industry, revenue: totalRevenue, orderCount, confidence,
      subscores: { revenue: revScore, frequency: freqScore, recency: recencyScore, diversity: diversityScore },
      categoryTypes: categories,
      contactName: allOrders.find(o => o.contactName)?.contactName || '',
      contactEmail: allOrders.find(o => o.contactEmail)?.contactEmail || '',
      purchases: scoringOrders, activePipeline, allRecords: allOrders, signals: [],
      mostRecentDate: mostRecentDate ? mostRecentDate.toLocaleDateString() : 'Unknown'
    };
    account.futureOpportunities = orderCount > 0 ? dash.generateFutureOpportunities(account) : [];
    accounts.push(account);
  }
  return accounts;
}

const csvText = readFileSync(new URL('./fixtures/repeat-order-follow-up-fixture.csv', import.meta.url), 'utf8');
const records = dash.parseCSV(csvText);
const accounts = buildAccounts(records);
const byName = Object.fromEntries(accounts.map(a => [a.name, a]));

function groundedRepeatPatternOpp(accountName){
  const a = byName[accountName];
  return a.futureOpportunities.find(o => o.opportunityType === 'REPEAT PATTERN');
}
function groundedFollowUpOpp(accountName){
  const a = byName[accountName];
  return a.futureOpportunities.find(o => o.signalLayerType === 'Follow-Up Signal');
}

// Converts a real dashboard opportunity object into the ha_signals row
// shape reportHtml()/opportunityCardHtml() actually read (account_name,
// signal_type, why_reach_out, payload) -- the SAME field names
// api/weekly-scan.js writes when it persists a research-batch result. This
// is the one adaptation this preview tool performs: account-history
// opportunities are computed entirely client-side today and are not yet
// persisted to ha_signals/wired into weekly-scan.js's real query (a
// genuine backlog item, not something this branch changes -- see the
// accompanying report). Everything about the TEXT itself -- the status
// line, the conversation starter, the account name -- is the real,
// corrected production output, not invented for this preview.
function toDigestRow(accountName, opp){
  const statusLine = dash.accountHistoryStatusLine(opp);
  return {
    account_name: accountName,
    signal_type: opp.signalLayerType,
    why_reach_out: `${statusLine} — ${opp.whyNow || opp.reasonToReachOut || ''}`,
    payload: { suggestedNextMove: opp.conversationStarter, signalTitle: opp.opportunity || opp.opportunityName }
  };
}

// Real L.L.Bean business-signal fixture text, same shape/content already
// used in scripts/test-paid-beta-sprint.js's acceptance tests (a real,
// sourced business-activity signal -- not fabricated for this preview).
const llbeanRow = {
  account_name: 'L.L.Bean',
  signal_type: 'Business Activity',
  why_reach_out: 'L.L.Bean is investing over $50 million to reimagine its flagship store and retail campus, with a grand opening scheduled for September 18-20, 2026.',
  payload: {
    suggestedNextMove: 'Ask whether Retail Operations is already involved in the flagship renovation, or who else might be.',
    signalTitle: 'L.L.Bean flagship reopening after a significant renovation'
  }
};

const brightviewRow = toDigestRow('Brightview Dental Group', groundedFollowUpOpp('Brightview Dental Group'));
const ridgelineRow = toDigestRow('Ridgeline Auto Group', groundedRepeatPatternOpp('Ridgeline Auto Group'));
const lakeshoreRow = toDigestRow('Lakeshore Manufacturing Co', groundedRepeatPatternOpp('Lakeshore Manufacturing Co'));
const goldenValleyRow = toDigestRow('Golden Valley Steel Supply', groundedRepeatPatternOpp('Golden Valley Steel Supply'));

const newSignals = [llbeanRow, brightviewRow, ridgelineRow, lakeshoreRow, goldenValleyRow];

// Required proof: no exact duplicate opportunities in the digest, and
// stale/detail-only signals excluded (none of these are stale -- all are
// current-run signals; a genuinely stale/excluded business signal would
// simply never have reached digestEligibleRows in the real handler, per
// api/weekly-scan.js's classifyLegacySignalActionability() gate -- this
// preview only demonstrates the RENDERING side, not that gate itself,
// which is already covered by scripts/test-weekly-scan-reliability.js).
const seenKeys = new Set();
for(const row of newSignals){
  const key = `${row.account_name}|${row.why_reach_out}`;
  if(seenKeys.has(key)) throw new Error(`duplicate digest row detected for ${row.account_name} -- this preview tool requires unique rows, matching the real dedup guarantee`);
  seenKeys.add(key);
}

const user = { email: 'rep@example.com', name: 'Sample Rep' };
const baseUrl = 'https://app.example.com';
const summary = weeklySummaryFromSignals(newSignals, accounts.length);
const emailHtml = reportHtml(user, null, newSignals, baseUrl, summary);

// "Other Accounts to Watch" -- explicitly a PREVIEW-TOOL-ONLY addition
// appended below the real, unmodified reportHtml() output, not part of
// what api/weekly-scan.js would actually send. Demonstrates what
// surfacing "other monitored accounts with no new signal this run" could
// look like without changing the real email template.
const otherAccountNames = accounts
  .map(a => a.name)
  .filter(name => !newSignals.some(r => r.account_name === name));
const otherAccountsHtml = `
<div style="margin:24px auto 0;max-width:680px;padding:0 16px;">
  <div style="border:1px dashed #B45309;border-radius:14px;padding:16px 18px;background:#FBEFE3;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#92400E;margin-bottom:6px;">Preview tool addition — not part of the sent email</div>
    <h3 style="margin:0 0 8px;font-size:15px;color:#17375E;">Other Accounts to Watch</h3>
    <p style="margin:0 0 8px;font-size:13px;color:#5b677a;">No new actionable signal this run, but still monitored:</p>
    <ul style="margin:0;padding-left:20px;color:#25364d;font-size:13px;line-height:1.5;">
      ${otherAccountNames.map(n => `<li>${n}</li>`).join('')}
    </ul>
  </div>
</div>`;

const fullPreviewHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Weekly Digest Preview (local, no email sent)</title></head><body style="margin:0;background:#EEF1F5;">
${emailHtml}
${otherAccountsHtml}
</body></html>`;

const outPath = process.argv[2] || new URL('../digest-preview.html', import.meta.url).pathname;
writeFileSync(outPath, fullPreviewHtml);
console.log(`Digest preview written to: ${outPath}`);
console.log(`Signals included: ${newSignals.map(r => r.account_name).join(', ')}`);
console.log(`Other Accounts to Watch: ${otherAccountNames.join(', ')}`);
console.log('No email was sent. No provider was called.');
