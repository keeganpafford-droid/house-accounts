// Pricing/billing sprint: regression for api/lib/entitlement.js, the one
// authoritative monitored-account entitlement/count implementation that
// replaced three independently-drifted copies (api/settings.js,
// api/save-upload.js, api/prospect-one-off.js). Covers: the dynamic,
// self-expiring trial check; account_capacity only governing genuine
// paid/manual orgs; the free fallback; unlimited seats; and the
// customer+prospect+legacy aggregate count with active/paused/archived
// filtering preserved.
//
// Usage: node scripts/test-entitlement-unified.js
import { trialCurrentlyActive, accountCapacity, entitlement, usageFor } from '../api/lib/entitlement.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const daysFromNow = n => new Date(Date.now() + n * 86400000).toISOString();
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

// --- trialCurrentlyActive ---------------------------------------------
assert(trialCurrentlyActive({ trial_status: 'active', trial_end: daysFromNow(20) }) === true, 'an org with trial_status active and a future trial_end is currently trialing');
assert(trialCurrentlyActive({ subscription_status: 'trialing', trial_end: daysFromNow(5) }) === true, 'subscription_status "trialing" alone (regardless of trial_status) counts as currently trialing');
assert(trialCurrentlyActive({ trial_status: 'active', trial_end: daysAgo(1) }) === false, 'a trial_end in the past is NOT currently active, even if trial_status still says active');
assert(trialCurrentlyActive({ trial_status: 'active', trial_end: null }) === false, 'a null trial_end is never currently active');
assert(trialCurrentlyActive({}) === false, 'an org with no trial fields at all is not currently trialing');

// --- accountCapacity: the core "no permanently-unlimited hole" fix -----
assert(accountCapacity({ plan: 'free' }) === 10, 'a plain free org has a capacity of 10');
assert(accountCapacity({ subscription_status: 'trialing', trial_end: daysFromNow(10), account_capacity: null }) === null, 'a currently-active trial is unlimited, dynamically, regardless of the stored account_capacity column');
assert(accountCapacity({ subscription_status: 'trialing', trial_end: daysAgo(1), account_capacity: null }) === 10, 'THE KEY FIX: once trial_end passes and no real paid subscription exists, capacity reverts to 10 even though account_capacity is stored as NULL -- an expired, never-converted trial cannot remain permanently unlimited');
assert(accountCapacity({ subscription_status: 'active', account_capacity: 500 }) === 500, 'a genuinely active paid subscription reads the stored account_capacity');
assert(accountCapacity({ subscription_status: 'active', account_capacity: null }) === null, 'a genuinely active paid subscription with a null account_capacity (unlimited band) is unlimited');
assert(accountCapacity({ subscription_status: 'manual', account_capacity: null }) === null, 'a manual (out-of-band paid) org with null account_capacity is unlimited, preserving the existing manual-billing convention');
assert(accountCapacity({ subscription_status: 'manual', account_capacity: 1500 }) === 1500, 'a manual org with a specific granted capacity reads that number');
assert(accountCapacity({ subscription_status: 'canceled', account_capacity: 500 }) === 10, 'a canceled subscription falls back to the free ceiling of 10, even though account_capacity still holds the last-purchased number as a historical record');
assert(accountCapacity({ subscription_status: 'past_due', account_capacity: 500 }) === 10, 'a subscription_status the webhook wrote verbatim from Stripe (e.g. past_due) that is not active/paid/manual falls back to 10');
assert(accountCapacity({ plan: 'enterprise', subscription_status: 'inactive', account_capacity: null }) === 10, 'plan="enterprise" alone, with a subscription_status that is not active/paid/manual, does NOT bypass to unlimited -- subscription_status is the actual gate now, not the plan label');
{
  // A currently-active trial takes priority over a leftover finite
  // account_capacity ONLY when there is no genuine paid subscription --
  // subscription_status stays 'trialing' here, so this org has never
  // actually converted.
  const org = { subscription_status: 'trialing', trial_status: 'active', trial_end: daysFromNow(15), account_capacity: 10 };
  assert(accountCapacity(org) === null, 'an active (unconverted) trial is unlimited even if account_capacity happens to hold a finite leftover value');
}

