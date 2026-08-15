// Phase 2D items 1-3 -- static proof of migration 19's SQL content (the
// global capacity-lease acquire/release RPCs), same convention as
// scripts/test-monitoring-atomic-claim-schema.js: this automated suite has
// no database credentials in this sandbox, so the SQL text itself is the
// correctness proof available here. The three scenarios these assertions
// pin (acquire-to-exhaustion rejecting a third simultaneous caller, expired
// capacity being reclaimable, and a wrong lease token being unable to
// release another worker's slot) were additionally verified LIVE against
// production via the Supabase MCP connection during this phase (acquire
// with maxWorkers=2 twice succeeded, a third call correctly returned
// ok=false/activeCount=2/maxWorkers=2, release succeeded and was a safe
// no-op when repeated with an already-released/unrecognized token, and
// reclaimedCount was confirmed nonzero after manually expiring a row) --
// see the Phase 2D report for that evidence.
//
// Usage: node scripts/test-monitoring-capacity-schema.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const sql = readFileSync(join(REPO_ROOT, 'supabase-schema-migration-19-monitoring-capacity.sql'), 'utf8');

// ---------------------------------------------------------------------------
// Table shape -- lease_token IS the ownership proof (no separate ownership
// column needed), one row per currently-held slot (not N pre-seeded rows).
// ---------------------------------------------------------------------------
assert(/create table if not exists public\.ha_monitoring_capacity_leases\s*\(\s*\n\s*lease_token uuid primary key default gen_random_uuid\(\),/.test(sql), 'REQUIRED: lease_token is the primary key with a server-generated default -- the opaque token IS the row identity');
assert(/expires_at timestamptz not null/.test(sql), 'every lease row carries a mandatory expiration');

// ---------------------------------------------------------------------------
// acquire_monitoring_capacity() -- item 1: a third simultaneous acquisition
// beyond p_max_workers cannot obtain capacity.
// ---------------------------------------------------------------------------
const acquireBody = sql.split('create or replace function public.acquire_monitoring_capacity')[1].split('create or replace function public.release_monitoring_capacity')[0];
assert(/perform pg_advisory_xact_lock\(hashtext\('ha_monitoring_capacity'\)\)/.test(acquireBody), 'REQUIRED: acquire is serialized via a single fixed-constant advisory lock -- there is exactly one global pool, so concurrent acquire attempts cannot both observe the same active_count and both succeed past the cap');
assert(/select count\(\*\) into v_active_count from public\.ha_monitoring_capacity_leases;/.test(acquireBody), 'the active count is read fresh, under the lock, before the capacity decision');
assert(/if v_active_count >= v_clamped_max_workers then\s*\n\s*return jsonb_build_object\(\s*\n\s*'ok', false, 'reason', 'capacity-exhausted',/.test(acquireBody), `REQUIRED (item 1): once active_count >= max_workers, acquire returns ok=false reason=capacity-exhausted -- a third caller against a 2-worker cap cannot obtain a slot`);
assert(/v_clamped_max_workers := greatest\(1, coalesce\(p_max_workers, 1\)\);/.test(acquireBody), 'REQUIRED: the configured cap itself cannot be silently coerced to 0/unlimited by a missing or non-positive p_max_workers');

// ---------------------------------------------------------------------------
// item 2: expired capacity is reclaimable -- deleted as part of the SAME
// atomic acquire call that would otherwise be blocked by it, before the
// active-count decision is made, so a crashed worker's slot does not
// permanently consume capacity.
// ---------------------------------------------------------------------------
assert(/with reclaimed as \(\s*\n\s*delete from public\.ha_monitoring_capacity_leases where expires_at <= now\(\) returning 1\s*\n\s*\)\s*\n\s*select count\(\*\) into v_reclaimed_count from reclaimed;/.test(acquireBody), 'REQUIRED (item 2): expired rows (expires_at <= now()) are deleted and counted BEFORE the active-count check below -- an expired slot is never counted against the cap');
assert(acquireBody.indexOf('delete from public.ha_monitoring_capacity_leases where expires_at') < acquireBody.indexOf('select count(*) into v_active_count'), 'REQUIRED: the reclaim delete runs strictly before the active-count read, so a just-expired slot is already gone by the time capacity is decided');
assert(/v_clamped_lease_seconds := greatest\(60, least\(coalesce\(p_lease_seconds, 270\), 900\)\);/.test(acquireBody), 'the lease TTL itself is clamped to a bounded [60,900]s range, same clamp convention as migration 16\'s target lease -- a slot cannot be leased forever by a misconfigured caller');

// ---------------------------------------------------------------------------
// release_monitoring_capacity() -- item 3: a wrong/stale lease token cannot
// release another worker's slot. Structural by construction: lease_token is
// the primary key, so `delete ... where lease_token = $1` can only ever
// affect the exact row that token names, never any other row.
// ---------------------------------------------------------------------------
const releaseBody = sql.split('create or replace function public.release_monitoring_capacity')[1].split('revoke all on function public.release_monitoring_capacity')[0];
assert(/delete from public\.ha_monitoring_capacity_leases\s*\n\s*where lease_token = p_lease_token\s*\n\s*returning lease_token into v_deleted;/.test(releaseBody), 'REQUIRED (item 3): release deletes by exact lease_token match only -- since lease_token is the primary key, an incorrect/unrecognized token structurally cannot match a different worker\'s row');
assert(/if v_deleted is null then\s*\n\s*return jsonb_build_object\('ok', false, 'reason', 'not-current-lease'\);/.test(releaseBody), 'REQUIRED: a release for a token that matched no row (wrong token, already released, or expired-and-reclaimed) is a safe ok=false no-op, never an exception and never a different row\'s deletion');
assert(/perform pg_advisory_xact_lock\(hashtext\('ha_monitoring_capacity'\)\)/.test(releaseBody), 'release is serialized under the same advisory lock as acquire, so a release and a concurrent acquire\'s reclaim-then-count sequence cannot interleave inconsistently');

// ---------------------------------------------------------------------------
// Lockdown: service_role only, same posture as every other RPC in this schema.
// ---------------------------------------------------------------------------
for (const fn of ['acquire_monitoring_capacity(integer, integer)', 'release_monitoring_capacity(uuid)']) {
  assert(sql.includes(`revoke all on function public.${fn} from public;`), `REQUIRED: ${fn} revokes PUBLIC execute`);
  assert(sql.includes(`revoke all on function public.${fn} from anon;`), `REQUIRED: ${fn} revokes anon execute`);
  assert(sql.includes(`revoke all on function public.${fn} from authenticated;`), `REQUIRED: ${fn} revokes authenticated execute`);
  assert(sql.includes(`grant execute on function public.${fn} to service_role;`), `REQUIRED: ${fn} grants execute only to service_role`);
}
assert(/alter table public\.ha_monitoring_capacity_leases enable row level security;/.test(sql), 'RLS is enabled on the lease table -- fail-closed for anon/authenticated, same as every other monitoring table');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
