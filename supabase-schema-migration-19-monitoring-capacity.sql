-- Migration 19: Phase 2D -- durable global capacity lease for Queue
-- monitoring research. Solves a DIFFERENT problem than migration 16's
-- claim_ha_monitoring_target()/complete_ha_monitoring_attempt(): that pair
-- prevents two workers from doing duplicate research on the SAME target;
-- this pair bounds TOTAL simultaneous provider work across ALL targets,
-- ALL Vercel monitoring-consumer instances, globally -- there is currently
-- no verified way to get that from @vercel/queue@0.4.0's push-mode
-- configuration surface (queue/v2beta's experimentalTriggers schema and
-- the full installed SDK type surface were both read in full; neither
-- exposes any concurrency-limiting option). This is deliberately the
-- smallest possible application-side substitute -- a single global pool of
-- N opaque-token leases, not a general distributed rate-limiter framework
-- -- kept narrow enough to delete outright if Vercel ever documents a real
-- native push-mode concurrency control (see api/lib/monitoring-capacity.js).
--
-- Design, same idioms migration 16 already established:
--   - one row per currently-held capacity slot, not N pre-seeded rows --
--     the actual cap (MONITORING_MAX_CONCURRENT_WORKERS) is an application
--     env var passed as p_max_workers on every call, never stored here, so
--     changing it requires no migration.
--   - lease_token IS the row's primary key -- the opaque ownership token
--     the caller holds is exactly what proves/lets it release its own row;
--     release is a plain `delete ... where lease_token = $1`, which can
--     structurally only ever match the ONE row with that exact token (or
--     zero rows for a wrong/stale token) -- no separate ownership check
--     needed.
--   - acquire is advisory-lock-serialized (same pg_advisory_xact_lock
--     technique as claim_ha_monitoring_target(), keyed on a fixed constant
--     since there is exactly one global pool, not one per target) so the
--     "reclaim expired, count, insert-if-under-cap" sequence is atomic
--     under concurrent callers.
--   - expired rows (a crashed worker's slot) are deleted as part of the
--     SAME acquire call that would otherwise be blocked by them, not a
--     separate cleanup job -- "expired capacity is reclaimable" falls out
--     of this for free, the same way claim_ha_monitoring_target() reclaims
--     an expired target lease.

create table if not exists public.ha_monitoring_capacity_leases (
  lease_token uuid primary key default gen_random_uuid(),
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Only for the (rare, operational) "how much capacity is in use right now"
-- query -- not on the hot acquire/release path, which always looks up by
-- primary key or does a full-table count over a pool this small (single
-- digits by design).
create index if not exists ha_monitoring_capacity_leases_expires_idx
  on public.ha_monitoring_capacity_leases (expires_at);

-- =============================================================================
-- acquire_monitoring_capacity() -- atomic acquire-or-reject.
-- =============================================================================
-- Required outcomes:
--   capacity available   -> ok=true, a fresh opaque lease_token + expires_at
--   capacity exhausted    -> ok=false, reason='capacity-exhausted', plus the
--                            active count/cap the caller asked against (for
--                            logging, never for a retry decision made here --
--                            this function makes no retry decision, the
--                            caller does)
create or replace function public.acquire_monitoring_capacity(
  p_max_workers integer,
  p_lease_seconds integer default 270
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_clamped_lease_seconds integer;
  v_clamped_max_workers integer;
  v_reclaimed_count integer;
  v_active_count integer;
  v_token uuid;
  v_expires_at timestamptz;
begin
  -- Same clamp convention as claim_ha_monitoring_target()'s lease clamp: a
  -- caller cannot obtain an arbitrarily long lease, and a misconfigured
  -- zero/negative max never silently means "unlimited."
  v_clamped_lease_seconds := greatest(60, least(coalesce(p_lease_seconds, 270), 900));
  v_clamped_max_workers := greatest(1, coalesce(p_max_workers, 1));

  -- Serializes ALL acquire attempts into one at a time -- there is exactly
  -- ONE global pool, so this lock is keyed on a fixed constant rather than
  -- a per-target hash. This is what makes "reclaim expired, count, decide,
  -- insert" atomic without a separate unique-index trick.
  perform pg_advisory_xact_lock(hashtext('ha_monitoring_capacity'));

  -- Reclaim: an expired lease is a crashed/killed worker's slot -- it is
  -- not "in use," so it is deleted as part of the same atomic decision a
  -- fresh acquire is making, exactly like claim_ha_monitoring_target()'s
  -- own expired-lease reclaim. The count is returned (not just silently
  -- dropped) so the caller can log a distinct "expired slot reclaimed"
  -- observability line -- see api/lib/monitoring-capacity.js.
  with reclaimed as (
    delete from public.ha_monitoring_capacity_leases where expires_at <= now() returning 1
  )
  select count(*) into v_reclaimed_count from reclaimed;

  select count(*) into v_active_count from public.ha_monitoring_capacity_leases;

  if v_active_count >= v_clamped_max_workers then
    return jsonb_build_object(
      'ok', false, 'reason', 'capacity-exhausted',
      'activeCount', v_active_count, 'maxWorkers', v_clamped_max_workers, 'reclaimedCount', v_reclaimed_count
    );
  end if;

  v_token := gen_random_uuid();
  v_expires_at := now() + make_interval(secs => v_clamped_lease_seconds);
  insert into public.ha_monitoring_capacity_leases (lease_token, expires_at)
    values (v_token, v_expires_at);

  return jsonb_build_object('ok', true, 'leaseToken', v_token, 'expiresAt', v_expires_at, 'activeCount', v_active_count + 1, 'maxWorkers', v_clamped_max_workers, 'reclaimedCount', v_reclaimed_count);
end;
$$;

revoke all on function public.acquire_monitoring_capacity(integer, integer) from public;
revoke all on function public.acquire_monitoring_capacity(integer, integer) from anon;
revoke all on function public.acquire_monitoring_capacity(integer, integer) from authenticated;
grant execute on function public.acquire_monitoring_capacity(integer, integer) to service_role;

-- =============================================================================
-- release_monitoring_capacity() -- ownership-checked release.
-- =============================================================================
-- Compare-and-swap by construction, not by a separate ownership column
-- check: lease_token IS the row's primary key, so `delete ... where
-- lease_token = p_lease_token` can only ever affect the exact row that
-- token names (or zero rows for a wrong/already-released/expired-and-
-- reclaimed token) -- never another worker's slot. A release for a token
-- that no longer exists (already released, or reclaimed after expiry) is
-- NOT an error -- it is a safe no-op, same posture as
-- complete_ha_monitoring_attempt()'s 'not-current-attempt' branch.
create or replace function public.release_monitoring_capacity(
  p_lease_token uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_deleted uuid;
begin
  perform pg_advisory_xact_lock(hashtext('ha_monitoring_capacity'));
  delete from public.ha_monitoring_capacity_leases
    where lease_token = p_lease_token
    returning lease_token into v_deleted;

  if v_deleted is null then
    return jsonb_build_object('ok', false, 'reason', 'not-current-lease');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.release_monitoring_capacity(uuid) from public;
revoke all on function public.release_monitoring_capacity(uuid) from anon;
revoke all on function public.release_monitoring_capacity(uuid) from authenticated;
grant execute on function public.release_monitoring_capacity(uuid) to service_role;

-- RLS: fail closed for anon/authenticated, unaffected for service_role --
-- same posture migration 15 established for every other monitoring table.
-- Every reader/writer of this table is the acquire/release RPCs above
-- (security invoker, called only via the service-role key) or an
-- operator's own ad hoc query; there is no browser-facing access path.
alter table public.ha_monitoring_capacity_leases enable row level security;
