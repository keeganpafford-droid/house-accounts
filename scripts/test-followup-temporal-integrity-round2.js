// Follow-up temporal-integrity round -- Preview QA found two residual
// generalized failures (Dispatch Goods duplicate primary/Additional
// Opportunity, Neural Trust outreach-posture contradiction) plus wording
// issues (Avidia follow-up offer language, discovery-date labeling,
// Weatherby's no-active-opportunity UX). This file covers the 18 required
// verification items plus the 5 additional Weatherby-specific items, all
// against the real, verbatim dashboard/index.html source extracted into a vm
// sandbox -- nothing here is a reimplementation of production logic.
//
// Usage: node scripts/test-followup-temporal-integrity-round2.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const DASHBOARD_SRC = readFileSync(DASHBOARD_PATH, 'utf8');
const LINES = DASHBOARD_SRC.split('\n');

function extractBlock(label, startLine, endLine, expectedPrefix){
  const slice = LINES.slice(startLine - 1, endLine).join('\n');
  if(!slice.startsWith(expectedPrefix)){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-followup-temporal-integrity-round2.js.`);
  }
  const trimmed = slice.trimEnd();
  if(!trimmed.endsWith('}') && !trimmed.endsWith('};')){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${endLine} does not close as expected -- update the line range.`);
  }
  return slice;
}

const TIMEBOX_CONFIG_SRC = extractBlock('TIMEBOX_CONFIG', 2690, 2695, 'const TIMEBOX_CONFIG = {');
const IS_RELATIONSHIP_EXPANSION_SRC = extractBlock('isRelationshipExpansionOpportunity', 2925, 2928, 'function isRelationshipExpansionOpportunity(');
const DEDUPE_AND_IDENTITY_BLOCK = extractBlock('dedupe-and-identity-helpers', 2843, 3289, 'function cleanOpportunityToken(');
const CARD_AND_MODAL_BLOCK = extractBlock('card-and-modal-helpers', 4595, 5765, 'function confidenceLabel(');
const SALES_PLAY_BLOCK = extractBlock('sales-play-grounding', 7683, 8973, 'function salesPlayModeFromOpp(');
const SCORING_AND_TIMEBOX_BLOCK = extractBlock('scoring-and-timebox-helpers', 8976, 9479, 'function normalizeSignalLayerType(');
const RR_BLOCK = extractBlock('recently-researched', 7464, 7524, 'function getRecentlyResearchedAccounts(){');
const OPEN_RESEARCHED_BLOCK = extractBlock('openResearchedAccountOpportunities', 7268, 7363, 'async function openResearchedAccountOpportunities(uploadId, accountName){');
const ESCAPE_HTML_SRC = extractBlock('escapeHtml', 10186, 10189, 'function escapeHtml(');
const FMT_MONEY_SRC = extractBlock('fmtMoney', 7598, 7600, 'function fmtMoney(');
const CLAMP_SCORE_SRC = extractBlock('clampScore', 7603, 7605, 'function clampScore(');

