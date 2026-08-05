// Commercial-readiness correction round (final), item 4: hide the full
// Enterprise pricing tier from the public pricing display while keeping
// Free/Solo/Team unchanged and preserving a simple enterprise lead-capture
// route. This is a presentation-only change -- billing/entitlement/plan
// enforcement logic (api/settings.js's planConfig()/entitlement(), which
// still fully recognizes the 'enterprise' plan server-side) is untouched
// and verified as such below (required test 19).
//
// Usage: node scripts/test-pricing-presentation.js
import { readFileSync } from 'fs';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const html = readFileSync(new URL('../pricing.html', import.meta.url), 'utf8');

// required test 16: full Enterprise pricing is hidden.
assert(!/<h3>Enterprise<\/h3>/.test(html), 'required test 16: no Enterprise plan card (with its own <h3>Enterprise</h3> heading) is rendered on the public pricing page');
assert(!/Contact Sales/.test(html), 'required test 16: the old Enterprise-tier "Contact Sales" CTA button is gone');
assert(!/25\+\s*users/.test(html), 'required test 16: the Enterprise-specific "25+ users" feature line is gone');
assert(!/Custom onboarding/.test(html) && !/Custom data onboarding/.test(html) && !/Dedicated support/.test(html), 'required test 16: undefined/unpublished Enterprise-only feature claims (custom onboarding, dedicated support) are not displayed');
assert(!/<div class="price">Custom<\/div>/.test(html), 'required test 16: no "Custom" (undefined enterprise) price is published anywhere on the page');

// required test 17: Free, Solo, and Team remain visible.
assert(/<h3>Free Forever<\/h3>/.test(html), 'required test 17: the Free Forever plan card remains visible');
assert(/<h3>Solo<\/h3>/.test(html), 'required test 17: the Solo plan card remains visible');
assert(/<h3>Team<\/h3>/.test(html), 'required test 17: the Team plan card remains visible');

// Do not change the current $99 Solo or $299 Team pricing in this round.
assert(/<div class="price">\$99<span/.test(html), 'required test 19: Solo pricing remains exactly $99/mo, unchanged');
assert(/<div class="price">\$299<span/.test(html), 'required test 19: Team pricing remains exactly $299/mo, unchanged');
assert(/<div class="price">\$0<\/div>/.test(html), 'required test 19: Free plan pricing remains exactly $0, unchanged');

// required test 18: "Need more than 25 users? Contact us." remains
// available, and preserves the existing /contact.html route.
assert(/Need more than 25 users\?\s*<a href="\/contact\.html">Contact us<\/a>\./.test(html), 'required test 18: the simple enterprise lead-capture line "Need more than 25 users? Contact us." is present and links through the existing /contact.html contact route');

// required test 19 (continued): existing pricing/billing behavior is
// unchanged -- the server-side plan config/entitlement logic still fully
// supports 'enterprise' (this is presentation simplification only, no
// billing/entitlement/plan-enforcement change).
const settingsSrc = readFileSync(new URL('../api/settings.js', import.meta.url), 'utf8');
assert(/plan==='enterprise'\)return\{plan:'enterprise'/.test(settingsSrc), "required test 19: api/settings.js's planConfig() still fully supports the 'enterprise' plan server-side -- entitlement/plan enforcement logic was not touched by this presentation-only change");
assert(/plan==='enterprise'\)/.test(settingsSrc) && /unlimited=/.test(settingsSrc), "required test 19: api/settings.js's entitlement() logic still exists and still branches on plan==='enterprise' -- unchanged");

// Existing customer records/plan values are untouched: admin still lists
// 'enterprise' as a real, selectable plan value (not removed from the
// underlying plan enum, only from the public marketing display).
const adminSrc = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
assert(/<option>enterprise<\/option>/.test(adminSrc), "required test 19: the admin panel's plan filters still list 'enterprise' as a real plan value -- existing enterprise customer records are unaffected by the public pricing-page change");

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
