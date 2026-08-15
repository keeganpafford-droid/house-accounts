// Phase 2B item K -- proves the legacy api/weekly-scan.js sweep excludes
// ONLY organizations explicitly listed in QUEUE_MANAGED_ORGANIZATION_IDS,
// and is a complete no-op (excludes nothing) when that variable is unset --
// the required "no production recurring-monitoring behavior changes for
// existing Beta users" guarantee.
//
// Usage: node scripts/test-weekly-scan-queue-exclusion.js
import { isQueueManagedOrganization } from '../api/lib/monitoring-queue.js';
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

// The exact function weekly-scan.js's exclusion check calls -- re-verified
// here from the consuming side (rather than re-testing
// isQueueManagedOrganization() itself again, already covered in
// scripts/test-monitoring-queue-adapter.js) to prove the INTEGRATION point:
// an unset/empty allowlist excludes no organization at all.
assert(isQueueManagedOrganization('any-beta-org-id', process.env.QUEUE_MANAGED_ORGANIZATION_IDS) === false, 'REQUIRED: with QUEUE_MANAGED_ORGANIZATION_IDS unset (this test\'s real environment, matching production today), no organization is excluded from the legacy sweep');
assert(isQueueManagedOrganization('founder-org-id', 'founder-org-id') === true, 'once an operator deliberately sets the allowlist to a specific org, that org is correctly identified as Queue-managed');
assert(isQueueManagedOrganization('other-beta-org-id', 'founder-org-id') === false, 'REQUIRED: setting the allowlist to the founder org does not also exclude an unrelated Beta organization');

// Structural proof against the real source: the exclusion check exists,
// runs inside the per-upload loop (so it is evaluated once per upload, not
// globally), and precedes any research/signal work for that upload.
{
  const source = readFileSync(join(REPO_ROOT, 'api', 'weekly-scan.js'), 'utf8');
  assert(/import \{ isQueueManagedOrganization \} from '\.\/lib\/monitoring-queue\.js';/.test(source), 'weekly-scan.js imports the shared isQueueManagedOrganization() rather than reimplementing allowlist logic');
  assert(/if\(isQueueManagedOrganization\(user\.organization_id, process\.env\.QUEUE_MANAGED_ORGANIZATION_IDS\)\) continue;/.test(source), 'REQUIRED: the exclusion check runs per-upload, inside the loop, using the real per-upload organization_id -- not a single global gate');
  const loopStart = source.indexOf('for(const upload of uploads || []){');
  const exclusionCheck = source.indexOf('isQueueManagedOrganization(user.organization_id');
  const firstResearchCall = source.indexOf('ha_weekly_runs', loopStart);
  assert(loopStart !== -1 && exclusionCheck !== -1 && firstResearchCall !== -1 && loopStart < exclusionCheck && exclusionCheck < firstResearchCall, 'REQUIRED: the exclusion check runs before any run-tracking/research work begins for that upload, not after');
  assert(/organization_id\)&order=updated_at\.desc/.test(source), 'the ha_uploads query now selects organization_id (via the embedded ha_users) so the exclusion check has real data to check against');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
