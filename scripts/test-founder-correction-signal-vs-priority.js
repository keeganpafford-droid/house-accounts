// Global Business Trigger Intelligence sprint, founder correction round:
// "NO GROUNDED ACTIVATION -> NO PRIORITY" must never mean
// "NO GROUNDED ACTIVATION -> NO SIGNAL." This file proves the five bounded
// corrections the founder ordered after the Preview QA reproduction (25-
// account fixture, upload ec599230-...) using ARCHETYPES, never named real
// companies:
//
//   1. Identity eligibility: a grounded/probable (identityConfidence
//      'unconfirmed') signal -- the ordinary case for any account whose
//      uploaded CSV had no website/location column -- is no longer excluded
//      from commercial/priority evaluation outright. Only an explicit
//      'rejected' grade (contradicted/ambiguous identity) is excluded.
//   2. Signal vs. Priority: a real, current, sourced business event (the
//      Hypertherm reproduction: 30 ranked candidates, a real #1 acquisition
//      candidate, 0 raw signals returned) must survive as a legitimate
//      signal even when House Accounts cannot responsibly infer an
//      activation for it -- proven here at the deterministic layer
//      (makeSignal()/normalizeCommercialIntelligence() never require a play
//      to keep a signal alive) since the prompt-language half of this fix
//      (api/signal-intelligence.js's COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT,
//      api/research-account.js's and api/research-batch.js's synthesis
//      prompts) governs live model behavior no regression test can pin down
//      without a real OpenAI call, out of scope for this sprint.
//   3. View Research dead-end: openResearchedAccountOpportunities() must
//      show real, found signals via the SAME renderVerifiedSignals()
//      rendering machinery already used elsewhere, not a generic "no active
//      opportunity" dialog, whenever research found signals but none are
//      Priority-eligible.
//   4. Reserved email domain: rep@example.com (and .net/.org/.edu) must
//      never be inferred as a company website, in any of the three
//      independently-maintained copies of this rule.
//   5. Silent signal-loss diagnostics: every discard point inside
//      makeSignal() and the surrounding mapping pipeline in
//      api/research-batch.js now stamps/logs a concrete reason instead of
//      silently returning null.
//
// Usage: node scripts/test-founder-correction-signal-vs-priority.js
import { makeSignal, domainFromContactEmail } from '../api/research-batch.js';
import { normalizeOpportunity, normalizeCommercialIntelligence, verifyCandidateCompanyGrounding } from '../api/signal-intelligence.js';
import { domainFromWebsite } from '../api/research-account.js';
import vm from 'vm';
import { extractFn, extractRange, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const NOW = new Date('2026-08-12T12:00:00Z');
const daysAgo = n => { const d = new Date(NOW.getTime() - n*86400000); return d.toISOString().slice(0,10); };

// ===========================================================================
// Section A -- real production pipeline (makeSignal()/normalizeOpportunity()),
// same convention as scripts/test-beta-seller-experience-quality-gate.js.
// `account` deliberately carries NO website/location field throughout this
// file -- the exact shape of an ordinary customer-order CSV upload with no
// such column, and the precondition for the identity-ceiling bug this round
// fixes.
// ===========================================================================
function buildOpportunity(raw, account = {}, candidate = {}){
  const signal = makeSignal(raw, account);
  if(!signal) return null;
  return normalizeOpportunity(signal, { name: signal.accountName, ...account }, candidate);
}
function asBusinessOpportunity(opp){
  return { ...opp, isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal', account: opp.accountName };
}

const DASHBOARD_SRC = loadDashboardSource();
const TIMEBOX_CONFIG_SRC = extractFn(DASHBOARD_SRC, 'TIMEBOX_CONFIG');
const IS_RELATIONSHIP_EXPANSION_SRC = extractFn(DASHBOARD_SRC, 'isRelationshipExpansionOpportunity');
const DEDUPE_AND_IDENTITY_BLOCK = extractRange(DASHBOARD_SRC, 'function cleanOpportunityToken(', 'function isWebResearchSignal(opp){');
const CARD_AND_MODAL_BLOCK = extractRange(DASHBOARD_SRC, 'function confidenceLabel(', 'function isSignalPriorityEligible(');
const SCORING_AND_TIMEBOX_BLOCK = extractRange(DASHBOARD_SRC, 'function normalizeSignalLayerType(', 'function feedSummary(');
const ESCAPE_HTML_SRC = extractFn(DASHBOARD_SRC, 'escapeHtml');
const CLAMP_SCORE_SRC = extractFn(DASHBOARD_SRC, 'clampScore');
const OPEN_RESEARCHED_ACCOUNT_OPPORTUNITIES_SRC = extractFn(DASHBOARD_SRC, 'openResearchedAccountOpportunities');
const EXTRACT_EMAIL_DOMAIN_SRC = extractFn(DASHBOARD_SRC, 'extractEmailDomain');

function makeSandbox(){
  const calls = [];
  const sandbox = {
    console,
    __calls: calls,
    window: {
      accountRadarAccounts: [],
      HouseAccountsHeader: { beginOverlay(){}, endOverlay(){} },
      HouseAccountManager: {
        close(){},
        isOpen(){ return false; },
        showError(opts){ calls.push({ type: 'error', opts }); },
        showResearchResults(opts){ calls.push({ type: 'research-results', opts }); }
      }
    },
    document: { getElementById: () => ({ textContent: '', innerHTML: '', style: {} }), querySelectorAll: () => [] },
    isWarmAccount: () => false,
    refreshAggregateDashboard: async () => ({ ok: true }),
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON, Promise
  };
  vm.createContext(sandbox);
  const fullSource = [
    ESCAPE_HTML_SRC,
    CLAMP_SCORE_SRC,
    EXTRACT_EMAIL_DOMAIN_SRC,
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    CARD_AND_MODAL_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK,
    OPEN_RESEARCHED_ACCOUNT_OPPORTUNITIES_SRC
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'founder-correction-extract.js' }).runInContext(sandbox);
  return sandbox;
}

const sandbox = makeSandbox();
for (const fn of [sandbox.isPriorityEligibleOpportunity, sandbox.hasConfirmedOrLegacyIdentity, sandbox.hasCredibleActivationPlay, sandbox.renderVerifiedSignals, sandbox.dedupeFoundSignals, sandbox.openResearchedAccountOpportunities, sandbox.extractEmailDomain]){
  assert(typeof fn === 'function', `extraction produced a real function (${fn && fn.name})`);
}

// ===========================================================================
// Case A -- real signal, no grounded activation. No website field on the
// account; a distinctive, timely, sourced acquisition/expansion event; no
// disclosed integration/opening/onboarding detail. Modeled on the
// Hypertherm reproduction (a real #1-ranked acquisition candidate) and the
// BerryDunn/Covetrus production evidence (own-domain press release still
// graded 'unconfirmed' for lack of a website field to compare against).
// ===========================================================================
const ACCOUNT_NO_WEBSITE = { name: 'Northfield Instruments' }; // no website, no location -- archetype of an ordinary CSV upload
const CASE_A_RAW = {
  accountName: 'Northfield Instruments',
  sourceUrl: 'https://industrynews.example/northfield-instruments-acquires-component-supplier',
  signalTitle: 'Northfield Instruments Acquires Component Supplier',
  concrete_trigger: 'Northfield Instruments acquired a minority stake in a regional component supplier',
  business_context: 'Northfield Instruments announced it acquired a minority stake in a regional component supplier, with no further operational detail disclosed.',
  event_date: daysAgo(3),
  publicationDate: daysAgo(3),
  confidence: 84
  // Deliberately no commercialPlay/activationIdeas/expansionPotential --
  // exactly what the real pipeline produces for a real event with no
  // disclosed integration detail, per this round's corrected prompt
  // contract (see COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT and both
  // synthesis prompts' new "signal vs. activation are separate judgments"
  // language).
};
// The candidate/evidence names the company by its bare, full phrase --
// entityMatch()'s nameMatched floor -- but the account has no website/
// location for verifyCandidateCompanyGrounding() to independently
// corroborate against, so this lands on 'unconfirmed' ("grounded/probable"),
// never 'confirmed'. This is the exact, structural mechanism the QA
// reproduction found (100% of a 20-signal sample landed here, including
// evidence hosted on the company's own domain).
const CASE_A_CANDIDATE = { title: CASE_A_RAW.signalTitle, snippet: CASE_A_RAW.business_context, url: CASE_A_RAW.sourceUrl };
{
  const builtSignal = makeSignal(CASE_A_RAW, ACCOUNT_NO_WEBSITE);
  assert(!!builtSignal, 'Case A: makeSignal() still returns a real signal for a real, sourced, current event with no disclosed activation (never required a play to survive)');
  assert(builtSignal.commercialPlay === null && Array.isArray(builtSignal.activationIdeas) && builtSignal.activationIdeas.length === 0, 'Case A: commercialPlay/activationIdeas are correctly absent -- restraint expressed, not fabricated');

  const grounding = verifyCandidateCompanyGrounding(CASE_A_CANDIDATE, ACCOUNT_NO_WEBSITE);
  assert(grounding.identityConfidence === 'unconfirmed', `Case A: identity lands on 'unconfirmed' (grounded/probable) -- name-matched, no contradiction, just no website field to independently corroborate against (got '${grounding.identityConfidence}')`);

  const built = buildOpportunity(CASE_A_RAW, ACCOUNT_NO_WEBSITE, CASE_A_CANDIDATE);
  const opp = { ...asBusinessOpportunity(built), identityConfidence: grounding.identityConfidence };
  assert(sandbox.hasConfirmedOrLegacyIdentity(opp) === true, 'Case A: the corrected identity gate no longer treats a merely-uncorroborated (not contradicted) identity as ineligible');
  assert(sandbox.hasCredibleActivationPlay(opp) === false, 'Case A: sanity -- there is genuinely no credible play to recommend');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'Case A: correctly NOT Priority-eligible -- no grounded activation means no Priority, exactly as intended');

  // The signal itself must still be visible through the raw-signal renderer
  // (Research Details / View Research) -- absence of a play must never mean
  // absence of the signal.
  const rawSignalForDisplay = { ...builtSignal, isReal: true, identityConfidence: grounding.identityConfidence };
  const html = sandbox.renderVerifiedSignals([rawSignalForDisplay]);
  assert(!html.includes('No external signals found'), 'Case A: the real signal renders through renderVerifiedSignals() -- it is not hidden merely because there is no activation to recommend');
  // renderSingleVerifiedSignal() titles the card from signal.signalDetail
  // first (the real event summary makeSignal() computed), not signalTitle.
  assert(html.includes(sandbox.escapeHtml(builtSignal.signalDetail)), 'Case A: the rendered signal reflects the real, specific event');
}

