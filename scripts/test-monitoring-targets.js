// Phase 1 monitoring-architecture foundation -- deterministic, DB-free
// coverage for api/lib/monitoring-targets.js. No mocking needed: every
// function under test is a pure function of its arguments.
//
// Usage: node scripts/test-monitoring-targets.js
import {
  normalizeCompanyName,
  identityKey,
  computeStaggeredDueDate,
  groupAccountsForBackfill,
  buildBackfillPlan,
  STAGGER_WINDOW_MS
} from '../api/lib/monitoring-targets.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const USER_A = 'user-aaaaaaaa-0000-0000-0000-000000000001';
const USER_B = 'user-bbbbbbbb-0000-0000-0000-000000000002';
const ORG_A = 'org-11111111-0000-0000-0000-000000000001';
const ORG_B = 'org-22222222-0000-0000-0000-000000000002';

// --- deterministic staggering ---------------------------------------------
{
  const now = Date.parse('2026-08-15T00:00:00.000Z');
  const d1 = computeStaggeredDueDate(USER_A, 'acme manufacturing', now);
  const d2 = computeStaggeredDueDate(USER_A, 'acme manufacturing', now);
  assert(d1 === d2, 'REQUIRED: computeStaggeredDueDate is deterministic for the same identity + reference time');

  const dOtherIdentity = computeStaggeredDueDate(USER_A, 'zenith industrial', now);
  assert(d1 !== dOtherIdentity, 'different identities generally land on different staggered due dates');

  const offsetMs = Date.parse(d1) - now;
  assert(offsetMs >= 0 && offsetMs < STAGGER_WINDOW_MS, `REQUIRED: staggered due date falls within [now, now+7days) (got offsetMs=${offsetMs})`);

  // Spread sanity check across many synthetic identities: confirms the
  // hash-based stagger does not degenerate into clustering everything at
  // one end of the window.
  const offsets = Array.from({ length: 500 }, (_, i) => Date.parse(computeStaggeredDueDate(USER_A, `synthetic co ${i}`, now)) - now);
  const bucket = ms => Math.floor(ms / (STAGGER_WINDOW_MS / 7));
  const bucketsHit = new Set(offsets.map(bucket));
  assert(bucketsHit.size >= 5, `REQUIRED: 500 synthetic identities spread across at least 5 of 7 day-buckets, not clustered (got ${bucketsHit.size})`);
}

// --- identity/grouping: stable across regenerated ha_accounts.id ----------
{
  // Simulates a re-research-triggered resave: replace_ha_accounts_snapshot()
  // deletes and reinserts, so the row's own id and upload_id both change,
  // but the literal account_name is identical.
  const rows = [
    { id: 'row-1-old-id', user_id: USER_A, organization_id: ORG_A, account_name: 'Acme Manufacturing', upload_id: 'upload-1', updated_at: '2026-08-01T00:00:00Z', monitoring_status: 'active' },
    { id: 'row-1-regenerated-id', user_id: USER_A, organization_id: ORG_A, account_name: 'Acme Manufacturing', upload_id: 'upload-2-new', updated_at: '2026-08-10T00:00:00Z', monitoring_status: 'active' }
  ];
  const { groups, collisions } = groupAccountsForBackfill(rows);
  assert(collisions.length === 0, 'REQUIRED: the same literal account_name reappearing under a regenerated ha_accounts.id/upload_id is not a collision');
  assert(groups.length === 1, `REQUIRED: two rows for the same (user, normalized name) collapse into exactly one target group (got ${groups.length})`);
  assert(groups[0].currentUploadId === 'upload-2-new', 'the most recently updated row is authoritative for the current_upload_id pointer');
}

// --- same company name for different users stays separate -----------------
{
  const rows = [
    { id: 'a1', user_id: USER_A, organization_id: ORG_A, account_name: 'Acme Manufacturing', upload_id: 'u1', updated_at: '2026-08-01T00:00:00Z', monitoring_status: 'active' },
    { id: 'b1', user_id: USER_B, organization_id: ORG_B, account_name: 'Acme Manufacturing', upload_id: 'u2', updated_at: '2026-08-01T00:00:00Z', monitoring_status: 'active' }
  ];
  const { groups, collisions } = groupAccountsForBackfill(rows);
  assert(collisions.length === 0, 'two different users each monitoring "Acme Manufacturing" is not a collision');
  assert(groups.length === 2, `REQUIRED: the same normalized company name for two different users produces two distinct target groups (got ${groups.length})`);
  assert(groups.some(g => g.userId === USER_A) && groups.some(g => g.userId === USER_B), 'both users are represented as separate groups');
}

