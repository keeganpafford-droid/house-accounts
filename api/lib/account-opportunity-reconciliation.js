// Organizational Learning V1B: server-side reconciliation of
// ha_account_opportunities against an account's current purchase history.
// The one function api/save-upload.js's post-snapshot hook AND the
// one-time backfill script both call -- exactly one place this logic can
// drift, matching deriveAccountOpportunities() itself being the one place
// pattern-detection can drift (see api/lib/account-opportunities.js).
//
// `sb` is an injected async (path, options) => data function -- the same
// shape api/signal-events.js's own sb()/api/save-upload.js's supabase()
// helpers already use -- so this module has no direct dependency on either
// file's specific HTTP-calling convention, and tests can supply a mock
// exactly like scripts/test-signal-events.js already does.
//
// Ordering note: this performs several separate REST calls, not one
// atomic transaction (PostgREST doesn't expose multi-statement
// transactions the way the replace_ha_accounts_snapshot() RPC does for
// ha_accounts). The supersede-then-insert ordering below is chosen
// specifically so the database's own "at most one active row per family"
// partial unique index (migration 12) is never transiently violated. If a
// call fails partway through, the worst case is a family left briefly
// without an active row until the next reconciliation run recomputes and
// re-inserts it -- self-healing, and never produces two simultaneously
// active rows or lost feedback history. A future hardening pass could move
// this into a single Postgres RPC matching replace_ha_accounts_snapshot()'s
// pattern; not required for this correctness model to hold today.
import { deriveAccountOpportunities } from './account-opportunities.js';

function quoteList(values) {
  return values.map(v => `"${String(v).replace(/"/g, '')}"`).join(',');
}

export async function reconcileAccountOpportunities(sb, { userId, uploadId, accountName, rawData }) {
  const computed = deriveAccountOpportunities(accountName, rawData);
  const computedFingerprints = computed.map(c => c.fingerprint);
  const computedFamilies = new Set(computed.map(c => c.familyFingerprint));
  const now = () => new Date().toISOString();

  const existingByFingerprintRows = computedFingerprints.length
    ? await sb(`ha_account_opportunities?user_id=eq.${encodeURIComponent(userId)}&fingerprint=in.(${quoteList(computedFingerprints)})&select=*`, { method: 'GET' })
    : [];
  // Scoped by account, NOT by the currently-computed family list -- a
  // family that just dropped OUT of the computed set (its evidence no
  // longer qualifies) must still be found here so the inactive-transition
  // pass below can see it. Scoping this query to only the computed
  // families would make a dropped family invisible to that pass entirely.
  const existingActiveForAccountRows = await sb(`ha_account_opportunities?user_id=eq.${encodeURIComponent(userId)}&account_name=eq.${encodeURIComponent(accountName)}&status=eq.active&select=*`, { method: 'GET' });

  const byFingerprint = new Map((existingByFingerprintRows || []).map(r => [r.fingerprint, r]));
  const activeByFamily = new Map((existingActiveForAccountRows || []).map(r => [r.family_fingerprint, r]));

  const results = [];
  for (const c of computed) {
    const existing = byFingerprint.get(c.fingerprint);
    if (existing) {
      // The exact same instance is still current -- refresh its evidence
      // snapshot and reconfirm it as seen, never create a duplicate.
      const updated = await sb(`ha_account_opportunities?id=eq.${encodeURIComponent(existing.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          payload: c.payload, category: c.category, upload_id: uploadId || existing.upload_id,
          status: 'active', last_seen_at: now(), updated_at: now()
        })
      });
      results.push(Array.isArray(updated) ? updated[0] : updated);
      continue;
    }

    // No row for this exact instance yet. A different, currently-active
    // row for the SAME family means a genuinely new cycle has begun --
    // supersede it BEFORE inserting the new active row, so the database's
    // own "at most one active per family" constraint is never transiently
    // violated.
    const priorActive = activeByFamily.get(c.familyFingerprint);
    if (priorActive) {
      await sb(`ha_account_opportunities?id=eq.${encodeURIComponent(priorActive.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'superseded', superseded_at: now(), updated_at: now() })
      });
    }
    const inserted = await sb('ha_account_opportunities', {
      method: 'POST',
      body: JSON.stringify([{
        user_id: userId, upload_id: uploadId, account_name: accountName,
        opportunity_type: c.opportunityType, category: c.category,
        family_fingerprint: c.familyFingerprint, fingerprint: c.fingerprint,
        status: 'active', payload: c.payload
      }])
    });
    const newRow = Array.isArray(inserted) ? inserted[0] : inserted;
    results.push(newRow);
    if (priorActive) {
      await sb(`ha_account_opportunities?id=eq.${encodeURIComponent(priorActive.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ superseded_by_id: newRow.id })
      });
    }
  }

  // A family that WAS active but the current computation no longer
  // supports at all (the qualifying evidence disappeared -- e.g. a
  // purchase-history correction) goes inactive. Never deleted -- append-
  // only history is preserved regardless of current relevance.
  for (const [family, row] of activeByFamily) {
    if (!computedFamilies.has(family)) {
      await sb(`ha_account_opportunities?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'inactive', updated_at: now() })
      });
    }
  }

  return results;
}