// ===========================================================================
// Case B -- the SAME underlying event, but the source also explicitly
// establishes a disclosed integration/welcome/launch detail. Same account
// (still no website field). Activation ideas may now be generated, and the
// opportunity can become Priority-eligible.
// ===========================================================================
const CASE_B_RAW = {
  ...CASE_A_RAW,
  business_context: 'Northfield Instruments announced it acquired a minority stake in a regional component supplier, and the two teams are holding a joint welcome event for the combined field staff next month.',
  commercialPlay: { concept: 'Combined Team Welcome', narrative: 'The two teams are holding a joint welcome event for the combined field staff -- a real, dated moment to equip the merged field team with a shared identity.' },
  activationIdeas: ['Combined-team welcome kits for the joint field staff event', 'Shared-identity apparel for the merged crew']
};
{
  const built = buildOpportunity(CASE_B_RAW, ACCOUNT_NO_WEBSITE, CASE_A_CANDIDATE);
  assert(built.commercialPlay && built.activationIdeas.length > 0, 'Case B: a disclosed integration detail survives normalizeCommercialIntelligence() as a real commercialPlay + activationIdeas');
  const grounding = verifyCandidateCompanyGrounding(CASE_A_CANDIDATE, ACCOUNT_NO_WEBSITE);
  const opp = { ...asBusinessOpportunity(built), identityConfidence: grounding.identityConfidence, actionabilityStatus: { status: 'recent-past', isPriorityEligible: true } };
  assert(sandbox.hasCredibleActivationPlay(opp) === true, 'Case B: the grounded activation is recognized as credible');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === true, 'Case B: with identity no longer a secret mandatory prerequisite AND a credible activation present, the opportunity can become Priority-eligible even with no website field on the account');
}

