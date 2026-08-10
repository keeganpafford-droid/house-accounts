// Commercial-readiness correction round (final), item 1: a REAL rendered
// weekly-digest preview generated through the EXACT final weekly-scan
// input path -- not a hand-adapted mockup. Every function that touches a
// digest row here is imported unmodified from api/weekly-scan.js:
//   - accountPayload() shapes a raw ha_accounts row exactly as the real
//     handler does;
//   - deriveAccountHistoryDigestRows() is the SAME function the real
//     handler now calls per upload to pull recent-order follow-ups and
//     reorder opportunities out of already-stored order history
//     (raw_data.existingSignals/repeatPatterns);
//   - dedupeDigestRows() is the SAME whole-bucket dedup the real handler
//     applies right before send;
//   - reportHtml()/weeklySummaryFromSignals() are the SAME renderer used
//     for the real email.
// This script does NOT construct digest rows by hand for account-history
// opportunities -- it builds ha_accounts-shaped rows (raw_data.
// existingSignals/repeatPatterns) from a real run of the dashboard's own
// signal-generation pipeline against the fixture CSV, exactly as
// dashboard/index.html's serializeAccountForStorage() would persist them,
// then hands those rows to the real weekly-scan functions.
//
// The one thing this script cannot do without running providers is
// discover a NEW public business signal -- so the single business-activity
// row below is constructed directly in the ha_signals row shape
// (account_name/signal_type/why_reach_out/payload) research-batch.js's
// real output already takes after api/weekly-scan.js inserts it, using
// the same L.L.Bean fixture text already used in
// scripts/test-paid-beta-sprint.js's acceptance tests. It is pushed into
// the SAME digestEligibleRows-equivalent list as the account-history rows,
// then run through the same dedupeDigestRows()/reportHtml() call the real
// handler makes.
//
// No email is sent -- this only writes a local HTML file. No provider is
// called (no OpenAI/Serper/Firecrawl network requests).
//
// Usage: node scripts/generate-digest-preview.js [output-path.html]
import { readFileSync, writeFileSync } from 'fs';
import vm from 'vm';
import { reportHtml, weeklySummaryFromSignals, accountPayload, deriveAccountHistoryDigestRows, dedupeDigestRows } from '../api/weekly-scan.js';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

const DASHBOARD_SRC = loadDashboardSource();

