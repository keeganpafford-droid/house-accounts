-- Migration 13: fixes a real production bug in migration 12's
-- ha_account_opportunities.upload_id foreign key.
--
-- Root cause: migration 12 declared `upload_id uuid references
-- public.ha_uploads(id)` with NO explicit ON DELETE action, which
-- Postgres defaults to NO ACTION -- meaning DELETE FROM ha_uploads fails
-- outright with a foreign-key violation (23503) the instant any
-- ha_account_opportunities row still references that upload, which is the
-- normal, expected state for any customer list that has ever been saved
-- since V1B shipped. Every OTHER table that references ha_uploads(id)
-- (ha_accounts, ha_research_runs, ha_signals, ha_weekly_runs) already uses
-- ON DELETE CASCADE -- ha_account_opportunities was the one outlier,
-- accidentally left off the existing "deleting a list must actually
-- succeed" contract this schema otherwise upholds everywhere else.
--
-- Fix is ON DELETE SET NULL, not CASCADE, matching the OTHER historical-
-- evidence-preservation FKs already established in this schema
-- (signal_id/opportunity_id/parent_event_id on ha_signal_events,
-- superseded_by_id on this same table) -- never CASCADE, which would
-- destroy the row itself. upload_id here is informational only ("which
-- upload most recently confirmed this instance," refreshed on every
-- reconciliation pass -- see api/lib/account-opportunity-reconciliation.js)
-- and is NOT part of this table's identity (that's user_id + fingerprint,
-- see migration 12's own header comment); losing it costs nothing an
-- application query actually depends on, and the row -- and any
-- ha_signal_events feedback history that points at it -- survives
-- unaffected. The application-level cleanup this enables (transitioning a
-- deleted list's now-orphaned ACTIVE opportunities to 'inactive', scoped
-- precisely to avoid touching an account name still represented by a
-- different, still-live upload for the same user) lives in
-- api/monitoring-lists.js's deleteList(), not here.
alter table public.ha_account_opportunities
  drop constraint if exists ha_account_opportunities_upload_id_fkey;
alter table public.ha_account_opportunities
  add constraint ha_account_opportunities_upload_id_fkey
  foreign key (upload_id) references public.ha_uploads(id) on delete set null;
