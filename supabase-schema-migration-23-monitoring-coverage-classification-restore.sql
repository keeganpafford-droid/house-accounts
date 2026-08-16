-- Migration 23: restore coverage_classification persistence in
-- complete_ha_monitoring_attempt(), regressed by migration 20.
--
-- Root cause: migration 17 added the coverage_classification column and
-- extended complete_ha_monitoring_attempt() to persist p_coverage into it on
-- every insert. Migration 20 needed to add a new trailing parameter
-- (p_cooldown_hours) to the same function, which -- because Postgres
-- disallows inserting a new parameter ahead of existing defaulted ones --
-- required dropping the old 6-arg signature and re-creating the function
-- from scratch (see migration 20's own header comment). That rewrite copied
-- the pre-migration-17 version of the INSERT statement rather than the
-- coverage-persisting one, silently dropping coverage_classification from
-- both the column list and the VALUES list. The column, its CHECK
-- constraint, and every caller (api/queues/monitoring-consumer.js's
-- completeAttempt(), which has always passed p_coverage) were unaffected --
-- only the write itself stopped happening. Confirmed in Production: the
-- first two live Queue-managed attempts (Insurcomm Restoration Group, ICP
-- Group -- 2026-08-16) both persisted with coverage_classification null
-- despite verified 'complete' coverage in Vercel runtime logs.
--
-- Fix: create-or-replace the SAME 7-arg signature migration 20 introduced
-- (no signature change, so no drop-then-create is needed here -- unlike
-- migration 20's own predicament, this migration only restores a column in
-- the existing INSERT, it doesn't add or remove a parameter), restoring
-- coverage_classification to the column/VALUES lists exactly as migration
-- 17 defined it, while keeping every migration-20 behavior (p_cooldown_hours
-- parameter, its clamp, and the cooldown-column writes on both branches)
-- byte-for-byte unchanged. Migration 20's own file is left untouched --
-- this is a new, additive migration, not an edit to migration history.
--
-- Historical rows: deliberately NOT backfilled. Every attempt row inserted
-- while this regression was live (migration 20's deploy through this fix)
-- has its coverage_classification stuck at null with no durable, in-schema
-- record of which of 'complete'/'degraded_trustworthy' it actually was --
-- unlike migration 17's own one-row backfill, which had a specific,
-- independently-verified execution-log source for its single row, there is
-- no deterministic evidence here to backfill from at the database level.
-- Guessing would misclassify some rows with more confidence than the
-- evidence supports. Any row with a real classification, however (e.g. from
-- a matching Vercel runtime log a founder has independently verified,
-- such as the two Production rows referenced above), can be corrected later
-- via a separate, explicitly-scoped, evidence-cited update -- not by this
-- migration.

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
    target_id, outcome, coverage_classification, elapsed_ms, openai_calls, openai_input_tokens, openai_output_tokens,
    serper_queries, serper_failed_queries, firecrawl_requests, firecrawl_successes,
    estimated_cost_usd, cost_model_version, error
  ) values (
    p_target_id, v_outcome, p_coverage,
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
