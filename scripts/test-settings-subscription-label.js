// Pricing UX polish round: settings.html used to display the raw internal
// database value "PLAN: paid" -- not meaningful customer-facing language,
// since House Accounts has no feature-based paid plans. Replaced with
// capacity/subscription language derived from the same usage.companyLimit/
// usage.trialActive entitlement fields the rest of the page already uses.
//
// Extracts the real computation (verbatim, not reimplemented) out of
// settings.html's inline <script> and executes it against fixture
// usage/plan combinations, plus source-level checks that the raw "Plan"
// row and old "Upgrade Plan" CTA text are gone.
//
// Usage: node scripts/test-settings-subscription-label.js
import { readFileSync } from 'fs';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

const match = html.match(/const companyLimit = usage\.companyLimit;\n\s*const subscriptionLabel = usage\.trialActive[\s\S]*?monitored accounts`\)\);/);
if(!match) throw new Error('Could not locate the subscriptionLabel computation in settings.html -- it may have been renamed or restructured.');
const subscriptionLabelFn = new Function('usage', 'plan', `${match[0]}\nreturn subscriptionLabel;`);

// A genuinely paid org with a finite purchased capacity -- the exact real
// case that used to show "Plan: paid".
assert(subscriptionLabelFn({ trialActive: false, companyLimit: 100 }, 'paid') === 'Up to 100 monitored accounts', 'REQUIRED: a paid 100-account org shows "Up to 100 monitored accounts", not the raw plan value');
assert(subscriptionLabelFn({ trialActive: false, companyLimit: 500 }, 'paid') === 'Up to 500 monitored accounts', 'a different purchased capacity produces a different label -- proves it is read live, not hardcoded');

// A genuinely unlimited paid/manual org.
assert(subscriptionLabelFn({ trialActive: false, companyLimit: null }, 'paid') === 'Unlimited monitored accounts', 'an unlimited paid/manual org shows "Unlimited monitored accounts"');

// The actual Free plan.
assert(subscriptionLabelFn({ trialActive: false, companyLimit: 10 }, 'free') === 'Free · Up to 10 monitored accounts', 'REQUIRED: the Free plan still shows "Free · Up to 10 monitored accounts"');

// An org still inside an active grandfathered legacy trial -- temporary
// trial messaging, distinct from both Free and a real paid subscription.
assert(subscriptionLabelFn({ trialActive: true, companyLimit: null }, 'team') === 'Trial · Unlimited monitored accounts', 'an active legacy trial (unlimited) shows temporary trial messaging, not "Plan: team"');
assert(subscriptionLabelFn({ trialActive: true, companyLimit: 250 }, 'team') === 'Trial · Up to 250 monitored accounts', 'an active legacy trial with a finite capacity shows that capacity with trial framing');

// Source-level: the raw internal plan value is no longer displayed as its
// own labeled row, and the CTA no longer says "Upgrade Plan".
assert(!/\['Plan',\s*plan\]/.test(html), 'REQUIRED: settings.html no longer renders a raw ["Plan", plan] grid row');
assert(/\['Subscription',\s*subscriptionLabel\]/.test(html), 'settings.html renders the new ["Subscription", subscriptionLabel] row instead');
assert(!/Upgrade Plan/.test(html), 'REQUIRED: the old "Upgrade Plan" CTA text is gone');
assert(/View pricing/.test(html), 'the CTA now reads "View pricing", matching what the link actually does (navigates to /pricing.html)');
assert(html.includes('href="/pricing.html"'), 'the CTA still links to the pricing page, unchanged');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
