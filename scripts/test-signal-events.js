// Signal feedback / organizational-learning foundation: deterministic
// coverage for api/signal-events.js against the REAL, production-bound
// handler export (mocked Supabase fetch, in-memory tables), not a
// reimplementation. Covers: server-derived identity (never trusted from
// the body), organization-level signal-ownership validation, server-
// derived recommendation snapshots (never trusted from the browser),
// client_event_id request idempotency, semantic dedupe for
// signal_useful/signal_not_useful (a changed judgment is new history, a
// repeated identical one is not -- per the founder's explicit
// instruction, this file does NOT test that two separate same-state
// Useful clicks both persist), multiple legitimate outreach_made attempts
// with no arbitrary dedupe, approach_shared's tight same-rep parent-event
// scoping and note length limit, schema_version stamping, and the
// current-rep-only batched read-back.
//
// Post-verification-pass correction: POST now resolves the acted-on
// signal by signalId (the exact ha_signals row), never by
// event_fingerprint alone -- ha_signals only guarantees uniqueness per
// (user_id, event_fingerprint), not per account, so a bare fingerprint is
// not a safe write-resolution key. GET read-back is keyed by
// (event_fingerprint, account_name) together, for the same reason. This
// file's fixtures include two signals that deliberately SHARE a
// fingerprint but belong to different accounts (fp-collision-shared),
// modeling the exact collision the persistence layer does not prevent,
// and proves both POST and GET keep them apart. It also proves an
// approach note attached to an OLDER outreach attempt never leaks onto a
// NEWER attempt that has no note of its own yet.
//
// Usage: node scripts/test-signal-events.js
import handler, { readBackKey } from '../api/signal-events.js';

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
function makeReq({ method = 'POST', token = 'valid-token-a1', body, query } = {}) {
  return { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body, query };
}
function getKeys(...pairs) {
  return { keys: JSON.stringify(pairs.map(([eventFingerprint, accountName]) => ({ eventFingerprint, accountName }))) };
}

