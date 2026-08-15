-- Migration 16: Phase 2A worker-readiness -- atomic monitoring-target
-- claim/lease + completion RPCs. Additive only: extends
-- ha_monitoring_targets with two lease columns and adds two RPCs. No
-- Vercel Queue, scheduler, or background worker calls these yet -- this is
-- database-side foundation only, following the exact pattern already
-- proven in production for ha_research_runs (migration 5's
-- claim_ha_research_run()/heartbeat_ha_research_run()): an advisory-lock-
-- serialized claim, a leased ownership marker with a clamped expiry, and a
-- compare-and-swap-style completion that only applies when the caller's
-- attempt_id still matches -- so a late/duplicate/abandoned-worker
-- completion is a safe no-op, not a corruption.
--
-- Database state is the final source of correctness here, not Vercel
-- Queue's own idempotency/retry guarantees (which are a public-beta
-- product and an additional safety layer, not the authority) -- see the
-- Phase 2A report for why this was verified as a deliberate design choice,
-- not an oversight.

alter table public.ha_monitoring_targets
  add column if not exists lease_attempt_id uuid,
  add column if not exists lease_expires_at timestamptz;

-- Index only for the (rare, operational) "find abandoned leases" query --
-- not on the hot claim path, which always looks up by primary key.
create index if not exists ha_monitoring_targets_lease_idx
  on public.ha_monitoring_targets (lease_expires_at)
  where lease_attempt_id is not null;

