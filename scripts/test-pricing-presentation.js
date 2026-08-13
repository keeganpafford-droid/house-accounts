// Pricing/billing sprint (2026-08-13): pricing.html was rebuilt from four
// static Free/Solo/Team/(hidden)Enterprise plan cards into a single
// account-capacity slider backed by the canonical pricing-bands.js
// definition, with Stripe Checkout for paid bands and a substantial
// "Contact Sales" state for >2,500 accounts. This file replaces the prior
// card-based presentation checks (required tests 16-19 from the
// commercial-readiness round) with checks against the new shape: no
// per-plan cards, one canonical pricing source consumed by the page and
// the backend alike, and the previously-hidden Enterprise/Contact-Sales
// state now deliberately visible again (the founder's brief explicitly
// requires it, superseding the earlier round's decision to hide it).
//
// Usage: node scripts/test-pricing-presentation.js
import { readFileSync } from 'fs';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const html = readFileSync(new URL('../pricing.html', import.meta.url), 'utf8');

// No static per-plan cards of any kind remain -- pricing is a single
// interactive selector now, not four cards.
assert(!/<h3>Free Forever<\/h3>/.test(html), 'pricing.html no longer has a separate Free Forever plan card');
assert(!/<h3>Solo<\/h3>/.test(html), 'pricing.html no longer has a separate Solo plan card');
assert(!/<h3>Team<\/h3>/.test(html), 'pricing.html no longer has a separate Team plan card');
assert(!/<h3>Enterprise<\/h3>/.test(html), 'pricing.html no longer has a separate Enterprise plan card');

// The account-capacity selector itself.
assert(html.includes('id="accountCountRange"'), 'pricing.html has the account-capacity range slider');
assert(html.includes('id="accountCountInput"'), 'pricing.html has the account-capacity numeric input, kept in sync with the slider');
assert(html.includes('id="selectorResult"'), 'pricing.html has a single live result panel that updates as the count changes');

// Enterprise is a substantial visual "Contact Sales" state on the same
// panel now, not hidden -- this reverses the earlier presentation-only
// round's decision, per the founder's explicit 2026-08-13 pricing brief.
assert(/Contact Sales/.test(html), 'pricing.html has a "Contact Sales" CTA for the >2,500-account state');
assert(/Let's build the right plan for your team\./.test(html), 'pricing.html shows the required "Let\'s build the right plan for your team." Enterprise copy');
assert(/href=(['"])\/contact\.html\1/.test(html), 'the Enterprise state links through the existing /contact.html contact route');

// One canonical pricing source, consumed as-is (no copied numbers).
assert(/<script type="module">[\s\S]*from\s*(['"])\/pricing-bands\.js\1/.test(html), 'pricing.html imports the canonical pricing-bands.js module rather than hardcoding band data');
for(const amount of ['$99','$199','$299','$399','$499','$599','$899']){
  assert(!html.includes(amount), `pricing.html does not hardcode the paid-band amount ${amount} -- it must come only from pricing-bands.js`);
}
assert(html.includes('/api/create-checkout-session'), 'pricing.html wires the paid-band CTA to the Checkout endpoint');

// The canonical pricing-band definition itself matches the approved
// pricing table, and is what the backend uses too -- not a second copy.
const bandsSrc = readFileSync(new URL('../pricing-bands.js', import.meta.url), 'utf8');
const approved = [
  [10, 0], [100, 9900], [250, 19900], [500, 29900], [750, 39900],
  [1000, 49900], [1500, 59900], [2500, 89900]
];
for(const [maxAccounts, priceCents] of approved){
  const re = new RegExp(`maxAccounts:\\s*${maxAccounts}\\s*,\\s*priceCents:\\s*${priceCents}\\b`);
  assert(re.test(bandsSrc), `pricing-bands.js defines the approved band: up to ${maxAccounts} accounts at ${priceCents} cents/month`);
}
assert(/maxAccounts:\s*null.*contactSales:\s*true/.test(bandsSrc), 'pricing-bands.js defines the Enterprise band as a contact-sales state with no fixed price');

const checkoutSrc = readFileSync(new URL('../api/create-checkout-session.js', import.meta.url), 'utf8');
const webhookSrc = readFileSync(new URL('../api/stripe-webhook.js', import.meta.url), 'utf8');
assert(/from\s*(['"])\.\.\/pricing-bands\.js\1/.test(checkoutSrc), 'api/create-checkout-session.js imports the same canonical pricing-bands.js -- no separate backend price table');
assert(/from\s*(['"])\.\.\/pricing-bands\.js\1/.test(webhookSrc), 'api/stripe-webhook.js imports the same canonical pricing-bands.js -- no separate backend price table');

// Existing customer records/plan values are untouched: admin still lists
// 'enterprise' as a real, selectable plan value.
const adminSrc = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
assert(/<option>enterprise<\/option>/.test(adminSrc), "the admin panel's plan filters still list 'enterprise' as a real plan value -- existing enterprise customer records are unaffected");

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
