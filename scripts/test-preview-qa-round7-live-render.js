// Preview QA round 7 (post-6ab5b9c real-Preview-screenshot forensic
// diagnosis): rounds 5-6 fixed the client-side dedup/date-reconciliation/
// opener-repair LOGIC, but new real Preview screenshots showed all three
// defects still visible. Root cause, confirmed by this file's fixtures:
// raw_data.existingSignals entries persisted before
// isVerifiedSignalOpportunity/signalLayerType were set on every opportunity
// object (a genuinely older, "legacy" object shape) silently fail
// isBusinessOpportunity()/isBusinessSignalOpportunity() -- both client
// (dashboard/index.html) and server (api/get-dashboard.js) -- which defeats
// business-signal identity merge/dedup AND read-time date reconciliation
// for that one persisted object, even though a freshly re-derived
// ha_signals row for the SAME event correctly carries those flags and
// therefore survives as an apparent duplicate. Fixed by
// reconcileStoredOpportunity() (api/get-dashboard.js), which runs every
// existingSignals entry through the same classifyLegacySignalActionability()
// reconciliation ha_signals rows already get, AND re-asserts the two
// identity flags every CURRENT signal always carries.
//
// A second, independent defect: two confirmed-production Conversation
// Starters (Kiniksa Pharmaceuticals, Sandwich Stampede) pitched a product
// directly ("promotional materials," "event merchandise or VIP gifts") --
// phrasings the old mentionsProductOrMerchOffer() regex never covered, and
// which were only rejected for a Cold/referral-first posture in the first
// place. Fixed by widening the regex to the full list the permanent
// Conversation Starter rule names, and applying it universally (every
// posture, every signal type) since a first-contact-shaped question should
// never lead with a product pitch regardless of relationship strength.
//
// This file uses the REAL production functions -- buildAccountsFromRows()
// (api/get-dashboard.js) and the real, verbatim dashboard/index.html source
// extracted into a vm sandbox -- with LEGACY-shaped fixtures (missing
// isVerifiedSignalOpportunity/signalLayerType on existingSignals entries,
// exactly like a pre-fix persisted row) so it actually exercises the same
// gap the real Preview screenshots exposed, not an idealized shape that
// happens to already carry every current flag.
//
// Usage: node scripts/test-preview-qa-round7-live-render.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { buildAccountsFromRows } from '../api/get-dashboard.js';

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
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-preview-qa-round7-live-render.js.`);
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
const CARD_AND_MODAL_BLOCK = extractBlock('card-and-modal-helpers-plus-signal-derived', 4595, 5923, 'function confidenceLabel(');
const OPPORTUNITY_GENERATION_BLOCK = extractBlock('opportunity-generation', 7590, 8130, 'function estimateFutureValue(account, opportunityType){');
const SALES_PLAY_BLOCK = extractBlock('sales-play-grounding', 7727, 9017, 'function salesPlayModeFromOpp(');
const SCORING_AND_TIMEBOX_BLOCK = extractBlock('scoring-and-timebox-helpers', 9020, 9523, 'function normalizeSignalLayerType(');
const ESCAPE_HTML_SRC = extractBlock('escapeHtml', 10230, 10233, 'function escapeHtml(');
const FMT_MONEY_SRC = extractBlock('fmtMoney', 7642, 7644, 'function fmtMoney(');
const CLAMP_SCORE_SRC = extractBlock('clampScore', 7647, 7649, 'function clampScore(');
const REASON_AND_STARTER_BLOCK = extractBlock('reason-and-starter-helpers', 7045, 7083, 'function getReasonToReachOutTitle(opp){');

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
    ESCAPE_HTML_SRC,
    FMT_MONEY_SRC,
    CLAMP_SCORE_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    CARD_AND_MODAL_BLOCK,
    OPPORTUNITY_GENERATION_BLOCK,
    REASON_AND_STARTER_BLOCK,
    SALES_PLAY_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'dashboard-round7-live-render-extract.js' }).runInContext(sandbox);
  return sandbox;
}

function daysAgoIso(days){
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// ===========================================================================
// SCENARIO 1 -- Dispatch Goods, LEGACY-shaped existingSignals entry: no
// isVerifiedSignalOpportunity/signalLayerType (the true real-Preview shape),
// empty sourceUrl, plus a fresh ha_signals row for the SAME real-world
// follow-on investment, plus a genuinely separate Series A round.
// Items 1, 2, 3, 16.
// ===========================================================================
{
  const followOnDate = daysAgoIso(10);
  const seriesADate = daysAgoIso(150);
  const accountRows = [{
    account_name: 'Dispatch Goods', upload_id: 'upload-1', industry: 'Logistics',
    contact_name: '', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 80, relationshipStrength: 10 },
    raw_data: {
      monitoring_status: 'active',
      existingSignals: [{
        // Deliberately NO isVerifiedSignalOpportunity/signalLayerType --
        // the exact shape a row persisted before those fields existed on
        // every opportunity object still has.
        account: 'Dispatch Goods', accountName: 'Dispatch Goods',
        canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
        signalTitle: 'Follow-on Investment from Santa Cruz Ventures',
        signalSummary: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods.',
        sourceName: 'Santa Cruz Works', cleanSourceName: 'Santa Cruz Works',
        sourceUrl: '',
        eventDate: followOnDate, eventDateConfidence: 'exact',
        publicationDate: followOnDate, publishedDate: followOnDate,
        actionabilityStatus: { status: 'recent-past', tense: 'past', isPriorityEligible: true },
        confidence: 82, confidenceScore: 82
      }]
    }
  }];
  const signalRows = [
    {
      account_name: 'Dispatch Goods', upload_id: 'upload-1', signal_type: 'Funding',
      title: 'Dispatch Goods Business Update',
      source_url: 'https://santacruzworks.org/articles/dispatch-goods-follow-on',
      source_domain: 'Santa Cruz Works', confidence: 78,
      published_at: followOnDate,
      payload: {
        isReal: true,
        canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
        whatChanged: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods.',
        eventDate: followOnDate, event_date: followOnDate,
        publicationDate: followOnDate, publishedDate: followOnDate,
        confidenceScore: 78
      }
    },
    {
      account_name: 'Dispatch Goods', upload_id: 'upload-1', signal_type: 'Funding',
      title: 'Dispatch Goods Series A',
      source_url: 'https://example.com/dispatch-goods-series-a',
      source_domain: 'Example Wire', confidence: 80,
      published_at: seriesADate,
      payload: {
        isReal: true,
        canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
        whatChanged: 'Dispatch Goods raised a Series A round led by a separate investor group.',
        eventDate: seriesADate, event_date: seriesADate,
        publicationDate: seriesADate, publishedDate: seriesADate,
        confidenceScore: 80
      }
    }
  ];

  const { accountList } = buildAccountsFromRows(accountRows, signalRows);
  const dispatchAccount = accountList.find(a => a.name === 'Dispatch Goods');
  assert(!!dispatchAccount, 'Dispatch Goods account survives buildAccountsFromRows() with a legacy-shaped existingSignals entry');

  const sandbox = makeSandbox();
  sandbox.window.accountRadarAccounts = [dispatchAccount];

  // Item 3: the main dashboard grid caps every account to ONE card
  // (limitReasonsPerAccount(..., 1) inside prepareAllOpportunities/
  // prepareTimeboxReasons) -- the SAME single canonical identity must be
  // used to pick that one card as accountOpportunityCluster() uses to
  // build the full cluster, so the grid card and the Prepare for Call
  // primary are never two different representations of the same event.
  const cardCandidates = sandbox.prepareAllOpportunities(dispatchAccount.futureOpportunities);
  assert(cardCandidates.length === 1, `item 3: the main dashboard grid shows exactly one card per account (got ${cardCandidates.length})`);
  const followOn = dispatchAccount.futureOpportunities.find(o => /Follow-on Investment/i.test(o.signalTitle || ''));
  assert(sandbox.sameOpportunity(cardCandidates[0], followOn), 'item 3: the one grid card selected is the SAME canonical event (by identity, not reference) as the follow-on investment used for Prepare for Call -- both surfaces agree on identity');
  assert(!!followOn, 'the specific-titled follow-on investment opportunity is present after hydration');

  // Items 1-2: accountOpportunityCluster()/additionalOpportunitiesFor() --
  // whichever raw representation is used as "primary" -- must resolve to
  // exactly one canonical event for this real-world investment, and no
  // later call re-adds a duplicate.
  const cluster = sandbox.accountOpportunityCluster(followOn);
  assert(cluster.length === 2, `item 1: the account's canonical cluster contains exactly the two genuinely distinct opportunities (follow-on + Series A), never a re-injected duplicate of the follow-on investment (got ${cluster.length})`);
  const additional = sandbox.additionalOpportunitiesFor(followOn);
  assert(additional.length === 1 && /Series A/i.test(additional[0].signalTitle || ''), `item 1: Additional Opportunities shows only the genuinely separate Series A round, never a second copy of the follow-on investment (got ${additional.map(o => o.signalTitle).join(', ')})`);

  // Item 2: re-running the exact same hydration/cluster call again (as a
  // second page load or refresh would) must not re-introduce a duplicate.
  const clusterAgain = sandbox.accountOpportunityCluster(followOn);
  assert(clusterAgain.length === 2, `item 2: a second call to accountOpportunityCluster() (simulating a repeat render/refresh) still shows exactly 2 opportunities, never growing (got ${clusterAgain.length})`);

  // Final rendered HTML -- primary and Additional Opportunities.
  const verifiedHtml = sandbox.renderVerifiedOpportunitySection(followOn);
  assert(/Follow-on Investment from Santa Cruz Ventures/.test(verifiedHtml), 'the Verified Opportunity panel renders the real, specific signalTitle');
  const additionalHtml = sandbox.renderAdditionalOpportunitiesForSalesPlay(followOn);
  assert(!/Follow-on Investment from Santa Cruz Ventures/.test(additionalHtml), 'item 1 (rendered proof): the follow-on investment primary never ALSO renders inside Additional Opportunities');
  assert(/Series A/i.test(additionalHtml), 'item 16: the genuinely separate Series A round still renders in Additional Opportunities, proving separate rounds are never merged away entirely');
}

