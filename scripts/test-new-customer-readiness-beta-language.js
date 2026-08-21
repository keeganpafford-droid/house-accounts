// New-Customer Readiness lane, item 1 (2026-08-20): bounded customer-facing
// trust/onboarding correction, approved after a read-only recon found the
// site-wide "House Accounts is currently in Beta" banner, the first-run
// welcome modal, and a handful of page-local copy instances presenting the
// product itself as a temporary test environment -- exactly the wrong signal
// while actively selling to prospects/customers, including larger
// distributor organizations. This proves every approved correction landed,
// that nothing outside the approved 7-item scope was touched (dormant
// Prospect Intelligence/"Beta workflow" markup, legitimate Trial
// billing-state terminology), and that no replacement announcement banner
// was introduced.
//
// Usage: node scripts/test-new-customer-readiness-beta-language.js
import { readFileSync, existsSync } from 'fs';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function read(path){ return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'); }

// =============================================================================
// 1) Site-wide Beta banner -- removed entirely, no replacement banner.
// =============================================================================
{
  const header = read('site-header.js');
  assert(!/ha-beta-banner/.test(header), '1) REQUIRED: site-header.js no longer injects a .ha-beta-banner');
  assert(!/currently in Beta/i.test(header), '1) REQUIRED: site-header.js contains no "currently in Beta" copy');
  // Scope discipline: removeLegacy()'s old-markup cleanup selectors are
  // harmless to leave in place (nothing produces that markup any more) --
  // only assert the actual banner injection and text are gone, not that
  // every trace of the old selector list was scrubbed.

  const css = read('site-header.css');
  assert(!/\.ha-beta-banner/.test(css), '1) REQUIRED: site-header.css no longer defines .ha-beta-banner styles');

  const pagesWithMarkup = [
    'index.html', 'pricing.html', 'faq.html', 'security.html', 'privacy.html',
    'terms.html', 'contact.html', 'whats-new.html',
    'dashboard/index.html'
  ];
  const pagesCssOnly = [
    'export-guides/generic-excel/index.html', 'export-guides/facilis/index.html',
    'export-guides/esp/index.html', 'export-guides/commonsku/index.html',
    'export-guides/antera/index.html', 'export-guides/zoominfo/index.html',
    'export-guides/hubspot/index.html', 'export-guides/pipedrive/index.html',
    'export-guides/prospect-excel/index.html', 'export-guides/salesforce/index.html',
    'export-guides/apollo/index.html'
  ];
  for(const page of [...pagesWithMarkup, ...pagesCssOnly]){
    const html = read(page);
    assert(!/beta-top-banner/.test(html), `1) REQUIRED: ${page} carries no remaining .beta-top-banner CSS or markup`);
    assert(!/currently in Beta/i.test(html), `1) REQUIRED: ${page} contains no "currently in Beta" copy, static or otherwise`);
  }
}

// =============================================================================
// 2) First-run welcome modal -- Beta-specific language removed, useful
//    setup/value guidance preserved, no "trial"/"early access" substitution.
// =============================================================================
{
  const dashboard = read('dashboard/index.html');
  assert(/<h2 id="betaWelcomeTitle">Welcome to House Accounts 👋<\/h2>/.test(dashboard), '2) REQUIRED: the welcome modal title reads "Welcome to House Accounts" -- no Beta framing');
  assert(!/one of our first Beta users/i.test(dashboard), '2) REQUIRED: "one of our first Beta users" is gone');
  assert(!/as a beta user/i.test(dashboard), '2) REQUIRED: "as a beta user" is gone');
  assert(/Your feedback helps us keep improving House Accounts\./.test(dashboard), '2) sanity: the approved replacement feedback line is present');
  assert(/Help promotional products sales reps answer one question:/.test(dashboard), '2) sanity: the useful mission/value guidance line is preserved');
  assert(/A 60–90 second tour, then your first upload takes about 2–3 minutes\./.test(dashboard), '2) sanity: the useful setup-time guidance line is preserved');
  assert(!/\btrial\b/i.test(dashboard.match(/<div class="beta-modal-backdrop"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || ''), '2) REQUIRED: the welcome modal never substitutes "trial" framing for the removed Beta language');
  assert(!/early[- ]access/i.test(dashboard.match(/<div class="beta-modal-backdrop"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || ''), '2) REQUIRED: the welcome modal never substitutes "early access" framing for the removed Beta language');
}

// =============================================================================
// 3) Settings -- intro line corrected; legitimate Trial billing-state fields
//    (a separate, unrelated concept) are explicitly untouched.
// =============================================================================
{
  const settings = read('settings.html');
  assert(settings.includes('Your House Accounts workspace.'), '3) REQUIRED: Settings intro reads "Your House Accounts workspace."');
  assert(!/beta workspace/i.test(settings), '3) REQUIRED: "beta workspace" is gone from Settings');
  assert(settings.includes('const hasRealTrialHistory'), '3) REQUIRED (scope discipline): the legitimate Trial billing-state gating logic (hasRealTrialHistory/trialRows) is untouched');
  assert(settings.includes("['Trial status',trialLabel]"), '3) REQUIRED (scope discipline): the Trial status/used/started/end/remaining rows themselves are untouched');
}

// =============================================================================
// 4) Feedback & Support page -- Beta-specific framing removed, page not
//    otherwise redesigned.
// =============================================================================
{
  const contact = read('contact.html');
  assert(contact.includes('<div class="eyebrow">Feedback</div>'), '4) REQUIRED: the eyebrow reads "Feedback", not "Beta Feedback"');
  assert(!/Beta Feedback/.test(contact), '4) REQUIRED: "Beta Feedback" is gone');
  assert(!/During beta/i.test(contact), '4) REQUIRED: "During beta..." is gone');
  assert(contact.includes('Your suggestions and bug reports directly influence what we build next.'), '4) sanity: the lead sentence still makes the same substantive claim, just without Beta framing');
  assert(contact.includes('<li>Product support</li>'), '4) REQUIRED: "Beta support" was renamed to "Product support"');
  assert(!/Beta support/.test(contact), '4) REQUIRED: "Beta support" is gone');
  // Scope discipline: the page's other cards (Share Feedback / Report a Bug
  // / Suggest a Feature / Need Help) are untouched -- no redesign.
  assert(contact.includes('💬 Share Feedback') && contact.includes('🐞 Report a Bug') && contact.includes('💡 Suggest a Feature'), '4) sanity: the page structure itself is unchanged');
}

// =============================================================================
// 5) What's New -- "beta" removed from the one feedback sentence only, no
//    broader refresh.
// =============================================================================
{
  const whatsNew = read('whats-new.html');
  assert(whatsNew.includes('your feedback directly shapes what moves from Exploring to Up Next.'), "5) REQUIRED: the Exploring section's feedback sentence no longer says \"beta feedback\"");
  assert(!/beta feedback/i.test(whatsNew), '5) REQUIRED: "beta feedback" is gone from What\'s New');
  assert(whatsNew.includes('Recently Shipped') && whatsNew.includes('Up Next') && whatsNew.includes('Exploring'), '5) sanity: the page structure/sections are unchanged -- no broader refresh in this slice');
}

// =============================================================================
// 6) Feedback notification email -- internal subject line corrected, no
//    other email-flow change.
// =============================================================================
{
  const feedbackApi = read('api/feedback.js');
  assert(feedbackApi.includes('const subject = `House Accounts ${label}`;'), '6) REQUIRED: the internal feedback-notification subject reads "House Accounts ${label}"');
  assert(!/House Accounts Beta \$\{label\}/.test(feedbackApi), '6) REQUIRED: the old "House Accounts Beta ${label}" subject is gone');
  assert(feedbackApi.includes("process.env.RESEND_API_KEY"), '6) sanity: the email-sending mechanism itself is untouched');
}

// =============================================================================
// 7) Hall of Accounts -- superseded by Commercial Credibility V1
//    (2026-08-21): at the time this test was written, the "Beta Distributor"
//    testimonial had just been removed but the page itself was still live,
//    unlinked, with two other unverified testimonials. The whole page has
//    since been retired -- see scripts/test-commercial-credibility-v1.js for
//    full coverage of the retirement/redirect. Only a light presence check
//    remains here so this file doesn't silently stop covering the file at
//    all.
// =============================================================================
{
  assert(!existsSync(new URL('../hall-of-accounts.html', import.meta.url)), '7) sanity: hall-of-accounts.html no longer exists in the repo (retired by Commercial Credibility V1)');
}

// =============================================================================
// Explicitly out of scope -- must remain exactly as before.
// =============================================================================
{
  const dashboard = read('dashboard/index.html');
  assert(dashboard.includes('<div class="workflow-label">New beta workflow</div>'), 'REQUIRED (scope discipline): the dormant, always-hidden "New beta workflow" Prospect Intelligence card markup is untouched');
  assert(/\.ha-mvp \.workflow-switcher,/.test(dashboard), 'REQUIRED (scope discipline): the CSS rule that keeps that dormant card hidden is untouched');

  const prospects = read('prospects/index.html');
  assert(prospects.includes('<div class="eyebrow">Beta workflow</div>'), 'REQUIRED (scope discipline): prospects/index.html\'s own "Beta workflow" eyebrow is untouched (dormant, JS-redirected route)');

  const pricing = read('pricing.html');
  assert(pricing.includes('id="accountCountRange"'), 'REQUIRED (scope discipline): pricing.html itself is untouched');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
