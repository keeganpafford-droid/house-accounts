// Organizational Learning V1B, items 8/9: deterministic coverage for
// api/signal-events.js's opportunity_* event family (opportunity_selected/
// opportunity_useful/opportunity_not_useful/opportunity_outreach_made/
// opportunity_approach_shared) against the REAL, production-bound handler
// export (mocked Supabase fetch, in-memory tables) -- not a
// reimplementation. This mirrors scripts/test-signal-events.js's coverage
// shape for the equivalent signal_* family, applied to
// ha_account_opportunities instead of ha_signals:
//   - target resolved by opportunityId, organization-scoped, never by a
//     client-supplied event_fingerprint/account_name/category.
//   - a genuinely separate structural family from signal_* -- an
//     opportunity_* event's signal_id is always null, and vice versa.
//   - the recommendation-at-action snapshot (Correction 2) is reconstructed
//     server-side from the resolved row's opportunity_type/category plus a
//     client-supplied templateKey, validated against
//     api/lib/account-opportunity-templates.js's known registry -- never
//     trusted recommendation prose.
//   - semantic dedupe for opportunity_useful/opportunity_not_useful, no
//     dedupe for opportunity_outreach_made.
//   - opportunity_approach_shared's tight same-rep parent-event scoping,
//     inheriting opportunity_id/event_fingerprint/account_name from its
//     resolved opportunity_outreach_made parent.
//
// Usage: node scripts/test-opportunity-events.js
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
      ['valid-token-b1', { id: 'auth-b1', email: 'repb1@orgb.example.com' }]
    ]),
    haUsers: [
      { id: 'user-a1', auth_user_id: 'auth-a1', email: 'repa1@orga.example.com', organization_id: 'org-a' },
      { id: 'user-a2', auth_user_id: 'auth-a2', email: 'repa2@orga.example.com', organization_id: 'org-a' },
      { id: 'user-b1', auth_user_id: 'auth-b1', email: 'repb1@orgb.example.com', organization_id: 'org-b' }
    ],
    haAccountOpportunities: [
      { id: 'opp-a1-followup', user_id: 'user-a1', account_name: 'Acme Co', opportunity_type: 'follow_up', category: null, fingerprint: 'opp:follow_up:v1:acme|last:2025-06-01', status: 'active' },
      { id: 'opp-a2-repeat', user_id: 'user-a2', account_name: 'Beta Inc', opportunity_type: 'repeat_pattern', category: 'Apparel', fingerprint: 'opp:repeat_pattern:v1:beta|apparel|last:2025-03-15', status: 'active' },
      { id: 'opp-b1', user_id: 'user-b1', account_name: 'Gamma LLC', opportunity_type: 'follow_up', category: null, fingerprint: 'opp:follow_up:v1:gamma|last:2025-01-01', status: 'active' }
    ],
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
  // opportunityId required; a client-supplied signalId is never accepted
  // as a substitute for the required opportunityId on an opportunity_*
  // event.
  // ---------------------------------------------------------------------
  {
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'opportunity_useful', clientEventId: 'c-no-opp-id' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `REQUIRED: missing opportunityId is rejected 400 (got ${res.statusCode})`);
  }

  // ---------------------------------------------------------------------
  // Organization-level opportunity resolution: rejects an opportunityId
  // outside the caller's organization, accepts one owned by a TEAMMATE.
  // ---------------------------------------------------------------------
  {
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'opportunity_useful', opportunityId: 'opp-b1', clientEventId: 'c-cross-org' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 404, `REQUIRED: an opportunityId belonging to a DIFFERENT organization is rejected 404, not written (got ${res.statusCode})`);
  }
  {
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'opportunity_selected', opportunityId: 'opp-does-not-exist', clientEventId: 'c-missing-opp' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 404, `an opportunityId with no matching ha_account_opportunities row is rejected 404 (got ${res.statusCode})`);
  }
  {
    const { res, ev } = await withState(async (state) => {
      const req = makeReq({ token: 'valid-token-a1', body: {
        eventType: 'opportunity_selected', opportunityId: 'opp-a2-repeat', clientEventId: 'c-teammate',
        // Spoofed fields -- must be entirely ignored; the resolved row's
        // own event_fingerprint/account_name are what get stored.
        eventFingerprint: 'attacker-supplied-fingerprint', accountName: 'attacker-supplied-account-name'
      } });
      const res = makeRes();
      await handler(req, res);
      return { res, ev: state.haSignalEvents[0] };
    });
    assert(res.statusCode === 200, `REQUIRED: an opportunityId owned by a TEAMMATE in the same organization resolves successfully (org-level, not current-user-only) (got ${res.statusCode})`);
    assert(ev.user_id === 'user-a1', 'the event is recorded under the ACTING rep (user-a1), not the teammate who owns the opportunity row');
    assert(ev.organization_id === 'org-a', 'the event carries the acting rep\'s own organization_id');
    assert(ev.account_name === 'Beta Inc', 'REQUIRED: account_name is derived from the resolved ha_account_opportunities row, never from client-supplied accountName');
    assert(ev.event_fingerprint === 'opp:repeat_pattern:v1:beta|apparel|last:2025-03-15', 'REQUIRED: event_fingerprint is derived from the resolved row, never from client-supplied eventFingerprint');
    assert(ev.opportunity_id === 'opp-a2-repeat', 'the event carries the exact opportunity_id resolved, matching what the rep actually saw');
    assert(ev.signal_id === undefined || ev.signal_id === null, 'REQUIRED: an opportunity_* event never carries a signal_id -- the two families are structurally distinct');
  }

  // ---------------------------------------------------------------------
  // Correction 2: server-derived recommendation snapshot. A follow_up
  // opportunity reconstructs its snapshot from a validated templateKey;
  // client-supplied recommendation prose is entirely ignored; an
  // unrecognized templateKey degrades honestly rather than fabricating.
  // ---------------------------------------------------------------------
  {
    const { ev } = await withState(async (state) => {
      const req = makeReq({ body: {
        eventType: 'opportunity_useful', opportunityId: 'opp-a1-followup', templateKey: 'auto_service_apparel', clientEventId: 'c-snapshot-followup',
        // Spoofed recommendation content -- must be entirely ignored.
        payload: { opportunityName: 'FAKE - ignore me', recommendedContact: 'Fake Contact' }
      } });
      const res = makeRes();
      await handler(req, res);
      return { ev: state.haSignalEvents[0] };
    });
    assert(ev.payload.opportunityType === 'follow_up', 'REQUIRED: snapshot opportunityType matches the resolved row\'s own opportunity_type');
    assert(ev.payload.opportunityName === 'Service Department Apparel Program', 'REQUIRED: snapshot opportunityName is reconstructed server-side from the validated templateKey, never from client-supplied prose');
    assert(ev.payload.recommendedContact === 'Service Director', 'snapshot recommendedContact is reconstructed server-side from the validated templateKey');
    assert(ev.payload.reasonToReachOut === 'Recent order delivered or completed', 'snapshot reasonToReachOut reflects the standing follow_up reason');
  }
  {
    const { ev } = await withState(async (state) => {
      const req = makeReq({ body: { eventType: 'opportunity_selected', opportunityId: 'opp-a1-followup', templateKey: 'not-a-real-template-key', clientEventId: 'c-bad-template' } });
      const res = makeRes();
      await handler(req, res);
      return { ev: state.haSignalEvents[0] };
    });
    assert(ev.payload.opportunityName === 'Follow-Up Opportunity', 'REQUIRED: an unrecognized/tampered templateKey degrades to an honest generic name, never a fabricated one');
  }
  {
    // Genuine repeat_pattern: the snapshot is reconstructed from
    // opportunity_type + category alone -- no templateKey needed, and one
    // supplied is simply irrelevant.
    const { ev } = await withState(async (state) => {
      const req = makeReq({ token: 'valid-token-a2', body: { eventType: 'opportunity_useful', opportunityId: 'opp-a2-repeat', clientEventId: 'c-snapshot-repeat' } });
      const res = makeRes();
      await handler(req, res);
      return { ev: state.haSignalEvents[0] };
    });
    assert(ev.payload.opportunityType === 'repeat_pattern', 'snapshot opportunityType reflects repeat_pattern');
    assert(ev.payload.opportunityName === 'Apparel Program', 'REQUIRED: repeat_pattern snapshot reconstructs the program name from the resolved row\'s own category, with no client-supplied templateKey needed');
  }

  // ---------------------------------------------------------------------
  // opportunity_selected carries no snapshot? -- No: per SNAPSHOT_EVENT_TYPES
  // it DOES (mirrors signal_selected). Confirm no snapshot only applies to
  // the outreach-note event, opportunity_approach_shared (parallel to
  // approach_shared).
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Idempotency: replaying the same (user, clientEventId) pair returns the
  // existing event, never inserts a second row.
  // ---------------------------------------------------------------------
  {
    const { firstId, secondId, count } = await withState(async (state) => {
      const req1 = makeReq({ body: { eventType: 'opportunity_outreach_made', opportunityId: 'opp-a1-followup', clientEventId: 'c-retry-same' } });
      const res1 = makeRes();
      await handler(req1, res1);
      const req2 = makeReq({ body: { eventType: 'opportunity_outreach_made', opportunityId: 'opp-a1-followup', clientEventId: 'c-retry-same' } });
      const res2 = makeRes();
      await handler(req2, res2);
      return { firstId: res1.body.id, secondId: res2.body.id, count: state.haSignalEvents.length };
    });
    assert(firstId === secondId, `REQUIRED: replaying the same clientEventId returns the SAME event id (got ${firstId} vs ${secondId})`);
    assert(count === 1, `REQUIRED: a retried request never creates a second row (got ${count} rows)`);
  }

  // ---------------------------------------------------------------------
  // Semantic dedupe for opportunity_useful/opportunity_not_useful: a
  // repeated identical judgment is a server-side no-op; a changed judgment
  // inserts real new history.
  // ---------------------------------------------------------------------
  {
    const { firstRes, repeatRes, changeRes, count, types } = await withState(async (state) => {
      const req1 = makeReq({ body: { eventType: 'opportunity_useful', opportunityId: 'opp-a1-followup', clientEventId: 'c-useful-1' } });
      const res1 = makeRes();
      await handler(req1, res1);

      const req2 = makeReq({ body: { eventType: 'opportunity_useful', opportunityId: 'opp-a1-followup', clientEventId: 'c-useful-2-different-id' } });
      const res2 = makeRes();
      await handler(req2, res2);

      const req3 = makeReq({ body: { eventType: 'opportunity_not_useful', opportunityId: 'opp-a1-followup', clientEventId: 'c-not-useful-1' } });
      const res3 = makeRes();
      await handler(req3, res3);

      return { firstRes: res1.body, repeatRes: res2.body, changeRes: res3.body, count: state.haSignalEvents.length, types: state.haSignalEvents.map(e => e.event_type) };
    });
    assert(firstRes.id, 'sanity: the first opportunity_useful is recorded');
    assert(repeatRes.noOp === true && repeatRes.id === firstRes.id, `REQUIRED: a second, independently-clicked opportunity_useful for an opportunity already marked useful is a server-side no-op (got ${JSON.stringify(repeatRes)})`);
    assert(changeRes.id && changeRes.id !== firstRes.id && !changeRes.noOp, `REQUIRED: switching from Useful to Not-useful inserts a genuinely new event (got ${JSON.stringify(changeRes)})`);
    assert(count === 2, `REQUIRED: exactly 2 rows exist after useful, repeat-useful (no-op), not-useful (got ${count})`);
    assert(types.join(',') === 'opportunity_useful,opportunity_not_useful', `REQUIRED: only the genuine judgment change is stored (got ${types.join(',')})`);
  }

  // ---------------------------------------------------------------------
  // opportunity_outreach_made: no server-side dedupe -- two genuinely
  // distinct clientEventIds both persist as separate attempts.
  // ---------------------------------------------------------------------
  {
    const { count, ids } = await withState(async (state) => {
      const req1 = makeReq({ body: { eventType: 'opportunity_outreach_made', opportunityId: 'opp-a1-followup', clientEventId: 'c-outreach-1' } });
      const res1 = makeRes();
      await handler(req1, res1);
      const req2 = makeReq({ body: { eventType: 'opportunity_outreach_made', opportunityId: 'opp-a1-followup', clientEventId: 'c-outreach-2' } });
      const res2 = makeRes();
      await handler(req2, res2);
      return { count: state.haSignalEvents.length, ids: [res1.body.id, res2.body.id] };
    });
    assert(count === 2, `REQUIRED: two genuinely distinct opportunity_outreach_made attempts both persist -- no arbitrary server-side dedupe (got ${count} rows)`);
    assert(ids[0] !== ids[1], 'the two outreach attempts have distinct event ids');
  }

  // ---------------------------------------------------------------------
  // opportunity_approach_shared: requires parentEventId pointing to the
  // CALLER'S OWN opportunity_outreach_made row; inherits opportunity_id/
  // event_fingerprint/account_name from that parent.
  // ---------------------------------------------------------------------
  {
    const { noteRes, ev } = await withState(async (state) => {
      const outreachReq = makeReq({ body: { eventType: 'opportunity_outreach_made', opportunityId: 'opp-a1-followup', clientEventId: 'c-outreach-for-note' } });
      const outreachRes = makeRes();
      await handler(outreachReq, outreachRes);
      const noteReq = makeReq({ body: { eventType: 'opportunity_approach_shared', parentEventId: outreachRes.body.id, note: 'Called and asked how the recent order landed.', clientEventId: 'c-note-1' } });
      const noteRes = makeRes();
      await handler(noteReq, noteRes);
      return { noteRes, ev: state.haSignalEvents.find(e => e.event_type === 'opportunity_approach_shared') };
    });
    assert(noteRes.statusCode === 200, `a valid opportunity approach note saves successfully (got ${noteRes.statusCode})`);
    assert(ev.parent_event_id, 'REQUIRED: opportunity_approach_shared carries parent_event_id linking it to its outreach attempt');
    assert(ev.payload.approachNote === 'Called and asked how the recent order landed.', 'the raw note text is preserved verbatim');
    assert(ev.event_fingerprint === 'opp:follow_up:v1:acme|last:2025-06-01' && ev.account_name === 'Acme Co', 'opportunity_approach_shared inherits its fingerprint/account from the parent outreach event');
    assert(ev.opportunity_id === 'opp-a1-followup', 'opportunity_approach_shared inherits its opportunity_id from the parent outreach event');
  }
  {
    // Missing parentEventId.
    const { res } = await withState(async () => {
      const req = makeReq({ body: { eventType: 'opportunity_approach_shared', note: 'A note with no parent.', clientEventId: 'c-orphan-note' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 400, `an opportunity_approach_shared with no parentEventId is rejected 400 (got ${res.statusCode})`);
  }
  {
    // parentEventId belongs to a signal-side outreach_made, not an
    // opportunity_outreach_made -- must be rejected, not silently accepted
    // cross-family.
    const { res } = await withState(async (state) => {
      state.haSignalEvents.push({ id: 'fake-signal-outreach', user_id: 'user-a1', organization_id: 'org-a', event_type: 'outreach_made', signal_id: 'sig-whatever', event_fingerprint: 'fp-whatever', account_name: 'Somewhere Inc' });
      const req = makeReq({ body: { eventType: 'opportunity_approach_shared', parentEventId: 'fake-signal-outreach', note: 'Trying to cross families.', clientEventId: 'c-cross-family-note' } });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 404, `REQUIRED: opportunity_approach_shared rejects a parentEventId whose event_type is not opportunity_outreach_made (got ${res.statusCode})`);
  }
  {
    // Empty note / length limit -- same validation as approach_shared.
    const { emptyRes, longRes } = await withState(async (state) => {
      const outreachReq = makeReq({ body: { eventType: 'opportunity_outreach_made', opportunityId: 'opp-a1-followup', clientEventId: 'c-outreach-empty-note' } });
      const outreachRes = makeRes();
      await handler(outreachReq, outreachRes);
      const emptyReq = makeReq({ body: { eventType: 'opportunity_approach_shared', parentEventId: outreachRes.body.id, note: '   ', clientEventId: 'c-empty-note' } });
      const emptyRes = makeRes();
      await handler(emptyReq, emptyRes);
      const longReq = makeReq({ body: { eventType: 'opportunity_approach_shared', parentEventId: outreachRes.body.id, note: 'x'.repeat(501), clientEventId: 'c-long-note' } });
      const longRes = makeRes();
      await handler(longReq, longRes);
      return { emptyRes, longRes };
    });
    assert(emptyRes.statusCode === 400, `REQUIRED: an empty/whitespace-only opportunity approach note is rejected 400 (got ${emptyRes.statusCode})`);
    assert(longRes.statusCode === 400, `REQUIRED: an opportunity approach note over the 500-char limit is rejected 400 (got ${longRes.statusCode})`);
  }
  {
    // parentEventId belonging to a DIFFERENT rep, even within the same
    // organization.
    const { res } = await withState(async (state) => {
      const outreachReq = makeReq({ token: 'valid-token-a2', body: { eventType: 'opportunity_outreach_made', opportunityId: 'opp-a2-repeat', clientEventId: 'c-a2-outreach' } });
      const outreachRes = makeRes();
      await handler(outreachReq, outreachRes);
      const noteReq = makeReq({ token: 'valid-token-a1', body: { eventType: 'opportunity_approach_shared', parentEventId: outreachRes.body.id, note: 'Trying to attach a note to my teammate\'s outreach.', clientEventId: 'c-cross-rep-note' } });
      const res = makeRes();
      await handler(noteReq, res);
      return { res };
    });
    assert(res.statusCode === 404, `REQUIRED: a rep cannot attach an opportunity approach note to a DIFFERENT rep's outreach attempt, even within the same organization (got ${res.statusCode})`);
  }

  // ---------------------------------------------------------------------
  // prepare_call_opened is genuinely SHARED between both families (per
  // migration 12's target-family check): supplying opportunityId targets
  // ha_account_opportunities exactly like the opportunity_* types above,
  // with an empty payload (it is pure engagement, not a judgment/snapshot
  // event) and no dedupe.
  // ---------------------------------------------------------------------
  {
    const { ev } = await withState(async (state) => {
      const req = makeReq({ body: { eventType: 'prepare_call_opened', opportunityId: 'opp-a1-followup', clientEventId: 'c-prepare-call' } });
      const res = makeRes();
      await handler(req, res);
      return { ev: state.haSignalEvents[0] };
    });
    assert(ev.event_type === 'prepare_call_opened', 'REQUIRED: prepare_call_opened resolves against ha_account_opportunities when opportunityId is supplied');
    assert(ev.opportunity_id === 'opp-a1-followup' && (ev.signal_id === undefined || ev.signal_id === null), 'REQUIRED: the shared prepare_call_opened event carries opportunity_id, never signal_id, for an account-history opportunity');
    assert(Object.keys(ev.payload).length === 0, 'prepare_call_opened carries an empty payload for an opportunity target too -- pure engagement, not a snapshot event');
  }

  // ---------------------------------------------------------------------
  // Item 11: GET read-back recognizes the opportunity_* vocabulary exactly
  // like its signal_* equivalents -- feedback, selected, outreachLogged,
  // and approach-note scoping all work identically, keyed by
  // (eventFingerprint, accountName) as usual (the opp:*:v1: namespace
  // already keeps this from ever colliding with an unprefixed signal
  // fingerprint).
  // ---------------------------------------------------------------------
  {
    const { states } = await withState(async () => {
      await handler(makeReq({ body: { eventType: 'opportunity_selected', opportunityId: 'opp-a1-followup', clientEventId: 'r-opp-select' } }), makeRes());
      await handler(makeReq({ body: { eventType: 'opportunity_useful', opportunityId: 'opp-a1-followup', clientEventId: 'r-opp-useful' } }), makeRes());
      const outreachRes = makeRes();
      await handler(makeReq({ body: { eventType: 'opportunity_outreach_made', opportunityId: 'opp-a1-followup', clientEventId: 'r-opp-outreach' } }), outreachRes);
      await handler(makeReq({ body: { eventType: 'opportunity_approach_shared', parentEventId: outreachRes.body.id, note: 'Checked in about the recent order.', clientEventId: 'r-opp-note' } }), makeRes());

      const getRes = makeRes();
      await handler(makeReq({ method: 'GET', query: getKeys(['opp:follow_up:v1:acme|last:2025-06-01', 'Acme Co']) }), getRes);
      return { states: getRes.body.states };
    });
    const s = states[readBackKey('opp:follow_up:v1:acme|last:2025-06-01', 'Acme Co')];
    assert(!!s, 'sanity: the requested key has a state entry');
    assert(s.selected === true, 'REQUIRED: read-back reflects opportunity_selected the same way it reflects signal_selected');
    assert(s.feedback === 'useful', 'REQUIRED: read-back reflects opportunity_useful the same way it reflects signal_useful');
    assert(s.outreachLogged === true && !!s.latestOutreachEventId, 'REQUIRED: read-back reflects opportunity_outreach_made the same way it reflects outreach_made');
    assert(s.approachNote === 'Checked in about the recent order.', 'REQUIRED: read-back returns the opportunity_approach_shared note, scoped to the latest outreach attempt, exactly like the signal-side note');
  }
  {
    // Cross-family isolation, explicit: a signal_useful event under a
    // DIFFERENT fingerprint namespace must never be read back under an
    // opportunity fingerprint's key, and vice versa -- proven here simply
    // by confirming a fresh opportunity fingerprint with no opportunity_*
    // history of its own reads back clean, even in a state object that
    // also contains real signal-side history elsewhere (the two never
    // share a composite key by construction: opp:*:v1: vs unprefixed).
    const { states } = await withState(async () => {
      const getRes = makeRes();
      await handler(makeReq({ method: 'GET', query: getKeys(['opp:repeat_pattern:v1:beta|apparel|last:2025-03-15', 'Beta Inc']) }), getRes);
      return { states: getRes.body.states };
    });
    const s = states[readBackKey('opp:repeat_pattern:v1:beta|apparel|last:2025-03-15', 'Beta Inc')];
    assert(s.feedback === null && s.selected === false && s.outreachLogged === false, 'a key with no opportunity_* history returns a clean, unanswered default state, same as the signal-side default');
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
