// Pricing UX polish round: the pricing.html slider used to be
// geometrically linear from 1 to 2,600, crushing every lower (and more
// commonly chosen) price band into a sliver near the left edge. It now
// moves across the commercially meaningful capacity-band stops
// themselves, mapped directly from the canonical PRICING_BANDS list (no
// second copy of the thresholds) -- while the numeric input still
// resolves an exact typed count (e.g. 387) through the same
// bandForAccountCount() the price/CTA display uses.
//
// Extracts the real render()/bandIndexForCount()/syncFromRange()/
// syncFromNumber() functions out of pricing.html's inline module script
// (regex-based, not reimplemented) into a vm sandbox, with the genuine
// PRICING_BANDS/bandForAccountCount/formatPriceCents imported normally
// and injected as already-resolved values (vm.Script doesn't support ES
// `import` syntax, so the import line itself is stripped -- the function
// BODIES that follow it are untouched).
//
// Usage: node scripts/test-pricing-slider-bands.js
import vm from 'vm';
import { readFileSync } from 'fs';
import { extractFn } from './lib/dashboard-extract.js';
import { PRICING_BANDS, bandForAccountCount, formatPriceCents } from '../pricing-bands.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const PRICING_HTML = readFileSync(new URL('../pricing.html', import.meta.url), 'utf8');
const RENDER_FN = extractFn(PRICING_HTML, 'render');
const BAND_INDEX_FN = extractFn(PRICING_HTML, 'bandIndexForCount');
const SYNC_FROM_RANGE_FN = extractFn(PRICING_HTML, 'syncFromRange');
const SYNC_FROM_NUMBER_FN = extractFn(PRICING_HTML, 'syncFromNumber');

function makeSandbox(){
  const range = { value: '0', max: '8' };
  const numberInput = { value: '10' };
  const result = { dataset: {} };
  const bandLabelEl = { textContent: '' };
  const bandPriceEl = { innerHTML: '', textContent: '' };
  const bandDetailEl = { textContent: '' };
  const ctaEl = { textContent: '', href: '', onclick: null };
  const errorEl = { style: {} };
  const sandbox = {
    console,
    PRICING_BANDS, bandForAccountCount, formatPriceCents,
    range, numberInput, result, bandLabelEl, bandPriceEl, bandDetailEl, ctaEl, errorEl,
    startCheckout: () => {}
  };
  vm.createContext(sandbox);
  const fullSource = [RENDER_FN, BAND_INDEX_FN, SYNC_FROM_RANGE_FN, SYNC_FROM_NUMBER_FN].join('\n\n');
  new vm.Script(fullSource, { filename: 'pricing-slider-bands-extract.js' }).runInContext(sandbox);
  return { sandbox, range, numberInput, result, bandLabelEl, bandPriceEl, bandDetailEl, ctaEl };
}

for(const name of ['render', 'bandIndexForCount', 'syncFromRange', 'syncFromNumber']){
  assert(typeof makeSandbox().sandbox[name] === 'function', `extraction produced a real function (${name})`);
}

// --- bandIndexForCount(): the founder's own worked example -------------
{
  const { sandbox } = makeSandbox();
  assert(sandbox.bandIndexForCount(387) === PRICING_BANDS.indexOf(bandForAccountCount(387)), 'bandIndexForCount(387) matches the real band resolved by bandForAccountCount() -- no separate/duplicated threshold logic');
  assert(PRICING_BANDS[sandbox.bandIndexForCount(387)].key === 'band_500', 'REQUIRED: 387 resolves to the "up to 500" band, matching the founder\'s own worked example');
}

// --- syncFromRange(): dragging the slider lands exactly on each band's --
// ceiling, and render() reflects that band correctly.
{
  const { sandbox, numberInput, bandLabelEl, bandPriceEl, ctaEl, result } = makeSandbox();
  for(let i = 0; i < PRICING_BANDS.length - 1; i++){ // excludes the Enterprise stop, checked separately below
    sandbox.range.value = String(i);
    sandbox.syncFromRange();
    const band = PRICING_BANDS[i];
    assert(Number(numberInput.value) === band.maxAccounts, `dragging the slider to position ${i} sets the numeric input to exactly ${band.key}'s ceiling (${band.maxAccounts}) (got ${numberInput.value})`);
    assert(bandLabelEl.textContent === (band.key === 'free' ? 'Free' : band.label), `slider position ${i} renders the correct band label`);
  }
}
{
  // The last stop (Enterprise) resolves into the contact-sales state, not
  // a fixed-price band.
  const { sandbox, result, ctaEl } = makeSandbox();
  sandbox.range.value = String(PRICING_BANDS.length - 1);
  sandbox.syncFromRange();
  assert(result.dataset.state === 'enterprise', 'dragging the slider to its last position lands on the Enterprise/contact-sales state');
  assert(ctaEl.textContent === 'Contact Sales', 'the Enterprise stop\'s CTA reads "Contact Sales"');
  assert(ctaEl.href === '/contact.html', 'the Enterprise stop\'s CTA links to /contact.html');
}

