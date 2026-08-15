-- Migration 17: Phase 2C prep -- persist the actual coverage classification
-- (classifyResearchCoverage()'s output, api/lib/research-pipeline.js) on
-- each ha_monitoring_attempts row, rather than only the collapsed
-- outcome='success'/'failed' the table already stores. complete_ha_monitoring_
-- attempt() (migration 16) already receives p_coverage as an argument and
-- validates it against the same three-value set -- this migration stops
-- discarding that value at persistence time. Deliberately NOT inferred
-- later from provider counters (firecrawl_requests vs firecrawl_successes):
-- the pipeline already knows the real answer at execution time, so this
-- column stores that answer directly, not a reconstruction of it.
--
-- Nullable by design: historical rows recorded before this column existed
-- (and any future row inserted by a caller that, for whatever reason,
-- doesn't have a classification) are not forced into a fabricated value.
-- The CHECK constraint still holds every row that DOES have a value to the
-- same three-value set p_coverage itself is already validated against.

alter table public.ha_monitoring_attempts
  add column if not exists coverage_classification text;

alter table public.ha_monitoring_attempts
  drop constraint if exists ha_monitoring_attempts_coverage_classification_check;

alter table public.ha_monitoring_attempts
  add constraint ha_monitoring_attempts_coverage_classification_check
  check (coverage_classification is null or coverage_classification in ('complete', 'degraded_trustworthy', 'insufficient'));

comment on column public.ha_monitoring_attempts.coverage_classification is
  'The exact classifyResearchCoverage() output for this attempt (complete/degraded_trustworthy/insufficient), persisted verbatim from p_coverage at completion time -- not reconstructed from provider counters. Null on rows recorded before migration 17.';

-- Extend complete_ha_monitoring_attempt() to persist p_coverage into the
-- new column. Signature unchanged (create or replace, not drop+create) --
-- no caller (api/queues/monitoring-consumer.js) needs any change, since it
-- already passes p_coverage on every call.
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

-- Backfill the one pre-migration-17 attempt (the first live Queue smoke
-- test, Sterling Devices / Keegan Test org) from its verified execution
-- evidence: serperConfigured (12 queries, 0 failed) and synthesis succeeded
-- (outcome='success', 2 candidates evaluated per the founder's own
-- observed Vercel runtime logs), firecrawl_requests(6) > firecrawl_successes(5)
-- -- which is exactly classifyResearchCoverage()'s degraded_trustworthy
-- condition (research-pipeline.js:122). Scoped to this one specific row by
-- id, not a blanket backfill.
update public.ha_monitoring_attempts
set coverage_classification = 'degraded_trustworthy'
where id = '3fea7fd6-4e68-444f-a220-50e7b59bdd61'
  and coverage_classification is null;
