// Notification & Outcome Loop V1 step 3 -- deterministic coverage for
// api/notification-scheduler.js against the REAL, production-bound handler
// export (mocked Supabase/Resend fetch), same convention as
// scripts/test-weekly-monitoring-characterization.js. Proves: auth
// gating, the NOTIFICATION_ENABLED_ORGANIZATION_IDS activation gate,
// in_app_only users never get email, weekly cadence due-checking via the
// delivery log watermark, empty digests are never sent/logged, successful
// sends create a durable success row, one user's Resend failure never
// blocks another user's send, an ignored prompt is not repeated on
// consecutive daily runs, and cross-user isolation of digest content.
//
// Every scenario below except the dedicated allowlist-gate block sets
// NOTIFICATION_ENABLED_ORGANIZATION_IDS to 'org-1' (the org every other
// fixture user belongs to) -- proving those behaviors while the gate is
// open, since the gate itself is covered separately.
//
// Usage: node scripts/test-notification-scheduler.js
import handler, { isNotificationEnabledOrganization } from '../api/notification-scheduler.js';

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

function setEnv({ allowlist = 'org-1' } = {}) {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.RESEND_API_KEY = 'fake-resend-key';
  process.env.ALERTS_FROM_EMAIL = 'House Accounts <alerts@houseaccounts.ai>';
  if (allowlist === null) delete process.env.NOTIFICATION_ENABLED_ORGANIZATION_IDS;
  else process.env.NOTIFICATION_ENABLED_ORGANIZATION_IDS = allowlist;
}

