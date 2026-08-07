// Preview QA follow-up round (post e49b0e094c0970bc789a93cd8fbc4bec986bccc0):
// two generalized problems remained plus one smaller presentation issue.
//
// Problem 1 -- Dispatch Goods still rendered the same real-world event twice
// (once as the primary Verified Opportunity, once as an "Additional
// Opportunity" under a different, generic title). Root cause: get-dashboard.js's
// buildAccountsFromRows() concatenated two independently-deduped-but-never-
// cross-deduped sources (the persisted raw_data.existingSignals snapshot and a
// fresh signalToOpportunity() built from every surviving ha_signals row) with
// no canonicalization pass ever run BETWEEN them. Fixed by adding
// canonicalizeAccountOpportunities() (get-dashboard.js), which runs the real
// resolveOpportunityEvents() (signal-intelligence.js) once across the combined
// candidate set for each account, before the payload is ever split into
// primary/Additional/Research Details/Recently Researched. That fix alone
// didn't fully collapse the real-shaped duplicate until resolveEvents()'s own
// merge gate was also corrected: it re-derived eventDate from free text
// instead of trusting a candidate's own already-resolved structured eventDate
// field, so two representations of the same event with matching structured
// dates but no date literally restated in one side's snippet text never
// satisfied the "positive agreement" merge requirement.
//
// Problem 2 -- Avidia's Signal description said "...ribbon cutting on June
// 23, 2026" while Status said "Event date: Jun 22" and Evidence said "Dated
// Jun 22". Root cause: extractEventDate() (signal-intelligence.js) grabbed
// whichever date pattern matched FIRST in concatenated free text, with no way
// to tell "the event happened on X" from "this listing was posted/dated X" --
// a listing site's own dateline could silently outrank the sentence that
// actually named the event date. Fixed by teaching extractEventDate() to skip
// matches immediately preceded by publication/listing language ("posted",
// "published", "dated", "listed", "updated", "created", "added").
//
// Problem 3 -- a Conversation Starter was observed cut off mid-clause
// ("...with a ceremonial ribbon..."). Root cause: compact() (research-batch.js)
// always hard-cut at exactly `max` characters, backing off only to the
// nearest earlier WORD boundary, never a sentence or clause boundary. Fixed
// by preferring the last real sentence ending, then the last clause boundary,
// within a reasonable distance of `max`, before falling back to the original
// word-boundary behavior.
//
// This file uses the REAL, exported production functions directly
// (buildAccountsFromRows/canonicalizeAccountOpportunities from
// api/get-dashboard.js; resolveEvents/resolveOpportunityEvents/extractEventDate
// from api/signal-intelligence.js; makeSignal/compact/computeActionability from
// api/research-batch.js) plus the real, verbatim dashboard/index.html source
// extracted into a vm sandbox for client-side cluster/status rendering --
// nothing here is a test-only reimplementation of production dedup or date
// logic.
//
// Usage: node scripts/test-preview-qa-round5-followup.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { buildAccountsFromRows } from '../api/get-dashboard.js';
import { resolveEvents, resolveOpportunityEvents, extractEventDate } from '../api/signal-intelligence.js';
import { makeSignal, compact, computeActionability, signalEventCategory } from '../api/research-batch.js';

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
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-preview-qa-round5-followup.js.`);
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
const SCORING_AND_TIMEBOX_BLOCK = extractBlock('scoring-and-timebox-helpers', 8976, 9479, 'function normalizeSignalLayerType(');
const FMT_MONEY_SRC = extractBlock('fmtMoney', 7598, 7600, 'function fmtMoney(');
const CLAMP_SCORE_SRC = extractBlock('clampScore', 7603, 7605, 'function clampScore(');

function makeSandbox(){
  const sandbox = {
    console,
    window: { accountRadarAccounts: [] },
    document: { getElementById: () => ({ textContent: '', innerHTML: '', style: {} }), querySelectorAll: () => [] },
    isWarmAccount: () => false,
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  const fullSource = [
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    FMT_MONEY_SRC,
    CLAMP_SCORE_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    CARD_AND_MODAL_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'dashboard-round5-extract.js' }).runInContext(sandbox);
  return sandbox;
}

// ===========================================================================
// Items 1-3 -- the real Preview object shape: one persisted existingSignals
// snapshot entry plus one still-un-folded raw ha_signals row for the SAME
// real-world event, run through the actual server endpoint function
// buildAccountsFromRows().
// ===========================================================================
{
  const accountRows = [{
    account_name: 'Dispatch Goods', upload_id: 'upload-1', industry: 'Logistics',
    contact_name: '', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 80, relationshipStrength: 10 },
    raw_data: {
      monitoring_status: 'active',
      existingSignals: [{
        account: 'Dispatch Goods', accountName: 'Dispatch Goods',
        signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
        canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL', opportunityType: 'BUSINESS_ACTIVITY_FINANCIAL',
        signalTitle: 'Follow-on Investment from Santa Cruz Ventures',
        whatChanged: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods.',
        sourceName: 'Santa Cruz Works',
        sourceUrl: 'https://santacruzworks.org/dispatch-goods-follow-on-investment',
        eventDate: '2026-06-23', eventDateConfidence: 'exact',
        publicationDate: '2026-06-22', publishedDate: '2026-06-22',
        actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true },
        confidence: 82, commercialScore: 82
      }]
    }
  }];
  const signalRows = [{
    account_name: 'Dispatch Goods', upload_id: 'upload-1', signal_type: 'Funding',
    title: 'Dispatch Goods Business Update',
    source_url: 'https://santacruzworks.org/articles/dispatch-goods-follow-on',
    source_domain: 'Santa Cruz Works', confidence: 78,
    payload: {
      isReal: true,
      whatChanged: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods, indicating confidence in their business model.',
      signalDetail: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods, indicating confidence in their business model.',
      eventDate: '2026-06-23', event_date: '2026-06-23',
      actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true },
      confidenceScore: 78
    },
    first_seen_at: '2026-06-24T00:00:00Z', last_seen_at: '2026-06-24T00:00:00Z'
  }];

  const { accountList } = buildAccountsFromRows(accountRows, signalRows);
  const dispatch = accountList.find(a => a.name === 'Dispatch Goods');
  assert(!!dispatch, 'item 1: Dispatch Goods account is present in buildAccountsFromRows() output');
  assert(dispatch.futureOpportunities.length === 1, `item 1: the persisted snapshot entry and the still-raw ha_signals row for the SAME real-world event collapse to exactly one futureOpportunities entry (got ${dispatch.futureOpportunities.length})`);
  const primary = dispatch.futureOpportunities[0];
  assert(primary.sourceUrl === 'https://santacruzworks.org/dispatch-goods-follow-on-investment' || primary.corroboratingCandidates >= 2, 'item 1: the surviving entry is the canonically-resolved event carrying evidence from both original representations');

  // items 2-3: feed the ALREADY-server-canonicalized array (exactly what a
  // real Preview payload would contain) into the real client-side cluster
  // functions and confirm the primary is never re-surfaced as an Additional
  // Opportunity of itself.
  const sandbox = makeSandbox();
  const clientOpp = { ...primary, account: 'Dispatch Goods', accountName: 'Dispatch Goods' };
  sandbox.window.accountRadarAccounts = [{ name: 'Dispatch Goods', futureOpportunities: [clientOpp] }];
  const cluster = sandbox.accountOpportunityCluster(clientOpp);
  assert(cluster.length === 1, `item 2: the account's canonical cluster contains exactly the one resolved opportunity (got ${cluster.length})`);
  const additional = sandbox.additionalOpportunitiesFor(clientOpp);
  assert(additional.length === 0, `item 3: the primary opportunity never reappears in its own Additional Opportunities list (got ${additional.length} entries)`);
}