// --- Correction round: paid precedence over a still-open legacy trial --
// This is the exact real-world shape traced from the sandbox test org:
// an organization already inside a grandfathered legacy trial
// (trial_status active, trial_end weeks out) that then completes a real
// Stripe Checkout while that trial window is still technically open.
{
  const convertedOrg = {
    plan: 'paid', subscription_status: 'active',
    trial_status: 'active', trial_end: daysFromNow(28), trial_used: true,
    account_capacity: 100
  };
  assert(accountCapacity(convertedOrg) === 100, 'REQUIRED: a genuine paid subscription wins immediately over a still-open legacy trial -- purchased capacity (100), not unlimited');
  const ent = entitlement(convertedOrg);
  assert(ent.companyLimit === 100, 'entitlement().companyLimit reflects the purchased capacity, not the leftover trial');
  assert(ent.trialActive === false, 'REQUIRED: customer-facing entitlement no longer reports an active trial after conversion, even though trial_status/trial_end are still literally "active"/in the future in the row');
  assert(ent.trialDaysRemaining === null, 'REQUIRED: trialDaysRemaining is suppressed once paid, so dashboard copy like "Paid trial · N days left" cannot be built from it');
  assert(ent.unlimited === false, 'a converted org with a finite purchased band is correctly reported as NOT unlimited');
}
{
  // Robustness: even if a converted org's trial_status was somehow never
  // separately retired (defense in depth -- the webhook does retire it,
  // but the entitlement layer must not depend on that alone), paid
  // precedence still wins on its own via subscription_status.
  const org = { subscription_status: 'manual', trial_status: 'active', trial_end: daysFromNow(10), account_capacity: 2500 };
  assert(accountCapacity(org) === 2500, 'paid precedence holds for a manual grant too, regardless of a leftover active trial_status');
}
{
  // THE CANCELLATION EDGE CASE: once trial_status has been retired to
  // 'inactive' (as api/stripe-webhook.js's checkout.session.completed
  // handler now does) and the subscription is later canceled, the org
  // must fall through to Free -- NOT resurrect the remainder of its old
  // trial window, even though trial_end is still technically in the
  // future.
  const canceledAfterConversion = {
    plan: 'paid', subscription_status: 'canceled',
    trial_status: 'inactive', trial_end: daysFromNow(15), trial_used: true,
    account_capacity: 100
  };
  assert(accountCapacity(canceledAfterConversion) === 10, 'REQUIRED: a subscription canceled after conversion falls back to Free (10), not the leftover legacy trial, because trial_status was retired at conversion time');
  assert(trialCurrentlyActive(canceledAfterConversion) === false, 'trialCurrentlyActive() is false for this org even though trial_end is still in the future -- trial_status is no longer "active"');
}
{
  // If trial_status were NOT retired (hypothetical -- proves WHY the
  // webhook retirement is required, not just the entitlement reordering):
  // a canceled subscription with a still-"active" trial_status and a
  // still-future trial_end WOULD incorrectly resurrect unlimited access.
  // This documents the exact failure mode the webhook change prevents.
  const hypotheticalUnretired = { subscription_status: 'canceled', trial_status: 'active', trial_end: daysFromNow(15), account_capacity: 100 };
  assert(accountCapacity(hypotheticalUnretired) === null, 'documents why trial_status retirement at conversion time is required: without it, a canceled subscription with a leftover active trial_status would resurrect unlimited access via the trial branch');
}

// --- entitlement(): shape and derived fields ----------------------------
{
  const ent = entitlement({ plan: 'free', subscription_status: 'inactive', trial_status: 'inactive' });
  assert(ent.unlimited === false && ent.isLimitedPlan === true && ent.companyLimit === 10, 'entitlement() for a plain free org: limited, companyLimit 10');
  assert(ent.freeCompanyLimit === 10, 'entitlement() always reports the free ceiling as 10, regardless of plan');
}
{
  const ent = entitlement({ subscription_status: 'active', account_capacity: 750, plan: 'paid' });
  assert(ent.unlimited === false && ent.companyLimit === 750 && ent.accountCapacity === 750, 'entitlement() for a real paid Stripe org reports the purchased capacity as both companyLimit and accountCapacity');
  assert(ent.paidActive === true, 'entitlement() reports paidActive for an active subscription_status');
}
{
  const ent = entitlement({ subscription_status: 'trialing', trial_status: 'active', trial_end: daysFromNow(3) });
  assert(ent.unlimited === true && ent.trialActive === true && ent.companyLimit === null, 'entitlement() for a currently-active trial is unlimited and reports trialActive');
}
{
  const ent = entitlement({ subscription_status: 'trialing', trial_status: 'active', trial_end: daysAgo(2), trial_used: true });
  assert(ent.unlimited === false && ent.companyLimit === 10 && ent.trialActive === false, 'entitlement() for an expired, never-converted trial correctly falls back to limited/10');
}

