// Organizational Learning V1B: deterministic coverage for
// reconcileAccountOpportunities() -- the one function api/save-upload.js's
// post-snapshot hook and the one-time backfill script both call. Uses a
// small in-memory mock of the ha_account_opportunities table (same PostgREST-
// style query/patch semantics scripts/test-signal-events.js already mocks),
// not a real database.
//
// Usage: node scripts/test-account-opportunity-reconciliation.js
import { reconcileAccountOpportunities } from '../api/lib/account-opportunity-reconciliation.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function parseQuery(url) {
  const qIndex = url.indexOf('?');
  const query = qIndex === -1 ? '' : url.slice(qIndex + 1);
  const params = new URLSearchParams(query);
  const filters = {};
  for (const [key, value] of params.entries()) {
    if (key === 'select') continue;
    filters[key] = value;
  }
  return filters;
}
function matchValue(rowValue, filterValue) {
  if (filterValue.startsWith('eq.')) return String(rowValue ?? '') === decodeURIComponent(filterValue.slice(3));
  if (filterValue.startsWith('in.(')) {
    const inner = filterValue.slice(4, -1);
    const values = inner.split(',').map(v => decodeURIComponent(v.replace(/^"|"$/g, '')));
    return values.includes(String(rowValue ?? ''));
  }
  return true;
}

