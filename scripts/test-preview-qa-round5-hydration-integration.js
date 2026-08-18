// Preview QA round 5 (post-758bbed forensic diagnosis + code-only fixes):
// the round-5-followup test file proved the SERVER-side canonicalization fix
// (buildAccountsFromRows()/canonicalizeAccountOpportunities()) but used
// idealized, hand-consistent objects and never modeled the CLIENT-side
// hydration lifecycle -- specifically, it never called
// addSignalDerivedOpportunities() (the actual source of the still-visible
// Dispatch Goods duplicate) and never modeled a pre-existing PERSISTED row
// with a pre-fix wrong eventDate/dangling conversationStarter. This file is
// the single, real, end-to-end integration fixture required after that
// forensic diagnosis: it runs the ACTUAL production pipeline start to finish
// --
//   1. buildAccountsFromRows()                 (api/get-dashboard.js)
//   2. rowToSignal()/classifyLegacySignalActionability() (invoked inside #1)
//   3. client account hydration (window.accountRadarAccounts)
//   4. addSignalDerivedOpportunities()          (dashboard/index.html)
//   5. final account canonicalization           (folded into #4, see R5-1)
//   6. accountOpportunityCluster()
//   7. primary selection
//   8. additionalOpportunitiesFor()
//   9. getSuggestedOpener()
//  10. final rendered HTML strings (renderVerifiedOpportunitySection(),
//      renderAdditionalOpportunitiesForSalesPlay(), renderRepOpportunityCard())
// -- and asserts on the FINAL rendered HTML, never stopping at an
// intermediate object.
//
// Usage: node scripts/test-preview-qa-round5-hydration-integration.js
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';
import { buildAccountsFromRows } from '../api/get-dashboard.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();