// ===========================================================================
// SCENARIO 2 -- Avidia Bank, LEGACY-shaped existingSignals entry with a
// pre-fix wrong eventDate (the source's own listing date, not the true
// event date) AND a dangling-ellipsis persisted Conversation Starter.
// Items 4, 5, 6, 7.
// ===========================================================================
{
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function dateParts(daysAgo){
    const d = new Date(Date.now() - daysAgo * 86400000);
    return { iso: d.toISOString().slice(0, 10), month: MONTH_NAMES[d.getUTCMonth()], monthAbbr: MONTH_ABBR[d.getUTCMonth()], day: d.getUTCDate(), year: d.getUTCFullYear() };
  }
  const realEvent = dateParts(10);
  const listingDate = dateParts(11);

  const accountRows = [{
    account_name: 'Avidia Bank', upload_id: 'upload-2', industry: 'Banking',
    contact_name: 'Tad', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 75, relationshipStrength: 5 },
    raw_data: {
      monitoring_status: 'active',
      existingSignals: [{
        // Legacy shape again: no isVerifiedSignalOpportunity/signalLayerType.
        account: 'Avidia Bank', accountName: 'Avidia Bank',
        canonicalEventType: 'RENOVATION_COMPLETION',
        signalTitle: 'Avidia Bank Westborough Branch Renovation',
        signalSummary: `Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon cutting on ${realEvent.month} ${realEvent.day}, ${realEvent.year}.`,
        whatChanged: `Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon cutting on ${realEvent.month} ${realEvent.day}, ${realEvent.year}.`,
        sourceUrl: 'https://www.eventbrite.com/e/avidia-bank-westborough-ribbon-cutting',
        cleanSourceName: 'Eventbrite',
        // Pre-fix persisted state: the wrong (listing) date, with exact
        // confidence, as an earlier research run wrote it directly into
        // raw_data.existingSignals -- never touched by rowToSignal() since
        // it never passes through the ha_signals table.
        eventDate: listingDate.iso, event_date: listingDate.iso, eventDateConfidence: 'exact',
        publicationDate: listingDate.iso, publishedDate: listingDate.iso,
        conversationStarter: "Hey Tad — saw Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon... Is that creating any internal or customer-facing needs we should be thinking about?",
        confidence: 74, confidenceScore: 74
      }]
    }
  }];

  const { accountList } = buildAccountsFromRows(accountRows, []);
  const avidiaAccount = accountList.find(a => a.name === 'Avidia Bank');
  assert(!!avidiaAccount, 'Avidia Bank account survives buildAccountsFromRows() with a legacy-shaped existingSignals entry');
  const avidiaOpp = avidiaAccount.futureOpportunities[0];

  // Items 4, 6: dashboard/modal status and actionability use the reconciled
  // real event date, not the persisted listing date.
  assert(avidiaOpp.eventDate === realEvent.iso, `item 4: the legacy-persisted listing-date eventDate is reconciled to the explicit real event-date text (got ${avidiaOpp.eventDate}, expected ${realEvent.iso})`);
  assert(avidiaOpp.eventDateConfidence === 'exact', 'the reconciled event date keeps exact confidence');

  const sandbox = makeSandbox();
  sandbox.window.accountRadarAccounts = [avidiaAccount];
  const statusLine = sandbox.signalDateAndActionabilityLine(avidiaOpp);
  const realShort = `${realEvent.monthAbbr} ${realEvent.day}`;
  const listingShort = `${listingDate.monthAbbr} ${listingDate.day}`;
  assert(new RegExp(`Event date: ${realShort}`).test(statusLine), `item 6: Status/actionability wording uses the reconciled real event date (got "${statusLine}")`);
  assert(!new RegExp(listingShort).test(statusLine), `item 4: Status never mentions the wrong listing date (got "${statusLine}")`);

  const verifiedHtml = sandbox.renderVerifiedOpportunitySection(avidiaOpp);
  assert(new RegExp(`Event date: ${realShort}`).test(verifiedHtml), 'item 4: the rendered Verified Opportunity panel (dashboard and Prepare for Call modal share this same render function) shows the reconciled real event date');

  // Item 5: Evidence may still truthfully carry the source's own listing
  // date as a distinct fact -- the reconciliation never deletes it, only
  // stops it from being used AS the event date.
  assert(avidiaOpp.publicationDate === listingDate.iso || avidiaOpp.publishedDate === listingDate.iso, `item 5: the source's own listing date remains available as publicationDate/publishedDate, distinct from the reconciled eventDate (got publicationDate=${avidiaOpp.publicationDate}, publishedDate=${avidiaOpp.publishedDate})`);

  // Item 7: the dangling-ellipsis Conversation Starter is sanitized on
  // every surface that reads it through the shared accessor.
  const opener = sandbox.getSuggestedOpener(avidiaOpp);
  assert(!/\.{3,}|…/.test(opener), `item 7: the Avidia opener contains no ellipsis fragment on any surface (got "${opener}")`);
  assert(/\?/.test(opener), 'item 7: the Avidia opener is a real question');
}

