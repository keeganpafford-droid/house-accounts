// Notification & Outcome Loop V1 step 3 -- static proof of migration 22's
// SQL content (notification_preference + ha_notification_deliveries), same
// convention as scripts/test-monitoring-capacity-schema.js /
// test-monitoring-retry-cooldown-schema.js: this automated suite has no
// database credentials in this sandbox, so the SQL text itself is the
// correctness proof available here.
//
// Usage: node scripts/test-notification-preferences-schema.js
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

const sql = readFileSync(join(REPO_ROOT, 'supabase-schema-migration-22-notification-preferences.sql'), 'utf8');

// ---------------------------------------------------------------------------
// notification_preference -- additive, defaults to weekly, fixed vocabulary.
// ---------------------------------------------------------------------------
assert(/alter table public\.ha_users\s*\n\s*add column if not exists notification_preference text not null default 'weekly'/.test(sql), 'REQUIRED: notification_preference is added additively (if not exists), defaulting to \'weekly\' so every existing Beta user is unaffected without a separate backfill');
assert(/check \(notification_preference in \('daily', 'weekly', 'in_app_only'\)\)/.test(sql), 'REQUIRED: notification_preference is constrained to exactly the founder-specified vocabulary -- no SMS/Slack/custom-time values sneak in later without a migration');

// ---------------------------------------------------------------------------
// ha_notification_deliveries -- durable delivery log with dedupe arrays.
// ---------------------------------------------------------------------------
assert(/create table if not exists public\.ha_notification_deliveries/.test(sql), 'migration 22 creates ha_notification_deliveries');
assert(/status text not null check \(status in \('success', 'failed'\)\)/.test(sql), 'REQUIRED: status distinguishes success from failed -- only success rows should ever advance the notifier\'s watermark');
assert(/included_signal_ids uuid\[\] not null default '\{\}'/.test(sql), 'REQUIRED: included_signal_ids is a plain array column, not a separate relational table -- per the founder\'s explicit V1 scope');
assert(/included_outreach_event_ids uuid\[\] not null default '\{\}'/.test(sql), 'REQUIRED: included_outreach_event_ids is a plain array column -- the digest builder reads this back to suppress re-mentioning an unchanged unresolved-outreach item');
assert(/user_id uuid not null references public\.ha_users\(id\) on delete cascade/.test(sql), 'a delivery log row cannot outlive the user it was sent to');

// ---------------------------------------------------------------------------
// Index shape -- the one query this table actually needs to serve fast:
// "this user's most recent successful delivery."
// ---------------------------------------------------------------------------
assert(/create index if not exists ha_notification_deliveries_user_success_idx\s*\n\s*on public\.ha_notification_deliveries \(user_id, sent_at desc\)\s*\n\s*where status = 'success';/.test(sql), 'REQUIRED: a partial index on (user_id, sent_at desc) where status=success serves the hot "last successful delivery" lookup directly');

// ---------------------------------------------------------------------------
// RLS: fail-closed, same posture as every other internal-only table.
// ---------------------------------------------------------------------------
assert(/alter table public\.ha_notification_deliveries enable row level security;/.test(sql), 'REQUIRED: RLS is enabled on ha_notification_deliveries -- fail-closed for anon/authenticated, no browser-facing access path');
assert(!/create policy/i.test(sql), 'REQUIRED: no permissive policy is introduced -- service-role-only access is the intended enforcement path');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
