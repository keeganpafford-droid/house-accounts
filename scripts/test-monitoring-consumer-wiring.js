// Phase 2B item L -- structural check on api/queues/monitoring-consumer.js:
// confirms it wires the real RPC names and the coherent visibility timeout
// from api/lib/monitoring-queue.js, rather than a hand-copied/drifted
// value. Not a live Queue/Supabase execution (this sandbox has neither) --
// see the file's own header comment for that caveat.
//
// Usage: node scripts/test-monitoring-consumer-wiring.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { QUEUE_VISIBILITY_TIMEOUT_SECONDS } from '../api/lib/monitoring-queue.js';
import { consumeMonitoringMessage } from '../api/queues/monitoring-consumer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const source = readFileSync(join(REPO_ROOT, 'api', 'queues', 'monitoring-consumer.js'), 'utf8');

assert(/rpc\/claim_ha_monitoring_target/.test(source), 'the consumer calls the real claim_ha_monitoring_target RPC (migration 16), not a placeholder name');
assert(/rpc\/complete_ha_monitoring_attempt/.test(source), 'the consumer calls the real complete_ha_monitoring_attempt RPC (migration 16)');
assert(/p_target_id.*p_lease_seconds|p_lease_seconds.*p_target_id/s.test(source), 'the claim call passes both required RPC parameters');
assert(/p_target_id.*p_attempt_id.*p_coverage|p_coverage.*p_attempt_id/s.test(source), 'the completion call passes the target id, attempt id, and coverage classification');
assert(/visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS/.test(source), 'REQUIRED: the consumer route configures its Queue visibility timeout from the SAME shared constant the coherent-timing design (item B) is built around, not a separately hardcoded number');
assert(typeof QUEUE_VISIBILITY_TIMEOUT_SECONDS === 'number' && QUEUE_VISIBILITY_TIMEOUT_SECONDS === 600, `sanity: the shared visibility timeout constant is the documented 600s choice (got ${QUEUE_VISIBILITY_TIMEOUT_SECONDS})`);
assert(/normalizeCompanyName/.test(source), 'account resolution falls back to normalized-name matching for a renamed account, using the same identity function Phase 1 established (not a second copy)');
assert(/projectAccountContext/.test(source), 'REQUIRED: the consumer resolves BOUNDED account context (item D), never the full ha_accounts row/raw_data, before calling the research pipeline');
assert(typeof consumeMonitoringMessage === 'function', 'consumeMonitoringMessage is exported and importable without @vercel/queue being installed (the dynamic import is isolated to the default route handler, not this function)');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