// ===========================================================================
// SCENARIO 3 -- Neural Trust: confirmed production Conversation Starter
// text that both dangles mid-sentence AND pitches products directly.
// Item 8.
// ===========================================================================
{
  const sandbox = makeSandbox();
  const neuralTrust = {
    account: 'NeuralTrust', accountName: 'NeuralTrust', contactName: 'Alina',
    isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal',
    canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
    signalTitle: 'NeuralTrust Secures $20M Seed Round',
    sourceUrl: 'https://example.com/neuraltrust-seed',
    relationshipStrength: 5,
    conversationStarter: "I noticed NeuralTrust just secured a $20M seed round for securing AI... Anything coming up that we should be thinking about with promotional products?"
  };
  const opener = sandbox.getSuggestedOpener(neuralTrust);
  assert(!/\.{3,}|…/.test(opener), `item 8: the Neural Trust dashboard/modal opener contains no ellipsis fragment on any surface (got "${opener}")`);
  assert(!sandbox.mentionsProductOrMerchOffer(opener), `item 8/10/11: the Neural Trust opener never pitches a product directly (got "${opener}")`);
  assert(/\?/.test(opener), 'the Neural Trust opener is a real question');
  assert(/^Hey Alina\b/.test(opener), 'item 12: the known contact\'s first name (Alina) is preserved in the fallback opener');
}

