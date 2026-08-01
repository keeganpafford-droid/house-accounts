-- Migration 5: Phase 2A / implementation-review item 2 — server-owned
-- logical research-run tracking for public.ha_research_runs.
--
-- =============================================================================
-- 1. WHAT THIS CLOSES
-- =============================================================================
-- The Phase 2A saveQueue fix (dashboard/index.html) only serializes
-- saveCurrentUpload() calls within one JS execution context (one tab, one
-- page load). It does nothing to stop a second browser tab, or the same tab
-- after a reload, from independently calling researchTopAccounts() and
-- launching its own full 4-worker research pass against the SAME upload —
-- each pass would make its own real OpenAI/search-provider calls and its own
-- eventual save, which is both wasteful and, per the Phase 2A audit
-- correction, exactly the kind of scenario that must be ruled out (not
-- assumed) before trusting an accepted-vs-persisted signal count. This
-- migration adds the missing SERVER-SIDE tracking that makes "one active
-- logical research run per upload" an actual database guarantee rather than
-- a client-side assumption. See api/research-batch.js for the claim/
-- complete/fail logic that reads and writes this table.
--
-- =============================================================================
-- 2. WHY A SEPARATE TABLE FROM ha_weekly_runs
-- =============================================================================
-- ha_weekly_runs tracks the scheduled/cron monitoring path (api/weekly-scan.js)
-- and its own lifecycle (queued/running/complete/partial/failed/timed_out) is
-- specific to that path's chunked, multi-account-batch execution model.
-- ha_research_runs tracks a different, simpler thing: one interactive
-- dashboard research invocation (researchTopAccounts()), keyed by a
-- client-visible-but-server-validated research_run_id, with a much smaller
-- state machine (running/completed/failed). Conflating the two would couple
-- two independently-evolving execution paths for no benefit.
--
-- =============================================================================
-- 3. WHY A PARTIAL UNIQUE INDEX, NOT A PLAIN UNIQUE CONSTRAINT
-- =============================================================================
-- Same reasoning as idx_ha_weekly_runs_one_running_per_upload (migration 3):
-- an upload legitimately accumulates many historical runs (completed,
-- failed) over its lifetime; only the transient 'running' state should ever
-- be singular at a given moment for a given upload.
--
-- =============================================================================
-- 4. ROLLBACK
-- =============================================================================
-- drop index concurrently if exists idx_ha_research_runs_one_running_per_upload;
-- drop table if exists public.ha_research_runs;
-- Rolling back removes run-history tracking entirely; api/research-batch.js
-- must be rolled back to its pre-migration form (no run-claiming) in the same
-- change, since it will otherwise fail every request once this table is gone.

create table if not exists public.ha_research_runs (
  id uuid primary key default gen_random_uuid(),
  research_run_id text not null,
  user_id uuid not null references public.ha_users(id) on delete cascade,
  upload_id uuid not null references public.ha_uploads(id) on delete cascade,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  result_summary jsonb default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  constraint ha_research_runs_user_upload_run_key unique (user_id, upload_id, research_run_id)
);

create unique index concurrently if not exists idx_ha_research_runs_one_running_per_upload
  on public.ha_research_runs(upload_id)
  where status = 'running';

-- Same trust model as replace_ha_accounts_snapshot (migration 4 §5): no RLS
-- policies exist on this table, and it is intended to be read/written only
-- by server-side code using the service_role key. No RPC function is needed
-- here (api/research-batch.js issues plain REST calls against this table,
-- the same pattern every other api/*.js file already uses), but PostgREST
-- still exposes this table directly at /rest/v1/ha_research_runs to any
-- anon/authenticated client by default unless RLS is enabled with no
-- permissive policies (the same implicit protection every other ha_* table
-- in this schema already relies on — there is no plain "revoke" equivalent
-- for table access the way there is for a function's EXECUTE privilege).
alter table public.ha_research_runs enable row level security;
-- No policies are created: RLS enabled with zero policies denies all access
-- to anon/authenticated roles by default, while service_role (used
-- exclusively by api/research-batch.js) bypasses RLS entirely as it already
-- does for every other table in this schema.