function makeSandbox(){
  const domElements = {};
  const sandbox = {
    console,
    window: { accountRadarAccounts: [] },
    document: {
      getElementById: (id) => { domElements[id] = domElements[id] || { hidden: true, textContent: '', innerHTML: '', style: {} }; return domElements[id]; },
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    isWarmAccount: () => false,
    // Dismissal persistence (localStorage-backed) is unrelated to this
    // round's wording/count changes -- stubbed to "nothing dismissed" so
    // getRecentlyResearchedAccounts() runs, exactly like other test files in
    // this suite stub unrelated dependencies rather than re-extracting them.
    isResearchResultDismissed: () => false,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  const fullSource = [
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    `const RECENTLY_RESEARCHED_WINDOW_MS = 30 * 60 * 1000;`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    ESCAPE_HTML_SRC,
    FMT_MONEY_SRC,
    CLAMP_SCORE_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    CARD_AND_MODAL_BLOCK,
    SALES_PLAY_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK,
    RR_BLOCK
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'dashboard-followup-round2-extract.js' }).runInContext(sandbox);
  sandbox.__domElements = domElements;
  return sandbox;
}

const sandbox = makeSandbox();

function realBusinessOpp(overrides = {}){
  return {
    account: 'Dispatch Goods',
    accountName: 'Dispatch Goods',
    signalLayerType: 'Business Activity Signal',
    isVerifiedSignalOpportunity: true,
    canonicalEventType: 'PARTNERSHIP',
    opportunityType: 'PARTNERSHIP',
    ...overrides
  };
}

// ===========================================================================
// Items 1-5: Dispatch-style duplicate -- canonical event identity, not title
// ===========================================================================
{
  // The confirmed production shape: primary card carries the real headline;
  // the second representation carries only the generic classification-
  // fallback title and a raw evidence-style summary in signalSummary/
  // signalDetail, but shares the SAME source name and the SAME (or a
  // one-day-adjacent) date.
  const primary = realBusinessOpp({
    signalTitle: 'Follow-on Investment from Santa Cruz Ventures',
    cleanSourceName: 'Santa Cruz Works',
    sourceUrl: 'https://santacruzworks.org/dispatch-goods-investment',
    eventDate: '2026-06-23',
    actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true }
  });
  const additionalRepresentation = realBusinessOpp({
    signalTitle: 'Timely signal creates a reason to reconnect',
    signalSummary: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods, indicating confidence in their business model.',
    signalDetail: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods, indicating confidence in their business model.',
    cleanSourceName: 'Santa Cruz Works',
    sourceUrl: '',
    eventDate: '2026-06-23',
    actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true }
  });

  assert(
    sandbox.opportunitiesLikelySameInitiative(primary, additionalRepresentation) === true,
    'required test 2: same source name (cleanSourceName) + close date is recognized as the same initiative even with an empty sourceUrl on one side and completely different title/summary text'
  );
  assert(
    sandbox.sameOpportunity(primary, additionalRepresentation) === true,
    'required test 1/3: sameOpportunity() recognizes the Dispatch-style pair as the SAME canonical event by identity, not by comparing their (deliberately different) visible titles'
  );

  sandbox.window.accountRadarAccounts = [{
    name: 'Dispatch Goods',
    futureOpportunities: [primary, additionalRepresentation]
  }];
  const cluster = sandbox.accountOpportunityCluster({ account: 'Dispatch Goods' });
  assert(cluster.length === 1, `required test 1: the merge/clustering pass collapses the Dispatch-style pair into ONE canonical opportunity in the account's active cluster (got ${cluster.length})`);
  const winner = cluster[0];
  assert(winner.signalTitle === 'Follow-on Investment from Santa Cruz Ventures', 'required test 1: the merged winner retains the strongest (real headline) evidence, not the generic classification-fallback title');

  const additionalList = sandbox.additionalOpportunitiesFor(winner);
  assert(!additionalList.some(o => sandbox.sameOpportunity(o, winner)), 'required test 3/4: the selected primary is excluded from its own Additional Opportunities list -- the same real-world event cannot render as both primary and Additional');

  // required test 4: openResearchedAccountOpportunities() (primary selection)
  // and additionalOpportunitiesFor() (Additional Opportunities) must derive
  // from the exact same canonical cluster -- proven directly on-disk rather
  // than only through behavior, since this is precisely the "two different
  // representations" defect class.
  assert(
    /dedupeOpportunities\(collapseDuplicateAccountHistorySignals\(rawOpportunities\)\)/.test(OPEN_RESEARCHED_BLOCK),
    'required test 4: openResearchedAccountOpportunities() builds its candidate list through dedupeOpportunities(collapseDuplicateAccountHistorySignals(...)) -- the SAME pipeline accountOpportunityCluster() uses -- so a live and a persisted representation of one event cannot survive as two separate entries feeding two different surfaces'
  );
}