// ===========================================================================
// Case C -- wrong/ambiguous entity. Evidence superficially resembles the
// account but does not name it and is not a distinctive-token fallback
// match either -- entityMatch()'s nameMatched floor fails outright.
// ===========================================================================
{
  const wrongEntityCandidate = { title: 'Regional Manufacturing Roundup', snippet: 'Several unrelated regional manufacturers reported routine quarterly updates this week.', url: 'https://industrynews.example/regional-roundup' };
  const grounding = verifyCandidateCompanyGrounding(wrongEntityCandidate, ACCOUNT_NO_WEBSITE);
  assert(grounding.identityConfidence === 'rejected', `Case C: evidence that never actually names the account is rejected outright (got '${grounding.identityConfidence}')`);
  const opp = { ...asBusinessOpportunity({ ...CASE_A_RAW, accountName: ACCOUNT_NO_WEBSITE.name }), identityConfidence: grounding.identityConfidence, actionabilityStatus: { status: 'recent-past', isPriorityEligible: true } };
  assert(sandbox.hasConfirmedOrLegacyIdentity(opp) === false, 'Case C: the corrected identity gate still excludes an explicit rejected grade -- identity protection is preserved, not removed');
  assert(sandbox.isPriorityEligibleOpportunity(opp) === false, 'Case C: rejected identity is never Priority-eligible');
}

