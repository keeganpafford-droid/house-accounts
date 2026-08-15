// Phase 2D: Controlled Concurrency / Vendor Rate Safety -- the narrow
// application-side substitute for a Queue-native push-mode concurrency
// cap. @vercel/queue@0.4.0's full type surface and its own bundled
// vercel.json/experimentalTriggers documentation were both read in full;
// neither exposes any concurrency-limiting option for queue/v2beta push
// delivery. This module -- backed by migration 19's
// acquire_monitoring_capacity()/release_monitoring_capacity() RPCs -- is
// deliberately the smallest thing that bounds TOTAL simultaneous provider
// work across every monitoring-consumer instance globally, kept behind
// exactly two functions so it can be deleted outright if Vercel ever
// documents a real native control.
//
// This solves a DIFFERENT problem than claim_ha_monitoring_target()/
// complete_ha_monitoring_attempt() (migration 16): that pair prevents two
// workers from doing duplicate research on the SAME target. This pair
// bounds how much provider work can be happening AT ALL, across every
// target, at once. Neither is a substitute for the other -- see
// api/lib/monitoring-queue.js's processMonitoringJob() for how both are
// used together (capacity acquired BEFORE the target claim, so a worker
// never holds a real 300s target lease while blocked on scarce capacity).
//
// Dependency-injected supabase(path, options) fetch helper, matching this
// codebase's established pattern (api/lib/signal-persistence.js and every
// api/queues/*.js route keep their own local supabase() implementation) --
// this module has no hidden global Supabase client of its own, so it is
// fully testable with a mocked supabase function.
//
// Lease TTL default (270s): deliberately BETWEEN the worker's own platform
// maxDuration (180s, api/queues/monitoring-consumer.js's vercel.json
// entry) and the existing DB target lease (300s, migration 16). A
// healthily-running worker acquires capacity near the very start of
// processMonitoringJob() (before the target claim) and releases it in a
// `finally` covering the entire rest of the attempt -- so the maximum time
// capacity can legitimately be held during a NORMAL run is bounded by the
// same 180s platform ceiling that kills a hung worker outright. 270s
// leaves a deliberate ~90s buffer above that ceiling (never expires out
// from under a healthy worker) while recovering faster than the 300s
// target lease -- appropriate because a stuck capacity slot blocks EVERY
// other worker in the global pool from acquiring capacity at all, not just
// retries of one target, so faster reclaim matters more here than for the
// per-target lease.
export const DEFAULT_CAPACITY_LEASE_SECONDS = 270;

// Attempts to acquire one of MONITORING_MAX_CONCURRENT_WORKERS global
// capacity slots. Returns either:
//   { ok: true, leaseToken, expiresAt, activeCount, maxWorkers }
//   { ok: false, reason: 'capacity-exhausted', activeCount, maxWorkers }
// Never throws for the ordinary "no capacity right now" case -- that is
// expected backpressure, not an error (see the RPC's own header comment).
// A genuine Supabase/network failure still propagates as a rejected
// promise, same as every other RPC call in this codebase.
export async function acquireMonitoringCapacity({ maxWorkers, leaseSeconds = DEFAULT_CAPACITY_LEASE_SECONDS, supabase }) {
  const result = await supabase('rpc/acquire_monitoring_capacity', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ p_max_workers: maxWorkers, p_lease_seconds: leaseSeconds })
  });
  // Phase 2D item F: a distinct observability line whenever the RPC's own
  // atomic reclaim (see its header comment) actually found a crashed
  // worker's expired slot -- separate from the acquired/unavailable
  // outcome, since it can accompany either one.
  if (result.reclaimedCount > 0) {
    console.log('[monitoring-capacity.expired-slot-reclaimed]', JSON.stringify({ reclaimedCount: result.reclaimedCount }));
  }
  if (result.ok) {
    console.log('[monitoring-capacity.acquired]', JSON.stringify({
      maxWorkers: result.maxWorkers, activeCount: result.activeCount, leaseSeconds
    }));
  } else {
    console.log('[monitoring-capacity.unavailable]', JSON.stringify({
      maxWorkers: result.maxWorkers, activeCount: result.activeCount, reason: result.reason
    }));
  }
  return result;
}

// Releases a previously-acquired capacity slot. Idempotent/safe on a
// missing leaseToken (nothing was ever acquired -- a caller-side no-op,
// never calls the RPC) and on a token the RPC no longer recognizes
// (already released, or expired and reclaimed by another acquire) -- both
// resolve to { ok: false, reason: ... } rather than throwing, so a
// `finally` release is always safe to call unconditionally.
export async function releaseMonitoringCapacity({ leaseToken, supabase }) {
  if (!leaseToken) return { ok: false, reason: 'no-lease-held' };
  const result = await supabase('rpc/release_monitoring_capacity', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ p_lease_token: leaseToken })
  });
  console.log('[monitoring-capacity.released]', JSON.stringify({ ok: result.ok, reason: result.reason }));
  return result;
}