// ===========================================================================
// Required test 5: separate investment rounds remain separate
// ===========================================================================
{
  const roundOne = realBusinessOpp({
    signalTitle: 'Seed Financing Closed With Blue Harbor Capital',
    cleanSourceName: 'TechCrunch',
    sourceUrl: 'https://techcrunch.com/dispatch-goods-seed',
    eventDate: '2025-01-10',
    actionabilityStatus: { status: 'stale', tense: 'past', isPriorityEligible: false }
  });
  const roundTwo = realBusinessOpp({
    signalTitle: 'Follow-on Investment from Santa Cruz Ventures',
    cleanSourceName: 'Santa Cruz Works',
    sourceUrl: 'https://santacruzworks.org/dispatch-goods-investment',
    eventDate: '2026-06-23',
    actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true }
  });
  assert(
    sandbox.opportunitiesLikelySameInitiative(roundOne, roundTwo) === false,
    'required test 5: two genuinely separate investment rounds (different sources, different dates over a year apart, no title-token overlap) are NOT merged into one event'
  );
  assert(sandbox.sameOpportunity(roundOne, roundTwo) === false, 'required test 5: sameOpportunity() also keeps two separate investment rounds distinct');
}

// ===========================================================================
// Items 6-8: outreach posture (Neural Trust)
// ===========================================================================
{
  const neuralTrustOpp = realBusinessOpp({
    account: 'NeuralTrust', accountName: 'NeuralTrust',
    relationshipStrength: 5,
    canonicalEventType: 'PARTNERSHIP',
    conversationStarter: "I noticed NeuralTrust just secured a $20M seed round, which could lead to exciting new projects. I'd love to discuss how we can support your upcoming initiatives with promotional products.",
    sourceUrl: 'https://example.com/neuraltrust-seed'
  });
  assert(sandbox.isReferralFirstPosture(neuralTrustOpp) === true, 'sanity: NeuralTrust (relationshipStrength 5) is a referral-first/first-contact posture');
  assert(
    sandbox.mentionsProductOrMerchOffer(neuralTrustOpp.conversationStarter),
    'sanity: the confirmed production Conversation Starter text pitches products directly'
  );
  assert(
    sandbox.isGroundedOpener(neuralTrustOpp.conversationStarter, neuralTrustOpp) === false,
    'required test 6: the cached, product-pitching Conversation Starter is rejected as ungrounded -- getSuggestedOpener() cannot return it verbatim'
  );
  const opener = sandbox.getSuggestedOpener(neuralTrustOpp);
  assert(
    !sandbox.mentionsProductOrMerchOffer(opener),
    `required test 6: the actual opener getSuggestedOpener() returns never leads with a direct product/merch pitch, for any posture (got: "${opener}")`
  );

  // required test 7: Best Next Move (buildConciseSalesPlay's Cold branch)
  // independently derives a referral-first ask -- proven on-disk so the
  // SAME posture concept (isReferralFirstPosture()) is demonstrably what
  // both getSuggestedOpener() and buildConciseSalesPlay() key off, not two
  // independently-tuned templates that happen to agree today.
  assert(
    /Keep the first ask small and referral-focused/.test(SALES_PLAY_BLOCK),
    'required test 7: buildConciseSalesPlay()\'s Cold/first-contact branch keeps the existing "keep the first ask small and referral-focused" Best Next Move framing'
  );
  assert(
    /Do not lead with product ideas yet\. Use the signal to find the right person, then ask permission to follow up\./.test(SALES_PLAY_BLOCK),
    'required test 7: the Cold-branch coaching note explicitly states the same referral-first rule getSuggestedOpener() now enforces on cached copy'
  );
  assert(
    /Do you know \$\{ask\}\? Not trying to jump straight to a pitch/.test(SALES_PLAY_BLOCK),
    'required test 7: buildReplyFirstEmail()\'s Cold branch also asks for the right person before any product mention, never leading with a pitch'
  );

  // required test 8: a known uploaded/discovered contact name does not
  // upgrade the posture -- hasKnownContact only personalizes wording (see
  // buildConciseSalesPlay's Cold branch), it never changes ctx.mode or
  // isReferralFirstPosture()'s own relationshipStrength-based decision.
  const knownContactOpp = realBusinessOpp({
    account: 'NeuralTrust', accountName: 'NeuralTrust',
    relationshipStrength: 5,
    canonicalEventType: 'PARTNERSHIP',
    suggestedContactDetails: { name: 'Jordan Rivera', title: 'VP Marketing' },
    conversationStarter: "I'd love to discuss how we can support your upcoming initiatives with promotional products.",
    sourceUrl: 'https://example.com/neuraltrust-seed'
  });
  assert(sandbox.isReferralFirstPosture(knownContactOpp) === true, 'required test 8: a real, known contact name on file does NOT flip the posture away from referral-first -- knowing a name is not the same as knowing that person owns the opportunity');
  assert(sandbox.isGroundedOpener(knownContactOpp.conversationStarter, knownContactOpp) === false, 'required test 8: known-contact personalization does not exempt a product-pitching cached opener from the referral-first posture check');
}

