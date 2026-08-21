// Commercial Credibility V1 (2026-08-21): deterministic coverage for the
// approved navigation doctrine ("pages have a home and they stay there" --
// Why House Accounts, Real-World Results, and Pricing are permanent
// top-level destinations regardless of auth state) and the new/retired
// pages it introduces. Real-browser auth-aware header behavior and the
// Product Tour's real step-2 spotlight are covered separately in
// scripts/test-commercial-credibility-v1-live.js.
//
// Usage: node scripts/test-commercial-credibility-v1.js
import { readFileSync, existsSync } from 'fs';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function read(path){ return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'); }

// =============================================================================
// 1) Navigation doctrine: Why House Accounts, Real-World Results, and
//    Pricing are ONE shared, permanent list -- never a conditional pair of
//    lists that happen to agree.
// =============================================================================
{
  const header = read('site-header.js');
  const commercialMatch = header.match(/const COMMERCIAL_LINKS=\[([\s\S]*?)\];/);
  assert(!!commercialMatch, 'REQUIRED: site-header.js defines a single shared COMMERCIAL_LINKS constant');
  const commercialBlock = commercialMatch ? commercialMatch[1] : '';
  assert(/label:'Why House Accounts',href:'\/why-house-accounts\.html'/.test(commercialBlock), 'REQUIRED: COMMERCIAL_LINKS includes Why House Accounts -> /why-house-accounts.html');
  assert(/label:'Real-World Results',href:'\/real-world-results\.html'/.test(commercialBlock), 'REQUIRED: COMMERCIAL_LINKS includes Real-World Results -> /real-world-results.html');
  assert(/label:'Pricing',href:'\/pricing\.html'/.test(commercialBlock), 'REQUIRED: COMMERCIAL_LINKS includes Pricing -> /pricing.html');

  const publicLinksMatch = header.match(/const publicLinks=(\[\.\.\.COMMERCIAL_LINKS\]);/);
  assert(!!publicLinksMatch, 'REQUIRED: publicLinks IS the shared COMMERCIAL_LINKS list (spread, not redefined) -- signed-out nav never diverges from the permanent list');

  const appLinksMatch = header.match(/const appLinks=\[([\s\S]*?)\];/);
  assert(!!appLinksMatch, 'sanity: appLinks is defined');
  const appLinksBlock = appLinksMatch ? appLinksMatch[1] : '';
  assert(/label:'Dashboard'/.test(appLinksBlock), 'REQUIRED: Dashboard leads the authenticated nav');
  assert(/\.\.\.COMMERCIAL_LINKS/.test(appLinksBlock), 'REQUIRED: appLinks spreads the SAME shared COMMERCIAL_LINKS list -- signed-in nav never diverges from the permanent list either');
  assert(!/label:'Upload Guides'/.test(appLinksBlock), 'REQUIRED: Upload Guides is not in primary authenticated navigation');
  assert(!/label:'FAQ'/.test(appLinksBlock) && !/label:'Security'/.test(appLinksBlock), 'REQUIRED: FAQ and Security are not in primary authenticated navigation');
}

// =============================================================================
// 2) Help dropdown: Upload Guides has its new, permanent home there.
// =============================================================================
{
  const header = read('site-header.js');
  const dropdownMatch = header.match(/id="haHelpDropdown"[^>]*>([\s\S]*?)<\/div>/);
  assert(!!dropdownMatch, 'sanity: Help dropdown markup located');
  const dropdownBlock = dropdownMatch ? dropdownMatch[1] : '';
  const order = ['Restart Product Tour', 'Upload Guides', 'FAQ', "What's New", 'Contact / Feedback'];
  let lastIndex = -1;
  let inOrder = true;
  for(const label of order){
    const idx = dropdownBlock.indexOf(label);
    if(idx === -1 || idx < lastIndex) inOrder = false;
    lastIndex = idx;
  }
  assert(inOrder, `REQUIRED: Help dropdown items appear in the specified order (${order.join(' | ')})`);
  assert(/href="\/export-guides\/">Upload Guides<\/a>/.test(dropdownBlock), 'REQUIRED: Upload Guides in Help points to /export-guides/');
  assert(!/href="\/why-house-accounts\.html"/.test(dropdownBlock) && !/href="\/real-world-results\.html"/.test(dropdownBlock), 'REQUIRED: Why House Accounts and Real-World Results are never added to Help -- they stay in primary nav only');
}

// =============================================================================
// 3) Footer stays restrained and structurally unchanged -- still holds the
//    secondary/trust/legal resources, not the two permanent commercial
//    pages (already covered by primary nav).
// =============================================================================
{
  const header = read('site-header.js');
  const footerMatch = header.match(/const footerLinks=\[([\s\S]*?)\];/);
  assert(!!footerMatch, 'sanity: footerLinks defined');
  const footerBlock = footerMatch ? footerMatch[1] : '';
  for(const label of ['Pricing', 'Upload Guides', 'Upload Troubleshooting', 'Data Security', 'Privacy', 'Terms', 'Contact / Feedback']){
    assert(footerBlock.includes(`label:'${label}'`), `sanity: authenticated footer still includes "${label}"`);
  }
  assert(!footerBlock.includes("label:'Why House Accounts'") && !footerBlock.includes("label:'Real-World Results'"), 'REQUIRED: footer stays restrained -- the two permanent commercial pages are not duplicated into it');
}

// =============================================================================
// 4) Product Tour step 2: spotlights the permanent Help control, teaches
//    the real information architecture, never programmatically opens Help
//    just to preserve the old spotlight target.
// =============================================================================
{
  const dashboard = read('dashboard/index.html');
  const stepMatch = dashboard.match(/id: 'export-guides',[\s\S]{0,700}?\},/);
  assert(!!stepMatch, 'sanity: the export-guides tour step is located');
  const stepBlock = stepMatch ? stepMatch[0] : '';
  assert(/target: '#haHelpToggle'/.test(stepBlock), "REQUIRED: tour step 2 spotlights #haHelpToggle, the permanent Help control");
  assert(!/target: 'a\[href="\/export-guides\/"\]'/.test(dashboard), 'REQUIRED: the old direct-nav-link spotlight target is gone');
  assert(/Need help preparing or uploading customer data\? Upload Guides are always available under Help\./.test(stepBlock), 'REQUIRED: tour step 2 copy teaches the real, current location -- Upload Guides under Help');
  assert(!/helpDropdown\.hidden\s*=\s*false/.test(dashboard.slice(dashboard.indexOf("id: 'export-guides'") - 200, dashboard.indexOf("id: 'export-guides'") + 900)), 'sanity: this step does not programmatically force the Help dropdown open just to preserve old spotlight behavior');
}

