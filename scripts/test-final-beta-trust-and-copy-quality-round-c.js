// Final bounded Beta trust correction (Round C): dedicated regression
// coverage for the three remaining smoke-test trust failures plus the
// global "How to Approach" seller-copy quality correction.
//
//   1. Cianbro Maine CTE Business Summit -> canonical Conference/Summit /
//      Event everywhere (canonicalEventType, seller copy, buying team),
//      never Hiring -- including the read-time self-heal for a legacy row
//      whose recommendedBuyingTeam/likelyBuyers was frozen at persist time
//      by the old, pre-canonical-classification independent classifier.
//   2. Cianbro "ABC Convention > Past Events > ... > Schedule" roster page
//      -> Possible Match / non-actionable -- including the read-time
//      identityConfidence self-heal for a legacy row graded 'unconfirmed'
//      by an older, looser version of isStandaloneSingleTokenMention().
//   3. BerryDunn generic careers evidence -> never Leadership Change absent
//      real leadership-change evidence (resolveEventType()'s
//      LEADERSHIP_APPOINTMENT pattern tightened to require a real ROLE word
//      near the verb, not a bare "named"/"promotes"/"appoints" match).
//   4. Raw breadcrumb/SEO-title text is never emitted verbatim as seller
//      copy (How to Approach / Email / Call Script / Subject / Questions to
//      Ask) -- looksLikeRawSourceArtifact()/cleanEvidencePhraseForOutreach()
//      gate every one of those surfaces.
//   5-7. Natural, concrete, family-specific discovery questions replace the
//      old vague "anything coming up?" boilerplate for hiring/event/generic
//      weak signals.
//   8. Prepare for Call's Email/Call Script/Questions to Ask/Subject all
//      derive from the SAME canonical family as the card headline -- no
//      surface can say Hiring while another says Event.
//
// Usage: node scripts/test-final-beta-trust-and-copy-quality-round-c.js
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';
import { resolveCanonicalEventType, classifyLegacySignalActionability } from '../api/research-batch.js';
import { verifyCandidateCompanyGrounding } from '../api/signal-intelligence.js';
import { makeAISignal } from '../api/research-account.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();
const TIMEBOX_CONFIG_SRC = extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG');
const IS_RELATIONSHIP_EXPANSION_SRC = extractFn(DASHBOARD_SRC, 'isRelationshipExpansionOpportunity');
const DEDUPE_AND_IDENTITY_BLOCK = extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(', 'function isWebResearchSignal(opp){');
const CARD_AND_MODAL_BLOCK = extractRange(DASHBOARD_SRC, 'function confidenceLabel(', 'function addSignalDerivedOpportunities(');
const OPPORTUNITY_GENERATION_BLOCK = extractRange(DASHBOARD_SRC, 'function estimateFutureValue(account, opportunityType){', 'function getPriorityTier(');
const SALES_PLAY_BLOCK = extractRange(DASHBOARD_SRC, 'function salesPlayModeFromOpp(', 'function renderPipelineTable(');
const SCORING_AND_TIMEBOX_BLOCK = extractRange(DASHBOARD_SRC, 'function normalizeSignalLayerType(', 'function feedSummary(');
const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
const FMT_MONEY_SRC = extractFn(DASHBOARD_SRC, 'fmtMoney');
const CLAMP_SCORE_SRC = extractFn(DASHBOARD_SRC, 'clampScore');
const REASON_AND_STARTER_BLOCK = extractRange(DASHBOARD_SRC, 'function getReasonToReachOutTitle(opp){', 'function getConversationStarterText(');

function makeSandbox() {
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
    SCORING_AND_TIMEBOX_BLOCK,
    `this.getSuggestedOpener = getSuggestedOpener;
     this.businessSuggestedOpener = businessSuggestedOpener;
     this.looksLikeRawSourceArtifact = looksLikeRawSourceArtifact;
     this.cleanEvidencePhraseForOutreach = cleanEvidencePhraseForOutreach;
     this.groundedInitiativeTitle = groundedInitiativeTitle;
     this.naturalDiscoveryQuestion = naturalDiscoveryQuestion;
     this.naturalDiscoveryFallbackOpener = naturalDiscoveryFallbackOpener;
     this.businessSignalPlainSummary = businessSignalPlainSummary;
     this.canonicalSignalKind = canonicalSignalKind;
     this.inferSalesPlaySignalType = inferSalesPlaySignalType;
     this.buildConciseSalesPlay = buildConciseSalesPlay;
     this.groundedDepartmentForOpportunity = groundedDepartmentForOpportunity;`
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'round-c-extract.js' }).runInContext(sandbox);
  return sandbox;
}

