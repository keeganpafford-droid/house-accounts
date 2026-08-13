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
    if(u.includes('api.stripe.com/v1/customers') && options.method === 'POST'){
      stripeCustomerCreateCalls += 1;
      return jsonResponse({ id: 'cus_test_123' });
    }
    if(u.includes('api.stripe.com/v1/checkout/sessions') && options.method === 'POST'){
      stripeCheckoutSessionCalls.push(options.body);
      return jsonResponse({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' });
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

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