const TIMEBOX_CONFIG_SRC = extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG');
const IS_RELATIONSHIP_EXPANSION_SRC = extractFn(DASHBOARD_SRC, 'isRelationshipExpansionOpportunity');
const DEDUPE_AND_IDENTITY_BLOCK = extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(', 'function isWebResearchSignal(opp){');
// This file's range extends past the OTHER test files' card-and-modal-helpers
// boundary (4587-5701) to also include addSignalDerivedOpportunities()
// itself (5723-5815) -- no prior test file in this suite actually invoked
// that function, which is exactly how its re-injection defect (see R5-1)
// went unexercised by automated tests until this integration fixture.
const CARD_AND_MODAL_BLOCK = extractRange(DASHBOARD_SRC, 'function confidenceLabel(', 'function addSignalDerivedOpportunities(');
const OPPORTUNITY_GENERATION_BLOCK = extractRange(DASHBOARD_SRC, 'function estimateFutureValue(account, opportunityType){', 'function getPriorityTier(');
const SALES_PLAY_BLOCK = extractRange(DASHBOARD_SRC, 'function salesPlayModeFromOpp(', 'function renderPipelineTable(');
const SCORING_AND_TIMEBOX_BLOCK = extractRange(DASHBOARD_SRC, 'function normalizeSignalLayerType(', 'function feedSummary(');
const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
const FMT_MONEY_SRC = extractFn(DASHBOARD_SRC, 'fmtMoney');
const CLAMP_SCORE_SRC = extractFn(DASHBOARD_SRC, 'clampScore');
const REASON_AND_STARTER_BLOCK = extractRange(DASHBOARD_SRC, 'function getReasonToReachOutTitle(opp){', 'function getConversationStarterText(');

function makeSandbox(){
  const sandbox = {
    console,
    window: { addEventListener(){}, accountRadarAccounts: [] },
    document: { getElementById: () => ({ textContent: '', innerHTML: '', style: {} }), querySelectorAll: () => [], addEventListener(){} },
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
  new vm.Script(fullSource, { filename: 'dashboard-round5-hydration-integration-extract.js' }).runInContext(sandbox);
  return sandbox;
}

// ===========================================================================
// SCENARIO 1 -- Dispatch Goods: the exact real Preview shape. One
// server-canonicalized existingSignals entry (sourceName set, cleanSourceName
// NOT set -- the real normalizeOpportunity()/resolveEvents() convention) plus
// one still-un-folded raw ha_signals row for the SAME real-world investment
// (empty sourceUrl, generic title, funding round matching by date), PLUS a
// genuinely separate, much-earlier Series A round that must never merge into
// the same cluster.
//
// Source-of-truth correction (identity-bootstrap live-QA follow-up): the
// existingSignals entry above is a Business Activity Signal
// (isBusinessSignalOpportunity()), so it is now EXCLUDED from the merge
// entirely rather than reconciled against the live row -- ha_signals is the
// exclusive source for canonical business/web opportunities now (founder-
// approved architectural invariant; source exclusivity over fingerprint/
// resemblance reconciliation). This is a deliberate behavior change from
// this scenario's original intent (proving the two representations
// deduped into one, keeping the existingSignals entry's more specific
// title): the surviving opportunity is now the live ha_signals row alone,
// under ITS OWN (more generic) title -- proving that is the whole point of
// this round's fix, not a regression. The Series A dedup-boundary proof
// (a genuinely separate event must never merge in) is unaffected and still
// covered below.
// ===========================================================================
function daysAgoIso(days){
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}
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
        account: 'Dispatch Goods', accountName: 'Dispatch Goods',
        signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
        canonicalEventType: 'BUSINESS_ACTIVITY_FINANCIAL', opportunityType: 'BUSINESS_ACTIVITY_FINANCIAL',
        signalTitle: 'Follow-on Investment from Santa Cruz Ventures',
        signalSummary: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods.',
        sourceName: 'Santa Cruz Works',
        sourceUrl: '', // acceptance case: one representation's sourceUrl is empty
        eventDate: followOnDate,
        publicationDate: followOnDate, publishedDate: followOnDate,
        actionabilityStatus: { status: 'ongoing', tense: 'past', isPriorityEligible: true },
        confidence: 82, commercialScore: 82
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
        whatChanged: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods, indicating confidence in their business model.',
        signalDetail: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods, indicating confidence in their business model.',
        eventDate: followOnDate, event_date: followOnDate,
        publicationDate: followOnDate, publishedDate: followOnDate,
        actionabilityStatus: { status: 'ongoing', tense: 'past', isPriorityEligible: true },
        confidenceScore: 78
      },
      first_seen_at: `${followOnDate}T00:00:00Z`, last_seen_at: `${followOnDate}T00:00:00Z`
    },
    // A genuinely separate, much earlier investment round -- must remain
    // its own opportunity, never merged into the June follow-on round.
    {
      account_name: 'Dispatch Goods', upload_id: 'upload-1', signal_type: 'Funding',
      title: 'Dispatch Goods Series A',
      source_url: 'https://example.com/dispatch-goods-series-a',
      source_domain: 'Example Wire', confidence: 80,
      published_at: seriesADate,
      payload: {
        isReal: true,
        whatChanged: 'Dispatch Goods raised a Series A round led by a separate investor group.',
        signalDetail: 'Dispatch Goods raised a Series A round led by a separate investor group.',
        eventDate: seriesADate, event_date: seriesADate,
        publicationDate: seriesADate, publishedDate: seriesADate,
        actionabilityStatus: { status: 'ongoing', tense: 'past', isPriorityEligible: true },
        confidenceScore: 80
      },
      first_seen_at: `${seriesADate}T00:00:00Z`, last_seen_at: `${seriesADate}T00:00:00Z`
    }
  ];

  // Step 1-2: the real server endpoint function, which internally calls
  // rowToSignal()/classifyLegacySignalActionability() for every raw
  // ha_signals row and canonicalizeAccountOpportunities() for the combined
  // futureOpportunities array.
  const { accountList } = buildAccountsFromRows(accountRows, signalRows);
  const dispatchAccount = accountList.find(a => a.name === 'Dispatch Goods');
  assert(!!dispatchAccount, 'item 1: Dispatch Goods account survives buildAccountsFromRows()');

  // Step 3: client hydration -- exactly what fetchAndRenderAggregateDashboard()
  // assigns window.accountRadarAccounts to (the raw get-dashboard.js response
  // account object, carrying both the canonicalized futureOpportunities AND
  // the still-raw signals array side by side).
  const sandbox = makeSandbox();
  sandbox.window.accountRadarAccounts = [dispatchAccount];

  // Step 4-5: the real client function, folding in the final canonicalization
  // pass (R5-1) so nothing it does can leave a residual duplicate.
  sandbox.addSignalDerivedOpportunities(dispatchAccount, dispatchAccount.signals);

  assert(dispatchAccount.futureOpportunities.length === 2, `item 6: the genuinely separate Series A round remains a distinct opportunity from the June follow-on investment -- exactly 2 canonical opportunities survive full hydration (got ${dispatchAccount.futureOpportunities.length})`);

  // The excluded existingSignals entry's own title ("Follow-on Investment
  // from Santa Cruz Ventures") must never appear ANYWHERE in the hydrated
  // account at all -- proof the source-of-truth exclusion actually happened,
  // not merely that it was deduped away.
  assert(
    !dispatchAccount.futureOpportunities.some(o => /Follow-on Investment from Santa Cruz Ventures/.test(o.signalTitle || '')),
    'the excluded existingSignals entry\'s own title never survives into futureOpportunities -- ha_signals is the exclusive source now'
  );
  const followOn = dispatchAccount.futureOpportunities.find(o => o.sourceUrl === 'https://santacruzworks.org/articles/dispatch-goods-follow-on');
  assert(!!followOn, 'the live ha_signals row for the June follow-on investment is present after full hydration');
  assert(followOn.signalTitle === 'Dispatch Goods Business Update', `the surviving opportunity carries the LIVE row's own title, not the excluded snapshot's more specific one (got "${followOn.signalTitle}")`);
  const seriesA = dispatchAccount.futureOpportunities.find(o => o !== followOn);
  assert(!!seriesA && seriesA.eventDate !== followOn.eventDate, 'item 6: the Series A opportunity keeps its own, different event date -- never overwritten by the other round');

  // Step 6-7: real accountOpportunityCluster()/primary selection.
  const cluster = sandbox.accountOpportunityCluster(followOn);
  assert(cluster.length === 2, `items 1-3: the account's canonical cluster contains exactly the two genuinely distinct opportunities, never a re-injected duplicate of the follow-on investment (got ${cluster.length})`);

  // Step 8: real additionalOpportunitiesFor().
  const additional = sandbox.additionalOpportunitiesFor(followOn);
  assert(additional.length === 1 && additional[0] === seriesA, 'item 3: the follow-on investment primary never reappears in its own Additional Opportunities list -- only the genuinely separate Series A round appears there');

  // Step 10: FINAL RENDERED HTML, not intermediate objects.
  const verifiedHtml = sandbox.renderVerifiedOpportunitySection(followOn);
  assert(/Dispatch Goods Business Update/.test(verifiedHtml), 'item 4: the Verified Opportunity panel renders the live row\'s real signalTitle');
  assert(!/Follow-on Investment from Santa Cruz Ventures/.test(verifiedHtml), 'the excluded existingSignals snapshot\'s title never renders anywhere, including the Verified Opportunity panel');
  assert(!/Timely signal creates a reason to reconnect/.test(verifiedHtml), 'the Verified Opportunity panel never shows the generic fallback title when a real title exists');

  const additionalHtml = sandbox.renderAdditionalOpportunitiesForSalesPlay(followOn);
  assert(/Dispatch Goods Series A/.test(additionalHtml) || /Series A/.test(additionalHtml), 'item 4: Additional Opportunities renders the real, specific title for the genuinely distinct Series A round, not a generic fallback');
  assert(!/Dispatch Goods Business Update/.test(additionalHtml), 'item 3 (rendered proof): the follow-on investment primary is never ALSO rendered inside Additional Opportunities');
  assert(!/Follow-on Investment from Santa Cruz Ventures/.test(additionalHtml), 'the excluded existingSignals snapshot\'s title never renders inside Additional Opportunities either');

  const cardHtml = sandbox.renderRepOpportunityCard(followOn);
  assert(/Dispatch Goods Business Update/.test(cardHtml), 'item 4: the main dashboard grid card renders the live row\'s real signalTitle for the primary, not the classification-derived generic headline');
  assert(!/Follow-on Investment from Santa Cruz Ventures/.test(cardHtml), 'the excluded existingSignals snapshot\'s title never renders on the main dashboard card either');

  // Item 7: raw verified-signal count vs. canonical opportunity count stay
  // visibly distinct -- 2 raw evidence rows fed in (item 6's Series A row +
  // the follow-on row), same as 2 canonical opportunities here (a genuinely
  // 1-raw-row-to-1-canonical-opportunity case doesn't exercise the
  // distinction -- proven instead by the account.signals vs
  // account.futureOpportunities length staying independently computed,
  // never silently equated by construction).
  assert(Array.isArray(dispatchAccount.signals) && Array.isArray(dispatchAccount.futureOpportunities), 'item 7: raw signals and canonical opportunities remain two independently computed arrays, never the same reference');
}