// ===========================================================================
// Item 1: Cianbro Maine CTE Business Summit -- canonical Conference/Summit
// everywhere, never Hiring, including the buying-team self-heal.
// ===========================================================================
{
  const title = 'Cianbro at Maine CTE Business Summit';
  const ctx = 'Cianbro joined the Maine CTE Business Summit to discuss career pathways for students.';
  const canonical = resolveCanonicalEventType({ signalTitle: title, business_context: ctx });
  assert(canonical.eventType === 'EVENT_CONFERENCE', `REQUIRED: Cianbro Summit resolves to canonical EVENT_CONFERENCE (got ${canonical.eventType})`);

  const freshSignal = makeAISignal(
    { signalTitle: title, whatChanged: ctx },
    { title, snippet: ctx, url: 'https://news.example.com/cianbro-summit' },
    'Cianbro', '', false
  );
  assert(freshSignal.canonicalEventType === 'EVENT_CONFERENCE', 'REQUIRED: a freshly researched Cianbro Summit signal persists canonicalEventType EVENT_CONFERENCE');
  assert(!/hiring|onboarding/i.test(freshSignal.reasonToReachOut), `REQUIRED: freshly researched Cianbro Summit reasonToReachOut is never Hiring-oriented (got "${freshSignal.reasonToReachOut}")`);
  assert(!freshSignal.affectedDepartment || freshSignal.affectedDepartment !== 'HR / People', `REQUIRED: freshly researched Cianbro Summit buying department is not HR / People (got "${freshSignal.affectedDepartment}")`);

  // REQUIRED bug fix: a legacy row persisted BEFORE canonical classification
  // existed, whose recommendedBuyingTeam/likelyBuyers were frozen by the old
  // independent classifier as Hiring-oriented, self-heals to the correct
  // canonical family's team -- the actual reproduced "conflicting seller
  // interpretation" (Events headline, HR/Employee Onboarding buying team).
  const staleRow = {
    companyName: 'Cianbro', accountName: 'Cianbro',
    title, signalTitle: title, rawTitle: title,
    businessContext: ctx,
    sourceUrl: 'https://news.example.com/cianbro-summit',
    recommendedBuyingTeam: ['HR / People'], likelyBuyers: ['HR / People'],
    reasonToReachOut: 'Hiring creates a timely reason to check in'
  };
  const healed = classifyLegacySignalActionability(staleRow);
  assert(healed.canonicalEventType === 'EVENT_CONFERENCE', 'REQUIRED: the stale legacy row self-heals to canonical EVENT_CONFERENCE');
  assert(JSON.stringify(healed.recommendedBuyingTeam) === JSON.stringify(['Marketing / Events']), `REQUIRED: the stale "HR / People" buying team self-heals to the canonical events-family team (got ${JSON.stringify(healed.recommendedBuyingTeam)})`);
  assert(JSON.stringify(healed.likelyBuyers) === JSON.stringify(['Marketing / Events']), `REQUIRED: likelyBuyers self-heals identically to recommendedBuyingTeam (got ${JSON.stringify(healed.likelyBuyers)})`);
  assert(!/hiring|onboarding/i.test(healed.reasonToReachOut), `REQUIRED: the self-healed reasonToReachOut is no longer Hiring-oriented (got "${healed.reasonToReachOut}")`);

  // Dashboard header (getReasonToReachOutTitle) and Sales Play bucket
  // (inferSalesPlaySignalType) both agree on "event", never "hiring" --
  // proves the conflicting-interpretation defect is closed end to end.
  const sandbox = makeSandbox();
  const opp = { canonicalEventType: 'EVENT_CONFERENCE', opportunityType: 'SIGNAL-DRIVEN', sourceUrl: 'https://news.example.com/cianbro-summit', isVerifiedSignalOpportunity: true, account: 'Cianbro', signalType: 'Conference / Summit' };
  const headerTitle = sandbox.getReasonToReachOutTitle(opp);
  assert(headerTitle === 'Event activity creates a timely reason to check in', `REQUIRED: Prepare-for-Call header reads Event for Cianbro Summit (got "${headerTitle}")`);
  const bucket = sandbox.inferSalesPlaySignalType(opp, headerTitle, '', '');
  assert(bucket === 'event', `REQUIRED: the Sales Play outreach-flavor bucket agrees ("event"), never "hiring" (got "${bucket}")`);
}

