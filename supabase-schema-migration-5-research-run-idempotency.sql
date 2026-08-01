-- Migration 5 (REVISED — Phase 2A implementation-review round 2): server-owned
-- logical research-run tracking for public.ha_research_runs, now with
-- atomic claim/lease/attempt semantics. This migration has never been
-- applied to any database — it is revised in place rather than superseded
-- by a migration 6, so there is exactly one historical version of this
-- table to reason about.
--
-- =============================================================================
-- 1. WHAT THIS CLOSES (original scope, still true)
-- =============================================================================
-- The Phase 2A saveQueue fix (dashboard/index.html) only serializes
-- saveCurrentUpload() calls within one JS execution context (one tab, one
-- page load). It does nothing to stop a second browser tab, or the same tab
-- after a reload, from independently launching its own research pass against
-- the SAME upload. This migration adds server-side tracking that makes "one
-- active logical research run per upload" an actual database guarantee.
--
-- =============================================================================
-- 2. WHAT ROUND 2 ADDS: STABLE AUTOMATIC-RUN IDENTITY + LEASE/ATTEMPT SAFETY
-- =============================================================================
-- Round 1's design let the CLIENT invent a random research_run_id per
-- researchTopAccounts() call. That does not stop a reload or a second tab
-- from starting a genuinely NEW run after the first one already completed —
-- nothing tied run identity to the upload itself, so "no run for THIS id yet"
-- always looked like a legitimate new run to claim.
--
-- Round 2 fixes this by making run identity for the automatic path entirely
-- SERVER-OWNED and DETERMINISTIC: the automatic post-upload research pass
-- always claims the fixed literal research_run_id 'auto', scoped uniquely by
-- (user_id, upload_id) via the existing unique constraint below. A reload, a
-- second tab, or a client sending an arbitrary different string for the
-- automatic path all resolve to the exact same row — client-supplied
-- identifiers are no longer read for identity on this path at all. A
-- genuinely new run after a completed run is only ever created when the
-- caller explicitly requests runIntent:'manual-rerun' (the "Research Top
-- Accounts" button click, an explicit authenticated user action), and even
-- then the SERVER mints the new identifier (a random manual-<uuid>-like
-- string), never the client. See api/research-batch.js's
-- claimResearchRunAtomic()/claim_ha_research_run() call site and
-- dashboard/index.html's researchTopAccounts().
--
-- Round 2 also adds lease/attempt-token semantics: a Vercel function
-- invocation can be killed (timeout, cold shutdown, crash) before its
-- try/catch/finally ever runs, which would otherwise leave a row stuck at
-- status='running' forever, permanently blocking that upload's "one active
-- run" slot. Every claim now carries:
--   - attempt_id:     identifies the CURRENT owning execution attempt.
--                      completion/failure is only accepted for the attempt_id
--                      that currently owns the row (see §5) — a late result
--                      from an attempt that was already reclaimed as stale
--                      cannot silently overwrite the replacement attempt's
--                      state.
--   - attempt_count:  incremented every time a row is reclaimed (after a
--                      failure or an expired lease), for observability.
--   - lease_expires_at: a bounded time budget for the current attempt. Once
--                      this passes with no completion/failure recorded, the
--                      row is treated as abandoned and may be reclaimed by a
--                      fresh claim, WITHOUT needing an explicit failure
--                      marking first — this is what actually recovers from a
--                      process that died mid-flight (see §5).
--   - heartbeat_at:   last time this attempt confirmed liveness. Set at
--                      claim/reclaim time, and actively refreshed mid-flight
--                      by heartbeat_ha_research_run() (§7a below), which
--                      api/research-batch.js calls on a periodic renewal loop
--                      for the duration of a long-running research pass. This
--                      is the real mechanism that keeps lease_expires_at from
--                      passing out from under a still-live attempt; the fixed
--                      per-claim lease_seconds (server-clamped to [60, 900],
--                      see §7/§7a) is only the fallback abandonment bound for
--                      an attempt that stops heartbeating (crash, hard kill,
--                      timeout) — not the sole liveness signal.
--
-- =============================================================================
-- 3. WHY A SECURITY-INVOKER RPC INSTEAD OF PLAIN INSERT/UPSERT VIA POSTGREST
-- =============================================================================
-- The claim decision requires reading the current state of up to two rows
-- (the exact (user,upload,research_run_id) triple, AND any other row for the
-- same upload_id that might still be actively leased) and then branching into
-- one of five different atomic actions (attach-to-active, return-cached-
-- completed, reclaim-after-failure, reclaim-after-expired-lease, or
-- claim-new) — with a hard guarantee that no two concurrent callers can both
-- believe they successfully claimed the SAME slot. A sequence of separate
-- PostgREST GET/POST/PATCH calls from application code cannot make this
-- atomic (a second caller could read state between this caller's read and
-- write). claim_ha_research_run() (§6) does the whole decision inside one
-- PL/pgSQL function body, serialized per upload_id by
-- pg_advisory_xact_lock(hashtext(upload_id)) — the exact same pattern
-- replace_ha_accounts_snapshot() already uses (see
-- supabase-schema-migration-4-atomic-account-snapshot.sql §5) — so "claim is
-- one atomic database operation" is a real guarantee, not just careful
-- application code.
--
-- =============================================================================
-- 4. WHY THE OLD PARTIAL UNIQUE INDEX IS REMOVED, NOT KEPT ALONGSIDE THE RPC
-- =============================================================================
-- The original version of this migration added
-- `create unique index ... on ha_research_runs(upload_id) where status =
-- 'running'` to enforce "at most one running row per upload" at the index
-- level. That index cannot account for lease expiry: index predicates must
-- be IMMUTABLE, and `lease_expires_at > now()` is not immutable, so the index
-- can only ever see the literal `status` column. That means a row stuck at
-- status='running' with an EXPIRED lease would still occupy the index's one
-- slot for that upload_id, and claim_ha_research_run()'s legitimate
-- reclaim-via-fresh-INSERT path (used when the claim targets a DIFFERENT
-- research_run_id than the stale row, e.g. a manual rerun while an old
-- automatic attempt is stuck) would incorrectly hit a unique-violation
-- against that stale row, even though the function's own application-level
-- check had already determined the stale row's lease was expired and
-- therefore not actually blocking.
--
-- This is safe to remove ONLY because, after this migration, ha_research_runs
-- is written EXCLUSIVELY through claim_ha_research_run() (INSERT/reclaim
-- UPDATE) and the attempt_id-guarded PATCH used by
-- completeResearchRunAttempt()/failResearchRunAttempt() in
-- api/research-batch.js (which only ever updates one already-existing row by
-- id + attempt_id — it never inserts, so it cannot by itself create a second
-- concurrently-running row for the same upload). EXECUTE on the RPC is
-- revoked from anon/authenticated (§7) and RLS with no policies (§8) blocks
-- any other write path, so the advisory-lock-serialized logic inside the
-- function is the actual, sufficient enforcement of "at most one active run
-- per upload" — it is simply correct in a way a static index predicate
-- cannot be.
--
-- =============================================================================
-- 5. LATE-RESULT SAFETY: WHY COMPLETION/FAILURE IS GUARDED BY attempt_id
-- =============================================================================
-- Scenario: attempt A claims 'auto' for upload U, its lease expires (the
-- Vercel invocation died mid-flight), a later request reclaims the SAME row
-- as attempt B (new attempt_id, attempt_count+1). If attempt A's original,
-- now-orphaned process eventually resumes and calls
-- completeResearchRunAttempt() with its OWN (stale) attemptId, that PATCH is
-- scoped `?upload_id=eq...&research_run_id=eq...&attempt_id=eq...` — since
-- the row's attempt_id column now holds B's id, not A's, zero rows match,
-- PostgREST returns an empty array, and the caller (api/research-batch.js)
-- reports `{applied:false}` — A's late result is silently discarded, and the
-- row's actual state (whatever B is doing / has done) is left untouched. See
-- scripts/test-research-run-idempotency.js's "old worker completes after
-- lease takeover" case.
--
-- =============================================================================
-- 6. ROLLBACK
-- =============================================================================
-- drop function if exists public.heartbeat_ha_research_run(uuid, uuid, text, uuid, integer);
-- drop function if exists public.claim_ha_research_run(uuid, uuid, text, integer);
-- drop table if exists public.ha_research_runs;
-- api/research-batch.js must be rolled back to a version without run
-- claiming/heartbeating in the same change, since it will otherwise fail
-- every uploadId-bound request once this table/function are gone.
-- api/save-upload.js must also be rolled back to a version that does not
-- call heartbeat_ha_research_run or pass p_research_run_id/p_attempt_id to
-- replace_ha_accounts_snapshot (see migration 4 §6a/§9).

create table if not exists public.ha_research_runs (
  id uuid primary key default gen_random_uuid(),
  research_run_id text not null,
  user_id uuid not null references public.ha_users(id) on delete cascade,
  upload_id uuid not null references public.ha_uploads(id) on delete cascade,
  status text not null default 'running',
  attempt_id uuid not null default gen_random_uuid(),
  attempt_count integer not null default 1,
  lease_expires_at timestamptz not null default (now() + interval '5 minutes'),
  heartbeat_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  result_summary jsonb default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  constraint ha_research_runs_user_upload_run_key unique (user_id, upload_id, research_run_id)
);

-- See §4 above — no partial "one running per upload" index. Uniqueness of
-- "at most one actively-leased running row per upload" is enforced inside
-- claim_ha_research_run() itself, which correctly accounts for lease expiry
-- in a way a static index predicate cannot.

-- =============================================================================
-- 7. claim_ha_research_run() — the atomic claim/attach/reclaim RPC
-- =============================================================================
-- SECURITY INVOKER, pinned search_path, same trust model as
-- replace_ha_accounts_snapshot() (migration 4 §5): only service_role calls
-- this (EXECUTE revoked from public/anon/authenticated below), and ownership
-- of p_upload_id is verified against p_user_id before anything else happens
-- — api/research-batch.js derives p_user_id from a verified Supabase auth
-- token (see resolveAuthenticatedUploadOwner()), never from client-supplied
-- lead/email values, so this check is defense in depth against a future
-- application-code bug, not the only thing standing between a caller and
-- another user's data.
--
-- Returns jsonb: {"outcome": "...", "run": {...ha_research_runs row...}}.
-- outcome is one of:
--   'claimed-new'                  — no prior row existed; a fresh row was
--                                     inserted with a new attempt_id.
--   'reclaimed-after-failure'      — the row existed with status='failed';
--                                     reclaimed with a new attempt_id.
--   'reclaimed-after-expired-lease'— the row existed with status='running'
--                                     but lease_expires_at had passed;
--                                     reclaimed with a new attempt_id.
--   'attached-active'              — the row exists, status='running', and
--                                     its lease is still valid. The caller
--                                     must NOT start a second execution; it
--                                     should treat this exactly like an
--                                     already-in-progress run.
--   'completed'                    — the row exists and is already
--                                     status='completed'. The caller must not
--                                     restart research; result_summary on
--                                     the returned row is the cached outcome.
-- Raises (via RAISE EXCEPTION ... USING ERRCODE):
--   42501 (insufficient_privilege, reused as "ownership" here to match
--          replace_ha_accounts_snapshot's convention) — p_upload_id does not
--          belong to p_user_id, or does not exist. Does not distinguish the
--          two, so this call does not leak whether an upload id exists.
--   55P03 (lock_not_available, reused here as "a different run is active")
--          — a DIFFERENT research_run_id is currently actively (non-expired)
--          running for this upload. Rejected, not joined: joining would
--          require merging two independent research executions' output.
--
-- EVALUATION ORDER (Phase 2A implementation-review ROUND 10 — a claim-
-- ordering defect, distinct from the round-9 lease-liveness fix): the checks
-- below run in this exact sequence, inside the SAME advisory-lock-held
-- transaction, and each step is a hard prerequisite for the next:
--   A. If p_research_run_id = 'auto': is there ALREADY a completed run
--      (auto or manual) for this upload? If so, return outcome='completed'
--      immediately — BEFORE this call ever looks at, let alone reclaims, its
--      own 'auto' row. Checking this first is what stops an expired or
--      failed 'auto' row from being reclaimed into a live second execution
--      after a manual rerun has already produced the upload's real result.
--   B. Load the exact (user_id, upload_id, research_run_id) row. completed
--      or actively-leased-running short-circuit as before. A failed or
--      expired-lease row is NOT reclaimed unconditionally: this function
--      first checks whether some OTHER research_run_id is actively
--      (non-expired) running for this same upload (excluding the exact row
--      itself by id) and raises 55P03 if so — an expired/failed row does
--      not by itself prove the upload's "one active run" slot is free; a
--      different run id may be legitimately holding it right now.
--   C. Only when no exact row exists at all does this function fall back to
--      the upload-wide "is anything else actively running" check before
--      inserting a brand-new row.
-- Prior to this round, the exact-row branch (B) reclaimed on failed/expired
-- status alone, with no check for a concurrently active different run, and
-- guard A ran only in branch C (i.e. only when no exact row existed) — so
-- an expired/failed exact row could be reclaimed straight past both an
-- actively-running different run id AND an already-completed different run,
-- producing two simultaneously active runs for one upload, or restarting
-- research a manual rerun had already finished. This round's fix is a
-- control-flow reordering only; no return value shape, errcode, or outcome
-- string changed.
create or replace function public.claim_ha_research_run(
  p_user_id uuid,
  p_upload_id uuid,
  p_research_run_id text,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing public.ha_research_runs;
  v_other_active public.ha_research_runs;
  v_other_completed public.ha_research_runs;
  v_result public.ha_research_runs;
  v_clamped_lease_seconds integer;
begin
  -- Same server-side clamp as heartbeat_ha_research_run() (§7a) — a client
  -- must not be able to obtain an arbitrarily long (or zero/negative) lease
  -- by passing an out-of-range or missing p_lease_seconds.
  v_clamped_lease_seconds := greatest(60, least(coalesce(p_lease_seconds, 300), 900));

  -- Serializes ALL claim attempts for this upload_id (regardless of which
  -- research_run_id they target) into one at a time. This is what makes the
  -- read-then-branch-then-write logic below atomic without needing a
  -- separate immutable index to encode the same invariant — see §3, §4.
  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));

  if not exists (
    select 1 from public.ha_uploads where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'claim_ha_research_run: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  -- A. AUTOMATIC COMPLETION GUARD, evaluated FIRST, before this call ever
  -- looks at its own exact row. Round 3 established that the automatic path
  -- ('auto' -- a reserved literal only the automatic path ever uses, see
  -- api/research-batch.js's claim branch) must not start again if ANY run
  -- for this upload has already completed successfully, regardless of
  -- whether that completed run's id was 'auto' or a server-minted
  -- 'manual-*' id. Round 10 fixes WHERE this check runs: previously it only
  -- ran in the "no exact row exists" branch (C below), so an automatic
  -- claim whose OWN 'auto' row existed but was failed/expired-lease skipped
  -- this check entirely and fell straight into reclaiming that row, even
  -- though a manual rerun had already completed. Checking it here, before
  -- the exact-row lookup, closes that gap. Only an explicit manual-rerun
  -- request (p_research_run_id <> 'auto') is exempt -- that IS the separate,
  -- explicitly authorized pathway the review requires.
  if p_research_run_id = 'auto' then
    select * into v_other_completed
    from public.ha_research_runs
    where upload_id = p_upload_id and status = 'completed'
    order by completed_at desc
    limit 1;
    if found then
      return jsonb_build_object('outcome', 'completed', 'run', to_jsonb(v_other_completed));
    end if;
  end if;

  -- B. EXACT-ROW HANDLING.
  select * into v_existing
  from public.ha_research_runs
  where user_id = p_user_id and upload_id = p_upload_id and research_run_id = p_research_run_id
  for update;

  if found then
    if v_existing.status = 'completed' then
      return jsonb_build_object('outcome', 'completed', 'run', to_jsonb(v_existing));
    end if;

    if v_existing.status = 'running' and v_existing.lease_expires_at > now() then
      return jsonb_build_object('outcome', 'attached-active', 'run', to_jsonb(v_existing));
    end if;

    -- status = 'failed', or status = 'running' with an expired lease: this
    -- row is a RECLAIM CANDIDATE, not an automatic reclaim. Round 10: a
    -- failed/expired exact row does not by itself prove the upload's "one
    -- active run" slot is free -- a DIFFERENT research_run_id could be
    -- actively (non-expired) running right now (e.g. an expired 'auto' row
    -- sitting alongside a live manual rerun). Check for that BEFORE
    -- reclaiming, excluding the exact row itself by id so it never conflicts
    -- with its own (expired/failed) state.
    select * into v_other_active
    from public.ha_research_runs
    where upload_id = p_upload_id and status = 'running' and lease_expires_at > now()
      and id <> v_existing.id
    limit 1;

    if found then
      raise exception 'claim_ha_research_run: a different research run (%) is already in progress for upload %', v_other_active.research_run_id, p_upload_id
        using errcode = '55P03';
    end if;

    update public.ha_research_runs
    set status = 'running',
        attempt_id = gen_random_uuid(),
        attempt_count = v_existing.attempt_count + 1,
        lease_expires_at = now() + make_interval(secs => v_clamped_lease_seconds),
        heartbeat_at = now(),
        started_at = now(),
        completed_at = null,
        error_message = null
    where id = v_existing.id
    returning * into v_result;

    return jsonb_build_object(
      'outcome', case when v_existing.status = 'failed' then 'reclaimed-after-failure' else 'reclaimed-after-expired-lease' end,
      'run', to_jsonb(v_result)
    );
  end if;

  -- C. NO EXACT ROW: make sure no DIFFERENT research_run_id is actively
  -- (non-expired) running for this upload before creating a new one. (Guard
  -- A above already ruled out an already-completed run for the automatic
  -- path; this is the separate "is something else running right now" check,
  -- which applies to both the automatic and manual-rerun paths.)
  select * into v_other_active
  from public.ha_research_runs
  where upload_id = p_upload_id and status = 'running' and lease_expires_at > now()
  limit 1;

  if found then
    raise exception 'claim_ha_research_run: a different research run (%) is already in progress for upload %', v_other_active.research_run_id, p_upload_id
      using errcode = '55P03';
  end if;

  insert into public.ha_research_runs (
    research_run_id, user_id, upload_id, status, attempt_id, attempt_count,
    lease_expires_at, heartbeat_at, started_at
  ) values (
    p_research_run_id, p_user_id, p_upload_id, 'running', gen_random_uuid(), 1,
    now() + make_interval(secs => v_clamped_lease_seconds), now(), now()
  )
  returning * into v_result;

  return jsonb_build_object('outcome', 'claimed-new', 'run', to_jsonb(v_result));
end;
$$;

revoke all on function public.claim_ha_research_run(uuid, uuid, text, integer) from public;
revoke all on function public.claim_ha_research_run(uuid, uuid, text, integer) from anon;
revoke all on function public.claim_ha_research_run(uuid, uuid, text, integer) from authenticated;
grant execute on function public.claim_ha_research_run(uuid, uuid, text, integer) to service_role;

-- =============================================================================
-- 7a. heartbeat_ha_research_run() — atomic lease renewal / attempt
--     verification (Phase 2A implementation-review ROUND 3)
-- =============================================================================
-- The real Phase 1B fallback execution ran ~12 minutes; a fixed 300s lease
-- (§7) would expire mid-run without renewal. This RPC does ONE atomic
-- compare-and-swap UPDATE: it succeeds only when the row's status is still
-- 'running', its attempt_id still matches the caller's, AND its OWN lease
-- has not already expired -- exactly the ownership-AND-liveness check a
-- stale/replaced/abandoned attempt must fail. attempt_id matching alone is
-- not sufficient: an attempt whose lease lapsed before ANYONE reclaimed it
-- (nobody has called claim_ha_research_run() yet, so attempt_id on the row
-- is still this caller's own) must not be able to resurrect itself by
-- heartbeating past its own deadline -- only claim_ha_research_run()'s
-- reclaim path may do that, and reclaiming always mints a NEW attempt_id
-- (see §7's reclaim branch). It is deliberately NOT a "read current state,
-- then decide, then write" sequence (the review explicitly asked this NOT
-- be implemented that way): the single UPDATE's WHERE clause IS the check,
-- and Postgres's row-level locking makes it correct under any interleaving
-- with a concurrent reclaim inside claim_ha_research_run() -- see §7b for
-- why this does not need the same advisory lock claim_ha_research_run()
-- uses.
--
-- Lease duration is ALWAYS clamped server-side to [60, 900] seconds,
-- regardless of what p_lease_seconds the caller requests -- a client cannot
-- obtain an arbitrarily long (effectively permanent) lease by requesting an
-- excessive value. api/research-batch.js additionally clamps in JS before
-- ever constructing this call, but this function is the authoritative,
-- final clamp (defense in depth, same pattern as every other value this
-- schema treats as untrusted client input).
--
-- Returns jsonb: {"ok": true, "run": {...}} on success, or
-- {"ok": false, "reason": "not-current-attempt"} (NOT an exception) when the
-- row does not match -- a stale attempt's heartbeat is an expected,
-- ordinary outcome, not an error condition. Still raises 42501 for a
-- genuine ownership mismatch on p_upload_id/p_user_id, matching every other
-- RPC in this schema.
create or replace function public.heartbeat_ha_research_run(
  p_user_id uuid,
  p_upload_id uuid,
  p_research_run_id text,
  p_attempt_id uuid,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_clamped_lease_seconds integer;
  v_row public.ha_research_runs;
begin
  v_clamped_lease_seconds := greatest(60, least(coalesce(p_lease_seconds, 300), 900));

  if not exists (
    select 1 from public.ha_uploads where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'heartbeat_ha_research_run: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  update public.ha_research_runs
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => v_clamped_lease_seconds)
  where user_id = p_user_id
    and upload_id = p_upload_id
    and research_run_id = p_research_run_id
    and attempt_id = p_attempt_id
    and status = 'running'
    and lease_expires_at > now()
  returning * into v_row;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-current-attempt');
  end if;

  return jsonb_build_object('ok', true, 'run', to_jsonb(v_row));
end;
$$;
revoke all on function public.heartbeat_ha_research_run(uuid, uuid, text, uuid, integer) from public;
revoke all on function public.heartbeat_ha_research_run(uuid, uuid, text, uuid, integer) from anon;
revoke all on function public.heartbeat_ha_research_run(uuid, uuid, text, uuid, integer) from authenticated;
grant execute on function public.heartbeat_ha_research_run(uuid, uuid, text, uuid, integer) to service_role;

-- =============================================================================
-- 7b. WHY heartbeat_ha_research_run() DOES NOT TAKE THE ADVISORY LOCK
-- =============================================================================
-- claim_ha_research_run() takes pg_advisory_xact_lock(hashtext(upload_id))
-- because its decision spans MULTIPLE rows and branches (the exact-triple
-- row, plus a scan for any OTHER actively-running or completed row for the
-- same upload) that must be evaluated as one consistent snapshot. Taking
-- that same lock on every heartbeat call (expected every 30-60s per active
-- run, per api/research-batch.js) would serialize heartbeats against
-- reclaims/claims for no benefit: heartbeat's UPDATE touches exactly ONE
-- row, identified by a fully-specified WHERE clause (attempt_id AND
-- status='running'), so Postgres's ordinary row-level locking already makes
-- it correct under any interleaving -- if a reclaim (inside
-- claim_ha_research_run(), holding the advisory lock) is concurrently
-- updating the SAME row, this UPDATE blocks on the row lock until that
-- transaction commits, then re-evaluates its WHERE clause against the
-- POST-reclaim state (a new attempt_id) and correctly finds zero matching
-- rows. Skipping the advisory lock here is a deliberate performance choice
-- for a frequently-called operation, not a correctness gap.
--
-- =============================================================================
-- 8. TABLE-LEVEL PROTECTION FOR THE REMAINING WRITE PATH (attempt-id-guarded
--    completion/failure PATCH — see §5)
-- =============================================================================
-- completeResearchRunAttempt()/failResearchRunAttempt() in
-- api/research-batch.js issue a plain PostgREST PATCH (not through an RPC),
-- scoped to one row by id + attempt_id. This is safe from anon/authenticated
-- for the same reason every other table in this schema is: RLS is enabled
-- with zero policies, which denies all access to anon/authenticated by
-- default, while service_role (used exclusively by this backend code)
-- bypasses RLS entirely.
alter table public.ha_research_runs enable row level security;
