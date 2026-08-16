// Full Beta Cutover + Legacy Weekly-Scan Retirement -- focused regression
// proof for the four properties this specific branch changes (retiring
// api/weekly-scan.js, wiring the new crons, and restoring
// coverage_classification persistence). Same convention as
// scripts/test-monitoring-retry-cooldown-schema.js: this automated suite has
// no database credentials in this sandbox, so static/structural proof
// against the real on-disk source is what's available here.
//
// The OTHER required regression properties for this cutover -- monitoring
// scheduler remains due-only and allowlist-gated; notification scheduler
// remains allowlist-gated and respects daily/weekly/in_app_only; no empty
// email is sent; the watermark only advances on a real provider delivery
// id; monitoring global capacity/backpressure is unchanged; the
// insufficient-result cooldown is unchanged; Queue idempotency/lease
// behavior is unchanged -- are NOT re-proven here. This cutover did not
// touch any of that logic (only comments, vercel.json, and the
// coverage_classification RPC were changed in the files that implement it),
// and each property already has live, passing, unmodified-by-this-branch
// coverage: scripts/test-monitoring-scheduler.js (due-only + allowlist),
// scripts/test-notification-scheduler.js (allowlist + preference cadence),
// scripts/test-notification-digest.js (no-empty-email hasContent gate),
// scripts/test-notification-scheduler.js's watermark assertions (advances
// only on a real resend_message_id), scripts/test-monitoring-concurrency-
// bounds.js and scripts/test-monitoring-capacity-schema.js (global
// capacity/backpressure), scripts/test-monitoring-retry-cooldown-schema.js
// (insufficient-result cooldown), and scripts/test-monitoring-queue-
// adapter.js (idempotency/lease). Re-deriving those here would duplicate
// coverage rather than add any.
//
// Usage: node scripts/test-full-beta-cutover-verification.js
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// 1. api/weekly-scan.js is actually gone.
// ===========================================================================
assert(!existsSync(join(REPO_ROOT, 'api', 'weekly-scan.js')), 'REQUIRED: api/weekly-scan.js no longer exists on disk');

// ===========================================================================
// 2. No remaining file anywhere in api/, scripts/, or dashboard/ has a
//    RUNTIME dependency (an ES import, or a readFileSync of the file's own
//    source for a structural assertion) on api/weekly-scan.js. Historical/
//    provenance comments mentioning the retired file by name are expected
//    and are NOT what this checks -- only the two patterns that would
//    actually throw (ENOENT / module-not-found) once the file is gone.
// ===========================================================================
{
  const IMPORT_OR_READ_PATTERN = /(from\s+['"][^'"]*weekly-scan\.js['"]|readFileSync\([^)]*weekly-scan\.js)/;
  const offenders = [];
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!/\.(js|html)$/.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      if (IMPORT_OR_READ_PATTERN.test(text)) offenders.push(full.replace(REPO_ROOT + '/', ''));
    }
  }
  for (const dir of ['api', 'scripts', 'dashboard']) scan(join(REPO_ROOT, dir));
  assert(offenders.length === 0, `REQUIRED: zero files under api/, scripts/, dashboard/ import or readFileSync api/weekly-scan.js at runtime (found: ${JSON.stringify(offenders)})`);
}

// ===========================================================================
// 3. vercel.json: the retired cron is gone, the two new-architecture crons
//    are registered with the exact founder-specified schedules, and the
//    weekly-scan-only maxDuration function entry is gone too.
// ===========================================================================
{
  const vercelConfig = JSON.parse(readFileSync(join(REPO_ROOT, 'vercel.json'), 'utf8'));
  const crons = Array.isArray(vercelConfig.crons) ? vercelConfig.crons : [];
  assert(!crons.some(c => String(c.path || '').includes('weekly-scan')), 'REQUIRED: /api/weekly-scan is no longer registered in vercel.json\'s crons');
  const monitoringCron = crons.find(c => c.path === '/api/monitoring-scheduler');
  const notificationCron = crons.find(c => c.path === '/api/notification-scheduler');
  assert(monitoringCron?.schedule === '*/5 * * * *', `REQUIRED: /api/monitoring-scheduler is registered at */5 * * * * (got ${JSON.stringify(monitoringCron)})`);
  assert(notificationCron?.schedule === '0 12 * * *', `REQUIRED: /api/notification-scheduler is registered at 0 12 * * * (got ${JSON.stringify(notificationCron)})`);
  assert(!vercelConfig.functions?.['api/weekly-scan.js'], 'REQUIRED: vercel.json\'s functions block no longer configures api/weekly-scan.js');
}

