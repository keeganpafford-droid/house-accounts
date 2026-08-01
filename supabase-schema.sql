-- House Accounts v39 schema. Run once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.ha_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  company text,
  role text,
  house_accounts text,
  crm_erp text,
  source_page text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.ha_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.ha_users(id) on delete cascade,
  upload_name text,
  stage text default 'uploaded',
  summary jsonb default '{}'::jsonb,
  source_page text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.ha_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.ha_users(id) on delete cascade,
  upload_id uuid references public.ha_uploads(id) on delete cascade,
  account_name text not null,
  industry text,
  contact_name text,
  contact_email text,
  metrics jsonb default '{}'::jsonb,
  raw_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- At most one row per (upload_id, account_name) — see
  -- supabase-schema-migration-4-atomic-account-snapshot.sql for the full
  -- rationale (confirmed root cause of a duplicate-row production defect)
  -- and the production migration for existing databases.
  constraint ha_accounts_upload_account_name_key unique (upload_id, account_name)
);

-- Audit trail for rows removed by the de-duplication step in
-- supabase-schema-migration-4-atomic-account-snapshot.sql §3 (irrelevant on a
-- brand-new database, since there is nothing to de-duplicate, but declared
-- here so the end state matches an already-migrated production database).
create table if not exists public.ha_accounts_dedup_audit (
  id uuid primary key default gen_random_uuid(),
  removed_account_id uuid not null,
  kept_account_id uuid not null,
  upload_id uuid not null,
  account_name text not null,
  removed_row_snapshot jsonb not null,
  removed_at timestamptz not null default now()
);

-- Atomic, serialized, ownership-checked full-snapshot replace for an
-- upload's account list. SECURITY INVOKER, not DEFINER, and EXECUTE is
-- revoked from anon/authenticated below — see
-- supabase-schema-migration-4-atomic-account-snapshot.sql §5 for the full
-- security rationale (service_role-only trust model, no RLS policies exist
-- on these tables, ownership of p_upload_id is verified against p_user_id
-- before any row is touched).
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
  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));
  if not exists (
    select 1 from public.ha_uploads where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'replace_ha_accounts_snapshot: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
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
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid) from public;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid) from anon;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid) from authenticated;
grant execute on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid) to service_role;

create table if not exists public.ha_weekly_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.ha_users(id) on delete cascade,
  upload_id uuid references public.ha_uploads(id) on delete cascade,
  status text default 'queued',
  summary jsonb default '{}'::jsonb,
  started_at timestamptz default now(),
  finished_at timestamptz
);

-- At most one 'running' row per upload at any moment (see
-- supabase-schema-migration-3-single-running-run.sql for the full rationale
-- and the production migration for existing databases). Terminal states
-- (complete/partial/failed/timed_out) are unrestricted and accumulate freely.
create unique index if not exists idx_ha_weekly_runs_one_running_per_upload
  on public.ha_weekly_runs(upload_id)
  where status = 'running';

-- Server-owned logical research-run tracking (Phase 2A implementation-review,
-- both rounds). Distinct from ha_weekly_runs, which tracks the scheduled/
-- cron monitoring path — this tracks the interactive dashboard research path
-- (researchTopAccounts() in dashboard/index.html), so a browser reload or a
-- second tab cannot launch an untracked, duplicate research execution
-- against the same upload, and a killed Vercel invocation cannot leave a run
-- stuck at status='running' forever. See
-- supabase-schema-migration-5-research-run-idempotency.sql for the full
-- design rationale (lease/attempt semantics, why the old partial unique
-- index was removed in favor of the RPC below) and
-- api/research-batch.js for the claim/complete/fail call sites.
create table if not exists public.ha_research_runs (
  id uuid primary key default gen_random_uuid(),
  research_run_id text not null,
  user_id uuid not null references public.ha_users(id) on delete cascade,
  upload_id uuid not null references public.ha_uploads(id) on delete cascade,
  status text not null default 'running',
  attempt_id uuid not null default gen_random_uuid(),
  attempt_count integer not null default 1,
  lease_expires_at timestamptz not null default (now() + interval '5 minutes'),
  heartbeat_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  result_summary jsonb default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  constraint ha_research_runs_user_upload_run_key unique (user_id, upload_id, research_run_id)
);

