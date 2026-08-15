// Monitoring Identity V1, Path B wiring -- founder QA follow-up: proves the
// LIVE read-time call sites (api/get-dashboard.js's opportunity feed and
// "Newly Detected" gating, api/weekly-scan.js's digest eligibility) actually
// pass real target-level identity context into
// classifyMonitoringSignalEligibility(), not merely that the classifier
// itself is correct in isolation (see scripts/test-monitoring-identity-v1.js
// for that). Runs the REAL, exported functions end to end -- no
// reimplementation of the wiring being tested.
//
// Usage: node scripts/test-monitoring-identity-path-b-wiring.js
import { buildAccountsFromRows } from '../api/get-dashboard.js';
import { buildTargetIdentityIndex } from '../api/lib/monitoring-identity.js';
import handler from '../api/weekly-scan.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}

// The exact real-world shape from the live Test B fixture: a bare, exact,
// unembedded company-name match with no independent signal-side
// corroborator ('company named in source' is neither a strong nor a weak
// marker -- see classifyCorroboratorTier()).
function llBeanSignalRow(overrides = {}) {
  return {
    user_id: 'user-real', upload_id: null, account_name: 'L.L. Bean',
    signal_type: 'Renovation Completed', title: 'Flagship Store Reopening',
    why_reach_out: 'The reopening of the flagship store presents an opportunity to engage customers.',
    confidence: 48, source_url: 'https://www.pressherald.com/2026/06/11/l-l-bean-sets-flagship-reopening-for-september/',
    source_domain: 'pressherald.com', published_at: '2026-06-11T00:00:00Z',
    first_seen_at: '2026-08-15T14:54:18.617Z', last_seen_at: '2026-08-15T14:54:18.617Z',
    event_fingerprint: 'v2|l l bean|src:pressherald.com/2026/06/11/l-l-bean-sets-flagship-reopening-for-september|c1b0d287|2026-09-18',
    payload: {
      isReal: true, identityConfidence: 'unconfirmed', identityCorroboratorReasons: ['company named in source'],
      signalTitle: 'Flagship Store Reopening', whatChanged: 'L.L. Bean is reopening its flagship store.',
      sourceUrl: 'https://www.pressherald.com/2026/06/11/l-l-bean-sets-flagship-reopening-for-september/',
      actionabilityStatus: { status: 'upcoming', tense: 'future', isPriorityEligible: true },
      confidenceScore: 48
    },
    ...overrides
  };
}

const llBeanAccountRow = {
  account_name: 'L.L. Bean', user_id: 'user-real', upload_id: null, industry: 'Test',
  contact_name: '', contact_email: '',
  metrics: { revenue: 0, orderCount: 0, confidence: 0, relationshipStrength: 0 },
  raw_data: { monitoring_status: 'active' }
};

const resolvedTargetRow = {
  user_id: 'user-real', display_account_name: 'L.L. Bean',
  identity_status: 'derived', identity_domain: 'llbean.com', identity_domain_source: 'uploaded-website'
};
const unresolvedTargetRow = {
  user_id: 'user-real', display_account_name: 'L.L. Bean',
  identity_status: 'unresolved', identity_domain: null, identity_domain_source: null
};

// ============================================================================
// 1. get-dashboard.js's buildAccountsFromRows() -- the real function, not a
//    reimplementation -- actually consults the target identity index it's
//    handed, both for futureOpportunities gating and (implicitly, since it
//    uses the same lookup helper) the "Newly Detected" path.
// ============================================================================
{
  const targetIdentityIndex = buildTargetIdentityIndex([resolvedTargetRow]);
  const { accountList } = buildAccountsFromRows([llBeanAccountRow], [llBeanSignalRow()], [], targetIdentityIndex);
  const account = accountList.find(a => a.name === 'L.L. Bean');
  assert(!!account, 'sanity: L.L. Bean survives buildAccountsFromRows()');
  assert(
    (account?.futureOpportunities || []).some(o => /Flagship Store Reopening/i.test(o.signalTitle || '')),
    'REQUIRED 1) the real, stored L.L. Bean signal (unconfirmed, bare name match, no signal-level corroborator) reaches futureOpportunities/priority when paired with its resolved uploaded-website monitoring target via the REAL live dashboard wiring'
  );
}

