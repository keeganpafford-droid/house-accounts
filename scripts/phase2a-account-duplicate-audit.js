// Phase 2A implementation-review item 3 — read-only duplicate audit for
// public.ha_accounts, run BEFORE supabase-schema-migration-4 is ever applied.
// Reports exact-name duplicates and normalized-name duplicates SEPARATELY
// (they are different questions with different implications), and simulates
// exactly which rows the migration's de-duplication step would remove
// (keep earliest per (upload_id, account_name), same ranking the migration
// itself uses) without deleting or modifying anything.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
// This has NOT been run against production from this session (no database
// connection available here) — run it manually and review the output before
// deciding whether/how to apply the migration.
//
// Usage:
//   node scripts/phase2a-account-duplicate-audit.js
//   node scripts/phase2a-account-duplicate-audit.js --company=Avidia
import { normalizeCompany } from '../api/signal-intelligence.js';

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
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: options.prefer || 'return=representation', ...(options.headers || {}) }
  });
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!resp.ok) { const msg = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data)); throw new Error(`Supabase ${resp.status}: ${msg}`); }
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  const companyArg = args.find(a => a.startsWith('--company='));
  const company = companyArg ? companyArg.split('=').slice(1).join('=') : null;

  let path = 'ha_accounts?select=id,user_id,upload_id,account_name,created_at,updated_at&order=upload_id,account_name,created_at&limit=50000';
  if (company) path += `&account_name=ilike.*${encodeURIComponent(company)}*`;
  const rows = await supabase(path);
  const all = Array.isArray(rows) ? rows : [];
  console.log(`Scanned ${all.length} ha_accounts rows${company ? ` matching --company=${company}` : ''}.\n`);

  // ---------------------------------------------------------------------
  // 1. Exact-name duplicates: (upload_id, account_name) raw string match.
  // This is what the migration's unique constraint targets directly, and
  // what the confirmed production race actually produced.
  // ---------------------------------------------------------------------
  const exactGroups = new Map();
  for (const row of all) {
    const key = `${row.upload_id}|${row.account_name}`;
    if (!exactGroups.has(key)) exactGroups.set(key, []);
    exactGroups.get(key).push(row);
  }
  const exactDuplicateGroups = [...exactGroups.values()].filter(g => g.length > 1);
  console.log('=== 1. EXACT-NAME duplicates (upload_id, account_name) ===');
  console.log(`${exactDuplicateGroups.length} group(s) with more than one row sharing the exact same account_name within the same upload_id.\n`);
  for (const g of exactDuplicateGroups) {
    console.log(`upload_id=${g[0].upload_id}  account_name="${g[0].account_name}"  (${g.length} rows)`);
    g.forEach(r => console.log(`  id=${r.id} created_at=${r.created_at} updated_at=${r.updated_at}`));
  }

  // ---------------------------------------------------------------------
  // 2. Normalized-name duplicates: same normalizeCompany() output within
  // the same upload_id, but NOT necessarily identical raw strings (e.g.
  // "ABC LLC" vs "ABC Inc" vs "ABC, Inc."). Reported separately because the
  // migration's constraint does NOT catch or affect these, and collapsing
  // them is a separate, broader decision (see the long-term identity model
  // note below) — this section exists purely for visibility, not action.
  // ---------------------------------------------------------------------
  const normGroups = new Map();
  for (const row of all) {
    const key = `${row.upload_id}|${normalizeCompany(row.account_name)}`;
    if (!normGroups.has(key)) normGroups.set(key, []);
    normGroups.get(key).push(row);
  }
  const normDuplicateGroups = [...normGroups.values()].filter(g => g.length > 1 && new Set(g.map(r => r.account_name)).size > 1);
  console.log(`\n=== 2. NORMALIZED-NAME duplicates (upload_id, normalizeCompany(account_name)), excluding exact-name matches already counted above ===`);
  console.log(`${normDuplicateGroups.length} group(s) where two or more DIFFERENTLY-SPELLED account_name values normalize to the same company within the same upload_id.\n`);
  for (const g of normDuplicateGroups) {
    console.log(`upload_id=${g[0].upload_id}  normalized="${normalizeCompany(g[0].account_name)}"`);
    g.forEach(r => console.log(`  id=${r.id} account_name="${r.account_name}" created_at=${r.created_at}`));
  }

  // ---------------------------------------------------------------------
  // 3. Simulated migration delete-candidates: for each exact-name duplicate
  // group, the migration keeps the EARLIEST row (by created_at, then id) and
  // would remove the rest. This is a dry run only -- nothing is deleted or
  // written anywhere by this script.
  // ---------------------------------------------------------------------
  console.log(`\n=== 3. Migration delete-candidate simulation (dry run, nothing deleted) ===`);
  let wouldDeleteCount = 0;
  const deleteCandidates = [];
  for (const g of exactDuplicateGroups) {
    const sorted = [...g].sort((a, b) => {
      const ta = new Date(a.created_at).getTime(), tb = new Date(b.created_at).getTime();
      if (ta !== tb) return ta - tb;
      return String(a.id).localeCompare(String(b.id));
    });
    const keep = sorted[0];
    const remove = sorted.slice(1);
    wouldDeleteCount += remove.length;
    console.log(`upload_id=${g[0].upload_id} account_name="${g[0].account_name}": KEEP id=${keep.id} (created_at=${keep.created_at}), REMOVE ${remove.length} row(s): ${remove.map(r => r.id).join(', ')}`);
    remove.forEach(r => deleteCandidates.push({ ...r, kept_row_id: keep.id }));
  }
  console.log(`\nTotal rows the migration's de-duplication step would remove: ${wouldDeleteCount}`);
  console.log(deleteCandidates.length ? 'Full delete-candidate list (also what would be written to ha_accounts_dedup_audit, see migration §2):' : 'No rows would be removed -- the exact-name unique constraint can be added with zero data loss.');
  deleteCandidates.forEach(r => console.log(`  DELETE candidate: id=${r.id} upload_id=${r.upload_id} account_name="${r.account_name}" created_at=${r.created_at} (kept row: ${r.kept_row_id})`));

  console.log(`\n=== Summary ===`);
  console.log(`Exact-name duplicate rows to be removed by the migration: ${wouldDeleteCount}`);
  console.log(`Normalized-name-only duplicate groups (NOT touched by the migration, informational only): ${normDuplicateGroups.length}`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
