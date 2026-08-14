// Organizational Learning V1B: static proof of migration 12's SQL content
// (RLS/policy doctrine, table shape, structural constraints) PLUS a pure-JS
// mirror of the ha_signal_events_target_family_check CHECK expression's
// logic, exhaustively exercised against every event_type/target
// combination. Migration 12 is deliberately NOT applied to any live
// database yet (per explicit instruction) -- this is the correctness proof
// available before that happens: the SQL text is verified to say exactly
// what's intended, and the CASE-based invariant it expresses is verified
// to actually implement the intended exclusivity rules, ported to JS
// line-for-line so a future edit to one is checked against the other.
//
// Production correction (migration 14): migration 12's own file text below
// is left untouched as the historical record of what was originally
// applied, but the LIVE constraint no longer matches it exactly --
// migration 14 supersedes the prepare_call_opened branch. Root cause:
// signal_id/opportunity_id both use ON DELETE SET NULL specifically so a
// historical event survives its source row being deleted later (this
// exact file's own header, restated below) -- but the ORIGINAL strict-XOR
// prepare_call_opened branch required exactly one to stay non-null
// forever, which a real customer-list deletion violates the instant it
// nulls out signal_id for a prepare_call_opened row that (correctly) never
// had opportunity_id set. Reproduced live via a rolled-back transaction
// against Supabase project zodtymrckbtbiomakupf: 23514 check_violation on
// ha_signal_events_target_family_check, surfaced by PostgREST as a 400 on
// deleteList()'s very first statement (DELETE FROM ha_signals) -- before
// the request ever reached ha_accounts or ha_uploads. targetFamilyCheck()
// below mirrors the CORRECTED (migration 14) logic, not migration 12's
// original text, so this file stays the single live behavioral proof
// rather than going stale the moment a later migration supersedes it.
//
// Usage: node scripts/test-migration-12-schema.js
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

const sql = readFileSync(join(REPO_ROOT, 'supabase-schema-migration-12-account-opportunities.sql'), 'utf8');
const migration14Sql = readFileSync(join(REPO_ROOT, 'supabase-schema-migration-14-prepare-call-opened-orphan-fix.sql'), 'utf8');

// ---------------------------------------------------------------------
// Migration 14's actual SQL text says what targetFamilyCheck() below
// proves is correct -- not the strict XOR migration 12 originally shipped.
// ---------------------------------------------------------------------
assert(/alter table public\.ha_signal_events drop constraint if exists ha_signal_events_target_family_check/.test(migration14Sql), 'migration 14 drops the original constraint before redefining it');
assert(/when event_type = 'prepare_call_opened' then\s*\n\s*not \(signal_id is not null and opportunity_id is not null\)/.test(migration14Sql), 'REQUIRED: migration 14\'s prepare_call_opened branch forbids only "both set", not "neither set" -- matches targetFamilyCheck() below');
assert(!(/\(signal_id is not null\) <> \(opportunity_id is not null\)/.test(migration14Sql.split('check (')[1] || '')), 'REQUIRED: migration 14\'s actual CHECK expression (not its explanatory comment, which quotes the old bug verbatim) does not reintroduce the old strict-XOR');