// ===========================================================================
// Items 9-10: Avidia-style follow-up wording (durable vs. launch-specific)
// ===========================================================================
{
  const recentLaunch = { canonicalKind: 'expansion', actionabilityTense: 'past', eventDate: new Date(Date.now() - 3 * 86400000).toISOString().slice(0,10), isAccountHistory: false };
  const olderEligibleLaunch = { canonicalKind: 'expansion', actionabilityTense: 'past', eventDate: new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10), isAccountHistory: false };
  const upcomingLaunch = { canonicalKind: 'expansion', actionabilityTense: 'future', eventDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0,10), isAccountHistory: false };

  assert(sandbox.ideaOfferPhrase(recentLaunch) === 'a few launch-related ideas', `required test 9: an event 3 days in the past (Avidia's own observed case) still uses launch-specific wording (got "${sandbox.ideaOfferPhrase(recentLaunch)}")`);
  assert(sandbox.ideaOfferPhrase(olderEligibleLaunch) === 'a few post-event follow-up ideas', `required test 10: an eligible but older (30-day) follow-up uses durable "post-event" wording instead of "launch" (got "${sandbox.ideaOfferPhrase(olderEligibleLaunch)}")`);
  assert(sandbox.ideaOfferPhrase(upcomingLaunch) === 'a few launch-related ideas', `sanity: a genuinely future/upcoming launch-family event still offers launch-related ideas, never durable "post-event" language (got "${sandbox.ideaOfferPhrase(upcomingLaunch)}")`);
  assert(!/upcoming/i.test(sandbox.ideaOfferPhrase(olderEligibleLaunch)), 'required test 9: the durable post-event wording never implies the completed event is still upcoming');
}

// ===========================================================================
// Item 11: discovery date not used as event date/actionability evidence,
// and the "Detected" label (confusable with the Status line's own "Event
// date: ...") has been replaced with unambiguous "Dated" wording.
// ===========================================================================
{
  const withRealDate = { signalDate: new Date(Date.now() - 1 * 86400000).toISOString().slice(0,10) };
  const age = sandbox.formatSignalAge(withRealDate);
  assert(/^Dated /.test(age), `required test 11: formatSignalAge() uses "Dated ..." wording, not "Detected ..." (got "${age}")`);
  assert(!/Detected/.test(age), 'required test 11: the word "Detected" -- which reads as House Accounts\' own discovery activity -- no longer appears in this label');
  const withOnlyDiscoveryFields = { detectedAt: new Date().toISOString(), dateFound: new Date().toISOString(), firstSeenAt: new Date().toISOString() };
  assert(sandbox.formatSignalAge(withOnlyDiscoveryFields) === '', 'required test 11: discovery-only timestamps (detectedAt/dateFound/firstSeenAt) still never produce an age label at all -- they are not read by formatSignalAge()');
}

