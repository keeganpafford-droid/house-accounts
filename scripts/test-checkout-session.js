// Pricing/billing sprint: validates api/create-checkout-session.js against
// mocked Supabase + Stripe fetch calls (no live network). Confirms: auth
// and owner-role gates, server-side band re-derivation (never trusting a
// client-picked band), free/enterprise bands are rejected (no checkout
// for either), a missing Stripe Price ID configuration fails loudly
// instead of silently, and a Stripe customer is created once and reused
// on subsequent checkouts.
//
// Usage: node scripts/test-checkout-session.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';
process.env.STRIPE_PRICE_ID_500 = 'price_test_500';
process.env.STRIPE_PRICE_ID_1000 = 'price_test_1000';
delete process.env.STRIPE_PRICE_ID_250; // deliberately left unconfigured for one test case

import handler from '../api/create-checkout-session.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const ORG_ID = 'org-1';
let orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: null };
const OWNER = { id: 'user-owner', auth_user_id: 'auth-owner', email: 'owner@example.com', organization_id: ORG_ID, app_role: 'owner' };
const MEMBER = { id: 'user-member', auth_user_id: 'auth-member', email: 'member@example.com', organization_id: ORG_ID, app_role: 'member' };

function jsonResponse(data, ok = true, status = 200){
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

let stripeCustomerCreateCalls = 0;
let stripeCheckoutSessionCalls = [];
let stripePortalSessionCalls = [];
// Keyed by "customers/cus_x" / "subscriptions/sub_x" -- {status:404} means
// "does not resolve in this Stripe environment" (deleted, or minted under a
// different test/live key than STRIPE_SECRET_KEY currently points at);
// omit an id here to have it resolve as a real, live object.
let stripeGetOverrides = {};

function mockFetch(authUserForToken){
  return async (url, options = {}) => {
    const u = String(url);
    if(u.includes('/auth/v1/user')) return jsonResponse({ id: authUserForToken.auth_user_id, email: authUserForToken.email });
    if(u.includes('/rest/v1/ha_users?auth_user_id=eq.')){
      const match = [OWNER, MEMBER].find(x => u.includes(encodeURIComponent(x.auth_user_id)));
      return jsonResponse(match ? [match] : []);
    }
    if(u.includes('/rest/v1/ha_organizations?id=eq.') && (!options.method || options.method === 'GET')) return jsonResponse([{ ...orgState }]);
    if(u.includes('/rest/v1/ha_organizations?id=eq.') && options.method === 'PATCH'){
      const patch = JSON.parse(options.body);
      orgState = { ...orgState, ...patch };
      return jsonResponse([{ ...orgState }]);
    }
    if(u.includes('api.stripe.com/v1/customers/') && (!options.method || options.method === 'GET')){
      const id = u.split('api.stripe.com/v1/customers/')[1];
      if(stripeGetOverrides[`customers/${id}`]?.status === 404) return jsonResponse({ error: { code: 'resource_missing', message: `No such customer: '${id}'` } }, false, 404);
      return jsonResponse({ id, deleted: false });
    }
    if(u.includes('api.stripe.com/v1/subscriptions/') && (!options.method || options.method === 'GET')){
      const id = u.split('api.stripe.com/v1/subscriptions/')[1];
      if(stripeGetOverrides[`subscriptions/${id}`]?.status === 404) return jsonResponse({ error: { code: 'resource_missing', message: `No such subscription: '${id}'` } }, false, 404);
      return jsonResponse({ id, status: stripeGetOverrides[`subscriptions/${id}`]?.status || 'active' });
    }
    if(u.includes('api.stripe.com/v1/customers') && options.method === 'POST'){
      stripeCustomerCreateCalls += 1;
      return jsonResponse({ id: 'cus_test_123' });
    }
    if(u.includes('api.stripe.com/v1/checkout/sessions') && options.method === 'POST'){
      stripeCheckoutSessionCalls.push(options.body);
      return jsonResponse({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' });
    }
    if(u.includes('api.stripe.com/v1/billing_portal/sessions') && options.method === 'POST'){
      stripePortalSessionCalls.push(options.body);
      return jsonResponse({ id: 'bps_test_abc', url: 'https://billing.stripe.com/p/session/bps_test_abc' });
    }
    throw new Error(`Unhandled mock fetch URL in test: ${u}`);
  };
}

function fakeReq({ method = 'POST', token = 'valid-token', body = {} }){
  return { method, headers: { authorization: token ? `Bearer ${token}` : '' }, body };
}
function fakeRes(){
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}

const originalFetch = global.fetch;

async function run(){
  // 1. Non-owner is rejected.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: null };
    global.fetch = mockFetch(MEMBER);
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 300 } }), res);
    assert(res.statusCode === 403, 'a non-owner is rejected from starting checkout');
  }

  // 2. Unauthenticated is rejected.
  {
    global.fetch = async (url) => { if(String(url).includes('/auth/v1/user')) return jsonResponse({}, false, 401); throw new Error('should not reach REST calls when unauthenticated'); };
    const res = fakeRes();
    await handler(fakeReq({ token: '', body: { requestedAccountCount: 300 } }), res);
    assert(res.statusCode === 401, 'an unauthenticated request is rejected');
  }

  // 3. Free-range count is rejected -- no checkout for Free.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: null };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 5 } }), res);
    assert(res.statusCode === 400, 'a requested count within the Free band (5 accounts) is rejected -- Free needs no checkout');
  }

  // 4. Enterprise-range count is rejected -- no self-serve checkout for it.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: null };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 5000 } }), res);
    assert(res.statusCode === 400, 'a requested count over 2,500 (Enterprise) is rejected -- that state is contact-sales, not Checkout');
  }

  // 5. Invalid/missing count is rejected.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: null };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: {} }), res);
    assert(res.statusCode === 400, 'a missing requestedAccountCount is rejected');
  }

  // 6. A missing Stripe Price ID configuration for the resolved band fails
  // loudly (500), not silently checking out at the wrong price.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: 'cus_existing' };
    global.fetch = mockFetch(OWNER);
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 200 } }), res); // resolves to band_250, deliberately unconfigured
    assert(res.statusCode === 500, 'a resolved band with no configured Stripe Price ID env var fails loudly rather than silently proceeding');
  }

  // 7. Happy path, org with no existing Stripe customer: creates one,
  // persists it, creates a Checkout Session for the server-derived band,
  // returns the redirect URL.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: null };
    global.fetch = mockFetch(OWNER);
    stripeCustomerCreateCalls = 0;
    stripeCheckoutSessionCalls = [];
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 387 } }), res); // founder's own worked example -> "up to 500"
    assert(res.statusCode === 200, 'a valid paid-band checkout request succeeds');
    assert(res.body.url === 'https://checkout.stripe.com/c/pay/cs_test_abc', 'the response includes the Stripe-hosted Checkout redirect URL');
    assert(res.body.band.key === 'band_500', '387 accounts server-side resolves to the "up to 500" band, matching the founder\'s own worked example');
    assert(stripeCustomerCreateCalls === 1, 'a Stripe customer is created exactly once for an org with no existing stripe_customer_id');
    assert(orgState.stripe_customer_id === 'cus_test_123', 'the newly created Stripe customer id is persisted onto the organization');
    assert(stripeCheckoutSessionCalls.length === 1, 'exactly one Checkout Session is created');
    assert(stripeCheckoutSessionCalls[0].includes('price%5D=price_test_500'), 'the Checkout Session line item uses the real Price ID resolved for the 500 band, not a client-supplied value');
    assert(stripeCheckoutSessionCalls[0].includes(`organization_id%5D=${ORG_ID}`), 'the Checkout Session metadata carries the organization_id for the webhook to resolve later');
  }

  // 8. Happy path, org with an existing Stripe customer: reuses it, does
  // not create a second one.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: 'cus_existing_456' };
    global.fetch = mockFetch(OWNER);
    stripeCustomerCreateCalls = 0;
    stripeCheckoutSessionCalls = [];
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 900 } }), res);
    assert(res.statusCode === 200 && res.body.band.key === 'band_1000', '900 accounts resolves to the 1000 band');
    assert(stripeCustomerCreateCalls === 0, 'no new Stripe customer is created when the org already has one');
    assert(stripeCheckoutSessionCalls[0].includes('customer=cus_existing_456'), 'the existing Stripe customer id is reused for the Checkout Session');
  }

  // 9. Production incident regression: a stale/deleted/wrong-Stripe-environment
  // customer id on a NOT-currently-paid org (free, canceled, never-converted)
  // is handled safely -- a fresh customer is created and persisted, checkout
  // proceeds normally. This is the exact "No such customer" shape (a stored
  // id that no longer resolves), confirmed live for the founder's own org.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: 'cus_stale_from_test_mode', subscription_status: 'inactive' };
    stripeGetOverrides = { 'customers/cus_stale_from_test_mode': { status: 404 } };
    global.fetch = mockFetch(OWNER);
    stripeCustomerCreateCalls = 0;
    stripeCheckoutSessionCalls = [];
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 387 } }), res);
    assert(res.statusCode === 200, `REQUIRED: a stale/invalid stored customer id on a non-paid org never surfaces a raw Stripe error -- checkout still succeeds (got ${res.statusCode}: ${res.body?.error})`);
    assert(stripeCustomerCreateCalls === 1, 'REQUIRED: the stale customer id is treated as absent -- exactly one fresh Stripe customer is created');
    assert(orgState.stripe_customer_id === 'cus_test_123', 'REQUIRED: the fresh customer id replaces the stale one on the organization record');
    assert(stripeCheckoutSessionCalls[0].includes('customer=cus_test_123'), 'the Checkout Session uses the new, valid customer id, never the stale one');
    stripeGetOverrides = {};
  }

  // 10. REQUIRED: an org whose subscription_status is already active/paid/manual,
  // with a verifiably real Stripe subscription, is redirected to the Stripe
  // Billing Portal (upgrade/downgrade/cancel) instead of creating a second,
  // parallel Checkout Session -- regardless of which tier it clicks, including
  // its own current one.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: 'cus_paid_real', stripe_subscription_id: 'sub_paid_real', subscription_status: 'active', account_capacity: 100 };
    global.fetch = mockFetch(OWNER);
    stripeCustomerCreateCalls = 0;
    stripeCheckoutSessionCalls = [];
    stripePortalSessionCalls = [];
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 100 } }), res); // clicks its OWN current tier again
    assert(res.statusCode === 200 && res.body.portal === true, `REQUIRED: an already-paid org clicking Subscribe is routed to the Billing Portal, not a new Checkout Session (got ${res.statusCode})`);
    assert(res.body.url === 'https://billing.stripe.com/p/session/bps_test_abc', 'the response redirects to the real Stripe-hosted Billing Portal URL');
    assert(stripeCheckoutSessionCalls.length === 0, 'REQUIRED: no Checkout Session -- and therefore no possible second/duplicate subscription -- is ever created for an already-paid org');
    assert(stripeCustomerCreateCalls === 0, 'no new Stripe customer is created for an already-paid org either');
    assert(stripePortalSessionCalls.length === 1 && stripePortalSessionCalls[0].includes('customer=cus_paid_real'), 'exactly one Billing Portal session is created, for the real existing customer');
  }
  {
    // Same guarantee, a DIFFERENT tier -- upgrade/downgrade both go through
    // the portal, never a fresh Checkout Session.
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: 'cus_paid_real', stripe_subscription_id: 'sub_paid_real', subscription_status: 'active', account_capacity: 100 };
    global.fetch = mockFetch(OWNER);
    stripeCheckoutSessionCalls = [];
    stripePortalSessionCalls = [];
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 900 } }), res); // tries to move up to the 1000 band
    assert(res.statusCode === 200 && res.body.portal === true, 'REQUIRED: selecting a DIFFERENT (higher) tier for an already-paid org also goes through the Billing Portal, not a blind new subscription');
    assert(stripeCheckoutSessionCalls.length === 0, 'no Checkout Session created when changing tiers as an existing paid customer');
  }

  // 11. REQUIRED: an org marked paid/active in the database, but whose
  // Stripe subscription cannot be verified (stale/wrong-environment id, or
  // no Stripe object at all behind a manual grant) is refused safely -- a
  // clear, actionable error, NEVER a fresh Checkout Session that would
  // create a second parallel subscription behind an org the system already
  // believes is paying. This is the exact production shape: subscription_status
  // active, account_capacity set, but the stored Stripe ids don't resolve.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: 'cus_V3xqBV3aUfj8Kw', stripe_subscription_id: 'sub_1U3q2CD47TqZiY4IDOaEqn0U', subscription_status: 'active', account_capacity: 100 };
    stripeGetOverrides = { 'subscriptions/sub_1U3q2CD47TqZiY4IDOaEqn0U': { status: 404 } };
    global.fetch = mockFetch(OWNER);
    stripeCheckoutSessionCalls = [];
    stripePortalSessionCalls = [];
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 100 } }), res);
    assert(res.statusCode === 409, `REQUIRED: an unverifiable subscription on an already-paid org is refused (got ${res.statusCode})`);
    assert(!/no such/i.test(res.body?.error || ''), 'REQUIRED: the raw Stripe "No such ..." error string is never surfaced to the user');
    assert(typeof res.body?.error === 'string' && res.body.error.length > 0, 'a clear, actionable message is returned instead');
    assert(stripeCheckoutSessionCalls.length === 0, 'REQUIRED: absolutely no Checkout Session is created -- never risk a second parallel subscription when the existing one cannot be confirmed');
    assert(stripePortalSessionCalls.length === 0, 'no Billing Portal session either, since the underlying subscription could not be confirmed real');
    stripeGetOverrides = {};
  }

  // 12. A paid/manual org with NO stripe_subscription_id at all (a
  // hand-negotiated Enterprise grant, per BETA_OPERATIONS.md -- no real
  // Stripe object behind it) is refused the same safe way, not routed into
  // Checkout or the Portal for an object that was never created.
  {
    orgState = { id: ORG_ID, name: 'Acme Promo', stripe_customer_id: null, stripe_subscription_id: null, subscription_status: 'manual', account_capacity: null };
    global.fetch = mockFetch(OWNER);
    stripeCheckoutSessionCalls = [];
    stripePortalSessionCalls = [];
    stripeCustomerCreateCalls = 0;
    const res = fakeRes();
    await handler(fakeReq({ body: { requestedAccountCount: 900 } }), res);
    assert(res.statusCode === 409, `REQUIRED: a manually-granted paid org with no Stripe object at all is refused safely, not silently given a real Stripe subscription (got ${res.statusCode})`);
    assert(stripeCheckoutSessionCalls.length === 0 && stripeCustomerCreateCalls === 0, 'no Checkout Session and no new Stripe customer are created for a manual grant');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
