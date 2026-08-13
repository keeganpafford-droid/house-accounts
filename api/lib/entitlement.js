// The one authoritative monitored-account entitlement / capacity-count
// implementation. Replaces three previously independent, drifted
// hand-rolled copies (api/settings.js, api/save-upload.js,
// api/prospect-one-off.js each had their own entitlement()/usage-count
// logic with subtly different rules). Every caller -- usage display,
// account-cap enforcement, billing capacity checks, and future upgrade
// messaging -- now goes through this file.
//
// Seats/users are unlimited at every pricing level (2026-08-13 pricing
// contract). This module has nothing to do with seat counts -- see
// api/team.js for why seat_limit is no longer read as a gate.
//
// Callers pass in their own already-existing Supabase REST fetch helper
// (`sb`) rather than this module owning its own HTTP layer -- each API
// file's `sb()` is already independently correct and tested; unifying
// the business logic (what counts as monitored, what the limit is) is
// the actual fix, forcing one shared HTTP client is a separate, larger,
// unrequested refactor.
import { normalizeCompanyName } from '../company-identity.js';

const FREE_ACCOUNT_CAPACITY = 10;

function clean(v = '') { return String(v ?? '').trim(); }

function daysRemaining(date) {
  const t = new Date(date || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
}

// Whether the org currently has an active self-service trial. This is
// computed fresh from trial_end on every call -- nothing anywhere writes
// this back on expiry, so an expired trial reverts to the free capacity
// automatically on its very next read, exactly as it does today.
export function trialCurrentlyActive(org = {}) {
  const trial = clean(org.trial_status).toLowerCase();
  const sub = clean(org.subscription_status).toLowerCase();
  const days = daysRemaining(org.trial_end);
  return (trial === 'active' || sub === 'trialing') && days !== null && days > 0;
}

// The org's effective monitored-account capacity right now. null means
// unlimited. A currently-active trial takes priority over the stored
// account_capacity column (preserving today's dynamic, self-expiring
// trial behavior); only a genuinely paid/manual subscription reads the
// stored column. Everything else (free, or a lapsed/never-converted
// trial, or a canceled subscription) falls back to the free ceiling.
export function accountCapacity(org = {}) {
  if (trialCurrentlyActive(org)) return null;
  const sub = clean(org.subscription_status).toLowerCase();
  if (['active', 'paid', 'manual'].includes(sub)) {
    const raw = org.account_capacity;
    return raw === null || raw === undefined ? null : Number(raw);
  }
  return FREE_ACCOUNT_CAPACITY;
}

export function entitlement(org = {}) {
  const plan = clean(org.plan || 'free').toLowerCase();
  const sub = clean(org.subscription_status || '').toLowerCase();
  const trial = clean(org.trial_status || '').toLowerCase();
  const trialDays = daysRemaining(org.trial_end);
  const trialActive = trialCurrentlyActive(org);
  const trialUsed = !!org.trial_used;
  const isExpired = (sub === 'trialing' || trial === 'active') && trialDays === 0;
  const capacity = accountCapacity(org);
  const unlimited = capacity === null;
  return {
    plan,
    subscriptionStatus: sub || '',
    trialStatus: trial || '',
    trialStartedAt: org.trial_started_at || '',
    trialEnd: org.trial_end || '',
    trialUsed,
    trialDaysRemaining: trialDays,
    trialActive,
    trialExpired: isExpired,
    trialAlreadyUsedExpired: trialUsed && isExpired,
    paidActive: ['active', 'paid', 'manual'].includes(sub),
    unlimited,
    isLimitedPlan: !unlimited,
    isFreePlan: !unlimited,
    companyLimit: capacity,
    freeCompanyLimit: FREE_ACCOUNT_CAPACITY,
    accountCapacity: capacity
  };
}

async function orgUsers(sb, orgId, userId) {
  if (orgId) {
    const rows = await sb(`ha_users?organization_id=eq.${encodeURIComponent(orgId)}&select=id,email,status,last_login,login_count,last_ip,user_agent`);
    return (Array.isArray(rows) ? rows : []).filter(Boolean);
  }
  return [{ id: userId }].filter(u => u.id);
}

// The one authoritative monitored-account count: customer + prospect +
// legacy accounts, deduplicated by normalized company name, scoped to
// every active user in the org, excluding paused/archived uploads and
// accounts. This is now used identically for display (usageLabel),
// enforcement (companyLimit comparison), and one-off prospect saves --
// previously each of those had its own narrower or looser count.
export async function usageFor(sb, user, org = null) {
  const users = await orgUsers(sb, user.organization_id, user.id);
  const ids = users.map(u => u.id).filter(Boolean);
  const emails = users.map(u => clean(u.email).toLowerCase()).filter(Boolean);
  let customer = [], prospect = [], legacy = [];
  if (ids.length) {
    const inFilter = `in.(${ids.map(encodeURIComponent).join(',')})`;
    try {
      const uploads = (await sb(`ha_uploads?user_id=${inFilter}&select=id,stage`)) || [];
      const activeUploadIds = uploads.filter(u => !['paused', 'archived'].includes(clean(u.stage).toLowerCase())).map(u => u.id).filter(Boolean);
      if (activeUploadIds.length) {
        const upFilter = `in.(${activeUploadIds.map(encodeURIComponent).join(',')})`;
        customer = (await sb(`ha_accounts?upload_id=${upFilter}&select=account_name`)) || [];
      }
    } catch {}
    try {
      legacy = (await sb(`ha_monitored_companies?user_id=${inFilter}&select=company_name,name,account_name,status`)) || [];
      legacy = legacy.filter(r => !['paused', 'archived'].includes(clean(r.status).toLowerCase()));
    } catch {}
  }
  for (const email of emails) {
    try {
      const uploads = (await sb(`ha_prospect_uploads?user_email=eq.${encodeURIComponent(email)}&select=id,status`)) || [];
      const uploadIds = uploads.filter(u => !['paused', 'archived'].includes(clean(u.status).toLowerCase())).map(u => u.id).filter(Boolean);
      if (uploadIds.length) {
        const inUploads = `in.(${uploadIds.map(encodeURIComponent).join(',')})`;
        const rows = (await sb(`ha_prospect_accounts?upload_id=${inUploads}&select=company_name,status`)) || [];
        prospect.push(...rows.filter(r => !['paused', 'archived'].includes(clean(r.status).toLowerCase())));
      }
    } catch {}
  }
  const customerNames = new Set(customer.map(r => normalizeCompanyName(r.account_name)).filter(Boolean));
  const prospectNames = new Set(prospect.map(r => normalizeCompanyName(r.company_name)).filter(Boolean));
  const legacyNames = new Set(legacy.map(r => normalizeCompanyName(r.company_name || r.name || r.account_name)).filter(Boolean));
  const names = new Set([...customerNames, ...prospectNames, ...legacyNames]);
  const ent = entitlement(org || {});
  return {
    ...ent,
    customerCompanyCount: customerNames.size,
    existingCustomerCompanyCount: customerNames.size,
    prospectCompanyCount: prospectNames.size,
    legacyMonitoredCompanyCount: legacyNames.size,
    totalMonitoredCompanies: names.size,
    monitoredCompanyNames: [...names],
    customerCompanyNames: [...customerNames],
    prospectCompanyNames: [...prospectNames],
    // Seats/users are unlimited at every pricing level. seatsUsed remains
    // informational (shown in Settings); seatLimit is deliberately always
    // null (unlimited) here, regardless of the legacy org.seat_limit
    // column, which is no longer read as a gate anywhere.
    seatsUsed: users.filter(u => clean(u.status || 'active') !== 'inactive').length,
    seatLimit: null,
    usageLabel: ent.companyLimit != null ? `${names.size} / ${ent.companyLimit} companies monitored` : `${names.size} companies monitored`
  };
}