// --- usageFor(): aggregate count + active/paused/archived filtering ----
// Mock sb(path) => data, matching the shape every real caller's own
// Supabase REST wrapper already returns.
function mockSb(rows){
  return async (path) => {
    if(path.startsWith('ha_users?organization_id=')) return rows.users || [];
    if(path.startsWith('ha_uploads?user_id=')) return rows.uploads || [];
    if(path.startsWith('ha_accounts?upload_id=')) return rows.accounts || [];
    if(path.startsWith('ha_monitored_companies?user_id=')) return rows.legacy || [];
    if(path.startsWith('ha_prospect_uploads?user_email=')) return rows.prospectUploads || [];
    if(path.startsWith('ha_prospect_accounts?upload_id=')) return rows.prospectAccounts || [];
    throw new Error(`Unhandled mock sb path in test: ${path}`);
  };
}
{
  const sb = mockSb({
    users: [{ id: 'u1', email: 'owner@example.com', status: 'active' }],
    uploads: [{ id: 'up-active', stage: 'uploaded' }, { id: 'up-paused', stage: 'paused' }],
    accounts: [{ account_name: 'Acme Inc' }, { account_name: 'Nike' }],
    legacy: [{ company_name: 'Legacy Co', status: 'active' }, { company_name: 'Old Paused Co', status: 'archived' }],
    prospectUploads: [{ id: 'pu-active', status: 'active' }],
    prospectAccounts: [{ company_name: 'Prospect LLC', status: 'active' }]
  });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'free' });
  assert(usage.customerCompanyCount === 2, 'usageFor() counts customer accounts only from active (non-paused/archived) uploads (got ' + usage.customerCompanyCount + ')');
  assert(usage.legacyMonitoredCompanyCount === 1, 'usageFor() excludes archived legacy monitored companies (got ' + usage.legacyMonitoredCompanyCount + ')');
  assert(usage.prospectCompanyCount === 1, 'usageFor() still tracks active prospect accounts for display');
  // Billing-count correction: capacity counts customer + legacy only (2 +
  // 1 = 3) -- the 1 active prospect account is deliberately NOT part of
  // totalMonitoredCompanies/usageLabel, since prospects are one-shot
  // research snapshots, not recurring-monitored accounts (see
  // usageFor()'s own comment). prospectCompanyCount above still reports
  // it, just not toward capacity.
  assert(usage.totalMonitoredCompanies === 3, 'REQUIRED: usageFor() excludes prospect accounts from the capacity total -- only customer + legacy count (got ' + usage.totalMonitoredCompanies + ')');
  assert(usage.companyLimit === 10, 'usageFor() carries the entitlement companyLimit through for a free org');
  assert(usage.usageLabel === '3 / 10 companies monitored', 'REQUIRED: the usage label reflects the capacity-only total (customer + legacy), not the prospect-inclusive one (got "' + usage.usageLabel + '")');
}
{
  // Seats are unlimited at every pricing level -- seatLimit is always
  // null now, regardless of the legacy org.seat_limit value.
  const sb = mockSb({ users: [{ id: 'u1', email: 'a@example.com', status: 'active' }, { id: 'u2', email: 'b@example.com', status: 'active' }] });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'team', seat_limit: 25 });
  assert(usage.seatLimit === null, 'usageFor() always reports seatLimit as null (unlimited), even for an org whose legacy seat_limit column says 25');
  assert(usage.seatsUsed === 2, 'usageFor() still reports the real seatsUsed count for display purposes');
}
{
  // A company monitored as both a customer account and (separately)
  // researched as a prospect still counts once toward capacity -- via the
  // customer side alone, since the prospect side no longer contributes at
  // all. Confirms the prospect record doesn't cause double-counting or
  // any other capacity contribution once it overlaps a real customer.
  const sb = mockSb({
    users: [{ id: 'u1', email: 'a@example.com', status: 'active' }],
    uploads: [{ id: 'up1', stage: 'uploaded' }],
    accounts: [{ account_name: 'Acme Inc' }],
    prospectUploads: [{ id: 'pu1', status: 'active' }],
    prospectAccounts: [{ company_name: 'ACME, LLC', status: 'active' }]
  });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'free' });
  assert(usage.totalMonitoredCompanies === 1, 'a company that is both a customer account and a researched prospect counts once toward capacity (got ' + usage.totalMonitoredCompanies + ')');
}

// ---------------------------------------------------------------------
// Billing-count correction (founder QA): required regressions.
// ---------------------------------------------------------------------

// REQUIRED: active recurring customer accounts consume capacity.
{
  const sb = mockSb({
    users: [{ id: 'u1', email: 'a@example.com', status: 'active' }],
    uploads: [{ id: 'up1', stage: 'uploaded' }],
    accounts: [{ account_name: 'Acme Inc' }, { account_name: 'Nike' }, { account_name: 'L.L.Bean' }]
  });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'free' });
  assert(usage.totalMonitoredCompanies === 3, 'REQUIRED: active customer accounts (the population api/weekly-scan.js actually re-researches weekly) consume capacity (got ' + usage.totalMonitoredCompanies + ')');
}

