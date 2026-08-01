-- Migration 6: Phase 2A implementation-review ROUND 4 — consolidated,
-- attempt-guarded persistence for research-derived writes.
--
-- =============================================================================
-- 1. WHAT THIS CLOSES
-- =============================================================================
-- Round 3 atomically guarded ONLY the ha_accounts write (via
-- replace_ha_accounts_snapshot's optional p_research_run_id/p_attempt_id
-- parameters). The ha_signals insert and the ha_uploads research-state
-- update (stage/summary) remained protected only by a PRE-FLIGHT heartbeat
-- check in api/save-upload.js -- a separate operation from the writes
-- themselves. That leaves a real (if narrow) gap: a takeover landing
-- between the pre-flight check and either of those two writes is not
-- caught, so a stale/replaced attempt could still insert ha_signals rows or
-- overwrite ha_uploads.summary. The round-3 review response described this
-- as an "acceptable bounded trade-off" -- this migration removes the need
-- for that description entirely by closing the gap for real, rather than
-- accepting it.
--
-- persist_ha_research_output() (§3) is ONE atomic transaction that
-- validates attempt ownership ONCE, holds the SAME upload-scoped advisory
-- lock claim_ha_research_run() and replace_ha_accounts_snapshot() use for
-- the ENTIRE transaction, and only then writes ha_accounts, ha_signals, and
-- ha_uploads' research-state fields -- all three, or none. A stale/replaced
-- attempt gets errcode HA001 and the transaction rolls back: zero rows
-- change in any of the three tables.
--
-- =============================================================================
-- 2. WHY THIS IS A NEW MIGRATION, NOT ANOTHER REVISION OF 4 OR 5
-- =============================================================================
-- Migrations 4 and 5 have each been revised in place multiple times because
-- neither has ever been applied to any database, and each revision so far
-- stayed within that migration's own original, single-table concern
-- (ha_accounts identity/replacement; ha_research_runs lifecycle/leasing).
-- This migration's concern -- one transaction spanning ha_accounts,
-- ha_signals, AND ha_uploads together -- is a genuinely new, broader
-- concern layered on top of both, not a correction to either one's own
-- scope. Migrations 4 and 5 are unchanged by this file.
--
-- =============================================================================
-- 3. persist_ha_research_output() — ONE ATOMIC RESEARCH-OUTPUT SAVE
-- =============================================================================
-- SECURITY INVOKER, pinned search_path, EXECUTE revoked from
-- public/anon/authenticated and granted only to service_role — identical
-- trust model to every other RPC in this schema.
--
-- Acquires pg_advisory_xact_lock(hashtext(p_upload_id::text)) — the exact
-- same key claim_ha_research_run() and replace_ha_accounts_snapshot() use —
-- and HOLDS it for the entire transaction (advisory xact locks release only
-- at transaction end). This is what makes a SINGLE up-front attempt check
-- sufficient for every write that follows: for the remainder of this
-- transaction, no concurrent claim_ha_research_run() call can reclaim this
-- run (it would block trying to acquire the same lock key and, once
-- unblocked after this transaction commits, would see this transaction's
-- own lease renewal, not a stale one) and no concurrent
-- replace_ha_accounts_snapshot() call for the same upload can interleave
-- either. There is no gap between "validated" and "wrote" for a takeover to
-- land in, because nothing else touching this upload's research state can
-- run concurrently with this transaction at all.
--
-- Attempt validation IS lease renewal, in one statement (item 1's "validate
-- ... status=running, current attempt_id matches, lease is still active, OR
-- renew it atomically as part of the operation" — this implementation
-- chooses to always renew as part of the same UPDATE that performs the
-- validation, which is strictly stronger than a read-only validate: if the
-- UPDATE's WHERE clause does not match, nothing is renewed and nothing
-- below runs; if it does match, the row is simultaneously proven current
-- AND its lease is extended, in one indivisible statement — a stale attempt
-- cannot "pass" this check by chance ordering, and a genuine current
-- attempt never has to make a second round trip to renew before persisting).
--
-- Accounts are persisted by DELEGATING to replace_ha_accounts_snapshot()
-- (unchanged, migration 4), called WITHOUT its own p_research_run_id/
-- p_attempt_id arguments -- that re-check is redundant here (this
-- function's own check, under the lock held for the whole transaction,
-- already proved the attempt is current, and nothing can invalidate that
-- before this transaction commits), not incorrect to omit. Postgres
-- advisory xact locks are reentrant within the same transaction: a second
-- pg_advisory_xact_lock() call for a key this transaction already holds
-- succeeds immediately rather than blocking or erroring, so the nested call
-- inside replace_ha_accounts_snapshot() is safe.
--
-- Signals are inserted directly (not delegated) with the same
-- ignore-duplicates conflict target api/save-upload.js already relied on
-- via PostgREST's on_conflict=user_id,event_fingerprint — expressed here as
-- ON CONFLICT (user_id, event_fingerprint) DO NOTHING. Attempted vs.
-- actually-inserted counts are tracked explicitly (attempted = input array
-- length after the event_fingerprint-not-null filter; persisted = rows
-- actually returned by the INSERT), matching the same "do not infer, count"
-- instrumentation principle established in migration 4 and
-- api/save-upload.js since Phase 2A round 1. NOTE: identical to the
-- pre-existing plain-REST insert this replaces, a conflict on the SEPARATE
-- ha_signals_hash unique constraint (signal_hash) is NOT suppressed by this
-- ON CONFLICT clause (which only targets user_id+event_fingerprint) and
-- would still raise a hard error -- this is a pre-existing characteristic
-- of the signal_hash/event_fingerprint dual-uniqueness design, not a
-- regression introduced here, and is out of scope for this review.
--
-- ha_uploads.stage/summary are updated last, still inside the same
-- transaction and lock, closing the gap the round-3 pre-flight-only check
-- left open for "research status, summaries, research completion
-- metadata."
--
-- p_accounts uses null to mean "do not touch ha_accounts for this call"
-- (distinct from '[]'::jsonb, which explicitly clears the upload's account
-- list — see migration 4 §6a). p_signals/p_upload_stage/p_upload_summary
-- follow the same null-means-skip convention.
create or replace function public.persist_ha_research_output(
  p_upload_id uuid,
  p_user_id uuid,
  p_research_run_id text,
  p_attempt_id uuid,
  p_accounts jsonb default null,
  p_signals jsonb default null,
  p_upload_stage text default null,
  p_upload_summary jsonb default null,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run public.ha_research_runs;
  v_accounts_result public.ha_accounts[];
  v_accounts_count int := 0;
  v_signals_attempted int := 0;
  v_signals_persisted int := 0;
begin
  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));

  if not exists (
    select 1 from public.ha_uploads where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'persist_ha_research_output: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  -- Attempt validation + atomic lease renewal in one statement. If this
  -- attempt is stale/replaced, NOTHING below this point runs.
  update public.ha_research_runs
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 300), 900)))
  where user_id = p_user_id
    and upload_id = p_upload_id
    and research_run_id = p_research_run_id
    and attempt_id = p_attempt_id
    and status = 'running'
  returning * into v_run;

  if not found then
    raise exception 'persist_ha_research_output: attempt % for run % is no longer the active attempt for upload % (reclaimed, completed, or failed)', p_attempt_id, p_research_run_id, p_upload_id
      using errcode = 'HA001';
  end if;

  if p_accounts is not null then
    select array_agg(a) into v_accounts_result
    from public.replace_ha_accounts_snapshot(p_upload_id, p_user_id, p_accounts) a;
    v_accounts_count := coalesce(array_length(v_accounts_result, 1), 0);
  end if;

  if p_signals is not null and jsonb_typeof(p_signals) = 'array' and jsonb_array_length(p_signals) > 0 then
    v_signals_attempted := (
      select count(*) from jsonb_array_elements(p_signals) s
      where nullif(s->>'event_fingerprint', '') is not null
    );
    with inserted as (
      insert into public.ha_signals (
        user_id, upload_id, account_name, signal_hash, event_fingerprint,
        signal_type, title, why_reach_out, confidence, source_url,
        source_domain, published_at, payload, first_seen_at, last_seen_at
      )
      select
        p_user_id,
        p_upload_id,
        nullif(btrim(s->>'account_name'), ''),
        s->>'signal_hash',
        s->>'event_fingerprint',
        nullif(s->>'signal_type', ''),
        nullif(s->>'title', ''),
        nullif(s->>'why_reach_out', ''),
        nullif(s->>'confidence', '')::numeric,
        nullif(s->>'source_url', ''),
        nullif(s->>'source_domain', ''),
        nullif(s->>'published_at', ''),
        coalesce(s->'payload', '{}'::jsonb),
        now(),
        now()
      from jsonb_array_elements(p_signals) as s
      where nullif(s->>'event_fingerprint', '') is not null
      on conflict (user_id, event_fingerprint) do nothing
      returning id
    )
    select count(*) into v_signals_persisted from inserted;
  end if;

  if p_upload_stage is not null or p_upload_summary is not null then
    update public.ha_uploads
    set stage = coalesce(p_upload_stage, stage),
        summary = coalesce(p_upload_summary, summary),
        updated_at = now()
    where id = p_upload_id;
  end if;

  return jsonb_build_object(
    'accountsPersisted', v_accounts_count,
    'signalsAttempted', v_signals_attempted,
    'signalsPersisted', v_signals_persisted,
    'signalsConflictIgnored', greatest(0, v_signals_attempted - v_signals_persisted),
    'leaseExpiresAt', v_run.lease_expires_at,
    'attemptId', v_run.attempt_id
  );