// --- syncFromNumber(): typing an exact count still resolves through the -
// same canonical band math, and repositions the slider to match.
{
  const { sandbox, range, bandLabelEl, ctaEl } = makeSandbox();
  sandbox.numberInput.value = '387';
  sandbox.syncFromNumber();
  assert(Number(range.value) === PRICING_BANDS.indexOf(bandForAccountCount(387)), 'REQUIRED: typing 387 repositions the slider to the band bandForAccountCount(387) actually resolves to');
  assert(bandLabelEl.textContent === 'Up to 500 accounts', 'REQUIRED: typing 387 still resolves to the 500-account band for display, per the founder\'s worked example');
  assert(ctaEl.textContent === `Subscribe — ${formatPriceCents(bandForAccountCount(387).priceCents)}/mo`, `REQUIRED: the CTA shows the correct dynamic price for the resolved band (got "${ctaEl.textContent}")`);
}

// --- CTA copy: dynamic price, sourced only from pricing-bands.js -------
{
  const { sandbox, ctaEl } = makeSandbox();
  for(const band of PRICING_BANDS.filter(b => b.key !== 'free' && !b.contactSales)){
    sandbox.render(band.maxAccounts);
    const expected = `Subscribe — ${formatPriceCents(band.priceCents)}/mo`;
    assert(ctaEl.textContent === expected, `the ${band.key} band's CTA reads "${expected}" (got "${ctaEl.textContent}")`);
  }
}
{
  const { sandbox, ctaEl } = makeSandbox();
  sandbox.render(5);
  assert(ctaEl.textContent === 'Start Free' && ctaEl.href === '/signup', 'Free retains its "Start Free" CTA, linking to /signup');
}

// --- QA correction: tick alignment geometry -----------------------------
// The thumb's CENTER travels an inset track (thumbRadius to trackWidth
// minus thumbRadius), not the full width. Each tick must be positioned
// with the exact same calc() geometry the CSS-styled thumb uses --
// verified two ways: (1) the CSS custom property and the JS constant that
// must stay in sync are both actually 18px, and (2) the real
// tick-generation statement (extracted verbatim, not reimplemented)
// produces the exact expected `left: calc(...)` for every one of the 9
// stops.
{
  const thumbCssMatch = PRICING_HTML.match(/--slider-thumb:\s*(\d+)px/);
  const thumbJsMatch = PRICING_HTML.match(/const THUMB_PX = (\d+);/);
  assert(thumbCssMatch && thumbJsMatch && thumbCssMatch[1] === thumbJsMatch[1], `REQUIRED: the CSS --slider-thumb custom property and the JS THUMB_PX constant must stay in sync (got CSS=${thumbCssMatch?.[1]}, JS=${thumbJsMatch?.[1]})`);
}
{
  const startMarker = 'const THUMB_PX = 18;';
  const endMarker = "}).join('');";
  const start = PRICING_HTML.indexOf(startMarker);
  const end = PRICING_HTML.indexOf(endMarker, start) + endMarker.length;
  if(start === -1 || end === -1) throw new Error('Could not locate the tick-generation statement in pricing.html -- it may have been renamed or restructured.');
  const TICKS_SRC = PRICING_HTML.slice(start, end);

  const ticksEl = { innerHTML: '' };
  const sandbox = { PRICING_BANDS, ticksEl };
  vm.createContext(sandbox);
  new vm.Script(TICKS_SRC, { filename: 'pricing-ticks-extract.js' }).runInContext(sandbox);

  const THUMB_PX = 18;
  const expectedLefts = PRICING_BANDS.map((b, i) => `calc(${THUMB_PX / 2}px + ${i / (PRICING_BANDS.length - 1)} * (100% - ${THUMB_PX}px))`);
  for(let i = 0; i < PRICING_BANDS.length; i++){
    assert(ticksEl.innerHTML.includes(`left:${expectedLefts[i]}`), `REQUIRED: tick ${i} (${PRICING_BANDS[i].key}) is positioned at the thumb-center-matching offset "${expectedLefts[i]}"`);
  }
  assert(ticksEl.innerHTML.includes('left:calc(9px + 0 * (100% - 18px))'), 'the first (Free) tick sits exactly at the thumb\'s leftmost resting position (9px in from the edge -- half the thumb width, not the raw 0% edge)');
  assert(ticksEl.innerHTML.includes('left:calc(9px + 1 * (100% - 18px))'), 'the last (Enterprise) tick sits exactly at the thumb\'s rightmost resting position (9px in from the right edge)');
}

// ===========================================================================
// Founder QA: a logged-in org with an existing paid capacity (100 monitored
// accounts) landed on this page with the selector defaulted to Free/10.
// initializeFromLoggedInEntitlement() -- extracted verbatim, not
// reimplemented -- must override that default for a genuinely paid org
// (from purchased CAPACITY, never current usage), leave it alone for a
// Free/anonymous visitor, and never touch window.location (no redirect --
// this is a public marketing page).
// ===========================================================================
const INIT_FN = extractFn(PRICING_HTML, 'initializeFromLoggedInEntitlement');

