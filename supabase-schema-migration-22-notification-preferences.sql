-- Migration 22: Notification & Outcome Loop V1 -- per-user notification
-- cadence preference and a durable delivery log for the new, independent
-- notification scheduler (Step 3). weekly-scan.js's own digest send has no
-- delivery log today (fire-and-forget) -- this is the first one in the
-- codebase, deliberately built for the NEW notifier, not retrofitted onto
-- the legacy sweep (see the Monday Brief migration decision left for the
-- founder in the recon report).
--
-- notification_preference: additive, defaulted to 'weekly' so every
-- existing Beta user is unaffected by this migration alone -- no backfill
-- needed, the column default IS the backfill.
alter table public.ha_users
  add column if not exists notification_preference text not null default 'weekly'
  check (notification_preference in ('daily', 'weekly', 'in_app_only'));

-- ha_notification_deliveries: one row per SEND ATTEMPT (never per
-- no-op/empty-digest skip -- an empty digest is never sent at all, so
-- nothing is logged for it, keeping this table meaningful: every row here
-- represents a real decision to email a user). status distinguishes a
-- genuine Resend failure from a successful send; only a 'success' row ever
-- advances the effective "last notified" watermark the notifier computes
-- from this table -- a 'failed' row is retried on the next scheduler run
-- against the SAME unadvanced watermark, so nothing is silently lost.
--
-- included_signal_ids/included_outreach_event_ids are the durable dedupe
-- keys: a plain array column, not a separate per-item relational table --
-- per the founder's explicit instruction, no separate notification-item
-- model is built for V1 unless evidence proves arrays/JSON cannot safely
-- support it. They serve two jobs: (1) new-signal dedupe is actually driven
-- by first_seen_at compared against this row's own sent_at watermark, not
-- by scanning these arrays -- they exist primarily for audit/debugging
-- visibility into exactly what one email contained; (2) included_outreach_
-- event_ids IS actively read back by the digest builder, to suppress
-- re-including an unresolved-outreach prompt that was already mentioned in
-- the most recent successful delivery and whose underlying state (a new
-- outcome_reported report) hasn't changed since -- see
-- api/lib/notification-digest.js.
create table if not exists public.ha_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ha_users(id) on delete cascade,
  organization_id uuid references public.ha_organizations(id) on delete set null,
  status text not null check (status in ('success', 'failed')),
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  new_signal_count integer not null default 0,
  unresolved_outreach_count integer not null default 0,
  included_signal_ids uuid[] not null default '{}',
  included_outreach_event_ids uuid[] not null default '{}',
  resend_message_id text,
  error text
);

-- The hot read on every scheduler invocation, once per candidate user: "my
-- most recent SUCCESSFUL delivery" -- this is both the new-signal watermark
-- and (for weekly users) the due-cadence check, so it is the one index that
-- actually matters for this table.
create index if not exists ha_notification_deliveries_user_success_idx
  on public.ha_notification_deliveries (user_id, sent_at desc)
  where status = 'success';

-- RLS: fail-closed for anon/authenticated, unaffected for service_role --
-- same posture as every other internal-only table in this schema. Nothing
-- browser-facing ever reads or writes this table; the notification
-- scheduler (service-role key) is the only writer, and the dashboard's own
-- unresolved-outreach panel reads ha_signal_events directly, never this log.
alter table public.ha_notification_deliveries enable row level security;