// --- ambiguous same-user collision is detected, not silently merged -------
// Two DIFFERENT literal account names for the same user that happen to
// normalize to the same key -- by construction, since normalizeCompanyName()
// is deliberately non-fuzzy (only strips a fixed legal-suffix word list and
// punctuation, per company-identity.js), the only pairs this rule can ever
// catch are legal-suffix/punctuation variants like this one. That is a
// deliberate, conservative choice: this function does not try to guess
// whether a given collision is "obviously the same real company, safe to
// merge" versus "coincidentally similar, actually different companies" --
// distinguishing those is exactly the deferred Canonical Account Identity
// problem. It always refuses to pick, every time, which is the smallest
// safe Phase 1 behavior even though it means an unmonitored target until a
// human resolves it.
{
  const rows = [
    { id: 'c1', user_id: USER_A, organization_id: ORG_A, account_name: 'Acme Manufacturing', upload_id: 'u1', updated_at: '2026-08-01T00:00:00Z', monitoring_status: 'active' },
    { id: 'c2', user_id: USER_A, organization_id: ORG_A, account_name: 'Acme Manufacturing, Inc.', upload_id: 'u1', updated_at: '2026-08-02T00:00:00Z', monitoring_status: 'active' }
  ];
  assert(normalizeCompanyName('Acme Manufacturing') === normalizeCompanyName('Acme Manufacturing, Inc.'), 'test setup sanity: both literal names normalize to the same key');
  const { groups, collisions } = groupAccountsForBackfill(rows);
  assert(groups.length === 0, `REQUIRED: a colliding identity produces ZERO monitoring targets -- never guesses which name wins (got ${groups.length} groups)`);
  assert(collisions.length === 1, `REQUIRED: the collision is reported exactly once (got ${collisions.length})`);
  assert(collisions[0].literalNames.length === 2 && collisions[0].literalNames.includes('Acme Manufacturing') && collisions[0].literalNames.includes('Acme Manufacturing, Inc.'), 'the collision report names both conflicting literal account names');
}

// --- paused/archived status mapping ----------------------------------------
{
  const rows = [
    { id: 'p1', user_id: USER_A, organization_id: ORG_A, account_name: 'Paused Co', upload_id: 'u1', updated_at: '2026-08-01T00:00:00Z', monitoring_status: 'paused' },
    { id: 'a1', user_id: USER_A, organization_id: ORG_A, account_name: 'Archived Co', upload_id: 'u1', updated_at: '2026-08-01T00:00:00Z', monitoring_status: 'archived' },
    { id: 'n1', user_id: USER_A, organization_id: ORG_A, account_name: 'Normal Co', upload_id: 'u1', updated_at: '2026-08-01T00:00:00Z', monitoring_status: 'active' }
  ];
  const { groups } = groupAccountsForBackfill(rows);
  const byName = Object.fromEntries(groups.map(g => [g.displayAccountName, g.status]));
  assert(byName['Paused Co'] === 'paused', 'a paused account produces a paused target, not an active one');
  assert(byName['Archived Co'] === 'removed', 'an archived account produces a removed target');
  assert(byName['Normal Co'] === 'active', 'an ordinary active account produces an active target');
}

// --- blank/unnormalizable names are skipped, not defaulted ----------------
{
  const rows = [
    { id: 'z1', user_id: USER_A, organization_id: ORG_A, account_name: '   ...   ', upload_id: 'u1', updated_at: '2026-08-01T00:00:00Z', monitoring_status: 'active' }
  ];
  const { groups, collisions } = groupAccountsForBackfill(rows);
  assert(groups.length === 0 && collisions.length === 0, 'an account name that normalizes to nothing is skipped, not turned into a group or a collision');
}

// --- backfill plan idempotency ---------------------------------------------
{
  const rows = [
    { id: 'x1', user_id: USER_A, organization_id: ORG_A, account_name: 'Idempotent Co', upload_id: 'u1', updated_at: '2026-08-01T00:00:00Z', monitoring_status: 'active' }
  ];
  const { groups } = groupAccountsForBackfill(rows);
  const now = Date.now();

  const firstRun = buildBackfillPlan({ groups, existingKeys: new Set(), now });
  assert(firstRun.toInsert.length === 1, 'REQUIRED: first backfill run against an empty existing set inserts the new identity');
  assert(firstRun.alreadyPresentCount === 0, 'nothing is already present on the first run');

  const existingKeysAfterFirstRun = new Set(firstRun.toInsert.map(row => identityKey(row.user_id, row.normalized_company_name)));
  const secondRun = buildBackfillPlan({ groups, existingKeys: existingKeysAfterFirstRun, now: now + 60000 });
  assert(secondRun.toInsert.length === 0, `REQUIRED: re-running the backfill against the same groups once the identity already exists inserts nothing (got ${secondRun.toInsert.length})`);
  assert(secondRun.alreadyPresentCount === 1, 'REQUIRED: the re-run correctly reports the identity as already present rather than silently skipping it uncounted');
}

// --- backfill plan never touches an already-present identity's fields -----
{
  const rows = [
    { id: 'y1', user_id: USER_A, organization_id: ORG_A, account_name: 'Untouched Co', upload_id: 'u-new', updated_at: '2026-08-10T00:00:00Z', monitoring_status: 'paused' }
  ];
  const { groups } = groupAccountsForBackfill(rows);
  const existingKeys = new Set([identityKey(USER_A, normalizeCompanyName('Untouched Co'))]);
  const plan = buildBackfillPlan({ groups, existingKeys, now: Date.now() });
  assert(plan.toInsert.length === 0, 'REQUIRED: an already-present target is never re-inserted/updated even if the underlying account row changed status since it was first backfilled (that sync is explicitly future-phase work)');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