// ===========================================================================
// Item 2: Cianbro "ABC Convention > Past Events > ... > Schedule" roster
// page -- Possible Match / non-actionable, including the identityConfidence
// self-heal for a legacy row graded under an older, looser rule.
// ===========================================================================
{
  const rosterSnippet = 'ABC Convention > Past Events > Past ABC Conventions > 2026 > Schedule\nCianbro\nAcme Industrial\nNorthfield Supply';
  const rosterUrl = 'https://abcconvention.example.com/past-events/past-abc-conventions/2026/schedule';
  const grounding = verifyCandidateCompanyGrounding({ title: 'ABC Convention Past Exhibitors', snippet: rosterSnippet, url: rosterUrl }, { name: 'Cianbro' });
  assert(grounding.identityConfidence === 'possible', `REQUIRED: the live grounding rule itself grades the roster page 'possible' (got '${grounding.identityConfidence}')`);

  // REQUIRED bug fix: a legacy row persisted 'unconfirmed' by an OLDER,
  // looser grounding rule (before this round's/last round's local-clause
  // tightening) self-heals to 'possible' at read time -- the actual
  // reproduced defect (a stale row still opening Use This Signal / Prepare
  // for Call).
  const staleRosterRow = {
    companyName: 'Cianbro', accountName: 'Cianbro',
    title: 'ABC Convention Past Exhibitors', signalTitle: 'ABC Convention Past Exhibitors', rawTitle: 'ABC Convention Past Exhibitors',
    rawSnippet: rosterSnippet, businessContext: rosterSnippet,
    sourceUrl: rosterUrl,
    identityConfidence: 'unconfirmed'
  };
  const healedRoster = classifyLegacySignalActionability(staleRosterRow);
  assert(healedRoster.identityConfidence === 'possible', `REQUIRED: a stale 'unconfirmed' legacy roster row self-heals to 'possible' at read time (got '${healedRoster.identityConfidence}')`);

  // A row with NO identityConfidence stamped at all (truly ancient, missing
  // entirely) is ALSO regraded, not silently grandfathered into a
  // permissive default -- this is the exact "still allows an actionable
  // Business Signal" symptom.
  const missingIdentityRow = { ...staleRosterRow };
  delete missingIdentityRow.identityConfidence;
  const healedMissing = classifyLegacySignalActionability(missingIdentityRow);
  assert(healedMissing.identityConfidence === 'possible', `REQUIRED: a legacy row with NO identityConfidence at all also self-heals to 'possible' for the roster shape (got '${healedMissing.identityConfidence}')`);

  // Preserve: a genuinely 'confirmed' row (e.g. via account domain/location
  // corroboration this function cannot re-derive without the account
  // record) is left untouched -- the self-heal only ever downgrades an
  // 'unconfirmed'/missing grade, never risks demoting a legitimately
  // confirmed one.
  const confirmedRow = { ...staleRosterRow, identityConfidence: 'confirmed' };
  const healedConfirmed = classifyLegacySignalActionability(confirmedRow);
  assert(healedConfirmed.identityConfidence === undefined, 'REQUIRED preserve: a stored \'confirmed\' identityConfidence is never touched by the self-heal');

  // Preserve: the genuine explicit-claim shape (Mark Brooks represented
  // Cianbro at the Summit) still self-heals to (or stays) 'unconfirmed', a
  // real, visible Business Signal -- the self-heal only corrects the
  // over-permissive roster case, it does not suppress legitimate recall.
  const genuineRow = {
    companyName: 'Cianbro', accountName: 'Cianbro',
    rawTitle: 'Community Business Roundup',
    rawSnippet: 'Mark Brooks represented Cianbro at the Maine CTE Business Summit this week.',
    sourceUrl: 'https://localnews.example.com/cianbro-summit-roundup',
    identityConfidence: 'unconfirmed'
  };
  const healedGenuine = classifyLegacySignalActionability(genuineRow);
  assert(healedGenuine.identityConfidence === undefined, 'REQUIRED preserve: a genuine explicit-claim legacy row is left at its already-correct \'unconfirmed\' grade (no override emitted since the recompute agrees)');
}

