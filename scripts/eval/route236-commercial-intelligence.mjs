// product/commercial-opportunity-intelligence -- Route 236 qualitative
// evaluation harness.
//
// IMPORTANT, read before adding cases: this harness evaluates REASONING
// QUALITY (does the output feel like a smart merch strategist, or a
// generic list of swag attached to irrelevant news?), which is a judgment
// call about real LLM output, not something a script can grade by itself.
// This file does two honest, distinct things:
//
//   1. Runs each case's fixture through the REAL, production
//      normalizeCommercialIntelligence() (api/signal-intelligence.js) --
//      proving the SCHEMA/PLUMBING correctly carries a well-formed
//      commercial-interpretation payload through to a usable shape. This is
//      a plumbing check, not a reasoning-quality check.
//   2. Prints each case's evidence + expected-quality fixture next to the
//      six grading questions, formatted for a human (the founder, in a real
//      Preview QA pass with live OpenAI access) to actually judge the live
//      model's real output against -- this script cannot call OpenAI itself
//      and does not claim to grade reasoning quality on its own.
//
// Per explicit instruction: Route 236 companies/facts may live ONLY in this
// benchmark fixture file, never in production prompts or logic (confirmed:
// grep -ri "northern pool\|eliot veterinary\|true enterprises\|207 tavern\|haffner\|maine pet supply\|national wrecker" api/ dashboard/ returns nothing).
//
// Usage: node scripts/eval/route236-commercial-intelligence.mjs
import { normalizeCommercialIntelligence } from '../../api/signal-intelligence.js';

const GRADING_QUESTIONS = [
  'Did it correctly understand the real signal?',
  'Did it find a commercially useful play?',
  'Are ideas specific to this company/event?',
  'Did it recognize recurring/expansion potential when evidence warrants it?',
  'Is Best Next Question useful?',
  'Would a working salesperson immediately understand why this account is interesting?'
];

// ===========================================================================
// CASE 1 -- Northern Pool & Spa (canonical standard). Real facts as given
// directly by the founder: founded 1976 (2026 = 50th anniversary), and
// became connected with the larger Azureon organization.
// ===========================================================================
const NORTHERN_POOL_AND_SPA = {
  company: 'Northern Pool & Spa',
  evidence: {
    whatChanged: 'Northern Pool & Spa was founded in 1976, making 2026 its 50th anniversary. The company also became connected with the larger Azureon organization.',
    canonicalEventType: 'EVENT_AWARD', // anniversary bucket in today's classifier
    sourceNote: 'Founder-supplied fact, not independently re-sourced here.'
  },
  // The "gold" quality bar -- a well-behaved model's output, per the
  // founder's own worked example in the sprint brief. This is a FIXTURE
  // (a stand-in for what a good live response looks like), not a template
  // the production prompt is instructed to reproduce verbatim.
  goldFixture: {
    commercialPlay: {
      concept: '50 Summers',
      narrative: 'Use the anniversary as a reason to create a limited collection celebrating 50 summers of backyard memories -- built around the emotional territory Northern owns (pools, summer, family, backyards, longevity) rather than generic "50th anniversary merchandise."'
    },
    activationIdeas: [
      'Premium pool/beach towels',
      'Heritage hats',
      'Installer/team workwear',
      'Customer cooler kits',
      'Limited commemorative piece',
      'Employee anniversary gifts'
    ],
    expansionPotential: {
      narrative: 'This could become more than a one-time anniversary order -- Northern appears to have recurring needs around field apparel, technicians, seasonal hiring, and customer completion gifts, and its Azureon relationship may create a route into a larger organization if merchandise or employee programs are centralized.',
      tags: ['recurring-program', 'parent-org-route']
    },
    bestNextQuestion: 'Are merchandise and employee gear still handled here, or has any of that moved to Azureon?'
  },
  gradingNotes: {
    'Did it correctly understand the real signal?': 'Yes -- both the 50th anniversary and the Azureon relationship are stated as facts, not conflated with interpretation.',
    'Did it find a commercially useful play?': 'Yes -- "50 Summers" is a concrete, ownable concept, not a restatement of "celebrating an anniversary."',
    'Are ideas specific to this company/event?': 'Yes -- towels/heritage hats/cooler kits are pool-and-summer-specific, not generic apparel/drinkware/giveaways.',
    'Did it recognize recurring/expansion potential when evidence warrants it?': 'Yes -- recurring-program (field apparel/seasonal hiring) and parent-org-route (Azureon) are both grounded in the stated facts, not invented.',
    'Is Best Next Question useful?': 'Yes -- it directly probes centralization/ownership (does Azureon now own this decision?), the single most useful thing to learn next.',
    'Would a working salesperson immediately understand why this account is interesting?': 'Yes -- this is the founder\'s own real-world standard for this account.'
  }
};

