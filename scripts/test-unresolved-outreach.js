// Notification & Outcome Loop V1 -- deterministic coverage for
// api/unresolved-outreach.js against the REAL, production-bound
// listUnresolvedOutreach()/handler exports (mocked Supabase fetch), same
// convention as scripts/test-signal-events.js. Proves: only genuinely
// "still open" outreach is returned (terminal outcomes excluded), grouping
// outcome_reported children by parent_event_id is correct even across
// multiple outreach attempts, and only two Supabase calls happen per
// request (no N+1).
//
// Usage: node scripts/test-unresolved-outreach.js
import handler, { listUnresolvedOutreach } from '../api/unresolved-outreach.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}

const NOW = new Date('2026-08-20T00:00:00.000Z');

function makeMockFetch(state) {
  return async (url, options = {}) => {
    const u = String(url);
    state.calls.push(u);
    if (u.includes('/auth/v1/user')) {
      return jsonResponse({ id: 'auth-1', email: 'rep@example.com' });
    }
    if (u.includes('/rest/v1/ha_users')) {
      return jsonResponse([{ id: 'user-1', auth_user_id: 'auth-1', email: 'rep@example.com', organization_id: 'org-1' }]);
    }
    if (u.includes('/rest/v1/ha_signal_events')) {
      if (u.includes('event_type=eq.outcome_reported')) {
        // parent_event_id=in.(...) filter -- return every outcome row
        // whose parent_event_id appears in the requested set.
        const match = /parent_event_id=in\.\(([^)]*)\)/.exec(u);
        const ids = match ? match[1].split(',') : [];
        return jsonResponse(state.outcomeEvents.filter(e => ids.includes(e.parent_event_id)));
      }
      // outreach_made/opportunity_outreach_made list.
      return jsonResponse(state.outreachEvents);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

async function withState(outreachEvents, outcomeEvents, fn) {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  const state = { outreachEvents, outcomeEvents, calls: [] };
  const realFetch = global.fetch;
  global.fetch = makeMockFetch(state);
  try { return await fn(state); }
  finally { global.fetch = realFetch; }
}

async function run() {
  // -------------------------------------------------------------------
  // No outreach at all -- empty list, and the outcome query is skipped
  // entirely (nothing to look up children for).
  // -------------------------------------------------------------------
  {
    const { items, calls } = await withState([], [], async (state) => {
      const items = await listUnresolvedOutreach('user-1', { now: NOW });
      return { items, calls: state.calls };
    });
    assert(Array.isArray(items) && items.length === 0, 'REQUIRED: zero outreach events produces an empty list, not an error');
    assert(calls.filter(c => c.includes('ha_signal_events')).length === 1, 'REQUIRED: with zero outreach, the outcome_reported lookup query never fires (no N+1 for nothing)');
  }

  // -------------------------------------------------------------------
  // Mixed states: never-reported (still open), no_response_yet (still
  // open), and a terminal outcome (closed) -- only the first two survive.
  // -------------------------------------------------------------------
  {
    const outreachEvents = [
      { id: 'or-1', event_fingerprint: 'fp-1', signal_id: 'sig-1', opportunity_id: null, account_name: 'Acme Co', created_at: new Date(NOW.getTime() - 6 * 86400000).toISOString() },
      { id: 'or-2', event_fingerprint: 'fp-2', signal_id: 'sig-2', opportunity_id: null, account_name: 'Beta Inc', created_at: new Date(NOW.getTime() - 10 * 86400000).toISOString() },
      { id: 'or-3', event_fingerprint: 'fp-3', signal_id: 'sig-3', opportunity_id: null, account_name: 'Gamma LLC', created_at: new Date(NOW.getTime() - 30 * 86400000).toISOString() }
    ];
    const outcomeEvents = [
      // or-2: reported no_response_yet -- still open.
      { parent_event_id: 'or-2', created_at: new Date(NOW.getTime() - 2 * 86400000).toISOString(), payload: { outcomeStatus: 'no_response_yet' } },
      // or-3: reported engaged -- terminal, closed.
      { parent_event_id: 'or-3', created_at: new Date(NOW.getTime() - 25 * 86400000).toISOString(), payload: { outcomeStatus: 'engaged' } }
      // or-1: no report at all -- still open.
    ];
    const { items, calls } = await withState(outreachEvents, outcomeEvents, async (state) => {
      const items = await listUnresolvedOutreach('user-1', { now: NOW });
      return { items, calls: state.calls };
    });
    const ids = items.map(i => i.outreachEventId).sort();
    assert(JSON.stringify(ids) === JSON.stringify(['or-1', 'or-2']), `REQUIRED: only the never-reported and no_response_yet outreach remain open -- the engaged one is excluded (got ${JSON.stringify(ids)})`);
    assert(items.find(i => i.outreachEventId === 'or-1').currentStatus === null, 'or-1 (never reported) has currentStatus null');
    assert(items.find(i => i.outreachEventId === 'or-2').currentStatus === 'no_response_yet', 'or-2 correctly reflects its latest no_response_yet report');
    assert(calls.filter(c => c.includes('ha_signal_events')).length === 2, 'REQUIRED: exactly two Supabase calls total (outreach list, then one batched outcome lookup) -- no N+1 per outreach item');
  }

  // -------------------------------------------------------------------
  // HTTP handler wiring: auth required, returns the same shape.
  // -------------------------------------------------------------------
  {
    const req = { method: 'GET', headers: {} };
    const res = makeRes();
    await withState([], [], async () => { await handler(req, res); });
    assert(res.statusCode === 401, `REQUIRED: no Authorization header is rejected 401 (got ${res.statusCode})`);
  }
  {
    const req = { method: 'GET', headers: { authorization: 'Bearer valid-token' } };
    const res = makeRes();
    await withState([{ id: 'or-1', event_fingerprint: 'fp-1', signal_id: 'sig-1', opportunity_id: null, account_name: 'Acme Co', created_at: new Date(NOW.getTime() - 6 * 86400000).toISOString() }], [], async () => { await handler(req, res); });
    assert(res.statusCode === 200 && Array.isArray(res.body?.items), `the GET handler returns ok:true with an items array (got ${JSON.stringify(res.body)})`);
  }
  {
    const req = { method: 'POST', headers: { authorization: 'Bearer valid-token' } };
    const res = makeRes();
    await handler(req, res);
    assert(res.statusCode === 405, `REQUIRED: only GET is allowed (got ${res.statusCode})`);
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
