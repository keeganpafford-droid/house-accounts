// Priority 0, Requirement 5 — read-only report of existing duplicate-event
// groups in ha_signals, using the composite identity (user_id, upload_id,
// event_fingerprint). Does NOT delete, merge, or modify any row.
//
// Works whether or not the backfill (scripts/backfill-event-fingerprint.js)
// has already run: if a row's event_fingerprint column is still NULL, this
// recomputes it on the fly from the row's stored payload for the purposes of
// this report only.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
// This has NOT been run against production from this session (no database
// credentials/connection available here).
//
// Usage:
//   node scripts/find-duplicate-signals.js
//   node scripts/find-duplicate-signals.js --company=Avidia
//   node scripts/find-duplicate-signals.js --company=Avidia --json
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
    throw new Error(`Supabase ${resp.status}: ${msg}`);
  }
  return data;
}

function computeFingerprint(row) {
  if (row.event_fingerprint) return row.event_fingerprint;
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

// Highest confidence wins; ties broken by earliest first_seen_at (the
// original discovery), then by id for determinism.
function chooseRetained(rows) {
  return [...rows].sort((a, b) => {
    const confDiff = Number(b.confidence || 0) - Number(a.confidence || 0);
    if (confDiff !== 0) return confDiff;
    const timeDiff = new Date(a.first_seen_at || 0) - new Date(b.first_seen_at || 0);
    if (timeDiff !== 0) return timeDiff;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

async function main() {
  const args = process.argv.slice(2);
  const companyArg = args.find(a => a.startsWith('--company='));
  const company = companyArg ? companyArg.split('=').slice(1).join('=') : null;
  const asJson = args.includes('--json');

  let path = 'ha_signals?select=id,user_id,upload_id,account_name,title,source_url,source_domain,confidence,payload,event_fingerprint,first_seen_at,last_seen_at&order=account_name,first_seen_at&limit=5000';
  if (company) path += `&account_name=ilike.*${encodeURIComponent(company)}*`;
  const rows = await supabase(path);

  // Grouped by (user_id, event_fingerprint) — matching the actual database
  // constraint (ha_signals_user_fingerprint_key). Deliberately NOT scoped by
  // upload_id: this also surfaces duplicates that came from a re-upload of
  // the same list under a different upload_id, not just same-upload
  // duplicates, per the "monitor companies, not uploads" identity decision.
  const groups = new Map();
  for (const row of rows || []) {
    const fingerprint = computeFingerprint(row);
    if (!fingerprint) continue;
    const key = `${row.user_id}|${fingerprint}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...row, _fingerprint: fingerprint });
  }

  const duplicateGroups = [...groups.values()].filter(g => g.length > 1);
  const report = duplicateGroups.map(group => {
    const retained = chooseRetained(group);
    const removedIds = group.filter(r => r.id !== retained.id).map(r => r.id);
    const uploadIds = [...new Set(group.map(r => r.upload_id))];
    return {
      account: retained.account_name,
      userId: retained.user_id,
      uploadIds,
      spansMultipleUploads: uploadIds.length > 1,
      eventFingerprint: retained._fingerprint,
      rowCount: group.length,
      rows: group.map(r => ({
        id: r.id,
        title: r.title,
        sourceUrl: r.source_url,
        sourceDomain: r.source_domain,
        confidence: r.confidence,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        retained: r.id === retained.id
      })),
      retainedRowId: retained.id,
      removedRowIds: removedIds,
      evidencePreservationPlan: removedIds.length
        ? `Do not delete automatically. Proposed cleanup: merge payload.sources[] (and any distinct source_url) from row(s) ${removedIds.join(', ')} into retained row ${retained.id}'s payload.sources[], keeping every distinct source URL as corroborating evidence, then archive (not hard-delete) row(s) ${removedIds.join(', ')}.`
        : ''
    };
  });

  if (asJson) {
    console.log(JSON.stringify({ totalRowsScanned: (rows || []).length, duplicateGroupCount: report.length, groups: report }, null, 2));
    return;
  }

  console.log(`Scanned ${(rows || []).length} ha_signals rows${company ? ` matching --company=${company}` : ''}.`);
  console.log(`Found ${report.length} duplicate event group(s).\n`);
  for (const g of report) {
    console.log(`Account: ${g.account}  (user_id=${g.userId}, upload_id(s)=${g.uploadIds.join(', ')}${g.spansMultipleUploads ? ' — SPANS MULTIPLE UPLOADS, likely a re-upload' : ''})`);
    console.log(`Event fingerprint: ${g.eventFingerprint}`);
    for (const r of g.rows) {
      console.log(`  ${r.retained ? '[RETAIN]' : '[REMOVE]'} id=${r.id} title="${r.title}" source=${r.sourceUrl} confidence=${r.confidence} first_seen=${r.firstSeenAt}`);
    }
    console.log(`  Evidence plan: ${g.evidencePreservationPlan}`);
    console.log('');
  }
  if (!report.length) console.log('No duplicate groups found in the scanned rows.');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