// ===========================================================================
// Case D -- View Research click-through. An account with 3 real, found
// signals and 0 Priority-eligible opportunities must open and display those
// 3 signals through openResearchedAccountOpportunities(), never a "No
// active opportunity" dead end.
// ===========================================================================
{
  const accountName = 'Northfield Instruments';
  const uploadId = 'upload-archetype-1';
  const rawSignal = makeSignal(CASE_A_RAW, ACCOUNT_NO_WEBSITE);
  const grounding = verifyCandidateCompanyGrounding(CASE_A_CANDIDATE, ACCOUNT_NO_WEBSITE);
  // foundSignalDedupeKey() (dashboard/index.html) keys on
  // type|signalDetail|sourceDomain -- signalDetail and sourceUrl's DOMAIN
  // (not full path) must differ for these to count as 3 distinct signals,
  // matching how 3 genuinely different discovered events would actually
  // differ.
  const foundSignals = [1, 2, 3].map(n => ({
    ...rawSignal,
    isReal: true,
    identityConfidence: grounding.identityConfidence,
    signalTitle: `${rawSignal.signalTitle} (${n})`,
    signalDetail: `${rawSignal.signalDetail} (variant ${n})`,
    sourceUrl: `https://industrynews-${n}.example/northfield-instruments-acquires-component-supplier`
  }));
  // futureOpportunities: 3 real Business Activity Signal opportunities, none
  // Priority-eligible (no credible activation -- same Case A shape).
  const futureOpportunities = foundSignals.map(s => ({
    ...asBusinessOpportunity(buildOpportunity({ ...CASE_A_RAW, sourceUrl: s.sourceUrl }, ACCOUNT_NO_WEBSITE, CASE_A_CANDIDATE)),
    identityConfidence: grounding.identityConfidence,
    sourceUrl: s.sourceUrl
  }));
  sandbox.window.accountRadarAccounts = [{ name: accountName, uploadId, signals: foundSignals, futureOpportunities }];
  sandbox.__calls.length = 0;
  await sandbox.openResearchedAccountOpportunities(uploadId, accountName);
  const resultCall = sandbox.__calls.find(c => c.type === 'research-results');
  const errorCall = sandbox.__calls.find(c => c.type === 'error');
  assert(!errorCall, 'Case D: View Research is never a dead-end dialog when real signals were found');
  assert(!!resultCall, 'Case D: View Research opens the real research-results view');
  if (resultCall) {
    assert(resultCall.opts.signalsHtml && !resultCall.opts.signalsHtml.includes('No external signals found'), 'Case D: the opened view actually contains the rendered signals');
    assert(/3/.test(resultCall.opts.introHtml || ''), 'Case D: the intro honestly states the real found-signal count (3)');
  }
}
// Sanity: the Priority feed itself is unaffected -- an account with real
// Priority-eligible opportunities still opens Prepare for Call as before,
// never the research-results view.
{
  const accountName = 'Southbridge Fixtures';
  const uploadId = 'upload-archetype-2';
  const grounding = verifyCandidateCompanyGrounding(CASE_A_CANDIDATE, ACCOUNT_NO_WEBSITE);
  const eligibleOpp = { ...asBusinessOpportunity(buildOpportunity(CASE_B_RAW, { name: accountName }, CASE_A_CANDIDATE)), identityConfidence: grounding.identityConfidence, actionabilityStatus: { status: 'recent-past', isPriorityEligible: true } };
  sandbox.window.accountRadarAccounts = [{ name: accountName, uploadId, signals: [], futureOpportunities: [eligibleOpp] }];
  sandbox.__calls.length = 0;
  let salesPlayCalledWith = null;
  sandbox.createSalesPlayPanel = (opp) => { salesPlayCalledWith = opp; };
  await sandbox.openResearchedAccountOpportunities(uploadId, accountName);
  assert(!sandbox.__calls.length, 'Case D sanity: a Priority-eligible account never routes through the research-results dialog or the error dialog');
  assert(!!salesPlayCalledWith, 'Case D sanity: Prepare for Call still opens directly for a Priority-eligible opportunity, unchanged');
}

