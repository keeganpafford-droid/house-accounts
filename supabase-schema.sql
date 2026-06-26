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

create index if not exists idx_ha_uploads_user on public.ha_uploads(user_id);
create index if not exists idx_ha_accounts_upload on public.ha_accounts(upload_id);
create index if not exists idx_ha_signals_upload on public.ha_signals(upload_id);
create index if not exists idx_ha_signals_user_first_seen on public.ha_signals(user_id, first_seen_at desc);