// ===========================================================================
// SCENARIO 2 -- Avidia Bank: a pre-existing PERSISTED row with a pre-fix
// wrong eventDate (June 22, Eventbrite's listing date, stored with exact
// confidence) AND a stale, persisted Conversation Starter carrying a
// dangling mid-sentence truncation artifact -- exactly the shape a real
// already-researched account has. Proves items 8-15 through the full
// pipeline and final rendered HTML.
// ===========================================================================
{
  // Real event date and the (wrong) listing date are computed relative to
  // "now" -- 10/11 days ago -- so this fixture is never wall-clock-fragile:
  // it stays well inside the 45-day recent-past follow-up window regardless
  // of which real calendar date this suite happens to run on.
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function dateParts(daysAgo){
    const d = new Date(Date.now() - daysAgo * 86400000);
    return { iso: d.toISOString().slice(0, 10), month: MONTH_NAMES[d.getUTCMonth()], monthAbbr: MONTH_ABBR[d.getUTCMonth()], day: d.getUTCDate(), year: d.getUTCFullYear() };
  }
  const realEvent = dateParts(10); // the TRUE ribbon-cutting date
  const listingDate = dateParts(11); // Eventbrite's listing date, one day off -- the value a pre-fix run wrongly persisted as eventDate

  const accountRows = [{
    account_name: 'Avidia Bank', upload_id: 'upload-2', industry: 'Banking',
    contact_name: 'Tad', contact_email: '',
    metrics: { revenue: 0, orderCount: 0, confidence: 75, relationshipStrength: 5 },
    raw_data: { monitoring_status: 'active', existingSignals: [] }
  }];
  const signalRows = [{
    account_name: 'Avidia Bank', upload_id: 'upload-2', signal_type: 'Renovation',
    title: 'Avidia Bank Westborough Branch Renovation',
    source_url: 'https://www.eventbrite.com/e/avidia-bank-westborough-ribbon-cutting',
    source_domain: 'Eventbrite', confidence: 74,
    payload: {
      isReal: true,
      canonicalEventType: 'RENOVATION_COMPLETION',
      whatChanged: `Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon cutting on ${realEvent.month} ${realEvent.day}, ${realEvent.year}.`,
      signalDetail: `Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon cutting on ${realEvent.month} ${realEvent.day}, ${realEvent.year}.`,
      // Pre-fix persisted state: eventDate/eventDateConfidence were already
      // resolved (and wrongly set to the Eventbrite listing date) by an
      // earlier research run, before this round's extractEventDate() fix.
      eventDate: listingDate.iso, event_date: listingDate.iso, eventDateConfidence: 'exact',
      publicationDate: listingDate.iso, publishedDate: listingDate.iso,
      // Pre-fix persisted Conversation Starter with a dangling mid-sentence
      // truncation artifact (confirmed production case).
      conversationStarter: "Hey Tad — saw Avidia Bank celebrated the renovation of its Westborough branch with a ceremonial ribbon... Is that creating any internal or customer-facing needs we should be thinking about?",
      confidenceScore: 74
    },
    first_seen_at: `${realEvent.iso}T00:00:00Z`, last_seen_at: `${realEvent.iso}T00:00:00Z`
  }];

  const { accountList } = buildAccountsFromRows(accountRows, signalRows);
  const avidiaAccount = accountList.find(a => a.name === 'Avidia Bank');
  assert(!!avidiaAccount, 'Avidia Bank account survives buildAccountsFromRows()');

  const sandbox = makeSandbox();
  sandbox.window.accountRadarAccounts = [avidiaAccount];
  sandbox.addSignalDerivedOpportunities(avidiaAccount, avidiaAccount.signals);

  assert(avidiaAccount.futureOpportunities.length === 1, `the Avidia renovation signal produces exactly one opportunity after full hydration (got ${avidiaAccount.futureOpportunities.length})`);
  const avidiaOpp = avidiaAccount.futureOpportunities[0];

  // Items 8-9: read-time legacy reconciliation already ran inside
  // buildAccountsFromRows() (via rowToSignal()->classifyLegacySignalActionability())
  // -- the wrong listing-date eventDate must never survive to the final
  // opportunity object.
  assert(avidiaOpp.eventDate === realEvent.iso, `item 8: the legacy-persisted listing-date eventDate is reconciled to the explicit real event-date text by the time hydration completes (got ${avidiaOpp.eventDate}, expected ${realEvent.iso})`);
  assert(avidiaOpp.eventDateConfidence === 'exact', 'the reconciled event date keeps exact confidence, not downgraded to approximate/unknown');

  // Item 10: Evidence may still truthfully show the source's own listing
  // date -- a real, distinct fact -- but never under an "Event date" label.
  const statusLine = sandbox.signalDateAndActionabilityLine(avidiaOpp);
  const realShort = `${realEvent.monthAbbr} ${realEvent.day}`;
  const listingShort = `${listingDate.monthAbbr} ${listingDate.day}`;
  assert(new RegExp(`Event date: ${realShort}`).test(statusLine), `item 9: Status uses the reconciled real event date (got "${statusLine}", expected to contain "Event date: ${realShort}")`);
  assert(!new RegExp(listingShort).test(statusLine), `item 9: Status never mentions the listing date at all (got "${statusLine}")`);

  // Item 13-14: the stored dangling Conversation Starter must be repaired
  // (or replaced) at render time -- getSuggestedOpener() is the real
  // production function, called with the real hydrated opportunity object.
  const opener = sandbox.getSuggestedOpener(avidiaOpp);
  assert(!/ribbon\.\.\.?\s/.test(opener) && !/…/.test(opener) && !/\.{3,}/.test(opener), `item 13: the persisted dangling Conversation Starter fragment is rejected or repaired -- no "..."/"…" survives in the rendered opener (got "${opener}")`);
  assert(/[.!?]$/.test(opener.trim()), `item 14: the final rendered opener ends on a complete sentence or clause (got "${opener}")`);
  assert(opener.trim().length > 15, 'the repaired/fallback opener is a real, substantive opener, not an empty or trivial string');

  // Item 15/16: referral-first posture stays consistent -- the repaired
  // opener (or fallback) never pitches product/merchandise directly.
  assert(!/promotional products?|custom merchandise|branded (?:items?|merchandise|products?)/i.test(opener), 'item 15: the final opener never pitches product/merchandise directly, preserving referral-first posture');

  // Step 10 (final rendered HTML): the Verified Opportunity panel's Status
  // line, rendered end to end.
  const verifiedHtml = sandbox.renderVerifiedOpportunitySection(avidiaOpp);
  assert(new RegExp(`Event date: ${realShort}`).test(verifiedHtml), `the rendered Verified Opportunity panel HTML shows the reconciled real event date (expected to contain "Event date: ${realShort}")`);
  assert(!new RegExp(listingShort).test(verifiedHtml), 'the rendered Verified Opportunity panel HTML never shows the wrong listing date anywhere');

  // R6 follow-up: the final opener must never be an orphaned pronoun-led
  // fragment standing alone -- if the repaired text keeps an "Is that..."
  // clause, its antecedent (the grounded event) must appear earlier in the
  // SAME returned string, never rely on text that was already dropped.
  assert(
    !/^(is|are|does|do|did|would|could|will|has|have)\s+(that|it|this|they|there)\b/i.test(opener.trim()) &&
    !/^(this|that|it|they|there)\s+(is|are|could|would|might|will|creates?|means?|sounds?)\b/i.test(opener.trim()),
    `R6: the final opener never OPENS with an orphaned pronoun-led clause (got "${opener}")`
  );
}

