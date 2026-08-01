-- Migration 4: Phase 2A / A2 — atomic account-snapshot persistence + duplicate
-- defense for public.ha_accounts.
--
-- =============================================================================
-- 1. WHAT THIS CLOSES
-- =============================================================================
-- Confirmed forensic root cause (Phase 2A investigation): dashboard/index.html's
-- 4-worker concurrent research-fallback loop called saveCurrentUpload() once
-- per account, each doing a non-transactional DELETE then INSERT of the full
-- current ha_accounts snapshot for that upload. Two workers finishing close
-- together could both DELETE before either INSERTed, producing duplicate
-- account rows — the exact 60-row / 30-duplicate pattern observed in the
-- frozen Phase 1A/1B QA run. The application-side fix (dashboard/index.html,
-- same change set) removes the per-account save trigger and serializes
-- remaining callers client-side; this migration is the defense-in-depth
-- database-side fix.
--
-- =============================================================================
-- 2. DO NOT RUN YET — READ-ONLY AUDIT FIRST
-- =============================================================================
-- Before applying ANYTHING below, run scripts/phase2a-account-duplicate-audit.js
-- against the target database. It is entirely read-only and reports, without
-- deleting anything:
--   - exact-name duplicates: (upload_id, account_name) raw string matches —
--     what this migration's constraint targets and what the confirmed race
--     actually produced.
--   - normalized-name duplicates: same normalizeCompany() output but
--     different raw spelling (e.g. "ABC LLC" vs "ABC Inc") — reported for
--     visibility only; this migration does NOT touch these, see §4.
--   - a full simulation of exactly which rows step 3 below would move to the
--     audit table and delete (keep-earliest-per-exact-name-group), so you can
--     review the precise row list before running anything.
-- Do not proceed past this point until that audit has been reviewed.
--
-- =============================================================================
-- 3. DE-DUPLICATION BEFORE THE CONSTRAINT — AUDITED, NOT SILENT
-- =============================================================================
-- A plain UNIQUE constraint fails to create if duplicate rows already exist.
-- Earlier draft of this migration deleted duplicates directly; this version
-- instead copies every row it is about to remove into
-- ha_accounts_dedup_audit first, in the SAME transaction, so the deletion is
-- permanently reviewable (which row survived, which were removed, and when)
-- rather than a silent, unrecoverable DELETE. Keeps the earliest-created row
-- per exact (upload_id, account_name) pair.
--
-- =============================================================================
-- 4. WHY (upload_id, account_name) — THE NARROWEST CONSTRAINT THAT STOPS THE
--    CONFIRMED RACE, NOT A GENERAL ACCOUNT-IDENTITY MODEL
-- =============================================================================
-- The observed race produced EXACT duplicate account_name strings within the
-- same upload_id (both batches were literal re-submissions of the same
-- account list) — a raw-string constraint on exactly that pair is the
-- narrowest constraint that still fully closes the confirmed defect: nothing
-- narrower would still catch it, and anything broader (see below) would be
-- solving a different, larger problem this migration does not attempt.
--
-- A normalized-name constraint (folding "ABC LLC" / "ABC Inc" together) is
-- deliberately NOT added here. It would also block two genuinely distinct
-- real businesses that happen to normalize to the same string, is a policy
-- decision with real product tradeoffs, and was never implicated in the
-- confirmed race. The long-term recommendation, for a SEPARATE future
-- change, is an explicit upload-scoped account identity model distinguishing:
--   - raw account name (display, as uploaded)
--   - normalized account name (matching/dedup key)
--   - a stable source-row key (ties a persisted account back to its specific
--     row in the originating upload file, surviving re-uploads/edits)
--   - a generated account key (a real primary identity independent of any of
--     the above, so renaming a display name never breaks referential
--     integrity elsewhere)
-- That model is out of scope here; this migration only stops the confirmed
-- duplicate-insert race.
--
-- =============================================================================
-- 5. THE RPC FUNCTION — SECURITY MODEL
-- =============================================================================
-- SECURITY INVOKER, not DEFINER: this function is intended to be called ONLY
-- by server-side application code using the Supabase service_role key (the
-- same trust model every other write in this codebase already uses — there
-- are no RLS policies on ha_accounts/ha_uploads and no client ever calls
-- Supabase directly from the browser). service_role already bypasses RLS and
-- has full table access, so DEFINER's privilege-elevation semantics would add
-- risk (a search_path-hijack or logic bug inside the function could act with
-- elevated privilege on behalf of a lower-privileged caller) without adding
-- any capability this function actually needs. `set search_path = public` is
-- still pinned explicitly as defense in depth regardless of INVOKER/DEFINER.
--
-- EXECUTE is explicitly revoked from PUBLIC, anon, and authenticated and
-- granted only to service_role — Supabase grants EXECUTE on new public-schema
-- functions to PUBLIC by default, which would otherwise expose this function
-- directly via PostgREST's /rest/v1/rpc/ endpoint to any anon or
-- authenticated client. There is no RLS-safe design here that would justify
-- direct client access (no RLS policies exist on these tables at all), so
-- direct access is closed off entirely rather than attempted.
--
-- Ownership verification: p_user_id is never trusted as globally authoritative
-- on its own — the function explicitly verifies p_upload_id belongs to
-- p_user_id (via ha_uploads.user_id) before touching any row, and raises an
-- exception otherwise. In the current architecture this is defense in depth
-- (only service_role can call it, and api/save-upload.js already derives
-- user_id server-side from the authenticated ha_users record, never from
-- client input directly — see api/save-upload.js's getUserFromAuth()) rather
-- than the only thing standing between a malicious caller and another user's
-- data. It is what actually prevents a future application-code bug (e.g. a
-- refactor that accidentally passes the wrong user_id) from silently
-- replacing the wrong user's accounts.
--
-- =============================================================================
-- 6. ROLLBACK
-- =============================================================================
-- drop function if exists public.replace_ha_accounts_snapshot(uuid, uuid, jsonb);
-- alter table public.ha_accounts drop constraint if exists ha_accounts_upload_account_name_key;
-- drop table if exists public.ha_accounts_dedup_audit;
-- Rolling back does not restore rows removed by §3 to ha_accounts itself, but
-- every removed row's full content is preserved in ha_accounts_dedup_audit
-- until that table is explicitly dropped — restore from there if needed,
-- rather than from a backup. Rolling back the RPC function alone means
-- api/save-upload.js must be rolled back to its pre-migration DELETE+INSERT
-- form in the same change, since it now calls this function unconditionally.

-- ===========================================================================
-- Step 1: preserve an audit trail of every row about to be removed.
-- ===========================================================================
create table if not exists public.ha_accounts_dedup_audit (
  id uuid primary key default gen_random_uuid(),
  removed_account_id uuid not null,
  kept_account_id uuid not null,
  upload_id uuid not null,
  account_name text not null,
  removed_row_snapshot jsonb not null,
  removed_at timestamptz not null default now()
);

with ranked as (
  select id, upload_id, account_name, user_id, industry, contact_name, contact_email,
    metrics, raw_data, created_at, updated_at,
    row_number() over (
      partition by upload_id, account_name
      order by created_at asc, id asc
    ) as rn,
    first_value(id) over (
      partition by upload_id, account_name
      order by created_at asc, id asc
    ) as kept_id
  from public.ha_accounts
)
insert into public.ha_accounts_dedup_audit (removed_account_id, kept_account_id, upload_id, account_name, removed_row_snapshot)
select id, kept_id, upload_id, account_name, to_jsonb(ranked.*)
from ranked
where rn > 1;

-- Step 2: remove exactly the rows just audited above (same predicate, so the
-- audit table and the deletion can never drift apart).
delete from public.ha_accounts
where id in (select removed_account_id from public.ha_accounts_dedup_audit);

-- Step 3: add the uniqueness guarantee (narrowest constraint that stops the
-- confirmed race — see §4 above).
alter table public.ha_accounts
  add constraint ha_accounts_upload_account_name_key unique (upload_id, account_name);

-- Step 4: atomic, serialized, ownership-checked snapshot-replace RPC.
create or replace function public.replace_ha_accounts_snapshot(
  p_upload_id uuid,
  p_user_id uuid,
  p_accounts jsonb
) returns setof public.ha_accounts
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Serializes concurrent calls for the SAME upload_id only; different
  -- upload_ids never block each other. Released automatically when this
  -- transaction commits or rolls back.
  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));

  -- Ownership check: p_user_id is never trusted on its own. See §5.
  if not exists (
    select 1 from public.ha_uploads
    where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'replace_ha_accounts_snapshot: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  delete from public.ha_accounts where upload_id = p_upload_id;

  return query
  insert into public.ha_accounts (
    user_id, upload_id, account_name, industry, contact_name, contact_email,
    metrics, raw_data, created_at, updated_at
  )
  select
    p_user_id,
    p_upload_id,
    nullif(btrim(a->>'account_name'), ''),
    nullif(btrim(a->>'industry'), ''),
    nullif(btrim(a->>'contact_name'), ''),
    lower(nullif(btrim(a->>'contact_email'), '')),
    coalesce(a->'metrics', '{}'::jsonb),
    coalesce(a->'raw_data', '{}'::jsonb),
    now(),
    now()
  from jsonb_array_elements(p_accounts) as a
  where nullif(btrim(a->>'account_name'), '') is not null
  on conflict (upload_id, account_name) do update set
    industry = excluded.industry,
    contact_name = excluded.contact_name,
    contact_email = excluded.contact_email,
    metrics = excluded.metrics,
    raw_data = excluded.raw_data,
    updated_at = now()
  returning *;
end;
$$;

-- Step 5: lock down execution to service_role only (see §5). Supabase's
-- default grant to PUBLIC on new functions is revoked explicitly rather than
-- relied upon to already be absent.
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb) from public;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb) from anon;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb) from authenticated;
grant execute on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb) to service_role;