// ===========================================================================
// CASES 2-5 -- NOT POPULATED. The founder named these Route 236 accounts as
// the reasoning-pattern examples to draw from (acquisition/integration,
// hiring/growth, event/sponsorship, and a deliberately weak/thin-evidence
// control), but no real facts about any of them exist anywhere in this
// repository, this conversation, or any fixture/doc searched (confirmed via
// repo-wide grep for each name -- zero matches). Per explicit instruction
// ("if you lack enough grounded Route 236 facts... tell me exactly what
// founder input you need rather than fabricating the signal"), these are
// left as placeholders naming exactly what is needed, not invented content.
// ===========================================================================
const NEEDS_FOUNDER_INPUT = [
  {
    reasoningPattern: 'Acquisition / integration',
    company: 'candidate: one of JAR, WSP, National Wrecker, or another Route 236 account that was acquired or acquired another company',
    needed: 'The actual company, what was acquired/by whom, and approximately when -- so activationIdeas can be judged for whether they correctly propose an integration/new-team/brand-alignment play rather than generic swag.'
  },
  {
    reasoningPattern: 'Hiring / growth',
    company: 'candidate: True Enterprises, Maine Pet Supply, or another Route 236 account with a real hiring/expansion signal',
    needed: 'The actual company and what the real hiring/expansion signal was (new location, headcount growth, a specific posted initiative) -- so expansionPotential can be judged for correctly tagging employee-program/recurring-program rather than forcing a category.'
  },
  {
    reasoningPattern: 'Event / sponsorship',
    company: 'candidate: 207 Tavern or another Route 236 account with a real community/event signal',
    needed: 'The actual event/sponsorship and what is publicly known about it -- so the harness can judge whether activation ideas stay grounded in the event\'s real scale rather than manufacturing an elaborate campaign from thin evidence.'
  },
  {
    reasoningPattern: 'Deliberately weak/thin-evidence control',
    company: 'candidate: Eliot Veterinary Hospital, Haffner\'s, or any Route 236 account with genuinely thin public evidence',
    needed: 'A real example of a signal the founder judged too weak to build a credible play from in actual selling -- the PASS condition here is the model declining to manufacture commercialPlay/activationIdeas, so this case specifically needs an account where the founder can confirm "there was no real play here" as ground truth.'
  }
];

// ===========================================================================
// Runner
// ===========================================================================
let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

console.log('='.repeat(79));
console.log('CASE 1: Northern Pool & Spa (canonical, fully grounded)');
console.log('='.repeat(79));
console.log(`Evidence: ${NORTHERN_POOL_AND_SPA.evidence.whatChanged}`);
console.log('');

// Plumbing check: the gold fixture, expressed as raw "model output" shape,
// survives normalizeCommercialIntelligence() intact and ungenericized.
const normalized = normalizeCommercialIntelligence({
  commercialPlay: NORTHERN_POOL_AND_SPA.goldFixture.commercialPlay,
  activationIdeas: NORTHERN_POOL_AND_SPA.goldFixture.activationIdeas,
  expansionPotential: NORTHERN_POOL_AND_SPA.goldFixture.expansionPotential
});
assert(normalized.commercialPlay && normalized.commercialPlay.concept === '50 Summers', 'plumbing: the gold commercialPlay concept survives normalization unchanged');
assert(normalized.activationIdeas.length === NORTHERN_POOL_AND_SPA.goldFixture.activationIdeas.length, `plumbing: all ${NORTHERN_POOL_AND_SPA.goldFixture.activationIdeas.length} gold activation ideas survive normalization (none flagged as generic filler)`);
assert(normalized.expansionPotential && normalized.expansionPotential.tags.includes('recurring-program') && normalized.expansionPotential.tags.includes('parent-org-route'), 'plumbing: both gold expansion tags survive normalization');

console.log('');
console.log('Qualitative grading (for human judgment against REAL live model output, not this script):');
for (const q of GRADING_QUESTIONS) {
  console.log(`  - ${q}`);
  console.log(`    ${NORTHERN_POOL_AND_SPA.gradingNotes[q]}`);
}

console.log('');
console.log('='.repeat(79));
console.log('CASES 2-5: awaiting real founder input (not fabricated)');
console.log('='.repeat(79));
for (const c of NEEDS_FOUNDER_INPUT) {
  console.log(`- ${c.reasoningPattern} (${c.company})`);
  console.log(`  NEEDED: ${c.needed}`);
}

console.log('');
console.log(failures ? `\n${failures} PLUMBING FAILURE(S)` : '\nPlumbing check: ALL PASS (reasoning-quality grading above requires human judgment against live model output)');
if (failures) process.exitCode = 1;
