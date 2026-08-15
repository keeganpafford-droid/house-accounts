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
import { selectQueueManagedDueTargets, selectTargetsToPublish, DEFAULT_MONITORING_SCHEDULER_PUBLISH_LIMIT } from '../api/monitoring-scheduler.js';

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

// ---------------------------------------------------------------------------
// Phase 2D items 12-13: selectTargetsToPublish() -- deterministic due-
// ordering, publish-cap enforcement, and deferred targets remaining
// logically "due" (this function itself never mutates next_due_at; the
// structural proof above already confirms the whole file never writes to
// ha_monitoring_targets).
// ---------------------------------------------------------------------------
{
  // Item 12: never publishes more than the configured cap, even with a
  // large due backlog.
  const dueBacklog = Array.from({ length: 25 }, (_, i) => ({ id: `t${String(i).padStart(2, '0')}`, next_due_at: `2026-08-${String(1 + (i % 20)).padStart(2, '0')}T00:00:00.000Z` }));
  const { toPublish, deferred } = selectTargetsToPublish(dueBacklog, 10);
  assert(toPublish.length === 10, `REQUIRED (item 12): publishing is capped at the configured limit even with a 25-target backlog (got ${toPublish.length})`);
  assert(deferred.length === 15, `the remainder (25 - 10) is reported as deferred, not silently dropped (got ${deferred.length})`);
  assert(toPublish.length + deferred.length === dueBacklog.length, 'REQUIRED: every due target is accounted for as either published or deferred -- none vanish');
}

{
  // Item 12 (default): an unset/invalid publishLimit falls back to the
  // documented default, never to "publish everything."
  const dueBacklog = Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, next_due_at: '2026-08-10T00:00:00.000Z' }));
  const { toPublish } = selectTargetsToPublish(dueBacklog, undefined);
  assert(toPublish.length === DEFAULT_MONITORING_SCHEDULER_PUBLISH_LIMIT, `REQUIRED: an unset publish limit uses the documented default (${DEFAULT_MONITORING_SCHEDULER_PUBLISH_LIMIT}), not unbounded publishing (got ${toPublish.length})`);
  const { toPublish: withZero } = selectTargetsToPublish(dueBacklog, 0);
  assert(withZero.length === DEFAULT_MONITORING_SCHEDULER_PUBLISH_LIMIT, `REQUIRED: a zero/invalid publish limit also falls back to the safe default rather than publishing zero or everything (got ${withZero.length})`);
}

{
  // Item 13: deferred targets are exactly the oldest-due-first remainder --
  // still due, still eligible, simply left for a later scheduler
  // invocation. Oldest-due-first ordering (item E) means the PUBLISHED set
  // is always the longest-waiting targets, never an arbitrary subset.
  const dueBacklog = [
    { id: 'newest', next_due_at: '2026-08-15T00:00:00.000Z' },
    { id: 'oldest', next_due_at: '2026-08-01T00:00:00.000Z' },
    { id: 'middle', next_due_at: '2026-08-08T00:00:00.000Z' }
  ];
  const { toPublish, deferred } = selectTargetsToPublish(dueBacklog, 2);
  assert(toPublish.map(t => t.id).join(',') === 'oldest,middle', `REQUIRED: the published set is the oldest-due-first targets, not input order or newest-first (got ${toPublish.map(t => t.id).join(',')})`);
  assert(deferred.length === 1 && deferred[0].id === 'newest', `REQUIRED (item 13): the deferred target is the one target NOT published -- still a real, unmodified target object (same next_due_at), simply left for a later invocation (got ${JSON.stringify(deferred)})`);
  assert(deferred[0].next_due_at === '2026-08-15T00:00:00.000Z', 'REQUIRED (item 13): a deferred target\'s next_due_at is completely untouched by selection -- it remains exactly as due as it was, ready to be published (or deferred again) on the next scheduler run');
}

{
  // Determinism: a stable id tie-break when two targets share an exact
  // next_due_at, so repeated calls against the same input always produce
  // the same split -- correctness-critical for item 13's "deferred targets
  // remain due and are picked up next run" guarantee to not flap between
  // runs.
  const tied = [
    { id: 'b', next_due_at: '2026-08-10T00:00:00.000Z' },
    { id: 'a', next_due_at: '2026-08-10T00:00:00.000Z' },
    { id: 'c', next_due_at: '2026-08-10T00:00:00.000Z' }
  ];
  const run1 = selectTargetsToPublish(tied, 2);
  const run2 = selectTargetsToPublish(tied, 2);
  assert(JSON.stringify(run1) === JSON.stringify(run2), 'REQUIRED: repeated calls against identical input (including exactly-tied next_due_at) produce an identical split every time');
  assert(run1.toPublish.map(t => t.id).join(',') === 'a,b', `a stable id tie-break orders exactly-tied targets deterministically (got ${run1.toPublish.map(t => t.id).join(',')})`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
