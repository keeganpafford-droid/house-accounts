// Notification & Outcome Loop V1 step 3 -- deterministic coverage for
// api/notification-scheduler.js against the REAL, production-bound handler
// export (mocked Supabase/Resend fetch), same convention as
// scripts/test-weekly-monitoring-characterization.js. Proves: auth
// gating, in_app_only users never get email, weekly cadence due-checking
// via the delivery log watermark, empty digests are never sent/logged,
// successful sends create a durable success row, and one user's Resend
// failure never blocks another user's send.
//
// Usage: node scripts/test-notification-scheduler.js
import handler from '../api/notification-scheduler.js';

const CRON_SECRET = 'notification-scheduler-test-secret-1234567890';

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
function makeReq(secret = CRON_SECRET) {
  return { method: 'POST', headers: secret ? { authorization: `Bearer ${secret}` } : {} };
}

function setEnv() {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.RESEND_API_KEY = 'fake-resend-key';
  process.env.ALERTS_FROM_EMAIL = 'House Accounts <alerts@houseaccounts.ai>';
}

function makeMockFetch(state) {
  return async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if (u.includes('api.resend.com')) {
      state.resendCalls.push(JSON.parse(options.body));
      if (state.resendShouldFail) return jsonResponse({ message: 'simulated Resend outage' }, false, 502);
      return jsonResponse({ id: `resend-msg-${state.resendCalls.length}` });
    }
    if (u.includes('/rest/v1/ha_users')) {
      return jsonResponse(state.users);
    }
    if (u.includes('/rest/v1/ha_notification_deliveries')) {
      if (method === 'POST') {
        const rows = JSON.parse(options.body).map(r => ({ id: `delivery-${state.deliveries.length + 1}`, ...r }));
        state.deliveries.push(...rows);
        return jsonResponse(rows);
      }
      // GET: last successful delivery for a specific user.
      const userMatch = /user_id=eq\.([^&]+)/.exec(u);
      const userId = userMatch ? decodeURIComponent(userMatch[1]) : null;
      const rows = state.deliveries
        .filter(d => d.user_id === userId && d.status === 'success')
        .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime());
      return jsonResponse(rows.slice(0, 1));
    }
    if (u.includes('/rest/v1/ha_signals')) {
      const userMatch = /user_id=eq\.([^&]+)/.exec(u);
      const userId = userMatch ? decodeURIComponent(userMatch[1]) : null;
      const watermarkMatch = /first_seen_at=gt\.([^&]+)/.exec(u);
      const watermark = watermarkMatch ? new Date(decodeURIComponent(watermarkMatch[1])).getTime() : 0;
      const rows = (state.signals[userId] || []).filter(s => new Date(s.first_seen_at).getTime() > watermark);
      return jsonResponse(rows);
    }
    if (u.includes('/rest/v1/ha_signal_events')) {
      const userMatch = /user_id=eq\.([^&]+)/.exec(u);
      const userId = userMatch ? decodeURIComponent(userMatch[1]) : null;
      if (u.includes('event_type=eq.outcome_reported')) {
        const match = /parent_event_id=in\.\(([^)]*)\)/.exec(u);
        const ids = match ? match[1].split(',') : [];
        return jsonResponse((state.outcomeEvents[userId] || []).filter(e => ids.includes(e.parent_event_id)));
      }
      return jsonResponse(state.outreachEvents[userId] || []);
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
}

function baseState(overrides = {}) {
  return {
    users: [],
    deliveries: [],
    signals: {},
    outreachEvents: {},
    outcomeEvents: {},
    resendCalls: [],
    resendShouldFail: false,
    ...overrides
  };
}

async function withState(state, fn) {
  setEnv();
  const realFetch = global.fetch;
  global.fetch = makeMockFetch(state);
  try { return await fn(state); }
  finally { global.fetch = realFetch; }
}