// ===========================================================================
// Item 3: BerryDunn generic careers evidence -- never Leadership Change
// absent real leadership-change evidence.
// ===========================================================================
{
  const careersAward = resolveCanonicalEventType({
    signalTitle: 'BerryDunn Careers | Trusted advisors named a Best Place to Work',
    business_context: 'BerryDunn was named a Best Place to Work as recognized by industry peers. Explore open positions and join our team today.'
  });
  assert(careersAward.eventType !== 'LEADERSHIP_APPOINTMENT', `REQUIRED: a careers page that happens to mention "named ... as" award language is never classified as a leadership appointment (got ${careersAward.eventType})`);

  const genericCareers = resolveCanonicalEventType({
    signalTitle: 'BerryDunn Careers',
    business_context: 'BerryDunn promotes a collaborative, growth-oriented culture. Explore open positions and apply today.'
  });
  assert(genericCareers.eventType === 'HIRING_ACTIVITY', `REQUIRED: generic BerryDunn careers/employment evidence classifies as Hiring when genuinely supported (got ${genericCareers.eventType})`);

  // Preserve: a REAL leadership appointment (verb + actual role word) still
  // classifies correctly -- the fix narrows the gate, it does not disable
  // genuine leadership detection.
  const genuineAppointment = resolveCanonicalEventType({
    signalTitle: 'CFO announcement',
    business_context: 'Arthur J. Gallagher & Co. announced today that Jane Smith has been appointed Chief Financial Officer effective immediately.'
  });
  assert(genuineAppointment.eventType === 'LEADERSHIP_APPOINTMENT', `REQUIRED preserve: a genuine appointment ("appointed ... Chief Financial Officer") still classifies as LEADERSHIP_APPOINTMENT (got ${genuineAppointment.eventType})`);
}