// Same real dashboard functions scripts/test-repeat-order-follow-up-fixture.js
// exercises, located by name/semantic range (not physical line position) via
// the shared extractor -- so a future dashboard edit that moves these
// functions cannot silently make this preview render from stale/wrong code.
const SRC = [
  extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG'),
  extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(value){', 'function isRelationshipExpansionOpportunity(opp){'),
  extractFn(DASHBOARD_SRC, 'isWebResearchSignal'),
  extractRange(DASHBOARD_SRC, 'function signalLayerLabel(opp){', 'function isRecentAccountActivity(opp){'),
  extractFn(DASHBOARD_SRC, 'isLikelyInvalidAccountName'),
  extractFn(DASHBOARD_SRC, 'parseMaybeDate'),
  extractFn(DASHBOARD_SRC, 'parseCSV'),
  extractFn(DASHBOARD_SRC, 'inferPromoCategory'),
  extractFn(DASHBOARD_SRC, 'inferIndustry'),
  extractFn(DASHBOARD_SRC, 'formatShortDate'),
  extractRange(DASHBOARD_SRC, 'function isAccountHistoryOpportunity(opp){', 'function accountHistoryStatusLine(opp){'),
  extractRange(DASHBOARD_SRC, 'function estimateFutureValue(account, opportunityType){', 'function getPriorityTier(opp){'),
  extractRange(DASHBOARD_SRC, 'function isClosedHistoricalRecord(record){', 'function sumRevenue(records){'),
  extractFn(DASHBOARD_SRC, 'normalizeSignalLayerType'),
  extractRange(DASHBOARD_SRC, 'function daysSinceDate(value){', 'function getRecommendationType(opp){'),
  extractRange(DASHBOARD_SRC, 'function calculateOpportunityScore(opp){', 'function assignOpportunityScore(opp, account){'),
  extractRange(DASHBOARD_SRC, 'function monthIndexFromName(name){', 'function opportunityMatchesTimebox(opp, timebox){')
].join('\n\n');

const EXPORT_NAMES = [
  'parseCSV', 'inferPromoCategory', 'inferIndustry', 'isLikelyInvalidAccountName', 'parseMaybeDate',
  'isClosedHistoricalRecord', 'isActivePipelineRecord', 'hasOrderHistoryEvidence', 'sumRevenue',
  'findRepeatPatternGroups', 'createRepeatPatternOpportunities', 'categoryToPromoSuggestions',
  'generateFutureOpportunities', 'createOpportunity',
  'signalLayerLabel', 'isWebResearchSignal', 'isRecentAccountActivity',
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

// Builds the exact ha_accounts row shape serializeAccountForStorage()
// persists (metrics + raw_data.existingSignals/repeatPatterns), then runs
// it through the REAL accountPayload() from api/weekly-scan.js -- the same
// read path the real handler uses for every account, every invocation.
function toStoredAccountRow(account){
  return {
    account_name: account.name,
    industry: account.industry || '',
    contact_name: account.contactName || '',
    contact_email: account.contactEmail || '',
    metrics: {
      revenue: account.revenue || 0,
      orderCount: account.orderCount || 0,
      relationshipStrength: account.relationshipStrength || 0
    },
    raw_data: {
      historicalCategories: [...(account.categoryTypes || [])],
      existingSignals: account.futureOpportunities.filter(o => o.signalLayerType === 'Follow-Up Signal'),
      repeatPatterns: account.futureOpportunities.filter(o => o.opportunityType === 'REPEAT PATTERN')
    }
  };
}

const accountPayloads = accounts.map(toStoredAccountRow).map(accountPayload);
const accountHistoryRows = deriveAccountHistoryDigestRows(accountPayloads);

// Real, sourced L.L.Bean business-activity signal (same fixture text
// already used in scripts/test-paid-beta-sprint.js's acceptance tests),
// in the exact row shape a real research-batch discovery would take after
// api/weekly-scan.js inserts it into ha_signals and the actionability gate
// (classifyLegacySignalActionability) passes it through as digest-eligible
// -- reproduced directly here rather than run through providers.
const llbeanRow = {
  account_name: 'L.L.Bean',
  signal_type: 'Business Activity',
  why_reach_out: 'L.L.Bean is investing over $50 million to reimagine its flagship store and retail campus, with a grand opening scheduled for September 18-20, 2026.',
  payload: {
    suggestedNextMove: 'Ask whether Retail Operations is already involved in the flagship renovation, or who else might be.',
    signalTitle: 'L.L.Bean flagship reopening after a significant renovation'
  }
};

// The exact combine-and-dedupe step the real handler performs per upload
// (allDigestRowsForUpload), followed by the exact whole-bucket dedup it
// applies right before send (dedupeDigestRows) -- both imported, neither
// reimplemented here.
const allDigestRowsForUpload = [llbeanRow, ...accountHistoryRows];
const dedupedRows = dedupeDigestRows(allDigestRowsForUpload);

const user = { email: 'rep@example.com', name: 'Sample Rep' };
const baseUrl = 'https://app.example.com';
const summary = weeklySummaryFromSignals(dedupedRows, accounts.length);
const emailHtml = reportHtml(user, null, dedupedRows, baseUrl, summary);

// "Other Accounts to Watch" -- explicitly a PREVIEW-TOOL-ONLY addition
// appended below the real, unmodified reportHtml() output, not part of
// what api/weekly-scan.js would actually send. Demonstrates what
// surfacing "other monitored accounts with no new signal this run" could
// look like without changing the real email template.
const otherAccountNames = accounts
  .map(a => a.name)
  .filter(name => !dedupedRows.some(r => r.account_name === name));
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
console.log(`Signals included: ${dedupedRows.map(r => r.account_name).join(', ')}`);
console.log(`Other Accounts to Watch: ${otherAccountNames.join(', ')}`);
console.log('No email was sent. No provider was called.');
