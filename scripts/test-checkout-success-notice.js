// Pricing UX polish round: post-Checkout success confirmation on the
// dashboard. Extracts the real maybeShowCheckoutSuccessNotice() (and its
// once-only guard flag) out of dashboard/index.html into a vm sandbox and
// exercises it directly against a fake window/document, proving: it only
// fires on a genuine ?checkout=success return, the capacity number comes
// from live usage data (never hardcoded), it fires at most once, the
// query param is stripped so it can't resurface on a later visit, and the
// dismiss control actually dismisses it.
//
// Usage: node scripts/test-checkout-success-notice.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const SHOWN_FLAG_SRC = extractFn(DASHBOARD_SRC, 'checkoutSuccessNoticeShown');
const NOTICE_FN_SRC = extractFn(DASHBOARD_SRC, 'maybeShowCheckoutSuccessNotice');

function makeHarness(searchString){
  const added = [];
  const noticeEl = { classList: { add: c => added.push(c), remove: c => { const i = added.indexOf(c); if(i >= 0) added.splice(i, 1); } } };
  const textEl = { textContent: '' };
  let dismissHandler = null;
  const dismissBtn = { addEventListener: (evt, fn) => { dismissHandler = fn; } };
  let replacedUrl = null;
  const sandbox = {
    console,
    window: {
      location: { href: `https://app.example.com/dashboard${searchString}`, search: searchString },
      history: { replaceState: (state, title, url) => { replacedUrl = url; } }
    },
    document: {
      getElementById: (id) => id === 'checkoutSuccessNotice' ? noticeEl : id === 'checkoutSuccessNoticeText' ? textEl : id === 'checkoutSuccessNoticeDismiss' ? dismissBtn : null
    },
    URLSearchParams, URL
  };
  vm.createContext(sandbox);
  new vm.Script([SHOWN_FLAG_SRC, NOTICE_FN_SRC].join('\n\n'), { filename: 'checkout-success-notice-extract.js' }).runInContext(sandbox);
  return {
    call: (usage) => sandbox.maybeShowCheckoutSuccessNotice(usage),
    isActive: () => added.includes('active'),
    text: () => textEl.textContent,
    replacedUrl: () => replacedUrl,
    dismiss: () => { if(dismissHandler) dismissHandler(); }
  };
}

// 1. No ?checkout=success at all -- never shows, never touches the URL.
{
  const h = makeHarness('?foo=bar');
  h.call({ companyLimit: 100 });
  assert(h.isActive() === false, 'no ?checkout=success param: the notice never activates');
  assert(h.replacedUrl() === null, 'no ?checkout=success param: history is never touched');
}

// 2. checkout=cancelled (the failure/abandon redirect) never shows it either.
{
  const h = makeHarness('?checkout=cancelled');
  h.call({ companyLimit: 100 });
  assert(h.isActive() === false, '?checkout=cancelled does not trigger the success notice');
}

// 3. REQUIRED: a real successful return, finite purchased capacity.
{
  const h = makeHarness('?checkout=success');
  h.call({ companyLimit: 100 });
  assert(h.isActive() === true, 'a genuine ?checkout=success return activates the notice');
  assert(h.text() === 'You’re subscribed — House Accounts can now monitor up to 100 accounts.', `REQUIRED: the message states the real purchased capacity, not a hardcoded number (got "${h.text()}")`);
}

// 4. A different capacity number produces a different message -- proves
// the number is genuinely read from usage data, not a fixed string.
{
  const h = makeHarness('?checkout=success');
  h.call({ companyLimit: 750 });
  assert(h.text() === 'You’re subscribed — House Accounts can now monitor up to 750 accounts.', `the message reflects whatever companyLimit is actually passed in (got "${h.text()}")`);
}

// 5. Unlimited capacity (e.g. a manual/enterprise grant) gets appropriate
// wording instead of "up to null accounts".
{
  const h = makeHarness('?checkout=success');
  h.call({ companyLimit: null });
  assert(h.text() === 'You’re subscribed — House Accounts can now monitor unlimited accounts.', `unlimited capacity gets its own wording, not a broken "up to null" message (got "${h.text()}")`);
}

// 6. REQUIRED: the ?checkout=success param is stripped from the URL
// immediately, so a refresh or a later visit never re-shows it. Other
// query params are preserved.
{
  const h = makeHarness('?checkout=success&dashboardEmail=rep%40example.com');
  h.call({ companyLimit: 100 });
  const url = h.replacedUrl();
  assert(url && !url.includes('checkout=success'), `REQUIRED: the checkout param is stripped from the URL after showing (got "${url}")`);
  assert(url && url.includes('dashboardEmail'), 'other, unrelated query params survive the strip');
}

// 7. REQUIRED: fires at most once per page load, even if called again
// (mirrors loadDashboardUsage() potentially running more than once).
{
  const h = makeHarness('?checkout=success');
  h.call({ companyLimit: 100 });
  const firstText = h.text();
  h.dismiss();
  assert(h.isActive() === false, 'dismissing removes the active state');
  h.call({ companyLimit: 500 }); // a later call, e.g. a second usage refresh
  assert(h.isActive() === false, 'REQUIRED: a second call after the first does not re-activate the notice');
  assert(h.text() === firstText, 'REQUIRED: a second call does not overwrite the message either -- it only ever fires once per page load');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
