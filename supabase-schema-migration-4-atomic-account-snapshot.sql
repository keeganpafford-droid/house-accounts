-- Migration 4: Phase 2A / A2 — atomic account-snapshot persistence + duplicate
-- defense for public.ha_accounts.
--
-- =============================================================================
-- 1. WHAT THIS CLOSES
-- =============================================================================
-- Confirmed forensic root cause (Phase 2A investigation): dashboard/index.html's
-- 4-worker concurrent research-fallback loop called saveCurrentUpload() once
-- per account, each doing a non-transactional DELETE then INSERT of the full
-- current ha_accounts snapshot for that upload. Two workers finishing close
-- together could both DELETE before either INSERTed, producing duplicate
-- account rows — the exact 60-row / 30-duplicate pattern observed in the
-- frozen Phase 1A/1B QA run. The application-side fix (dashboard/index.html,
-- same change set) removes the per-account save trigger and serializes
-- remaining callers client-side; this migration is the defense-in-depth
-- database-side fix.
--
-- =============================================================================
-- 2. DO NOT RUN YET — READ-ONLY AUDIT FIRST
-- =============================================================================
-- Before applying ANYTHING below, run scripts/phase2a-account-duplicate-audit.js
-- against the target database. It is entirely read-only and reports, without
-- deleting anything:
--   - exact-name duplicates: (upload_id, account_name) raw string matches —
--     what this migration's constraint targets and what the confirmed race
--     actually produced.
--   - normalized-name duplicates: same normalizeCompany() output but
--     different raw spelling (e.g. "ABC LLC" vs "ABC Inc") — reported for
--     visibility only; this migration does NOT touch these, see §4.
--   - a full simulation of exactly which rows step 3 below would move to the
--     audit table and delete (keep-earliest-per-exact-name-group), so you can
--     review the precise row list before running anything.
-- Do not proceed past this point until that audit has been reviewed.
--
-- =============================================================================
-- 3. DE-DUPLICATION BEFORE THE CONSTRAINT — AUDITED, NOT SILENT
-- =============================================================================
-- A plain UNIQUE constraint fails to create if duplicate rows already exist.
-- Earlier draft of this migration deleted duplicates directly; this version
-- instead copies every row it is about to remove into
-- ha_accounts_dedup_audit first, in the SAME transaction, so the deletion is
-- permanently reviewable (which row survived, which were removed, and when)
-- rather than a silent, unrecoverable DELETE. Keeps the earliest-created row
-- per exact (upload_id, account_name) pair.
--
-- =============================================================================
-- 4. WHY (upload_id, account_name) — THE NARROWEST CONSTRAINT THAT STOPS THE
--    CONFIRMED RACE, NOT A GENERAL ACCOUNT-IDENTITY MODEL
-- =============================================================================
-- The observed race produced EXACT duplicate account_name strings within the
-- same upload_id (both batches were literal re-submissions of the same
-- account list) — a raw-string constraint on exactly that pair is the
-- narrowest constraint that still fully closes the confirmed defect: nothing
-- narrower would still catch it, and anything broader (see below) would be
-- solving a different, larger problem this migration does not attempt.
--
-- A normalized-name constraint (folding "ABC LLC" / "ABC Inc" together) is
-- deliberately NOT added here. It would also block two genuinely distinct
-- real businesses that happen to normalize to the same string, is a policy
-- decision with real product tradeoffs, and was never implicated in the
-- confirmed race. The long-term recommendation, for a SEPARATE future
-- change, is an explicit upload-scoped account identity model distinguishing:
--   - raw account name (display, as uploaded)
--   - normalized account name (matching/dedup key)
--   - a stable source-row key (ties a persisted account back to its specific
--     row in the originating upload file, surviving re-uploads/edits)
--   - a generated account key (a real primary identity independent of any of
--     the above, so renaming a display name never breaks referential
--     integrity elsewhere)
-- That model is out of scope here; this migration only stops the confirmed
-- duplicate-insert race.
--
-- =============================================================================
-- 5. THE RPC FUNCTION — SECURITY MODEL
-- =============================================================================
-- SECURITY INVOKER, not DEFINER: this function is intended to be called ONLY
-- by server-side application code using the Supabase service_role key (the
-- same trust model every other write in this codebase already uses — there
-- are no RLS policies on ha_accounts/ha_uploads and no client ever calls
-- Supabase directly from the browser). service_role already bypasses RLS and
-- has full table access, so DEFINER's privilege-elevation semantics would add
-- risk (a search_path-hijack or logic bug inside the function could act with
-- elevated privilege on behalf of a lower-privileged caller) without adding
-- any capability this function actually needs. `set search_path = public` is
-- still pinned explicitly as defense in depth regardless of INVOKER/DEFINER.
--
-- EXECUTE is explicitly revoked from PUBLIC, anon, and authenticated and
-- granted only to service_role — Supabase grants EXECUTE on new public-schema
-- functions to PUBLIC by default, which would otherwise expose this function
-- directly via PostgREST's /rest/v1/rpc/ endpoint to any anon or
-- authenticated client. There is no RLS-safe design here that would justify
-- direct client access (no RLS policies exist on these tables at all), so
-- direct access is closed off entirely rather than attempted.
--
-- Ownership verification: p_user_id is never trusted as globally authoritative
-- on its own — the function explicitly verifies p_upload_id belongs to
-- p_user_id (via ha_uploads.user_id) before touching any row, and raises an
-- exception otherwise. In the current architecture this is defense in depth
-- (only service_role can call it, and api/save-upload.js already derives
-- user_id server-side from the authenticated ha_users record, never from
-- client input directly — see api/save-upload.js's getUserFromAuth()) rather
-- than the only thing standing between a malicious caller and another user's
-- data. It is what actually prevents a future application-code bug (e.g. a
-- refactor that accidentally passes the wrong user_id) from silently
-- replacing the wrong user's accounts.
--
-- =============================================================================
-- 6a. ROUND 2 REVISIONS TO THE RPC BODY (Phase 2A implementation-review round 2)
-- =============================================================================
-- This migration has never been applied to any database, so the RPC below is
-- revised in place rather than tracked as a separate later change:
--   - Explicit up-front validation that p_accounts is a JSON array (raises
--     errcode 22023 with a clear message on anything else — an object, a
--     scalar, null). jsonb_array_elements() would already raise on a
--     non-array value, but with a cryptic generic message; this makes the
--     failure explicit and gives it a distinct, checkable errcode. Either
--     way this is atomic: a plpgsql function body is one implicit
--     transaction, so an unhandled exception anywhere inside it — including
--     here, before the DELETE below runs — rolls back everything the
--     function has done so far. See scripts/phase2a-rpc-authorization-tests.sql
--     tests 7-8.
--   - Duplicate account_name values WITHIN one p_accounts array are now
--     resolved deterministically BEFORE the insert (last occurrence in the
--     array wins, via WITH ORDINALITY + DISTINCT ON), rather than relying on
--     ON CONFLICT DO UPDATE to handle it. This closes a genuine bug found
--     during round-2 review: ON CONFLICT DO UPDATE can only resolve a
--     conflict against a row that already existed before the statement
--     started — it cannot resolve two NEW rows in the SAME insert statement
--     conflicting with EACH OTHER, and raises "ON CONFLICT DO UPDATE command
--     cannot affect row a second time" if that happens. A p_accounts array
--     containing two entries with the same account_name would have hit
--     exactly that error under the round-1 version of this function. See
--     scripts/phase2a-rpc-authorization-tests.sql test 9.
--   - An empty p_accounts array ('[]'::jsonb) is explicit, tested behavior:
--     the DELETE still removes the upload's existing accounts, and the
--     INSERT inserts nothing (zero rows selected), so the net effect is that
--     the upload's account list is cleared to empty. This is the correct
--     reading of "replace the full snapshot with this exact list" including
--     the empty-list case. See test 11.
--   - user_id on every inserted row is always the verified p_user_id
--     parameter — no per-row "user_id" field is ever read from the client's
--     JSON — so a caller embedding a spoofed user_id inside an individual
--     account object cannot influence row ownership. See test 10.
--   - The rows returned by RETURNING * always carry exactly p_upload_id and
--     p_user_id (both are literal parameters in the SELECT list, not
--     per-row values), so the returned set structurally cannot include rows
--     belonging to any other upload or user. See test 12.
--
-- =============================================================================
-- 9. ROUND 3 REVISIONS: ATTEMPT VALIDATION AT PERSISTENCE, AND THE EXACT RACE
--    THIS CLOSES
-- =============================================================================
-- p_research_run_id/p_attempt_id (both nullable, both optional, both-or-
-- neither enforced) let a research-derived save (api/save-upload.js, stage
-- 'researched'/'research_updated') prove it is still being called by the
-- CURRENT active attempt for that run, atomically, in the SAME transaction
-- as the account replacement itself — not as a separate prior check that
-- could go stale before the write happens.
--
-- The exact race this closes, as specified in review:
--   1. Attempt A's lease expires (its Vercel invocation is still running —
--      just slow, or already dead — either way nobody renewed the lease in
--      time).
--   2. Attempt B calls claim_ha_research_run() and reclaims the run — this
--      call takes pg_advisory_xact_lock(hashtext(upload_id)), updates the
--      row's attempt_id to a NEW value, and commits.
--   3. Attempt A, unaware, finishes its (now-orphaned) research late.
--   4. Attempt A calls api/save-upload.js, which calls
--      replace_ha_accounts_snapshot(..., p_research_run_id, p_attempt_id)
--      with its OWN (stale) attempt_id.
--   5. This call ALSO takes pg_advisory_xact_lock(hashtext(upload_id)) — the
--      SAME lock key attempt B's reclaim used. If B's transaction is still
--      in flight, A's call blocks until B commits; either way, by the time
--      A's transaction actually evaluates the `exists (select 1 from
--      ha_research_runs where ... attempt_id = p_attempt_id and status =
--      'running')` check, it is reading the POST-reclaim state, where the
--      row's attempt_id is B's, not A's. The check fails, A's call raises
--      HA001, and — because this happens before the DELETE/INSERT below —
--      NOTHING is written. A is rejected and writes nothing, exactly as
--      required.
--
-- This is what "atomic run-check/persistence" means here specifically: it
-- is not merely that the check and the write are in the same function body
-- (that alone would still be vulnerable to a reclaim landing in the gap
-- between two DIFFERENT advisory-locked transactions) — it is that the
-- check and the write share the SAME advisory lock key as
-- claim_ha_research_run()'s reclaim path, so a concurrent reclaim and a
-- concurrent save-with-attempt-check for the same upload_id are fully
-- serialized against each other, in either order, with no gap for a stale
-- attempt to slip through.
--
-- api/save-upload.js ALSO calls heartbeat_ha_research_run() as a pre-flight
-- check before this RPC (before even the ha_uploads PATCH, which this RPC
-- does not cover) — see api/save-upload.js and migration 5 §7a. That
-- pre-flight check and this RPC's embedded check are deliberately
-- redundant: the pre-flight check protects the ha_uploads row and the later
-- ha_signals insert (neither of which goes through this RPC, so neither can
-- get the same same-transaction guarantee), while renewing the lease
-- (reducing the CHANCE of a takeover happening at all in the small window
-- before this RPC runs); this RPC's embedded check is what actually
-- GUARANTEES the account write itself cannot be stale, regardless of
-- whether that earlier pre-flight check remains valid for the whole
-- duration of the request. Lease renewal narrows the window; the shared
-- advisory lock is what closes it.
--
-- =============================================================================
-- 6. ROLLBACK
-- =============================================================================
-- drop function if exists public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid);
-- alter table public.ha_accounts drop constraint if exists ha_accounts_upload_account_name_key;
-- drop table if exists public.ha_accounts_dedup_audit;
-- Rolling back does not restore rows removed by §3 to ha_accounts itself, but
-- every removed row's full content is preserved in ha_accounts_dedup_audit
-- until that table is explicitly dropped — restore from there if needed,
-- rather than from a backup. Rolling back the RPC function alone means
-- api/save-upload.js must be rolled back to its pre-migration DELETE+INSERT
-- form in the same change, since it now calls this function unconditionally.

-- ===========================================================================
-- Step 1: preserve an audit trail of every row about to be removed.
-- ===========================================================================
create table if not exists public.ha_accounts_dedup_audit (
  id uuid primary key default gen_random_uuid(),
  removed_account_id uuid not null,
  kept_account_id uuid not null,
  upload_id uuid not null,
  account_name text not null,
  removed_row_snapshot jsonb not null,
  removed_at timestamptz not null default now()
);

with ranked as (
  select id, upload_id, account_name, user_id, industry, contact_name, contact_email,
    metrics, raw_data, created_at, updated_at,
    row_number() over (
      partition by upload_id, account_name
      order by created_at asc, id asc
    ) as rn,
    first_value(id) over (
      partition by upload_id, account_name
      order by created_at asc, id asc
    ) as kept_id
  from public.ha_accounts
)
insert into public.ha_accounts_dedup_audit (removed_account_id, kept_account_id, upload_id, account_name, removed_row_snapshot)
select id, kept_id, upload_id, account_name, to_jsonb(ranked.*)
from ranked
where rn > 1;

-- Step 2: remove exactly the rows just audited above (same predicate, so the
-- audit table and the deletion can never drift apart).
delete from public.ha_accounts
where id in (select removed_account_id from public.ha_accounts_dedup_audit);

-- Step 3: add the uniqueness guarantee (narrowest constraint that stops the
-- confirmed race — see §4 above).
alter table public.ha_accounts
  add constraint ha_accounts_upload_account_name_key unique (upload_id, account_name);

-- Step 4: atomic, serialized, ownership-checked snapshot-replace RPC.
create or replace function public.replace_ha_accounts_snapshot(
  p_upload_id uuid,
  p_user_id uuid,
  p_accounts jsonb,
  p_research_run_id text default null,
  p_attempt_id uuid default null
) returns setof public.ha_accounts
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Serializes concurrent calls for the SAME upload_id only; different
  -- upload_ids never block each other. Released automatically when this
  -- transaction commits or rolls back. This is the SAME advisory lock key
  -- claim_ha_research_run() uses (hashtext(upload_id)) — see §9 for why that
  -- sharing is what makes the attempt check below race-free against a
  -- concurrent reclaim, not merely "same transaction."
  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));

  -- Ownership check: p_user_id is never trusted on its own. See §5.
  if not exists (
    select 1 from public.ha_uploads
    where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'replace_ha_accounts_snapshot: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  -- Round 3 (implementation-review): when this save represents
  -- research-derived output, both p_research_run_id and p_attempt_id are
  -- supplied and this call, still inside the advisory lock acquired above,
  -- verifies the caller is still the CURRENT, active attempt for that run
  -- before touching a single row. See §9 for the full race analysis. The
  -- initial pre-research upload save (stage='uploaded') passes both
  -- parameters as null and skips this check entirely, exactly like
  -- api/save-upload.js's own current behavior before this round.
  if p_research_run_id is not null or p_attempt_id is not null then
    if p_research_run_id is null or p_attempt_id is null then
      raise exception 'replace_ha_accounts_snapshot: p_research_run_id and p_attempt_id must both be provided together, or both omitted'
        using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.ha_research_runs
      where user_id = p_user_id
        and upload_id = p_upload_id
        and research_run_id = p_research_run_id
        and attempt_id = p_attempt_id
        and status = 'running'
    ) then
      raise exception 'replace_ha_accounts_snapshot: attempt % for run % is no longer the active attempt for upload % (reclaimed, completed, or failed)', p_attempt_id, p_research_run_id, p_upload_id
        using errcode = 'HA001';
    end if;
  end if;

  -- Round 2: p_accounts must be a JSON array. See §6a. This check runs
  -- BEFORE the DELETE below, but even if it did not, a plpgsql function
  -- body is one implicit transaction, so an unhandled exception anywhere in
  -- this function rolls back everything it has done so far, including the
  -- DELETE — malformed input fails atomically either way.
  if jsonb_typeof(p_accounts) is distinct from 'array' then
    raise exception 'replace_ha_accounts_snapshot: p_accounts must be a JSON array (got %)', coalesce(jsonb_typeof(p_accounts), 'null')
      using errcode = '22023';
  end if;

  delete from public.ha_accounts where upload_id = p_upload_id;

  -- Round 2: in-array duplicate account_name values are resolved
  -- deterministically (last occurrence wins, by array position) BEFORE the
  -- insert. See §6a for why ON CONFLICT DO UPDATE alone cannot handle two
  -- new rows in the same statement conflicting with each other.
  return query
  with numbered as (
    select
      nullif(btrim(elem->>'account_name'), '') as account_name,
      nullif(btrim(elem->>'industry'), '') as industry,
      nullif(btrim(elem->>'contact_name'), '') as contact_name,
      lower(nullif(btrim(elem->>'contact_email'), '')) as contact_email,
      coalesce(elem->'metrics', '{}'::jsonb) as metrics,
      coalesce(elem->'raw_data', '{}'::jsonb) as raw_data,
      ord
    from jsonb_array_elements(p_accounts) with ordinality as t(elem, ord)
  ),
  deduped as (
    select distinct on (account_name)
      account_name, industry, contact_name, contact_email, metrics, raw_data
    from numbered
    where account_name is not null
    order by account_name, ord desc
  )
  insert into public.ha_accounts (
    -- user_id is ALWAYS the verified p_user_id — no "user_id" field is ever
    -- read from the client-supplied JSON above, so a spoofed per-row
    -- user_id in p_accounts cannot influence ownership. See §6a / test 10.
    user_id, upload_id, account_name, industry, contact_name, contact_email,
    metrics, raw_data, created_at, updated_at
  )
  select
    p_user_id, p_upload_id, account_name, industry, contact_name, contact_email,
    metrics, raw_data, now(), now()
  from deduped
  on conflict (upload_id, account_name) do update set
    industry = excluded.industry,
    contact_name = excluded.contact_name,
    contact_email = excluded.contact_email,
    metrics = excluded.metrics,
    raw_data = excluded.raw_data,
    updated_at = now()
  returning *;
  -- An empty p_accounts array is explicit, tested behavior: deduped produces
  -- zero rows, so nothing is inserted, and combined with the DELETE above
  -- the upload's account list is cleared to empty. See §6a / test 11.
end;
$$;

-- Step 5: lock down execution to service_role only (see §5). Supabase's
-- default grant to PUBLIC on new functions is revoked explicitly rather than
-- relied upon to already be absent.
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid) from public;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid) from anon;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid) from authenticated;
grant execute on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid) to service_role;
