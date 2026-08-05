// Commercial-readiness core validation, item 4: dashboard label contrast.
// Verifies (a) the new burnt-amber tokens are defined with the exact
// required hex values, (b) every small uppercase card-label selector named
// in the request (and the other uppercase labels sharing the same design
// pattern) now uses one of those tokens instead of the low-contrast
// --signal gold, (c) --signal itself is untouched and still drives CTA
// buttons/decorative accents, and (d) a real WCAG relative-luminance
// contrast calculation proves both new tokens clear 4.5:1 against white --
// not just that the hex values were swapped, but that the swap actually
// fixes the readability problem.
//
// Usage: node scripts/test-dashboard-label-contrast.js
import { readFileSync } from 'fs';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Real WCAG 2.x contrast ratio math (not a stand-in) -- proves the specific
// hex values the request mandates actually clear 4.5:1 on white, the same
// calculation a browser accessibility auditor would run.
// ---------------------------------------------------------------------------
function relativeLuminance(hex){
  const n = hex.replace('#','');
  const [r,g,b] = [0,2,4].map(i => parseInt(n.slice(i, i+2), 16) / 255);
  const lin = c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const [R,G,B] = [r,g,b].map(lin);
  return 0.2126*R + 0.7152*G + 0.0722*B;
}
function contrastRatio(hexA, hexB){
  const [L1, L2] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a,b) => b - a);
  return (L1 + 0.05) / (L2 + 0.05);
}

{
  const oldContrast = contrastRatio('#F5A623', '#FFFFFF');
  assert(oldContrast < 4.5, `sanity: the PREVIOUS label color (#F5A623, --signal) genuinely fails 4.5:1 on white (got ${oldContrast.toFixed(2)}:1) -- confirms this was a real defect, not a false alarm`);

  const amberContrast = contrastRatio('#B45309', '#FFFFFF');
  assert(amberContrast >= 4.5, `--label-amber (#B45309) meets the 4.5:1 WCAG AA floor on white (got ${amberContrast.toFixed(2)}:1)`);

  const strongContrast = contrastRatio('#92400E', '#FFFFFF');
  assert(strongContrast >= 4.5, `--label-amber-strong (#92400E) meets the 4.5:1 WCAG AA floor on white (got ${strongContrast.toFixed(2)}:1)`);
  assert(strongContrast > amberContrast, `--label-amber-strong is strictly higher-contrast than --label-amber, as required for the "smallest text" case (got ${strongContrast.toFixed(2)}:1 vs ${amberContrast.toFixed(2)}:1)`);
}

// ---------------------------------------------------------------------------
// Tokens are defined with the exact required values, through shared CSS
// variables (not scattered inline hex codes).
// ---------------------------------------------------------------------------
{
  assert(/--label-amber:\s*#B45309;/.test(html), 'dashboard/index.html defines --label-amber: #B45309 in :root');
  assert(/--label-amber-strong:\s*#92400E;/.test(html), 'dashboard/index.html defines --label-amber-strong: #92400E in :root');
  // Still present and unchanged -- CTA buttons/decorative accents keep the
  // brighter gold identity; this proves the fix did not remove --signal.
  assert(/--signal:\s*#F5A623;/.test(html), 'dashboard/index.html still defines the original --signal: #F5A623 (CTA/decorative gold is untouched)');
}

// ---------------------------------------------------------------------------
// Every named small-label selector now uses one of the new amber tokens,
// never the low-contrast --signal, for its text color.
// ---------------------------------------------------------------------------
function ruleBlockFor(selector){
  // Matches "SELECTOR{...}" or "SELECTOR{ ... }" (single-line or
  // multi-line) where SELECTOR itself starts the line (ignoring leading
  // whitespace) -- deliberately excludes a compound/descendant selector
  // that merely ENDS with this same class name (e.g.
  // ".opp-card-footer .meta-section .opp-label{...}" must never satisfy a
  // lookup for ".opp-label" on its own).
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)[ \\t]*${escaped}\\s*\\{([^}]*)\\}`, 'm');
  const match = html.match(re);
  return match ? match[1] : null;
}

const labelSelectors = [
  '.opp-label',              // SIGNAL / STATUS / WHY IT MATTERS / RECOMMENDED CONTACT / CONVERSATION STARTER
  '.upload-eyebrow',
  '.workflow-label',
  '.form-field label',
  '.customer-dashboard-eyebrow',
  '.new-this-week-type',
  '.top-opps-title',
  '.signal-type',
  '.signal-meta-label',
  '.section-title'
];
for(const selector of labelSelectors){
  const block = ruleBlockFor(selector);
  assert(!!block, `${selector} rule block is present in dashboard/index.html`);
  if(block){
    assert(!/color:\s*var\(--signal\)/.test(block), `${selector} no longer uses the low-contrast var(--signal) for its text color`);
    assert(/color:\s*var\(--label-amber(-strong)?\)/.test(block), `${selector} uses one of the new burnt-amber tokens (got: "${block.trim()}")`);
  }
}

// The single smallest label (0.6rem) uses the strongest variant.
{
  const block = ruleBlockFor('.signal-connection-label');
  assert(!!block, '.signal-connection-label rule block is present');
  if(block){
    assert(/color:\s*var\(--label-amber-strong\)/.test(block), `.signal-connection-label (the smallest labeled text, 0.6rem) uses --label-amber-strong (got: "${block.trim()}")`);
  }
}

// ---------------------------------------------------------------------------
// --signal is still actively used elsewhere (buttons, borders, decorative
// bullets) -- proves this was a targeted label-only fix, not a wholesale
// removal of the brand's gold accent.
// ---------------------------------------------------------------------------
{
  const remainingSignalUses = (html.match(/var\(--signal\)/g) || []).length;
  assert(remainingSignalUses >= 5, `--signal remains in active use for CTA/decorative purposes elsewhere in the stylesheet (found ${remainingSignalUses} remaining usages)`);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
