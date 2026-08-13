// Pricing/billing sprint, correction round: the dashboard's compact usage
// badge (dashboardUsageInfo()/renderDashboardUsage() in dashboard/
// index.html) read `info.isFree` -- which is actually "this org has a
// finite monitored-account cap" (entitlement's isLimitedPlan) -- as if it
// meant "this org is on the Free plan." That's true for the actual Free
// plan, but ALSO true for any paid capacity band (e.g. a $99/mo
// 100-account org), so a genuinely paid customer was shown "Free ·
// 50/100 companies". Same root cause in the locked-card upgrade message
// (renderRepOpportunityCard()'s lockedAccountMessageHtml()), which
// hardcoded "You're monitoring 10 companies for free" regardless of plan.
//
// Extracts the REAL functions out of dashboard/index.html into a vm
// sandbox (same technique as scripts/test-commercial-intelligence-card-
// ux.js) and exercises them directly against the exact shape traced from
// the real sandbox test org.
//
// Usage: node scripts/test-paid-capacity-dashboard-badge.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';
import { entitlement } from '../api/lib/entitlement.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const DASHBOARD_USAGE_VAR = extractFn(DASHBOARD_SRC, 'dashboardUsage');
const NORMALIZE_FN = extractFn(DASHBOARD_SRC, 'normalizeCompanyNameForLimit');
const USAGE_INFO_FN = extractFn(DASHBOARD_SRC, 'dashboardUsageInfo');
const RENDER_USAGE_FN = extractFn(DASHBOARD_SRC, 'renderDashboardUsage');
const LOCKED_MSG_FN = extractFn(DASHBOARD_SRC, 'lockedAccountMessageHtml');

function makeSandbox(){
  const trialStatusEl = { textContent: '' };
  const sandbox = {
    console,
    document: { getElementById: (id) => id === 'dashboardTrialStatus' ? trialStatusEl : null },
    __trialStatusEl: trialStatusEl,
    Number, String, Math, Set, JSON
  };
  vm.createContext(sandbox);
  const fullSource = [
    DASHBOARD_USAGE_VAR,
    NORMALIZE_FN,
    USAGE_INFO_FN,
    RENDER_USAGE_FN,
    LOCKED_MSG_FN,
    // Test-only plumbing: dashboardUsage is a top-level `let` in the real
    // file, set elsewhere by loadDashboardUsage()'s fetch response. vm
    // contexts don't expose `let` bindings as global properties, so a
    // small in-scope setter is the standard way to reach it from outside.
    `function __setDashboardUsage(u){ dashboardUsage = u; }`
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'dashboard-usage-badge-extract.js' }).runInContext(sandbox);
  return sandbox;
}

for(const [name, fn] of [['dashboardUsageInfo', 'dashboardUsageInfo'], ['renderDashboardUsage', 'renderDashboardUsage'], ['lockedAccountMessageHtml', 'lockedAccountMessageHtml']]){
  assert(typeof makeSandbox()[fn] === 'function', `extraction produced a real function (${name})`);
}

// ===========================================================================
// REQUIRED: the exact real-world shape traced from the sandbox test org --
// plan='paid', subscription_status='active', account_capacity=100, 50
// monitored companies.
// ===========================================================================
{
  const sandbox = makeSandbox();
  const org = { plan: 'paid', subscription_status: 'active', account_capacity: 100 };
  const usage = { ...entitlement(org), totalMonitoredCompanies: 50, monitoredCompanyNames: [] };
  sandbox.__setDashboardUsage({ organization: org, usage });

  const info = sandbox.dashboardUsageInfo();
  assert(info.plan === 'paid', 'dashboardUsageInfo() reports the real plan value "paid"');
  assert(info.isFree === true && info.limit === 100, 'a finite 100-account capacity still triggers the capped-display branch (isFree/isLimitedPlan), just not literally "Free"');

  sandbox.renderDashboardUsage();
  const text = sandbox.__trialStatusEl.textContent;
  assert(text === '50 / 100 accounts monitored', `REQUIRED: the badge reads "50 / 100 accounts monitored" for a paid 100-account org, not "Free · 50/100 companies" (got "${text}")`);
  assert(!/Free/i.test(text), 'REQUIRED: the word "Free" never appears for a plan=\'paid\' organization');
}

// A genuinely Free-plan org keeps its exact prior wording, unchanged.
{
  const sandbox = makeSandbox();
  const org = { plan: 'free', subscription_status: 'inactive' };
  const usage = { ...entitlement(org), totalMonitoredCompanies: 4, monitoredCompanyNames: [] };
  sandbox.__setDashboardUsage({ organization: org, usage });
  sandbox.renderDashboardUsage();
  assert(sandbox.__trialStatusEl.textContent === 'Free · 4/10 companies', `an actual Free-plan org still shows "Free · 4/10 companies" (got "${sandbox.__trialStatusEl.textContent}")`);
}

// A paid org with unlimited capacity (e.g. a manual/enterprise grant with
// a null account_capacity) is unaffected -- falls through to the plain
// "N companies monitored" branch, same as before this correction.
{
  const sandbox = makeSandbox();
  const org = { plan: 'paid', subscription_status: 'manual', account_capacity: null };
  const usage = { ...entitlement(org), totalMonitoredCompanies: 340, monitoredCompanyNames: [] };
  sandbox.__setDashboardUsage({ organization: org, usage });
  sandbox.renderDashboardUsage();
  assert(sandbox.__trialStatusEl.textContent === '340 companies monitored', `an unlimited paid org shows the plain usage count, unaffected by this correction (got "${sandbox.__trialStatusEl.textContent}")`);
}

// An org still inside an unconverted legacy trial keeps its existing
// trial pill -- proves this correction did not touch that path.
{
  const sandbox = makeSandbox();
  const org = { plan: 'team', subscription_status: 'trialing', trial_status: 'active', trial_end: new Date(Date.now() + 28 * 86400000).toISOString() };
  const usage = { ...entitlement(org), totalMonitoredCompanies: 3, monitoredCompanyNames: [] };
  sandbox.__setDashboardUsage({ organization: org, usage });
  sandbox.renderDashboardUsage();
  assert(sandbox.__trialStatusEl.textContent === 'Team trial · 28 days left', `an unconverted legacy trial org still shows its trial pill, unchanged (got "${sandbox.__trialStatusEl.textContent}")`);
}

// ===========================================================================
// lockedAccountMessageHtml(): the same "Free" mislabel existed in the
// locked-card upgrade message.
// ===========================================================================
{
  const sandbox = makeSandbox();
  const org = { plan: 'free', subscription_status: 'inactive' };
  sandbox.__setDashboardUsage({ organization: org, usage: entitlement(org) });
  const html = sandbox.lockedAccountMessageHtml();
  assert(/You’re monitoring 10 companies for free/.test(html), 'the Free-plan locked message keeps its original wording');
}
{
  const sandbox = makeSandbox();
  const org = { plan: 'paid', subscription_status: 'active', account_capacity: 100 };
  sandbox.__setDashboardUsage({ organization: org, usage: entitlement(org) });
  const html = sandbox.lockedAccountMessageHtml();
  assert(!/for free/i.test(html), 'REQUIRED: a paid org\'s locked message never says "for free"');
  assert(/100-account plan/.test(html), `a paid 100-account org's locked message references its real 100-account limit (got "${html}")`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