// REQUIRED: an individually paused customer account does not consume
// capacity, using the SAME canonical pause field (ha_accounts.raw_data.
// monitoring_status) api/weekly-scan.js's accountPayload() now reads --
// one pause definition, not two.
{
  const sb = mockSb({
    users: [{ id: 'u1', email: 'a@example.com', status: 'active' }],
    uploads: [{ id: 'up1', stage: 'uploaded' }],
    accounts: [
      { account_name: 'Acme Inc', raw_data: {} },
      { account_name: 'Nike', raw_data: { monitoring_status: 'paused' } },
      { account_name: 'L.L.Bean', raw_data: {} }
    ]
  });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'free' });
  assert(usage.totalMonitoredCompanies === 2, `REQUIRED: an individually paused customer account (Nike) does not consume capacity -- 3 accounts, 1 paused, capacity usage is 2 (got ${usage.totalMonitoredCompanies})`);
}

// REQUIRED: a resumed account (monitoring_status explicitly set back to
// "active") consumes capacity again.
{
  const sb = mockSb({
    users: [{ id: 'u1', email: 'a@example.com', status: 'active' }],
    uploads: [{ id: 'up1', stage: 'uploaded' }],
    accounts: [
      { account_name: 'Acme Inc', raw_data: {} },
      { account_name: 'Nike', raw_data: { monitoring_status: 'active' } }
    ]
  });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'free' });
  assert(usage.totalMonitoredCompanies === 2, `REQUIRED: a resumed account (monitoring_status explicitly "active") consumes capacity again (got ${usage.totalMonitoredCompanies})`);
}

// REQUIRED: upload-level pause/archive exclusion remains intact alongside
// the new account-level exclusion -- an entire paused upload contributes
// nothing, regardless of what any individual account's own
// monitoring_status says.
{
  const sb = mockSb({
    users: [{ id: 'u1', email: 'a@example.com', status: 'active' }],
    uploads: [{ id: 'up-active', stage: 'uploaded' }, { id: 'up-paused', stage: 'paused' }],
    accounts: [{ account_name: 'Should Not Appear', raw_data: { monitoring_status: 'active' } }] // mock only serves this for the active upload's query; the paused upload is never queried at all
  });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'free' });
  assert(usage.totalMonitoredCompanies === 1, `REQUIRED: upload-level pause/archive exclusion still works -- the paused upload's account query is never even issued (got ${usage.totalMonitoredCompanies})`);
}

// REQUIRED: prospect accounts do not consume capacity, even with zero
// customer accounts at all.
{
  const sb = mockSb({
    users: [{ id: 'u1', email: 'a@example.com', status: 'active' }],
    prospectUploads: [{ id: 'pu1', status: 'active' }],
    prospectAccounts: [{ company_name: 'Prospect A', status: 'active' }, { company_name: 'Prospect B', status: 'active' }, { company_name: 'Prospect C', status: 'active' }]
  });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'free' });
  assert(usage.totalMonitoredCompanies === 0, 'REQUIRED: prospect accounts alone (zero customer accounts) contribute ZERO to capacity, even though 3 real prospect rows exist (got ' + usage.totalMonitoredCompanies + ')');
  assert(usage.prospectCompanyCount === 3, 'prospect accounts are still tracked/counted for display, just not toward capacity');
}

// REQUIRED: the real traced shape (28 customer accounts across 3 uploads,
// 22 prospect accounts, 0 legacy) resolves to 28 capacity usage, not 50.
{
  const customerNamesFixture = Array.from({ length: 28 }, (_, i) => ({ account_name: `Customer Account ${i + 1}` }));
  const prospectNamesFixture = Array.from({ length: 22 }, (_, i) => ({ company_name: `Prospect Company ${i + 1}`, status: 'active' }));
  const sb = mockSb({
    users: [{ id: 'u1', email: 'a@example.com', status: 'active' }],
    uploads: [{ id: 'up1', stage: 'uploaded' }, { id: 'up2', stage: 'uploaded' }, { id: 'up3', stage: 'uploaded' }],
    accounts: customerNamesFixture,
    prospectUploads: [{ id: 'pu1', status: 'active' }],
    prospectAccounts: prospectNamesFixture
  });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'paid', subscription_status: 'active', account_capacity: 100 });
  assert(usage.customerCompanyCount === 28, 'the fixture has exactly 28 distinct customer accounts (got ' + usage.customerCompanyCount + ')');
  assert(usage.prospectCompanyCount === 22, 'the fixture has exactly 22 distinct prospect accounts (got ' + usage.prospectCompanyCount + ')');
  assert(usage.totalMonitoredCompanies === 28, `REQUIRED: the real 28-customer + 22-prospect shape resolves to 28 capacity usage, not 50 (got ${usage.totalMonitoredCompanies})`);
  assert(usage.usageLabel === '28 / 100 companies monitored', `REQUIRED: the usage label reads "28 / 100 companies monitored", not "50 / 100" (got "${usage.usageLabel}")`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
