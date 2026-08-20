// Paid-beta-readiness sprint: What's New page restoration + navigation.
// The former /coming-soon page was fully orphaned -- self-referencing nav
// only, no real entry point anywhere in the app, gated by a
// comingSoonNavigation MVP flag that was defined but never actually
// consulted. Restored and repositioned as /whats-new.html ("What's New"),
// wired into the existing authenticated Help dropdown (the ONLY "Help
// menu" structure the current navigation actually has -- signed-out
// visitors have no Help menu at all), never added to the public/primary
// nav.
//
// Usage: node scripts/test-whats-new-page.js
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const whatsNew = fs.readFileSync(new URL('../whats-new.html', import.meta.url), 'utf8');
const header = fs.readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
const headerCss = fs.readFileSync(new URL('../site-header.css', import.meta.url), 'utf8');

// Item 1: the page route is a real, accessible static file (Vercel's
// cleanUrls:true serves whats-new.html at both /whats-new.html and
// /whats-new automatically -- no extra routing config needed, matching
// every other top-level marketing page in this repo).
assert.match(whatsNew, /<title>What's New \| House Accounts<\/title>/, 'item 1: whats-new.html exists with the expected page title');
assert.match(whatsNew, /<!DOCTYPE html>/i, 'item 1: whats-new.html is a complete, well-formed HTML document');
assert.equal(fs.existsSync(new URL('../coming-soon.html', import.meta.url)), false, 'the former /coming-soon.html file no longer exists -- restored as What\'s New, not left as an orphaned duplicate');

// Item 2: the navigation link is visible in the chosen location -- the
// existing authenticated Help dropdown, gated by the (renamed, now
// actually-used) whatsNewNavigation MVP flag.
assert.match(header, /whatsNewNavigation:true/, 'item 2: the whatsNewNavigation MVP flag is defined and enabled');
assert.match(header, /MVP_FEATURES\.whatsNewNavigation \? `<a role="menuitem" href="\/whats-new\.html">What's New<\/a>` : ''/, 'item 2: the Help dropdown conditionally renders a "What\'s New" menu item gated by the flag');
assert.doesNotMatch(header, /comingSoonNavigation:false/, 'the old, never-consulted comingSoonNavigation flag declaration no longer exists (renamed, not duplicated) -- it may still be mentioned in an explanatory comment');

// Item 3: mobile navigation remains functional -- the new link lives
// INSIDE the existing #haHelpDropdown container, so it automatically
// inherits the same mobile collapse/expand behavior every other Help item
// already has; no separate mobile-specific markup was introduced, and the
// menu button / mobile breakpoint rules are untouched.
{
  const dropdownBlock = header.match(/<div class="ha-help-dropdown"[\s\S]*?<\/div>/)[0];
  assert.match(dropdownBlock, /What's New/, 'item 3: the What\'s New link is nested inside the same Help dropdown container as every other Help item, so mobile collapse/expand behavior applies to it automatically');
}
assert.match(header, /ha-menu-button/, 'item 3: the mobile menu toggle button remains present and untouched');
assert.match(headerCss, /@media\(max-width:1260px\)\{[\s\S]*?\.ha-help-dropdown/, 'item 3: the existing mobile breakpoint rule for the Help dropdown is still present in site-header.css');
assert.match(headerCss, /\.ha-menu-button\{display:inline-flex/, 'item 3: the mobile menu-button display rule is unchanged');

// Item 4: Recently Shipped, Up Next, and Exploring are clearly
// distinguished -- three separate, differently-badged sections, in that
// order, each with its own heading and framing copy.
assert.match(whatsNew, /badge shipped">Recently Shipped/, 'item 4: a distinct "Recently Shipped" badge/section exists');
assert.match(whatsNew, /badge next">Up Next/, 'item 4: a distinct "Up Next" badge/section exists');
assert.match(whatsNew, /badge exploring">Exploring/, 'item 4: a distinct "Exploring" badge/section exists');
{
  const shippedIdx = whatsNew.indexOf('Recently Shipped');
  const nextIdx = whatsNew.indexOf('Up Next');
  const exploringIdx = whatsNew.indexOf('Exploring');
  assert.ok(shippedIdx > 0 && nextIdx > shippedIdx && exploringIdx > nextIdx, 'item 4: the three sections render in Recently Shipped -> Up Next -> Exploring order');
}
assert.match(whatsNew, /Planned .{0,20}not guaranteed dates\.|Planned — not guaranteed dates\./, 'item 4: Up Next is explicitly framed as planned, not guaranteed');
assert.match(whatsNew, /Not committed/, 'item 4: Exploring is explicitly framed as not committed, distinct from Up Next');

// Item 5: no stale delivery dates or unsupported claims remain -- no
// specific future ship-date/quarter language, and only real, already-
// promoted-to-main capabilities appear under Recently Shipped.
assert.doesNotMatch(whatsNew, /\bQ[1-4]\s*20\d\d\b/, 'item 5: no specific quarter-based ship date appears anywhere on the page');
{
  // Strip the one legitimate "Last updated: <Month> <Year>" label itself
  // before checking that no OTHER month/year delivery promise exists.
  const withoutLastUpdated = whatsNew.replace(/Last updated:\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d\d/, '');
  assert.doesNotMatch(withoutLastUpdated, /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d\d\b/, 'item 5: no specific future calendar month/year delivery promise appears anywhere other than the "Last updated" label');
}
// "not guaranteed dates" (the required Up Next framing) is an explicit
// disclaimer, not a promise -- only an AFFIRMATIVE guarantee claim is banned.
assert.doesNotMatch(whatsNew, /\bwe guarantee\b|\bguaranteed delivery\b|\bcoming soon\b/i, 'item 5: no affirmative guaranteed-delivery promise or "coming soon" language remains');
for(const internalTerm of ['branch', 'Claude', 'Anthropic', 'regression test', 'database', 'Supabase', 'provider architecture']){
  assert.doesNotMatch(whatsNew, new RegExp(internalTerm, 'i'), `item 5/design: no internal engineering term ("${internalTerm}") is exposed on the customer-facing page`);
}
assert.match(whatsNew, /Last updated: /, 'a visible "Last updated" label exists, using the same plain hand-maintained convention as privacy.html/terms.html');

// Item 6: existing Help and header navigation remain functional -- every
// Help dropdown item present as of this correction is still present,
// unchanged. Release-candidate correction (2026-08-20, RC amendment):
// "Export Help" and "Upload Troubleshooting" (both /export-guides/ anchors,
// redundant with the top-level "Upload Guides" nav link) were removed from
// the Help dropdown and replaced with a real "FAQ" entry -- see the
// dedicated coverage in scripts/test-help-dropdown-faq-navigation.js.
for(const existingItem of [
  'href="/dashboard/#restart-tour">Restart Product Tour',
  'href="/faq.html">FAQ',
  'href="/contact.html">Contact / Feedback'
]){
  assert.match(header, new RegExp(existingItem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `item 6: existing Help dropdown item ("${existingItem}") is still present and unchanged`);
}
assert.doesNotMatch(header, /href="\/export-guides\/#need-help">Export Help/, 'RC amendment: the redundant "Export Help" Help-menu entry is gone -- Upload Guides is already the top-level destination');
assert.doesNotMatch(header, /href="\/export-guides\/#troubleshooting">Upload Troubleshooting/, 'RC amendment: the redundant "Upload Troubleshooting" Help-menu entry is gone -- Upload Guides is already the top-level destination');
assert.match(header, /const publicLinks=\[/, 'item 6: the public (signed-out) nav link list is still defined');
assert.match(header, /const appLinks=\[/, 'item 6: the authenticated app nav link list is still defined');
{
  const publicLinksBlock = header.match(/const publicLinks=\[[\s\S]*?\];/)[0];
  const appLinksBlock = header.match(/const appLinks=\[[\s\S]*?\];/)[0];
  assert.doesNotMatch(publicLinksBlock, /whats-new/, 'design requirement: What\'s New is never added to the primary public nav -- it stays a subtle Help-menu item, not the primary header action');
  assert.doesNotMatch(appLinksBlock, /whats-new/, 'design requirement: What\'s New is never added to the primary authenticated nav either');
}

// Item 7: authentication behavior is unchanged -- the Help dropdown
// (carrying the new link) only ever renders in the `authenticated` branch;
// hasSession()/render()'s auth-gating logic is untouched.
assert.match(header, /function hasSession\(\)\{\s*return Boolean\(read\(SESSION_KEY\)\?\.access_token\);\s*\}/, 'item 7: hasSession() auth-check logic is unchanged');
assert.match(header, /const authenticated=hasSession\(\);/, 'item 7: render() still derives authenticated state the same way');
{
  const authenticatedMatch = header.match(/<div class="ha-help-menu">[\s\S]*?Sign Out<\/button>`/);
  assert.ok(authenticatedMatch, 'sanity: the authenticated header template branch was found');
  const authenticatedBranch = authenticatedMatch[0];
  assert.match(authenticatedBranch, /What's New/, 'item 7: the What\'s New link only renders inside the authenticated branch of the header template, never for signed-out visitors');
}

// Item 8: syntax check -- site-header.js and whats-new.html's inline
// <script> both parse without a syntax error (same pattern as
// test-followup-round.js's dashboard/index.html syntax check).
execFileSync(process.execPath, ['--check', new URL('../site-header.js', import.meta.url).pathname]);
console.log('PASS: item 8: site-header.js parses without a syntax error');
{
  const scriptMatches = [...whatsNew.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scriptMatches.length === 0, 'item 8: whats-new.html has no inline <script> blocks to syntax-check (static content page, matching pricing.html/faq.html/contact.html)');
}

console.log('PASS: all What\'s New page and navigation checks passed');
