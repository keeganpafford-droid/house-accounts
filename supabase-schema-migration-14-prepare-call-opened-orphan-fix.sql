-- Migration 14: fixes a real production bug in migration 12's
-- ha_signal_events_target_family_check CHECK constraint for
-- prepare_call_opened events.
--
-- Root cause: the constraint required prepare_call_opened rows to have
-- EXACTLY ONE of signal_id/opportunity_id non-null, via strict XOR
--   (signal_id is not null) <> (opportunity_id is not null)
-- But signal_id and opportunity_id both use ON DELETE SET NULL
-- specifically so historical events survive their source row being
-- deleted later (migration 12's own header comment, and this same
-- constraint's own comment, both state this intent explicitly). The
-- moment a customer list's ha_signals row backing a prepare_call_opened
-- event is deleted -- an ordinary, expected part of deleting a customer
-- list that has ever actually been used -- signal_id is set to null by
-- that FK, and since opportunity_id was never set for a signal-family
-- event, the row now has BOTH columns null, which the strict XOR
-- rejected. Every other event-type branch in this constraint only
-- forbids the WRONG-family column from being set (e.g. opportunity_useful
-- requires signal_id is null, but never requires opportunity_id is not
-- null) -- deliberately tolerant of its own target later going null via
-- cascade. prepare_call_opened was the one outlier that also demanded a
-- target currently exist, which cannot survive its own documented ON
-- DELETE SET NULL doctrine.
--
-- Reproduced live (BEGIN; DELETE FROM ha_signals ...; ROLLBACK;) against
-- Supabase project zodtymrckbtbiomakupf: deleting a customer list whose
-- signals carry any real prepare_call_opened history (the ordinary case
-- for any account a rep has actually opened) raised
--   23514 new row for relation "ha_signal_events" violates check
--   constraint "ha_signal_events_target_family_check"
-- which PostgREST surfaces as a 400 on the very FIRST statement
-- deleteList() runs (DELETE FROM ha_signals) -- before the request ever
-- reaches ha_accounts or ha_uploads, and before migration 13's own fix
-- (the ha_account_opportunities.upload_id FK) ever gets a chance to
-- matter. This is why a single-account list with no signal-engagement
-- history (no prepare_call_opened rows) could delete cleanly while a
-- real, actually-used multi-account list could not -- exactly the
-- data-dependent split observed.
--
-- Fix: relax prepare_call_opened to forbid only the structurally invalid
-- state (both columns set -- an event can never target both families at
-- once), matching every other branch's own posture, instead of also
-- requiring at least one to stay set. Insert-time validity (a
-- prepare_call_opened row is created with exactly one target already
-- resolved) remains the API's responsibility (api/signal-events.js), same
-- as already documented in migration 12's own header comment for every
-- other event type here -- the schema was never meant to re-validate that
-- after the fact, and doing so for this one branch was the bug.
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
    else true
  end
);