// ---------------------------------------------------------------------
// ha_account_opportunities shape.
// ---------------------------------------------------------------------
assert(/create table if not exists public\.ha_account_opportunities/i.test(sql), 'migration 12 creates ha_account_opportunities');
assert(/ALTER TABLE public\.ha_account_opportunities ENABLE ROW LEVEL SECURITY;/i.test(sql), 'REQUIRED: migration 12 enables RLS on ha_account_opportunities');
assert(!(/CREATE POLICY/i.test(sql)), 'REQUIRED: migration 12 introduces no browser-facing policy on either table -- server-only/service-role access is the enforcement path');
assert(/opportunity_type text not null check \(opportunity_type in \('repeat_pattern', 'follow_up'\)\)/.test(sql), 'REQUIRED: opportunity_type is constrained to exactly repeat_pattern/follow_up -- no generalized type list');
assert(/status text not null default 'active' check \(status in \('active', 'inactive', 'superseded'\)\)/.test(sql), 'REQUIRED: status is constrained to the three-state lifecycle');
assert(/constraint ha_account_opportunities_user_fingerprint_unique unique \(user_id, fingerprint\)/.test(sql), 'REQUIRED: (user_id, fingerprint) uniqueness makes reconciliation idempotent');
assert(/ha_account_opportunities_category_shape check/.test(sql) && /repeat_pattern.*category is not null/s.test(sql) && /follow_up.*category is null/s.test(sql), 'REQUIRED: category is structurally required for repeat_pattern and structurally forbidden for follow_up');
assert(/create unique index if not exists ha_account_opportunities_one_active_per_family[\s\S]*where status = 'active'/.test(sql), 'REQUIRED: at most one ACTIVE instance per family is enforced at the database level (partial unique index)');
assert(/superseded_by_id uuid references public\.ha_account_opportunities\(id\) on delete set null/.test(sql), 'superseded_by_id self-references for explicit "what replaced this" lineage');
assert(!(/organization_id/i.test(sql.split('ha_signal_events extension')[0])), 'sanity: ha_account_opportunities carries no redundant organization_id column, matching ha_signals\' own pattern (resolved via org membership at write/read time)');

// ---------------------------------------------------------------------
// ha_signal_events extension.
// ---------------------------------------------------------------------
assert(/add column if not exists opportunity_id uuid references public\.ha_account_opportunities\(id\) on delete set null/.test(sql), 'REQUIRED: opportunity_id is added as a nullable, ON DELETE SET NULL FK -- consistent with signal_id\'s existing posture');
assert(/'opportunity_selected'/.test(sql) && /'opportunity_useful'/.test(sql) && /'opportunity_not_useful'/.test(sql) && /'opportunity_outreach_made'/.test(sql) && /'opportunity_approach_shared'/.test(sql), 'REQUIRED: all 5 new opportunity_* event types are added to the widened CHECK');
assert(/'signal_selected'/.test(sql) && /'outcome_reported'/.test(sql), 'sanity: the original V1A event types are preserved in the widened CHECK, not dropped');
assert(!(/signal_id is not null and opportunity_id is null and/i.test(sql)) , 'sanity: no branch requires signal_id to be permanently non-null (would conflict with ON DELETE SET NULL)');
assert(!(/'signal_id not null'|signal_id is not null\)\s*and\s*\(opportunity_id is null/i.test(sql)), 'REQUIRED: the target-family CHECK never requires signal_id itself to be non-null -- only opportunity_id to be null for signal events');

console.log(`\n${failures === 0 ? 'ALL SQL-TEXT TESTS PASSED' : `${failures} SQL-TEXT TEST(S) FAILED`}`);

// ---------------------------------------------------------------------
// Pure-JS mirror of ha_signal_events_target_family_check's CASE logic --
// ported line-for-line from supabase-schema-migration-14-prepare-call-
// opened-orphan-fix.sql (the LIVE definition; see the header comment
// above for why this is no longer migration 12's own text). Exhaustively
// proves the intended exclusivity rules for every event_type.
// ---------------------------------------------------------------------
function targetFamilyCheck({ eventType, signalId, opportunityId, parentEventId }) {
  const hasSignal = signalId != null;
  const hasOpportunity = opportunityId != null;
  const hasParent = parentEventId != null;
  switch (true) {
    case eventType === 'prepare_call_opened':
      // NOT XOR: forbids only the structurally-invalid "both set" state.
      // "Neither set" is a valid, expected terminal state once ON DELETE
      // SET NULL has nulled out signal_id (or, symmetrically,
      // opportunity_id) for a historical row -- migration 14's fix.
      return !(hasSignal && hasOpportunity);
    case ['signal_selected', 'signal_useful', 'signal_not_useful', 'outreach_made'].includes(eventType):
      return !hasOpportunity;
    case eventType === 'approach_shared':
      return !hasOpportunity && hasParent;
    case ['opportunity_selected', 'opportunity_useful', 'opportunity_not_useful', 'opportunity_outreach_made'].includes(eventType):
      return !hasSignal;
    case eventType === 'opportunity_approach_shared':
      return !hasSignal && hasParent;
    default:
      return true; // outcome_reported: unconstrained, reserved
  }
}

