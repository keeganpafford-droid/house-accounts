-- Migration 7: Phase 2A implementation-review ROUND 7 — mode-scoped,
-- fail-closed account writes + post-research account-identity lock.
--
-- =============================================================================
-- 1. WHAT THIS CLOSES
-- =============================================================================
-- Two related gaps in the untracked (non-research) account-write path that
-- api/save-upload.js has owned since round 6:
--
--   a) The "does this upload already have research history" and "is a
--      research run currently active" checks were plain application-code GET
--      requests, wrapped in `.catch(() => [])`. A network error, a timeout,
--      or any other failure of that lookup was silently interpreted as
--      "no rows found" -- i.e. fail OPEN, exactly the direction that must
--      never happen for an authorization/state gate. The checks also ran
--      BEFORE, and separately from, the actual write (a different HTTP
--      request to a different endpoint, replace_ha_accounts_snapshot()),
--      so nothing stopped a research run from being claimed in the gap
--      between the check and the write.
--
--   b) stage="accounts_updated" (round 6) had no concept of account
--      IDENTITY. A caller could add, remove, or rename accounts through it
--      exactly as freely as through stage="uploaded" -- but ha_signals
--      relates to an account by account_name (see migration 4 §4's own
--      note that a real account-identity model, with a stable key
--      independent of display name, is "out of scope" for that migration
--      and deferred to "a separate future change"). Renaming or removing an
--      account after research has produced signals for it silently orphans
--      those signals from the UI's perspective (they stay in ha_signals,
--      keyed to a name nothing now displays) or, on a rename collision,
--      lets a maintenance edit silently re-target signal history onto a
--      different account. This migration does not attempt the full
--      account-identity model migration 4 deferred -- it closes the
--      immediate gap by making accounts_updated metadata-only (no
--      add/remove/rename) whenever research history exists, at the RPC
--      layer, so the restriction cannot be bypassed by any caller that
--      skips application-code checks.
--
-- Both are fixed the same way: replace_ha_accounts_snapshot() now takes an
-- explicit, server-derived p_mode and performs BOTH the state check and the
-- write inside the SAME advisory-locked transaction, so there is no gap for
-- a concurrent claim to land in, and no failure mode that can be
-- misinterpreted as "check passed."
--
-- =============================================================================
-- 2. WHY A NEW MIGRATION FILE, NOT AN EDIT TO MIGRATION 4 OR 6
-- =============================================================================
-- Same rationale as every migration in this series: migrations 4-6 are
-- already-reviewed, already-delivered artifacts. Editing them in place would
-- silently change what a prior round's sign-off actually covers. This file
-- is purely additive: it DROPs and re-CREATEs replace_ha_accounts_snapshot()
-- under an EXPANDED signature (see §3 for why DROP is required, not just
-- CREATE OR REPLACE), and re-CREATEs persist_ha_research_output() under its
-- EXISTING signature (so CREATE OR REPLACE alone is sufficient there) purely
-- to update the one internal call site that must now pass the new
-- parameter. Nothing about migrations 4, 5, or 6's own tables, constraints,
-- or the rest of their function bodies changes.
--
-- =============================================================================
-- 3. WHY DROP + CREATE, NOT CREATE OR REPLACE, FOR replace_ha_accounts_snapshot
-- =============================================================================
-- Postgres identifies a function by name + parameter TYPE LIST, not by
-- parameter names or default values. The existing signature is
-- (uuid, uuid, jsonb, text, uuid) [p_upload_id, p_user_id, p_accounts,
-- p_research_run_id, p_attempt_id]. Inserting p_mode as a new REQUIRED
-- parameter changes the type list, so `create or replace function
-- replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, [new type here])`
-- would CREATE A SECOND, OVERLOADED function rather than replace the
-- original -- both would remain callable, and any caller (application code,
-- another RPC, a stale PostgREST schema cache entry) that still resolves to
-- the 5-arg overload would keep running with NO mode check at all. The old
-- signature is explicitly DROPped first so only the new, mode-aware version
-- can exist under this function name.
--
-- p_mode is placed as the 4th positional parameter (after p_accounts, before
-- p_research_run_id/p_attempt_id) and given NO default -- every caller must
-- pass it explicitly. This is deliberate: "do not trust a client-provided
-- arbitrary mode" (this round's explicit requirement) means the *value* of
-- p_mode must always come from server-derived, validated state (see
-- api/save-upload.js's MODE_FOR_STAGE below), never a raw client field --
-- but the RPC itself cannot enforce "who computed this string," only that
-- SOME value was passed and that value is one of the three legal modes. A
-- default would make it possible to call this function correctly by
-- accident (omitting p_mode and getting some implicit legacy behavior);
-- requiring it forces every call site to be an explicit, auditable decision.
--
-- =============================================================================
-- 4. THE THREE MODES
-- =============================================================================
-- 'initial_upload': the ONE stage="uploaded" case. Ownership is verified as
--   before. NEW: rejected (errcode HA003) if the target upload already has
--   ANY row in ha_research_runs -- "uploaded" is creation-only; a caller
--   editing an upload that has already been researched (even if that run
--   later completed, even if it's long since finished) must use
--   'accounts_maintenance' instead. This mirrors, and now backs with an
--   atomic guarantee, the check api/save-upload.js already performed in
--   application code as of round 6 -- moved here so it cannot be bypassed
--   and cannot fail open.
--
-- 'accounts_maintenance': the stage="accounts_updated" case. Ownership
--   verified. NEW: rejected (errcode 55P03, "an active run is in progress"
--   -- the SAME errcode already used elsewhere in this schema for that
--   condition) if a running, unexpired research attempt exists for this
--   upload. NEW: if the upload has ANY prior research history (regardless
--   of whether that history is a currently-active run -- already rejected
--   above -- or a completed one), the incoming account_name set is compared
--   against ha_accounts' current account_name set for this upload. Any
--   addition, removal, or rename (i.e. the two sets are not IDENTICAL) is
--   rejected with errcode HA004. Field-level changes (industry,
--   contact_name, contact_email, metrics, raw_data) for the SAME set of
--   account names are permitted and processed exactly as before (delete +
--   reinsert of the full snapshot, same account_name values). If the upload
--   has NO research history yet, accounts_maintenance behaves like an
--   unrestricted snapshot replace (add/remove/rename all permitted) --
--   there is no signal history yet for anything to orphan.
--
-- 'tracked_research': the persist_ha_research_output() internal call.
--   Behavior is UNCHANGED from the current p_research_run_id/p_attempt_id
--   attempt-check -- both parameters are still required together, and the
--   attempt must still be the current, active, 'running' attempt for this
--   upload. No identity lock applies here: research output can add
--   accounts (a newly-discovered account from a batch scan) by design.
--
-- For 'initial_upload' and 'accounts_maintenance', p_research_run_id and
-- p_attempt_id must both be null -- carrying either is rejected (errcode
-- 22023) exactly as attempting to mix untracked and tracked semantics
-- always has been in this schema.
--
-- =============================================================================
-- 5. WHY THE IDENTITY LOCK COMPARES SETS, NOT A ROW-BY-ROW DIFF
-- =============================================================================
-- The client (api/save-upload.js, and ultimately dashboard/index.html) always
-- sends the FULL current in-memory account list on every save, not a partial
-- patch -- this has been true since round 1. So "did the caller add, remove,
-- or rename an account" is fully answered by comparing the complete incoming
-- account_name set against the complete existing set: identical sets means
-- every account that existed still exists under the same name (some fields
-- may differ -- that's the permitted edit); a different set means something
-- was added, removed, or renamed, and this function cannot tell which
-- without a stable identity key it does not have (see migration 4 §4 and
-- §1b above -- that's the deferred, separate account-identity-model change).
-- Rejecting the whole write when the sets differ, rather than trying to
-- guess which names are "the same account renamed," is the safe conservative
-- choice for a phase that explicitly does not introduce that identity model.
--
-- =============================================================================
-- 6. ROLLBACK
-- =============================================================================
-- Restoring the exact prior (round 6) behavior requires re-creating the old
-- 5-arg replace_ha_accounts_snapshot() from migration 4's CREATE statement
-- (drop this 6-arg version first), and re-creating persist_ha_research_output()
-- from migration 6's CREATE statement (its own signature is unchanged here,
-- so this step alone reverts its internal call site). Application code
-- (api/save-upload.js) must be rolled back in the same change -- it now
-- always passes p_mode and no longer performs its own pre-flight state
-- checks, so it cannot run correctly against the old 5-arg function.
--
-- =============================================================================
-- 7. TESTS
-- =============================================================================
-- See scripts/phase2a-rpc-authorization-tests.sql (new tests appended, this
-- round) for direct RPC-level coverage: mode validation, ownership,
-- initial_upload history rejection, accounts_maintenance active-run
-- rejection, identity-lock rejection (add/remove/rename) and permitted
-- field-only edits, tracked_research behavior unchanged. See
-- scripts/test-account-maintenance-concurrency.sh for the two-session
-- concurrency test (claim vs. maintenance racing for the same advisory
-- lock key). Neither is executable in this session -- no live database
-- connection is available; both are meant to be run against a real
-- Postgres/Supabase instance separately, exactly like every other *.sql
-- test file in this repo.
-- =============================================================================

drop function if exists public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, uuid);

create or replace function public.replace_ha_accounts_snapshot(
  p_upload_id uuid,
  p_user_id uuid,
  p_accounts jsonb,
  p_mode text,
  p_research_run_id text default null,
  p_attempt_id uuid default null
) returns setof public.ha_accounts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_has_history boolean;
  v_active_running boolean;
  v_existing_names text[];
  v_incoming_names text[];
begin
  if p_mode is null or p_mode not in ('initial_upload', 'accounts_maintenance', 'tracked_research') then
    raise exception 'replace_ha_accounts_snapshot: p_mode must be one of initial_upload, accounts_maintenance, tracked_research (got %)', coalesce(p_mode, 'null')
      using errcode = '22023';
  end if;

  -- Serializes concurrent calls for the SAME upload_id only -- the SAME
  -- advisory lock key claim_ha_research_run() uses, which is exactly what
  -- makes the accounts_maintenance active-run check below race-free against
  -- a concurrent claim (see §4 and the two-session concurrency test).
  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));

  -- Ownership check: p_user_id is never trusted on its own.
  if not exists (
    select 1 from public.ha_uploads
    where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'replace_ha_accounts_snapshot: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  if p_mode = 'tracked_research' then
    if p_research_run_id is null or p_attempt_id is null then
      raise exception 'replace_ha_accounts_snapshot: p_research_run_id and p_attempt_id must both be provided together for p_mode=tracked_research'
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
  else
    if p_research_run_id is not null or p_attempt_id is not null then
      raise exception 'replace_ha_accounts_snapshot: p_research_run_id/p_attempt_id may only be supplied for p_mode=tracked_research'
        using errcode = '22023';
    end if;

    select exists(
      select 1 from public.ha_research_runs where upload_id = p_upload_id
    ) into v_has_history;

    if p_mode = 'initial_upload' then
      if v_has_history then
        raise exception 'replace_ha_accounts_snapshot: upload % already has research history; use p_mode=accounts_maintenance for a post-research account edit', p_upload_id
          using errcode = 'HA003';
      end if;
    else -- accounts_maintenance
      select exists(
        select 1 from public.ha_research_runs
        where upload_id = p_upload_id
          and status = 'running'
          and lease_expires_at > now()
      ) into v_active_running;

      if v_active_running then
        raise exception 'replace_ha_accounts_snapshot: a research run is currently active for upload %; cannot perform account maintenance while research is in progress', p_upload_id
          using errcode = '55P03';
      end if;

      -- Phase 2A implementation-review ROUND 7, item 4: once research
      -- history exists, accounts_maintenance is metadata-only. Compare the
      -- complete incoming account_name set against the complete existing
      -- set -- see §5 above for why a set comparison, not a row diff, is
      -- the right (and only available) check without a stable
      -- account-identity key.
      if v_has_history then
        if jsonb_typeof(p_accounts) is distinct from 'array' then
          raise exception 'replace_ha_accounts_snapshot: p_accounts must be a JSON array (got %)', coalesce(jsonb_typeof(p_accounts), 'null')
            using errcode = '22023';
        end if;

        select coalesce(array_agg(distinct account_name order by account_name), array[]::text[])
          into v_existing_names
          from public.ha_accounts
          where upload_id = p_upload_id;

        select coalesce(array_agg(distinct name order by name), array[]::text[])
          into v_incoming_names
          from (
            select nullif(btrim(elem->>'account_name'), '') as name
            from jsonb_array_elements(p_accounts) as elem
          ) t
          where name is not null;

        if v_existing_names is distinct from v_incoming_names then
          raise exception 'replace_ha_accounts_snapshot: accounts_maintenance cannot add, remove, or rename accounts once research history exists for upload % (existing names %, incoming names %)', p_upload_id, v_existing_names, v_incoming_names
            using errcode = 'HA004';
        end if;
      end if;
    end if;
  end if;

  -- Round 2: p_accounts must be a JSON array. Re-checked here for the modes
  -- that did not already check it above (tracked_research; initial_upload
  -- with no history yet; accounts_maintenance with no history yet) -- a
  -- plpgsql function body is one implicit transaction, so an unhandled
  -- exception anywhere in this function rolls back everything it has done
  -- so far, including the DELETE below -- malformed input fails atomically
  -- either way.
  if jsonb_typeof(p_accounts) is distinct from 'array' then
    raise exception 'replace_ha_accounts_snapshot: p_accounts must be a JSON array (got %)', coalesce(jsonb_typeof(p_accounts), 'null')
      using errcode = '22023';
  end if;

  delete from public.ha_accounts where upload_id = p_upload_id;

  -- Round 2: in-array duplicate account_name values are resolved
  -- deterministically (last occurrence wins, by array position) BEFORE the
  -- insert.
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
    -- user_id is ALWAYS the verified p_user_id -- no "user_id" field is
    -- ever read from the client-supplied JSON above.
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
end;
$$;

revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, text, uuid) from public;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, text, uuid) from anon;
revoke all on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, text, uuid) from authenticated;
grant execute on function public.replace_ha_accounts_snapshot(uuid, uuid, jsonb, text, text, uuid) to service_role;

