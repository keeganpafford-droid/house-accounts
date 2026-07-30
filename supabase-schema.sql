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
  updated_at timestamptz default now()
);

create table if not exists public.ha_weekly_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.ha_users(id) on delete cascade,
  upload_id uuid references public.ha_uploads(id) on delete cascade,
  status text default 'queued',
  summary jsonb default '{}'::jsonb,
  started_at timestamptz default now(),
  finished_at timestamptz
);

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
