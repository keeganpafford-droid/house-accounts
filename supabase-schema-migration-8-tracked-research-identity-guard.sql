-- Migration 8: Phase 2A implementation-review — tracked-research
-- account-identity guard (HA005).
--
-- =============================================================================
-- 1. WHAT THIS CLOSES
-- =============================================================================
-- Release blocker: a client-side bug (Manage Customer Accounts modal
-- single-account research, see the audit this migration responds to)
-- submitted a research-persistence snapshot for one upload ("QA Preview",
-- 1 account) that had been built from a cross-upload aggregate ("QA
-- Preview" + "Phase 1", 31 accounts). replace_ha_accounts_snapshot()'s
-- p_mode='tracked_research' branch (the ONLY path persist_ha_research_output()
-- uses) had NO check that the submitted account_name set actually matched
-- the target upload's own account set -- unlike p_mode='accounts_maintenance',
-- which has carried exactly this check (HA004) since migration 7. The
-- server trusted the client's array completely for tracked_research. The
-- client-side root cause is fixed separately (an explicit,
-- upload_id-scoped research context, and a genuinely upload-scoped
-- api/get-dashboard.js path) -- this migration is the independent,
-- server-side backstop: even a client bug, a compromised client, or a
-- future regression cannot silently rewrite an upload's account set through
-- the tracked-research path, because the database itself now refuses to.
--
-- =============================================================================
-- 2. WHAT THIS DOES NOT CHANGE
-- =============================================================================
-- No tables, columns, indexes, or constraints change. No other function
-- changes. replace_ha_accounts_snapshot()'s signature (6 args), its
-- advisory lock, its research_run_id/attempt_id validation (HA001, via the
-- exists-check already present for p_mode='tracked_research'), its
-- p_mode='initial_upload'/'accounts_maintenance' behavior (HA003, HA004,
-- 55P03), and its existing grants/ownership checks are all preserved
-- byte-for-byte except for the one new block described below. This is a
-- CREATE OR REPLACE of the same function -- safe to re-run, and safe to
-- apply to a project that already has migrations 4-7 applied.
--
-- =============================================================================
-- 3. WHAT THIS ADDS
-- =============================================================================
-- Inside the existing p_mode='tracked_research' branch, AFTER the existing
-- attempt-validity check (HA001) but BEFORE any ha_accounts row is deleted
-- or inserted: compute the upload's existing, deduplicated account_name set
-- and the incoming, deduplicated account_name set from p_accounts (the
-- SAME dedup rule -- distinct account_name -- the write path below already
-- applies), and require EXACT set equality. Any difference (an added,
-- removed, renamed, or foreign-upload-copied account name) raises a new,
-- distinct SQLSTATE 'HA005' and the function returns without touching
-- ha_accounts at all.
--
-- Because this raises before the pre-existing `delete from ha_accounts
-- where upload_id = p_upload_id` statement, and because
-- persist_ha_research_output() (the only caller of this mode) calls this
-- function directly, with no exception handler / savepoint around the
-- call, a raised exception here aborts persist_ha_research_output()'s
-- entire transaction: the heartbeat/lease renewal it performs BEFORE
-- calling this function is rolled back too, no ha_signals rows are
-- inserted, no ha_uploads stage/summary update happens, and the research
-- attempt is left exactly as it was before the call -- neither
-- successfully persisted nor consumed. A caller must claim/retry normally;
-- nothing about this attempt's state changes as a side effect of the
-- rejection.
create or replace function public.replace_ha_accounts_snapshot(
  p_upload_id uuid,
  p_user_id uuid,
  p_accounts jsonb,
  p_mode text,
  p_research_run_id text default null,
  p_attempt_id uuid default null
) returns setof public.ha_accounts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_has_history boolean;
  v_active_running boolean;
  v_existing_names text[];
  v_incoming_names text[];
begin
  if p_mode is null or p_mode not in ('initial_upload', 'accounts_maintenance', 'tracked_research') then
    raise exception 'replace_ha_accounts_snapshot: p_mode must be one of initial_upload, accounts_maintenance, tracked_research (got %)', coalesce(p_mode, 'null')
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));
  if not exists (
    select 1 from public.ha_uploads where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'replace_ha_accounts_snapshot: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  if p_mode = 'tracked_research' then
    if p_research_run_id is null or p_attempt_id is null then
      raise exception 'replace_ha_accounts_snapshot: p_research_run_id and p_attempt_id must both be provided together for p_mode=tracked_research'
        using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.ha_research_runs
      where user_id = p_user_id
        and upload_id = p_upload_id
        and research_run_id = p_research_run_id
        and attempt_id = p_attempt_id
        and status = 'running'
        and lease_expires_at > now()
    ) then
      raise exception 'replace_ha_accounts_snapshot: attempt % for run % is no longer the active attempt for upload % (reclaimed, completed, failed, or its lease had already expired)', p_attempt_id, p_research_run_id, p_upload_id
        using errcode = 'HA001';
    end if;

    -- Migration 8 (HA005): a tracked-research save must submit EXACTLY the
    -- account_name set this upload already has -- research persists
    -- signals/metrics/raw_data for existing accounts, it never legitimately
    -- adds, removes, or renames one, and it must never be able to introduce
    -- account names that actually belong to a different upload. Checked
    -- BEFORE the delete/insert below, so a mismatch changes nothing.
    if jsonb_typeof(p_accounts) is distinct from 'array' then
      raise exception 'replace_ha_accounts_snapshot: p_accounts must be a JSON array (got %)', coalesce(jsonb_typeof(p_accounts), 'null')
        using errcode = '22023';
    end if;

    select coalesce(array_agg(distinct account_name order by account_name), array[]::text[])
      into v_existing_names
      from public.ha_accounts
      where upload_id = p_upload_id;

    select coalesce(array_agg(distinct name order by name), array[]::text[])
      into v_incoming_names
      from (
        select nullif(btrim(elem->>'account_name'), '') as name
        from jsonb_array_elements(p_accounts) as elem
      ) t
      where name is not null;

    if v_existing_names is distinct from v_incoming_names then
      raise exception 'replace_ha_accounts_snapshot: tracked-research snapshot mismatch for upload % -- a research save must submit exactly the account_name set the upload already has, never an added, removed, renamed, or foreign-upload account (existing names %, incoming names %)', p_upload_id, v_existing_names, v_incoming_names
        using errcode = 'HA005';
    end if;
  else
    if p_research_run_id is not null or p_attempt_id is not null then
      raise exception 'replace_ha_accounts_snapshot: p_research_run_id/p_attempt_id may only be supplied for p_mode=tracked_research'
        using errcode = '22023';
    end if;

    select exists(
      select 1 from public.ha_research_runs where upload_id = p_upload_id
    ) into v_has_history;

    if p_mode = 'initial_upload' then
      if v_has_history then
        raise exception 'replace_ha_accounts_snapshot: upload % already has research history; use p_mode=accounts_maintenance for a post-research account edit', p_upload_id
          using errcode = 'HA003';
      end if;
    else -- accounts_maintenance
      select exists(
        select 1 from public.ha_research_runs
        where upload_id = p_upload_id
          and status = 'running'
          and lease_expires_at > now()
      ) into v_active_running;

      if v_active_running then
        raise exception 'replace_ha_accounts_snapshot: a research run is currently active for upload %; cannot perform account maintenance while research is in progress', p_upload_id
          using errcode = '55P03';
      end if;

      if v_has_history then
        if jsonb_typeof(p_accounts) is distinct from 'array' then
          raise exception 'replace_ha_accounts_snapshot: p_accounts must be a JSON array (got %)', coalesce(jsonb_typeof(p_accounts), 'null')
            using errcode = '22023';
        end if;

        select coalesce(array_agg(distinct account_name order by account_name), array[]::text[])
          into v_existing_names
          from public.ha_accounts
          where upload_id = p_upload_id;

        select coalesce(array_agg(distinct name order by name), array[]::text[])
          into v_incoming_names
          from (
            select nullif(btrim(elem->>'account_name'), '') as name
            from jsonb_array_elements(p_accounts) as elem
          ) t
          where name is not null;

        if v_existing_names is distinct from v_incoming_names then
          raise exception 'replace_ha_accounts_snapshot: accounts_maintenance cannot add, remove, or rename accounts once research history exists for upload % (existing names %, incoming names %)', p_upload_id, v_existing_names, v_incoming_names
            using errcode = 'HA004';
        end if;
      end if;
    end if;
  end if;

  -- p_accounts must be a JSON array (explicit, atomic failure otherwise —
  -- see supabase-schema-migration-4-atomic-account-snapshot.sql §6a).
  if jsonb_typeof(p_accounts) is distinct from 'array' then
    raise exception 'replace_ha_accounts_snapshot: p_accounts must be a JSON array (got %)', coalesce(jsonb_typeof(p_accounts), 'null')
      using errcode = '22023';
  end if;

  delete from public.ha_accounts where upload_id = p_upload_id;

  -- In-array duplicate account_name values are resolved deterministically
  -- (last occurrence wins) BEFORE the insert — see migration 4 §6a for why
  -- ON CONFLICT DO UPDATE alone cannot resolve two new rows in the same
  -- statement conflicting with each other.
  return query
  with numbered as (
    select
      nullif(btrim(elem->>'account_name'), '') as account_name,
      nullif(btrim(elem->>'industry'), '') as industry,
      nullif(btrim(elem->>'contact_name'), '') as contact_name,
      lower(nullif(btrim(elem->>'contact_email'), '')) as contact_email,
      coalesce(elem->'metrics', '{}'::jsonb) as metrics,
      coalesce(elem->'raw_data', '{}'::jsonb) as raw_data,
      ord
    from jsonb_array_elements(p_accounts) with ordinality as t(elem, ord)
  ),
  deduped as (
    select distinct on (account_name)
      account_name, industry, contact_name, contact_email, metrics, raw_data
    from numbered
    where account_name is not null
    order by account_name, ord desc
  )
  insert into public.ha_accounts (
    -- user_id is ALWAYS the verified p_user_id — never read from p_accounts.
    user_id, upload_id, account_name, industry, contact_name, contact_email,
    metrics, raw_data, created_at, updated_at
  )
  select
    p_user_id, p_upload_id, account_name, industry, contact_name, contact_email,
    metrics, raw_data, now(), now()
  from deduped
  on conflict (upload_id, account_name) do update set
    industry = excluded.industry, contact_name = excluded.contact_name,
    contact_email = excluded.contact_email, metrics = excluded.metrics,
    raw_data = excluded.raw_data, updated_at = now()
  returning *;
  -- An empty p_accounts array clears the upload's account list to empty
  -- (DELETE above still runs; this INSERT inserts nothing) — explicit,
  -- tested behavior, not an oversight.
end;
$$;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, text, uuid) from public;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, text, uuid) from anon;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, text, uuid) from authenticated;
grant execute on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, text, uuid) to service_role;

-- =============================================================================
-- 4. APPLICATION INSTRUCTIONS
-- =============================================================================
-- Run this entire file once against your Supabase project's SQL editor (or
-- psql), AFTER migrations 4-7 have already been applied. It is a single
-- CREATE OR REPLACE FUNCTION plus its existing grants -- safe to re-run,
-- takes no table lock beyond the function definition itself, and requires
-- no application downtime. No data migration or backfill is needed.
