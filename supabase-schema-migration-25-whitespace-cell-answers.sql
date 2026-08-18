-- Migration 25: Cell-Level Buying Center x Offering Confirmation / Correction V1.
--
-- The trusted cell-level truth layer future Active Expansion Plays will
-- read from (not built yet -- this migration only stores the answers).
-- Distinct from, and does not replace, migration 24's
-- ha_whitespace_confirmations (buying-center-level "I have a relationship
-- here" confirmation). A buying-center confirmation never implies any
-- offering cell is Covered -- see dashboard/index.html's
-- computeAccountWhitespaceMatrix() module doctrine comment for the full V1
-- Covered truth rule this table is the second half of.
--
-- Identity: same (organization_id, normalized_company_name) V1 resolution
-- key as migration 24, for the same reason (see that migration's own
-- header comment for the full rename/re-upload safety analysis -- this
-- table inherits the identical, accepted exposure and the identical
-- mitigation: graceful re-ask on a key change, never fuzzy relinking).
--
-- Answer semantics: exactly one row per (org, account, buying center,
-- category) -- 'covered' | 'whitespace' | 'not_applicable'. Unlike
-- migration 24's confirmations (whose mere existence IS the confirmation,
-- so unconfirming deletes the row), a cell can be explicitly answered
-- "whitespace" (a rep saying "we don't sell this here," a real recorded
-- fact) as well as "covered" or "not_applicable" -- so the row is never
-- deleted on correction, only updated. "Latest answer wins" is enforced by
-- an atomic upsert (see api/whitespace-cell-answers.js's on_conflict
-- usage), not a client-side read-then-write.
--
-- confirmed_by_user_id is accountability (who last set this answer), not
-- ownership -- every answer is shared organization intelligence, visible
-- to and correctable by any authorized member of the org, same posture as
-- migration 24.
--
-- Explicitly NOT emitted into ha_signal_events / Behavioral Learning, not
-- aggregated across accounts or organizations -- these are private,
-- per-account answers in V1, not a training signal (founder instruction,
-- 2026-08-19).
create table if not exists public.ha_whitespace_cell_answers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.ha_organizations(id) on delete cascade,
  normalized_company_name text not null,
  buying_center text not null check (buying_center in (
    'HR / People', 'Events', 'Marketing', 'Operations / Facilities',
    'Procurement', 'Sales / Client Experience', 'Leadership'
  )),
  -- Same 11-offering taxonomy as WHITESPACE_CATEGORIES in dashboard/index.html
  -- (reused from inferPromoCategory()'s vocabulary, excluding 'Uncategorized').
  category text not null check (category in (
    'Apparel', 'Headwear', 'Drinkware', 'Event / Giveaway', 'Recognition / Awards',
    'Print / Stationery', 'Onboarding / Recruiting', 'Safety',
    'Wellness / Employee Engagement', 'Client Gifts', 'Sales Incentive'
  )),
  answer text not null check (answer in ('covered', 'whitespace', 'not_applicable')),
  confirmed_by_user_id uuid references public.ha_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, normalized_company_name, buying_center, category)
);

-- The only real read pattern: "every cell answer for this (org, account)",
-- once per whitespace-section render -- same doctrine as migration 24's
-- index.
create index if not exists ha_whitespace_cell_answers_org_account_idx
  on public.ha_whitespace_cell_answers (organization_id, normalized_company_name);

-- RLS: fail-closed for anon/authenticated -- same posture as migration 24
-- and every other internal-only table in this schema. Nothing browser-
-- facing talks to Supabase directly; api/whitespace-cell-answers.js
-- (service-role key) is the only reader/writer, after its own Bearer-token
-- auth + server-derived organization_id resolution.
alter table public.ha_whitespace_cell_answers enable row level security;