-- =============================================================================
-- 8. persist_ha_research_output(): SAME SIGNATURE, ONE INTERNAL CALL SITE
--    UPDATED
-- =============================================================================
-- Re-issued verbatim from migration 6 except for the single
-- replace_ha_accounts_snapshot(...) call, which now passes
-- p_mode='tracked_research' explicitly (required, no default -- see §3).
-- Nothing else in this function's body, signature, grants, or the rest of
-- migration 6 changes.
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
    from public.replace_ha_accounts_snapshot(p_upload_id, p_user_id, p_accounts, 'tracked_research', p_research_run_id, p_attempt_id) a;
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

  update public.ha_research_runs
  set status = 'completed',
      completed_at = now(),
      result_summary = jsonb_build_object(
        'accountsPersisted', v_accounts_count,
        'signalsAttempted', v_signals_attempted,
        'signalsPersisted', v_signals_persisted,
        'signalsConflictIgnored', greatest(0, v_signals_attempted - v_signals_persisted)
      ),
      heartbeat_at = now(),
      lease_expires_at = now()
  where id = v_run.id
    and attempt_id = p_attempt_id
  returning * into v_run;

  if not found then
    raise exception 'persist_ha_research_output: finalization update for attempt % / run % matched no row -- the locking invariant this function depends on was violated', p_attempt_id, p_research_run_id
      using errcode = 'HA002';
  end if;

  return jsonb_build_object(
    'accountsPersisted', v_accounts_count,
    'signalsAttempted', v_signals_attempted,
    'signalsPersisted', v_signals_persisted,
    'signalsConflictIgnored', greatest(0, v_signals_attempted - v_signals_persisted),
    'status', v_run.status,
    'completedAt', v_run.completed_at,
    'attemptId', v_run.attempt_id
  );
end;
$$;

revoke all on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) from public;
revoke all on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) from anon;
revoke all on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) from authenticated;
grant execute on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) to service_role;
