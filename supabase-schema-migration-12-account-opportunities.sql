-- Migration 12: Organizational Learning V1B -- durable identity/persistence
-- for Follow-Up and Repeat/Pattern account-history opportunities, and the
-- ha_signal_events extension that lets them participate in the SAME
-- feedback machinery V1A already built for Business Signals.
--
-- Architecture doctrine locked across the design conversation (see the
-- design doc for the full reasoning; restated here only where it explains
-- a concrete column/constraint choice):
--   - Sibling entity, not a generalized ha_opportunities table. Business
--     Signals stay exclusively in ha_signals; this table never holds one.
--   - Family vs instance identity: family (account [+ category]) is an
--     evergreen grouping key, never its own row -- every row here IS an
--     instance, one actionable cycle of its family. A rep's Useful/Used/
--     Outreach/Approach state attaches to the INSTANCE, so a new cycle
--     (a new anchor date) never inherits a prior cycle's feedback.
--   - Repeat/Pattern family = (account_name, category); instance anchor =
--     that category's most recent qualifying purchase date ("lastDate").
--   - Follow-Up family = (account_name) alone; instance anchor = the
--     account's own most recent dated purchase record ("mostRecentDate").
--     Both anchors are real evidence (a purchase date), not a fabricated
--     boundary -- calendar drift (a reorder window moving from approaching
--     to overdue, an account's live recency score decaying) never changes
--     the anchor and therefore never spawns a new instance; only a
--     genuinely new, later purchase does.
--   - Generic Follow-Up and non-grounded "Repeat/Pattern"-labeled template
--     opportunities (dashboard/index.html's createOpportunity()) both
--     normalize to opportunity_type='follow_up' here -- they are the same
--     generation mechanism with a label that flips purely on account-level
--     recency, never genuine per-category evidence (see
--     api/lib/account-opportunities.js's own header comment). Only
--     genuinely detected per-category cadences (opportunityType==='REPEAT
--     PATTERN' client-side) become opportunity_type='repeat_pattern'.
--   - Lifecycle is append-only: a row is never deleted. Reconciliation
--     (run server-side whenever an account's purchase history changes --
--     see api/save-upload.js) flips status between active/inactive/
--     superseded; superseded_by_id/superseded_at record exactly what
--     replaced what, for later longitudinal learning.
--
-- Column notes:
--   family_fingerprint: opp:<type>:v1:<account_norm>[|<category_norm>] --
--     the evergreen grouping key. account_norm reuses V1A's own
--     normalizeCompany() (api/signal-intelligence.js), the same
--     normalization the fingerprint-collision audit already relies on --
--     not a second, weaker normalizer.
--   fingerprint: family_fingerprint + '|last:<anchor date>' -- the
--     addressable instance identity. unique(user_id, fingerprint) is what
--     makes reconciliation idempotent: recomputing an unchanged account
--     reproduces the SAME fingerprint and updates the same row rather than
--     creating a duplicate.
--   The opp: prefix (present in BOTH family_fingerprint and fingerprint)
--     makes collision with a V1A ha_signals.event_fingerprint impossible
--     by construction -- that format has no colon-delimited prefix at all.
--     The :v1: segment allows a future formula revision without
--     reinterpreting historical rows, mirroring ha_signal_events'
--     schema_version column.
--   category: populated only for opportunity_type='repeat_pattern' (the
--     real evidence anchor for that family); always null for 'follow_up',
--     which is deliberately account-level, not per-category (see above).
--     Enforced structurally below, not merely by convention.
--   status/superseded_by_id/superseded_at/last_seen_at: the lifecycle
--     model. 'active' = the current, live instance for its family.
--     'superseded' = a newer instance in the same family now exists (see
--     superseded_by_id for exactly which one). 'inactive' = reconciliation
--     no longer finds this family's evidence at all (e.g. a data
--     correction removed the qualifying purchases). last_seen_at is
--     bumped every time reconciliation reconfirms this exact instance is
--     still current -- distinguishes "still live, recently reconfirmed"
--     from "hasn't been touched in a long time" without ever deleting a
--     row. The partial unique index below enforces "at most one active
--     instance per family" at the database level, independent of whether
--     the reconciliation logic that's supposed to guarantee it ever has a
--     bug.
--   payload: a compact, template-independent EVIDENCE snapshot (why this
--     instance exists -- category/orderCount/years/monthLabel/avgRevenue/
--     confidence for repeat_pattern; mostRecentOrderDate/orderCount for
--     follow_up), server-derived at reconciliation time, never trusted
--     from a client. This is deliberately NOT the same thing as the
--     RECOMMENDATION-AT-ACTION snapshot captured on individual
--     ha_signal_events rows (what HA actually presented to the rep at the
--     moment they acted, via a trusted server-validated template key) --
--     see api/signal-events.js for that half.
create table if not exists public.ha_account_opportunities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ha_users(id),
  upload_id uuid references public.ha_uploads(id),
  account_name text not null,
  opportunity_type text not null check (opportunity_type in ('repeat_pattern', 'follow_up')),
  category text,
  family_fingerprint text not null,
  fingerprint text not null,
  status text not null default 'active' check (status in ('active', 'inactive', 'superseded')),
  superseded_by_id uuid references public.ha_account_opportunities(id) on delete set null,
  superseded_at timestamptz,
  last_seen_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ha_account_opportunities_user_fingerprint_unique unique (user_id, fingerprint),
  constraint ha_account_opportunities_category_shape check (
    (opportunity_type = 'repeat_pattern' and category is not null)
    or (opportunity_type = 'follow_up' and category is null)
  )
);

create index if not exists ha_account_opportunities_user_family_idx on public.ha_account_opportunities(user_id, family_fingerprint);
create index if not exists ha_account_opportunities_status_idx on public.ha_account_opportunities(user_id, status);
-- Database-level backstop for the core lifecycle invariant -- at most one
-- ACTIVE instance per family at any time -- independent of whether the
-- application's reconciliation logic ever has a bug. Superseded/inactive
-- rows are exempt (many may share a family_fingerprint over time; that is
-- exactly the point of family grouping).
create unique index if not exists ha_account_opportunities_one_active_per_family
  on public.ha_account_opportunities(user_id, family_fingerprint)
  where status = 'active';

ALTER TABLE public.ha_account_opportunities ENABLE ROW LEVEL SECURITY;
-- Same doctrine as ha_signals/ha_signal_events: every read/write goes
-- through a verified-Bearer-token server endpoint using the service-role
-- key, which bypasses RLS by design. RLS with zero policies here means the
-- anon/authenticated Postgres roles a browser-held key would use can see
-- or write NOTHING in this table (fail closed).

-- ---------------------------------------------------------------------
-- ha_signal_events extension: additive only. signal_id/event_fingerprint/
-- account_name/parent_event_id/client_event_id/schema_version keep their
-- exact V1A meaning and constraints, untouched. signal_* event types and
-- their semantics are UNCHANGED.
-- ---------------------------------------------------------------------
alter table public.ha_signal_events
  add column if not exists opportunity_id uuid references public.ha_account_opportunities(id) on delete set null;

alter table public.ha_signal_events drop constraint if exists ha_signal_events_event_type_check;
alter table public.ha_signal_events add constraint ha_signal_events_event_type_check check (event_type in (
  'prepare_call_opened',
  'signal_selected',
  'signal_useful',
  'signal_not_useful',
  'outreach_made',
  'approach_shared',
  'opportunity_selected',
  'opportunity_useful',
  'opportunity_not_useful',
  'opportunity_outreach_made',
  'opportunity_approach_shared',
  'outcome_reported'
));

-- Structural target-family integrity, deliberately scoped to what a
-- single-row CHECK constraint can safely express -- see the design
-- conversation's own correction on this point. This constraint enforces
-- EXCLUSIVITY (a signal_* event can never carry an opportunity_id; an
-- opportunity_* event can never carry a signal_id; prepare_call_opened
-- must target exactly one family; both approach event types require
-- parent_event_id), never REQUIREDNESS of signal_id/opportunity_id
-- specifically. signal_id and opportunity_id both use ON DELETE SET NULL
-- (append-only history must survive its source row later being removed)
-- -- a permanent "must stay non-null" CHECK would make that deletion
-- itself violate the constraint, corrupting historical evidence retention
-- the moment it fired. The API is responsible for requiring the
-- appropriate target to exist AT EVENT-CREATION time (api/signal-events.js
-- already 400s before any insert if the resolved target is missing); nothing
-- server-side or in the schema can undo that check retroactively, so an
-- inserted row's target is always real at the moment it's written even
-- though the schema itself never promises it will stay populated forever.
--
-- parent_event_id is treated differently on purpose: it self-references
-- THIS SAME append-only table, which nothing in this application's actual
-- code path ever deletes a row from (rows are only ever inserted, never
-- removed) -- unlike ha_signals/ha_account_opportunities rows, which a
-- real admin/account-deletion flow can plausibly remove. Requiring
-- parent_event_id to stay non-null for approach-type events is therefore
-- safe to enforce permanently.
alter table public.ha_signal_events add constraint ha_signal_events_target_family_check check (
  case
    when event_type = 'prepare_call_opened' then
      (signal_id is not null) <> (opportunity_id is not null)
    when event_type in ('signal_selected', 'signal_useful', 'signal_not_useful', 'outreach_made') then
      opportunity_id is null
    when event_type = 'approach_shared' then
      opportunity_id is null and parent_event_id is not null
    when event_type in ('opportunity_selected', 'opportunity_useful', 'opportunity_not_useful', 'opportunity_outreach_made') then
      signal_id is null
    when event_type = 'opportunity_approach_shared' then
      signal_id is null and parent_event_id is not null
    -- outcome_reported: reserved, shape not yet decided (api/signal-events.js
    -- rejects it before any insert, same as V1A) -- left unconstrained here
    -- rather than guessing a shape that isn't built yet.
    else true
  end
);