// =============================================================================
// 5) Why House Accounts -- new page exists, uses the shared design system,
//    and does not overclaim ("solely/mostly responsible").
// =============================================================================
{
  assert(existsSync(new URL('../why-house-accounts.html', import.meta.url)), 'REQUIRED: why-house-accounts.html exists');
  const page = read('why-house-accounts.html');
  assert(/<title>Why House Accounts \| House Accounts<\/title>/.test(page), 'sanity: page title is correct');
  assert(page.includes('site-header.css') && page.includes('site-header.js'), 'REQUIRED: the page loads the shared header/nav system, not a bespoke one');
  assert(page.includes('Who should I contact next, and why?'), 'REQUIRED: preserves the existing product question');
  assert(page.includes('Make every rep their best rep.'), 'REQUIRED: preserves "Make every rep their best rep."');
  assert(page.includes('Trustworthy first. Useful second. Clever third.'), 'REQUIRED: preserves "Trustworthy first. Useful second. Clever third."');
  // Founder Narrative Correction (2026-08-21): the founder's personal $0->$1M
  // sales milestone is no longer the public positioning centerpiece -- it
  // remains fine for direct founder-led sales conversations, interviews, and
  // historical/internal documentation, but must not carry the core public
  // product story. See BACKLOG.md for the doctrine.
  assert(!/\$0|\$1M|\bno prior (industry )?experience\b/i.test(page), 'REQUIRED: the founder\'s personal $0->$1M milestone is no longer the public positioning centerpiece on Why House Accounts');
  assert(page.includes('firsthand experience building and managing a promotional-products book'), 'REQUIRED: the durable practitioner-credibility framing (firsthand experience, not the milestone) is present');
  assert(!/solely|mostly responsible/i.test(page), 'REQUIRED: does not claim the practices were solely or mostly responsible for the growth');
  assert(!/biography|life story/i.test(page), 'sanity: does not read as a founder biography');
  assert(page.includes('href="/real-world-results.html"'), 'REQUIRED: bridges to Real-World Results');
  assert(page.includes('href="/signup"'), 'REQUIRED: bridges to Start Free');
  for(const practice of ['reorder', 'go quiet', 'timely', 'departments and categories', 'proactive']){
    assert(new RegExp(practice, 'i').test(page), `sanity: the practices list mentions "${practice}"`);
  }
}

