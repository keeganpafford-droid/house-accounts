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
-- same change) removes the per-account save trigger and serializes remaining
-- callers client-side; this migration is the defense-in-depth database-side
-- fix, so the same shape of bug from ANY caller (including ones not yet
-- written) cannot silently duplicate rows again.
--
-- =============================================================================
-- 2. DE-DUPLICATION BEFORE THE CONSTRAINT
-- =============================================================================
-- A plain UNIQUE constraint fails to create if duplicate rows already exist.
-- This migration removes existing duplicates first (keeping the
-- earliest-created row per (upload_id, account_name)) before adding the
-- constraint, so it applies cleanly regardless of whether this exact race has
-- already left duplicate rows in this database. Run step 1 with
-- --dry-run reasoning first if you want to inspect what would be removed
-- (change the final DELETE to a SELECT against the same `ranked` CTE).
--
-- =============================================================================
-- 3. WHY (upload_id, account_name) AND NOT A NORMALIZED KEY
-- =============================================================================
-- The observed race produced EXACT duplicate account_name strings within the
-- same upload_id (both batches were literal re-submissions of the same
-- account list) — a raw-string constraint directly targets that failure
-- mode. A normalized-name constraint (folding "ABC LLC" / "ABC Inc" together)
-- is a broader, separate decision with its own tradeoffs (it would also block
-- two genuinely distinct real businesses that happen to normalize to the same
-- string) and is out of scope for this migration.
--
-- =============================================================================
-- 4. THE RPC FUNCTION
-- =============================================================================
-- replace_ha_accounts_snapshot() wraps the delete-then-insert in one function
-- call, serialized per upload_id via pg_advisory_xact_lock (auto-released at
-- transaction end). This is what actually prevents the race, not the unique
-- constraint alone: without the lock, two concurrent calls could each still
-- successfully delete-then-insert their own full account set within their own
-- transaction — the constraint alone only guarantees no duplicate ROWS within
-- a single resulting state, it does not guarantee the two calls merge
-- correctly rather than one call's DELETE running against stale data. The
-- lock forces the second concurrent call for the same upload_id to wait for
-- the first to fully commit, so its DELETE genuinely sees (and removes) the
-- first call's rows before inserting its own — true last-write-wins, not a
-- race. An ON CONFLICT clause on the INSERT additionally protects against two
-- entries in the SAME jsonb payload sharing an account_name.
--
-- =============================================================================
-- 5. ROLLBACK
-- =============================================================================
-- drop function if exists public.replace_ha_accounts_snapshot(uuid, uuid, jsonb);
-- alter table public.ha_accounts drop constraint if exists ha_accounts_upload_account_name_key;
-- Rolling back does not restore any rows removed by the de-duplication step in
-- §2 — back up ha_accounts before running this migration if that history must
-- be preserved. Rolling back the RPC function alone is safe at any time: the
-- application code falls back to nothing automatically, so api/save-upload.js
-- must be rolled back to its pre-migration DELETE+INSERT form in the same
-- change if this function is removed.

-- Step 1: remove existing duplicate rows, keep the earliest per (upload_id, account_name).
with ranked as (
  select id, row_number() over (
    partition by upload_id, account_name
    order by created_at asc, id asc
  ) as rn
  from public.ha_accounts
)
delete from public.ha_accounts
where id in (select id from ranked where rn > 1);

-- Step 2: add the uniqueness guarantee (defense in depth).
alter table public.ha_accounts
  add constraint ha_accounts_upload_account_name_key unique (upload_id, account_name);

-- Step 3: atomic, serialized snapshot-replace RPC.
create or replace function public.replace_ha_accounts_snapshot(
  p_upload_id uuid,
  p_user_id uuid,
  p_accounts jsonb
) returns setof public.ha_accounts
language plpgsql
as $$
begin
  -- Serializes concurrent calls for the SAME upload_id only; different
  -- upload_ids never block each other. Released automatically when this
  -- transaction commits or rolls back.
  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));

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