// ===========================================================================
// SCENARIO 4 -- Kiniksa Pharmaceuticals and Sandwich Stampede: confirmed
// production Conversation Starters that pitch products directly in an
// ALREADY-shown-good-elsewhere posture -- proving the product rule applies
// universally (not gated to Cold/referral-first postures) and that the
// known recommended contact is preserved through the fallback.
// Items 9, 10, 11, 12.
// ===========================================================================
{
  const sandbox = makeSandbox();
  const kiniksa = {
    account: 'Kiniksa Pharmaceuticals', accountName: 'Kiniksa Pharmaceuticals', contactName: 'Meghan King',
    isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal',
    canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL',
    signalTitle: 'Kiniksa Pharmaceuticals Q2 Financial Results Call',
    sourceUrl: 'https://example.com/kiniksa-q2',
    relationshipStrength: 5,
    conversationStarter: 'Would you be interested in discussing promotional materials for the event?'
  };
  assert(sandbox.isGroundedOpener(kiniksa.conversationStarter, kiniksa) === false, 'item 3 (policy): the stored Kiniksa opener is rejected for directly pitching a product ("promotional materials")');
  const kiniksaOpener = sandbox.getSuggestedOpener(kiniksa);
  assert(!sandbox.mentionsProductOrMerchOffer(kiniksaOpener), `item 10/11: the final Kiniksa opener never pitches a product directly (got "${kiniksaOpener}")`);
  assert(/\?/.test(kiniksaOpener), 'item 2 (policy): the final Kiniksa opener is a real, question-oriented ask');
  assert(/^Hey Meghan\b/.test(kiniksaOpener), 'item 12/6 (policy): the recommended contact (Meghan) remains intact in the final Kiniksa opener');
  assert(/Kiniksa Pharmaceuticals Q2 Financial Results Call/.test(kiniksaOpener), 'item 4 (policy): the Kiniksa fixture becomes a signal-grounded question naming the real event');

  const sandwich = {
    account: 'Sandwich Stampede', accountName: 'Sandwich Stampede', contactName: 'Scott',
    isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal',
    canonicalEventType: 'LOCATION_EVENT_UNSPECIFIED',
    signalTitle: 'Sandwich Stampede Inaugural Event Sells Out',
    sourceUrl: 'https://example.com/sandwich-stampede',
    relationshipStrength: 5,
    conversationStarter: 'Would you be interested in discussing event merchandise or VIP gifts for attendees?'
  };
  assert(sandbox.isGroundedOpener(sandwich.conversationStarter, sandwich) === false, 'item 3 (policy): the stored Sandwich Stampede opener is rejected for directly pitching products ("event merchandise or VIP gifts")');
  const sandwichOpener = sandbox.getSuggestedOpener(sandwich);
  assert(!sandbox.mentionsProductOrMerchOffer(sandwichOpener), `item 10/11: the final Sandwich Stampede opener never pitches a product directly (got "${sandwichOpener}")`);
  assert(/\?/.test(sandwichOpener), 'item 2 (policy): the final Sandwich Stampede opener is a real, question-oriented ask');
  assert(/^Hey Scott\b/.test(sandwichOpener), 'item 12/6 (policy): the recommended contact (Scott) remains intact in the final Sandwich Stampede opener');
  assert(/Sandwich Stampede Inaugural Event Sells Out/.test(sandwichOpener), 'item 4 (policy): the Sandwich Stampede fixture becomes a signal-grounded question naming the real event');
}