// ===========================================================================
// Item 4 -- same company/source/date/event, different (one generic, one
// specific) titles: resolveEvents() itself must merge them.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Dispatch Goods', canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
      title: 'Follow-on Investment from Santa Cruz Ventures',
      snippet: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods.',
      url: 'https://santacruzworks.org/dispatch-goods-follow-on-investment',
      sourceName: 'Santa Cruz Works', eventDate: '2026-06-23', candidateScore: 82
    },
    {
      companyName: 'Dispatch Goods', canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
      title: 'Dispatch Goods Business Update',
      snippet: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods, indicating confidence in their business model.',
      url: 'https://santacruzworks.org/articles/dispatch-goods-follow-on',
      sourceName: 'Santa Cruz Works', eventDate: '2026-06-23', candidateScore: 78
    }
  ];
  const events = resolveEvents(candidates);
  assert(events.length === 1, `item 4: two differently-titled representations of the same company/source/date/event merge into one resolveEvents() event (got ${events.length})`);
}

// ===========================================================================
// Item 5 -- missing source URL on one representation must never defeat a
// match when source name, account, event type, and date all agree.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Dispatch Goods', canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
      title: 'Follow-on Investment from Santa Cruz Ventures',
      snippet: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods.',
      url: 'https://santacruzworks.org/dispatch-goods-follow-on-investment',
      sourceName: 'Santa Cruz Works', eventDate: '2026-06-23', candidateScore: 82
    },
    {
      companyName: 'Dispatch Goods', canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
      title: 'Dispatch Goods Business Update',
      snippet: 'A recent capital raise for Dispatch Goods was reported.',
      url: '', // no source URL at all on this representation
      sourceName: 'Santa Cruz Works', eventDate: '2026-06-23', candidateScore: 60
    }
  ];
  const events = resolveEvents(candidates);
  assert(events.length === 1, `item 5: a missing source URL never prevents a match when account, type, source name, and event date already agree (got ${events.length})`);
}

