// Foundation freeze, Phase 3: direct proof of scripts/lib/dashboard-extract.js
// against representative REAL dashboard/index.html functions/blocks (small,
// large, nested braces, async, a multi-function range, template literals +
// object literals, window.NAME=function, const object/primitive
// declarations) plus deliberately adversarial cases (a regex literal
// containing brackets, missing markers, ambiguous markers) -- proving the
// extractor before anything is migrated to depend on it, per Phase 3's own
// required order of operations.
//
// Usage: node scripts/test-dashboard-extract-lib.js
import { extractFn, extractRange, extractStatementAfter, findMatchingBracket, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const SRC = loadDashboardSource();

// ===========================================================================
// Small function.
// ===========================================================================
{
  const fn = extractFn(SRC, 'sourceDomain');
  assert(fn.startsWith('function sourceDomain(url){'), `small function: extracted text starts with the real declaration (got "${fn.slice(0, 40)}...")`);
  assert(fn.trimEnd().endsWith('}'), 'small function: extracted text ends with its own closing brace');
  assert(fn.includes('new URL(url)'), 'small function: extracted text contains the real function body');
  assert(new Function('return (' + fn.replace(/^function sourceDomain/, 'function') + ')')()('https://example.com/x') === 'example.com', 'small function: the extracted source is genuinely executable and produces the correct real result');
}

// ===========================================================================
// Large function (window.NAME = function(){...}; -- also covers that
// declaration shape and a trailing semicolon).
// ===========================================================================
{
  const fn = extractFn(SRC, 'createSalesPlayPanel');
  assert(fn.startsWith('window.createSalesPlayPanel = function(opp, opts){'), `large function: extracted text starts with the real declaration (got "${fn.slice(0, 55)}...")`);
  assert(fn.trimEnd().endsWith('}'), 'large function: extracted text ends with its own closing brace (this particular window.NAME=function(){...} has no trailing semicolon in the real source)');
  assert(fn.length > 3000, `large function: extraction is genuinely large, not truncated (got ${fn.length} characters)`);
  assert(fn.includes('renderThePlaySection') && fn.includes('renderIdeasToSendSection'), 'large function: contains real internal calls from deep within its body, proving the full extent was captured');

  // A smaller window.NAME=function(){...}; sibling that DOES carry a
  // trailing semicolon in the real source -- proves that shape specifically.
  const smallWindowFn = extractFn(SRC, 'closeSalesPlayModal');
  assert(smallWindowFn.startsWith('window.closeSalesPlayModal = function(el){'), 'window.NAME=function with trailing semicolon: extracted the real declaration');
  assert(smallWindowFn.trimEnd().endsWith('};'), `window.NAME=function with trailing semicolon: extraction keeps the trailing ";" (got "...${smallWindowFn.slice(-10)}")`);
}

// ===========================================================================
// Nested braces (an object literal returned from inside conditional
// branches, itself containing array values) -- proves brace depth tracking
// survives multiple levels, not just one function body's outer braces.
// ===========================================================================
{
  const fn = extractFn(SRC, 'createOpportunity');
  assert(fn.startsWith('function createOpportunity('), 'nested braces: extracted the real createOpportunity() declaration');
  assert(fn.trimEnd().endsWith('}'), 'nested braces: extraction closes at the correct final brace, not an inner one');
  assert(/const opp = \{/.test(fn), 'nested braces: contains the nested object literal opening');
  assert(/return assignOpportunityScore\(opp, account\);/.test(fn), 'nested braces: contains the real final return statement, proving extraction did not stop early at an inner closing brace');
}

// ===========================================================================
// Async function.
// ===========================================================================
{
  const fn = extractFn(SRC, 'fetchUploadScopedSnapshot');
  assert(fn.startsWith('async function fetchUploadScopedSnapshot('), `async function: extracted text starts with "async function" (got "${fn.slice(0, 50)}...")`);
  assert(fn.trimEnd().endsWith('}'), 'async function: extracted text ends with its own closing brace');
  assert(/await /.test(fn), 'async function: body genuinely contains an await expression');
}

// ===========================================================================
// Function containing a template literal AND an object-literal-shaped
// pattern together, plus nested if-blocks -- getWhyNowText().
// ===========================================================================
{
  const fn = extractFn(SRC, 'getWhyNowText');
  assert(fn.startsWith('function getWhyNowText(opp){'), 'template-literal function: extracted the real getWhyNowText() declaration');
  assert(fn.includes('`Signal: ${title}`'), 'template-literal function: the extracted text preserves a real ${...} template expression verbatim, unbroken by brace-depth tracking');
  assert(fn.trimEnd().endsWith('}'), 'template-literal function: extraction closes correctly despite the template literal\'s own braces');
}

// ===========================================================================
// Function whose body contains regex literals with alternation (parens) and
// quantifiers/character content that LOOK like braces/brackets --
// isRecentAccountActivity(). This is the adversarial case that would corrupt
// a naive (non-trivia-aware) brace counter.
// ===========================================================================
{
  const fn = extractFn(SRC, 'isRecentAccountActivity');
  assert(fn.startsWith('function isRecentAccountActivity(opp){'), 'regex-containing function: extracted the real declaration');
  assert(/\/recent activity\|last closed order/.test(fn), 'regex-containing function: the real regex literal (with internal "|" alternation) is preserved verbatim');
  assert(fn.trimEnd().endsWith('}'), 'regex-containing function: extraction closes at the correct brace despite the regex literal\'s content never being brace/paren-counted');
}

// ===========================================================================
// const object literal declaration.
// ===========================================================================
{
  const block = extractFn(SRC, 'TIMEBOX_CONFIG');
  assert(block.startsWith('const TIMEBOX_CONFIG = {'), 'const object literal: extracted the real declaration');
  assert(block.trimEnd().endsWith('};'), 'const object literal: extraction includes the closing brace and trailing semicolon');
  assert(/quarter:\s*\{/.test(block), 'const object literal: a nested key\'s own object value is present, proving nested-brace handling works for object literals too');
}

// ===========================================================================
// let primitive declaration (no object/array value).
// ===========================================================================
{
  const decl = extractFn(SRC, 'cachedLists');
  assert(decl === 'let cachedLists=[];' || decl.startsWith('let cachedLists='), `let declaration: extracted the real declaration verbatim (got "${decl}")`);
}

// ===========================================================================
// Multi-function range (extractRange) -- two functions that are genuinely
// adjacent in the real file and belong together as one unit for a test that
// needs both (signalLayerLabel calls isWebResearchSignal/isRecentAccountActivity;
// isRecentAccountActivity is defined immediately after it).
// ===========================================================================
{
  const range = extractRange(SRC, 'function signalLayerLabel(opp){', 'function isRecentAccountActivity(opp){');
  assert(range.startsWith('function signalLayerLabel(opp){'), 'multi-function range: starts at the requested start marker');
  assert(range.trimEnd().endsWith('}'), 'multi-function range: ends at the end marker function\'s own closing brace');
  assert(range.includes('function isRecentAccountActivity(opp){'), 'multi-function range: the end marker function is fully included, not cut off partway');
  assert((range.match(/^function /gm) || []).length === 2, `multi-function range: contains exactly the two intended top-level functions, nothing extra (got ${(range.match(/^function /gm) || []).length})`);
}

// ===========================================================================
// extractRange()'s endMarker is deliberately NOT required to be globally
// unique -- only the NEAREST occurrence after startMarker matters. Proven
// against the real file: `function close(){` (no parameters) genuinely
// repeats (dashboard/index.html has it at least twice, in unrelated nested
// scopes), yet extracting the range ending at the FIRST one after a real,
// unique start marker must succeed and land on the correct, nearer one.
// ===========================================================================
{
  const closeCount = (SRC.match(/function close\(\)\{/g) || []).length;
  assert(closeCount >= 2, `sanity: "function close(){" (no params) genuinely repeats in the real file, making this a real adversarial case, not a synthetic one (got ${closeCount} occurrences)`);
  const range = extractRange(SRC, 'function open(){', 'function close(){');
  assert(range.startsWith('function open(){'), 'endMarker nearest-match: starts at the real open() declaration');
  assert(/stopResearchPoll\(\)/.test(range), 'endMarker nearest-match: the range reaches into the NEARER close() (which calls stopResearchPoll()), not a farther-away same-named one');
  assert((range.match(/function close\(\)\{/g) || []).length === 1, 'endMarker nearest-match: exactly the one, nearest close() is included -- extraction did not run past it to a later occurrence');
}

// ===========================================================================
// extractStatementAfter() -- the rare anonymous top-level statement with no
// name to look up (a delegated `document.addEventListener('click', ...)`
// wiring call). Anchored to the end of a real, named extraction
// (renderRecentlyResearchedSection()) rather than a bare line number.
// ===========================================================================
{
  const anchorFn = extractFn(SRC, 'getRecentlyResearchedAccounts');
  const anchorIndex = SRC.indexOf(anchorFn) + anchorFn.length;
  const stmt = extractStatementAfter(SRC, anchorIndex, "document.addEventListener('click'");
  assert(stmt.startsWith("document.addEventListener('click'"), 'extractStatementAfter: extracted text starts with the real statement');
  assert(stmt.trimEnd().endsWith(');'), `extractStatementAfter: extraction closes at the call's own matching ")" plus trailing ";" (got "...${stmt.slice(-15)}")`);
  assert(/isResearchResultDismissed|dismissResearchResult|openResearchedAccountOpportunities/.test(stmt), 'extractStatementAfter: the extracted listener body contains real, expected logic, not an empty or truncated stub');
}

// ===========================================================================
// Failure/detection: a name that does not exist anywhere in the source.
// ===========================================================================
{
  let threw = false;
  try { extractFn(SRC, 'thisFunctionDoesNotExistAnywhere12345'); }
  catch(e){ threw = true; assert(/no top-level function\/const\/let declaration/.test(e.message), `missing name: error message clearly explains the name was not found (got "${e.message}")`); }
  assert(threw, 'missing name: extractFn() throws rather than silently returning something wrong');
}

// ===========================================================================
// Failure/detection: an AMBIGUOUS name (appears more than once) must throw,
// never silently pick one -- tested against a small synthetic source so the
// test does not depend on a coincidental real duplicate existing.
// ===========================================================================
{
  const synthetic = `function duplicateName(a){\n  return a;\n}\n\nfunction duplicateName(b){\n  return b * 2;\n}\n`;
  let threw = false;
  try { extractFn(synthetic, 'duplicateName'); }
  catch(e){ threw = true; assert(/AMBIGUOUS/.test(e.message), `ambiguous name: error message explicitly says AMBIGUOUS (got "${e.message}")`); }
  assert(threw, 'ambiguous name: extractFn() throws rather than silently picking the first (or last) match');
}

// ===========================================================================
// Failure/detection: extractRange() with a marker that does not exist, and
// one that is ambiguous.
// ===========================================================================
{
  let threw = false;
  try { extractRange(SRC, 'function thisDoesNotExist999(', 'function isRecentAccountActivity(opp){'); }
  catch(e){ threw = true; assert(/not found/.test(e.message), `extractRange missing start marker: clear error (got "${e.message}")`); }
  assert(threw, 'extractRange missing start marker: throws rather than silently extracting from the wrong place');

  const synthetic = `function repeatedMarker(a){\n  return a;\n}\nfunction repeatedMarker(a){\n  return a;\n}\nfunction endHere(z){\n  return z;\n}\n`;
  let threw2 = false;
  try { extractRange(synthetic, 'function repeatedMarker(a){', 'function endHere(z){'); }
  catch(e){ threw2 = true; assert(/AMBIGUOUS/.test(e.message), `extractRange ambiguous start marker: clear error (got "${e.message}")`); }
  assert(threw2, 'extractRange ambiguous start marker: throws rather than silently picking one occurrence');
}

// ===========================================================================
// findMatchingBracket() direct unit checks -- the core primitive everything
// else depends on -- against synthetic adversarial strings.
// ===========================================================================
{
  const s1 = '{ "a": "}", b: `${ { x: 1 } }`, c: /\\}/ }';
  const close1 = findMatchingBracket(s1, 0);
  assert(close1 === s1.length - 1, `findMatchingBracket: correctly skips a "}" inside a string, a nested \${...} object, and a "}" inside a regex literal (got close index ${close1} of ${s1.length - 1})`);

  const s2 = '{ // a comment with a } in it\n  x: 1\n}';
  const close2 = findMatchingBracket(s2, 0);
  assert(s2[close2] === '}' && close2 === s2.length - 1, 'findMatchingBracket: correctly skips a "}" inside a line comment');

  const s3 = '{ /* block } comment */ y: 2 }';
  const close3 = findMatchingBracket(s3, 0);
  assert(s3[close3] === '}' && close3 === s3.length - 1, 'findMatchingBracket: correctly skips a "}" inside a block comment');
}

if(failures > 0){
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