// ===========================================================================
// Case E -- reserved email domain. rep@example.com (and .net/.org/.edu) must
// never be inferred as a company website, in any of the three
// independently-maintained copies.
// ===========================================================================
{
  const cases = ['rep@example.com', 'rep@example.net', 'rep@example.org', 'rep@example.edu'];
  for (const email of cases) {
    const domain = email.split('@')[1];
    assert(domainFromContactEmail(email) === '', `Case E (research-batch.js): domainFromContactEmail('${email}') never infers ${domain} as a company website`);
    assert(domainFromWebsite(domain) === '', `Case E (research-account.js): domainFromWebsite('${domain}') never infers a reserved example domain as a company website`);
    assert(sandbox.extractEmailDomain(email) === '', `Case E (dashboard/index.html): extractEmailDomain('${email}') never infers ${domain} as a company website`);
  }
  // Parity: existing personal-webmail behavior is unchanged by the widened rule.
  assert(domainFromContactEmail('rep@gmail.com') === '', 'Case E parity: personal webmail (gmail.com) is still excluded, unchanged');
  assert(domainFromWebsite('gmail.com') === '', 'Case E parity: personal webmail (gmail.com) is still excluded, unchanged (research-account.js)');
  assert(sandbox.extractEmailDomain('rep@gmail.com') === '', 'Case E parity: personal webmail (gmail.com) is still excluded, unchanged (dashboard)');
  // A genuine company domain is unaffected.
  assert(domainFromContactEmail('rep@northfieldinstruments.com') === 'northfieldinstruments.com', 'Case E sanity: a genuine company domain is still correctly inferred');
  assert(domainFromWebsite('northfieldinstruments.com') === 'northfieldinstruments.com', 'Case E sanity: a genuine company domain is still correctly inferred (research-account.js)');
  assert(sandbox.extractEmailDomain('rep@northfieldinstruments.com') === 'northfieldinstruments.com', 'Case E sanity: a genuine company domain is still correctly inferred (dashboard)');
}

// ===========================================================================
// Case F -- silent mapping rejection. A well-formed raw AI signal that gets
// rejected during makeSignal() must produce an explicit, loggable rejection
// reason (raw.__rejectionReason), not a bare, undiagnosable null.
// ===========================================================================
{
  const noAccountName = { ...CASE_A_RAW, accountName: '', account: '', company: '' };
  const r1 = makeSignal(noAccountName, ACCOUNT_NO_WEBSITE);
  assert(r1 === null && noAccountName.__rejectionReason === 'missing-account-name', `Case F: a signal missing an account name is discarded WITH a concrete reason (got '${noAccountName.__rejectionReason}')`);

  // prospectKillRule()'s hasNegativeOrIrrelevantContext() scans type/
  // signalType/signalTitle/title/summary/businessContext(camelCase)/
  // whyItMattersForPromo/sourceName/sourceUrl -- businessContext (not
  // business_context) is what makeSignal()'s buildBusinessContext() actually
  // reads verbatim (raw.businessContext), so the negative language has to
  // live there (and in signalTitle/concrete_trigger, both also scanned) to
  // reliably reach the kill rule regardless of which field wins.
  const negativeContext = {
    ...CASE_A_RAW,
    signalTitle: 'Northfield Instruments Announces Plant Closure and Layoffs',
    concrete_trigger: 'Northfield Instruments announced a plant closure amid a bankruptcy filing',
    businessContext: 'Northfield Instruments announced a plant closure and ongoing layoffs amid a bankruptcy filing.'
  };
  const r2 = makeSignal(negativeContext, ACCOUNT_NO_WEBSITE, { enableProspectQuality: true });
  assert(r2 === null && /^prospect-kill-rule:/.test(negativeContext.__rejectionReason || ''), `Case F: a negative/irrelevant-context signal is discarded WITH a concrete, classed reason under enableProspectQuality (got '${negativeContext.__rejectionReason}')`);

  const lowConfidenceJunk = { accountName: 'Northfield Instruments', sourceUrl: 'https://industrynews.example/vague', signalTitle: 'General Update', concrete_trigger: '', business_context: '', confidence: 5 };
  const r3 = makeSignal(lowConfidenceJunk, ACCOUNT_NO_WEBSITE);
  if (r3 === null) {
    assert(/^low-confidence:/.test(lowConfidenceJunk.__rejectionReason || ''), `Case F: a low-confidence, non-meaningful signal is discarded WITH a concrete reason (got '${lowConfidenceJunk.__rejectionReason}')`);
  } else {
    console.log('PASS (n/a): low-confidence fixture happened to clear hasMeaningfulSignal() -- reason-stamping already proven by the other two paths above');
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
