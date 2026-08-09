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
// isDirectSchedulingClose -> isPermissionBasedConceptOffer -> isGroundedOpener,
// all contiguous.
const GATE_SRC = extractLines('conversation-starter-policy-gate', 5123, 5329, 'function mentionsProductOrMerchOffer(text){');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(GATE_SRC, sandbox);
const { mentionsProductOrMerchOffer, isMeaningfulConversationQuestion, isDirectSchedulingClose, isPermissionBasedConceptOffer, isGroundedOpener } = sandbox;

for (const fn of [mentionsProductOrMerchOffer, isMeaningfulConversationQuestion, isDirectSchedulingClose, isPermissionBasedConceptOffer, isGroundedOpener]) {
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

// ---------------------------------------------------------------------------
// QA correction round 3 (Best Next Question policy refinement): a grounded,
// permission-based concept offer -- traceable to the opportunity's own
// generated activationIdeas/commercialPlay -- is now allowed. Everything
// else the founder listed as still-banned remains banned.
// ---------------------------------------------------------------------------
const DOVER_OPP = {
  account: 'Dover Honda',
  activationIdeas: ['Parade-day team kit', 'Family-focused giveaway bags'],
  commercialPlay: { concept: 'Holiday Parade Sponsorship', narrative: 'Dover Honda is the lead Platinum Sponsor for the 2026 Dover Holiday Parade.' }
};

// Required test 1: a grounded, activation-specific permission ask passes.
const DOVER_GOOD = 'We had a couple ideas for the Holiday Parade, including a parade-day team kit and a family-focused giveaway. Would it be okay if I sent a few concepts over?';
assert(mentionsProductOrMerchOffer(DOVER_GOOD) === true, 'required test 1 sanity: the Dover opener does mention a product/activation ("giveaway"), so it needs the new exception to pass at all');
assert(isPermissionBasedConceptOffer(DOVER_GOOD, DOVER_OPP) === true, 'required test 1: isPermissionBasedConceptOffer() recognizes the grounded, permission-based concept offer');
assert(isGroundedOpener(DOVER_GOOD, DOVER_OPP) === true, 'required test 1: a grounded, activation-specific permission ask passes isGroundedOpener() when it is traceable to the opportunity\'s own generated activationIdeas');

// Founder's alternate phrasing patterns must also pass.
const PATTERN_2 = 'A couple things came to mind for the event, including a parade-day team kit. Okay if I send them your way?';
assert(isGroundedOpener(PATTERN_2, DOVER_OPP) === true, 'required test 1: the "a couple things came to mind... okay if I send them your way?" pattern also passes');
const PATTERN_3 = 'We had an idea around a family-focused giveaway for the parade. Would it be useful if I sent a few concepts?';
assert(isGroundedOpener(PATTERN_3, DOVER_OPP) === true, 'required test 1: the "would it be useful if I sent" pattern also passes');

// Required test 2: generic product pitches still fail, even with a real opp.
const GENERIC_PITCH = 'We can support this with promotional products. Can we schedule a meeting?';
assert(isGroundedOpener(GENERIC_PITCH, DOVER_OPP) === false, 'required test 2: a generic "promotional products" pitch still fails isGroundedOpener() even when the opp has real activationIdeas (no permission-ask shape, and not traceable to a specific idea)');
const GENERIC_MERCH_OFFER = 'This creates a great opportunity for branded merchandise and event giveaways for attendees.';
assert(isGroundedOpener(GENERIC_MERCH_OFFER, DOVER_OPP) === false, 'required test 2: a generic merchandise/service offer with no permission-ask shape still fails');

// Required test 3: scheduling closes still fail, even when otherwise grounded.
const SCHEDULING_WITH_IDEA = 'We had an idea around a parade-day team kit. Can we schedule a quick call to discuss?';
assert(isGroundedOpener(SCHEDULING_WITH_IDEA, DOVER_OPP) === false, 'required test 3: a scheduling close ("can we schedule a quick call") still fails isGroundedOpener() even when it references a real activation idea');
const MEET_15_MIN = 'Would it be okay if I sent a few concepts? Can we meet for 15 minutes next week?';
assert(isGroundedOpener(MEET_15_MIN, DOVER_OPP) === false, 'required test 3: "Can we meet for 15 minutes?" still fails even alongside a genuine permission-ask sentence');

// Required test 4: unsupported/invented activation references still fail.
const INVENTED_IDEA = 'We had an idea around branded umbrellas for the parade. Would it be okay if I sent a few concepts over?';
assert(isPermissionBasedConceptOffer(INVENTED_IDEA, DOVER_OPP) === false, 'required test 4: an invented activation idea ("branded umbrellas") not present in the opp\'s real activationIdeas is not traceable');
assert(isGroundedOpener(INVENTED_IDEA, DOVER_OPP) === false, 'required test 4: isGroundedOpener() rejects the invented-idea permission ask, falling back to the deterministic template instead');
const NO_IDEAS_OPP = { account: 'Thin Evidence Co', activationIdeas: [], commercialPlay: null };
assert(isGroundedOpener(DOVER_GOOD, NO_IDEAS_OPP) === false, 'required test 4: the identical permission-ask phrasing fails for an opportunity with no real activationIdeas at all -- nothing to trace the offer to');
const OLD_SIGNAL_NO_KEYS = { account: 'Legacy Co' };
assert(isGroundedOpener(DOVER_GOOD, OLD_SIGNAL_NO_KEYS) === false, 'required test 4: an old signal with no activationIdeas/commercialPlay keys at all also fails -- the exception never fires without real, traceable ideas');

// Long scripted emails disguised as questions still fail -- the exception
// requires ONE short question, not a paragraph, even when it otherwise has
// the right shape and a real, traceable idea.
const LONG_SCRIPTED = 'Hi there, I hope this finds you well. We had an idea around family-focused giveaways and wanted to reach out because we think this could be a great fit for your organization given everything happening with the parade this year. Would it be okay if I sent a few concepts over for your review at your convenience?';
assert(LONG_SCRIPTED.length > 220, 'sanity: the long-scripted-email fixture exceeds the permission-ask exception\'s length cap');
assert(isPermissionBasedConceptOffer(LONG_SCRIPTED, DOVER_OPP) === false, 'a long scripted paragraph disguised as a permission-ask question is rejected by the length cap, even with the right shape and a real, traceable idea');
assert(isGroundedOpener(LONG_SCRIPTED, DOVER_OPP) === false, 'isGroundedOpener() rejects the long scripted email, falling back to the deterministic template instead');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