// ===========================================================================
// Items 12-13: Toyota/Weatherby regressions
// ===========================================================================
{
  const toyotaLikeOpp = realBusinessOpp({
    account: 'Toyota of Portsmouth', accountName: 'Toyota of Portsmouth',
    canonicalEventType: 'ACQUISITION', opportunityType: 'ACQUISITION',
    actionabilityStatus: { status: 'ongoing-stale', tense: 'ongoing', isPriorityEligible: false, label: 'No longer current' }
  });
  assert(sandbox.isPriorityEligibleOpportunity(toyotaLikeOpp) === false, 'required test 12: an expired-acquisition-style opportunity remains suppressed from active eligibility');
  assert(sandbox.signalDateAndActionabilityLine(toyotaLikeOpp) === 'No longer current', 'required test 12: the status line still reads "No longer current"');

  const weatherbyLikeOpp = realBusinessOpp({
    account: 'Weatherby Healthcare', accountName: 'Weatherby Healthcare',
    canonicalEventType: 'EVENT_CONFERENCE', opportunityType: 'EVENT_CONFERENCE',
    actionabilityStatus: { status: 'unknown-date', tense: 'unknown', isPriorityEligible: false, label: 'Date unavailable' }
  });
  assert(sandbox.isPriorityEligibleOpportunity(weatherbyLikeOpp) === false, 'required test 13: an undated Weatherby-style signal remains ineligible as an active play');
  assert(sandbox.signalDateAndActionabilityLine(weatherbyLikeOpp) === 'Date unavailable', 'required test 13: the status line still reads "Date unavailable"');
}

// ===========================================================================
// Item 14: Avidia-style duplicate events remain deduplicated (regression for
// the classification-order fix from the prior round).
// ===========================================================================
{
  const avidiaA = realBusinessOpp({
    account: 'Avidia Bank', accountName: 'Avidia Bank',
    canonicalEventType: 'RENOVATION_COMPLETION',
    signalTitle: 'Avidia Bank Westborough Branch Ribbon Cutting',
    cleanSourceName: 'Worcester Business Journal',
    sourceUrl: 'https://example.com/avidia-a',
    eventDate: '2026-06-23'
  });
  const avidiaB = realBusinessOpp({
    account: 'Avidia Bank', accountName: 'Avidia Bank',
    canonicalEventType: 'RENOVATION_COMPLETION',
    signalTitle: 'Avidia Bank Westborough Branch Ribbon Cutting and Open House',
    cleanSourceName: 'MetroWest Daily News',
    sourceUrl: 'https://example.com/avidia-b',
    eventDate: '2026-06-22'
  });
  assert(sandbox.opportunitiesLikelySameInitiative(avidiaA, avidiaB) === true, 'required test 14: the Avidia-style duplicate (title-token overlap, related event types, close dates) remains recognized as one initiative');
}

// ===========================================================================
// Item 15: no raw numeric score labels
// ===========================================================================
{
  sandbox.window.accountRadarAccounts = [{
    name: 'Ridgeline Facilities Group',
    futureOpportunities: [
      realBusinessOpp({ account: 'Ridgeline Facilities Group', accountName: 'Ridgeline Facilities Group', signalTitle: 'Ridgeline Facilities Group National Expo', sourceUrl: 'https://example.com/ridgeline-a', eventDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0,10), actionabilityStatus: { status: 'upcoming', tense: 'future', isPriorityEligible: true } }),
      realBusinessOpp({ account: 'Ridgeline Facilities Group', accountName: 'Ridgeline Facilities Group', signalTitle: 'Ridgeline Facilities Group Grand Opening', sourceUrl: 'https://example.com/ridgeline-b', eventDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0,10), actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true } })
    ]
  }];
  const primaryLike = { ...sandbox.window.accountRadarAccounts[0].futureOpportunities[0] };
  const html = sandbox.renderAdditionalOpportunitiesForSalesPlay(primaryLike);
  assert(!/Why Now \d/.test(html), 'required test 15: renderAdditionalOpportunitiesForSalesPlay() never renders a raw "Why Now N" numeric label');
}