{
  // REQUIRED 2) unresolved target -- explicit target row present, but with
  // no identity_domain_source -- the same exact-name signal must NOT reach
  // priority. This proves the wiring reads the real per-target value, not
  // just "a target row exists at all."
  const targetIdentityIndex = buildTargetIdentityIndex([unresolvedTargetRow]);
  const { accountList } = buildAccountsFromRows([llBeanAccountRow], [llBeanSignalRow()], [], targetIdentityIndex);
  const account = accountList.find(a => a.name === 'L.L. Bean');
  assert(
    !(account?.futureOpportunities || []).some(o => /Flagship Store Reopening/i.test(o.signalTitle || '')),
    'REQUIRED 2) the identical signal against an UNRESOLVED target (no identity_domain_source) stays out of futureOpportunities -- Path B never fires without a strong target anchor'
  );
  assert(
    (account?.signals || []).some(s => /Flagship Store Reopening/i.test(s.title || s.signalTitle || '')),
    '2) the signal is still visible in Research Details (acct.signals), just not promoted'
  );
}

{
  // REQUIRED 3) resolved target + 'possible' (embedded/token-only) signal
  // match stays secondary -- strong target identity never promotes a
  // namesake-shaped match, even through the live wiring.
  const targetIdentityIndex = buildTargetIdentityIndex([resolvedTargetRow]);
  const possibleRow = llBeanSignalRow({
    title: 'L.L. Bean Regional Office Park Development',
    payload: { ...llBeanSignalRow().payload, identityConfidence: 'possible', identityCorroboratorReasons: ['bare match is embedded inside a larger, different proper-name entity in the source text -- treated as a possible match, not a confirmed reference'] }
  });
  const { accountList } = buildAccountsFromRows([llBeanAccountRow], [possibleRow], [], targetIdentityIndex);
  const account = accountList.find(a => a.name === 'L.L. Bean');
  assert(
    !(account?.futureOpportunities || []).some(o => /Regional Office Park/i.test(o.signalTitle || '')),
    "REQUIRED 3) a 'possible' (embedded/larger-entity) signal match stays secondary even against a fully resolved target, through the live wiring"
  );
}

{
  // REQUIRED 4) missing target lookup entirely -- no ha_monitoring_targets
  // row for this account at all (e.g. predates Monitoring Identity V1, or
  // this read simply couldn't resolve one) -- fails conservatively to the
  // existing Path-A-only behavior, never accidentally promoting.
  const emptyTargetIdentityIndex = buildTargetIdentityIndex([]);
  const { accountList } = buildAccountsFromRows([llBeanAccountRow], [llBeanSignalRow()], [], emptyTargetIdentityIndex);
  const account = accountList.find(a => a.name === 'L.L. Bean');
  assert(
    !(account?.futureOpportunities || []).some(o => /Flagship Store Reopening/i.test(o.signalTitle || '')),
    'REQUIRED 4) a missing target lookup (empty index, no matching row) fails conservatively -- the signal stays secondary, exactly the pre-Path-B behavior'
  );
}

// ============================================================================
// 5. api/weekly-scan.js's digest eligibility -- the REAL exported handler,
//    full end-to-end invocation with a mocked Supabase/research-batch/Resend
//    layer (same pattern as scripts/test-weekly-scan-reliability.js), to
//    prove the digest path also consults live target identity, not just
//    that the classifier works in isolation.
// ============================================================================
const TEST_CRON_SECRET = 'test-cron-secret-path-b-wiring';
const DIGEST_USER_ID = 'user-digest-pathb';
// Digest-scenario target rows, scoped to the digest mock's OWN user_id
// (user-digest-pathb, not user-real) -- a target row's user_id must match
// the account whose signal is being classified, or the identityKey()
// lookup legitimately misses (this is a distinct fixture from
// resolvedTargetRow/unresolvedTargetRow above, which are scoped to the
// dashboard tests' user-real).
const resolvedDigestTargetRow = { user_id: DIGEST_USER_ID, display_account_name: 'L.L. Bean', identity_status: 'derived', identity_domain: 'llbean.com', identity_domain_source: 'uploaded-website' };
const unresolvedDigestTargetRow = { user_id: DIGEST_USER_ID, display_account_name: 'L.L. Bean', identity_status: 'unresolved', identity_domain: null, identity_domain_source: null };

