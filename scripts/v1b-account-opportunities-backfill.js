// Organizational Learning V1B: ONE-TIME, bounded materialization of
// ha_account_opportunities for every EXISTING ha_accounts row. Run once at
// V1B launch (after migration 12 is applied) so every Follow-Up/Repeat-
// Pattern opportunity already visible on the dashboard today becomes
// feedbackable immediately -- not lazily, on whatever future account
// upload happens to touch it (explicit founder instruction). Uses the
// exact same reconcileAccountOpportunities() reconciliation logic every
// future account save runs through (api/save-upload.js), so this is not a
// separate, parallel materialization path -- it is the SAME logic, run
// once, over every account instead of one at a time as saves happen.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
// This has NOT been run against production from this session (per explicit
// instruction: build and test, do not run the production backfill yet).
// Confirmed safe to run repeatedly -- reconcileAccountOpportunities() is
// idempotent (same fingerprint -> same row, evidence refreshed in place),
// so a partial run or a rerun after a fix never creates duplicates.
//
// Usage:
//   node scripts/v1b-account-opportunities-backfill.js            (live run)
//   node scripts/v1b-account-opportunities-backfill.js --dry-run   (report only, no writes)
import { deriveAccountOpportunities } from '../api/lib/account-opportunities.js';
import { reconcileAccountOpportunities } from '../api/lib/account-opportunity-reconciliation.js';

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
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? 'DRY RUN -- no writes will be made.\n' : 'LIVE RUN -- ha_account_opportunities will be written.\n');

  const rows = await supabase('ha_accounts?select=id,user_id,upload_id,account_name,raw_data&order=user_id,account_name&limit=50000');
  const accounts = Array.isArray(rows) ? rows : [];
  console.log(`Scanned ${accounts.length} ha_accounts rows.\n`);

  let processed = 0;
  let repeatPatternFound = 0;
  let followUpFound = 0;
  let errors = 0;

  for (const account of accounts) {
    processed += 1;
    try {
      if (dryRun) {
        const computed = deriveAccountOpportunities(account.account_name, account.raw_data);
        repeatPatternFound += computed.filter(c => c.opportunityType === 'repeat_pattern').length;
        followUpFound += computed.filter(c => c.opportunityType === 'follow_up').length;
      } else {
        const results = await reconcileAccountOpportunities(supabase, {
          userId: account.user_id, uploadId: account.upload_id, accountName: account.account_name, rawData: account.raw_data
        });
        repeatPatternFound += results.filter(r => r && r.opportunity_type === 'repeat_pattern').length;
        followUpFound += results.filter(r => r && r.opportunity_type === 'follow_up').length;
      }
    } catch (err) {
      errors += 1;
      console.warn(`  [error] account_id=${account.id} account_name=${account.account_name}: ${err.message}`);
    }
    if (processed % 25 === 0) console.log(`  ...${processed}/${accounts.length} accounts processed`);
  }

  console.log(`\nDone. ${processed} accounts processed, ${repeatPatternFound} repeat_pattern opportunities, ${followUpFound} follow_up opportunities, ${errors} errors.`);
  if (errors > 0) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
