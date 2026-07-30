-- Migration 2: Priority 0 — Eliminate Duplicate Stored Events.
-- Run this against the EXISTING production database (the one with live
-- ha_signals rows already in it). For a brand-new database, supabase-schema.sql
-- already includes the end state and this file is not needed.
--
-- Nothing in this file deletes or overwrites existing rows. No step here is
-- destructive; see ROLLBACK at the bottom.
--
-- =============================================================================
-- 1. WHY upload_id WAS REMOVED FROM THE UNIQUENESS BOUNDARY
-- =============================================================================
-- The constraint below is (user_id, event_fingerprint) — deliberately NOT
-- upload_id. House Accounts monitors companies, not uploads; upload_id is one
-- current intake mechanism among others. Concretely:
--   - A customer re-uploading their same list already mints a NEW upload_id
--     today (see api/save-upload.js) — scoping by upload_id would let the
--     exact bug this migration fixes reappear on every re-upload.
--   - Future intake sources (CRM sync, Commonsku, Salesforce, manual account
--     creation) would each need their own upload_id-shaped container, or
--     would need to be shoehorned into the existing one — either way,
--     the same company arriving via two intake paths would get two
--     independent scopes and two copies of the same event: the identical bug,
--     one layer up.
--   - event_fingerprint already begins with the same normalizeCompany(...)
--     used for entity matching elsewhere in the codebase, so scoping by
--     (user_id, event_fingerprint) is already company-level, not
--     upload-level, without needing a new stable company-identity
--     column/table today. upload_id remains on the row (unchanged) purely
--     for attribution/debugging — it is not part of the identity.
--
-- =============================================================================
-- 2. WHY user_id IS AN ACCEPTABLE NEAR-TERM BOUNDARY
-- =============================================================================
-- user_id is the only ownership column that actually exists on ha_signals
-- today, and every current read/write path (weekly-scan.js, save-upload.js,
-- get-dashboard.js, admin-dashboard.js) already scopes by it. It correctly
-- keeps two different customers' copies of the same real-world event
-- separate (event_fingerprint alone carries no owner information). It is a
-- narrower boundary than the ideal long-term one (see #3) but never produces
-- an incorrect merge — at worst it under-merges (two teammates in the same
-- org could each get their own copy of the same event), which is the
-- pre-existing status quo, not a regression introduced by this migration.
--
-- =============================================================================
-- 3. KNOWN FUTURE LIMITATION: organization_id
-- =============================================================================
-- The company-limit / entitlement logic in api/save-upload.js
-- (getUsageContext / orgUsers) already pools monitored companies across
-- every user in an organization, not per-user — a signal that the product's
-- real ownership unit may eventually be organization_id, not user_id. If two
-- teammates in the same org both monitor the same company, each could still
-- get their own copy of the same event under today's user_id scoping.
-- ha_signals has no organization_id column today, and adding one is a real
-- schema decision (not a one-column constraint edit) — intentionally left as
-- a deliberate follow-up, not bundled into this fix.

-- =============================================================================
-- 4. PRODUCTION ROLLOUT SEQUENCE (exact order — do not reorder)
-- =============================================================================
-- The application code in this same commit (api/weekly-scan.js,
-- api/save-upload.js) writes `event_fingerprint` on every insert and targets
-- `?on_conflict=user_id,event_fingerprint`. If that code reaches production
-- before the constraint below exists, Postgres/PostgREST rejects every
-- single insert (no matching unique constraint for the ON CONFLICT target),
-- which would 500 every weekly-scan run and every save-upload call. The
-- database migration MUST land first.
--
--   0. DEPLOY ORDER: run this migration's Step A + Step B against production
--      BEFORE deploying the new api/weekly-scan.js / api/save-upload.js code.
--      The reverse order breaks persistence entirely.
--   A. Add the nullable event_fingerprint column + its index (statement
--      below). Safe pre-deploy: the OLD application code doesn't reference
--      this column, so this is a no-op from the old code's perspective.
--   B. Add the unique constraint (statement below). Safe pre-deploy for the
--      same reason: Postgres never treats two NULLs as conflicting, and the
--      old code never writes event_fingerprint, so every existing/old-code
--      row stays NULL and none of them can violate this constraint.
--   [deploy the new application code now]
--   C. Verify one live upsert: trigger a single real write through the new
--      code path (e.g. `GET /api/weekly-scan?limit=1&dryRun=true` against
--      one real upload, or one manual save-upload call with a single
--      account/signal) and confirm in the DB that the resulting row has
--      event_fingerprint populated and the on_conflict path did not error.
--      Do this before backfilling, so any wiring problem is caught against a
--      single row, not the whole table.
--   D. Backfill existing rows: `node scripts/backfill-event-fingerprint.js`
--      (add --dry-run first to preview counts with no writes). Non-
--      destructive; only ever sets event_fingerprint where it is NULL.
--   E. Generate the duplicate report: `node scripts/find-duplicate-signals.js
--      --json` (optionally `--company=Avidia` first to confirm the reported
--      incident). Read-only.
--   F. Review cleanup candidates from step E with a human before touching any
--      row. No script in this fix deletes or merges rows automatically.
--   G. Only after D-F are complete and clean, consider (separately, not part
--      of this migration): `alter table ha_signals alter column
--      event_fingerprint set not null;`
--
-- =============================================================================
-- 5. ROLLBACK
-- =============================================================================
-- No step in this rollout deletes data, so rollback is low-risk at every
-- stage:
--   - If the new application code misbehaves after deploy (unexpected
--     errors, unexpected 409s, wrong fingerprints): revert the Vercel
--     deployment to the previous build. The constraint and column can be
--     left in place — the reverted old code never references
--     event_fingerprint or the on_conflict target, so it is unaffected by
--     their presence.
--   - If the constraint itself turns out to be wrong (e.g. false-positive
--     collisions incorrectly blocking legitimate distinct events):
--       alter table public.ha_signals drop constraint ha_signals_user_fingerprint_key;
--     This only removes the guard; it does not delete or alter any row.
--   - If the column is no longer wanted at all:
--       alter table public.ha_signals drop column event_fingerprint;
--     (Not expected to be necessary — included for completeness.)
--   - If the backfill (step D) wrote wrong values: it only ever changed the
--     event_fingerprint column, never title/payload/source_url/etc., so the
--     safe undo is `update ha_signals set event_fingerprint = null where ...`
--     for the affected rows, then re-run the backfill once the underlying
--     issue is fixed. No other column is ever touched by the backfill.
--   - Nothing in scripts/find-duplicate-signals.js or
--     scripts/check-duplicate-accounts.js writes anything — both are
--     read-only reports, so there is nothing to roll back from running them.

-- Step A: add the column. Nullable — existing rows start out NULL and are
-- populated by the backfill script.
alter table public.ha_signals
  add column if not exists event_fingerprint text;

create index if not exists idx_ha_signals_event_fingerprint
  on public.ha_signals(event_fingerprint);

-- Step B: add the composite uniqueness guard. Safe to run immediately/before
-- the new application code deploys — see rollout sequence above.
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

-- Steps C-G (verify one live upsert, backfill, report, review, NOT NULL) are
-- deliberately not SQL — see section 4 above for the exact commands.
