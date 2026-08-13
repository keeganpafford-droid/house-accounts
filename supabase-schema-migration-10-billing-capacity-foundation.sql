-- Migration 10: billing capacity foundation (additive only).
--
-- ha_organizations was never checked into this repo's schema history --
-- it was created directly against Supabase outside version control. This
-- migration documents (does not recreate) the live shape it depends on,
-- confirmed via a direct information_schema inspection on 2026-08-13:
--   id uuid, name text, plan text CHECK (plan IN ('free','solo','team',
--   'enterprise')), subscription_status text, trial_status text CHECK
--   (trial_status IN ('inactive','active','expired','cancelled')),
--   trial_started_at/trial_end timestamptz, trial_used bool,
--   seat_limit integer DEFAULT 1, created_at/updated_at timestamptz,
--   and (already present, unused by any application code before this
--   sprint) stripe_customer_id/stripe_subscription_id/stripe_price_id
--   text. No historical drift beyond these columns is addressed here.
--
-- This migration does not touch seat_limit or the plan/trial columns'
-- existing semantics -- it only adds the one thing that was actually
-- missing: a per-org numeric monitored-account capacity ceiling. Today
-- that ceiling is a hardcoded "10" constant duplicated across several
-- files; going forward it is a real column, authoritative for genuinely
-- paid/manual orgs. It is deliberately NOT authoritative for orgs on an
-- active self-service trial -- trial access stays computed dynamically
-- from trial_end (unchanged), so an expired, never-converted trial
-- reverts to the free ceiling on its own with no write-back required.
-- See api/lib/entitlement.js for the read-side logic this column feeds.

ALTER TABLE ha_organizations
  ADD COLUMN account_capacity integer NULL DEFAULT 10;
  -- NULL = unlimited (same convention seat_limit already uses).
  -- Non-null = the exact number of monitored accounts this org may have.
  -- Default 10 matches today's free-tier ceiling for every new org.

-- Backfill: preserve every existing org's CURRENT real entitlement
-- exactly, using the same "unlimited" definition entitlement() already
-- applies today (subscription_status active/paid/manual, or plan
-- enterprise). Trialing orgs are deliberately left at the column default
-- of 10 -- their actual access is unaffected because it's still governed
-- by the dynamic trial_end check, not by this column, while their trial
-- is active.
UPDATE ha_organizations
SET account_capacity = NULL
WHERE plan <> 'free'
  AND (subscription_status IN ('active','paid','manual') OR plan = 'enterprise');

-- Widen (never remove) the allowed plan values: 'paid' is the new value
-- Stripe-purchased capacity-band orgs will use going forward. Legacy
-- 'solo'/'team'/'enterprise' rows remain valid and unchanged.
ALTER TABLE ha_organizations
  DROP CONSTRAINT ha_organizations_plan_check,
  ADD CONSTRAINT ha_organizations_plan_check
    CHECK (plan = ANY (ARRAY['free','solo','team','enterprise','paid']));