function parseQuery(url) {
  const qIndex = url.indexOf('?');
  const query = qIndex === -1 ? '' : url.slice(qIndex + 1);
  const params = new URLSearchParams(query);
  const filters = {};
  for (const [key, value] of params.entries()) {
    if (key === 'select' || key === 'order' || key === 'limit') continue;
    filters[key] = value;
  }
  return { params, filters };
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
function filterRows(rows, filters) {
  return rows.filter(row => Object.entries(filters).every(([key, value]) => matchValue(row[key], value)));
}
function applyOrderLimit(rows, params) {
  let out = [...rows];
  const order = params.get('order');
  if (order) {
    const [field, dir] = order.split('.');
    out.sort((a, b) => {
      if (a[field] === b[field]) return 0;
      return (a[field] > b[field] ? 1 : -1) * (dir === 'desc' ? -1 : 1);
    });
  }
  const limit = params.get('limit');
  if (limit) out = out.slice(0, Number(limit));
  return out;
}

function baseState() {
  return {
    nextEventId: 1,
    authUsers: new Map([
      ['valid-token-a1', { id: 'auth-a1', email: 'repa1@orga.example.com' }],
      ['valid-token-a2', { id: 'auth-a2', email: 'repa2@orga.example.com' }],
      ['valid-token-b1', { id: 'auth-b1', email: 'repb1@orgb.example.com' }],
      ['valid-token-no-org', { id: 'auth-no-org', email: 'noorg@example.com' }]
    ]),
    haUsers: [
      { id: 'user-a1', auth_user_id: 'auth-a1', email: 'repa1@orga.example.com', organization_id: 'org-a' },
      { id: 'user-a2', auth_user_id: 'auth-a2', email: 'repa2@orga.example.com', organization_id: 'org-a' },
      { id: 'user-b1', auth_user_id: 'auth-b1', email: 'repb1@orgb.example.com', organization_id: 'org-b' },
      { id: 'user-no-org', auth_user_id: 'auth-no-org', email: 'noorg@example.com', organization_id: null }
    ],
    haSignals: [
      { id: 'sig-a1', user_id: 'user-a1', event_fingerprint: 'fp-shared-account', account_name: 'Acme Co', payload: { signalType: 'Hiring Activity', title: 'Acme Co is hiring', commercialPlay: { narrative: 'Acme is scaling its ops team fast.' }, suggestedContact: 'VP Operations', activationIdeas: ['welcome kits', 'onboarding swag', 'branded laptop bags', 'a fourth idea that should be dropped'], conversationStarter: 'Saw the hiring push -- how are you handling onboarding kits these days?' } },
      { id: 'sig-a2', user_id: 'user-a2', event_fingerprint: 'fp-teammate-only', account_name: 'Beta Inc', payload: { signalType: 'Expansion', title: 'Beta Inc opens new office', commercialPlay: { narrative: 'Beta is opening a second location.' }, suggestedContact: 'Facilities Lead', activationIdeas: ['office signage'], conversationStarter: 'Congrats on the new office -- need signage?' } },
      { id: 'sig-b1', user_id: 'user-b1', event_fingerprint: 'fp-org-b-only', account_name: 'Gamma LLC', payload: { signalType: 'Award', title: 'Gamma LLC wins award' } },
      // Two DISTINCT real accounts whose event_fingerprint collides -- the
      // exact scenario ha_signals' (user_id, event_fingerprint)-only
      // uniqueness constraint does not structurally prevent. Different
      // signal ids, different account_name, same fingerprint.
      { id: 'sig-a3-collision', user_id: 'user-a1', event_fingerprint: 'fp-collision-shared', account_name: 'Anderson Group', payload: { signalType: 'Hiring Activity', title: 'Anderson Group is hiring' } },
      { id: 'sig-a4-collision', user_id: 'user-a1', event_fingerprint: 'fp-collision-shared', account_name: 'Anderson Consulting', payload: { signalType: 'Hiring Activity', title: 'Anderson Consulting is hiring' } }
    ],
    haAccountOpportunities: [],
    haSignalEvents: []
  };
}

function makeMockFetch(state) {
  return async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if (u.includes('/auth/v1/user')) {
      const token = String((options.headers || {}).Authorization || '').replace(/^Bearer\s+/, '');
      const authUser = state.authUsers.get(token);
      if (!authUser) return jsonResponse(null, false, 401);
      return jsonResponse(authUser);
    }
    const { filters, params } = parseQuery(u);
    if (u.includes('/rest/v1/ha_users')) {
      const rows = filterRows(state.haUsers, filters);
      if (method === 'PATCH') { const body = JSON.parse(options.body); rows.forEach(r => Object.assign(r, body)); return jsonResponse(rows); }
      return jsonResponse(applyOrderLimit(rows, params));
    }
    if (u.includes('/rest/v1/ha_signals')) {
      return jsonResponse(applyOrderLimit(filterRows(state.haSignals, filters), params));
    }
    if (u.includes('/rest/v1/ha_account_opportunities')) {
      return jsonResponse(applyOrderLimit(filterRows(state.haAccountOpportunities, filters), params));
    }
    if (u.includes('/rest/v1/ha_signal_events')) {
      if (method === 'POST') {
        const body = JSON.parse(options.body);
        const inserted = body.map(row => {
          const full = { id: `event-${state.nextEventId++}`, created_at: new Date(Date.now() + state.nextEventId).toISOString(), ...row };
          state.haSignalEvents.push(full);
          return full;
        });
        return jsonResponse(inserted);
      }
      return jsonResponse(applyOrderLimit(filterRows(state.haSignalEvents, filters), params));
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
}

async function withState(fn) {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  const state = baseState();
  const realFetch = global.fetch;
  global.fetch = makeMockFetch(state);
  try { return await fn(state); }
  finally { global.fetch = realFetch; }
}

async function run() {
  // ---------------------------------------------------------------------
  // Auth required.
  // ---------------------------------------------------------------------
  {
    const { res } = await withState(async () => {
      const req = makeReq({ token: null, body: { eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'c-1' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 401, `REQUIRED: a request with no Authorization header is rejected 401 (got ${res.statusCode})`);
  }

  // ---------------------------------------------------------------------
  // organization_id required.
  // ---------------------------------------------------------------------
  {
    const { res } = await withState(async () => {
      const req = makeReq({ token: 'valid-token-no-org', body: { eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'c-1' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `REQUIRED: a rep with no organization cannot write an event (got ${res.statusCode})`);
  }

  // ---------------------------------------------------------------------
  // Unknown eventType / outcome_reported rejected / missing clientEventId
  // / missing signalId.
  // ---------------------------------------------------------------------
  {
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'made_up_event', signalId: 'sig-a1', clientEventId: 'c-1' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `unknown eventType is rejected 400 (got ${res.statusCode})`);
  }
  {
    // outcome_reported with no parentEventId at all (distinct from the
    // dedicated outcome_reported test block below, which covers the real
    // parent-linkage/status-enum behavior).
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'outcome_reported', outcomeStatus: 'engaged', clientEventId: 'c-1' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `an outcome_reported with no parentEventId is rejected 400 (got ${res.statusCode})`);
  }
  {
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'signal_useful', signalId: 'sig-a1' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `missing clientEventId is rejected 400 (got ${res.statusCode})`);
  }
  {
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'signal_useful', clientEventId: 'c-no-signal-id' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `REQUIRED: missing signalId is rejected 400 -- event_fingerprint alone is never accepted as a write-resolution key (got ${res.statusCode})`);
  }

  // ---------------------------------------------------------------------
  // Organization-level signal resolution: rejects a signalId outside the
  // caller's organization, accepts one owned by a TEAMMATE (not the
  // caller's own row) within the same organization. A client-supplied
  // eventFingerprint is never trusted for resolution or storage -- both
  // are derived from the resolved ha_signals row only.
  // ---------------------------------------------------------------------
  {
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'signal_useful', signalId: 'sig-b1', clientEventId: 'c-cross-org' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 404, `REQUIRED: a signalId belonging to a DIFFERENT organization is rejected 404, not written (got ${res.statusCode})`);
  }
  {
    const { res, ev } = await withState(async (state) => {
      const req = makeReq({ token: 'valid-token-a1', body: {
        eventType: 'signal_selected', signalId: 'sig-a2', clientEventId: 'c-teammate',
        // Spoofed fields -- must be entirely ignored; the resolved row's
        // own event_fingerprint/account_name are what get stored.
        eventFingerprint: 'attacker-supplied-fingerprint', accountName: 'attacker-supplied-account-name'
      } });
      const res = makeRes();
      await handler(req, res);
      return { res, ev: state.haSignalEvents[0] };
    });
    assert(res.statusCode === 200, `REQUIRED: a signalId owned by a TEAMMATE in the same organization resolves successfully (org-level, not current-user-only) (got ${res.statusCode})`);
    assert(ev.user_id === 'user-a1', 'the event is recorded under the ACTING rep (user-a1), not the teammate who owns the signal row');
    assert(ev.organization_id === 'org-a', 'the event carries the acting rep\'s own organization_id');
    assert(ev.account_name === 'Beta Inc', 'REQUIRED: account_name is derived from the resolved ha_signals row, never from client-supplied accountName ("attacker-supplied-account-name" is ignored)');
    assert(ev.event_fingerprint === 'fp-teammate-only', 'REQUIRED: event_fingerprint is derived from the resolved ha_signals row, never from client-supplied eventFingerprint ("attacker-supplied-fingerprint" is ignored)');
    assert(ev.signal_id === 'sig-a2', 'the event carries the exact signal_id resolved, matching what the rep actually saw');
  }
  {
    // A signalId that simply does not exist.
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'signal_useful', signalId: 'sig-does-not-exist', clientEventId: 'c-missing-signal' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 404, `a signalId with no matching ha_signals row is rejected 404 (got ${res.statusCode})`);
  }

  // ---------------------------------------------------------------------
  // Fingerprint collision across two distinct accounts: a write against
  // one of the two colliding signal rows must never be attributable to
  // the other merely because they share event_fingerprint.
  // ---------------------------------------------------------------------
  {
    const { evGroup, evConsulting } = await withState(async (state) => {
      await handler(makeReq({ body: { eventType: 'signal_useful', signalId: 'sig-a3-collision', clientEventId: 'c-collision-group' } }), makeRes());
      await handler(makeReq({ body: { eventType: 'signal_not_useful', signalId: 'sig-a4-collision', clientEventId: 'c-collision-consulting' } }), makeRes());
      return {
        evGroup: state.haSignalEvents.find(e => e.client_event_id === 'c-collision-group'),
        evConsulting: state.haSignalEvents.find(e => e.client_event_id === 'c-collision-consulting')
      };
    });
    assert(evGroup.account_name === 'Anderson Group' && evGroup.signal_id === 'sig-a3-collision', 'REQUIRED: the write against sig-a3-collision resolves to Anderson Group specifically, not the other colliding row');
    assert(evConsulting.account_name === 'Anderson Consulting' && evConsulting.signal_id === 'sig-a4-collision', 'REQUIRED: the write against sig-a4-collision resolves to Anderson Consulting specifically, even though it shares a fingerprint with Anderson Group');
    assert(evGroup.event_fingerprint === evConsulting.event_fingerprint, 'sanity: both signals really do share the same event_fingerprint, exercising the collision case');
  }

  // ---------------------------------------------------------------------
  // Server-derived recommendation snapshot: client-supplied recommendation
  // text is ignored; the stored snapshot comes from ha_signals.payload,
  // capped/truncated as designed.
  // ---------------------------------------------------------------------
  {
    const { ev } = await withState(async (state) => {
      const req = makeReq({ body: {
        eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'c-snapshot',
        // Spoofed recommendation content -- must be entirely ignored.
        payload: { commercialPlay: 'FAKE - ignore me', activationIdeas: ['fake idea'] }
      } });
      const res = makeRes();
      await handler(req, res);
      return { ev: state.haSignalEvents[0] };
    });
    assert(ev.payload.signalType === 'Hiring Activity', 'REQUIRED: snapshot signalType is derived from the real ha_signals.payload');
    assert(ev.payload.commercialPlay === 'Acme is scaling its ops team fast.', 'REQUIRED: snapshot commercialPlay narrative comes from the real stored signal, never a client-supplied value');
    assert(ev.payload.recommendedContact === 'VP Operations', 'snapshot recommendedContact is derived server-side');
    assert(Array.isArray(ev.payload.activationIdeas) && ev.payload.activationIdeas.length === 3, `REQUIRED: activationIdeas is capped to 3 real ideas, not the client-supplied fake one (got ${JSON.stringify(ev.payload.activationIdeas)})`);
    assert(ev.schema_version === 1, `REQUIRED: schema_version is stamped 1 (got ${ev.schema_version})`);
  }

  // ---------------------------------------------------------------------
  // prepare_call_opened carries no snapshot (pure engagement, not
  // feedback).
  // ---------------------------------------------------------------------
  {
    const { ev } = await withState(async (state) => {
      const req = makeReq({ body: { eventType: 'prepare_call_opened', signalId: 'sig-a1', clientEventId: 'c-open' } });
      const res = makeRes();
      await handler(req, res);
      return { ev: state.haSignalEvents[0] };
    });
    assert(Object.keys(ev.payload).length === 0, `REQUIRED: prepare_call_opened carries an empty payload, never a recommendation snapshot (got ${JSON.stringify(ev.payload)})`);
  }

  // ---------------------------------------------------------------------
  // Idempotency: replaying the same (user, clientEventId) pair returns the
  // existing event, never inserts a second row.
  // ---------------------------------------------------------------------
  {
    const { firstId, secondId, count } = await withState(async (state) => {
      const req1 = makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-retry-same' } });
      const res1 = makeRes();
      await handler(req1, res1);
      const req2 = makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-retry-same' } });
      const res2 = makeRes();
      await handler(req2, res2);
      return { firstId: res1.body.id, secondId: res2.body.id, count: state.haSignalEvents.length };
    });
    assert(firstId === secondId, `REQUIRED: replaying the same clientEventId returns the SAME event id (got ${firstId} vs ${secondId})`);
    assert(count === 1, `REQUIRED: a retried request never creates a second row (got ${count} rows)`);
  }

  // ---------------------------------------------------------------------
  // Semantic dedupe for signal_useful/signal_not_useful: a genuinely new
  // clientEventId with the SAME judgment already on record is a server-
  // side no-op (existing id returned, nothing inserted); a CHANGED
  // judgment inserts real new history. Per the founder's explicit
  // instruction, this file does NOT assert that two separate same-state
  // Useful clicks both persist.
  // ---------------------------------------------------------------------
  {
    const { firstRes, repeatRes, changeRes, count, types } = await withState(async (state) => {
      const req1 = makeReq({ body: { eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'c-useful-1' } });
      const res1 = makeRes();
      await handler(req1, res1);

      // A genuinely new gesture (different clientEventId), same judgment.
      const req2 = makeReq({ body: { eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'c-useful-2-different-id' } });
      const res2 = makeRes();
      await handler(req2, res2);

      // Now a changed judgment.
      const req3 = makeReq({ body: { eventType: 'signal_not_useful', signalId: 'sig-a1', clientEventId: 'c-not-useful-1' } });
      const res3 = makeRes();
      await handler(req3, res3);

      return { firstRes: res1.body, repeatRes: res2.body, changeRes: res3.body, count: state.haSignalEvents.length, types: state.haSignalEvents.map(e => e.event_type) };
    });
    assert(firstRes.id, 'sanity: the first signal_useful is recorded');
    assert(repeatRes.noOp === true && repeatRes.id === firstRes.id, `REQUIRED: a second, independently-clicked signal_useful (fresh clientEventId) for a signal already marked useful is a server-side no-op returning the existing event (got ${JSON.stringify(repeatRes)})`);
    assert(changeRes.id && changeRes.id !== firstRes.id && !changeRes.noOp, `REQUIRED: switching from Useful to Not-useful inserts a genuinely new event (got ${JSON.stringify(changeRes)})`);
    assert(count === 2, `REQUIRED: exactly 2 rows exist after useful, repeat-useful (no-op), not-useful -- the repeat never persisted (got ${count})`);
    assert(types.join(',') === 'signal_useful,signal_not_useful', `REQUIRED: only the genuine judgment change is stored, not the repeated confirmation (got ${types.join(',')})`);
  }

  // ---------------------------------------------------------------------
  // outreach_made: no server-side time-window dedupe -- two genuinely
  // distinct clientEventIds both persist as separate attempts.
  // ---------------------------------------------------------------------
  {
    const { count, ids } = await withState(async (state) => {
      const req1 = makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-outreach-1' } });
      const res1 = makeRes();
      await handler(req1, res1);
      const req2 = makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-outreach-2' } });
      const res2 = makeRes();
      await handler(req2, res2);
      return { count: state.haSignalEvents.length, ids: [res1.body.id, res2.body.id] };
    });
    assert(count === 2, `REQUIRED: two genuinely distinct outreach_made attempts both persist -- no arbitrary server-side dedupe (got ${count} rows)`);
    assert(ids[0] !== ids[1], 'the two outreach attempts have distinct event ids');
  }

  // ---------------------------------------------------------------------
  // approach_shared: requires parentEventId pointing to the CALLER'S OWN
  // outreach_made row; a non-empty note within the length limit.
  // ---------------------------------------------------------------------
  {
    const { noteRes, ev } = await withState(async (state) => {
      const outreachReq = makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-outreach-for-note' } });
      const outreachRes = makeRes();
      await handler(outreachReq, outreachRes);
      const noteReq = makeReq({ body: { eventType: 'approach_shared', parentEventId: outreachRes.body.id, note: 'Called the ops lead and referenced the hiring push.', clientEventId: 'c-note-1' } });
      const noteRes = makeRes();
      await handler(noteReq, noteRes);
      return { noteRes, ev: state.haSignalEvents.find(e => e.event_type === 'approach_shared') };
    });
    assert(noteRes.statusCode === 200, `a valid approach note saves successfully (got ${noteRes.statusCode})`);
    assert(ev.parent_event_id, 'REQUIRED: approach_shared carries parent_event_id linking it to its outreach attempt');
    assert(ev.payload.approachNote === 'Called the ops lead and referenced the hiring push.', 'the raw note text is preserved verbatim');
    assert(ev.event_fingerprint === 'fp-shared-account' && ev.account_name === 'Acme Co', 'approach_shared inherits its fingerprint/account from the parent outreach event');
  }
  {
    // Missing parentEventId.
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'approach_shared', note: 'A note with no parent.', clientEventId: 'c-orphan-note' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `an approach_shared with no parentEventId is rejected 400 (got ${res.statusCode})`);
  }
  {
    // Empty note.
    const { res } = await withState(async (state) => {
      const outreachReq = makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-outreach-empty-note' } });
      const outreachRes = makeRes();
      await handler(outreachReq, outreachRes);
      const req = makeReq({ body: { eventType: 'approach_shared', parentEventId: outreachRes.body.id, note: '   ', clientEventId: 'c-empty-note' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `REQUIRED: an empty/whitespace-only note is rejected 400, never persisted as an event (got ${res.statusCode})`);
  }
  {
    // Length limit.
    const { res } = await withState(async (state) => {
      const outreachReq = makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-outreach-long-note' } });
      const outreachRes = makeRes();
      await handler(outreachReq, outreachRes);
      const req = makeReq({ body: { eventType: 'approach_shared', parentEventId: outreachRes.body.id, note: 'x'.repeat(501), clientEventId: 'c-long-note' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `REQUIRED: a note over the server-side length limit (500 chars) is rejected 400 (got ${res.statusCode})`);
  }
  {
    // parentEventId belonging to a DIFFERENT rep, even within the same
    // organization -- a note is a personal reflection on one's OWN
    // outreach, not attachable to a teammate's.
    const { res } = await withState(async (state) => {
      const outreachReq = makeReq({ token: 'valid-token-a2', body: { eventType: 'outreach_made', signalId: 'sig-a2', clientEventId: 'c-a2-outreach' } });
      const outreachRes = makeRes();
      await handler(outreachReq, outreachRes);
      const noteReq = makeReq({ token: 'valid-token-a1', body: { eventType: 'approach_shared', parentEventId: outreachRes.body.id, note: 'Trying to attach a note to my teammate\'s outreach.', clientEventId: 'c-cross-rep-note' } });
      const res = makeRes();
      await handler(noteReq, res);
      return { res };
    });
    assert(res.statusCode === 404, `REQUIRED: a rep cannot attach an approach note to a DIFFERENT rep's outreach attempt, even within the same organization (got ${res.statusCode})`);
  }

  // ---------------------------------------------------------------------
  // outcome_reported: append-only child of the caller's OWN outreach_made
  // event, inherits fingerprint/signal_id/account_name from the parent,
  // validated outcomeStatus enum, optional note, NEVER deduped -- multiple
  // later updates are valid real history.
  // ---------------------------------------------------------------------
  {
    const { res, ev } = await withState(async (state) => {
      const outreachReq = makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-outreach-for-outcome' } });
      const outreachRes = makeRes();
      await handler(outreachReq, outreachRes);
      const outcomeReq = makeReq({ body: { eventType: 'outcome_reported', parentEventId: outreachRes.body.id, outcomeStatus: 'no_response_yet', clientEventId: 'c-outcome-1' } });
      const res = makeRes();
      await handler(outcomeReq, res);
      return { res, ev: state.haSignalEvents.find(e => e.event_type === 'outcome_reported') };
    });
    assert(res.statusCode === 200, `a valid outcome_reported saves successfully (got ${res.statusCode})`);
    assert(ev.parent_event_id, 'REQUIRED: outcome_reported carries parent_event_id linking it to its outreach attempt');
    assert(ev.payload.outcomeStatus === 'no_response_yet', 'the outcomeStatus is stored');
    assert(!('note' in ev.payload), 'REQUIRED: an omitted note is not stored as an empty/null field -- the payload simply has no note key');
    assert(ev.event_fingerprint === 'fp-shared-account' && ev.account_name === 'Acme Co', 'REQUIRED: outcome_reported inherits its fingerprint/account from the parent outreach event, never client-supplied');
    assert(ev.signal_id === 'sig-a1' && ev.opportunity_id == null, 'REQUIRED: outcome_reported inherits signal_id from a signal-family parent and carries no opportunity_id');
  }
  {
    // Optional note is stored verbatim when provided.
    const { ev } = await withState(async (state) => {
      const outreachRes = makeRes();
      await handler(makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-outreach-outcome-note' } }), outreachRes);
      await handler(makeReq({ body: { eventType: 'outcome_reported', parentEventId: outreachRes.body.id, outcomeStatus: 'engaged', note: 'Replied same day, wants a call next week.', clientEventId: 'c-outcome-note' } }), makeRes());
      return { ev: state.haSignalEvents.find(e => e.event_type === 'outcome_reported') };
    });
    assert(ev.payload.note === 'Replied same day, wants a call next week.', 'an optional note is stored verbatim alongside outcomeStatus');
  }
  {
    // Unknown outcomeStatus rejected.
    const { res } = await withState(async (state) => {
      const outreachRes = makeRes();
      await handler(makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-outreach-bad-status' } }), outreachRes);
      const req = makeReq({ body: { eventType: 'outcome_reported', parentEventId: outreachRes.body.id, outcomeStatus: 'closed_won', clientEventId: 'c-bad-status' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `REQUIRED: an outcomeStatus outside the fixed V1 vocabulary (no CRM-stage free-for-all) is rejected 400 (got ${res.statusCode})`);
  }
  {
    // parentEventId must point at an outreach_made/opportunity_outreach_made
    // event, not just any event (e.g. a prior signal_useful).
    const { res } = await withState(async (state) => {
      const usefulRes = makeRes();
      await handler(makeReq({ body: { eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'c-useful-for-bad-parent' } }), usefulRes);
      const req = makeReq({ body: { eventType: 'outcome_reported', parentEventId: usefulRes.body.id, outcomeStatus: 'engaged', clientEventId: 'c-wrong-parent-type' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 404, `REQUIRED: outcome_reported rejects a parentEventId that isn't an outreach_made/opportunity_outreach_made event (got ${res.statusCode})`);
  }
  {
    // Cross-rep: a rep cannot report an outcome on a teammate's outreach.
    const { res } = await withState(async (state) => {
      const outreachRes = makeRes();
      await handler(makeReq({ token: 'valid-token-a2', body: { eventType: 'outreach_made', signalId: 'sig-a2', clientEventId: 'c-a2-outreach-for-outcome' } }), outreachRes);
      const req = makeReq({ token: 'valid-token-a1', body: { eventType: 'outcome_reported', parentEventId: outreachRes.body.id, outcomeStatus: 'engaged', clientEventId: 'c-cross-rep-outcome' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 404, `REQUIRED: a rep cannot report an outcome on a DIFFERENT rep's outreach attempt (got ${res.statusCode})`);
  }
  {
    // REQUIRED: multiple later outcome updates are valid, real history --
    // never deduped/no-op'd the way signal_useful/signal_not_useful is.
    const { count, statuses } = await withState(async (state) => {
      const outreachRes = makeRes();
      await handler(makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'c-outreach-multi-outcome' } }), outreachRes);
      await handler(makeReq({ body: { eventType: 'outcome_reported', parentEventId: outreachRes.body.id, outcomeStatus: 'no_response_yet', clientEventId: 'c-outcome-multi-1' } }), makeRes());
      await handler(makeReq({ body: { eventType: 'outcome_reported', parentEventId: outreachRes.body.id, outcomeStatus: 'no_response_yet', clientEventId: 'c-outcome-multi-2' } }), makeRes());
      await handler(makeReq({ body: { eventType: 'outcome_reported', parentEventId: outreachRes.body.id, outcomeStatus: 'engaged', clientEventId: 'c-outcome-multi-3' } }), makeRes());
      const rows = state.haSignalEvents.filter(e => e.event_type === 'outcome_reported' && e.parent_event_id === outreachRes.body.id);
      return { count: rows.length, statuses: rows.map(r => r.payload.outcomeStatus) };
    });
    assert(count === 3, `REQUIRED: three separate outcome_reported calls on the SAME outreach all persist as distinct rows -- no dedup/no-op, even for the two identical 'no_response_yet' reports (got ${count})`);
    assert(statuses.join(',') === 'no_response_yet,no_response_yet,engaged', `REQUIRED: the full history is preserved in order, including the repeated no_response_yet -- an earlier report is never overwritten or destroyed by a later one (got ${statuses.join(',')})`);
  }
  {
    // outcome_reported against an opportunity_outreach_made parent inherits
    // opportunity_id, not signal_id.
    const { ev } = await withState(async (state) => {
      state.haAccountOpportunities = [{ id: 'opp-1', user_id: 'user-a1', fingerprint: 'fp-opp-1', account_name: 'Delta LLC', opportunity_type: 'REPEAT PATTERN', category: 'Apparel' }];
      const oppOutreachRes = makeRes();
      await handler(makeReq({ body: { eventType: 'opportunity_outreach_made', opportunityId: 'opp-1', clientEventId: 'c-opp-outreach-for-outcome' } }), oppOutreachRes);
      await handler(makeReq({ body: { eventType: 'outcome_reported', parentEventId: oppOutreachRes.body.id, outcomeStatus: 'went_nowhere', clientEventId: 'c-opp-outcome' } }), makeRes());
      return { ev: state.haSignalEvents.find(e => e.event_type === 'outcome_reported' && e.parent_event_id === oppOutreachRes.body.id) };
    });
    assert(ev.opportunity_id === 'opp-1' && ev.signal_id == null, 'REQUIRED: outcome_reported against an opportunity-family parent inherits opportunity_id, not signal_id');
    assert(ev.account_name === 'Delta LLC', 'inherits account_name from the opportunity-family parent');
  }

  // ---------------------------------------------------------------------
  // Multiple outreach attempts, note scoping: an OLDER attempt's note must
  // never appear to belong to a NEWER attempt that has none of its own yet.
  // ---------------------------------------------------------------------
  {
    const { states } = await withState(async (state) => {
      const outreach1Res = makeRes();
      await handler(makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'note-scope-outreach-1' } }), outreach1Res);
      await handler(makeReq({ body: { eventType: 'approach_shared', parentEventId: outreach1Res.body.id, note: 'First attempt: left a voicemail.', clientEventId: 'note-scope-note-1' } }), makeRes());

      // A second, later outreach attempt with NO note of its own yet.
      const outreach2Res = makeRes();
      await handler(makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'note-scope-outreach-2' } }), outreach2Res);

      const getRes = makeRes();
      await handler(makeReq({ method: 'GET', query: getKeys(['fp-shared-account', 'Acme Co']) }), getRes);
      return { states: getRes.body.states, outreach2Id: outreach2Res.body.id };
    });
    const s = states[readBackKey('fp-shared-account', 'Acme Co')];
    assert(!!s, 'sanity: the requested key has a state entry');
    assert(s.outreachLogged === true, 'sanity: outreach is logged');
    assert(s.approachNote === null, `REQUIRED: the newest outreach attempt has no note of its own -- the older attempt's note must NOT leak onto it (got ${JSON.stringify(s.approachNote)})`);
  }
  {
    // The mirror case: the NEWEST attempt DOES have its own note, and it
    // must be the one returned, not an older attempt's.
    const { states } = await withState(async (state) => {
      const outreach1Res = makeRes();
      await handler(makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'note-scope2-outreach-1' } }), outreach1Res);
      await handler(makeReq({ body: { eventType: 'approach_shared', parentEventId: outreach1Res.body.id, note: 'Old note, should not be returned.', clientEventId: 'note-scope2-note-1' } }), makeRes());

      const outreach2Res = makeRes();
      await handler(makeReq({ body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'note-scope2-outreach-2' } }), outreach2Res);
      await handler(makeReq({ body: { eventType: 'approach_shared', parentEventId: outreach2Res.body.id, note: 'New note, should be returned.', clientEventId: 'note-scope2-note-2' } }), makeRes());

      const getRes = makeRes();
      await handler(makeReq({ method: 'GET', query: getKeys(['fp-shared-account', 'Acme Co']) }), getRes);
      return { states: getRes.body.states, outreach2Id: outreach2Res.body.id };
    });
    const s = states[readBackKey('fp-shared-account', 'Acme Co')];
    assert(s.approachNote === 'New note, should be returned.', `REQUIRED: read-back returns the LATEST outreach attempt's own note, not an older attempt's (got ${JSON.stringify(s.approachNote)})`);
  }

  // ---------------------------------------------------------------------
  // Batched, current-rep-only read-back.
  // ---------------------------------------------------------------------
  {
    const { states } = await withState(async (state) => {
      // Rep A1: marks useful, then reconsiders to not-useful, then logs outreach with a note.
      await handler(makeReq({ token: 'valid-token-a1', body: { eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'r-useful' } }), makeRes());
      const notUsefulRes = makeRes();
      await handler(makeReq({ token: 'valid-token-a1', body: { eventType: 'signal_not_useful', signalId: 'sig-a1', clientEventId: 'r-not-useful' } }), notUsefulRes);
      const outreachRes = makeRes();
      await handler(makeReq({ token: 'valid-token-a1', body: { eventType: 'outreach_made', signalId: 'sig-a1', clientEventId: 'r-outreach' } }), outreachRes);
      await handler(makeReq({ token: 'valid-token-a1', body: { eventType: 'approach_shared', parentEventId: outreachRes.body.id, note: 'Left a voicemail, will follow up Thursday.', clientEventId: 'r-note' } }), makeRes());

      // Rep A2 (teammate, same org): marks the SAME signal useful --
      // must never leak into rep A1's own read-back.
      await handler(makeReq({ token: 'valid-token-a2', body: { eventType: 'signal_selected', signalId: 'sig-a1', clientEventId: 'r-a2-select' } }), makeRes());
      await handler(makeReq({ token: 'valid-token-a2', body: { eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'r-a2-useful' } }), makeRes());

      const getRes = makeRes();
      await handler(makeReq({ method: 'GET', token: 'valid-token-a1', query: getKeys(['fp-shared-account', 'Acme Co'], ['fp-nonexistent', 'Nowhere Inc']) }), getRes);
      return { states: getRes.body.states };
    });
    const s = states[readBackKey('fp-shared-account', 'Acme Co')];
    assert(!!s, 'sanity: the requested key has a state entry');
    assert(s.feedback === 'not_useful', `REQUIRED: read-back reflects rep A1's LATEST judgment (not_useful, the reconsideration), not the earlier useful (got ${s.feedback})`);
    assert(s.outreachLogged === true && !!s.latestOutreachEventId, 'REQUIRED: read-back reports outreach as logged, with the outreach event id available for a future note');
    assert(s.approachNote === 'Left a voicemail, will follow up Thursday.', 'REQUIRED: read-back returns the latest saved approach note');
    const missing = states[readBackKey('fp-nonexistent', 'Nowhere Inc')];
    assert(missing && missing.feedback === null && missing.outreachLogged === false, 'a key with no history returns a clean, unanswered default state');
  }
  {
    // signal_selected read-back: durable historical-use acknowledgement,
    // not a single "currently active" pointer. A signal never selected
    // reads selected:false; a signal selected even once (regardless of
    // any later feedback/outreach activity) reads selected:true and stays
    // true -- it is never un-set by anything else happening on the row.
    const { states } = await withState(async () => {
      await handler(makeReq({ token: 'valid-token-a1', body: { eventType: 'signal_selected', signalId: 'sig-a1', clientEventId: 'sel-a1' } }), makeRes());
      const getRes = makeRes();
      await handler(makeReq({ method: 'GET', token: 'valid-token-a1', query: getKeys(['fp-shared-account', 'Acme Co'], ['fp-teammate-only', 'Beta Inc']) }), getRes);
      return { states: getRes.body.states };
    });
    const selected = states[readBackKey('fp-shared-account', 'Acme Co')];
    const neverSelected = states[readBackKey('fp-teammate-only', 'Beta Inc')];
    assert(selected.selected === true, `REQUIRED: a signal this rep has selected at least once reads selected:true in read-back (got ${JSON.stringify(selected)})`);
    assert(neverSelected.selected === false, `REQUIRED: a signal this rep has never selected reads selected:false (got ${JSON.stringify(neverSelected)})`);
  }
  {
    // Reopening (no additional signal_selected) does not create a second
    // event, and the signal still reads selected:true -- the acknowledgement
    // is durable existence-based, not dependent on the LATEST event type.
    const { count, states } = await withState(async (state) => {
      await handler(makeReq({ token: 'valid-token-a1', body: { eventType: 'signal_selected', signalId: 'sig-a1', clientEventId: 'sel-first' } }), makeRes());
      // A later, unrelated judgment on the same signal -- selected must
      // remain true even though the LATEST event for this signal is now
      // signal_useful, not signal_selected.
      await handler(makeReq({ token: 'valid-token-a1', body: { eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'sel-then-useful' } }), makeRes());
      const getRes = makeRes();
      await handler(makeReq({ method: 'GET', token: 'valid-token-a1', query: getKeys(['fp-shared-account', 'Acme Co']) }), getRes);
      return { count: state.haSignalEvents.length, states: getRes.body.states };
    });
    assert(count === 2, `sanity: exactly the two genuinely distinct events were written (got ${count})`);
    const s = states[readBackKey('fp-shared-account', 'Acme Co')];
    assert(s.selected === true && s.feedback === 'useful', `REQUIRED: selected stays true and reflects alongside the LATEST feedback judgment, independent of event recency (got ${JSON.stringify(s)})`);
  }
  {
    // Account-scoped read-back: the SAME fingerprint, two different
    // accounts -- feedback given under one account context must never
    // appear when reading back the OTHER account's state.
    const { states } = await withState(async () => {
      await handler(makeReq({ body: { eventType: 'signal_useful', signalId: 'sig-a3-collision', clientEventId: 'collision-read-group' } }), makeRes());
      const getRes = makeRes();
      await handler(makeReq({ method: 'GET', query: getKeys(['fp-collision-shared', 'Anderson Group'], ['fp-collision-shared', 'Anderson Consulting']) }), getRes);
      return { states: getRes.body.states };
    });
    const group = states[readBackKey('fp-collision-shared', 'Anderson Group')];
    const consulting = states[readBackKey('fp-collision-shared', 'Anderson Consulting')];
    assert(group.feedback === 'useful', 'REQUIRED: Anderson Group\'s read-back reflects the feedback actually given on its own signal row');
    assert(consulting.feedback === null, 'REQUIRED: Anderson Consulting\'s read-back stays unanswered -- the SAME event_fingerprint as Anderson Group must never leak feedback across the account boundary');
  }
  {
    // Cross-rep isolation, explicit: rep A2's own read-back for the same
    // signal must reflect ONLY rep A2's history, not rep A1's.
    const { states } = await withState(async () => {
      await handler(makeReq({ token: 'valid-token-a1', body: { eventType: 'signal_not_useful', signalId: 'sig-a1', clientEventId: 'iso-a1' } }), makeRes());
      await handler(makeReq({ token: 'valid-token-a2', body: { eventType: 'signal_useful', signalId: 'sig-a1', clientEventId: 'iso-a2' } }), makeRes());
      const getRes = makeRes();
      await handler(makeReq({ method: 'GET', token: 'valid-token-a2', query: getKeys(['fp-shared-account', 'Acme Co']) }), getRes);
      return { states: getRes.body.states };
    });
    const s = states[readBackKey('fp-shared-account', 'Acme Co')];
    assert(s.feedback === 'useful', `REQUIRED: rep A2's read-back reflects ONLY their own judgment (useful), never rep A1's (not_useful) for the same signal (got ${s.feedback})`);
  }
  {
    const { res } = await withState(async () => {
      const req = makeReq({ method: 'GET', query: {} });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `GET with no keys is rejected 400 (got ${res.statusCode})`);
  }
  {
    const { res } = await withState(async () => {
      const req = makeReq({ method: 'GET', token: null, query: getKeys(['fp-shared-account', 'Acme Co']) });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 401, `GET also requires authentication (got ${res.statusCode})`);
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
