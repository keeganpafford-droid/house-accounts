-- Migration 11: signal feedback / organizational-learning foundation.
--
-- One new, append-only table: ha_signal_events. No other table is touched
-- -- ha_signals.organization_id was explicitly evaluated for this sprint
-- and found unnecessary (every write below resolves organization_id from
-- the verified rep's own ha_users row, and every read is scoped by
-- ha_signal_events.organization_id/user_id directly, never by joining
-- through ha_signals) -- see the design doc for the full reasoning.
--
-- Product principle this table exists to serve: House Accounts learns how
-- a specific rep, and more importantly a specific ORGANIZATION, sells.
-- Raw rep behavior/approach notes/outcomes are proprietary to the
-- organization that generated them and are never pooled across
-- organizations, benchmarked cross-customer, or used to hand one
-- organization another organization's selling playbook. That boundary is
-- enforced at the query layer (api/signal-events.js always scopes by the
-- verified rep's own organization_id) and, from this migration, at the
-- database layer too (see RLS below).
--
-- Column notes:
--   client_event_id: caller-generated UUID, one per distinct user gesture
--     (a button click, a note save). Retrying that SAME gesture (a
--     network timeout, a double-click before the button disables) must
--     reuse the SAME id so the unique constraint below turns the retry
--     into a no-op replay instead of a second row. A genuinely NEW
--     gesture (a later, separate outreach attempt; reconsidering a
--     Useful/Not-useful judgment) always gets a freshly generated id.
--     Scoped to (user_id, client_event_id) -- per rep, not globally --
--     per the founder's explicit instruction.
--   event_fingerprint: the durable, long-lived business-event identity
--     (matches ha_signals.event_fingerprint) -- the preferred join key
--     for any future learning query, since it survives a signal row being
--     refreshed/re-persisted.
--   signal_id: optional/secondary pointer to the ha_signals row that was
--     actually resolved server-side at write time. May go stale if that
--     row is later refreshed with a new id; event_fingerprint remains
--     authoritative.
--   parent_event_id: self-referencing. Links an approach_shared (and,
--     later, an outcome_reported) row back to the SPECIFIC outreach_made
--     attempt it belongs to -- required because the same rep may make
--     multiple outreach attempts against the same signal over time, each
--     with its own approach/outcome.
--   event_type: signal_useful/signal_not_useful judge the underlying
--     SIGNAL only ("was this a useful reason to reach out?"), deliberately
--     never HA's commercial play/recommendation -- a separate,
--     not-yet-built recommendation_* event family is reserved for that so
--     the two datasets are never conflated. prepare_call_opened is an
--     ENGAGEMENT event, not positive feedback. outcome_reported is
--     reserved (constraint allows it) but api/signal-events.js rejects it
--     as unsupported until the delayed-outcome-collection sprint exists --
--     the value is reserved now purely so no future migration is needed
--     just to widen this CHECK constraint.
--   schema_version: lets a future sprint change what a given event_type's
--     payload shape means without ambiguity. Not a general schema
--     registry -- just an integer tag, default 1 (the shape documented in
--     this migration and in api/signal-events.js).
--   payload: compact and derived SERVER-SIDE from the actual, currently-
--     stored ha_signals.payload at write time for signal_selected/
--     signal_useful/signal_not_useful/outreach_made (signal type/title, a
--     truncated commercial-play narrative, recommended contact, up to 3
--     activation ideas, a truncated conversation starter) -- never trusted
--     from the browser. approach_shared's payload carries only the rep's
--     own immutable freeform note (length-limited server-side). This is
--     what lets a future query compare "what HA recommended" against
--     "what the rep actually did," without duplicating the full signal
--     record on every event.
create table if not exists public.ha_signal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.ha_organizations(id),
  user_id uuid not null references public.ha_users(id),
  client_event_id uuid not null,
  event_fingerprint text not null,
  signal_id uuid references public.ha_signals(id) on delete set null,
  parent_event_id uuid references public.ha_signal_events(id) on delete set null,
  account_name text not null,
  event_type text not null check (event_type in (
    'prepare_call_opened',
    'signal_selected',
    'signal_useful',
    'signal_not_useful',
    'outreach_made',
    'approach_shared',
    'outcome_reported'
  )),
  schema_version smallint not null default 1,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ha_signal_events_user_client_event_unique unique (user_id, client_event_id)
);

create index if not exists ha_signal_events_org_created_idx on public.ha_signal_events(organization_id, created_at desc);
-- V1's only read path (api/signal-events.js GET) queries exactly
-- "this rep's events for one or more fingerprints, latest first" -- this
-- composite index matches that access pattern directly. No other index is
-- added speculatively.
create index if not exists ha_signal_events_user_fingerprint_created_idx on public.ha_signal_events(user_id, event_fingerprint, created_at desc);
create index if not exists ha_signal_events_parent_event_idx on public.ha_signal_events(parent_event_id);

-- This table holds proprietary organization-level sales behavior and
-- freeform rep notes. The application architecture (every api/*.js write/
-- read of this table goes through a verified-Bearer-token server endpoint
-- using the Supabase service-role key, which bypasses RLS by design) does
-- not need or use browser-facing Supabase client policies -- so none are
-- added here. Enabling RLS with zero policies means the anon/authenticated
-- Postgres roles a browser-held key would use can see or write NOTHING in
-- this table (fail closed), while the existing service-role server path is
-- completely unaffected and continues to work exactly as before.
ALTER TABLE public.ha_signal_events ENABLE ROW LEVEL SECURITY;