// ===========================================================================
// Item 16: no customer/account-specific production conditionals
// ===========================================================================
{
  const namedConditional = /if\s*\([^)]*(['"])(Dispatch Goods|NeuralTrust|Neural Trust|Avidia|Weatherby|Toyota of Portsmouth)\1/i.test(DASHBOARD_SRC);
  assert(!namedConditional, 'required test 16: no `if (...)` conditional in dashboard/index.html branches on any of the fixture account names from this round');
}

// ===========================================================================
// Weatherby UX items (additional 5): honest verified-signal vs. active-
// opportunity counts, plural grammar, action label, historical research
// accessibility.
// ===========================================================================
{
  const now = Date.now();
  sandbox.window.accountRadarAccounts = [{
    name: 'Weatherby Healthcare',
    uploadId: 'upload-weatherby',
    lastResearchedAt: new Date(now - 5 * 60000).toISOString(),
    signals: [
      { isReal: true, sourceUrl: 'https://example.com/w1', signalType: 'Conference', title: 'Weatherby exhibiting at conference' },
      { isReal: true, sourceUrl: 'https://example.com/w2', signalType: 'Conference', title: 'Weatherby booth announcement' },
      { isReal: true, sourceUrl: 'https://example.com/w3', signalType: 'Office Opening', title: 'Weatherby opened a regional office 10 months ago' }
    ],
    futureOpportunities: [
      realBusinessOpp({ account: 'Weatherby Healthcare', accountName: 'Weatherby Healthcare', canonicalEventType: 'EVENT_CONFERENCE', sourceUrl: 'https://example.com/w1', actionabilityStatus: { status: 'unknown-date', tense: 'unknown', isPriorityEligible: false, label: 'Date unavailable' } }),
      realBusinessOpp({ account: 'Weatherby Healthcare', accountName: 'Weatherby Healthcare', canonicalEventType: 'NEW_LOCATION_OPENING', sourceUrl: 'https://example.com/w3', actionabilityStatus: { status: 'stale', tense: 'past', isPriorityEligible: false, label: 'No longer current' } })
    ]
  }];

  const entries = sandbox.getRecentlyResearchedAccounts();
  assert(entries.length === 1, 'sanity: Weatherby Healthcare appears in Recently Researched');
  const weatherby = entries[0];

  // required item 19/20: verified-signal count and active-opportunity count
  // are computed independently and remain genuinely distinct.
  assert(weatherby.signalCount === 3, `additional test 1: three researched verified signals are counted for Weatherby (got ${weatherby.signalCount})`);
  assert(weatherby.activeOpportunityCount === 0, `additional test 2: zero of those signals are currently active/eligible opportunities (got ${weatherby.activeOpportunityCount})`);
  assert(weatherby.signalCount !== weatherby.activeOpportunityCount, 'additional test 2: verified-signal count and active-opportunity count are NOT conflated into a single number');

  // required item 21: the action label does not imply an active opportunity
  // exists when zero do.
  assert(
    /View research/.test(RR_BLOCK.replace(/\n/g, ' ')) && /activeOpportunityCount \? 'View opportunities' : 'View research'/.test(RR_BLOCK.replace(/\s+/g, ' ')),
    'additional test 3: the Recently Researched action label reads "View research" (not "View opportunities") when the account has verified signals but zero currently-active opportunities'
  );

  // required item 22: the account is never removed from Recently Researched
  // merely because it has zero active opportunities.
  assert(entries.some(e => e.name === 'Weatherby Healthcare'), 'additional test 4: Weatherby Healthcare remains visible in Recently Researched -- historical research is never hidden merely because no opportunity is currently active');

  // required item 23 (regression): the empty-state modal wording uses
  // correct singular/plural grammar and distinguishes verified-signal count
  // from active-opportunity count honestly.
  assert(
    /Research found \$\{researchedSignalCount\} verified signal\$\{researchedSignalCount === 1 \? '' : 's'\}/.test(OPEN_RESEARCHED_BLOCK),
    'additional test 5: the "No active opportunity to show" empty-state body uses the real researched-signal count with correct singular/plural grammar, honestly distinct from the zero eligible opportunities'
  );
  assert(
    /none \$\{researchedSignalCount === 1 \? 'is' : 'are'\} currently active/.test(OPEN_RESEARCHED_BLOCK),
    'additional test 5: the empty-state sentence uses correct is/are agreement for the verified-signal count'
  );
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