function makeMockSb(table) {
  let nextId = 1;
  return async (path, options = {}) => {
    const method = options.method || 'GET';
    const filters = parseQuery(path);
    if (method === 'POST') {
      const body = JSON.parse(options.body);
      const inserted = body.map(row => {
        const full = { id: `opp-${nextId++}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), superseded_at: null, superseded_by_id: null, ...row };
        table.push(full);
        return full;
      });
      return inserted;
    }
    if (method === 'PATCH') {
      const body = JSON.parse(options.body);
      const matches = table.filter(row => Object.entries(filters).every(([k, v]) => matchValue(row[k], v)));
      matches.forEach(row => Object.assign(row, body));
      return matches;
    }
    return table.filter(row => Object.entries(filters).every(([k, v]) => matchValue(row[k], v)));
  };
}

async function run() {
  // ---------------------------------------------------------------------
  // Fresh account: nothing persisted yet -- inserts new active rows.
  // ---------------------------------------------------------------------
  {
    const table = [];
    const sb = makeMockSb(table);
    const rawData = {
      purchases: [
        { category: 'Apparel', revenue: 2000, dateStr: '2024-03-10' },
        { category: 'Apparel', revenue: 2400, dateStr: '2025-03-15' }
      ]
    };
    const results = await reconcileAccountOpportunities(sb, { userId: 'user-1', uploadId: 'upload-1', accountName: 'Acme Co', rawData });
    assert(results.length === 2, `REQUIRED: a fresh account with a qualifying pattern produces both a repeat_pattern and a follow_up row (got ${results.length})`);
    assert(table.every(r => r.status === 'active'), 'REQUIRED: every freshly-created row starts active');
    assert(table.filter(r => r.opportunity_type === 'repeat_pattern').length === 1, 'exactly one repeat_pattern row for the one qualifying category');
  }

  // ---------------------------------------------------------------------
  // Idempotency: rerunning reconciliation with UNCHANGED purchase data
  // updates the SAME rows, never inserts duplicates.
  // ---------------------------------------------------------------------
  {
    const table = [];
    const sb = makeMockSb(table);
    const rawData = { purchases: [
      { category: 'Apparel', revenue: 2000, dateStr: '2024-03-10' },
      { category: 'Apparel', revenue: 2400, dateStr: '2025-03-15' }
    ] };
    const first = await reconcileAccountOpportunities(sb, { userId: 'user-1', uploadId: 'upload-1', accountName: 'Acme Co', rawData });
    const second = await reconcileAccountOpportunities(sb, { userId: 'user-1', uploadId: 'upload-1', accountName: 'Acme Co', rawData });
    assert(table.length === 2, `REQUIRED: rerunning reconciliation on unchanged data never inserts duplicates (got ${table.length} total rows)`);
    assert(first.find(r => r.opportunity_type === 'repeat_pattern').id === second.find(r => r.opportunity_type === 'repeat_pattern').id, 'REQUIRED: the same instance id is reused across reruns, not a new one');
  }

  // ---------------------------------------------------------------------
  // Supersession: a NEW, later purchase in the same category creates a new
  // instance and supersedes the old one -- exactly one active at a time.
  // ---------------------------------------------------------------------
  {
    const table = [];
    const sb = makeMockSb(table);
    const cycle2026 = { purchases: [
      { category: 'Apparel', revenue: 2000, dateStr: '2024-03-10' },
      { category: 'Apparel', revenue: 2400, dateStr: '2025-03-15' }
    ] };
    const first = await reconcileAccountOpportunities(sb, { userId: 'user-1', uploadId: 'upload-1', accountName: 'Acme Co', rawData: cycle2026 });
    const originalInstanceId = first.find(r => r.opportunity_type === 'repeat_pattern').id;

    const cycle2027 = { purchases: [
      ...cycle2026.purchases,
      { category: 'Apparel', revenue: 2600, dateStr: '2026-04-02' }
    ] };
    const second = await reconcileAccountOpportunities(sb, { userId: 'user-1', uploadId: 'upload-1', accountName: 'Acme Co', rawData: cycle2027 });
    const newInstance = second.find(r => r.opportunity_type === 'repeat_pattern');

    assert(newInstance.id !== originalInstanceId, 'REQUIRED: a new, later purchase in the pattern category creates a genuinely NEW instance id');
    const original = table.find(r => r.id === originalInstanceId);
    assert(original.status === 'superseded', `REQUIRED: the original 2026 instance is marked superseded, not left looking active (got ${original.status})`);
    assert(original.superseded_by_id === newInstance.id, 'REQUIRED: the superseded row records exactly which instance replaced it');
    assert(newInstance.status === 'active', 'the new 2027 instance is active');
    const activeRepeatPatternRows = table.filter(r => r.opportunity_type === 'repeat_pattern' && r.status === 'active');
    assert(activeRepeatPatternRows.length === 1, `REQUIRED: exactly one active repeat_pattern row for this family at any time (got ${activeRepeatPatternRows.length})`);
    assert(original.family_fingerprint === newInstance.family_fingerprint, 'sanity: both instances share the same evergreen family');
    assert(original.fingerprint !== newInstance.fingerprint, 'sanity: the two instances have different fingerprints');
  }

  // ---------------------------------------------------------------------
  // Inactive transition: evidence that no longer qualifies goes inactive,
  // not deleted -- history is preserved.
  // ---------------------------------------------------------------------
  {
    const table = [];
    const sb = makeMockSb(table);
    const withPattern = { purchases: [
      { category: 'Apparel', revenue: 2000, dateStr: '2024-03-10' },
      { category: 'Apparel', revenue: 2400, dateStr: '2025-03-15' }
    ] };
    const first = await reconcileAccountOpportunities(sb, { userId: 'user-1', uploadId: 'upload-1', accountName: 'Acme Co', rawData: withPattern });
    const patternId = first.find(r => r.opportunity_type === 'repeat_pattern').id;

    // A corrected upload removes the Apparel evidence entirely (down to a
    // single purchase, below findRepeatPatternGroups()'s 2-order minimum).
    const corrected = { purchases: [{ category: 'Apparel', revenue: 2000, dateStr: '2024-03-10' }] };
    await reconcileAccountOpportunities(sb, { userId: 'user-1', uploadId: 'upload-1', accountName: 'Acme Co', rawData: corrected });

    const row = table.find(r => r.id === patternId);
    assert(row.status === 'inactive', `REQUIRED: a family no longer supported by current evidence goes inactive (got ${row.status})`);
    assert(table.some(r => r.id === patternId), 'REQUIRED: the row still exists -- never deleted, history preserved');
  }

  // ---------------------------------------------------------------------
  // Cross-account isolation: reconciling one account never touches
  // another account's rows, even under the same user.
  // ---------------------------------------------------------------------
  {
    const table = [];
    const sb = makeMockSb(table);
    const rawData = { purchases: [
      { category: 'Apparel', revenue: 1000, dateStr: '2024-01-01' },
      { category: 'Apparel', revenue: 1100, dateStr: '2025-01-01' }
    ] };
    await reconcileAccountOpportunities(sb, { userId: 'user-1', uploadId: 'upload-1', accountName: 'Acme Co', rawData });
    await reconcileAccountOpportunities(sb, { userId: 'user-1', uploadId: 'upload-2', accountName: 'Beta Inc', rawData });
    const acmeRows = table.filter(r => r.account_name === 'Acme Co');
    const betaRows = table.filter(r => r.account_name === 'Beta Inc');
    assert(acmeRows.length === 2 && betaRows.length === 2, `REQUIRED: two distinct accounts under the same user each get their own rows, none shared (got Acme=${acmeRows.length}, Beta=${betaRows.length})`);
    assert(acmeRows[0].family_fingerprint !== betaRows[0].family_fingerprint, 'REQUIRED: different accounts never share a family_fingerprint, even with identical purchase data');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
