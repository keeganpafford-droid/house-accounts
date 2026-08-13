// Pricing/billing sprint: validates api/stripe-webhook.js -- manual
// Stripe-Signature verification (valid, tampered, wrong secret, replayed/
// stale timestamp) and the three handled lifecycle events end-to-end
// against a mocked Supabase fetch. No live network, no stripe SDK.
//
// Usage: node scripts/test-stripe-webhook.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.STRIPE_PRICE_ID_500 = 'price_test_500';
process.env.STRIPE_PRICE_ID_1000 = 'price_test_1000';

import { createHmac } from 'crypto';
import { Readable } from 'stream';
import handler, { verifyStripeSignature } from '../api/stripe-webhook.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function signPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)){
  const signed = `${timestamp}.${payload}`;
  const sig = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

// --- verifyStripeSignature() unit checks --------------------------------
{
  const payload = JSON.stringify({ hello: 'world' });
  const header = signPayload(payload, 'whsec_test_secret');
  assert(verifyStripeSignature(payload, header, 'whsec_test_secret') === true, 'a correctly signed payload verifies');
  assert(verifyStripeSignature(payload, header, 'whsec_wrong_secret') === false, 'the same payload/header fails verification against the wrong secret');
  assert(verifyStripeSignature(payload + 'tampered', header, 'whsec_test_secret') === false, 'a tampered payload (signature no longer matches) fails verification');
  assert(verifyStripeSignature(payload, '', 'whsec_test_secret') === false, 'a missing signature header fails verification rather than throwing');
  assert(verifyStripeSignature(payload, header, '') === false, 'a missing secret fails verification rather than throwing');
  const staleHeader = signPayload(payload, 'whsec_test_secret', Math.floor(Date.now() / 1000) - 600);
  assert(verifyStripeSignature(payload, staleHeader, 'whsec_test_secret') === false, 'a correctly-signed but stale (>5min old) timestamp is rejected as a replay-protection measure');
  assert(verifyStripeSignature(payload, 'garbage-not-even-the-right-shape', 'whsec_test_secret') === false, 'a malformed signature header fails verification rather than throwing');
}