async function runDigestScenario({ monitoringTargetRows, signalOverrides = {} }) {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  process.env.RESEND_API_KEY = 'fake-resend-key';
  delete process.env.WEEKLY_RESEARCH_BATCH_SIZE;

  const userId = 'user-digest-pathb';
  const upload = { id: 'upload-pathb', user_id: userId, upload_name: 'List', summary: {}, created_at: new Date().toISOString(), ha_users: { id: userId, email: 'rep@example.com', name: 'Rep', company: '' } };
  const account = { id: 'acct-llbean', account_name: 'L.L. Bean', industry: '', contact_name: '', contact_email: '', metrics: {}, raw_data: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

  const emailCalls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if (u.includes('/rest/v1/ha_uploads')) return jsonResponse([upload]);
    if (u.includes('/rest/v1/ha_accounts')) return jsonResponse([account]);
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'GET') return jsonResponse([]);
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'POST') return jsonResponse([{ id: 'run-pathb', ...JSON.parse(options.body)[0] }]);
    if (u.includes('/rest/v1/ha_weekly_runs') && method === 'PATCH') return jsonResponse([{ id: 'run-pathb-patched' }]);
    if (u.includes('/rest/v1/ha_signals') && method === 'POST') return jsonResponse(JSON.parse(options.body));
    if (u.includes('/rest/v1/ha_monitoring_targets')) return jsonResponse(monitoringTargetRows);
    if (u.includes('/api/research-batch')) {
      return jsonResponse({
        signals: [{
          accountName: 'L.L. Bean', signalType: 'Renovation Completed', signalTitle: 'Flagship Store Reopening',
          whatChanged: 'L.L. Bean is reopening its flagship store.', whyItMattersForPromo: 'Timely reason to reach out',
          sourceUrl: 'https://www.pressherald.com/2026/06/11/l-l-bean-sets-flagship-reopening-for-september/',
          confidenceScore: 48, publicationDate: new Date().toISOString(),
          // Required for classifyLegacySignalActionability() to reach a
          // priority-eligible actionability status at all (a separate gate
          // digestEligibleRows also requires) -- matches the real,
          // persisted Test B signal's own eventDate, so this fixture
          // clears the SAME actionability bar the live signal did, and
          // only the identity-eligibility gate varies across these
          // scenarios.
          eventDate: '2026-09-18',
          identityConfidence: 'unconfirmed', identityCorroboratorReasons: ['company named in source'],
          ...signalOverrides
        }],
        diagnostics: { structuredSummary: { eligibleAccounts: 1, processedAccounts: 1, failedAccounts: 0 } }
      });
    }
    if (u === 'https://api.resend.com/emails' && method === 'POST') {
      const body = JSON.parse(options.body);
      emailCalls.push(body);
      return jsonResponse({ id: 'resend-id-pathb' });
    }
    throw new Error(`Unhandled fetch in Path B digest wiring test mock: ${method} ${u}`);
  };

  const req = { method: 'GET', headers: { host: 'example.test', authorization: `Bearer ${TEST_CRON_SECRET}` }, query: { limit: '25' } };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  try {
    await handler(req, res);
  } finally {
    global.fetch = realFetch;
  }
  return { res, emailCalls };
}

{
  // REQUIRED: resolved target (uploaded-website) + the real unconfirmed
  // bare-name-match signal shape => digest eligible (email sent).
  const { res, emailCalls } = await runDigestScenario({ monitoringTargetRows: [resolvedDigestTargetRow] });
  assert(res.statusCode === 200, 'REQUIRED 5) resolved-target digest scenario returns 200');
  assert(emailCalls.length === 1, `REQUIRED 5) a resolved target (uploaded-website) + unconfirmed bare-name-match signal is digest-eligible -- exactly one digest email sent (got ${emailCalls.length})`);
}

{
  // REQUIRED: unresolved target (explicit target row, no identity_domain_source)
  // + the same signal shape => NOT digest eligible (no email).
  const { res, emailCalls } = await runDigestScenario({ monitoringTargetRows: [unresolvedDigestTargetRow] });
  assert(res.statusCode === 200, 'REQUIRED 6) unresolved-target digest scenario still returns 200');
  assert(emailCalls.length === 0, `REQUIRED 6) an UNRESOLVED target + the identical signal is NOT digest eligible -- zero digest emails sent (got ${emailCalls.length})`);
}

{
  // REQUIRED: resolved target + a 'possible' (embedded/token-only) signal
  // match => NOT digest eligible.
  const { res, emailCalls } = await runDigestScenario({
    monitoringTargetRows: [resolvedDigestTargetRow],
    signalOverrides: { identityConfidence: 'possible', identityCorroboratorReasons: ['bare match is embedded inside a larger, different proper-name entity in the source text -- treated as a possible match, not a confirmed reference'] }
  });
  assert(res.statusCode === 200, 'REQUIRED 7) resolved-target + possible-match digest scenario still returns 200');
  assert(emailCalls.length === 0, `REQUIRED 7) a resolved target + only a 'possible' signal match is NOT digest eligible, even with a strong target anchor -- zero digest emails sent (got ${emailCalls.length})`);
}

{
  // REQUIRED: missing target lookup entirely (ha_monitoring_targets returns
  // no row for this account) => fails conservatively, NOT digest eligible.
  const { res, emailCalls } = await runDigestScenario({ monitoringTargetRows: [] });
  assert(res.statusCode === 200, 'REQUIRED 8) missing-target-lookup digest scenario still returns 200');
  assert(emailCalls.length === 0, `REQUIRED 8) a missing target lookup (no ha_monitoring_targets row at all) fails conservatively -- zero digest emails sent, exactly the pre-Path-B behavior (got ${emailCalls.length})`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
