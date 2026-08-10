// Foundation freeze, Phase 3 (Dashboard Test-Harness Stabilization): the ONE
// shared, stable extraction utility for pulling real source text out of
// dashboard/index.html for use in a vm sandbox. Replaces ~28 test files'
// own hand-rolled extractFn()/extractBlock()/extractRaw()/extractLines()
// copies, every one of which located its target by an ABSOLUTE PHYSICAL
// LINE NUMBER -- meaning an ordinary, unrelated edit anywhere earlier in
// this 12,000+ line file (adding a comment, a new function, a bug fix) could
// silently shift every later line number and break tests that have nothing
// to do with the edit. Confirmed repeatedly, not hypothetically: Foundation
// Freeze Phase 1 added ~15 lines and required repairing ~380 call sites
// across 27 files; Phase 2 added ~35 lines and required ~40 more repairs
// across 25 files.
//
// This module locates code by SEMANTIC STRUCTURE instead: a function/const/
// let declaration is found by searching for its own name, not by trusting a
// number that has no relationship to the code once anything above it
// changes. Adding, deleting, or moving lines ABOVE a target has zero effect
// on finding it.
//
// Design: brace-aware scanning, not a full JS parser. A minimal, deliberately
// narrow tokenizer (skipTrivia() below) is the only thing standing between
// "brace-aware" and "silently wrong": it must correctly step over string
// literals, template literals (including nested ${...} expressions, which
// can themselves contain arbitrary braces), line/block comments, and regex
// literals (which can contain '{', '}', '(', ')' that must never be counted
// as real brackets -- e.g. /\d{4}/ or /(foo|bar)/, both real patterns
// already present in dashboard/index.html). A full parser (e.g. Acorn) was
// considered and rejected: this file's actual syntax (plain function
// declarations, no arrow-function-at-top-level, no JSX/TS) is simple enough
// that a careful scanner is safe and needs no new dependency -- see
// scripts/test-dashboard-extract-lib.js for direct proof against every one
// of these shapes, including deliberately adversarial regex/template cases.
//
// Exports:
//   loadDashboardSource() -> the raw dashboard/index.html text (read once,
//     memoized) -- callers extract from it directly rather than re-reading
//     the file themselves.
//   extractFn(source, name) -> the exact, verbatim source text of the named
//     top-level function/const/let declaration (whichever it turns out to
//     be -- callers only need to know its NAME, not its shape). Throws a
//     specific, actionable error if not found, or if the name is genuinely
//     ambiguous (found more than once) -- never silently returns the wrong
//     one.
//   extractRange(source, startMarker, endMarker) -> the exact source text
//     from startMarker's own declaration through endMarker's own
//     declaration, inclusive of both, for the rare case a test genuinely
//     needs several adjacent functions/module-level blocks as one
//     contiguous unit (e.g. because they reference each other via shared
//     top-level `let` state). Both markers must be unique, literal
//     substrings that begin a real declaration (function/async function/
//     window.NAME=function/const/let) -- this is a deliberate constraint,
//     not a limitation: it keeps the boundary of "what's included"
//     unambiguous and machine-checked, rather than a second flavor of magic
//     numbers wearing a string costume.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', '..', 'dashboard', 'index.html');

let cachedSource = null;
export function loadDashboardSource(){
  if(cachedSource === null) cachedSource = readFileSync(DASHBOARD_PATH, 'utf8');
  return cachedSource;
}

// Keywords after which a following `/` is a regex literal, not division --
// e.g. `return /foo/.test(x)`, `case /foo/:`. Deliberately not exhaustive of
// every ECMAScript keyword; scoped to the ones that can plausibly precede a
// regex literal in this codebase's actual style.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'instanceof', 'yield', 'else', 'do'
]);

function isRegexStart(source, slashIndex){
  let i = slashIndex - 1;
  while(i >= 0 && /\s/.test(source[i])) i--;
  if(i < 0) return true;
  const ch = source[i];
  if(/[a-zA-Z0-9_$)\]]/.test(ch)){
    if(/[a-zA-Z0-9_$]/.test(ch)){
      let j = i;
      while(j >= 0 && /[a-zA-Z0-9_$]/.test(source[j])) j--;
      const word = source.slice(j + 1, i + 1);
      return REGEX_PRECEDING_KEYWORDS.has(word);
    }
    return false; // ends with ')' or ']' -- division, not regex
  }
  return true; // any other punctuation (or start-of-source) expects an expression next
}