// ===========================================================================
// Item 1 (policy): every rendered Conversation Starter across a mixed batch
// is question-oriented -- a broad sweep, not just the two named fixtures.
// Item 13 (email may still be less restrictive -- this file does not touch
// buildConciseSalesPlay's email/call-script output, only the Conversation
// Starter field, matching "do not apply this strict no-product rule to the
// full email body or every other outreach field").
// ===========================================================================
{
  const sandbox = makeSandbox();
  const fixtures = [
    { account: 'Acme Corp', accountName: 'Acme Corp', isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL', signalTitle: 'Acme Corp Series B', sourceUrl: 'https://example.com/acme' },
    { account: 'Riverside Fitness', accountName: 'Riverside Fitness', isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', canonicalEventType: 'NEW_LOCATION_OPENING', signalTitle: 'Riverside Fitness Grand Reopening' },
    { account: 'Delta Robotics', accountName: 'Delta Robotics', isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', canonicalEventType: 'LEADERSHIP', signalTitle: 'Delta Robotics Names New COO' }
  ];
  for(const opp of fixtures){
    const opener = sandbox.getSuggestedOpener(opp);
    assert(/\?/.test(opener), `item 1 (policy): the fallback Conversation Starter for ${opp.account} is question-oriented (got "${opener}")`);
    assert(!sandbox.mentionsProductOrMerchOffer(opener), `item 3 (policy): the fallback Conversation Starter for ${opp.account} never pitches a product directly (got "${opener}")`);
  }
}

// ===========================================================================
// Item 9 -- static proof that every visible Conversation Starter render
// site calls the shared getSuggestedOpener() accessor, not a raw field.
// ===========================================================================
{
  const salesPlayPanelSrc = LINES.slice(8140 - 1, 8360).join('\n');
  assert(/window\.createSalesPlayPanel\s*=\s*function/.test(salesPlayPanelSrc), 'sanity: extracted the real createSalesPlayPanel() source for the static Conversation Starter accessor check');
  assert(/getSuggestedOpener\(opp\)/.test(salesPlayPanelSrc), 'item 9: Prepare for Call\'s Call Plan renders the Conversation Starter via getSuggestedOpener(opp)');
  const conversationStarterLine = (salesPlayPanelSrc.match(/.*Conversation Starter.*\n.*/g) || []).join('\n');
  assert(/getSuggestedOpener\(opp\)/.test(conversationStarterLine) && !/opp\.conversationStarter/.test(conversationStarterLine), 'item 9: the Conversation Starter block specifically reads getSuggestedOpener(opp), never opp.conversationStarter directly');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
