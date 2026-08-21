import fs from 'node:fs';
function assert(ok,msg){if(!ok) throw new Error(msg)}
const header=fs.readFileSync('site-header.js','utf8');
const home=fs.readFileSync('index.html','utf8');
const signup=fs.readFileSync('signup.html','utf8');
const login=fs.readFileSync('login.html','utf8');
assert(!header.includes("label:'Coming Soon'"),'Coming Soon remains in public nav');
assert(!header.includes("label:'Customer Success'"),'Customer Success remains in public nav');
// Commercial Credibility V1 (2026-08-21) navigation doctrine: Why House
// Accounts, Real-World Results, and Pricing are the permanent top-level
// public destinations. FAQ, Security, and Feedback were deliberately
// removed from primary public navigation -- they remain reachable from
// the footer instead (see scripts/test-commercial-credibility-v1.js for
// full coverage of the new architecture).
for(const label of ['Why House Accounts','Real-World Results','Pricing']) assert(header.includes(`label:'${label}'`),`${label} missing from public nav`);
for(const label of ['FAQ','Security','Feedback']) assert(!header.includes(`label:'${label}'`),`${label} should no longer be a primary public/authenticated nav label -- footer-only now`);
assert(home.includes('Upload your customer history'),'Homepage MVP supporting copy missing');
assert(!home.includes('Research target accounts'),'Homepage still promotes target-account research');
for(const name of ['name','organizationName','role','house_accounts','crm_erp','email','password']) assert(signup.includes(`name="${name}"`),`Signup field ${name} missing`);
assert(!login.includes('signupFields'),'Login still contains embedded signup component');
assert(signup.includes('/signup-form.js'),'Canonical signup component is not loaded');

assert(signup.includes('Free Forever • No credit card required'),'Signup is missing the Free Forever badge');
assert(signup.includes('Monitor up to 10 customer accounts for free—forever.'),'Signup is missing permanent free-tier copy');
// 2026-08-13 pricing decision: no new 30-day paid-capacity trials are
// granted going forward -- Free is the only no-payment entry point, and
// paid capacity is purchased through Stripe Checkout on the pricing page
// instead. The old trial-clarification line is gone; signup now points
// to pricing instead of promising a trial.
assert(!signup.includes('Every paid plan starts with a 30-day free trial.'),'Signup still promises a 30-day free trial, which is no longer offered');
assert(signup.includes('See pricing') && signup.includes('href="/pricing.html"'),'Signup is missing a link to pricing for customers who need more than the free tier');
assert(home.includes('Free Forever • No credit card required'),'Homepage is missing the Free Forever badge');
assert(home.includes('Monitor up to 10 customer accounts for free—forever.'),'Homepage is missing permanent free-tier copy');
const pricing=fs.readFileSync('pricing.html','utf8');
const signupScript=fs.readFileSync('signup-form.js','utf8');
// Pricing/billing sprint: the Solo/Team plan cards and their "Start
// 30-Day Free Trial" CTAs were replaced by a single account-capacity
// slider + Stripe Checkout. No plan-name query params, no trial CTAs.
assert(!/Start 30-Day Free Trial/.test(pricing),'pricing.html still advertises the retired 30-day free trial CTA');
assert(!pricing.includes('href="/signup?plan=solo"') && !pricing.includes('href="/signup?plan=team"'),'pricing.html still links to the retired plan-specific signup routes');
assert(pricing.includes('id="accountCountRange"') && pricing.includes('id="accountCountInput"'),'pricing.html is missing the account-capacity slider/numeric input');
assert(pricing.includes("/api/create-checkout-session"),'pricing.html does not wire up Stripe Checkout');
assert(pricing.includes('href="/signup">Start Free'),'Free-tier CTA must use the permanent free signup route');
assert(header.includes('href="/signup">Start Free'),'Header Start Free must use the permanent free signup route');
assert(signupScript.includes("plan:requestedPlan"),'Canonical signup does not preserve selected free or paid plan');
for(const [name,html] of [['homepage',home],['signup',signup],['pricing',pricing]]){
  assert(!/monitor(?:ed|ing)? companies/i.test(html),`${name} still uses monitored companies terminology`);
  assert(!/up to 10 companies/i.test(html),`${name} still uses companies for the free-tier limit`);
}

// Billing/pricing cleanup sprint: the homepage's static hero copy and the
// canonical signup component both used to promise a "30-Day Free Trial" for
// any non-free plan -- api/auth.js's orgDefaults() has granted no such
// trial since the 2026-08-13 pricing decision (Free is the only
// no-payment entry point; paid capacity is purchased through Stripe
// Checkout), so this was a pure, live, customer-facing false promise.
assert(!/30-day free trial/i.test(home),'REQUIRED: the homepage no longer promises a 30-day free trial that is not actually granted');
assert(!/30-day free trial/i.test(signupScript),'REQUIRED: signup-form.js no longer promises a 30-day free trial for a ?plan=solo/?plan=team signup -- the backend has granted no such trial for months');
assert(!/Start 30-Day Free Trial/.test(signupScript),'REQUIRED: signup-form.js no longer ever renders a "Start 30-Day Free Trial" button label, on submit or on failure/retry');

console.log('Public MVP navigation and canonical signup checks passed.');
