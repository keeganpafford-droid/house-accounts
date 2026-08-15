-- Migration 15: Phase 1 monitoring-architecture foundation.
--
-- Purely additive. No existing table, column, constraint, or RPC is
-- altered. No trigger runs against production behavior yet -- these three
-- tables are inert until a later phase's scheduler/Queue worker/digest job
-- actually reads or writes them. Weekly monitoring (api/weekly-scan.js)
-- and every other current code path is unaffected by this migration.
--
-- Context: House Accounts is moving recurring account monitoring from one
-- monolithic Monday cron sweep to a scheduler -> durable due targets ->
-- Vercel Queue -> bounded single-account workers -> persisted intelligence
-- shape. This migration adds only the durable state that shape needs to
-- exist; the scheduler, Queue, and workers themselves are later phases.
--
-- ============================================================================
-- 1. ha_monitoring_targets -- the durable recurring-monitoring identity.
-- ============================================================================
--
-- Why this table exists at all, and why it is not just ha_accounts.id:
-- replace_ha_accounts_snapshot() (migration 4) deletes and reinserts every
-- row for an upload on EVERY save, including a re-research-triggered
-- resave, not just a fresh upload -- ha_accounts.id is regenerated then.
-- upload_id is not durable either: a full re-upload of the same list mints
-- a brand new upload_id (see api/weekly-scan.js's own comment on why its
-- event_fingerprint dedup is deliberately not upload_id-scoped). Attaching
-- a long-lived recurring schedule to either would silently orphan/duplicate
-- it the next time a customer re-uploads or a research run resaves the
-- account list.
--
-- Identity model: (user_id, normalized_company_name), deliberately the SAME
-- tuple api/signal-intelligence.js's event_fingerprint already uses for the
-- identical reason (it is the one identity proven to survive uploads,
-- reprocessing, and list maintenance in this codebase today).
-- normalized_company_name uses the exact same algorithm as
-- api/company-identity.js's normalizeCompanyName() -- lowercase, strip
-- common legal suffixes, collapse punctuation/whitespace. See
-- scripts/backfill-monitoring-targets.js and api/lib/monitoring-targets.js
-- for the JS implementation this must stay byte-for-byte consistent with;
-- no SQL trigger reimplements this normalization, so drift is avoided by
-- there being exactly one normalization call site (the backfill/enqueue
-- code), not two.
--
-- Deliberately user_id-scoped, not organization_id-scoped: two teammates in
-- the same organization uploading the same real customer under slightly
-- different spellings will, for now, produce two independently-monitored
-- targets. This is a named, accepted limitation (not a bug) until
-- Canonical Account Identity / account assignment is intentionally solved
-- later -- unifying across users requires deciding whose account record
-- wins, which is a product decision this migration does not make.
-- organization_id is stored for reporting/routing convenience only (e.g. a
-- future notification job's org-scoped queries) -- it is never part of the
-- identity key and never used to deduplicate targets across users.
--
-- current_upload_id is explicitly informational, not authoritative: it is
-- whatever upload the backfill/sync last observed this identity under, kept
-- only so an operator can trace a target back to a recent upload for
-- debugging. Nothing may treat it as a stable foreign key the target
-- depends on -- the whole point of this table is to survive upload_id
-- churn.
--
-- next_due_at / last_scanned_at: per the locked architecture direction,
-- these will eventually advance ONLY on a worker's own explicit successful-
-- completion write (a later phase). This migration only creates the
-- columns; nothing in this phase writes to next_due_at after the initial
-- backfill, and nothing reads it to drive any scheduler yet.
create table if not exists public.ha_monitoring_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ha_users(id),
  organization_id uuid not null references public.ha_organizations(id),
  normalized_company_name text not null,
  display_account_name text not null,
  current_upload_id uuid references public.ha_uploads(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'paused', 'removed')),
  next_due_at timestamptz not null,
  last_scanned_at timestamptz,
  last_attempt_at timestamptz,
  last_attempt_status text check (last_attempt_status is null or last_attempt_status in ('success', 'failed')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ha_monitoring_targets_user_identity_unique unique (user_id, normalized_company_name)
);