// ===========================================================================
// Item 6 -- genuinely separate investment rounds (same company/type, dates
// far apart) must remain separate, not be collapsed by the date-preference
// fix.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Dispatch Goods', canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
      title: 'Series A investment', snippet: 'Dispatch Goods raised a Series A round.',
      url: 'https://a.example.com/series-a', sourceName: 'Example Wire', eventDate: '2026-02-01', candidateScore: 80
    },
    {
      companyName: 'Dispatch Goods', canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
      title: 'Follow-on investment', snippet: 'Dispatch Goods raised a follow-on round from Santa Cruz Ventures.',
      url: 'https://b.example.com/follow-on', sourceName: 'Example Wire', eventDate: '2026-06-23', candidateScore: 80
    }
  ];
  const events = resolveEvents(candidates);
  assert(events.length === 2, `item 6: two genuinely separate investment rounds (dates ~140 days apart) remain two distinct events, never merged (got ${events.length})`);
}

// ===========================================================================
// Items 7-9, 11-12 -- the Avidia-shaped case: makeSignal() fed raw text
// containing BOTH the true event-date sentence ("...ribbon cutting on June
// 23, 2026") and an Eventbrite-style publication/listing dateline ("...dated
// June 22, 2026"), run through the real, exported makeSignal() end-to-end.
// ===========================================================================
{
  const raw = {
    accountName: 'Avidia Bank',
    signalTitle: 'Avidia Bank Westborough Branch Renovation',
    whatChanged: 'Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon cutting on June 23, 2026.',
    evidence: 'Source: Eventbrite listing, posted June 22, 2026.',
    sourceUrl: 'https://www.eventbrite.com/e/avidia-bank-westborough-ribbon-cutting',
    sourceName: 'Eventbrite',
    confidenceScore: 78
  };
  const account = { contacts: [], orders: [] };
  const signal = makeSignal(raw, account, {});
  assert(!!signal, 'items 7-12: makeSignal() accepts the Avidia-shaped fixture and returns a real signal object');
  assert(signal.eventDate === '2026-06-23', `item 12: the real event date (June 23, from the "ribbon cutting on June 23, 2026" sentence) is what ends up in eventDate, never the Eventbrite listing's June 22 dateline (got ${signal.eventDate})`);
  assert(signal.eventDate !== signal.publicationDate, `item 7: eventDate and publicationDate remain distinct fields, never conflated (eventDate=${signal.eventDate}, publicationDate=${signal.publicationDate})`);

  // item 9: temporal eligibility (computeActionability) is driven by the
  // corrected eventDate, evaluated a realistic distance later.
  const now = new Date('2026-07-05T12:00:00Z');
  const actionability = computeActionability({
    eventCategory: signalEventCategory(signal.canonicalEventType),
    eventDate: signal.eventDate, dateConfidence: signal.eventDateConfidence,
    publicationDate: signal.publicationDate, now
  });
  assert(actionability.status === 'recent-past' && actionability.isPriorityEligible === true, `item 9: temporal eligibility is computed from the real June 23 event date, not the June 22 publication date (got status=${actionability.status})`);

  // item 8: the dashboard's real Status-line renderer must show the actual
  // event date, never the publication date.
  const sandbox = makeSandbox();
  const oppForStatus = { eventDate: signal.eventDate, actionabilityStatus: actionability };
  const statusLine = sandbox.signalDateAndActionabilityLine(oppForStatus);
  assert(/Event date: Jun 23/.test(statusLine), `item 8: the real Status line shows "Event date: Jun 23", never Jun 22 (got "${statusLine}")`);
  assert(!/Jun 22/.test(statusLine), `item 8: the Status line never mentions Jun 22 at all (got "${statusLine}")`);

  // item 10: Evidence (formatSignalAge) may separately show the real
  // publication date, but must never claim it under an "Event date" label --
  // formatSignalAge()'s own "Dated X" wording is a distinct surface from
  // signalDateAndActionabilityLine()'s "Event date: X".
  if(signal.publicationDate){
    const oppForEvidence = { signalDate: signal.publicationDate };
    const evidenceLine = sandbox.formatSignalAge(oppForEvidence);
    assert(!/Event date/.test(evidenceLine), `item 10: the Evidence date line never uses the "Event date" label for a publication date (got "${evidenceLine}")`);
  }
}

