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
  assert(usage.prospectCompanyCount === 1, 'usageFor() counts active prospect accounts');
  assert(usage.totalMonitoredCompanies === 4, 'usageFor() reports one deduplicated total across customer + prospect + legacy (got ' + usage.totalMonitoredCompanies + ')');
  assert(usage.companyLimit === 10, 'usageFor() carries the entitlement companyLimit through for a free org');
  assert(usage.usageLabel === '4 / 10 companies monitored', 'usageFor() builds the correct usage label for a limited org (got "' + usage.usageLabel + '")');
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
  // A duplicate company (same normalized name) monitored as both a
  // customer account and a prospect account counts once, not twice.
  const sb = mockSb({
    users: [{ id: 'u1', email: 'a@example.com', status: 'active' }],
    uploads: [{ id: 'up1', stage: 'uploaded' }],
    accounts: [{ account_name: 'Acme Inc' }],
    prospectUploads: [{ id: 'pu1', status: 'active' }],
    prospectAccounts: [{ company_name: 'ACME, LLC', status: 'active' }]
  });
  const usage = await usageFor(sb, { id: 'u1', organization_id: 'org-1' }, { plan: 'free' });
  assert(usage.totalMonitoredCompanies === 1, 'the same company monitored as both a customer account and a prospect account is counted once, not twice (got ' + usage.totalMonitoredCompanies + ')');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
