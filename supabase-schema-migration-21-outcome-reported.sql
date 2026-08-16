-- Migration 21: Notification & Outcome Loop V1 -- outcome_reported goes
-- live. Migrations 11/12 already reserved the event_type value and
-- deliberately left it unconstrained in ha_signal_events_target_family_check
-- ("outcome_reported: reserved, shape not yet decided"); this migration
-- gives it a family-exclusivity + parent-required shape, now that the
-- shape IS decided.
--
-- Baseline correction: an earlier draft of this migration copied migration
-- 12's ORIGINAL prepare_call_opened case (strict XOR) instead of migration
-- 14's live fix for it -- applying that draft against production failed
-- immediately (23514, existing prepare_call_opened rows with BOTH
-- signal_id/opportunity_id null, the exact orphan-after-cascade case
-- migration 14 already fixed). This migration's baseline is migration 14's
-- CURRENT constraint, unchanged except for the new outcome_reported case
-- added below.
--
-- outcome_reported itself needs the SAME tolerance migration 14 already
-- established, for the identical reason: signal_id/opportunity_id both use
-- ON DELETE SET NULL (so historical events survive their source row being
-- deleted later), which means an outcome_reported row inherited from a
-- since-deleted parent can also end up with BOTH columns null. A strict XOR
-- here would eventually hit the exact same 23514 migration 14 already
-- diagnosed and fixed once, just for a newer event type -- so this uses
-- migration 14's "not both set" tolerance, not the stricter shape approach_
-- shared/opportunity_approach_shared use (those two are exempt because
-- their parent's own parent_event_id-derived identity, not their own
-- signal_id/opportunity_id, is what actually matters for their family
-- membership -- see their own cases below, unchanged).
--
-- parent_event_id is still required and NOT given this same tolerance: it
-- self-references THIS SAME append-only table, which nothing in this
-- application's code path ever deletes a row from (migration 12's own
-- comment on approach_shared/opportunity_approach_shared explains this
-- distinction in full) -- so outcome_reported's parent_event_id, unlike its
-- signal_id/opportunity_id, can safely stay a hard requirement forever.
--
-- No table/column changes -- api/signal-events.js (not this migration)
-- enforces payload.outcomeStatus's enum (no_response_yet/engaged/
-- progressed/went_nowhere) and validates the resolved parent's actual
-- event_type/ownership before any insert, exactly like every other
-- parent-derived event type already does. Deliberately NOT deduped/no-op'd
-- like signal_useful/signal_not_useful: multiple later outcome updates on
-- the same outreach are valid, real history, not a repeated opinion.
alter table public.ha_signal_events drop constraint if exists ha_signal_events_target_family_check;
alter table public.ha_signal_events add constraint ha_signal_events_target_family_check check (
  case
    when event_type = 'prepare_call_opened' then
      not (signal_id is not null and opportunity_id is not null)
    when event_type in ('signal_selected', 'signal_useful', 'signal_not_useful', 'outreach_made') then
      opportunity_id is null
    when event_type = 'approach_shared' then
      opportunity_id is null and parent_event_id is not null
    when event_type in ('opportunity_selected', 'opportunity_useful', 'opportunity_not_useful', 'opportunity_outreach_made') then
      signal_id is null
    when event_type = 'opportunity_approach_shared' then
      signal_id is null and parent_event_id is not null
    when event_type = 'outcome_reported' then
      not (signal_id is not null and opportunity_id is not null) and parent_event_id is not null
    else true
  end
);