-- Matches the scheduler's future access pattern directly ("which active
-- targets are due right now") -- no other index is added speculatively.
create index if not exists ha_monitoring_targets_due_idx
  on public.ha_monitoring_targets (next_due_at)
  where status = 'active';
create index if not exists ha_monitoring_targets_org_idx
  on public.ha_monitoring_targets (organization_id);

-- ============================================================================
-- 2. ha_monitoring_attempts -- per-attempt provider-usage/cost telemetry.
-- ============================================================================
--
-- Persists exactly the providerUsage shape api/research-batch.js already
-- computes on every invocation today (openai calls/tokens, serper
-- queries/failures, firecrawl requests/successes) -- currently only
-- console.log'd, never durable. This is persistence of already-computed
-- data, not new instrumentation. Not a billing meter or finance dashboard:
-- a flat fact table meant to be queried ad hoc (count of attempts,
-- successes, avg(estimated_cost_usd), retry overhead per target) once a
-- later phase's worker starts writing rows here. Nothing writes to this
-- table yet in this phase.
--
-- cost_model_version: estimated_cost_usd is only ever as good as the
-- per-unit provider rates used to compute it at write time. If those rates
-- change later, historical rows must stay interpretable as "computed under
-- assumption set N" rather than silently becoming misleading -- this
-- column is that tag, not a general schema-version mechanism.
create table if not exists public.ha_monitoring_attempts (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.ha_monitoring_targets(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  outcome text not null check (outcome in ('success', 'failed')),
  elapsed_ms integer,
  openai_calls integer not null default 0,
  openai_input_tokens integer not null default 0,
  openai_output_tokens integer not null default 0,
  serper_queries integer not null default 0,
  serper_failed_queries integer not null default 0,
  firecrawl_requests integer not null default 0,
  firecrawl_successes integer not null default 0,
  estimated_cost_usd numeric(8, 5),
  cost_model_version text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists ha_monitoring_attempts_target_idx
  on public.ha_monitoring_attempts (target_id, attempted_at desc);

-- ============================================================================
-- 3. ha_email_log -- one shared email-delivery evidence model.
-- ============================================================================
--
-- Deliberately generic across email_type ('welcome' | 'weekly_digest' |
-- 'founder_notification' | ...) rather than a separate log table per email
-- kind -- a single lightweight evidence model every transactional send can
-- share via one future helper (sendTrackedEmail()), not built in this
-- phase. Nothing in the codebase writes to this table yet -- existing
-- emails (founder-notification, invite) are untouched in this phase.
--
-- Timestamp semantics, exactly as specified: attempted_at is always
-- populated the moment a send is attempted, regardless of outcome
-- (sent/skipped/failed). sent_at is nullable and populated ONLY when the
-- provider actually accepted the send -- the CHECK constraint makes "sent_at
-- set but status not sent" structurally impossible rather than a
-- convention callers could violate.
create table if not exists public.ha_email_log (
  id uuid primary key default gen_random_uuid(),
  email_type text not null,
  recipient text not null,
  status text not null check (status in ('sent', 'skipped', 'failed')),
  provider_message_id text,
  error text,
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint ha_email_log_sent_at_requires_sent check (sent_at is null or status = 'sent')
);

create index if not exists ha_email_log_type_attempted_idx
  on public.ha_email_log (email_type, attempted_at desc);

-- ============================================================================
-- RLS: fail closed for anon/authenticated, unaffected for service_role.
-- ============================================================================
-- Every current and planned reader/writer of these three tables is a
-- server-side api/*.js endpoint using the Supabase service-role key, which
-- bypasses RLS by design -- the same posture migration 11 already
-- established for ha_signal_events. Enabling RLS with zero policies means
-- an anon/authenticated (browser-held) key can see or write nothing in any
-- of these tables; the service-role server path is entirely unaffected.
ALTER TABLE public.ha_monitoring_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ha_monitoring_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ha_email_log ENABLE ROW LEVEL SECURITY;