// Given `source` and an index `i` that may be the start of "trivia" (a line
// comment, block comment, string literal, template literal -- including
// nested ${...} expressions -- or regex literal), returns the index just
// past that trivia, or `i` unchanged if nothing there needs skipping. This
// is the single piece of logic that keeps bracket-depth counting from being
// corrupted by a brace/paren/bracket character that only LOOKS like a real
// one because it is actually inside text content.
function skipTrivia(source, i){
  const ch = source[i];
  if(ch === '/' && source[i + 1] === '/'){
    const nl = source.indexOf('\n', i);
    return nl === -1 ? source.length : nl;
  }
  if(ch === '/' && source[i + 1] === '*'){
    const end = source.indexOf('*/', i + 2);
    if(end === -1) throw new Error(`skipTrivia: unterminated block comment starting at index ${i}`);
    return end + 2;
  }
  if(ch === '\'' || ch === '"'){
    const quote = ch;
    let j = i + 1;
    while(j < source.length && source[j] !== quote){
      j += (source[j] === '\\') ? 2 : 1;
    }
    if(j >= source.length) throw new Error(`skipTrivia: unterminated string literal starting at index ${i}`);
    return j + 1;
  }
  if(ch === '`'){
    let j = i + 1;
    while(j < source.length){
      if(source[j] === '\\'){ j += 2; continue; }
      if(source[j] === '`') return j + 1;
      if(source[j] === '$' && source[j + 1] === '{'){
        const closeBrace = findMatchingBracket(source, j + 1);
        j = closeBrace + 1;
        continue;
      }
      j++;
    }
    throw new Error(`skipTrivia: unterminated template literal starting at index ${i}`);
  }
  if(ch === '/' && source[i + 1] !== '/' && source[i + 1] !== '*' && isRegexStart(source, i)){
    let j = i + 1;
    let inCharClass = false;
    while(j < source.length){
      if(source[j] === '\\'){ j += 2; continue; }
      if(source[j] === '['){ inCharClass = true; j++; continue; }
      if(source[j] === ']'){ inCharClass = false; j++; continue; }
      if(source[j] === '\n') throw new Error(`skipTrivia: unterminated regex literal starting at index ${i}`);
      if(source[j] === '/' && !inCharClass){ j++; break; }
      j++;
    }
    while(j < source.length && /[a-z]/i.test(source[j])) j++; // regex flags
    return j;
  }
  return i;
}

// Returns the index of the bracket matching the one at `openIndex`
// (source[openIndex] must be '(', '{', or '['), skipping over any trivia
// (strings/templates/comments/regexes) encountered along the way so
// bracket-like characters inside them are never counted.
export function findMatchingBracket(source, openIndex){
  const OPEN = source[openIndex];
  const CLOSE = { '(': ')', '{': '}', '[': ']' }[OPEN];
  if(!CLOSE) throw new Error(`findMatchingBracket: character "${OPEN}" at index ${openIndex} is not an opening bracket`);
  let depth = 0;
  let i = openIndex;
  while(i < source.length){
    const skipped = skipTrivia(source, i);
    if(skipped !== i){ i = skipped; continue; }
    const ch = source[i];
    if(ch === OPEN) depth++;
    else if(ch === CLOSE){
      depth--;
      if(depth === 0) return i;
    }
    i++;
  }
  throw new Error(`findMatchingBracket: no matching "${CLOSE}" found for "${OPEN}" at index ${openIndex}`);
}

