// Founder QA amendment (2026-08-20, RC remediation branch, scope-locked):
// FAQ existed (faq.html, corrected under RC-3.1 on the same branch) but had
// no entry point from the authenticated Help dropdown. Meanwhile "Export
// Help" and "Upload Troubleshooting" were both just anchors into the SAME
// /export-guides/ page the top-level "Upload Guides" nav link already
// opens (see export-guides/index.html's own #need-help/#troubleshooting
// section ids) -- redundant Help-menu entries for a destination already one
// click away. Smallest navigation-only correction: add a real FAQ entry,
// remove the two redundant ones. No header/Help-system/FAQ/Upload Guides
// redesign.
//
// Usage: node scripts/test-help-dropdown-faq-navigation.js
import { readFileSync } from 'fs';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const header = readFileSync(new URL('../site-header.js', import.meta.url), 'utf8');
const dropdownMatch = header.match(/id="haHelpDropdown"[^>]*>([\s\S]*?)<\/div>/);
if(!dropdownMatch) throw new Error('Could not locate the #haHelpDropdown markup in site-header.js -- it may have been renamed or restructured.');
const dropdownBlock = dropdownMatch[1];

assert(/href="\/faq\.html">FAQ<\/a>/.test(dropdownBlock), 'REQUIRED: the Help dropdown offers a real FAQ entry, pointing to faq.html');
assert(!/Export Help/.test(dropdownBlock), 'REQUIRED: the redundant "Export Help" Help-menu entry is gone');
assert(!/Upload Troubleshooting/.test(dropdownBlock), 'REQUIRED: the redundant "Upload Troubleshooting" Help-menu entry is gone');
assert(!/export-guides/.test(dropdownBlock), 'REQUIRED: no remaining Help-menu entry points into /export-guides/ -- that destination is reached via the existing top-level Upload Guides nav link instead');

// Every other pre-existing Help item is untouched.
assert(/href="\/dashboard\/#restart-tour">Restart Product Tour<\/a>/.test(dropdownBlock), 'sanity: "Restart Product Tour" is unchanged');
assert(/href="\/contact\.html">Contact \/ Feedback<\/a>/.test(dropdownBlock), 'sanity: "Contact / Feedback" is unchanged');
assert(/whats-new\.html/.test(dropdownBlock), 'sanity: "What\'s New" is unchanged (still gated on MVP_FEATURES.whatsNewNavigation)');

// Scope discipline: the authenticated app footer's own "Upload
// Troubleshooting" entry is a SEPARATE surface (footerLinks) the founder
// did not ask to change -- it must remain untouched by this correction.
const footerLinksMatch = header.match(/const footerLinks=\[[\s\S]*?\];/);
assert(!!footerLinksMatch, 'sanity: footerLinks is still defined');
assert(footerLinksMatch[0].includes("label:'Upload Troubleshooting'"), 'REQUIRED (scope discipline): the authenticated app footer\'s own "Upload Troubleshooting" link is untouched -- this correction only removes the redundant Help-DROPDOWN entries, not the footer');

// Upload Guides itself (the destination these two removed entries
// duplicated) is untouched -- still the real top-level nav route.
const appLinksMatch = header.match(/const appLinks=\[[\s\S]*?\];/);
assert(!!appLinksMatch, 'sanity: appLinks is still defined');
assert(appLinksMatch[0].includes("label:'Upload Guides'") && appLinksMatch[0].includes("href:'/export-guides/'"), 'REQUIRED (scope discipline): the top-level "Upload Guides" nav link is untouched');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