function makeInitSandbox({ session, usageResult, usageThrows } = {}){
  const range = { value: '0' };
  const numberInput = { value: '10' };
  const result = { dataset: {} };
  const bandLabelEl = { textContent: '' };
  const bandPriceEl = { innerHTML: '', textContent: '' };
  const bandDetailEl = { textContent: '' };
  const ctaEl = { textContent: '', href: '', onclick: null };
  const errorEl = { style: {} };
  const usageCalls = [];
  const houseAuth = {
    getSession: () => session || null,
    usage: async () => {
      usageCalls.push(1);
      if(usageThrows) throw new Error('Could not load usage.');
      return usageResult;
    }
  };
  const sandbox = {
    console,
    window: { HouseAuth: houseAuth },
    HouseAuth: houseAuth,
    PRICING_BANDS, bandForAccountCount, formatPriceCents,
    range, numberInput, result, bandLabelEl, bandPriceEl, bandDetailEl, ctaEl, errorEl,
    startCheckout: () => {}
  };
  vm.createContext(sandbox);
  const fullSource = [RENDER_FN, BAND_INDEX_FN, INIT_FN].join('\n\n');
  new vm.Script(fullSource, { filename: 'pricing-init-extract.js' }).runInContext(sandbox);
  return { sandbox, range, numberInput, bandLabelEl, ctaEl, usageCalls };
}

{
  // No session at all (anonymous visitor) -- must never call usage()/redirect,
  // and the Free/10 default is left completely untouched.
  const { sandbox, range, numberInput, usageCalls } = makeInitSandbox({ session: null });
  await sandbox.initializeFromLoggedInEntitlement();
  assert(usageCalls.length === 0, 'REQUIRED: an anonymous visitor (no session) never triggers a usage fetch -- this public page must never force a login redirect on load');
  assert(range.value === '0' && numberInput.value === '10', 'the anonymous default (Free/10) is left untouched');
}
{
  // Logged in, but a genuinely Free org -- also stays at Free/10.
  const { sandbox, range, numberInput, bandLabelEl } = makeInitSandbox({
    session: { access_token: 'tok' },
    usageResult: { usage: { paidActive: false, accountCapacity: 10 } }
  });
  await sandbox.initializeFromLoggedInEntitlement();
  assert(numberInput.value === '10' && bandLabelEl.textContent !== 'Up to 100 accounts', 'REQUIRED: a logged-in Free organization initializes at Free/10, not overridden');
}
{
  // REQUIRED: the founder's own exact case -- 100-account paid capacity, 30
  // monitored (usage). The selector must show the PURCHASED capacity (100),
  // never current usage (30), and never silently downgrade to it.
  const { sandbox, range, numberInput, bandLabelEl, ctaEl } = makeInitSandbox({
    session: { access_token: 'tok' },
    usageResult: { usage: { paidActive: true, accountCapacity: 100, totalMonitoredCompanies: 30 } }
  });
  await sandbox.initializeFromLoggedInEntitlement();
  assert(Number(numberInput.value) === 100, `REQUIRED: a paid org's selector initializes to its purchased capacity (100), not current usage (30) or the Free default (got ${numberInput.value})`);
  assert(Number(range.value) === PRICING_BANDS.indexOf(bandForAccountCount(100)), 'the range slider position matches the 100-account band');
  assert(bandLabelEl.textContent === 'Up to 100 accounts', 'REQUIRED: the band label reflects the org\'s real purchased tier');
  assert(ctaEl.textContent.includes('Subscribe'), 'the CTA still renders normally for the matched tier (server-side checkout now safely redirects an already-paid org to the Billing Portal instead of a duplicate subscription)');
}
{
  // Unlimited (Enterprise/manual) capacity -- lands on the last (Enterprise) stop.
  const { sandbox, range, numberInput } = makeInitSandbox({
    session: { access_token: 'tok' },
    usageResult: { usage: { paidActive: true, accountCapacity: null } }
  });
  await sandbox.initializeFromLoggedInEntitlement();
  assert(Number(range.value) === PRICING_BANDS.length - 1, 'REQUIRED: unlimited (null) capacity initializes the selector to the Enterprise stop');
}
{
  // A failed usage fetch (expired token, network hiccup) degrades safely --
  // never throws, never leaves the page in a broken state, just keeps the
  // anonymous-visitor default.
  const { sandbox, range, numberInput, usageCalls } = makeInitSandbox({ session: { access_token: 'tok' }, usageThrows: true });
  await sandbox.initializeFromLoggedInEntitlement();
  assert(usageCalls.length === 1, 'sanity: a usage fetch was attempted for a logged-in session');
  assert(range.value === '0' && numberInput.value === '10', 'REQUIRED: a failed usage fetch degrades safely to the Free/10 default, never throws or breaks the page');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
