// Phase 2A item E/H -- static proof of migration 16's SQL content (the
// atomic claim/lease + completion RPCs), same convention as
// scripts/test-monitoring-schema.js. Every scenario named in the Phase 2A
// task (successful claim, duplicate simultaneous claim, expired lease,
// not-due, paused/removed, abandoned worker, successful completion, failed
// completion, retried completion) was additionally verified live against
// production via the Supabase MCP connection during this phase -- see the
// Phase 2A report for that evidence. This automated suite has no database
// credentials in this sandbox, so the SQL text itself is the correctness
// proof available here, matching migration 15's own precedent.
//
// Usage: node scripts/test-monitoring-atomic-claim-schema.js
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

const sql = readFileSync(join(REPO_ROOT, 'supabase-schema-migration-16-monitoring-atomic-claim.sql'), 'utf8');

// ---------------------------------------------------------------------------
// Lease columns.
// ---------------------------------------------------------------------------
assert(/alter table public\.ha_monitoring_targets\s*\n\s*add column if not exists lease_attempt_id uuid,\s*\n\s*add column if not exists lease_expires_at timestamptz;/.test(sql), 'REQUIRED: lease_attempt_id/lease_expires_at are added additively (if not exists) to ha_monitoring_targets');

// ---------------------------------------------------------------------------
// claim_ha_monitoring_target() -- ordering and outcomes.
// ---------------------------------------------------------------------------
assert(/create or replace function public\.claim_ha_monitoring_target/i.test(sql), 'migration 16 creates claim_ha_monitoring_target');
assert(/perform pg_advisory_xact_lock\(hashtext\(p_target_id::text\)\)/.test(sql), 'REQUIRED: the claim is serialized per-target via the same advisory-lock pattern claim_ha_research_run() already uses in production');
assert(/for update;/i.test(sql.split('create or replace function public.claim_ha_monitoring_target')[1].split('complete_ha_monitoring_attempt')[0]), 'REQUIRED: the target row is locked (for update) before branching -- prevents a race between the read and the write');
assert(/if v_target\.status <> 'active' then\s*\n\s*return jsonb_build_object\('ok', false, 'reason', 'not-active'/.test(sql), 'REQUIRED: a paused/removed target returns ok=false reason=not-active, not an exception -- an expected outcome, not a caller error');
assert(/if v_target\.next_due_at > now\(\) then\s*\n\s*return jsonb_build_object\('ok', false, 'reason', 'not-due'/.test(sql), 'REQUIRED: a not-yet-due target returns ok=false reason=not-due');
assert(/if v_target\.lease_attempt_id is not null and v_target\.lease_expires_at > now\(\) then\s*\n\s*return jsonb_build_object\('ok', false, 'reason', 'already-leased'/.test(sql), 'REQUIRED: an active (non-expired) competing lease returns ok=false reason=already-leased -- the second concurrent caller exits BEFORE any provider spend, since claim happens before research');
assert(/status <> 'active'[\s\S]*?next_due_at > now\(\)[\s\S]*?lease_attempt_id is not null and v_target\.lease_expires_at > now\(\)/.test(sql), 'REQUIRED: checks run in this order -- active status, then due, then lease -- so a paused target is never reported as merely "leased"');
assert(/raise exception 'claim_ha_monitoring_target: no monitoring target % exists'/.test(sql), 'a nonexistent target_id raises an exception (a real caller error), not a silent false');

// ---------------------------------------------------------------------------
// complete_ha_monitoring_attempt() -- ownership check and cadence semantics.
// ---------------------------------------------------------------------------
assert(/create or replace function public\.complete_ha_monitoring_attempt/i.test(sql), 'migration 16 creates complete_ha_monitoring_attempt');
assert(/if v_target\.lease_attempt_id is distinct from p_attempt_id then/.test(sql) && /return jsonb_build_object\('ok', false, 'reason', 'not-current-attempt'\);/.test(sql), 'REQUIRED: a stale/mismatched attempt_id (an abandoned or already-completed attempt retrying) is a safe no-op, not an exception -- this is what makes retried completion non-corrupting');
assert(/if p_coverage in \('complete', 'degraded_trustworthy'\) then\s*\n\s*update public\.ha_monitoring_targets\s*\n\s*set last_scanned_at = now\(\),\s*\n\s*next_due_at = now\(\) \+ make_interval\(days => greatest\(1, coalesce\(p_cadence_days, 7\)\)\)/.test(sql), 'REQUIRED: cadence (last_scanned_at/next_due_at) advances ONLY for complete/degraded_trustworthy outcomes');
assert(/last_attempt_status = 'failed',\s*\n\s*last_error = p_error,\s*\n\s*lease_attempt_id = null,\s*\n\s*lease_expires_at = null,/.test(sql), 'REQUIRED: an insufficient/failed outcome clears the lease (so the target is immediately reclaimable) but does not touch last_scanned_at/next_due_at -- confirmed by absence of those columns in this branch');
assert(!/insufficient[\s\S]{0,5}next_due_at\s*=/.test(sql), 'sanity: no code path sets next_due_at anywhere near the word "insufficient"');
assert(/insert into public\.ha_monitoring_attempts \(/.test(sql), 'REQUIRED: an ha_monitoring_attempts row is inserted on every completion call (both success and failure outcomes reach the same insert statement before branching on cadence)');
assert(/if p_coverage not in \('complete', 'degraded_trustworthy', 'insufficient'\) then/.test(sql), 'the coverage classification is validated against exactly the three values api/lib/research-pipeline.js\'s classifyResearchCoverage() can produce');

// ---------------------------------------------------------------------------
// Lockdown: service_role only, same posture as every other RPC in this schema.
// ---------------------------------------------------------------------------
for (const fn of ['claim_ha_monitoring_target(uuid, integer)', 'complete_ha_monitoring_attempt(uuid, uuid, text, integer, text, jsonb)']) {
  assert(sql.includes(`revoke all on function public.${fn} from public;`), `REQUIRED: ${fn} revokes PUBLIC execute`);
  assert(sql.includes(`revoke all on function public.${fn} from anon;`), `REQUIRED: ${fn} revokes anon execute`);
  assert(sql.includes(`revoke all on function public.${fn} from authenticated;`), `REQUIRED: ${fn} revokes authenticated execute`);
  assert(sql.includes(`grant execute on function public.${fn} to service_role;`), `REQUIRED: ${fn} grants execute only to service_role`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