// ===========================================================================
// Item 11 -- during a resolveEvents() merge, a reliable structured event date
// established by the first-processed candidate is never overwritten by a
// later candidate's publication-context-only (or otherwise unreliable) date.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Avidia Bank', canonicalEventType: 'RENOVATION_COMPLETION',
      title: 'Westborough Branch Ribbon Cutting',
      snippet: 'Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon cutting on June 23, 2026.',
      url: 'https://example.com/avidia-westborough', sourceName: 'Local News', eventDate: '2026-06-23', candidateScore: 85
    },
    {
      companyName: 'Avidia Bank', canonicalEventType: 'RENOVATION_COMPLETION',
      title: 'Avidia Bank Westborough Branch Event',
      snippet: 'Eventbrite listing, posted June 22, 2026.',
      url: 'https://www.eventbrite.com/e/avidia-bank-westborough', sourceName: 'Eventbrite', candidateScore: 60
      // deliberately no structured eventDate field on this candidate --
      // its only date is publication-context text, which extractEventDate()
      // now correctly refuses to treat as an event date.
    }
  ];
  const events = resolveEvents(candidates);
  assert(events.length === 1, `item 11: the two Avidia representations (sharing the "Westborough" location entity) still merge into one event (got ${events.length})`);
  assert(events[0].eventIdentity.eventDate === '2026-06-23', `item 11: the merged event's identity retains the reliable June 23 event date -- the second candidate's publication-context-only date (now correctly excluded by extractEventDate()) never overwrites it (got ${events[0].eventIdentity.eventDate})`);
}

// ===========================================================================
// Item 12 (direct extractEventDate() unit coverage) -- publication-context
// dates are never returned as the event date, even as the ONLY date present.
// ===========================================================================
{
  const eventFirst = extractEventDate('Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon cutting on June 23, 2026. Source: Eventbrite, dated June 22, 2026.');
  assert(eventFirst.eventDate === '2026-06-23', `item 12: extractEventDate() prefers the real event-language date over an adjacent publication-context date (got ${eventFirst.eventDate})`);

  const pubOnly = extractEventDate('Eventbrite listing, posted June 22, 2026.');
  assert(pubOnly.eventDate === null && pubOnly.dateConfidence === 'unknown', `item 12: when the ONLY date present is publication-context, extractEventDate() returns unknown rather than misreporting it as an event date (got ${JSON.stringify(pubOnly)})`);
}

// ===========================================================================
// Item 13 -- Conversation Starter (and every other compact()-capped field)
// truncates at a sentence or clause boundary, never mid-clause with a
// dangling fragment ending.
// ===========================================================================
{
  const longStarter = 'Hey Tad — saw Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon cutting. Is that creating any internal or customer-facing needs we should be thinking about, and who would be the right person to loop in on that side?';
  const truncated150 = compact(longStarter, 150);
  assert(truncated150.length <= 150, `item 13: compact() never exceeds the requested max length (got length ${truncated150.length})`);
  assert(/[.!?]$/.test(truncated150) || /…$/.test(truncated150), `item 13: the truncated text ends cleanly (a real sentence end, or an explicit ellipsis after a clause/word boundary), never a bare dangling word (got "${truncated150}")`);
  assert(!/ribbon\.\.\.?$/i.test(truncated150) && !/ribbon$/i.test(truncated150), `item 13: the confirmed production fragment ("...ceremonial ribbon...") is not reproduced by the fixed compact() (got "${truncated150}")`);

  const noPunctuation = 'a run-on sentence with no punctuation at all just a very long stretch of words that keeps going and going and going and going and going and going and going without any breaks whatsoever until it finally ends right here';
  const truncatedNoPunct = compact(noPunctuation, 100);
  assert(/…$/.test(truncatedNoPunct), 'item 13: text with no sentence/clause boundary at all still falls back to the safe word-boundary + ellipsis behavior');

  const short = compact('short text stays exactly as is', 240);
  assert(short === 'short text stays exactly as is', 'item 13: text already within the max length is never altered');
}

// ===========================================================================
// Items 14-21 -- existing regression coverage (Neural Trust referral-first,
// Weatherby View Research + plural counts, Toyota exclusion, Avidia 43-day
// post-event wording, no raw score labels, syntax/browser tests) already
// lives in scripts/test-followup-temporal-integrity-round2.js and
// scripts/test-avidia-date-fixed-clock-regression.js and is re-verified by
// the full `npm test` run this round's final report cites -- not duplicated
// here to avoid two divergent copies of the same assertions.
// ===========================================================================

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
