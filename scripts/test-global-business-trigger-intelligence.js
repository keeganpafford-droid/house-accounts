// Global Business Trigger Intelligence sprint.
//
// Founder brief: "NO GROUNDED ACTIVATION -> NO PRIORITY" must hold for
// every weak-by-default signal family the model is likely to see, not just
// the confirmed funding/earnings case (Neural Trust/Black Hat) the previous
// sprint fixed. Live QA showed the deterministic "confident but manufactured
// activation" gate (formerly isFinancialEventDressedAsActivation(), scoped
// to WEAK_EVENT_ANCHOR/FINANCIAL_EVENT_ANCHOR matching only funding/earnings
// language) let the exact same confidently-worded fabrication through for
// acquisition, leadership-appointment, and facility-opening/relocation
// signals -- a play whose entire content was the bare event category plus a
// generic campaign/visibility noun, with no real audience or moment named,
// was correctly flagged for funding but NOT for these other three families.
//
// This file proves three things directly, at the UNIT level (not just via
// the opportunity pipeline, which scripts/test-held-out-blind-evaluation.js
// already covers end to end):
//   1. The widened gate (isGenericCommercialPlay()/isGenericActivationIdea(),
//      api/signal-intelligence.js) now catches the confident-fabrication
//      shape across all four weak-by-default families, while continuing to
//      pass every genuinely grounded narrative the prior sprint's suite
//      already established as strong.
//   2. The client-side mirror (dashboard/index.html's identically-named
//      isGenericCommercialPlay()) produces IDENTICAL results to the
//      server-side version for the same inputs -- the two are independently
//      maintained copies (see this sprint's architecture audit), so proving
//      they agree is the only way to know a fix applied to one file didn't
//      silently diverge from the other.
//   3. The one named development-account reference that was living inside
//      the LIVE production prompt (api/signal-intelligence.js's
//      COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT, previously "Impiricus" as a
//      FACT/UNSUPPORTED-ASSUMPTION illustration) is gone, and the fragment
//      now carries archetype-level guidance for acquisition/leadership/
//      facility signals structurally parallel to its existing funding
//      guidance.
//
// Usage: node scripts/test-global-business-trigger-intelligence.js
import { isGenericCommercialPlay as serverIsGenericCommercialPlay, isGenericActivationIdea, COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT } from '../api/signal-intelligence.js';
import vm from 'vm';
import { extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// 1. Unit-level: the widened gate catches confident fabrication across all
//    four weak-by-default families, and never regresses on strong, grounded
//    narratives for the same families.
// ===========================================================================
const WEAK_CONFIDENT_FABRICATIONS = [
  ['funding', 'Raising a Series A is a great opportunity to run a brand visibility campaign celebrating the round.'],
  ['acquisition', 'Acquiring a regional competitor creates a great opportunity to run a brand visibility campaign celebrating the milestone.'],
  ['leadership (VP)', 'The new VP of Marketing is a great moment to launch a comprehensive rebrand for the company.'],
  ['leadership (appointed)', 'Appointed as CMO, this is a great opportunity to run a brand awareness campaign.'],
  ['facility opening', 'The new facility opening is a great opportunity to run a brand visibility campaign for the grand opening.']
];
for(const [family, narrative] of WEAK_CONFIDENT_FABRICATIONS){
  assert(serverIsGenericCommercialPlay(narrative) === true, `required property (${family}): a confidently-phrased, event-category-only narrative with no real audience/moment is caught as generic (got false for "${narrative}")`);
}

const STRONG_GROUNDED_NARRATIVES = [
  ['acquisition', 'Create a welcome/integration moment for the incoming drivers and dispatch staff as they join the fleet operations.'],
  ['facility opening', 'Use the move to a larger office as a reason to create an opening-day moment for staff and the patients visiting the new location for the first time.'],
  ['leadership', 'A newly hired Chief Growth Officer likely wants an early, visible internal win -- a team culture refresh or client-facing rollout gives them a fast, tangible first move.'],
  ['sponsorship', 'Turn the title sponsorship into a visible finish-line presence for the volunteers and runners crossing the line, not just a banner with the company\'s name on it.'],
  ['funding + disclosed initiative', 'The Series B is earmarked for doubling the field engineering team -- a reason to build a welcome moment for the new engineers joining over the next two quarters.']
];
for(const [family, narrative] of STRONG_GROUNDED_NARRATIVES){
  assert(serverIsGenericCommercialPlay(narrative) === false, `required property (${family}): a genuinely grounded narrative naming a real audience/moment is never flagged generic (regression check; got true for "${narrative}")`);
}

const WEAK_CONFIDENT_IDEAS = [
  ['funding', 'Series A celebration launch kit'],
  ['acquisition', 'Acquisition celebration launch kit'],
  ['leadership', 'New VP brand awareness campaign'],
  ['facility (bare)', 'Uniforms'],
  ['facility (bare, signage)', 'Signage']
];
for(const [family, idea] of WEAK_CONFIDENT_IDEAS){
  assert(isGenericActivationIdea(idea) === true, `required property (${family}): the bare/dressed-up idea "${idea}" is filtered`);
}

const STRONG_QUALIFIED_IDEAS = [
  ['facility, qualified', 'Staff opening-day polos'],
  ['acquisition, qualified', 'Welcome kit for new drivers'],
  ['sponsorship, qualified', 'Finish-line volunteer vests']
];
for(const [family, idea] of STRONG_QUALIFIED_IDEAS){
  assert(isGenericActivationIdea(idea) === false, `required property (${family}): a specific, qualified idea using otherwise-generic words is never filtered (regression check; got true for "${idea}")`);
}

console.log('');

// ===========================================================================
// 2. Server/client parity: dashboard/index.html's mirrored isGenericCommercialPlay()
//    must agree with the server-side version on every case above -- these
//    are two independently-maintained, byte-should-be-identical copies (see
//    this sprint's architecture audit), so a fix applied only to one file
//    is exactly the kind of silent-drift bug this proves didn't happen.
// ===========================================================================
{
  const DASHBOARD_SRC = loadDashboardSource();
  const SRC = extractRange(DASHBOARD_SRC, 'const GENERIC_COMMERCIAL_PLAY_HEDGE', 'function getLegacyNarrativeForEligibility(opp){');
  const sandbox = { console };
  vm.createContext(sandbox);
  new vm.Script(`${SRC}\nthis.__isGenericCommercialPlay = isGenericCommercialPlay;`, { filename: 'gbti-client-parity.js' }).runInContext(sandbox);
  const clientIsGenericCommercialPlay = sandbox.__isGenericCommercialPlay;

  const ALL_CASES = [...WEAK_CONFIDENT_FABRICATIONS, ...STRONG_GROUNDED_NARRATIVES];
  for(const [family, narrative] of ALL_CASES){
    const serverResult = serverIsGenericCommercialPlay(narrative);
    const clientResult = clientIsGenericCommercialPlay(narrative);
    assert(serverResult === clientResult, `required property (server/client parity, ${family}): dashboard/index.html's isGenericCommercialPlay() agrees with api/signal-intelligence.js's version (server=${serverResult}, client=${clientResult}, narrative="${narrative}")`);
  }
}

console.log('');

// ===========================================================================
// 3. Named-example audit: the live production prompt no longer references
//    "Impiricus" (or any other named development/QA account), and now
//    carries generalized guidance for acquisition/leadership/facility
//    signals structurally parallel to its existing funding guidance.
// ===========================================================================
{
  const NAMED_DEV_ACCOUNTS = ['Impiricus', 'Dover Honda', 'Gallagher', 'Avidia', 'Kiniksa', 'Neural Trust', 'Brightview', 'Ridgeline', 'Meridian', 'Hannaford', 'Amoskeag', 'Northern Pool'];
  const leaked = NAMED_DEV_ACCOUNTS.filter(name => COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT.includes(name));
  assert(leaked.length === 0, `required property: the live COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT contains no named development/QA account references (leaked: ${leaked.join(', ') || 'none'})`);
  assert(/UNSUPPORTED ASSUMPTION/.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'sanity: the FACT/INFERENCE/UNSUPPORTED ASSUMPTION discipline is still present after genericizing its examples');
  assert(/acquisition/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT) && /leadership appointment/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT) && /facility opening or relocation/i.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'required property: the prompt now names acquisition/leadership/facility explicitly as weak-by-default families alongside funding, not just funding');
  assert(/NO GROUNDED ACTIVATION, NO PRIORITY/.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT.slice(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT.indexOf('SAME'))) || /SAME "NO GROUNDED ACTIVATION/.test(COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT), 'required property: the "NO GROUNDED ACTIVATION, NO PRIORITY" standard is explicitly generalized beyond funding in the live prompt text');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