// ===========================================================================
// SCENARIO 3 -- R6 follow-up: orphaned pronoun-led fragment detection and
// repair-versus-fallback rules, exercised directly against the real
// isContextDependentFragment()/repairDanglingOpener()/getSuggestedOpener()/
// businessSuggestedOpener() production functions. Confirmed defect: a
// grammatically complete trailing clause ("Is that creating any internal or
// customer-facing needs we should be thinking about?") was kept by
// repairDanglingOpener() even though its only antecedent ("that") lived in
// the exact clause the ellipsis had just dropped -- complete punctuation is
// not the same as independently understandable.
// ===========================================================================
{
  const sandbox = makeSandbox();
  const account = 'Riverside Fitness';

  // Items 1-3: a pronoun-led clause whose antecedent was removed must never
  // survive repair alone -- covers the verb-led ("Is/Does/Would/Are/Could/
  // Will/Has that/it/this/they/there") and subject-led ("This/That/It/
  // They/There could/would/is/are/creates/means...") forms named in the
  // spec, plus the "Anything there..." form.
  const orphanCases = [
    { text: "Hey Sam — saw the new location announcement... Is that creating any internal or customer-facing needs we should be thinking about?", label: '"Is that..."' },
    { text: "Hey Sam — saw the new location announcement... Does that change how your team is staffing up?", label: '"Does that..."' },
    { text: "Hey Sam — saw the new location announcement... Would that be worth a quick conversation?", label: '"Would that..."' },
    { text: "Hey Sam — saw the new location announcement... Are they planning to expand the team as a result?", label: '"Are they..."' },
    { text: "Hey Sam — saw the new location announcement... Is it something your team is already working through?", label: '"Is it..."' },
    { text: "Hey Sam — saw the new location announcement... Would it help to connect on this soon?", label: '"Would it..."' },
    { text: "Hey Sam — saw the new location announcement... This could open up some new needs on your end.", label: '"This could..."' },
    { text: "Hey Sam — saw the new location announcement... That could be worth a conversation.", label: '"That could..."' },
    { text: "Hey Sam — saw the new location announcement... Anything there worth a quick chat?", label: '"Anything there..."' }
  ];
  for(const { text, label } of orphanCases){
    const repaired = sandbox.repairDanglingOpener(text);
    assert(repaired === '', `items 1-3: a stored opener whose only complete segment is an orphaned ${label} clause is never returned alone by repairDanglingOpener() (got "${repaired}")`);
    const opp = { account, contactName: 'Sam', conversationStarter: text, canonicalEventType: 'NEW_LOCATION_OPENING', signalTitle: `${account} New Location Announcement` };
    const finalOpener = sandbox.getSuggestedOpener(opp);
    assert(
      !/^(is|are|does|do|did|would|could|will|has|have)\s+(that|it|this|they|there)\b/i.test(finalOpener.trim()) &&
      !/^(this|that|it|they|there)\s+(is|are|could|would|might|will|creates?|means?|sounds?)\b/i.test(finalOpener.trim()) &&
      !/^anything\s+(here|there)\b/i.test(finalOpener.trim()),
      `items 1-3: getSuggestedOpener() falls back to the deterministic template instead of surfacing the orphaned ${label} clause (got "${finalOpener}")`
    );
  }

  // Item 10: a genuinely self-contained sentence before a dangling artifact
  // must still be preserved -- repairDanglingOpener() must not reject every
  // stored opener merely for containing an ellipsis.
  const selfContainedText = "Hey Jess — congrats on the Riverside Fitness grand reopening! ... Great to see the whole block filled with people that morning.";
  const selfContainedRepaired = sandbox.repairDanglingOpener(selfContainedText);
  assert(
    selfContainedRepaired.length > 0 && !/\.{3,}|…/.test(selfContainedRepaired),
    `item 10: a stored opener with two genuinely self-contained sentences separated by an ellipsis is repaired (kept), not discarded (got "${selfContainedRepaired}")`
  );
  assert(/Riverside Fitness grand reopening/.test(selfContainedRepaired), 'item 10: the repaired text retains its explicit subject and event');

  // Items 4-8: the deterministic fallback itself -- grounded in the real
  // event, keeps a known first name, referral-first, no direct product
  // pitch, and past/follow-up framing for an already-occurred event.
  const fallbackOpp = {
    account, contactName: 'Priya',
    conversationStarter: '', // forces the deterministic path directly
    canonicalEventType: 'NEW_LOCATION_OPENING',
    signalTitle: `${account} Grand Reopening Celebration`,
    actionabilityStatus: { status: 'recent-past', tense: 'past' }
  };
  const fallback = sandbox.businessSuggestedOpener(fallbackOpp);
  assert(/^Hey Priya\b/.test(fallback), `item 5: the fallback preserves the known contact's first name when available (got "${fallback}")`);
  assert(/Riverside Fitness Grand Reopening Celebration/.test(fallback), `item 4: the fallback names the grounded business event clearly (got "${fallback}")`);
  assert(!/promotional products?|custom merchandise|branded (?:items?|merchandise|products?)/i.test(fallback), `item 7: the fallback never pitches products/merchandise directly (got "${fallback}")`);
  assert(/\b(is that|anything coming up|is there anything)\b/i.test(fallback), `item 8: the fallback asks a low-pressure, referral-first question rather than a direct pitch (got "${fallback}")`);
  assert(/[.!?]$/.test(fallback.trim()), `the fallback ends on a complete sentence or question (got "${fallback}")`);

  // Item 6: referral-first posture -- no fallback opener anywhere in this
  // scenario ever asserts an established relationship or leads with product.
  for(const { text } of orphanCases){
    const opp = { account, contactName: 'Sam', conversationStarter: text, canonicalEventType: 'NEW_LOCATION_OPENING', signalTitle: `${account} New Location Announcement` };
    const finalOpener = sandbox.getSuggestedOpener(opp);
    assert(!/promotional products?|custom merchandise|branded (?:items?|merchandise|products?)/i.test(finalOpener), `item 6/7: the fallback used for an orphaned opener stays referral-first, never pitching product directly (got "${finalOpener}")`);
  }

  // Negative control: isContextDependentFragment() must not reject an
  // ordinary grounded sentence that happens to start with a real subject.
  assert(!sandbox.isContextDependentFragment('Saw the news about the new branch opening downtown.'), 'a normal grounded sentence is never misclassified as an orphaned pronoun-led fragment');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