-- Atomic claim/attach/reclaim RPC — see migration 5 §3/§4/§7 for the full
-- rationale (why a plain unique index cannot encode lease expiry, why this
-- must be one atomic function rather than separate REST calls).
create or replace function public.claim_ha_research_run(
  p_user_id uuid,
  p_upload_id uuid,
  p_research_run_id text,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing public.ha_research_runs;
  v_other_active public.ha_research_runs;
  v_result public.ha_research_runs;
begin
  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));

  if not exists (
    select 1 from public.ha_uploads where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'claim_ha_research_run: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  select * into v_existing
  from public.ha_research_runs
  where user_id = p_user_id and upload_id = p_upload_id and research_run_id = p_research_run_id
  for update;

  if found then
    if v_existing.status = 'completed' then
      return jsonb_build_object('outcome', 'completed', 'run', to_jsonb(v_existing));
    end if;

    if v_existing.status = 'running' and v_existing.lease_expires_at > now() then
      return jsonb_build_object('outcome', 'attached-active', 'run', to_jsonb(v_existing));
    end if;

    update public.ha_research_runs
    set status = 'running',
        attempt_id = gen_random_uuid(),
        attempt_count = v_existing.attempt_count + 1,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        heartbeat_at = now(),
        started_at = now(),
        completed_at = null,
        error_message = null
    where id = v_existing.id
    returning * into v_result;

    return jsonb_build_object(
      'outcome', case when v_existing.status = 'failed' then 'reclaimed-after-failure' else 'reclaimed-after-expired-lease' end,
      'run', to_jsonb(v_result)
    );
  end if;

  -- Round 3: an automatic claim ('auto') must not start again if ANY run
  -- for this upload already completed (auto or manual) — see migration 5's
  -- "close manual-before-auto duplication" section for the full rationale.
  if p_research_run_id = 'auto' then
    select * into v_other_active
    from public.ha_research_runs
    where upload_id = p_upload_id and status = 'completed'
    order by completed_at desc
    limit 1;
    if found then
      return jsonb_build_object('outcome', 'completed', 'run', to_jsonb(v_other_active));
    end if;
  end if;

  select * into v_other_active
  from public.ha_research_runs
  where upload_id = p_upload_id and status = 'running' and lease_expires_at > now()
  limit 1;

  if found then
    raise exception 'claim_ha_research_run: a different research run (%) is already in progress for upload %', v_other_active.research_run_id, p_upload_id
      using errcode = '55P03';
  end if;

  insert into public.ha_research_runs (
    research_run_id, user_id, upload_id, status, attempt_id, attempt_count,
    lease_expires_at, heartbeat_at, started_at
  ) values (
    p_research_run_id, p_user_id, p_upload_id, 'running', gen_random_uuid(), 1,
    now() + make_interval(secs => p_lease_seconds), now(), now()
  )
  returning * into v_result;

  return jsonb_build_object('outcome', 'claimed-new', 'run', to_jsonb(v_result));
end;
$$;
revoke all on function public.claim_ha_research_run(uuid, uuid, text, integer) from public;
revoke all on function public.claim_ha_research_run(uuid, uuid, text, integer) from anon;
revoke all on function public.claim_ha_research_run(uuid, uuid, text, integer) from authenticated;
grant execute on function public.claim_ha_research_run(uuid, uuid, text, integer) to service_role;

-- Atomic lease renewal / attempt verification (one compare-and-swap UPDATE
-- — see migration 5 §7a for the full rationale, including why this does
-- NOT take the advisory lock claim_ha_research_run() uses).
create or replace function public.heartbeat_ha_research_run(
  p_user_id uuid,
  p_upload_id uuid,
  p_research_run_id text,
  p_attempt_id uuid,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_clamped_lease_seconds integer;
  v_row public.ha_research_runs;
begin
  v_clamped_lease_seconds := greatest(60, least(coalesce(p_lease_seconds, 300), 900));

  if not exists (
    select 1 from public.ha_uploads where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'heartbeat_ha_research_run: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  update public.ha_research_runs
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => v_clamped_lease_seconds)
  where user_id = p_user_id
    and upload_id = p_upload_id
    and research_run_id = p_research_run_id
    and attempt_id = p_attempt_id
    and status = 'running'
  returning * into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-current-attempt');
  end if;

  return jsonb_build_object('ok', true, 'run', to_jsonb(v_row));
end;
$$;
revoke all on function public.heartbeat_ha_research_run(uuid, uuid, text, uuid, integer) from public;
revoke all on function public.heartbeat_ha_research_run(uuid, uuid, text, uuid, integer) from anon;
revoke all on function public.heartbeat_ha_research_run(uuid, uuid, text, uuid, integer) from authenticated;
grant execute on function public.heartbeat_ha_research_run(uuid, uuid, text, uuid, integer) to service_role;

-- RLS enabled, no policies: denies all anon/authenticated access by default;
-- service_role (used exclusively by api/research-batch.js) bypasses RLS.
alter table public.ha_research_runs enable row level security;

create table if not exists public.ha_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.ha_users(id) on delete cascade,
  upload_id uuid references public.ha_uploads(id) on delete cascade,
  weekly_run_id uuid references public.ha_weekly_runs(id) on delete set null,
  account_name text not null,
  signal_hash text unique not null,
  -- Business-event identity (see resolveOpportunityEvents() in
  -- api/signal-intelligence.js). This is the real dedup key: it identifies
  -- the same real-world event regardless of which chunk, source, or AI
  -- generation produced the title text. signal_hash above is kept only for
  -- literal exact-duplicate protection and backward compatibility; it is
  -- title-text-based and must not be relied on to catch reworded duplicates.
  event_fingerprint text,
  signal_type text,
  title text,
  why_reach_out text,
  confidence numeric,
  source_url text,
  source_domain text,
  published_at text,
  payload jsonb default '{}'::jsonb,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now()
);

-- One stored event per monitored company per customer: the same
-- event_fingerprint cannot be inserted twice for the same user. Deliberately
-- NOT scoped by upload_id — House Accounts monitors companies, not uploads,
-- and upload_id is just one current intake mechanism among others (re-upload,
-- CRM sync, manual entry, ...). Scoping by upload_id would let the same
-- company's event duplicate again across a re-upload or a second intake
-- source, reproducing this same bug one layer up. NULLs are intentionally
-- allowed to remain non-unique (existing rows are backfilled by
-- scripts/backfill-event-fingerprint.js; see
-- supabase-schema-migration-2-event-fingerprint.sql for the staged rollout
-- against a database that already has data). Postgres has no
-- "ADD CONSTRAINT IF NOT EXISTS", so this is guarded explicitly.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ha_signals_user_fingerprint_key'
  ) then
    alter table public.ha_signals
      add constraint ha_signals_user_fingerprint_key
      unique (user_id, event_fingerprint);
  end if;
end $$;

create index if not exists idx_ha_uploads_user on public.ha_uploads(user_id);
create index if not exists idx_ha_accounts_upload on public.ha_accounts(upload_id);
create index if not exists idx_ha_signals_upload on public.ha_signals(upload_id);
create index if not exists idx_ha_signals_user_first_seen on public.ha_signals(user_id, first_seen_at desc);
create index if not exists idx_ha_signals_event_fingerprint on public.ha_signals(event_fingerprint);