// ===========================================================================
// Item 4: raw breadcrumb/SEO-title text is never emitted verbatim as
// seller-facing copy.
// ===========================================================================
{
  const sandbox = makeSandbox();
  assert(sandbox.looksLikeRawSourceArtifact('ABC Convention > Past Events > Past ABC Conventions > 2026 > Schedule') === true, 'REQUIRED: a breadcrumb chain is detected as a raw source artifact');
  assert(sandbox.looksLikeRawSourceArtifact('Hiring Now! - Zippia') === true, 'REQUIRED: a known job-board SEO suffix ("- Zippia") is detected as a raw source artifact');
  assert(sandbox.looksLikeRawSourceArtifact('Careers - MyWorkdayJobs') === true, 'REQUIRED: a known job-board SEO suffix ("- MyWorkdayJobs") is detected as a raw source artifact');
  assert(sandbox.looksLikeRawSourceArtifact('L.L.Bean, Inc. Jobs | LiveAndWorkInMaine') === true, 'REQUIRED: a publisher-suffix title ("| LiveAndWorkInMaine") is detected as a raw source artifact');
  assert(sandbox.looksLikeRawSourceArtifact('Cianbro was involved with the Maine CTE Business Summit') === false, 'sanity: a genuine, clean factual sentence is NOT flagged as a raw source artifact');

  const abcOpp = {
    account: 'Cianbro', signalTitle: 'ABC Convention > Past Events > Past ABC Conventions > 2026 > Schedule',
    canonicalEventType: 'EVENT_CONFERENCE', opportunityType: 'SIGNAL-DRIVEN',
    isVerifiedSignalOpportunity: true, sourceUrl: 'https://abcconvention.example.com/past-events'
  };
  const abcOpener = sandbox.getSuggestedOpener(abcOpp);
  assert(!/>\s*Past Events|Schedule/.test(abcOpener), `REQUIRED (the actual reproduced bug): the How to Approach opener never quotes the raw breadcrumb chain verbatim (got "${abcOpener}")`);
  assert(!/anything coming up (that )?(we should|you.?d like|is worth)?\s*(be\s+)?thinking about/i.test(abcOpener), `REQUIRED: the opener never falls back to the banned "anything coming up..." filler (got "${abcOpener}")`);

  const zippiaOpp = {
    account: 'Acme Corp', signalTitle: 'Hiring Now! - Zippia', canonicalEventType: 'HIRING_ACTIVITY', opportunityType: 'SIGNAL-DRIVEN',
    isVerifiedSignalOpportunity: true, sourceUrl: 'https://www.zippia.com/acme-corp-careers'
  };
  const zippiaOpener = sandbox.getSuggestedOpener(zippiaOpp);
  assert(!/Zippia/i.test(zippiaOpener), `REQUIRED: the opener never quotes the raw "Hiring Now! - Zippia" SEO title verbatim (got "${zippiaOpener}")`);

  const llbeanOpp = {
    account: 'L.L.Bean', signalTitle: 'L.L.Bean, Inc. Jobs | LiveAndWorkInMaine', canonicalEventType: 'HIRING_ACTIVITY', opportunityType: 'SIGNAL-DRIVEN',
    isVerifiedSignalOpportunity: true, sourceUrl: 'https://liveandworkinmaine.com/llbean-jobs'
  };
  const llbeanOpener = sandbox.getSuggestedOpener(llbeanOpp);
  assert(!/LiveAndWorkInMaine/i.test(llbeanOpener), `REQUIRED: the opener never quotes the raw "| LiveAndWorkInMaine" publisher suffix verbatim (got "${llbeanOpener}")`);

  // groundedInitiativeTitle() (feeds Email/Call Script/Subject/Questions)
  // is gated identically -- the raw breadcrumb never reaches those surfaces
  // either.
  const initiativeTitle = sandbox.groundedInitiativeTitle(abcOpp);
  assert(initiativeTitle === '', `REQUIRED: groundedInitiativeTitle() returns empty for the raw breadcrumb rather than the junk text itself (got "${initiativeTitle}")`);
}

