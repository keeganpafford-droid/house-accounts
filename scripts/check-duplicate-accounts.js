// Priority 0, Requirement 6 — checks whether the same company exists as more
// than one ha_accounts row within a single upload. This is the upstream
// condition that let duplicate events land in separate weekly-scan.js
// research-batch chunks (see api/weekly-scan.js batchSize chunking). Read-only.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
// This has NOT been run against production from this session (no database
// credentials/connection available here) — run it manually to confirm
// whether Avidia Bank actually has duplicate ha_accounts rows, and whether
// this looks like expected account-history behavior, duplicate uploaded
// customer data, or an ingestion bug.
//
// Usage:
//   node scripts/check-duplicate-accounts.js
//   node scripts/check-duplicate-accounts.js --company=Avidia
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
    throw new Error(`Supabase ${resp.status}: ${msg}`);
  }
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  const companyArg = args.find(a => a.startsWith('--company='));
  const company = companyArg ? companyArg.split('=').slice(1).join('=') : null;

  let path = 'ha_accounts?select=id,user_id,upload_id,account_name,created_at,updated_at&order=upload_id,account_name&limit=20000';
  if (company) path += `&account_name=ilike.*${encodeURIComponent(company)}*`;
  const rows = await supabase(path);

  const groups = new Map();
  for (const row of rows || []) {
    const key = `${row.upload_id}|${normalizeCompany(row.account_name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const duplicateGroups = [...groups.values()].filter(g => g.length > 1);
  console.log(`Scanned ${(rows || []).length} ha_accounts rows${company ? ` matching --company=${company}` : ''}.`);
  console.log(`Found ${duplicateGroups.length} upload(s) with more than one account row for the same normalized company name.\n`);
  for (const g of duplicateGroups) {
    console.log(`upload_id=${g[0].upload_id}  normalized_company="${normalizeCompany(g[0].account_name)}"`);
    for (const r of g) {
      console.log(`  id=${r.id} account_name="${r.account_name}" created_at=${r.created_at} updated_at=${r.updated_at}`);
    }
    console.log('');
  }
  if (!duplicateGroups.length) console.log('No duplicate account rows found in the scanned uploads.');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