async function run() {
  // -------------------------------------------------------------------
  // Auth required.
  // -------------------------------------------------------------------
  {
    const res = makeRes();
    await withState(baseState(), async () => { await handler(makeReq(null), res); });
    assert(res.statusCode === 401, `REQUIRED: no Authorization header is rejected 401 (got ${res.statusCode})`);
  }
  {
    const res = makeRes();
    await withState(baseState(), async () => { await handler(makeReq('wrong-secret'), res); });
    assert(res.statusCode === 401, `REQUIRED: a wrong secret is rejected 401 (got ${res.statusCode})`);
  }

  // -------------------------------------------------------------------
  // in_app_only user never receives email -- excluded from candidates
  // entirely, zero delivery attempts.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [{ id: 'user-inapp', email: 'inapp@example.com', organization_id: 'org-1', notification_preference: 'in_app_only' }],
      signals: { 'user-inapp': [{ id: 'sig-1', account_name: 'Acme', title: 'New activity', first_seen_at: new Date().toISOString() }] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.statusCode === 200, `sanity: the invocation succeeds (got ${res.statusCode})`);
    assert(res.body.usersConsidered === 0, `REQUIRED: an in_app_only user is never a notification candidate, even with real new signals (got ${res.body.usersConsidered})`);
    assert(state.resendCalls.length === 0, 'REQUIRED: zero Resend calls for an in_app_only user');
    assert(state.deliveries.length === 0, 'REQUIRED: zero delivery log rows for an in_app_only user');
  }

  // -------------------------------------------------------------------
  // Weekly user not yet due (last success < 7 days ago) -- skipped
  // entirely, no new delivery row, no email.
  // -------------------------------------------------------------------
  {
    const recentSuccess = { id: 'prior-1', user_id: 'user-weekly', status: 'success', sent_at: new Date(Date.now() - 2 * 86400000).toISOString(), included_signal_ids: [], included_outreach_event_ids: [] };
    const state = baseState({
      users: [{ id: 'user-weekly', email: 'weekly@example.com', organization_id: 'org-1', notification_preference: 'weekly' }],
      deliveries: [recentSuccess],
      signals: { 'user-weekly': [{ id: 'sig-1', account_name: 'Acme', title: 'New activity', first_seen_at: new Date().toISOString() }] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.body.notDue === 1, `REQUIRED: a weekly user only 2 days past their last successful send is not due yet (got notDue=${res.body.notDue})`);
    assert(state.resendCalls.length === 0, 'no email sent for a not-yet-due weekly user, even though real new signals exist');
    assert(state.deliveries.length === 1, 'REQUIRED: no new delivery row is created for a not-due skip -- only the pre-existing row remains');
  }

  // -------------------------------------------------------------------
  // Daily user with nothing new and nothing eligible -- empty digest is
  // never sent and never logged.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [{ id: 'user-daily-empty', email: 'empty@example.com', organization_id: 'org-1', notification_preference: 'daily' }],
      signals: { 'user-daily-empty': [] },
      outreachEvents: { 'user-daily-empty': [] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.body.emptyDigest === 1, `REQUIRED: a user with zero new signals and zero unresolved outreach produces an empty-digest skip (got ${JSON.stringify(res.body)})`);
    assert(state.resendCalls.length === 0, 'REQUIRED: zero Resend calls for an empty digest -- never send "nothing happened"');
    assert(state.deliveries.length === 0, 'REQUIRED: zero delivery log rows for an empty-digest skip -- the log only records genuine send decisions');
  }

  // -------------------------------------------------------------------
  // Daily user with real new content: never sent before -> due, real
  // signal exists -> email sent, a success delivery row is created with
  // the correct included ids/counts.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [{ id: 'user-daily-new', email: 'new@example.com', organization_id: 'org-1', notification_preference: 'daily' }],
      signals: { 'user-daily-new': [{ id: 'sig-dover', account_name: 'Dover Honda', title: 'Holiday parade activity', first_seen_at: new Date(Date.now() - 3600000).toISOString() }] },
      outreachEvents: { 'user-daily-new': [] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.body.sent === 1, `REQUIRED: a daily user with a real new signal gets an email sent (got ${JSON.stringify(res.body)})`);
    assert(state.resendCalls.length === 1, 'exactly one Resend call happened');
    assert(state.resendCalls[0].subject.includes('Dover Honda'), `REQUIRED: the sent email's subject reflects the real account (got ${JSON.stringify(state.resendCalls[0].subject)})`);
    assert(state.deliveries.length === 1 && state.deliveries[0].status === 'success', 'REQUIRED: a status=success delivery row is created');
    assert(JSON.stringify(state.deliveries[0].included_signal_ids) === JSON.stringify(['sig-dover']), 'REQUIRED: the delivery row records exactly which signal was included, for future dedupe/audit');
  }

  // -------------------------------------------------------------------
  // Weekly user, never sent before (no prior row at all) -- always due on
  // their first-ever invocation.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [{ id: 'user-weekly-first', email: 'weeklyfirst@example.com', organization_id: 'org-1', notification_preference: 'weekly' }],
      signals: { 'user-weekly-first': [{ id: 'sig-1', account_name: 'ABC Manufacturing', title: 'New facility expansion', first_seen_at: new Date(Date.now() - 3600000).toISOString() }] },
      outreachEvents: { 'user-weekly-first': [] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.body.sent === 1, `REQUIRED: a weekly user with no prior delivery at all is due on their first invocation (got ${JSON.stringify(res.body)})`);
  }

  // -------------------------------------------------------------------
  // REQUIRED: a Resend failure for one user is logged as 'failed' and
  // does NOT block a second user's send in the same invocation.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [
        { id: 'user-fail', email: 'fail@example.com', organization_id: 'org-1', notification_preference: 'daily' },
        { id: 'user-ok', email: 'ok@example.com', organization_id: 'org-1', notification_preference: 'daily' }
      ],
      signals: {
        'user-fail': [{ id: 'sig-fail', account_name: 'Acme', title: 'Signal', first_seen_at: new Date(Date.now() - 3600000).toISOString() }],
        'user-ok': [{ id: 'sig-ok', account_name: 'Beta', title: 'Signal', first_seen_at: new Date(Date.now() - 3600000).toISOString() }]
      },
      outreachEvents: { 'user-fail': [], 'user-ok': [] },
      resendShouldFail: true
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    // Both users' emails "fail" here since resendShouldFail is global to
    // this mock -- proves both are isolated (both attempted, both logged),
    // not that the second short-circuits after the first's failure.
    assert(res.body.failed === 2, `REQUIRED: both users' failed sends are counted, proving neither blocked the other's attempt (got ${JSON.stringify(res.body)})`);
    assert(state.deliveries.every(d => d.status === 'failed'), 'REQUIRED: every failed send is logged as status=failed, never silently dropped');
    assert(state.deliveries.length === 2, 'REQUIRED: one delivery row per user, even on failure');
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