// ===========================================================================
// Items 5-7: natural, concrete, family-specific discovery questions.
// ===========================================================================
{
  const sandbox = makeSandbox();
  const hiringQuestion = sandbox.naturalDiscoveryQuestion('hiring');
  assert(/onboarding|growth|focused/i.test(hiringQuestion), `REQUIRED (item 5): the hiring discovery question is natural and hiring-oriented (got "${hiringQuestion}")`);
  assert(!/anything coming up|is anything changing|would there be anything worth/i.test(hiringQuestion), `REQUIRED: the hiring question avoids the founder's named banned phrasings (got "${hiringQuestion}")`);

  const eventQuestion = sandbox.naturalDiscoveryQuestion('event');
  assert(/ongoing/i.test(eventQuestion), `REQUIRED (item 6): the event discovery question is natural and event-oriented (got "${eventQuestion}")`);
  assert(!/anything coming up|is anything changing|would there be anything worth/i.test(eventQuestion), `REQUIRED: the event question avoids the founder's named banned phrasings (got "${eventQuestion}")`);

  const genericQuestion = sandbox.naturalDiscoveryQuestion('business');
  assert(!/anything coming up|is anything changing|would there be anything worth/i.test(genericQuestion), `REQUIRED (item 7): the generic/unknown discovery fallback avoids the founder's named banned phrasings (got "${genericQuestion}")`);

  // The full openers built from these questions also pass the site's own
  // established grounded-opener quality gate's banned-pattern list
  // (isGroundedOpener()'s UNGROUNDED_LEGACY_PATTERNS) -- proves the new
  // templates are not just founder-compliant but consistent with the
  // pre-existing house style the deterministic fallback was previously
  // exempt from.
  const hiringOpener = sandbox.naturalDiscoveryFallbackOpener('hiring', 'there', 'Acme Corp');
  assert(!/anything coming up (that )?(we should|you.?d like|is worth)?\s*(be\s+)?thinking about/i.test(hiringOpener), `sanity: the hiring fallback opener does not match isGroundedOpener()'s own banned "anything coming up" pattern (got "${hiringOpener}")`);
  assert(!/saw some recent (company )?activity/i.test(hiringOpener), `sanity: the hiring fallback opener does not match isGroundedOpener()'s own banned "saw some recent activity" pattern (got "${hiringOpener}")`);
  const genericOpener = sandbox.naturalDiscoveryFallbackOpener('business', 'there', 'Acme Corp');
  assert(!/anything coming up (that )?(we should|you.?d like|is worth)?\s*(be\s+)?thinking about/i.test(genericOpener), `sanity: the generic fallback opener does not match isGroundedOpener()'s own banned "anything coming up" pattern (got "${genericOpener}")`);
}

// ===========================================================================
// Item 8: Prepare for Call's Email/Call Script/Questions to Ask/Subject all
// derive from the SAME canonical family as the card headline -- never one
// surface saying Hiring while another says Event.
// ===========================================================================
{
  const sandbox = makeSandbox();
  const cianbroOpp = {
    account: 'Cianbro', canonicalEventType: 'EVENT_CONFERENCE', opportunityType: 'SIGNAL-DRIVEN',
    signalTitle: 'Cianbro was involved with the Maine CTE Business Summit',
    isVerifiedSignalOpportunity: true, sourceUrl: 'https://news.example.com/cianbro-summit',
    affectedDepartment: 'Marketing / Events'
  };
  const headerTitle = sandbox.getReasonToReachOutTitle(cianbroOpp);
  const reasonTitle = headerTitle;
  const whyNow = sandbox.businessSignalPlainSummary(cianbroOpp);
  const signalType = sandbox.inferSalesPlaySignalType(cianbroOpp, reasonTitle, whyNow, '');
  const canonicalKind = sandbox.canonicalSignalKind(cianbroOpp) || '';
  const initiativeTitle = sandbox.groundedInitiativeTitle(cianbroOpp) || reasonTitle;
  const department = sandbox.groundedDepartmentForOpportunity(cianbroOpp);
  const play = sandbox.buildConciseSalesPlay({
    account: 'Cianbro', firstName: 'there', mode: 'Cold', reasonTitle, whyNow,
    relationshipStrength: 0, sourceLabel: 'public signal', category: '', signalType, canonicalKind,
    department, initiativeTitle, isUpcoming: false, actionabilityTense: '', eventDate: '',
    hasKnownContact: false, isAccountHistory: false, layer: 'Business Activity Signal',
    orderCategory: '', orderDateText: '', reorderStatus: null
  });
  assert(signalType === 'event', `REQUIRED: the Sales Play bucket for Cianbro Summit is "event" (got "${signalType}")`);
  const allSurfaceText = `${play.emailSubject} ${play.outreachEmail} ${play.callScript.join(' ')} ${play.questionsToAsk.join(' ')} ${play.bestNextMove}`;
  assert(!/hiring|onboarding|recruit/i.test(allSurfaceText), `REQUIRED: no Prepare-for-Call outreach surface (email/call script/questions/best next move) mentions Hiring for a canonical Conference/Summit signal (got: ${JSON.stringify(play)})`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