// Declaration patterns this codebase actually uses (verified directly
// against dashboard/index.html -- no arrow-function-at-top-level exists, so
// none is supported; adding one is a small, isolated change here if that
// ever changes). Each pattern's regex captures up to and including the
// opening character that begins the VALUE (a function's parameter-list `(`,
// or the character immediately after a const/let's `=`).
// [ \t]* (not just ^) so a declaration indented inside dashboard/index.html's
// second inline <script> (the Manage Customer Accounts modal's own IIFE) is
// still recognized as its own top-level declaration within that scope --
// confirmed necessary: e.g. `let cachedLists=[];` is indented one space.
const DECLARATION_PATTERNS = [
  { kind: 'function', re: /^[ \t]*(?:async\s+)?function\s+NAME\s*\(/m },
  { kind: 'function', re: /^[ \t]*window\.NAME\s*=\s*(?:async\s+)?function\s*\(/m },
  { kind: 'value', re: /^[ \t]*(?:const|let)\s+NAME\s*=\s*/m }
];

function findDeclarationMatches(source, name){
  const matches = [];
  for(const { kind, re } of DECLARATION_PATTERNS){
    const pattern = new RegExp(re.source.replace('NAME', name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'gm');
    let m;
    while((m = pattern.exec(source)) !== null){
      // The declaration text itself starts at the first non-whitespace
      // character of the match, not at the leading [ \t]* the pattern also
      // captured (needed for indentation tolerance, see DECLARATION_PATTERNS).
      const leadingWs = m[0].length - m[0].trimStart().length;
      matches.push({ kind, index: m.index + leadingWs, matchEnd: m.index + m[0].length });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  return matches;
}

// Given the index just after a declaration's opening token (e.g. right
// after `function foo(` 's own `(`, or right after `const FOO = ` 's `=`),
// determines and returns the end index (exclusive) of that ENTIRE
// declaration -- function body close, object/array literal close, or a
// primitive/expression's terminating top-level `;` -- plus a trailing `;`
// when one immediately follows (the `window.NAME = function(){...};` shape).
function findDeclarationEnd(source, kind, matchEnd){
  if(kind === 'function'){
    const openParen = matchEnd - 1;
    const closeParen = findMatchingBracket(source, openParen);
    let i = closeParen + 1;
    while(/\s/.test(source[i])) i++;
    if(source[i] !== '{') throw new Error(`findDeclarationEnd: expected "{" to open the function body at index ${i}, found "${source[i]}"`);
    const closeBrace = findMatchingBracket(source, i);
    let end = closeBrace + 1;
    if(source[end] === ';') end++;
    return end;
  }
  // kind === 'value': const/let NAME = <value>
  let i = matchEnd;
  while(/\s/.test(source[i])) i++;
  if(source[i] === '{' || source[i] === '['){
    const close = findMatchingBracket(source, i);
    let end = close + 1;
    if(source[end] === ';') end++;
    return end;
  }
  // Primitive/string/template/expression value -- scan to the first
  // top-level ';', respecting any nested brackets the expression itself
  // contains (e.g. a function expression, a ternary, a call).
  let depth = 0;
  while(i < source.length){
    const skipped = skipTrivia(source, i);
    if(skipped !== i){ i = skipped; continue; }
    const ch = source[i];
    if(ch === '(' || ch === '{' || ch === '[') depth++;
    else if(ch === ')' || ch === '}' || ch === ']') depth--;
    else if(ch === ';' && depth === 0) return i + 1;
    else if(ch === '\n' && depth === 0){
      // No semicolon on this line and nothing left open -- treat end of
      // line as the statement end (covers the rare ASI-reliant one-liner).
      return i;
    }
    i++;
  }
  throw new Error('findDeclarationEnd: reached end of source looking for a terminating ";" for a const/let value');
}

// extractFn(source, name): the exact, verbatim source text of the named
// top-level function or const/let declaration. Throws if not found, or if
// more than one top-level declaration of that name exists (ambiguous --
// never silently picks one).
export function extractFn(source, name){
  const matches = findDeclarationMatches(source, name);
  if(matches.length === 0){
    throw new Error(`extractFn(${name}): no top-level function/const/let declaration named "${name}" found in the given source -- it may have been renamed, removed, or is not declared at the top level.`);
  }
  if(matches.length > 1){
    throw new Error(`extractFn(${name}): AMBIGUOUS -- found ${matches.length} top-level declarations named "${name}" (at character offsets ${matches.map(m => m.index).join(', ')}). extractFn() refuses to silently guess; use extractRange() with more specific markers, or make the name unique.`);
  }
  const { kind, index, matchEnd } = matches[0];
  const end = findDeclarationEnd(source, kind, matchEnd);
  return source.slice(index, end);
}

// startMarker must be GLOBALLY unique: it is the sole anchor establishing
// which occurrence of this text is meant, with no other reference point to
// disambiguate by.
function findUniqueStartMarker(source, marker){
  const first = source.indexOf(marker);
  if(first === -1){
    throw new Error(`extractRange: startMarker ${JSON.stringify(marker)} not found in the given source.`);
  }
  const second = source.indexOf(marker, first + 1);
  if(second !== -1){
    throw new Error(`extractRange: startMarker ${JSON.stringify(marker)} is AMBIGUOUS -- it appears more than once (at character offsets ${first} and ${second}, at least). Use a longer, unique substring.`);
  }
  return first;
}

// endMarker is the NEAREST occurrence of that text after startMarker --
// deliberately NOT required to be globally unique. This is what makes it
// possible to close a range at e.g. a nested `function close(){` that is a
// perfectly ordinary, repeated name in an unrelated scope elsewhere in a
// 12,000+ line file (dashboard/index.html genuinely has several) -- the
// only thing that matters for "where does this range end" is the first
// match found after where it starts, exactly as a reader scanning forward
// from startMarker would find it.
function findNearestEndMarker(source, marker, searchFrom){
  const index = source.indexOf(marker, searchFrom);
  if(index === -1){
    throw new Error(`extractRange: endMarker ${JSON.stringify(marker)} not found anywhere after startMarker (searching from character offset ${searchFrom}).`);
  }
  return index;
}

function declarationKindAt(source, index){
  // Declarations may be indented (see DECLARATION_PATTERNS' comment) -- find
  // the start of the line containing `index` so the sticky match below can
  // consume the same leading [ \t]* the patterns allow for, then confirm
  // the declaration's own non-whitespace start lands exactly on `index`
  // (i.e. `index` really is the declaration's start, not some later
  // position on the same line).
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  for(const { kind, re } of DECLARATION_PATTERNS){
    const anchored = new RegExp(re.source.replace('NAME', '[A-Za-z_$][A-Za-z0-9_$]*').replace(/^\^/, ''), 'y');
    anchored.lastIndex = lineStart;
    const m = anchored.exec(source);
    if(m && m.index === lineStart){
      const leadingWs = m[0].length - m[0].trimStart().length;
      if(lineStart + leadingWs === index) return { kind, matchEnd: lineStart + m[0].length };
    }
  }
  return null;
}

// extractRange(source, startMarker, endMarker): the exact source text from
// startMarker's own declaration through the NEAREST endMarker declaration
// found after it, inclusive of both. startMarker must be a globally unique,
// literal substring beginning a real top-level declaration (function/async
// function/window.NAME=function/const/let). endMarker must begin the SAME
// kind of real declaration wherever its nearest occurrence after startMarker
// falls, but is deliberately NOT required to be globally unique -- a name
// like `close` genuinely repeats across unrelated nested scopes in a file
// this size, and "the next one after start" is an unambiguous, well-defined
// target without demanding uniqueness across the entire file.
export function extractRange(source, startMarker, endMarker){
  const startIndex = findUniqueStartMarker(source, startMarker);
  const startDecl = declarationKindAt(source, startIndex);
  if(!startDecl){
    throw new Error(`extractRange: startMarker ${JSON.stringify(startMarker)} was found, but does not begin a recognized declaration (function/async function/window.NAME=function/const/let) at that exact position -- extractRange() requires both markers to mark real declaration starts, not arbitrary text.`);
  }
  const endIndex = findNearestEndMarker(source, endMarker, startIndex + startMarker.length);
  const endDecl = declarationKindAt(source, endIndex);
  if(!endDecl){
    throw new Error(`extractRange: endMarker ${JSON.stringify(endMarker)} was found, but does not begin a recognized declaration (function/async function/window.NAME=function/const/let) at that exact position -- extractRange() requires both markers to mark real declaration starts, not arbitrary text.`);
  }
  const end = findDeclarationEnd(source, endDecl.kind, endDecl.matchEnd);
  return source.slice(startIndex, end);
}

// extractStatementAfter(source, afterIndex, marker): for the rare top-level
// statement with no name to look up by (e.g. a bare
// `document.addEventListener('click', ...)` call wiring a delegated
// listener) -- finds the NEAREST occurrence of `marker` at or after
// `afterIndex` and extracts through the end of that one statement (its
// outermost call's matching closing paren, plus a trailing ';' if one
// immediately follows). `afterIndex` is meant to be the end of a preceding,
// name-based extraction (extractFn()'s return value's own length added to
// its start, or simply `source.indexOf(extractFn(source, 'someEarlierFn'))
// + extractFn(...).length`) -- i.e. "immediately after this already-proven
// point," never a bare line-derived number.
export function extractStatementAfter(source, afterIndex, marker){
  const start = source.indexOf(marker, afterIndex);
  if(start === -1){
    throw new Error(`extractStatementAfter: marker ${JSON.stringify(marker)} not found at or after character offset ${afterIndex}.`);
  }
  const openParen = source.indexOf('(', start);
  if(openParen === -1 || /[;{}]/.test(source.slice(start, openParen))){
    throw new Error(`extractStatementAfter: marker ${JSON.stringify(marker)} was found, but no call "(" immediately belonging to it follows -- this helper only supports a single bare function-call statement.`);
  }
  const closeParen = findMatchingBracket(source, openParen);
  let end = closeParen + 1;
  if(source[end] === ';') end++;
  return source.slice(start, end);
}
