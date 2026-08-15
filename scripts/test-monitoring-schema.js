// Phase 1 monitoring-architecture foundation -- static proof of migration
// 15's SQL content (table shape, constraints, RLS doctrine), plus a pure-JS
// mirror of the ha_email_log timestamp-semantics CHECK, exhaustively
// exercised. Same convention as scripts/test-migration-12-schema.js: this
// migration IS applied directly to production for Phase 1 (unlike
// migration 12 at the time that file was written), but this automated
// suite has no database credentials in this sandbox, so the SQL text
// itself is the correctness proof available here -- see the Phase 1 report
// for the live-database confirmation run separately via the Supabase MCP
// connection.
//
// Usage: node scripts/test-monitoring-schema.js
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

const sql = readFileSync(join(REPO_ROOT, 'supabase-schema-migration-15-monitoring-foundation.sql'), 'utf8');

// ---------------------------------------------------------------------
// ha_monitoring_targets shape.
// ---------------------------------------------------------------------
assert(/create table if not exists public\.ha_monitoring_targets/i.test(sql), 'migration 15 creates ha_monitoring_targets');
assert(/constraint ha_monitoring_targets_user_identity_unique unique \(user_id, normalized_company_name\)/i.test(sql), 'REQUIRED: (user_id, normalized_company_name) is the unique durable identity key');
assert(/status text not null default 'active' check \(status in \('active', 'paused', 'removed'\)\)/i.test(sql), 'REQUIRED: status is constrained to active/paused/removed');
assert(/next_due_at timestamptz not null/i.test(sql), 'next_due_at is required (no target exists without a due date)');
assert(/last_attempt_status text check \(last_attempt_status is null or last_attempt_status in \('success', 'failed'\)\)/i.test(sql), 'last_attempt_status is nullable but constrained when set');
assert(/current_upload_id uuid references public\.ha_uploads\(id\) on delete set null/i.test(sql), 'current_upload_id survives its upload being deleted rather than blocking the delete or leaving a dangling reference');
assert(/create index if not exists ha_monitoring_targets_due_idx\s*\n\s*on public\.ha_monitoring_targets \(next_due_at\)\s*\n\s*where status = 'active'/i.test(sql), 'REQUIRED: the due-scheduling index is scoped to active targets only, matching the future scheduler\'s access pattern');
assert(/ALTER TABLE public\.ha_monitoring_targets ENABLE ROW LEVEL SECURITY;/i.test(sql), 'REQUIRED: RLS is enabled on ha_monitoring_targets (fail closed for anon/authenticated)');
assert(!/create policy.*ha_monitoring_targets/i.test(sql), 'REQUIRED: no browser-facing policy is added -- every reader/writer is a service-role server endpoint');

// ---------------------------------------------------------------------
// ha_monitoring_attempts shape.
// ---------------------------------------------------------------------
assert(/create table if not exists public\.ha_monitoring_attempts/i.test(sql), 'migration 15 creates ha_monitoring_attempts');
assert(/target_id uuid not null references public\.ha_monitoring_targets\(id\) on delete cascade/i.test(sql), 'REQUIRED: attempts are deleted along with their target (no orphaned telemetry rows)');
assert(/outcome text not null check \(outcome in \('success', 'failed'\)\)/i.test(sql), 'REQUIRED: outcome is constrained to success/failed -- "zero signals found" must be modeled as a successful outcome by the caller, not a schema-level default');
assert(/estimated_cost_usd numeric\(8, 5\)/i.test(sql), 'estimated_cost_usd has fixed precision suitable for sub-cent per-attempt costs');
assert(/cost_model_version text/i.test(sql), 'REQUIRED: cost_model_version is present so historical estimates stay interpretable if provider pricing assumptions change');
assert(/ALTER TABLE public\.ha_monitoring_attempts ENABLE ROW LEVEL SECURITY;/i.test(sql), 'REQUIRED: RLS is enabled on ha_monitoring_attempts');

// ---------------------------------------------------------------------
// ha_email_log shape.
// ---------------------------------------------------------------------
assert(/create table if not exists public\.ha_email_log/i.test(sql), 'migration 15 creates ha_email_log');
assert(/status text not null check \(status in \('sent', 'skipped', 'failed'\)\)/i.test(sql), 'REQUIRED: status is constrained to sent/skipped/failed -- a missing RESEND_API_KEY must be recordable as "skipped", never silently absent');
assert(/attempted_at timestamptz not null default now\(\)/i.test(sql), 'REQUIRED: attempted_at is required and always populated on insert');
assert(/sent_at timestamptz,/i.test(sql), 'sent_at is nullable');
assert(/constraint ha_email_log_sent_at_requires_sent check \(sent_at is null or status = 'sent'\)/i.test(sql), 'REQUIRED: the database itself forbids sent_at being set unless status is \'sent\' -- not left to caller discipline');
assert(/ALTER TABLE public\.ha_email_log ENABLE ROW LEVEL SECURITY;/i.test(sql), 'REQUIRED: RLS is enabled on ha_email_log');

// ---------------------------------------------------------------------
// Pure-JS mirror of the ha_email_log_sent_at_requires_sent CHECK,
// exhaustively exercised across every (status, sent_at) combination --
// same convention as test-migration-12-schema.js's targetFamilyCheck().
// ---------------------------------------------------------------------
function sentAtRequiresSentCheck(sentAt, status) {
  return sentAt === null || status === 'sent';
}
const statuses = ['sent', 'skipped', 'failed'];
const sentAtValues = [null, '2026-08-15T12:00:00Z'];
for (const status of statuses) {
  for (const sentAt of sentAtValues) {
    const allowed = sentAtRequiresSentCheck(sentAt, status);
    const expected = sentAt === null || status === 'sent';
    assert(allowed === expected, `sentAtRequiresSentCheck(sentAt=${JSON.stringify(sentAt)}, status=${status}) === ${expected}`);
  }
}
assert(sentAtRequiresSentCheck(null, 'skipped') === true, 'REQUIRED: a skipped send with no sent_at is valid (the common missing-RESEND_API_KEY case)');
assert(sentAtRequiresSentCheck('2026-08-15T12:00:00Z', 'skipped') === false, 'REQUIRED: a skipped send can never carry a populated sent_at -- structurally impossible, not just a convention');
assert(sentAtRequiresSentCheck('2026-08-15T12:00:00Z', 'failed') === false, 'REQUIRED: a failed send can never carry a populated sent_at');
assert(sentAtRequiresSentCheck('2026-08-15T12:00:00Z', 'sent') === true, 'a sent email may carry a populated sent_at');
assert(sentAtRequiresSentCheck(null, 'sent') === true, 'a sent email is not required to carry sent_at (nullable either way) -- only the reverse is forbidden');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
