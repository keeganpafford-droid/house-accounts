// Priority 0 — backfills ha_signals.event_fingerprint for rows written
// before this fix, from each row's stored `payload`. Non-destructive: only
// ever sets event_fingerprint on rows where it is currently NULL.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
// This has NOT been run against production from this session (no database
// credentials/connection available here) — run it manually, or once the
// Supabase MCP connection is authorized for this session.
//
// Usage:
//   node scripts/backfill-event-fingerprint.js --dry-run
//   node scripts/backfill-event-fingerprint.js
//   node scripts/backfill-event-fingerprint.js --batch-size=500
import { resolveOpportunityEvents } from '../api/signal-intelligence.js';

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
    err.body = data;
    throw err;
  }
  return data;
}

// Reconstructs an opportunity-shaped object from a stored row so the exact
// same resolveOpportunityEvents() logic production uses today produces the
// exact same fingerprint format for old rows.
function computeFingerprint(row) {
  const payload = row.payload || {};
  const opportunity = {
    ...payload,
    accountName: payload.accountName || row.account_name,
    companyName: payload.companyName || payload.accountName || row.account_name,
    headline: payload.headline || payload.signalTitle || row.title,
    whatChanged: payload.whatChanged || payload.businessContext || row.title,
    sourceUrl: payload.sourceUrl || row.source_url,
    publishedAt: payload.publishedAt || payload.eventDate || row.published_at,
    signalFamily: payload.signalFamily
  };
  const [resolved] = resolveOpportunityEvents([opportunity]);
  return resolved?.eventFingerprint || null;
}

function isUniqueViolation(err) {
  return err?.status === 409 || /23505|duplicate key/i.test(String(err?.message || ''));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const batchArg = args.find(a => a.startsWith('--batch-size='));
  const batchSize = batchArg ? Number(batchArg.split('=')[1]) : 200;

  let offset = 0;
  let scanned = 0, updated = 0, skippedNoFingerprint = 0;
  const conflicts = [];

  for (;;) {
    const rows = await supabase(
      `ha_signals?select=id,user_id,upload_id,account_name,title,source_url,published_at,payload,event_fingerprint` +
      `&event_fingerprint=is.null&order=id&limit=${batchSize}&offset=${offset}`
    );
    if (!Array.isArray(rows) || !rows.length) break;

    for (const row of rows) {
      scanned += 1;
      const fingerprint = computeFingerprint(row);
      if (!fingerprint) { skippedNoFingerprint += 1; continue; }
      if (dryRun) { updated += 1; continue; }
      try {
        await supabase(`ha_signals?id=eq.${encodeURIComponent(row.id)}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ event_fingerprint: fingerprint })
        });
        updated += 1;
      } catch (err) {
        if (isUniqueViolation(err)) {
          // This row's real-world event already has an event_fingerprint on
          // another row for the same user+upload — i.e. it IS one of the
          // pre-existing duplicate-event rows this sprint is about. Leave it
          // NULL; do not guess which row should "win" here. That decision
          // belongs to scripts/find-duplicate-signals.js's report and human
          // review, not to this backfill.
          conflicts.push({ id: row.id, user_id: row.user_id, upload_id: row.upload_id, account_name: row.account_name, title: row.title, attemptedFingerprint: fingerprint });
        } else {
          throw err;
        }
      }
    }
    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  console.log(JSON.stringify({ dryRun, scanned, updated, skippedNoFingerprint, conflictCount: conflicts.length, conflicts }, null, 2));
  if (conflicts.length) {
    console.error(`\n${conflicts.length} row(s) could not be backfilled because they collide with an already-backfilled duplicate.`);
    console.error('Run scripts/find-duplicate-signals.js for the full report before deciding how to resolve them.');
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
