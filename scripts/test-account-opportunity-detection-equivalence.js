// Organizational Learning V1B: proves api/lib/account-opportunities.js's
// findRepeatPatternGroups() stays behaviorally identical to the dashboard's
// own REAL findRepeatPatternGroups() (dashboard/index.html, extracted
// verbatim via dashboard-extract.js) across shared fixtures. This is the
// anti-drift guarantee the design doc calls for in place of physically
// relocating the dashboard's function (which at least 5 existing test files
// already extract/call by name -- see api/lib/account-opportunities.js's
// own header comment for why literal file-sharing was rejected). Editing
// either copy's thresholds/anchor logic without the other breaks this file.
//
// Usage: node scripts/test-account-opportunity-detection-equivalence.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';
import { findRepeatPatternGroups as serverFindRepeatPatternGroups, computeFollowUpEvidence } from '../api/lib/account-opportunities.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const AVERAGE_REVENUE_SRC = extractFn(DASHBOARD_SRC, 'averageRevenue');
const MONTH_NAME_SRC = extractFn(DASHBOARD_SRC, 'monthNameFromDate');
const FIND_REPEAT_PATTERN_GROUPS_SRC = extractFn(DASHBOARD_SRC, 'findRepeatPatternGroups');

const sandbox = { console, Array, Map, Set, Date, Math, String, Number };
vm.createContext(sandbox);
new vm.Script([AVERAGE_REVENUE_SRC, MONTH_NAME_SRC, FIND_REPEAT_PATTERN_GROUPS_SRC].join('\n\n'), { filename: 'dashboard-repeat-pattern-extract.js' }).runInContext(sandbox);
const dashboardFindRepeatPatternGroups = (purchases) => sandbox.findRepeatPatternGroups({ purchases });

function d(dateStr) { return new Date(dateStr); }

// Comparable projection -- the dashboard's own patterns carry extra
// rendering-only fields (orders, lastDateStr, hasCurrentSeasonActivity)
// the server module deliberately omits; equivalence is about identity/
// evidence, not object shape.
function identityShape(patterns) {
  return patterns.map(p => ({
    category: p.category, orderCount: p.orderCount, years: p.years,
    monthLabel: p.monthLabel, lastDate: p.lastDate.toISOString(),
    avgRevenue: Math.round(p.avgRevenue * 100) / 100, confidence: p.confidence
  }));
}

const FIXTURES = [
  {
    name: 'multi-year seasonal Apparel pattern (Acme)',
    purchases: [
      { category: 'Apparel', revenue: 2000, date: d('2024-03-10') },
      { category: 'Apparel', revenue: 2400, date: d('2025-03-15') },
      { category: 'Headwear', revenue: 500, date: d('2025-06-01') }
    ]
  },
  {
    name: 'high-volume single-year Apparel pattern',
    purchases: [
      { category: 'Apparel', revenue: 1000, date: d('2025-01-05') },
      { category: 'Apparel', revenue: 1200, date: d('2025-04-10') },
      { category: 'Apparel', revenue: 1100, date: d('2025-08-20') }
    ]
  },
  {
    name: 'two orders, no qualifying evidence -- no pattern',
    purchases: [
      { category: 'Drinkware', revenue: 300, date: d('2024-01-01') },
      { category: 'Drinkware', revenue: 320, date: d('2025-05-01') }
    ]
  },
  {
    name: 'single order only -- below the 2-order minimum',
    purchases: [{ category: 'Apparel', revenue: 900, date: d('2025-06-01') }]
  },
  {
    name: 'Uncategorized excluded entirely',
    purchases: [
      { category: 'Uncategorized', revenue: 100, date: d('2024-01-01') },
      { category: 'Uncategorized', revenue: 100, date: d('2025-01-01') }
    ]
  },
  {
    name: 'more than 3 qualifying categories -- capped at top 3',
    purchases: [
      { category: 'Apparel', revenue: 5000, date: d('2024-01-01') }, { category: 'Apparel', revenue: 5200, date: d('2025-01-01') },
      { category: 'Headwear', revenue: 100, date: d('2024-02-01') }, { category: 'Headwear', revenue: 110, date: d('2025-02-01') },
      { category: 'Drinkware', revenue: 200, date: d('2024-03-01') }, { category: 'Drinkware', revenue: 210, date: d('2025-03-01') },
      { category: 'Event / Giveaway', revenue: 300, date: d('2024-04-01') }, { category: 'Event / Giveaway', revenue: 310, date: d('2025-04-01') }
    ]
  },
  { name: 'empty purchase history', purchases: [] }
];

for (const fixture of FIXTURES) {
  const dashboardResult = identityShape(dashboardFindRepeatPatternGroups(fixture.purchases));
  const serverResult = identityShape(serverFindRepeatPatternGroups(fixture.purchases));
  assert(
    JSON.stringify(dashboardResult) === JSON.stringify(serverResult),
    `REQUIRED: server findRepeatPatternGroups() matches the dashboard's real function for "${fixture.name}" (dashboard=${JSON.stringify(dashboardResult)}, server=${JSON.stringify(serverResult)})`
  );
}

// ---------------------------------------------------------------------
// computeFollowUpEvidence(): deliberately not compared against a dashboard
// counterpart -- there is no dashboard equivalent, by design (Follow-Up
// existence is intentionally decoupled from generateFutureOpportunities()'s
// industry-template engine). Covered directly here instead.
// ---------------------------------------------------------------------
{
  const evidence = computeFollowUpEvidence([
    { category: 'Apparel', date: d('2024-01-01') },
    { category: 'Headwear', date: d('2025-06-15') }
  ]);
  assert(evidence.orderCount === 2, `REQUIRED: orderCount counts every dated purchase record (got ${evidence?.orderCount})`);
  assert(evidence.mostRecentOrderDate.toISOString().slice(0, 10) === '2025-06-15', `REQUIRED: mostRecentOrderDate is the latest dated purchase (got ${evidence?.mostRecentOrderDate})`);
}
{
  const evidence = computeFollowUpEvidence([{ category: 'Apparel', date: null }]);
  assert(evidence === null, 'REQUIRED: an account with no resolvable purchase date has no Follow-Up evidence at all');
}
{
  assert(computeFollowUpEvidence([]) === null, 'REQUIRED: an account with zero purchases has no Follow-Up evidence');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