function makeMockFetch(state) {
  return async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    if (u.includes('api.resend.com')) {
      state.resendCalls.push(JSON.parse(options.body));
      if (state.resendShouldFail) return jsonResponse({ message: 'simulated Resend outage' }, false, 502);
      // Simulates a 2xx response that -- contrary to Resend's own
      // documented SendEmailResponse schema -- carries no id. Genuinely
      // undocumented/anomalous, but the code must still fail closed
      // against it rather than trust "the request didn't throw."
      if (state.resendAmbiguousResponse) return jsonResponse({});
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
    if (u.includes('/rest/v1/ha_monitoring_targets')) {
      return jsonResponse(state.monitoringTargets || []);
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
    monitoringTargets: [],
    resendCalls: [],
    resendShouldFail: false,
    resendAmbiguousResponse: false,
    ...overrides
  };
}

// Same real, actionable payload shape as scripts/test-notification-digest.js
// (matches classifyLegacySignalActionability's own requirements for
// isPriorityEligible:true) with no identityConfidence set, so the LEGACY
// GRANDFATHER clause in classifyMonitoringSignalEligibility() treats it as
// 'priority' by default -- every fixture in this file uses this unless a
// test is specifically exercising the priority/secondary distinction.
function actionablePayload(overrides = {}) {
  return {
    concreteTrigger: 'Flagship Store Reopening',
    title: 'Flagship Store Reopening',
    businessContext: 'The flagship store has undergone extensive renovations, indicating a commitment to enhancing customer experience and brand presence.',
    publishedAt: 'Jun 11, 2026',
    event_date: '2026-12-01',
    eventDateConfidence: 'exact',
    ...overrides
  };
}

async function withState(state, fn, envOpts) {
  setEnv(envOpts);
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
  // NOTIFICATION_ENABLED_ORGANIZATION_IDS: activation safety, fail-closed.
  // -------------------------------------------------------------------
  {
    assert(isNotificationEnabledOrganization('org-1', '') === false, 'an empty allowlist enables no organization');
    assert(isNotificationEnabledOrganization('org-1', undefined) === false, 'an unset allowlist enables no organization (the default, no-op state)');
    assert(isNotificationEnabledOrganization('41e28b77-fe7f-49ea-b299-e361fd03df6d', '41e28b77-fe7f-49ea-b299-e361fd03df6d') === true, 'an exact single-entry allowlist match is enabled');
    assert(isNotificationEnabledOrganization('org-2', 'org-1,org-2,org-3') === true, 'a multi-entry allowlist match is enabled');
    assert(isNotificationEnabledOrganization('org-4', 'org-1,org-2,org-3') === false, 'an organization not in the allowlist is not enabled');
    assert(isNotificationEnabledOrganization(null, 'org-1') === false, 'a null/missing organizationId is never enabled, even with a non-empty allowlist');
  }
  {
    // REQUIRED: with the env var unset entirely, nobody is a candidate --
    // not even a daily user with real, waiting content -- and the ha_users
    // query never even runs (usersConsidered stays 0, no fetch beyond the
    // gate check).
    const state = baseState({
      users: [{ id: 'user-x', email: 'x@example.com', organization_id: 'org-1', notification_preference: 'daily' }],
      signals: { 'user-x': [{ id: 'sig-1', account_name: 'Acme', title: 'New activity', first_seen_at: new Date().toISOString(), payload: actionablePayload() }] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); }, { allowlist: null });
    assert(res.statusCode === 200 && res.body.usersConsidered === 0, `REQUIRED: an unset NOTIFICATION_ENABLED_ORGANIZATION_IDS considers zero users, even with real waiting content (got ${JSON.stringify(res.body)})`);
    assert(state.resendCalls.length === 0, 'REQUIRED: zero Resend calls when the activation gate is closed');
    assert(state.deliveries.length === 0, 'REQUIRED: zero delivery log rows when the activation gate is closed');
  }
  {
    // A user whose org is NOT in a non-empty allowlist is skipped, while a
    // user whose org IS in it proceeds normally -- proves the gate
    // discriminates per-org, not just on/off globally.
    const state = baseState({
      users: [
        { id: 'user-not-enabled', email: 'not-enabled@example.com', organization_id: 'org-other', notification_preference: 'daily' },
        { id: 'user-enabled', email: 'enabled@example.com', organization_id: 'org-1', notification_preference: 'daily' }
      ],
      signals: {
        'user-not-enabled': [{ id: 'sig-1', account_name: 'Acme', title: 'New activity', first_seen_at: new Date().toISOString(), payload: actionablePayload() }],
        'user-enabled': [{ id: 'sig-2', account_name: 'Beta', title: 'New activity', first_seen_at: new Date().toISOString(), payload: actionablePayload() }]
      },
      outreachEvents: { 'user-not-enabled': [], 'user-enabled': [] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); }, { allowlist: 'org-1' });
    assert(res.body.usersConsidered === 1, `REQUIRED: only the user whose organization is in the allowlist is considered (got ${JSON.stringify(res.body)})`);
    assert(state.resendCalls.length === 1, 'exactly one email sent -- the enabled org\'s user');
    assert(state.deliveries.length === 1 && state.deliveries[0].user_id === 'user-enabled', 'REQUIRED: the delivery row belongs to the enabled-org user, never the excluded one');
  }
  {
    // REQUIRED: an in_app_only user is excluded EVEN when their org is
    // enabled -- the allowlist is activation safety, not a substitute for
    // the user's own notification_preference.
    const state = baseState({
      users: [{ id: 'user-inapp-enabled', email: 'inapp-enabled@example.com', organization_id: 'org-1', notification_preference: 'in_app_only' }],
      signals: { 'user-inapp-enabled': [{ id: 'sig-1', account_name: 'Acme', title: 'New activity', first_seen_at: new Date().toISOString(), payload: actionablePayload() }] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); }, { allowlist: 'org-1' });
    assert(res.body.usersConsidered === 0, `REQUIRED: in_app_only is excluded even when the org itself is enabled (got ${JSON.stringify(res.body)})`);
  }

  // -------------------------------------------------------------------
  // in_app_only user never receives email -- excluded from candidates
  // entirely, zero delivery attempts.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [{ id: 'user-inapp', email: 'inapp@example.com', organization_id: 'org-1', notification_preference: 'in_app_only' }],
      signals: { 'user-inapp': [{ id: 'sig-1', account_name: 'Acme', title: 'New activity', first_seen_at: new Date().toISOString(), payload: actionablePayload() }] }
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
      signals: { 'user-weekly': [{ id: 'sig-1', account_name: 'Acme', title: 'New activity', first_seen_at: new Date().toISOString(), payload: actionablePayload() }] }
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
  // REQUIRED (signal doctrine correction): a recent PRIORITY signal is
  // included in the actual sent email while a recent SECONDARY signal
  // (same digest, same age) is excluded -- end to end through the real
  // handler, real ha_monitoring_targets fetch, and real
  // classifyMonitoringSignalEligibility()/classifyLegacySignalActionability()
  // policy, not a mocked/bypassed eligibility check.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [{ id: 'user-doctrine', email: 'doctrine@example.com', organization_id: 'org-1', notification_preference: 'daily' }],
      signals: {
        'user-doctrine': [
          // Priority via Path A: strong signal-level corroboration.
          { id: 'sig-priority', account_name: 'Priority Co', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload({ identityConfidence: 'confirmed', identityCorroboratorReasons: ['verified company domain'] }) },
          // Secondary: weak corroboration, no strong target anchor -- must
          // never enter the email.
          { id: 'sig-secondary', account_name: 'Secondary Co', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload({ identityConfidence: 'possible', identityCorroboratorReasons: ['location match'] }) }
        ]
      },
      outreachEvents: { 'user-doctrine': [] },
      // Neither account has a resolved monitoring target -- Path B grants
      // no benefit to either, proving the exclusion is genuinely about the
      // signal's own weak corroboration, not an artifact of missing target data.
      monitoringTargets: []
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.body.sent === 1, `sanity: the user receives an email (has real priority content) (got ${JSON.stringify(res.body)})`);
    assert(state.resendCalls[0].html.includes('Priority Co'), 'REQUIRED: the sent email contains the priority-eligible signal');
    assert(!state.resendCalls[0].html.includes('Secondary Co'), 'REQUIRED: the sent email does NOT contain the secondary-tier signal -- a persisted ha_signals row is not automatically eligible for a proactive notification');
    assert(JSON.stringify(state.deliveries[0].included_signal_ids) === JSON.stringify(['sig-priority']), 'REQUIRED: the delivery log\'s included_signal_ids records only the priority signal, confirming the secondary signal was excluded from selection itself, not merely hidden in rendering');
  }

  // -------------------------------------------------------------------
  // Daily user with real new content: never sent before -> due, real
  // signal exists -> email sent, a success delivery row is created with
  // the correct included ids/counts.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [{ id: 'user-daily-new', email: 'new@example.com', organization_id: 'org-1', notification_preference: 'daily' }],
      signals: { 'user-daily-new': [{ id: 'sig-dover', account_name: 'Dover Honda', title: 'Holiday parade activity', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload() }] },
      outreachEvents: { 'user-daily-new': [] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.body.sent === 1, `REQUIRED: a daily user with a real new signal gets an email sent (got ${JSON.stringify(res.body)})`);
    assert(state.resendCalls.length === 1, 'exactly one Resend call happened');
    assert(state.resendCalls[0].html.includes('Dover Honda'), `REQUIRED: the sent email's body reflects the real account (got no match in the HTML)`);
    assert(state.resendCalls[0].subject === '1 account worth a look', `REQUIRED: the subject uses the concise, count-based phrasing (never names an individual account) (got ${JSON.stringify(state.resendCalls[0].subject)})`);
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
      signals: { 'user-weekly-first': [{ id: 'sig-1', account_name: 'ABC Manufacturing', title: 'New facility expansion', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload() }] },
      outreachEvents: { 'user-weekly-first': [] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.body.sent === 1, `REQUIRED: a weekly user with no prior delivery at all is due on their first invocation (got ${JSON.stringify(res.body)})`);
  }

  // -------------------------------------------------------------------
  // REQUIRED (Notification & Outcome Loop V1 pre-QA verification item 2):
  // an ignored automatic outcome prompt is not repeated on the very next
  // daily invocation merely because the rep hasn't answered -- integration-
  // level proof (unit coverage already exists in
  // scripts/test-notification-digest.js) that two real, consecutive
  // handler invocations against the SAME unanswered outreach item actually
  // produce this behavior end to end.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [{ id: 'user-repeat-check', email: 'repeat@example.com', organization_id: 'org-1', notification_preference: 'daily' }],
      signals: { 'user-repeat-check': [] },
      // Old enough (>=5 days) to already be eligible for an automatic
      // prompt, never reported on -- exactly the "still waiting, ignored"
      // case.
      outreachEvents: { 'user-repeat-check': [{ id: 'or-repeat', event_fingerprint: 'fp-repeat', signal_id: 'sig-repeat', opportunity_id: null, account_name: 'Dover Honda', created_at: new Date(Date.now() - 10 * 86400000).toISOString() }] },
      outcomeEvents: { 'user-repeat-check': [] }
    });
    const firstRes = makeRes();
    await withState(state, async () => { await handler(makeReq(), firstRes); });
    assert(firstRes.body.sent === 1, `REQUIRED: the first invocation sends the outreach prompt, since it is eligible and has never been mentioned (got ${JSON.stringify(firstRes.body)})`);
    assert(state.resendCalls[0].html.includes('Dover Honda'), 'the first email actually contains the outreach prompt');

    // Second invocation, same day, nothing about the outreach item has
    // changed (no new outcome_reported, no new signals) -- must NOT
    // resend the same prompt.
    const secondRes = makeRes();
    await withState(state, async () => { await handler(makeReq(), secondRes); });
    assert(secondRes.body.emptyDigest === 1, `REQUIRED: the second consecutive daily invocation, with nothing changed, produces an empty digest -- the prompt is not repeated (got ${JSON.stringify(secondRes.body)})`);
    assert(state.resendCalls.length === 1, `REQUIRED: still exactly one Resend call total across both invocations -- the second run sent nothing (got ${state.resendCalls.length})`);
    assert(state.deliveries.length === 1, 'REQUIRED: no second delivery row was created for the suppressed repeat');
  }

  // -------------------------------------------------------------------
  // REQUIRED (Notification & Outcome Loop V1 pre-QA verification item 3):
  // notification selection is strictly user/org scoped -- two different
  // users, each with their own real signal and their own real unresolved
  // outreach, must never see the other's content in their digest.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [
        { id: 'user-iso-a', email: 'iso-a@example.com', organization_id: 'org-1', notification_preference: 'daily' },
        { id: 'user-iso-b', email: 'iso-b@example.com', organization_id: 'org-1', notification_preference: 'daily' }
      ],
      signals: {
        'user-iso-a': [{ id: 'sig-a', account_name: 'Alpha Corp', title: 'Alpha signal', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload() }],
        'user-iso-b': [{ id: 'sig-b', account_name: 'Bravo Corp', title: 'Bravo signal', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload() }]
      },
      outreachEvents: {
        'user-iso-a': [{ id: 'or-a', event_fingerprint: 'fp-a', signal_id: 'sig-a', opportunity_id: null, account_name: 'Alpha Corp', created_at: new Date(Date.now() - 10 * 86400000).toISOString() }],
        'user-iso-b': [{ id: 'or-b', event_fingerprint: 'fp-b', signal_id: 'sig-b', opportunity_id: null, account_name: 'Bravo Corp', created_at: new Date(Date.now() - 10 * 86400000).toISOString() }]
      },
      outcomeEvents: { 'user-iso-a': [], 'user-iso-b': [] }
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.body.sent === 2, `sanity: both isolated users get a real send (got ${JSON.stringify(res.body)})`);
    assert(state.resendCalls.length === 2, 'exactly two Resend calls, one per user');

    const callToA = state.resendCalls.find(c => c.to === 'iso-a@example.com');
    const callToB = state.resendCalls.find(c => c.to === 'iso-b@example.com');
    assert(callToA.html.includes('Alpha Corp') && !callToA.html.includes('Bravo Corp'), 'REQUIRED: user A\'s email contains only Alpha Corp -- never Bravo Corp\'s signal or outreach prompt');
    assert(callToB.html.includes('Bravo Corp') && !callToB.html.includes('Alpha Corp'), 'REQUIRED: user B\'s email contains only Bravo Corp -- never Alpha Corp\'s signal or outreach prompt');

    const deliveryA = state.deliveries.find(d => d.user_id === 'user-iso-a');
    const deliveryB = state.deliveries.find(d => d.user_id === 'user-iso-b');
    assert(JSON.stringify(deliveryA.included_signal_ids) === JSON.stringify(['sig-a']), 'REQUIRED: user A\'s delivery log row records only user A\'s own signal id');
    assert(JSON.stringify(deliveryB.included_signal_ids) === JSON.stringify(['sig-b']), 'REQUIRED: user B\'s delivery log row records only user B\'s own signal id');
    assert(JSON.stringify(deliveryA.included_outreach_event_ids) === JSON.stringify(['or-a']), 'REQUIRED: user A\'s delivery log row records only user A\'s own outreach event id, never user B\'s');
    assert(JSON.stringify(deliveryB.included_outreach_event_ids) === JSON.stringify(['or-b']), 'REQUIRED: user B\'s delivery log row records only user B\'s own outreach event id, never user A\'s');
  }

  // -------------------------------------------------------------------
  // REQUIRED (delivery-success contract correction): only a positively-
  // confirmed provider send (a real, non-empty string id) may count as
  // 'sent', advance the watermark, or suppress an outreach prompt.
  // sendEmail() -> { skipped: true } (e.g. RESEND_API_KEY unset in this
  // environment) must NEVER be treated as a successful delivery.
  // -------------------------------------------------------------------
  {
    const state = baseState({
      users: [{ id: 'user-skip', email: 'skip@example.com', organization_id: 'org-1', notification_preference: 'daily' }],
      signals: { 'user-skip': [{ id: 'sig-skip', account_name: 'Acme', title: 'Signal', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload() }] },
      outreachEvents: { 'user-skip': [{ id: 'or-skip', event_fingerprint: 'fp-skip', signal_id: 'sig-skip-outreach', opportunity_id: null, account_name: 'Acme', created_at: new Date(Date.now() - 10 * 86400000).toISOString() }] },
      outcomeEvents: { 'user-skip': [] }
    });
    const originalKey = process.env.RESEND_API_KEY;
    const res = makeRes();
    await withState(state, async () => {
      delete process.env.RESEND_API_KEY; // simulates the exact live-QA condition
      await handler(makeReq(), res);
    });
    if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;

    assert(res.body.sent === 0, `REQUIRED: sent stays 0 when sendEmail() returns { skipped: true } -- "did not throw" is never treated as delivery (got ${JSON.stringify(res.body)})`);
    assert(res.body.skipped === 1, `REQUIRED: the skip is counted in its own bucket, distinct from a genuine provider failure (got ${JSON.stringify(res.body)})`);
    assert(state.resendCalls.length === 0, 'sanity: sendEmail() never even reaches the Resend API call when the key is missing');
    assert(state.deliveries.length === 1, 'REQUIRED: a durable record of the skipped attempt IS persisted -- delivery is never silently pretended or silently dropped');
    assert(state.deliveries[0].status === 'failed', `REQUIRED: a skipped send is recorded as 'failed' (the schema's existing two-value status vocabulary), never 'success' (got ${state.deliveries[0].status})`);
    assert(state.deliveries[0].resend_message_id == null, 'REQUIRED: no provider message id is stored for a skipped send');
    assert(/RESEND_API_KEY/.test(state.deliveries[0].error || ''), `REQUIRED: the persisted error is honest about why -- names the missing key, not a generic failure (got ${JSON.stringify(state.deliveries[0].error)})`);

    // The critical regression: a SECOND invocation, now with a real key,
    // must still find the SAME signal and the SAME outreach prompt
    // eligible -- proving the skipped attempt left no false watermark and
    // suppressed nothing.
    const secondRes = makeRes();
    await withState(state, async () => { await handler(makeReq(), secondRes); });
    assert(secondRes.body.sent === 1, `REQUIRED: the signal remains eligible on the next invocation -- the skipped attempt never advanced the watermark (got ${JSON.stringify(secondRes.body)})`);
    assert(state.resendCalls.length === 1, 'the real send only happens once real transport succeeds');
    const successRow = state.deliveries.find(d => d.status === 'success');
    assert(!!successRow, 'a genuine success row now exists');
    assert(JSON.stringify(successRow.included_signal_ids) === JSON.stringify(['sig-skip']), 'REQUIRED: the previously-skipped signal is included in the first REAL successful delivery, not lost');
    assert(JSON.stringify(successRow.included_outreach_event_ids) === JSON.stringify(['or-skip']), 'REQUIRED: the outreach prompt ALSO remains eligible after the skipped attempt -- it was never suppressed by a delivery that didn\'t actually happen');
  }
  {
    // REQUIRED (item 6, provider-error/ambiguous-response coverage): a 2xx
    // Resend response that -- contrary to its own documented schema --
    // carries no id must ALSO fail closed, not just the explicit
    // { skipped: true } no-op path. "No throw" is never sufficient proof
    // of delivery, regardless of which code path produced the falsy id.
    const state = baseState({
      users: [{ id: 'user-ambiguous', email: 'ambiguous@example.com', organization_id: 'org-1', notification_preference: 'daily' }],
      signals: { 'user-ambiguous': [{ id: 'sig-ambiguous', account_name: 'Acme', title: 'Signal', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload() }] },
      outreachEvents: { 'user-ambiguous': [] },
      resendAmbiguousResponse: true
    });
    const res = makeRes();
    await withState(state, async () => { await handler(makeReq(), res); });
    assert(res.body.sent === 0, `REQUIRED: a 2xx Resend response with no id is never counted as sent (got ${JSON.stringify(res.body)})`);
    assert(state.resendCalls.length === 1, 'sanity: the Resend call genuinely happened this time (unlike the missing-key case) -- this is a distinct code path from the skip');
    assert(state.deliveries.length === 1 && state.deliveries[0].status === 'failed', 'REQUIRED: the ambiguous response is still logged as a durable failed attempt');
    assert(state.deliveries[0].resend_message_id == null, 'no message id is stored when none was actually returned');
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
        'user-fail': [{ id: 'sig-fail', account_name: 'Acme', title: 'Signal', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload() }],
        'user-ok': [{ id: 'sig-ok', account_name: 'Beta', title: 'Signal', first_seen_at: new Date(Date.now() - 3600000).toISOString(), payload: actionablePayload() }]
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
    assert(res.body.skipped === 0, 'REQUIRED: a genuine provider error (throws) is counted as failed, never conflated with the distinct skipped bucket');
    assert(state.deliveries.every(d => d.status === 'failed'), 'REQUIRED: every failed send is logged as status=failed, never silently dropped');
    assert(state.deliveries.length === 2, 'REQUIRED: one delivery row per user, even on failure');
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
