// Phase 2B item L -- deterministic coverage for api/monitoring-scheduler.js's
// pure selection logic and its safety properties (repeated-run safety and
// never advancing cadence are proven structurally: the scheduler has no
// code path that writes to ha_monitoring_targets at all -- see the file's
// own source, grepped below rather than asserted against a live call this
// sandbox cannot make).
//
// Usage: node scripts/test-monitoring-scheduler.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { selectQueueManagedDueTargets } from '../api/monitoring-scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------------
// selectQueueManagedDueTargets -- only flagged/due/active targets enqueue.
// ---------------------------------------------------------------------------
{
  const dueActive = [
    { id: 't1', organization_id: 'founder-org' },
    { id: 't2', organization_id: 'beta-org-1' },
    { id: 't3', organization_id: 'founder-org' },
    { id: 't4', organization_id: 'beta-org-2' }
  ];
  const selected = selectQueueManagedDueTargets(dueActive, 'founder-org');
  assert(selected.length === 2 && selected.every(t => t.organization_id === 'founder-org'), `REQUIRED: only targets belonging to an allowlisted organization are selected (got ${JSON.stringify(selected.map(t => t.id))})`);

  const selectedEmpty = selectQueueManagedDueTargets(dueActive, '');
  assert(selectedEmpty.length === 0, 'REQUIRED: an empty allowlist selects nothing -- the default, no-op state for every existing Beta organization');

  const selectedMulti = selectQueueManagedDueTargets(dueActive, 'founder-org,beta-org-2');
  assert(selectedMulti.length === 3, 'a multi-organization allowlist selects targets from every listed organization');
}

{
  // Idempotency across repeated calls with the identical input -- proves
  // this is a pure, side-effect-free filter, a prerequisite for "repeated
  // scheduler runs are safe" (the other half of that guarantee is Queue's
  // own idempotency-key deduplication, covered in
  // scripts/test-monitoring-queue-adapter.js).
  const dueActive = [{ id: 't1', organization_id: 'org-a' }];
  const run1 = selectQueueManagedDueTargets(dueActive, 'org-a');
  const run2 = selectQueueManagedDueTargets(dueActive, 'org-a');
  assert(JSON.stringify(run1) === JSON.stringify(run2), 'REQUIRED: repeated selection against the same input is deterministic (same targets selected every time)');
}

// ---------------------------------------------------------------------------
// Structural proof: the scheduler file contains no write to
// ha_monitoring_targets at all -- "does not advance cadence itself" is true
// by construction, not by a runtime check this sandbox cannot make live.
// ---------------------------------------------------------------------------
{
  const source = readFileSync(join(REPO_ROOT, 'api', 'monitoring-scheduler.js'), 'utf8');
  assert(!/PATCH|method:\s*['"]POST['"].*ha_monitoring_targets|ha_monitoring_targets.*method:\s*['"]PATCH['"]/s.test(source), 'sanity: no PATCH/write call against ha_monitoring_targets appears in the scheduler source');
  assert(/next_due_at=lte/.test(source), 'the scheduler reads next_due_at (to select due targets) -- confirms the due-filter is present');
  assert(!/next_due_at\s*[:=]\s*(?!.*select)/.test(source.replace(/next_due_at=lte[^\s&]*/g, '')), 'REQUIRED: outside the due-filter query string itself, next_due_at is never assigned/written anywhere in the scheduler');
  assert(/enqueueMonitoringJob/.test(source), 'the scheduler publishes via enqueueMonitoringJob() -- the one Queue-adapter entry point, not a duplicated inline send() call');
  assert(/CRON_SECRET/.test(source) && /safeSecretEqual/.test(source), 'the scheduler is gated behind the same CRON_SECRET auth convention as every other internal cron endpoint in this codebase');
}

// vercel.json itself must not list this endpoint as a cron in this phase --
// checked against the real config file, not just the scheduler's own source.
{
  const vercelConfig = JSON.parse(readFileSync(join(REPO_ROOT, 'vercel.json'), 'utf8'));
  const crons = Array.isArray(vercelConfig.crons) ? vercelConfig.crons : [];
  assert(!crons.some(c => String(c.path || '').includes('monitoring-scheduler')), 'REQUIRED: api/monitoring-scheduler.js is not registered in vercel.json\'s crons -- general production scheduling is not enabled in this phase');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
