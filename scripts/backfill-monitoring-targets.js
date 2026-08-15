// Phase 1 monitoring-architecture foundation — backfills ha_monitoring_targets
// from current ha_accounts rows. Purely additive: only ever INSERTs
// identities not already present (see api/lib/monitoring-targets.js's
// buildBackfillPlan() for why re-running this is always idempotent).
// Never updates an already-present target, never deletes anything.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
// This has NOT been run against production from this session via this
// script (no database credentials available in this sandbox) — the
// equivalent plan was computed and applied directly via the Supabase MCP
// connection instead; see the Phase 1 report for the actual production
// counts. This script is the reusable, tested source of truth for any
// future/CI run and for re-running the backfill after new accounts arrive.
//
// Usage:
//   node scripts/backfill-monitoring-targets.js --dry-run
//   node scripts/backfill-monitoring-targets.js --apply
import { groupAccountsForBackfill, buildBackfillPlan, identityKey } from '../api/lib/monitoring-targets.js';

function env() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return { url, key };
}

async function supabase(path, options = {}) {
  const { url, key } = env();
  const resp = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!resp.ok) {
    const msg = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data));
    const err = new Error(`Supabase ${resp.status}: ${msg}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// Fetched and joined in application code rather than a PostgREST embed --
// avoids depending on a specific declared FK-embed relationship between
// ha_accounts and ha_users existing/being named a particular way; both are
// simple, cheap, boundedly-sized selects at current beta scale.
async function loadAccountRowsWithOrg() {
  const [accounts, users] = await Promise.all([
    supabase('ha_accounts?select=id,user_id,account_name,upload_id,updated_at,raw_data&limit=50000'),
    supabase('ha_users?select=id,organization_id&limit=50000')
  ]);
  const orgByUser = new Map((users || []).map(u => [u.id, u.organization_id]));
  return (accounts || [])
    .map(a => ({
      id: a.id,
      user_id: a.user_id,
      organization_id: orgByUser.get(a.user_id) || null,
      account_name: a.account_name,
      upload_id: a.upload_id,
      updated_at: a.updated_at,
      monitoring_status: a?.raw_data?.monitoring_status || 'active'
    }))
    // An account row whose user has no resolvable organization_id cannot
    // produce a valid target (organization_id is NOT NULL on
    // ha_monitoring_targets) -- excluded and reported, not defaulted.
    .filter(a => a.organization_id != null);
}

async function loadExistingKeys() {
  const rows = await supabase('ha_monitoring_targets?select=user_id,normalized_company_name&limit=100000');
  return new Set((rows || []).map(r => identityKey(r.user_id, r.normalized_company_name)));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const accountRows = await loadAccountRowsWithOrg();
  const { groups, collisions } = groupAccountsForBackfill(accountRows);
  const existingKeys = await loadExistingKeys();
  const { toInsert, alreadyPresentCount } = buildBackfillPlan({ groups, existingKeys, now: Date.now() });

  const report = {
    apply,
    totalAccountRowsScanned: accountRows.length,
    candidateIdentityGroups: groups.length,
    alreadyPresentCount,
    toInsertCount: toInsert.length,
    collisionCount: collisions.length,
    collisions
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    console.log('\nDry run only -- no rows written. Re-run with --apply to insert.');
    return;
  }

  const inserted = [];
  const chunkSize = 200;
  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const chunk = toInsert.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const rows = await supabase('ha_monitoring_targets', {
      method: 'POST',
      prefer: 'return=representation',
      body: JSON.stringify(chunk)
    });
    inserted.push(...(Array.isArray(rows) ? rows : []));
  }

  console.log(JSON.stringify({ ...report, insertedCount: inserted.length }, null, 2));
  if (collisions.length) {
    console.error(`\n${collisions.length} identity collision(s) were detected and deliberately NOT backfilled -- no monitoring target was created for them.`);
    console.error('Resolve manually (decide the correct canonical name/account) before these accounts can be monitored under the new architecture.');
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