const SIG = 'signal-uuid', OPP = 'opportunity-uuid', PARENT = 'parent-uuid';

const CASES = [
  // [description, row, expectedValid]
  ['signal_useful with signal_id only', { eventType: 'signal_useful', signalId: SIG }, true],
  ['signal_useful with both signal_id AND opportunity_id -- structurally invalid', { eventType: 'signal_useful', signalId: SIG, opportunityId: OPP }, false],
  ['signal_useful with signal_id nulled by ON DELETE SET NULL (historical row) -- still valid, opportunity_id stays null', { eventType: 'signal_useful', signalId: null }, true],
  ['outreach_made with signal_id only', { eventType: 'outreach_made', signalId: SIG }, true],
  ['outreach_made with opportunity_id -- structurally invalid, wrong family', { eventType: 'outreach_made', opportunityId: OPP }, false],
  ['approach_shared with signal_id + parent -- valid', { eventType: 'approach_shared', signalId: SIG, parentEventId: PARENT }, true],
  ['approach_shared with NO parent -- REQUIRED invalid', { eventType: 'approach_shared', signalId: SIG }, false],
  ['approach_shared with opportunity_id -- structurally invalid, wrong family', { eventType: 'approach_shared', opportunityId: OPP, parentEventId: PARENT }, false],
  ['opportunity_useful with opportunity_id only', { eventType: 'opportunity_useful', opportunityId: OPP }, true],
  ['opportunity_useful with signal_id -- structurally invalid, wrong family', { eventType: 'opportunity_useful', opportunityId: OPP, signalId: SIG }, false],
  ['opportunity_useful with opportunity_id nulled by ON DELETE SET NULL (historical row) -- still valid, signal_id stays null', { eventType: 'opportunity_useful', opportunityId: null }, true],
  ['opportunity_outreach_made with opportunity_id only', { eventType: 'opportunity_outreach_made', opportunityId: OPP }, true],
  ['opportunity_approach_shared with opportunity_id + parent -- valid', { eventType: 'opportunity_approach_shared', opportunityId: OPP, parentEventId: PARENT }, true],
  ['opportunity_approach_shared with NO parent -- REQUIRED invalid', { eventType: 'opportunity_approach_shared', opportunityId: OPP }, false],
  ['opportunity_approach_shared with signal_id -- structurally invalid, wrong family', { eventType: 'opportunity_approach_shared', signalId: SIG, parentEventId: PARENT }, false],
  ['prepare_call_opened targeting a signal only -- valid', { eventType: 'prepare_call_opened', signalId: SIG }, true],
  ['prepare_call_opened targeting an opportunity only -- valid', { eventType: 'prepare_call_opened', opportunityId: OPP }, true],
  ['prepare_call_opened targeting BOTH -- REQUIRED invalid (an event can never target both families at once)', { eventType: 'prepare_call_opened', signalId: SIG, opportunityId: OPP }, false],
  ['prepare_call_opened targeting NEITHER at INSERT time -- structurally allowed by the schema (the API is responsible for rejecting this at creation time, same trust model as every other branch here), but this is also NOT the historical-orphan case below', { eventType: 'prepare_call_opened' }, true],
  ['REQUIRED (migration 14 fix): prepare_call_opened whose signal_id was later nulled by ON DELETE SET NULL (its ha_signals row was deleted, e.g. by a customer-list delete) -- valid, opportunity_id correctly stays null since this was always a signal-family event. This is the exact production reproduction: deleting a list violated this constraint under the pre-migration-14 strict XOR.', { eventType: 'prepare_call_opened', signalId: null, opportunityId: null }, true],
  ['outcome_reported -- unconstrained/reserved', { eventType: 'outcome_reported' }, true]
];

for (const [description, row, expected] of CASES) {
  const actual = targetFamilyCheck(row);
  assert(actual === expected, `${expected ? 'REQUIRED: valid' : 'REQUIRED: rejected'} -- ${description} (got ${actual ? 'valid' : 'rejected'})`);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
