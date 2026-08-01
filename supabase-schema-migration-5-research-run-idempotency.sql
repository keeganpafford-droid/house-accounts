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
--                      claim/reclaim time. This endpoint does not currently
--                      implement an active mid-flight heartbeat refresh (a
--                      setInterval-style keepalive inside a serverless
--                      function is fragile and does not survive a hard kill
--                      anyway, so it would not add real protection); instead,
--                      lease_seconds is sized comfortably above this
--                      project's real maximum single-invocation duration
--                      (see the maxDuration commentary in
--                      api/research-batch.js — Fluid Compute, 300s project
--                      default), so the lease itself is the actual liveness
--                      bound.
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
-- drop function if exists public.claim_ha_research_run(uuid, uuid, text, integer);
-- drop table if exists public.ha_research_runs;
-- api/research-batch.js must be rolled back to a version without run
-- claiming in the same change, since it will otherwise fail every
-- uploadId-bound request once this table/function are gone.

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
  v_result public.ha_research_runs;
begin
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

    -- status = 'failed', or status = 'running' with an expired lease: reclaim.
    update public.ha_research_runs
    set status = 'running',
        attempt_id = gen_random_uuid(),
        attempt_count = v_existing.attempt_count + 1,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
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

  -- No row for this exact (user, upload, research_run_id) triple. Before
  -- creating one, make sure no DIFFERENT research_run_id is actively
  -- (non-expired) running for this upload.
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
    now() + make_interval(secs => p_lease_seconds), now(), now()
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