-- =============================================================================
-- claim_ha_monitoring_target() -- atomic claim.
-- =============================================================================
-- Required outcomes, verified against each named scenario:
--   successful claim                -> outcome='claimed', a fresh attempt_id
--   duplicate simultaneous claim    -> outcome='already-leased' (the SECOND
--                                       caller, serialized behind the
--                                       advisory lock, sees the first
--                                       caller's just-written non-expired
--                                       lease and exits here -- before any
--                                       Serper/Firecrawl/OpenAI call, since
--                                       the caller is expected to check
--                                       `ok` before doing any provider work)
--   expired lease                   -> outcome='reclaimed-after-expired-lease'
--                                       (a fresh attempt_id is minted; the
--                                       old attempt_id can never complete
--                                       this target again -- see the
--                                       completion RPC's ownership check)
--   target no longer due            -> ok=false, reason='not-due' (not an
--                                       exception -- an expected, ordinary
--                                       outcome of a scheduler racing a
--                                       just-completed scan)
--   paused target                   -> ok=false, reason='not-active'
--   removed target                  -> ok=false, reason='not-active'
--   target does not exist           -> raises 'HA010' (the caller passed a
--                                       stale/invalid target_id -- a real
--                                       caller error, not an expected
--                                       runtime outcome, matching this
--                                       schema's existing convention of
--                                       exceptions for ownership/existence
--                                       failures and jsonb reason codes for
--                                       expected non-claim outcomes)
create or replace function public.claim_ha_monitoring_target(
  p_target_id uuid,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_target public.ha_monitoring_targets;
  v_clamped_lease_seconds integer;
  v_attempt_id uuid;
begin
  -- Same clamp convention as heartbeat_ha_research_run() (migration 5,
  -- section 7a): a caller cannot obtain an arbitrarily long or zero/negative
  -- lease by passing an out-of-range value.
  v_clamped_lease_seconds := greatest(60, least(coalesce(p_lease_seconds, 300), 900));

  -- Serializes ALL claim attempts for this one target into one at a time --
  -- this is what makes the read-then-branch-then-write logic below atomic
  -- without a separate partial-unique-index trick, same technique
  -- claim_ha_research_run() uses keyed on upload_id.
  perform pg_advisory_xact_lock(hashtext(p_target_id::text));

  select * into v_target
  from public.ha_monitoring_targets
  where id = p_target_id
  for update;

  if not found then
    raise exception 'claim_ha_monitoring_target: no monitoring target % exists', p_target_id
      using errcode = 'HA010';
  end if;

  if v_target.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'not-active', 'status', v_target.status);
  end if;

  if v_target.next_due_at > now() then
    return jsonb_build_object('ok', false, 'reason', 'not-due', 'next_due_at', v_target.next_due_at);
  end if;

  if v_target.lease_attempt_id is not null and v_target.lease_expires_at > now() then
    return jsonb_build_object('ok', false, 'reason', 'already-leased', 'lease_expires_at', v_target.lease_expires_at);
  end if;

  v_attempt_id := gen_random_uuid();

  update public.ha_monitoring_targets
  set lease_attempt_id = v_attempt_id,
      lease_expires_at = now() + make_interval(secs => v_clamped_lease_seconds),
      last_attempt_at = now(),
      updated_at = now()
  where id = p_target_id;

  return jsonb_build_object(
    'ok', true,
    'outcome', case when v_target.lease_attempt_id is not null then 'reclaimed-after-expired-lease' else 'claimed' end,
    'attemptId', v_attempt_id,
    'leaseExpiresAt', now() + make_interval(secs => v_clamped_lease_seconds)
  );
end;
$$;

revoke all on function public.claim_ha_monitoring_target(uuid, integer) from public;
revoke all on function public.claim_ha_monitoring_target(uuid, integer) from anon;
revoke all on function public.claim_ha_monitoring_target(uuid, integer) from authenticated;
grant execute on function public.claim_ha_monitoring_target(uuid, integer) to service_role;

-- =============================================================================
-- complete_ha_monitoring_attempt() -- atomic, ownership-checked completion.
-- =============================================================================
-- Compare-and-swap style, same doctrine as heartbeat_ha_research_run(): the
-- caller must present the SAME attempt_id claim_ha_monitoring_target()
-- handed it. A mismatch (the lease already expired and was reclaimed by
-- another attempt, or this call is a stale retry arriving after the lease
-- naturally lapsed and was cleared) is NOT an exception -- it is an
-- expected, safe no-op: {"ok": false, "reason": "not-current-attempt"}.
-- This is what makes "retrying completion does not corrupt cadence/state"
-- true by construction: a duplicate completion call for an attempt that
-- already completed (or was superseded) can never advance next_due_at a
-- second time or overwrite a newer attempt's result.
--
-- p_coverage in ('complete','degraded_trustworthy'): cadence advances --
-- last_scanned_at = now(), next_due_at = now() + p_cadence_days, lease
-- cleared, last_attempt_status='success', last_error cleared.
-- p_coverage = 'insufficient': cadence does NOT advance -- last_scanned_at/
-- next_due_at are left untouched, lease cleared (so the target becomes
-- immediately reclaimable rather than stuck), last_attempt_status='failed',
-- last_error set from p_error.
--
-- p_telemetry is persisted into ha_monitoring_attempts verbatim (already-
-- shaped by the caller from runResearchPipeline()'s providerUsage return --
-- see api/lib/research-pipeline.js) regardless of outcome, so failed
-- attempts are not invisible to the cost/retry-overhead telemetry Phase 1
-- already established the table for.
create or replace function public.complete_ha_monitoring_attempt(
  p_target_id uuid,
  p_attempt_id uuid,
  p_coverage text,
  p_cadence_days integer default 7,
  p_error text default null,
  p_telemetry jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_target public.ha_monitoring_targets;
  v_outcome text;
begin
  if p_coverage not in ('complete', 'degraded_trustworthy', 'insufficient') then
    raise exception 'complete_ha_monitoring_attempt: unknown coverage classification %', p_coverage
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_target_id::text));

  select * into v_target
  from public.ha_monitoring_targets
  where id = p_target_id
  for update;

  if not found then
    raise exception 'complete_ha_monitoring_attempt: no monitoring target % exists', p_target_id
      using errcode = 'HA010';
  end if;

  if v_target.lease_attempt_id is distinct from p_attempt_id then
    -- Ownership/liveness mismatch: a newer attempt already reclaimed this
    -- target (or the lease was never this caller's), or a prior call
    -- already completed and cleared it. Never treated as an error -- see
    -- this function's own header comment.
    return jsonb_build_object('ok', false, 'reason', 'not-current-attempt');
  end if;

  v_outcome := case when p_coverage in ('complete', 'degraded_trustworthy') then 'success' else 'failed' end;

  insert into public.ha_monitoring_attempts (
    target_id, outcome, elapsed_ms, openai_calls, openai_input_tokens, openai_output_tokens,
    serper_queries, serper_failed_queries, firecrawl_requests, firecrawl_successes,
    estimated_cost_usd, cost_model_version, error
  ) values (
    p_target_id, v_outcome,
    nullif(p_telemetry->>'elapsedMs', '')::integer,
    coalesce((p_telemetry->>'openaiCalls')::integer, 0),
    coalesce((p_telemetry->>'openaiInputTokens')::integer, 0),
    coalesce((p_telemetry->>'openaiOutputTokens')::integer, 0),
    coalesce((p_telemetry->>'serperQueries')::integer, 0),
    coalesce((p_telemetry->>'serperFailedQueries')::integer, 0),
    coalesce((p_telemetry->>'firecrawlRequests')::integer, 0),
    coalesce((p_telemetry->>'firecrawlSuccesses')::integer, 0),
    nullif(p_telemetry->>'estimatedCostUsd', '')::numeric,
    nullif(p_telemetry->>'costModelVersion', ''),
    p_error
  );

  if p_coverage in ('complete', 'degraded_trustworthy') then
    update public.ha_monitoring_targets
    set last_scanned_at = now(),
        next_due_at = now() + make_interval(days => greatest(1, coalesce(p_cadence_days, 7))),
        last_attempt_status = 'success',
        last_error = null,
        lease_attempt_id = null,
        lease_expires_at = null,
        updated_at = now()
    where id = p_target_id;
  else
    update public.ha_monitoring_targets
    set last_attempt_status = 'failed',
        last_error = p_error,
        lease_attempt_id = null,
        lease_expires_at = null,
        updated_at = now()
    where id = p_target_id;
  end if;

  return jsonb_build_object('ok', true, 'outcome', v_outcome, 'coverage', p_coverage);
end;
$$;

revoke all on function public.complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb) from public;
revoke all on function public.complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb) from anon;
revoke all on function public.complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb) from authenticated;
grant execute on function public.complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb) to service_role;