end;
$$;

revoke all on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) from public;
revoke all on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) from anon;
revoke all on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) from authenticated;
grant execute on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) to service_role;

-- =============================================================================
-- 4. THE EXACT RACE, RE-VERIFIED FOR THE THREE-TABLE CASE
-- =============================================================================
--   1. Attempt A's lease expires.
--   2. Attempt B calls claim_ha_research_run() — takes
--      pg_advisory_xact_lock(hashtext(upload_id)), reclaims (new
--      attempt_id), commits (lock released).
--   3. Attempt A finishes late and calls api/save-upload.js, which calls
--      persist_ha_research_output() with A's OWN (stale) attempt_id.
--   4. This call takes the SAME advisory lock key. If B's transaction from
--      step 2 were still open, A would block until it commits; either way,
--      by the time A's UPDATE ... WHERE ... attempt_id = p_attempt_id runs,
--      it is reading the POST-reclaim row, where attempt_id is B's.
--   5. The UPDATE matches zero rows. HA001 is raised. The transaction rolls
--      back. NONE of the accounts insert, the signals insert, or the
--      ha_uploads update ever ran — not just "were also rejected," they
--      structurally never executed, because they are lexically AFTER the
--      attempt check inside the same function body and PL/pgSQL does not
--      continue past a raised, uncaught exception.
--
-- =============================================================================
-- 5. ROLLBACK
-- =============================================================================
-- drop function if exists public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer);
-- api/save-upload.js must be rolled back to a version that does not call
-- persist_ha_research_output for research-output-stage saves in the same
-- change (it would otherwise fail every such save once this function is
-- gone). Rolling this back alone does not affect migrations 4 or 5.
