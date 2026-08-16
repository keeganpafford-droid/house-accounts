-- Migration 20: Notification & Outcome Loop V1 prerequisite -- durable
-- research-failure cooldown for ha_monitoring_targets. Solves a DIFFERENT
-- problem than migration 19's capacity lease: that pair bounds how much
-- provider work can happen simultaneously; this column bounds how OFTEN a
-- single chronically-failing target can be re-attempted, independent of
-- capacity. Needed specifically because the monitoring scheduler is moving
-- to a 5-minute cadence (*/5 * * * *) -- without this, a target whose
-- research keeps concluding 'insufficient' can be re-published by the
-- scheduler roughly once per hour, forever (bounded only by
-- MESSAGE_RETENTION_SECONDS' incidental effect on Vercel Queue's own
-- idempotency-key deduplication, which was never designed as a cost-safety
-- mechanism), each cycle burning up to POISON_DELIVERY_THRESHOLD real paid
-- attempts before poison-acking again. See api/monitoring-scheduler.js's
-- due-query for the other half of this fix.
--
-- Deliberately NOT next_due_at: next_due_at is cadence truth (when is this
-- ACCOUNT due for its next monitoring cycle) and must never be touched by a
-- failed attempt -- conflating "failed, retry sooner" with "successfully
-- monitored, due again in a week" would corrupt the one field the whole
-- claim/completion design already treats as authoritative. This is a
-- SEPARATE, narrower concept: "do not let the SCHEDULER re-publish this
-- specific target again until this time," nothing else reads or writes it.
--
-- Deliberately NOT consulted by claim_ha_monitoring_target() or the Queue
-- consumer's peekTarget(): an in-flight message's own Queue-level retries
-- (up to POISON_DELIVERY_THRESHOLD, governed entirely by Vercel Queue's own
-- redelivery/backoff) must continue exactly as before -- this column only
-- ever gates whether the SCHEDULER creates a NEW message in the first
-- place. capacity-unavailable never reaches this code path at all (that
-- branch returns before ever calling claimTarget/completeAttempt), so it
-- structurally can never set or be affected by this cooldown.

alter table public.ha_monitoring_targets
  add column if not exists research_retry_cooldown_until timestamptz;

-- Only for the scheduler's own due-query filter -- not on the hot
-- claim/complete path, which always looks up by primary key.
create index if not exists ha_monitoring_targets_cooldown_idx
  on public.ha_monitoring_targets (research_retry_cooldown_until)
  where research_retry_cooldown_until is not null;

-- complete_ha_monitoring_attempt() gains one new, defaulted, trailing
-- parameter (p_cooldown_hours). This CHANGES the function's signature
-- (6 params -> 7), so create-or-replace alone would leave the OLD 6-param
-- function in place as an ambiguous overload -- the old signature is
-- dropped explicitly first so exactly one function of this name exists
-- afterward. Existing callers (api/queues/monitoring-consumer.js's
-- completeAttempt() wrapper) need no changes: they never pass
-- p_cooldown_hours, so PostgREST resolves the single remaining function and
-- Postgres applies the default.
drop function if exists public.complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb);

create or replace function public.complete_ha_monitoring_attempt(
  p_target_id uuid,
  p_attempt_id uuid,
  p_coverage text,
  p_cadence_days integer default 7,
  p_error text default null,
  p_telemetry jsonb default '{}'::jsonb,
  p_cooldown_hours integer default 24
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_target public.ha_monitoring_targets;
  v_outcome text;
  v_clamped_cooldown_hours integer;
begin
  if p_coverage not in ('complete', 'degraded_trustworthy', 'insufficient') then
    raise exception 'complete_ha_monitoring_attempt: unknown coverage classification %', p_coverage
      using errcode = '22023';
  end if;

  -- Same bounded-clamp convention as every other tunable in this schema
  -- (lease seconds, capacity workers, etc.) -- a caller cannot request an
  -- effectively-permanent cooldown (capped at 7 days) or a zero/negative one
  -- that would defeat the whole point.
  v_clamped_cooldown_hours := greatest(1, least(coalesce(p_cooldown_hours, 24), 168));

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
        research_retry_cooldown_until = null,
        updated_at = now()
    where id = p_target_id;
  else
    update public.ha_monitoring_targets
    set last_attempt_status = 'failed',
        last_error = p_error,
        lease_attempt_id = null,
        lease_expires_at = null,
        research_retry_cooldown_until = now() + make_interval(hours => v_clamped_cooldown_hours),
        updated_at = now()
    where id = p_target_id;
  end if;

  return jsonb_build_object('ok', true, 'outcome', v_outcome, 'coverage', p_coverage);
end;
$$;

revoke all on function public.complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb, integer) from public;
revoke all on function public.complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb, integer) from anon;
revoke all on function public.complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb, integer) from authenticated;
grant execute on function public.complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb, integer) to service_role;