// =============================================================================
// 6) Real-World Results -- canonical proof destination, correctly framed as
//    real founder field results (not independent customer case studies),
//    with the three confirmed anonymized examples, truthfully represented.
// =============================================================================
{
  assert(existsSync(new URL('../real-world-results.html', import.meta.url)), 'REQUIRED: real-world-results.html exists');
  assert(!existsSync(new URL('../success-stories.html', import.meta.url)), 'REQUIRED: the old success-stories.html path no longer exists (renamed, not duplicated)');
  const page = read('real-world-results.html');
  assert(/<title>Real-World Results \| House Accounts<\/title>/.test(page), 'sanity: page title is correct');
  assert(page.includes('site-header.css') && page.includes('site-header.js'), 'REQUIRED: the page loads the shared header/nav system');
  assert(/real, anonymized results from House Accounts being used in the field/.test(page), 'REQUIRED: framing clearly states these are real, anonymized field examples');
  assert(!/documents how the signal engine performed in the real world/.test(page), 'REQUIRED: the old unhedged "documents...in the real world" overclaim is gone');
  assert(/anonymized to protect the businesses involved/.test(page), 'REQUIRED: explicit anonymity framing is present');

  // The six-stage progression stays conceptually intact.
  const stages = ['Signal Found', 'Rep Took Action', 'Timing Confirmed', 'Meeting Scheduled', 'Opportunity Created', 'Order Won'];
  for(const stage of stages) assert(page.includes(`<div class="flow-step">${stage}</div>`), `REQUIRED: the validation progression still includes "${stage}"`);

  // Story 1 -- Timing Confirmed (unchanged, confirmed real).
  assert(page.includes('Regional Manufacturing Company') && page.includes('Seasonal Buying Pattern'), 'REQUIRED: Timing Confirmed story is present');
  assert(page.includes("We're discussing that with our buying team next week."), 'REQUIRED: the real quoted response is present, unembellished');
  assert(page.includes('Timing validated.'), 'REQUIRED: Timing Confirmed outcome is present, unembellished');

  // Story 2 -- Order Won (unchanged, confirmed real, $1,000).
  assert(page.includes('Regional Healthcare Practice') && page.includes('Milestone Anniversary'), 'REQUIRED: Order Won story is present');
  assert(page.includes('Anniversary merchandise order') && page.includes('$1,000'), 'REQUIRED: the $1,000 outcome is present, exactly as confirmed -- not embellished with a larger or different figure');

  // Story 3 -- Meeting Scheduled (new, confirmed real, no quote, no invented outcome).
  assert(page.includes('Regional Automotive Dealership') && page.includes('Community/Event Signal'), 'REQUIRED: Meeting Scheduled story is present');
  assert(page.includes('Meeting generated.'), 'REQUIRED: Meeting Scheduled outcome is present, exactly as confirmed');
  const storyBlockMatch = page.match(/data-stage="Meeting Scheduled"[\s\S]*?<\/article>/);
  assert(!!storyBlockMatch, 'sanity: located the Meeting Scheduled story card');
  assert(storyBlockMatch && !/class="response"/.test(storyBlockMatch[0]), 'REQUIRED: no invented quote for the Meeting Scheduled story -- none was confirmed');

  const cardCount = (page.match(/<article class="story"/g) || []).length;
  assert(cardCount === 3, `REQUIRED: exactly three story cards are present (got ${cardCount})`);

  // Correctness fix riding along with this change: the results count was
  // hardcoded to "2 documented examples" and would have silently gone
  // stale the moment a third card was added.
  assert(page.includes('`Growing validation library — ${cards.length} documented examples`'), 'REQUIRED: the results count is computed from cards.length, not hardcoded -- it will not go stale again as more stories are added');
  assert(!page.includes('2 documented examples'), 'REQUIRED: the old hardcoded "2 documented examples" string is gone');
}

// =============================================================================
// 7) Hall of Accounts -- retired entirely, redirected, no unverified
//    testimonials carried forward.
// =============================================================================
{
  assert(!existsSync(new URL('../hall-of-accounts.html', import.meta.url)), 'REQUIRED: hall-of-accounts.html no longer exists');
  const vercelConfig = JSON.parse(read('vercel.json'));
  const redirects = vercelConfig.redirects || [];
  const halRedirect = redirects.find(r => r.source === '/hall-of-accounts.html');
  assert(!!halRedirect, 'REQUIRED: vercel.json redirects /hall-of-accounts.html');
  assert(halRedirect && halRedirect.destination === '/real-world-results.html', 'REQUIRED: the redirect destination is the canonical Real-World Results page');
  const realWorldResults = read('real-world-results.html');
  assert(!realWorldResults.includes('Promo Sales Manager') && !realWorldResults.includes('Distributor Owner'), 'REQUIRED: the two unverified Hall of Accounts testimonials were not carried forward into the canonical proof page');
}

// =============================================================================
// 8) Homepage: product-first structure preserved, one compact bridge
//    section added (not two giant sections), no hero/three-card redesign.
// =============================================================================
{
  const home = read('index.html');
  assert(home.includes('Know which customers to contact this week'), 'sanity: hero headline unchanged');
  assert(home.includes('Analyze Existing Customers') && home.includes('Surface Actionable Signals') && home.includes('Know What to Do Next'), 'REQUIRED: the existing three-card product explanation is unchanged');
  const bridgeSections = (home.match(/class="bridge-grid"/g) || []).length;
  assert(bridgeSections === 1, `REQUIRED: exactly one compact bridge section was added, not two giant ones (found ${bridgeSections})`);
  assert(home.includes('href="/why-house-accounts.html"'), 'REQUIRED: homepage bridges to Why House Accounts');
  assert(home.includes('href="/real-world-results.html"'), 'REQUIRED: homepage bridges to Real-World Results');
  assert(home.includes('href="/why-house-accounts.html">Why House Accounts</a>') && home.includes('href="/real-world-results.html">Real-World Results</a>') && home.includes('href="/pricing.html">Pricing</a>'), 'REQUIRED: homepage primary nav reflects the new permanent doctrine');
  assert(!home.includes('href="/faq.html">FAQ</a><a href="/security.html">Security</a><a href="/contact.html">Feedback</a>'), 'REQUIRED: FAQ/Security/Feedback are no longer in the homepage primary nav');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