// ===========================================================================
// 4. coverage_classification persistence fix (migration 23): the regression
//    migration 20 introduced (dropping coverage_classification from the
//    INSERT column/VALUES lists when it rewrote complete_ha_monitoring_
//    attempt() to add p_cooldown_hours) is restored, migration 20's own
//    file is untouched, and every migration-20 cooldown behavior survives
//    unchanged in the new function body.
// ===========================================================================
{
  const migration20 = readFileSync(join(REPO_ROOT, 'supabase-schema-migration-20-monitoring-retry-cooldown.sql'), 'utf8');
  assert(!/coverage_classification/.test(migration20), 'sanity: migration 20\'s own file was NOT edited in place to fix this (it still has the regression as originally shipped) -- the fix is a new, additive migration, matching the founder\'s explicit "preserve migration history" requirement');

  const migration23Path = join(REPO_ROOT, 'supabase-schema-migration-23-monitoring-coverage-classification-restore.sql');
  assert(existsSync(migration23Path), 'REQUIRED: a new migration 23 file exists (smallest forward migration, not an edit to migration 20)');
  const sql = readFileSync(migration23Path, 'utf8');

  assert(/create or replace function public\.complete_ha_monitoring_attempt\(/.test(sql), 'REQUIRED: migration 23 create-or-replaces complete_ha_monitoring_attempt()');
  assert(/p_cooldown_hours integer default 24/.test(sql), 'REQUIRED: the 7-parameter signature (including p_cooldown_hours) migration 20 introduced is preserved -- this is not a signature change, so no drop-then-create is needed');
  assert(!/drop function if exists public\.complete_ha_monitoring_attempt/.test(sql), 'REQUIRED: migration 23 does not drop the function first -- the signature is unchanged from migration 20, only the INSERT body is restored');

  const fnBody = sql.split('create or replace function public.complete_ha_monitoring_attempt')[1] || '';
  assert(/insert into public\.ha_monitoring_attempts \(\s*\n\s*target_id, outcome, coverage_classification, elapsed_ms/.test(fnBody), 'REQUIRED: coverage_classification is restored to the INSERT column list, immediately after outcome (migration 17\'s original position)');
  assert(/values \(\s*\n\s*p_target_id, v_outcome, p_coverage,/.test(fnBody), 'REQUIRED: p_coverage is restored to the VALUES list at the coverage_classification position');

  // The exact three coverage values the CHECK constraint (migration 17)
  // allows must all be accepted and stored verbatim -- p_coverage is
  // inserted directly, not gated by outcome, so 'complete',
  // 'degraded_trustworthy', and 'insufficient' all persist their own exact
  // string, not a collapsed outcome='success'/'failed' proxy.
  assert(/if p_coverage not in \('complete', 'degraded_trustworthy', 'insufficient'\) then/.test(fnBody), 'REQUIRED: the same three-value validation guard is preserved');
  assert(/v_outcome := case when p_coverage in \('complete', 'degraded_trustworthy'\) then 'success' else 'failed' end;/.test(fnBody), 'REQUIRED: outcome collapses complete/degraded_trustworthy to success and insufficient to failed, same as before -- coverage_classification is the finer-grained value alongside it, not a replacement for it');

  // Every migration-20 cooldown behavior must survive byte-for-byte in the
  // new function body -- this is what proves the fix is additive/isolated,
  // not a regression of migration 20's own work.
  assert(/v_clamped_cooldown_hours := greatest\(1, least\(coalesce\(p_cooldown_hours, 24\), 168\)\);/.test(fnBody), 'REQUIRED: the cooldown clamp migration 20 added is unchanged');
  assert(/research_retry_cooldown_until = now\(\) \+ make_interval\(hours => v_clamped_cooldown_hours\)/.test(fnBody), 'REQUIRED: the insufficient/failure branch still sets research_retry_cooldown_until using the clamped value');
  assert(/research_retry_cooldown_until = null/.test(fnBody), 'REQUIRED: the success branch still clears research_retry_cooldown_until');
  assert(/next_due_at = now\(\) \+ make_interval\(days => greatest\(1, coalesce\(p_cadence_days, 7\)\)\)/.test(fnBody), 'REQUIRED: cadence advancement on success is unchanged');
  assert(/if v_target\.lease_attempt_id is distinct from p_attempt_id then/.test(fnBody), 'REQUIRED: the not-current-attempt lease-ownership guard is unchanged');

  // No blanket historical backfill -- the founder was explicit that
  // guessing a historical row's classification is not acceptable.
  assert(!/^\s*update public\.ha_monitoring_attempts\s*$/m.test(sql.split('revoke all')[0].split('$$;')[1] || ''), 'REQUIRED: migration 23 contains no blanket UPDATE backfilling historical null coverage_classification rows');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