// --- handler() end-to-end, mocked Supabase fetch -------------------------
let orgRows = [];
function mockFetch(){
  return async (url, options = {}) => {
    const u = String(url);
    if(u.includes('/rest/v1/ha_organizations') && u.includes('stripe_customer_id=eq.') && (!options.method || options.method === 'GET')){
      const m = decodeURIComponent(u).match(/stripe_customer_id=eq\.(.+?)(&|$)/);
      const custId = m?.[1];
      return jsonResponse(orgRows.filter(o => o.stripe_customer_id === custId));
    }
    if(u.includes('/rest/v1/ha_organizations') && options.method === 'PATCH'){
      const idMatch = decodeURIComponent(u).match(/id=eq\.(.+?)(&|$)/);
      const id = idMatch?.[1];
      const patch = JSON.parse(options.body);
      orgRows = orgRows.map(o => o.id === id ? { ...o, ...patch } : o);
      return jsonResponse(orgRows.filter(o => o.id === id));
    }
    throw new Error(`Unhandled mock fetch URL in test: ${u}`);
  };
}
function jsonResponse(data, ok = true, status = 200){
  return { ok, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function fakeReq(bodyObj){
  const payload = JSON.stringify(bodyObj);
  const stream = Readable.from([Buffer.from(payload)]);
  stream.method = 'POST';
  stream.headers = { 'stripe-signature': signPayload(payload, 'whsec_test_secret') };
  return stream;
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
  // 1. checkout.session.completed establishes a new paid subscription.
  {
    orgRows = [{ id: 'org-1', stripe_customer_id: null, subscription_status: 'inactive', plan: 'free', account_capacity: 10 }];
    global.fetch = mockFetch();
    const res = fakeRes();
    await handler(fakeReq({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', customer: 'cus_1', subscription: 'sub_1', metadata: { organization_id: 'org-1', band_key: 'band_500' } } }
    }), res);
    assert(res.statusCode === 200, 'checkout.session.completed returns 200');
    const org = orgRows.find(o => o.id === 'org-1');
    assert(org.stripe_customer_id === 'cus_1' && org.stripe_subscription_id === 'sub_1', 'the org is stamped with the real Stripe customer/subscription ids');
    assert(org.stripe_price_id === 'price_test_500', 'the org is stamped with the real Price ID resolved from the band, traced back through pricing-bands.js');
    assert(org.subscription_status === 'active' && org.plan === 'paid', 'the org becomes active/paid');
    assert(org.account_capacity === 500, 'the org\'s account_capacity is set to the purchased band\'s ceiling');
  }

  // 2. checkout.session.completed with no organization_id/band_key metadata
  // is safely ignored (not a crash, not a guess).
  {
    orgRows = [{ id: 'org-2', stripe_customer_id: null, subscription_status: 'inactive', plan: 'free', account_capacity: 10 }];
    global.fetch = mockFetch();
    const res = fakeRes();
    await handler(fakeReq({ type: 'checkout.session.completed', data: { object: { id: 'cs_2', customer: 'cus_2', subscription: 'sub_2', metadata: {} } } }), res);
    assert(res.statusCode === 200, 'a checkout.session.completed with no usable metadata still acknowledges 200 (Stripe requires this to avoid retries)');
    assert(orgRows.find(o => o.id === 'org-2').plan === 'free', 'no organization is mutated when metadata cannot be resolved');
  }

  // 3. customer.subscription.updated re-syncs a price/band change made on
  // Stripe's side.
  {
    orgRows = [{ id: 'org-3', stripe_customer_id: 'cus_3', stripe_subscription_id: 'sub_3', subscription_status: 'active', plan: 'paid', account_capacity: 500 }];
    global.fetch = mockFetch();
    const res = fakeRes();
    await handler(fakeReq({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_3', customer: 'cus_3', status: 'active', items: { data: [{ price: { id: 'price_test_1000' } }] } } }
    }), res);
    assert(res.statusCode === 200, 'customer.subscription.updated returns 200');
    const org = orgRows.find(o => o.id === 'org-3');
    assert(org.account_capacity === 1000 && org.stripe_price_id === 'price_test_1000', 'a price change made directly on Stripe is re-synced onto the org, not left stale');
  }

  // 4. customer.subscription.updated with a status change (e.g. past_due)
  // and no price change still syncs subscription_status.
  {
    orgRows = [{ id: 'org-4', stripe_customer_id: 'cus_4', stripe_subscription_id: 'sub_4', subscription_status: 'active', plan: 'paid', account_capacity: 500 }];
    global.fetch = mockFetch();
    const res = fakeRes();
    await handler(fakeReq({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_4', customer: 'cus_4', status: 'past_due', items: { data: [{ price: { id: 'price_test_500' } }] } } }
    }), res);
    const org = orgRows.find(o => o.id === 'org-4');
    assert(org.subscription_status === 'past_due', 'a Stripe-reported status change (e.g. past_due) is synced onto subscription_status verbatim');
    assert(org.account_capacity === 500, 'account_capacity is left as-is when the price/band did not change');
  }

  // 5. customer.subscription.deleted reverts the org to Free, WITHOUT
  // touching account_capacity -- the historical record is preserved, and
  // the unified entitlement logic falls back to 10 on its own because
  // subscription_status is no longer active/paid/manual.
  {
    orgRows = [{ id: 'org-5', stripe_customer_id: 'cus_5', stripe_subscription_id: 'sub_5', subscription_status: 'active', plan: 'paid', account_capacity: 1500 }];
    global.fetch = mockFetch();
    const res = fakeRes();
    await handler(fakeReq({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_5', customer: 'cus_5' } } }), res);
    assert(res.statusCode === 200, 'customer.subscription.deleted returns 200');
    const org = orgRows.find(o => o.id === 'org-5');
    assert(org.subscription_status === 'canceled', 'the org\'s subscription_status is flipped to canceled');
    assert(org.account_capacity === 1500, 'account_capacity is deliberately left untouched as a historical record of what was last purchased');
  }
  {
    // Confirm the entitlement fallback actually works against the exact
    // row state the webhook just produced above -- this is the real
    // "does cancellation actually revert access" proof, not just a status
    // string check.
    const { accountCapacity } = await import('../api/lib/entitlement.js');
    const org = orgRows.find(o => o.id === 'org-5');
    assert(accountCapacity(org) === 10, 'after cancellation, the unified entitlement logic reports a capacity of 10 (Free) for this org, despite account_capacity=1500 still being stored');
  }

  // 6. An event type outside the three handled ones is acknowledged but
  // causes no organization mutation.
  {
    orgRows = [{ id: 'org-6', stripe_customer_id: 'cus_6', subscription_status: 'active', plan: 'paid', account_capacity: 500 }];
    global.fetch = mockFetch();
    const res = fakeRes();
    await handler(fakeReq({ type: 'invoice.payment_failed', data: { object: { customer: 'cus_6' } } }), res);
    assert(res.statusCode === 200, 'an unhandled event type is still acknowledged 200 (so Stripe does not retry it)');
    assert(orgRows.find(o => o.id === 'org-6').subscription_status === 'active', 'an unhandled event type never mutates any organization -- dunning/invoice handling is explicitly out of scope for this sprint');
  }

  // 7. An invalid signature is rejected before any Supabase call is made.
  {
    global.fetch = async () => { throw new Error('should not reach Supabase for an invalid signature'); };
    const stream = Readable.from([Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }))]);
    stream.method = 'POST';
    stream.headers = { 'stripe-signature': 't=1,v1=deadbeef' };
    const res = fakeRes();
    await handler(stream, res);
    assert(res.statusCode === 400, 'an invalid Stripe-Signature is rejected with 400, before touching Supabase');
  }

  global.fetch = originalFetch;
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run();
