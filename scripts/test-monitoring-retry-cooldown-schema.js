// Notification & Outcome Loop V1 prerequisite -- static proof of migration
// 20's SQL content (the research-failure cooldown column + the updated
// complete_ha_monitoring_attempt() RPC), same convention as
// scripts/test-monitoring-atomic-claim-schema.js /
// test-monitoring-capacity-schema.js: this automated suite has no database
// credentials in this sandbox, so the SQL text itself is the correctness
// proof available here.
//
// Usage: node scripts/test-monitoring-retry-cooldown-schema.js
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

const sql = readFileSync(join(REPO_ROOT, 'supabase-schema-migration-20-monitoring-retry-cooldown.sql'), 'utf8');

// ---------------------------------------------------------------------------
// Column shape -- additive, nullable (no cooldown = never blocked).
// ---------------------------------------------------------------------------
assert(/alter table public\.ha_monitoring_targets\s*\n\s*add column if not exists research_retry_cooldown_until timestamptz;/.test(sql), 'REQUIRED: research_retry_cooldown_until is added additively (if not exists) to ha_monitoring_targets');

// ---------------------------------------------------------------------------
// Overload-ambiguity avoidance -- the old 6-param signature must be dropped
// before the 7-param version is created, or Postgres/PostgREST would carry
// two ambiguous overloads of the same function name.
// ---------------------------------------------------------------------------
assert(/drop function if exists public\.complete_ha_monitoring_attempt\(uuid, uuid, text, integer, text, jsonb\);/.test(sql), 'REQUIRED: the old 6-parameter complete_ha_monitoring_attempt signature is explicitly dropped before the 7-parameter version is created, so exactly one function of this name exists afterward');
assert(sql.indexOf('drop function if exists public.complete_ha_monitoring_attempt') < sql.indexOf('create or replace function public.complete_ha_monitoring_attempt'), 'REQUIRED: the drop runs strictly before the create, not after');

const fnBody = sql.split('create or replace function public.complete_ha_monitoring_attempt')[1];

// ---------------------------------------------------------------------------
// New parameter -- defaulted, so every existing caller (which never passes
// p_cooldown_hours) is unaffected; clamped to a bounded, sane range.
// ---------------------------------------------------------------------------
assert(/p_cooldown_hours integer default 24/.test(fnBody), 'REQUIRED: p_cooldown_hours defaults to 24 (the founder-specified cooldown), so no existing call site needs to change');
assert(/v_clamped_cooldown_hours := greatest\(1, least\(coalesce\(p_cooldown_hours, 24\), 168\)\);/.test(fnBody), 'REQUIRED: the cooldown is clamped to a bounded [1,168]-hour range -- a caller cannot request a zero/negative cooldown or an effectively-permanent one');

// ---------------------------------------------------------------------------
// insufficient branch: sets the cooldown, leaves next_due_at untouched.
// success branch: clears the cooldown, still advances next_due_at as before.
// ---------------------------------------------------------------------------
// fnBody also contains an earlier, unrelated "case when ... else 'failed'
// end" expression (the v_outcome assignment) -- locate the REAL update
// if/else/end-if block by its distinguishing marker first, so a naive
// split('else') doesn't pick up that earlier CASE expression's else instead.
const updateBlockStart = fnBody.indexOf("if p_coverage in ('complete', 'degraded_trustworthy') then\n    update public.ha_monitoring_targets");
const updateBlock = updateBlockStart >= 0 ? fnBody.slice(updateBlockStart) : '';
const successBranch = updateBlock.split('else')[0] || '';
const insufficientBranch = (updateBlock.split('else')[1] || '').split('end if;')[0];

assert(/research_retry_cooldown_until = now\(\) \+ make_interval\(hours => v_clamped_cooldown_hours\)/.test(insufficientBranch), 'REQUIRED: the insufficient/failure branch sets research_retry_cooldown_until to now() + the clamped cooldown');
assert(!/next_due_at/.test(insufficientBranch), 'REQUIRED: next_due_at is never touched by the insufficient branch -- cadence truth stays untouched, only the new cooldown column changes on failure');
assert(/research_retry_cooldown_until = null/.test(successBranch), 'REQUIRED: a successful completion (complete/degraded_trustworthy) clears any prior cooldown');
assert(/next_due_at = now\(\) \+ make_interval\(days => greatest\(1, coalesce\(p_cadence_days, 7\)\)\)/.test(successBranch), 'sanity: the pre-existing cadence-advance behavior on success is unchanged by this migration');

// ---------------------------------------------------------------------------
// Lockdown: service_role only, targeting the NEW 7-arg signature specifically.
// ---------------------------------------------------------------------------
const fn = 'complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb, integer)';
assert(sql.includes(`revoke all on function public.${fn} from public;`), `REQUIRED: ${fn} revokes PUBLIC execute`);
assert(sql.includes(`revoke all on function public.${fn} from anon;`), `REQUIRED: ${fn} revokes anon execute`);
assert(sql.includes(`revoke all on function public.${fn} from authenticated;`), `REQUIRED: ${fn} revokes authenticated execute`);
assert(sql.includes(`grant execute on function public.${fn} to service_role;`), `REQUIRED: ${fn} grants execute only to service_role`);

// ---------------------------------------------------------------------------
// Structural proof that capacity-unavailable can never touch this cooldown:
// grep the capacity module and the capacity-unavailable branch of
// processMonitoringJob for any reference to the new column/concept. This is
// true by construction (that branch returns before ever calling
// claimTarget/completeAttempt), pinned here as a real regression guard.
// ---------------------------------------------------------------------------
const capacitySource = readFileSync(join(REPO_ROOT, 'api', 'lib', 'monitoring-capacity.js'), 'utf8');
assert(!/cooldown/i.test(capacitySource), 'REQUIRED: api/lib/monitoring-capacity.js never references the research-failure cooldown -- capacity backpressure is a structurally separate concept');

const queueSource = readFileSync(join(REPO_ROOT, 'api', 'lib', 'monitoring-queue.js'), 'utf8');
const capacityUnavailableBranch = queueSource.split("reason: 'capacity-unavailable'")[0].split('const capacity = await acquireCapacity')[1] || '';
assert(!/cooldown/i.test(capacityUnavailableBranch), 'REQUIRED: the capacity-unavailable branch in processMonitoringJob() never references the cooldown -- it returns before ever reaching claimTarget/completeAttempt, so it structurally cannot set or be blocked by it');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
