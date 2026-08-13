// Signal feedback / organizational-learning foundation: two small, static
// proofs that don't belong in scripts/test-signal-events.js's handler-level
// coverage --
//   1. rowToSignal()/signalToOpportunity() (api/get-dashboard.js) now
//      expose the stable eventFingerprint/id every api/signal-events.js
//      call needs to key on -- previously exposed nowhere on the client.
//   2. migration 11 actually enables Row Level Security on
//      ha_signal_events, and does not introduce any permissive
//      browser-facing policy (the application's server-only/service-role
//      access model is the intended enforcement path, not a policy set).
//
// Usage: node scripts/test-signal-events-schema-and-exposure.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rowToSignal, signalToOpportunity } from '../api/get-dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------------
// 1. Client-facing signal identity exposure.
// ---------------------------------------------------------------------------
const fakeRow = {
  id: 'sig-row-1',
  user_id: 'user-1',
  account_name: 'Acme Co',
  signal_type: 'Hiring Activity',
  title: 'Acme Co is hiring',
  why_reach_out: '',
  confidence: 82,
  source_url: 'https://news.example.com/acme-hiring',
  source_domain: 'news.example.com',
  published_at: '2026-07-01',
  event_fingerprint: 'fp-acme-hiring-2026',
  first_seen_at: '2026-07-02T00:00:00.000Z',
  last_seen_at: '2026-07-02T00:00:00.000Z',
  payload: { signalType: 'Hiring Activity', title: 'Acme Co is hiring' }
};

{
  const signal = rowToSignal(fakeRow);
  assert(signal.eventFingerprint === 'fp-acme-hiring-2026', `REQUIRED: rowToSignal() exposes eventFingerprint (got ${JSON.stringify(signal.eventFingerprint)})`);
  assert(signal.id === 'sig-row-1', `REQUIRED: rowToSignal() exposes id as a secondary/optional hint (got ${JSON.stringify(signal.id)})`);
}
{
  const opp = signalToOpportunity(fakeRow);
  assert(opp.eventFingerprint === 'fp-acme-hiring-2026', `REQUIRED: signalToOpportunity() (feeds Prepare for Call's opp object) exposes eventFingerprint (got ${JSON.stringify(opp.eventFingerprint)})`);
  assert(opp.id === 'sig-row-1', `REQUIRED: signalToOpportunity() exposes id (got ${JSON.stringify(opp.id)})`);
}
{
  // A row with no event_fingerprint at all (should not happen for a real
  // persisted business signal, but the client-side feedback controls must
  // still degrade safely rather than send an empty-string fingerprint).
  const bareRow = { ...fakeRow, event_fingerprint: '' };
  const signal = rowToSignal(bareRow);
  assert(signal.eventFingerprint === '', 'rowToSignal() never fabricates a fingerprint when none is stored -- stays an honest empty string');
}

// ---------------------------------------------------------------------------
// 2. Migration 11: RLS enabled, no permissive policy introduced.
// ---------------------------------------------------------------------------
const migrationPath = join(REPO_ROOT, 'supabase-schema-migration-11-signal-events-foundation.sql');
const migrationSql = readFileSync(migrationPath, 'utf8');

assert(/create table if not exists public\.ha_signal_events/i.test(migrationSql), 'migration 11 creates ha_signal_events');
assert(/ALTER TABLE public\.ha_signal_events ENABLE ROW LEVEL SECURITY;/i.test(migrationSql), 'REQUIRED: migration 11 enables Row Level Security on ha_signal_events');
assert(!/CREATE POLICY/i.test(migrationSql), 'REQUIRED: migration 11 introduces no browser-facing policy -- server-only/service-role access is the intended enforcement path, so RLS with zero policies fails closed for anon/authenticated roles');
assert(/unique \(user_id, client_event_id\)/i.test(migrationSql), 'migration 11 enforces the (user_id, client_event_id) idempotency constraint');
assert(/parent_event_id uuid references public\.ha_signal_events\(id\)/i.test(migrationSql), 'migration 11 defines the self-referencing parent_event_id column');
assert(/schema_version smallint not null default 1/i.test(migrationSql), 'migration 11 defines schema_version, defaulting to 1');
assert(/'signal_useful'/.test(migrationSql) && /'signal_not_useful'/.test(migrationSql), 'migration 11\'s event_type CHECK constraint uses the signal-scoped names (signal_useful/signal_not_useful), not the generic feedback_* names');
assert(/'outreach_made'/.test(migrationSql) && !/'outreach_sent'/.test(migrationSql), 'migration 11 uses outreach_made, not the earlier outreach_sent name');
assert(/'outcome_reported'/.test(migrationSql), 'migration 11 reserves the outcome_reported value for a future sprint');
assert(!/ha_signals\s+ADD COLUMN organization_id/i.test(migrationSql), 'REQUIRED: migration 11 does not add organization_id to ha_signals -- evaluated and found unnecessary for this sprint');
assert(/user_id, event_fingerprint, created_at desc/i.test(migrationSql), 'migration 11 adds the (user_id, event_fingerprint, created_at desc) composite index matching the actual V1 read-back access pattern');

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
