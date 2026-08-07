// Regression test for the Conversation Starter policy-gate hardening
// (reproduced production case: a Gallagher acquisition opportunity's
// rendered Conversation Starter was "This could create opportunities for
// onboarding kits and marketing materials for the new services. Can we
// schedule a time to discuss?" -- a direct product pitch plus a
// meeting-progression close, neither of which the pre-existing gate
// caught).
//
// Extracts the real, verbatim gate functions from dashboard/index.html
// (mentionsProductOrMerchOffer, isMeaningfulConversationQuestion,
// isDirectSchedulingClose, isGroundedOpener) into a vm sandbox and calls
// them for real -- this is a hardcoded contiguous line range; if
// dashboard/index.html changes shape, extractLines() below throws instead
// of silently testing stale/wrong code.
//
// Usage: node scripts/test-conversation-starter-policy-gate.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const DASHBOARD_SRC = readFileSync(DASHBOARD_PATH, 'utf8');
const LINES = DASHBOARD_SRC.split('\n');

function extractLines(label, startLine, endLine, expectedFirst) {
  const first = LINES[startLine - 1];
  if (!first || !first.startsWith(expectedFirst)) {
    throw new Error(`extractLines(${label}): dashboard/index.html line ${startLine} is "${first}", expected to start with "${expectedFirst}" -- source has shifted, update the line range in this test.`);
  }
  return LINES.slice(startLine - 1, endLine).join('\n');
}

// mentionsProductOrMerchOffer -> isMeaningfulConversationQuestion ->
// isDirectSchedulingClose -> isGroundedOpener, all contiguous.
const GATE_SRC = extractLines('conversation-starter-policy-gate', 4995, 5122, 'function mentionsProductOrMerchOffer(text){');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(GATE_SRC, sandbox);
const { mentionsProductOrMerchOffer, isMeaningfulConversationQuestion, isDirectSchedulingClose, isGroundedOpener } = sandbox;

for (const fn of [mentionsProductOrMerchOffer, isMeaningfulConversationQuestion, isDirectSchedulingClose, isGroundedOpener]) {
  assert(typeof fn === 'function', `extraction produced a real function (${fn && fn.name})`);
}

// ---------------------------------------------------------------------------
// 1. The exact reproduced production violation must now be rejected.
// ---------------------------------------------------------------------------
const REPRODUCED_VIOLATION = 'I noticed Gallagher recently acquired Wilson M. Beck Insurance Services. This could create opportunities for onboarding kits and marketing materials for the new services. Can we schedule a time to discuss?';
assert(mentionsProductOrMerchOffer(REPRODUCED_VIOLATION) === true, '1) the exact reproduced Gallagher opener is caught by mentionsProductOrMerchOffer()');
assert(isDirectSchedulingClose(REPRODUCED_VIOLATION) === true, '1) the exact reproduced Gallagher opener is caught by isDirectSchedulingClose()');
assert(isGroundedOpener(REPRODUCED_VIOLATION, { account: 'Arthur J. Gallagher' }) === false, '1) isGroundedOpener() rejects the exact reproduced violation');

// ---------------------------------------------------------------------------
// 2. Equivalent product-first framing with DIFFERENT product nouns and a
//    different scheduling phrase must also be rejected -- proving the fix
//    covers the class, not just the literal reproduced phrase.
// ---------------------------------------------------------------------------
const VARIANT_A = 'Saw the new distribution center opening. This could open up a need for branded lanyards and welcome kits for the new hires. Would you like to schedule a call?';
assert(isGroundedOpener(VARIANT_A, { account: 'Acme Corp' }) === false, "2) a wording variant (different noun 'welcome kits'/'lanyards', different close 'would you like to schedule') is also rejected");

const VARIANT_B = "Noticed the acquisition closing. This creates demand for recognition programs across the merged team. Let's set up a time to chat.";
assert(isGroundedOpener(VARIANT_B, { account: 'Acme Corp' }) === false, "2) another variant ('creates demand for'/'recognition programs', 'let's set up a time') is also rejected");

assert(isDirectSchedulingClose('Shall we book a quick meeting to go over it?') === true, '3) "shall we book a quick meeting" is caught as a direct scheduling close');
assert(isDirectSchedulingClose('Would you like to hop on a call sometime?') === true, '3) "would you like to hop on a call" is caught as a direct scheduling close');

// ---------------------------------------------------------------------------
// 4. The known-good Gallagher earnings-call opener (Track B UI validation,
//    confirmed policy-compliant) must still pass -- no regression.
// ---------------------------------------------------------------------------
const KNOWN_GOOD = 'Hey Crystal — saw Gallagher will host a conference call to discuss their second quarter earnings. Is there anything coming up that your team is already planning around?';
assert(mentionsProductOrMerchOffer(KNOWN_GOOD) === false, '4) the known-good earnings-call opener does not trip mentionsProductOrMerchOffer()');
assert(isDirectSchedulingClose(KNOWN_GOOD) === false, '4) the known-good earnings-call opener does not trip isDirectSchedulingClose()');
assert(isGroundedOpener(KNOWN_GOOD, { account: 'Arthur J. Gallagher' }) === true, '4) isGroundedOpener() still accepts the known-good earnings-call opener');

// ---------------------------------------------------------------------------
// 5. Legitimate grounded questions that happen to share a word with the
//    newly-added qualified noun list ("materials", "onboarding") must still
//    pass -- guards against the fix being too broad.
// ---------------------------------------------------------------------------
const CONTROL_1 = 'Are your raw materials sourced locally, or does that vary by region?';
const CONTROL_2 = 'Saw your team posted several safety-technician roles — is that tied to the new plant ramp-up?';
const CONTROL_3 = 'Noticed the new distribution center opening — how is the team handling onboarding for the new hires?';
[CONTROL_1, CONTROL_2, CONTROL_3].forEach((text, i) => {
  assert(mentionsProductOrMerchOffer(text) === false, `5) control ${i + 1} ("${text.slice(0, 40)}...") does not false-positive on mentionsProductOrMerchOffer()`);
  assert(isGroundedOpener(text, { account: 'Acme Corp' }) === true, `5) control ${i + 1} still passes isGroundedOpener() as a legitimate grounded question`);
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
