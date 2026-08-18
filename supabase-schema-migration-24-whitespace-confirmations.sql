-- Migration 24: Account Expansion / Whitespace Intelligence -- durable,
-- organization-scoped buying-center mapping confirmations.
--
-- Replaces the interim client-local (localStorage) implementation shipped
-- alongside the Buying Center x Offering matrix -- a rep telling House
-- Accounts "we have a relationship in Marketing at this account" is
-- organization intelligence, not a browser preference. Must be durable,
-- organization-scoped, cross-device, and visible to every authorized
-- member of that organization.
--
-- Identity: keyed by (organization_id, normalized_company_name) -- the
-- SAME identity convention ha_monitoring_targets already established
-- (organization_id + normalized_company_name, via the shared
-- normalizeCompanyName() in api/company-identity.js), not a new one.
-- Deliberately NOT a hard foreign key to ha_monitoring_targets.id:
-- monitoring-target row lifecycle (created/paused/removed for cadence
-- purposes) is a different concern from whether a rep has mapped an
-- account's buying centers, and not every ha_accounts row is guaranteed
-- to have a corresponding monitoring target (94 accounts vs 90 targets in
-- production today). Reusing the identity CONVENTION without coupling to
-- that table's row lifecycle keeps the two features independent.
--
-- This is persistent account STATE (like ha_monitoring_targets.identity_status),
-- not a behavioral evidence stream -- deliberately its own small table
-- rather than forced into ha_signal_events, whose signal/event-fingerprint
-- shape doesn't cleanly fit generic per-dimension account state and would
-- need a fragile synthetic-fingerprint scheme to reuse.
--
-- (organization_id, normalized_company_name) is a V1 ACCOUNT-RESOLUTION
-- KEY, not an immutable account identifier -- this codebase has no stable
-- account UUID anywhere (see migration 15's identity doctrine, which made
-- the same call for ha_monitoring_targets, with the same unmitigated
-- exposure). There is no rename affordance in the product today (an
-- account's name can only change via a CSV re-upload with a differently-
-- spelled account name, and dashboard/index.html's saveAccountMetadataEdit()
-- explicitly cannot rename an account). If a re-upload ever DOES produce a
-- differently-normalizing account name, existing rows here under the old
-- key become inert (not deleted, simply unreferenced) -- the account
-- falls back to the mapping prompt and the rep re-confirms, the exact
-- same safe state as an account that was never confirmed (see
-- dashboard/index.html's computeAccountWhitespaceMatrix()/
-- confirmedCentersForAccount() and their test coverage in
-- scripts/test-account-whitespace-intelligence-slice1.js's persistence-
-- identity section). Smallest safe mitigation for V1: deliberately do NOT
-- add fuzzy/best-effort relinking of orphaned rows to a new account that
-- happens to normalize to the same key -- that risks silently
-- misattributing one company's confirmed buying centers to an unrelated
-- company that coincidentally shares a name. A real fix needs a stable,
-- cross-upload account identity (a larger Canonical Account Identity
-- project), not V1 scope.
create table if not exists public.ha_whitespace_confirmations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.ha_organizations(id) on delete cascade,
  normalized_company_name text not null,
  buying_center text not null check (buying_center in (
    'HR / People', 'Events', 'Marketing', 'Operations / Facilities',
    'Procurement', 'Sales / Client Experience', 'Leadership'
  )),
  confirmed_by_user_id uuid references public.ha_users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- One row per (org, account, buying center) -- unconfirming deletes the
  -- row outright (see api/whitespace-map.js's toggle semantics), so there
  -- is no separate "confirmed:false" state to store; a row's mere
  -- existence IS the confirmation.
  unique (organization_id, normalized_company_name, buying_center)
);

-- The only real read pattern: "every confirmed buying center for this
-- (org, account)", once per whitespace-section render.
create index if not exists ha_whitespace_confirmations_org_account_idx
  on public.ha_whitespace_confirmations (organization_id, normalized_company_name);

-- RLS: fail-closed for anon/authenticated -- same posture as every other
-- internal-only table in this schema (e.g. migration 22's
-- ha_notification_deliveries). Nothing browser-facing talks to Supabase
-- directly; api/whitespace-map.js (service-role key) is the only reader/
-- writer, after its own Bearer-token auth + server-derived organization_id
-- resolution -- a client can never influence which organization's
-- confirmations are read or written.
alter table public.ha_whitespace_confirmations enable row level security;
