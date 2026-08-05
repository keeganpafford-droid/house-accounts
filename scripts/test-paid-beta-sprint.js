// Paid-beta trust-and-usability sprint — automated coverage for Priorities
// 1-5 (Priority 6/weekly-digest coverage lives in
// scripts/test-weekly-scan-reliability.js, alongside the rest of
// api/weekly-scan.js's existing test suite).
//
// Section A imports the REAL exported functions from api/research-batch.js
// (signal-date-truth machinery + grounded-outreach fallback templates).
// Section B extracts the REAL, verbatim source of the dashboard-side
// functions from dashboard/index.html (two large contiguous blocks, each
// self-verified against an exact line range) and runs them in a vm sandbox
// -- nothing here is a reimplementation of the production logic.
//
// Usage: node scripts/test-paid-beta-sprint.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import {
  signalEventCategory, resolveSignalEventDate, computeActionability,
  oneHistoricalOrderFact, salesReadyOpener, salesReadyWhy, makeSignal, EVENT_LIKE_TYPES,
  hasTrustworthyActionabilityMetadata, classifyLegacySignalActionability, resolveCanonicalEventType
} from '../api/research-batch.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Section A — Priority 1: signal-date truth (real research-batch.js exports)
// ===========================================================================

const NOW = new Date('2026-08-04T00:00:00Z');

{
  // Required test 1 (reconciliation item 1, revised): Natural Products Expo
  // West 2023 discovered in 2026 -- RETAINED as research history, excluded
  // from current priorities. A valid, sourced stale signal is never deleted
  // solely for being stale; only its actionability metadata marks it
  // non-priority.
  const cat = signalEventCategory('EVENT_TRADE_SHOW');
  const resolved = resolveSignalEventDate(
    {}, 'Natural Products Expo West 2023 exhibitor booth', 'Natural Products Expo West 2023', 'New Hope Network exhibitor list', cat
  );
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(cat === 'event-like', 'a trade show is classified as an event-like signal');
  assert(resolved.eventDate === '2023-06-15' && resolved.dateConfidence === 'approximate', 'the bare year embedded in "Expo West 2023" resolves to an approximate 2023 date, not left unknown');
  assert(actionability.status === 'stale' && actionability.excludeFromPriorities === true, 'required test 1: a trade show whose name embeds year 2023, evaluated in 2026, is excluded from current priorities');

  // The full makeSignal() pipeline -- proven via a real raw AI-signal shape
  // through the actual production function -- RETAINS the signal (item 1)
  // rather than discarding it, but flags it so it never surfaces as a
  // priority or in the "Newly Detected"/digest counts.
  const raw = { accountName: 'New Hope Network', signalTitle: 'Natural Products Expo West 2023', concrete_trigger: 'Natural Products Expo West 2023 exhibitor booth', business_context: 'New Hope Network exhibited at Natural Products Expo West 2023.', sourceUrl: 'https://example.com/expo-west-2023', confidence: 85 };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'reconciliation item 1, sub-test 1: makeSignal() RETAINS the stale Expo West 2023 signal instead of discarding it -- a valid, sourced signal is never deleted solely for being stale');
  assert(madeSignal.isReal === true && madeSignal.accountName === 'New Hope Network' && madeSignal.sourceUrl === 'https://example.com/expo-west-2023', 'reconciliation item 1, sub-test 4: the retained stale signal keeps its real evidence (source, account) so it remains available to Research Details/account history');
  assert(madeSignal.actionabilityStatus.status === 'stale', 'reconciliation item 1, sub-test 1: the retained signal carries status:stale');
  assert(madeSignal.actionabilityStatus.isPriorityEligible === false && madeSignal.actionabilityStatus.excludeFromPriorities === true, 'reconciliation item 1, sub-test 2: the retained stale signal is flagged non-priority-eligible so it is absent from This Week/Month/Quarter/Year priorities and "Newly Detected"');
  assert(madeSignal.isUpcoming === false, 'the retained stale signal is never flagged isUpcoming');
}

{
  // Reconciliation item 1, sub-test 5: an unknown-date webinar behaves like
  // the stale case (retained, non-priority-eligible) but is labeled
  // "date unknown", never "stale" and never "upcoming".
  const raw = { accountName: 'HPGR', signalTitle: 'HPGR HRCe product webinar', concrete_trigger: 'HPGR HRCe product webinar', business_context: 'HPGR is promoting a product webinar, no date visible on the page.', sourceUrl: 'https://example.com/hpgr-webinar', confidence: 80 };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'reconciliation item 1, sub-test 5: makeSignal() retains an undated event-like signal as research detail rather than discarding it');
  assert(madeSignal.actionabilityStatus.status === 'unknown-date', `reconciliation item 1, sub-test 5: the retained undated webinar is labeled "unknown-date", not "stale" (got: "${madeSignal.actionabilityStatus.status}")`);
  assert(madeSignal.actionabilityStatus.isPriorityEligible === false, 'reconciliation item 1, sub-test 5: the undated webinar is not priority-eligible');
  assert(madeSignal.isUpcoming === false, 'reconciliation item 1, sub-test 5: the undated webinar is never flagged isUpcoming');
}

{
  // Required test 2: a future webinar with an explicit date -- eligible and
  // labeled upcoming.
  const cat = signalEventCategory('EVENT_CONFERENCE');
  const resolved = resolveSignalEventDate({ event_date: '2026-09-15' }, 'HRCe product webinar', 'HRCe product webinar', '', cat);
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(resolved.dateConfidence === 'exact', 'an explicit ISO event_date is parsed with exact confidence');
  assert(actionability.status === 'upcoming' && actionability.isPriorityEligible === true && actionability.excludeFromPriorities === false, 'required test 2: a future, confidently-dated webinar is eligible and labeled upcoming');
}

{
  // Required test 3 (explicit "future events remain eligible", distinct
  // fixture from test 2): a facility ribbon cutting scheduled next month.
  const cat = signalEventCategory('LOCATION_EVENT_UNSPECIFIED');
  const futureDate = new Date(NOW.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const resolved = resolveSignalEventDate({ event_date: futureDate }, 'ribbon cutting for new distribution center', 'Ribbon Cutting', '', cat);
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(actionability.status === 'upcoming', 'required test 3: a ribbon cutting 30 days in the future remains eligible as upcoming');
}

{
  // Required test 4: a ribbon cutting 20 days ago -- eligible as a
  // follow-up, using past tense.
  const cat = signalEventCategory('LOCATION_EVENT_UNSPECIFIED');
  const pastDate = new Date(NOW.getTime() - 20 * 86400000).toISOString().slice(0, 10);
  const resolved = resolveSignalEventDate({ event_date: pastDate }, 'ribbon cutting ceremony', 'ribbon cutting ceremony', '', cat);
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(actionability.status === 'recent-past' && actionability.tense === 'past' && actionability.isPriorityEligible === true, 'required test 4: a ribbon cutting 20 days in the past is eligible as a follow-up');

  const opener = salesReadyOpener('ribbon cutting ceremony', 'Acme Manufacturing held a ribbon cutting.', '', 'New Location', { accountName: 'Acme Manufacturing', actionability });
  assert(/recently had/i.test(opener), `required test 4: the generated opener uses past tense ("recently had") for a recent-past event, not present/future tense (got: "${opener}")`);
  assert(!/coming up|will host|is hosting/i.test(opener), 'required test 4: the opener for a recent-past event does not use future-tense phrasing');
}

{
  // Required test 5: a webinar with no date -- not labeled upcoming.
  const cat = signalEventCategory('EVENT_CONFERENCE');
  const resolved = resolveSignalEventDate({}, 'HPGR HRCe product webinar', 'HPGR HRCe product webinar', 'HPGR is promoting a product webinar, no date visible on the page.', cat);
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(resolved.dateConfidence === 'unknown', 'a webinar with no parseable date anywhere in its text stays dateConfidence:unknown');
  assert(actionability.status === 'unknown-date' && actionability.isPriorityEligible === false, 'required test 5: an undated webinar is not priority-eligible');
  assert(actionability.label !== 'Upcoming' && actionability.status !== 'upcoming', 'required test 5: an undated webinar is never labeled upcoming');

  const opener = salesReadyOpener('HRCe product webinar', 'HPGR is promoting a product webinar.', '', 'Webinar', { accountName: 'HPGR', actionability, recommendedBuyingTeam: ['Marketing'] });
  assert(!/\bupcoming\b/i.test(opener), `required test 5: the generated opener for an undated webinar never says "upcoming" (got: "${opener}")`);
}

{
  // Required test 6 (reconciliation item 2, revised): a recent hiring
  // announcement -- published within the 180-day recency ceiling -- remains
  // actionable using publication recency. An ongoing signal's eligibility
  // now depends on that ceiling, not merely on lacking an event date, so
  // this test supplies a fresh publicationDate (30 days old, matching the
  // reconciliation's own "hiring article 30 days old: eligible" scenario).
  const cat = signalEventCategory('HIRING_ACTIVITY');
  assert(cat === 'ongoing', 'hiring is classified as an ongoing business-change signal, not event-like');
  const resolved = resolveSignalEventDate({}, 'hiring initiative for field marketing coordinators', 'Acme is hiring', '', cat);
  const recentPubDate = new Date(NOW.getTime() - 30 * 86400000).toISOString();
  const actionability = computeActionability({ eventCategory: cat, eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, publicationDate: recentPubDate, now: NOW });
  assert(actionability.status === 'ongoing' && actionability.isPriorityEligible === true, 'required test 6: a hiring signal published 30 days ago remains actionable');
  assert(actionability.usesPublicationDate === true, 'required test 6: an ongoing signal is explicitly flagged as using publication-date recency, not an event date, so the UI never mislabels it');

  // Full makeSignal() pipeline: a recent hiring announcement is NOT
  // discarded by the actionability gate (only event-like/stale signals are).
  const raw = { accountName: 'Acme Corp', signalTitle: 'Acme is hiring field marketing coordinators', concrete_trigger: 'hiring field marketing coordinators', business_context: 'Acme is actively hiring for its marketing team.', sourceUrl: 'https://example.com/acme-hiring', confidence: 80, publicationDate: new Date(NOW.getTime() - 5 * 86400000).toISOString() };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'required test 6 (end-to-end): a recent hiring signal survives makeSignal() -- ongoing signals are never excluded for lacking an event date');
  assert(madeSignal.eventCategory === 'ongoing' && madeSignal.actionabilityStatus.status === 'ongoing', 'required test 6 (end-to-end): the persisted signal carries eventCategory:ongoing and actionabilityStatus.status:ongoing');
}

// ---------------------------------------------------------------------------
// Reconciliation item 2: a conservative 180-day recency ceiling for ongoing
// (non-event-like) signals -- hiring, expansion, rebrand, leadership change,
// new location, sustained growth -- so an old article can no longer surface
// as if it were current, and discoveredAt/first_seen_at is never substituted
// for the real source publication date.
// ---------------------------------------------------------------------------
{
  // hiring article 30 days old: eligible.
  const cat = signalEventCategory('HIRING_ACTIVITY');
  const pub30 = new Date(NOW.getTime() - 30 * 86400000).toISOString();
  const actionability = computeActionability({ eventCategory: cat, publicationDate: pub30, now: NOW });
  assert(actionability.status === 'ongoing' && actionability.isPriorityEligible === true && actionability.excludeFromPriorities === false, 'reconciliation item 2: a hiring article published 30 days ago is priority eligible');
}
{
  // hiring article 240 days old: retained but not priority eligible.
  const cat = signalEventCategory('HIRING_ACTIVITY');
  const pub240 = new Date(NOW.getTime() - 240 * 86400000).toISOString();
  const actionability = computeActionability({ eventCategory: cat, publicationDate: pub240, now: NOW });
  assert(actionability.status === 'ongoing-stale' && actionability.isPriorityEligible === false && actionability.excludeFromPriorities === true, `reconciliation item 2: a hiring article published 240 days ago is retained (research detail) but NOT priority eligible (got status "${actionability.status}")`);

  const raw = { accountName: 'Acme Corp', signalTitle: 'Acme hired a new VP of Operations', concrete_trigger: 'hired a new VP of Operations', business_context: 'Acme announced a new VP of Operations.', sourceUrl: 'https://example.com/acme-vp-hire', confidence: 80, publicationDate: pub240 };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'reconciliation item 2: makeSignal() retains a 240-day-old ongoing signal instead of discarding it');
  assert(madeSignal.actionabilityStatus.isPriorityEligible === false, 'reconciliation item 2: the retained 240-day-old ongoing signal is not priority eligible end-to-end');
}
{
  // ongoing signal with no publication date: detail only.
  const cat = signalEventCategory('EXPANSION_ACTIVITY');
  const actionability = computeActionability({ eventCategory: cat, publicationDate: '', now: NOW });
  assert(actionability.status === 'ongoing-undated' && actionability.isPriorityEligible === false, `reconciliation item 2: an ongoing signal with no publication date is detail-only, not priority eligible (got status "${actionability.status}")`);
}
{
  // House Accounts discovery date cannot make an old ongoing signal current
  // -- discoveredAt/dateFound/first_seen_at must never be substituted for
  // the source's own publication date.
  const cat = signalEventCategory('HIRING_ACTIVITY');
  const oldPub = new Date(NOW.getTime() - 400 * 86400000).toISOString();
  const actionability = computeActionability({
    eventCategory: cat,
    publicationDate: oldPub,
    // A fresh discoveredAt is intentionally irrelevant input here --
    // computeActionability() takes no discoveredAt/dateFound parameter at
    // all, so there is no code path by which it could substitute for
    // publicationDate.
    now: NOW
  });
  assert(actionability.status === 'ongoing-stale' && actionability.isPriorityEligible === false, 'reconciliation item 2: an old publication date stays non-eligible regardless of how recently House Accounts discovered the signal');
}

{
  // Distinct-concepts test: event_date must never silently become the
  // publication date merely because the true event date is absent.
  const raw = { accountName: 'Acme Corp', signalTitle: 'Acme wins major contract', concrete_trigger: 'wins major contract', business_context: 'Acme announced a new customer contract.', sourceUrl: 'https://example.com/acme-contract', confidence: 80, publicationDate: '2026-07-01' };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'sanity: the contract-win signal is not discarded');
  assert(madeSignal.publishedDate === '2026-07-01' && madeSignal.publicationDate === '2026-07-01', 'the publication date is preserved on the signal');
  assert(madeSignal.eventDate === '' || madeSignal.eventDate !== madeSignal.publishedDate, 'event date is never silently set to the publication date merely because no real event date exists -- the two remain genuinely distinct fields');
}

// ---------------------------------------------------------------------------
// QA round 3, item 1: the exact three visible Preview defects -- an undated
// HPGR-style webinar, an undated anniversary celebration, and an undated
// workshop -- proven end-to-end through the real makeSignal() pipeline.
// Required coverage 1, 2, 3.
// ---------------------------------------------------------------------------
{
  const raw = {
    accountName: 'HPGR', signalTitle: 'HPGR HRCe product webinar', concrete_trigger: 'HPGR HRCe product webinar',
    business_context: 'HPGR is promoting a product webinar for its customer base, no date visible on the page.',
    sourceUrl: 'https://example.com/hpgr-webinar', confidence: 85
  };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'required coverage 1: an undated HPGR-style webinar is retained (research detail), not discarded');
  assert(madeSignal.eventCategory === 'event-like', `required coverage 1: the webinar is classified event-like (got "${madeSignal.eventCategory}")`);
  assert(madeSignal.actionabilityStatus.status === 'unknown-date', `required coverage 1: with no explicit date, the webinar is "unknown-date"/Date unavailable, never treated as a current priority (got "${madeSignal.actionabilityStatus.status}")`);
  assert(madeSignal.actionabilityStatus.isPriorityEligible === false && madeSignal.actionabilityStatus.excludeFromPriorities === true, 'required coverage 1: the undated webinar is excluded from priority/digest eligibility');
  assert(madeSignal.isUpcoming === false, 'required coverage 1: the undated webinar is never flagged isUpcoming');
}
{
  const raw = {
    accountName: 'New York Marriott Marquis', signalTitle: 'New York Marriott Marquis anniversary celebration', concrete_trigger: 'anniversary celebration',
    business_context: 'The hotel is celebrating its anniversary, no specific date given.',
    sourceUrl: 'https://example.com/marriott-anniversary', confidence: 80
  };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'required coverage 2: an undated anniversary celebration is retained (research detail), not discarded');
  assert(madeSignal.eventCategory === 'event-like', `required coverage 2: the anniversary celebration is classified event-like (got "${madeSignal.eventCategory}")`);
  assert(madeSignal.actionabilityStatus.status === 'unknown-date', `required coverage 2: with no explicit date, the anniversary is Date unavailable, never a current priority (got "${madeSignal.actionabilityStatus.status}")`);
  assert(madeSignal.actionabilityStatus.isPriorityEligible === false, 'required coverage 2: the undated anniversary is excluded from priority eligibility');
}
{
  const raw = {
    accountName: 'The Other Women', signalTitle: 'The Other Women workshops', concrete_trigger: 'The Other Women workshops',
    business_context: 'The Other Women hosts workshops for entrepreneurs, no date specified.',
    sourceUrl: 'https://example.com/the-other-women-workshops', confidence: 75
  };
  const madeSignal = makeSignal(raw, {});
  assert(madeSignal !== null, 'required coverage 3: an undated workshop is retained (research detail), not discarded');
  assert(madeSignal.eventCategory === 'event-like', `required coverage 3: "workshops" (plural) is correctly classified event-like, not mistakenly treated as ongoing due to the word-boundary/plural classifier gap (got "${madeSignal.eventCategory}")`);
  assert(madeSignal.actionabilityStatus.status === 'unknown-date', `required coverage 3: with no explicit date, the workshop is Date unavailable, never a current priority (got "${madeSignal.actionabilityStatus.status}")`);
  assert(madeSignal.actionabilityStatus.isPriorityEligible === false, 'required coverage 3: the undated workshop is excluded from priority eligibility');
}

// ---------------------------------------------------------------------------
// QA round 2, item 1: classifyLegacySignalActionability() -- the single
// canonical, backward-compatible normalizer for signals persisted before
// actionabilityStatus/eventCategory existed. Required coverage items 1, 7,
// 8, 9.
// ---------------------------------------------------------------------------
{
  // Required coverage 1: the exact New Hope Network "Natural Products Expo
  // West 2023" shape -- old-style payload with NO actionabilityStatus, and
  // eventDate identical to publishedDate (the old publication-date-fallback
  // bug) -- evaluated in the current year, must classify stale.
  const legacyExpoWest = {
    accountName: 'New Hope Network', signalTitle: 'Natural Products Expo West 2023', title: 'Natural Products Expo West 2023',
    concreteTrigger: 'Natural Products Expo West 2023 exhibitor booth', concrete_trigger: 'Natural Products Expo West 2023 exhibitor booth',
    canonicalEventType: 'EVENT_TRADE_SHOW',
    businessContext: 'New Hope Network exhibited at Natural Products Expo West 2023.',
    eventDate: '2023-03-10', event_date: '2023-03-10', publishedDate: '2023-03-10', publicationDate: '2023-03-10',
    sourceUrl: 'https://example.com/expo-west-2023'
  };
  assert(hasTrustworthyActionabilityMetadata(legacyExpoWest) === false, 'a payload with no actionabilityStatus at all is correctly identified as legacy');
  const result = classifyLegacySignalActionability(legacyExpoWest);
  assert(result.eventCategory === 'event-like', 'required coverage 1: the legacy Expo West signal is classified event-like from its canonicalEventType');
  assert(result.actionabilityStatus.status === 'stale', `required coverage 1: the legacy Expo West signal, evaluated in the current year, is classified stale (got "${result.actionabilityStatus.status}")`);
  assert(result.actionabilityStatus.isPriorityEligible === false && result.actionabilityStatus.excludeFromPriorities === true, 'required coverage 1: the legacy Expo West signal is excluded from priority/digest eligibility');
  assert(result.isUpcoming === false, 'required coverage 1: the legacy Expo West signal is never flagged isUpcoming');
}
{
  // Required coverage 7: a legacy undated webinar -- Date unavailable,
  // detail-only, never stale and never upcoming.
  const legacyWebinar = {
    accountName: 'HPGR', signalTitle: 'HPGR HRCe product webinar', title: 'HPGR HRCe product webinar',
    concreteTrigger: 'HPGR HRCe product webinar', canonicalEventType: 'EVENT_CONFERENCE',
    businessContext: 'HPGR is promoting a product webinar, no date visible.',
    sourceUrl: 'https://example.com/hpgr-webinar'
  };
  const result = classifyLegacySignalActionability(legacyWebinar);
  assert(result.actionabilityStatus.status === 'unknown-date', `required coverage 7: a legacy undated webinar is classified "unknown-date"/Date unavailable, not stale (got "${result.actionabilityStatus.status}")`);
  assert(result.actionabilityStatus.isPriorityEligible === false, 'required coverage 7: a legacy undated webinar is not priority eligible');
  assert(result.actionabilityStatus.label === 'Date unavailable', 'required coverage 7: the label reads "Date unavailable"');
}
{
  // Required coverage 8: a legacy ongoing signal published more than 180
  // days ago is detail-only.
  const oldPublished = new Date(Date.now() - 400 * 86400000).toISOString();
  const legacyOldHiring = {
    accountName: 'Acme Corp', signalTitle: 'Acme is hiring field marketing coordinators', title: 'Acme is hiring field marketing coordinators',
    concreteTrigger: 'hiring field marketing coordinators', canonicalEventType: 'HIRING_ACTIVITY',
    businessContext: 'Acme is actively hiring for its marketing team.',
    publishedDate: oldPublished, publicationDate: oldPublished, eventDate: oldPublished, event_date: oldPublished,
    sourceUrl: 'https://example.com/acme-hiring'
  };
  const result = classifyLegacySignalActionability(legacyOldHiring);
  assert(result.eventCategory === 'ongoing', 'required coverage 8: hiring is classified ongoing');
  assert(result.actionabilityStatus.status === 'ongoing-stale', `required coverage 8: a legacy hiring signal published >180 days ago is classified "ongoing-stale" (got "${result.actionabilityStatus.status}")`);
  assert(result.actionabilityStatus.isPriorityEligible === false, 'required coverage 8: the old legacy hiring signal is not priority eligible');
}
{
  // Required coverage 9 (revised for QA round 3, item 1): a correctly
  // classified fresh signal is NOT visibly reclassified/overridden --
  // classifyLegacySignalActionability() now always recomputes
  // eventCategory/actionabilityStatus from more primitive facts (never
  // blindly trusts the stored derived judgment directly), which is a
  // provable no-op for a signal that was already correct, and a
  // self-healing correction for one that wasn't (see the "internally
  // inconsistent metadata" test below). Real title/trigger content is
  // required here for the fixture to be realistic -- a fresh signal always
  // carries this.
  const freshStatus = { status: 'upcoming', tense: 'future', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: false, label: 'Upcoming' };
  const freshSignal = {
    accountName: 'Acme Corp', signalTitle: 'Acme trade show', title: 'Acme trade show', concreteTrigger: 'Acme trade show',
    canonicalEventType: 'EVENT_TRADE_SHOW', businessContext: '',
    eventCategory: 'event-like', actionabilityStatus: freshStatus, eventDate: '2027-01-01', eventDateConfidence: 'exact'
  };
  assert(hasTrustworthyActionabilityMetadata(freshSignal) === true, 'required coverage 9: a signal with a complete actionabilityStatus/eventCategory is recognized as trustworthy (shape-complete)');
  const result = classifyLegacySignalActionability(freshSignal);
  assert(result.eventCategory === 'event-like', 'required coverage 9: a correctly-classified fresh signal\'s eventCategory recomputes to the same value (no visible change)');
  assert(result.actionabilityStatus.status === freshStatus.status && result.actionabilityStatus.isPriorityEligible === freshStatus.isPriorityEligible, `required coverage 9: a correctly-classified fresh signal's actionabilityStatus recomputes to the same values -- recomputation is a genuine no-op, not an override (got: ${JSON.stringify(result.actionabilityStatus)})`);
  assert(result.eventDate === '2027-01-01' && result.eventDateConfidence === 'exact', 'required coverage 9: a fresh signal\'s own trustworthy eventDate/eventDateConfidence are preserved, not re-derived from text');
}
{
  // QA round 3, item 1: internally inconsistent stored metadata must NOT be
  // blindly trusted -- an event-like signal wrongly marked
  // isPriorityEligible:true/status:"ongoing" with no real date is corrected
  // at the boundary, exactly like the visible HPGR webinar/anniversary/
  // workshop Preview defects.
  const inconsistentWebinar = {
    accountName: 'HPGR', signalTitle: 'HPGR HRCe product webinar', title: 'HPGR HRCe product webinar', concreteTrigger: 'HPGR HRCe product webinar',
    canonicalEventType: 'EVENT_CONFERENCE', businessContext: 'HPGR is promoting a product webinar.',
    // Simulates a bug: eventCategory/actionabilityStatus wrongly claim this
    // is an eligible ongoing signal, despite dateConfidence:'unknown'.
    eventCategory: 'ongoing', eventDateConfidence: 'unknown', publicationDate: new Date().toISOString(),
    actionabilityStatus: { status: 'ongoing', tense: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: true, label: 'Ongoing business change' }
  };
  assert(hasTrustworthyActionabilityMetadata(inconsistentWebinar) === true, 'the inconsistent fixture is shape-complete (this is exactly the "looks trustworthy but is not" case the invariant must catch)');
  const healed = classifyLegacySignalActionability(inconsistentWebinar);
  assert(healed.eventCategory === 'event-like', `internally inconsistent metadata is corrected: eventCategory recomputed as event-like from the webinar content, not trusted as "ongoing" (got: "${healed.eventCategory}")`);
  assert(healed.actionabilityStatus.status === 'unknown-date', `internally inconsistent metadata is corrected: status recomputed as "unknown-date" (Date unavailable), not trusted as "ongoing" (got: "${healed.actionabilityStatus.status}")`);
  assert(healed.actionabilityStatus.isPriorityEligible === false, 'internally inconsistent metadata is corrected: the healed signal is not priority eligible, regardless of what the stored flag claimed');
}
{
  // Required coverage 4 & 6: an explicit future event date with 'exact'
  // confidence IS Upcoming; the SAME date with only 'approximate'
  // confidence is NOT -- Upcoming requires an explicit, not inferred, date.
  const exactFuture = { accountName: 'Acme', signalTitle: 'Acme trade show', title: 'Acme trade show', concreteTrigger: 'Acme trade show', canonicalEventType: 'EVENT_TRADE_SHOW', businessContext: '', eventDate: '2099-03-15', eventDateConfidence: 'exact', sourceUrl: 'https://example.com/acme' };
  const exactResult = classifyLegacySignalActionability(exactFuture);
  assert(exactResult.actionabilityStatus.status === 'upcoming' && exactResult.actionabilityStatus.isPriorityEligible === true, `required coverage 4: an explicit (exact-confidence) future event date IS Upcoming (got: "${exactResult.actionabilityStatus.status}")`);

  const approxFuture = { ...exactFuture, eventDateConfidence: 'approximate' };
  const approxResult = classifyLegacySignalActionability(approxFuture);
  assert(approxResult.actionabilityStatus.status === 'unknown-date' && approxResult.actionabilityStatus.isPriorityEligible === false, `an approximate/inferred future date is never confident enough to claim Upcoming (got: "${approxResult.actionabilityStatus.status}")`);
}
{
  // Required coverage 5/6: an explicit recent-past event date remains
  // Recent event; an old one becomes No longer current.
  // classifyLegacySignalActionability() has no `now` override -- these
  // fixtures use real current-time-relative offsets rather than the fixed
  // NOW constant Section A's computeActionability()-direct tests use.
  const recentPastBase = { accountName: 'Acme', signalTitle: 'Acme ribbon cutting', title: 'Acme ribbon cutting', concreteTrigger: 'Acme ribbon cutting', canonicalEventType: 'LOCATION_EVENT_UNSPECIFIED', businessContext: '', eventDateConfidence: 'exact', sourceUrl: 'https://example.com/acme-rc' };
  const recentPast = { ...recentPastBase, eventDate: new Date(Date.now() - 20 * 86400000).toISOString().slice(0,10) };
  const recentResult = classifyLegacySignalActionability(recentPast);
  assert(recentResult.actionabilityStatus.status === 'recent-past' && recentResult.actionabilityStatus.isPriorityEligible === true, `required coverage 5: an explicit event 20 days in the past remains Recent event (got: "${recentResult.actionabilityStatus.status}")`);

  const oldEvent = { ...recentPastBase, eventDate: new Date(Date.now() - 400 * 86400000).toISOString().slice(0,10) };
  const oldResult = classifyLegacySignalActionability(oldEvent);
  assert(oldResult.actionabilityStatus.status === 'stale' && oldResult.actionabilityStatus.isPriorityEligible === false, `required coverage 6: an event 400 days in the past becomes No longer current (got: "${oldResult.actionabilityStatus.status}")`);
}

// ===========================================================================
// Section A2 — Priority 2: grounded outreach (real research-batch.js exports)
// ===========================================================================

{
  // Deterministic fallback contains the exact signal (required coverage
  // item 8), and grounds in company name / department / historical fact
  // when supplied.
  const account = { orderCount: 3, categories: ['Apparel'] };
  const historicalFact = oneHistoricalOrderFact(account);
  assert(historicalFact === "you've ordered Apparel for them before (3 orders on file)", `oneHistoricalOrderFact() produces a real, specific fact from real order data (got: "${historicalFact}")`);
  assert(oneHistoricalOrderFact({}) === '', 'oneHistoricalOrderFact() returns nothing invented when the account has no real order history');

  const opener = salesReadyOpener('HRCe product webinar', 'HPGR is promoting a product webinar.', '', 'Webinar', {
    accountName: 'HPGR', actionability: { status: 'unknown-date', tense: 'unknown' }, recommendedBuyingTeam: ['Marketing'], historicalFact
  });
  assert(opener.includes('HPGR') && opener.includes('HRCe product webinar'), `the fallback opener references the exact company and exact signal trigger, not a generic category phrase (got: "${opener}")`);
  assert(opener.includes(historicalFact), 'the fallback opener incorporates the real historical-order fact when one is available');
  assert(!/anything coming up where it would help to think through merch/i.test(opener), 'the exact ungrounded legacy phrase from the review is not produced by the fixed fallback');
}

{
  // Two different companies, two different real signals, in the SAME
  // category, must not receive the same generic outreach text.
  const openerA = salesReadyOpener('HRCe product webinar', 'HPGR is promoting a webinar.', '', 'Webinar', { accountName: 'HPGR', actionability: { status: 'unknown-date' } });
  const openerB = salesReadyOpener('annual distributor summit', 'Acme Distributors is hosting its annual summit.', '', 'Conference / Summit', { accountName: 'Acme Distributors', actionability: { status: 'unknown-date' } });
  assert(openerA !== openerB, 'two different companies with two different signals in the same category (events) receive genuinely different outreach text');
  assert(openerA.includes('HPGR') && !openerA.includes('Acme Distributors'), 'company A\'s opener names company A, not company B');
  assert(openerB.includes('Acme Distributors') && !openerB.includes('HPGR'), 'company B\'s opener names company B, not company A');
}

{
  // Do not invent a merch program or claim it is already planned.
  const opener = salesReadyOpener('HRCe product webinar', 'HPGR is promoting a product webinar.', '', 'Webinar', { accountName: 'HPGR', actionability: { status: 'unknown-date' }, recommendedBuyingTeam: ['Marketing'] });
  assert(!/we('| a)?re already (working on|planning|preparing)/i.test(opener), 'the opener never claims a merch program is already planned');
  assert(!/we have (already )?sent|we shipped/i.test(opener), 'the opener never claims work has already happened');
}

console.log(`\nSection A/A2 (research-batch.js): ${failures === 0 ? 'ALL PASS SO FAR' : `${failures} FAILURE(S) SO FAR`}`);

// ===========================================================================
// Section B — dashboard/index.html, real verbatim source extracted into a vm
// sandbox. Two large contiguous blocks cover everything needed below; each
// is verified to still start with its expected first line before use, so a
// source reshuffle fails loudly here instead of silently testing stale text.
// ===========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const DASHBOARD_SRC = readFileSync(DASHBOARD_PATH, 'utf8');
const LINES = DASHBOARD_SRC.split('\n');

function extractBlock(label, startLine, endLine, expectedPrefix){
  const slice = LINES.slice(startLine - 1, endLine).join('\n');
  if(!slice.startsWith(expectedPrefix)){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in scripts/test-paid-beta-sprint.js.`);
  }
  const trimmed = slice.trimEnd();
  if(!trimmed.endsWith('}') && !trimmed.endsWith('};')){
    throw new Error(`extractBlock(${label}): dashboard/index.html line ${endLine} does not close as expected -- update the line range.`);
  }
  return slice;
}

// Covers: confidenceLabel, signalLayerLabel, isRecentAccountActivity,
// sourceDomain, shortText, parseMaybeDate, formatSignalAge,
// cleanBusinessText, businessSignalKind, businessSuggestedOpener,
// getRepFriendlyWhy, isGroundedOpener, getSuggestedOpener, mailtoHref,
// opportunityHeadline, whyThisMattersText, extractHistoricalOrderCount,
// evidenceSourceLabel, findAccountForOpp, realPriorCategories,
// structuredEvidenceRows, formatShortDate, signalDateAndActionabilityLine,
// renderSuggestedContactCompact/Primary/Meta,
// renderVerifiedOpportunitySection, accountContextFallbackMessage,
// renderAccountContextSection, renderSupportingResearchDetails,
// renderRepOpportunityCard, renderSingleVerifiedSignal,
// renderVerifiedSignals, isSignalPriorityEligible.
const CARD_AND_MODAL_BLOCK = extractBlock('card-and-modal-helpers', 4035, 4929, 'function confidenceLabel(');

// QA round 2, item 2/6: covers cleanOpportunityToken, primaryCategoryFromOpportunity,
// departmentFromText, likelyDepartmentFromOpportunity, isGenericContactLabel,
// likelySuggestedContact, likelyKnownBuyer, opportunityDedupeKey, the new
// event-level dedup helpers (significantTitleTokens, titleTokenOverlapRatio,
// relatedEventTypes, opportunitiesLikelySameInitiative,
// clusterBusinessSignalOpportunities, sourceStrengthScore,
// initiativeCandidateRank, compareInitiativeCandidates,
// mergeBusinessSignalInitiatives), dedupeOpportunities, verifiedSignalDedupeKey,
// dedupeVerifiedSignals, isBusinessOpportunity, buyingOpportunityIdentity,
// buyingConversationLabel, suggestedIntroductionPath.
const DEDUPE_AND_IDENTITY_BLOCK = extractBlock('dedupe-and-identity-helpers', 2683, 3101, 'function cleanOpportunityToken(');

// QA round 2, item 3/4/7: covers salesPlayModeFromOpp, salesPlayModeLabel,
// cleanSalesPlayText, pickPrimaryPromoCategory, trimToWords,
// groundedDepartmentForOpportunity, groundedInitiativeTitle,
// window.createSalesPlayPanel (defined but never invoked by these tests --
// its own further dependencies are irrelevant as inert, uncalled code),
// initiativeLeadIn, ownerAskPhrase, ideaOfferPhrase, linkedinMessageForOpp,
// buildReplyFirstEmail, buildNaturalCallScript, conciseSubject,
// ownerPhraseForSignal, triggerPhraseForSignal, buildConciseSalesPlay,
// questionsForSignal, subjectRationale, inferSalesPlaySignalType.
const SALES_PLAY_BLOCK = extractBlock('sales-play-grounding', 6318, 7436, 'function salesPlayModeFromOpp(');

// Covers: normalizeSignalLayerType, signalTypePriority, daysSinceDate,
// scoreFromFreshness, normalizedConfidenceValue, evidenceCount,
// getRecommendationType, recommendationSlug/BadgeMeta/OneLine,
// calculateOpportunityScore, assignOpportunityScore, getOpportunityScore,
// sortDailyReasons, collapseDuplicateFollowUps, limitReasonsPerAccount,
// getOpportunityPlanningWindow, opportunityMatchesTimebox,
// prepareTimeboxReasons, prepareAllOpportunities, pluralize, feedSummary.
const SCORING_AND_TIMEBOX_BLOCK = extractBlock('scoring-and-timebox-helpers', 7553, 8056, 'function normalizeSignalLayerType(');

const TIMEBOX_CONFIG_SRC = extractBlock('TIMEBOX_CONFIG', 2542, 2547, 'const TIMEBOX_CONFIG = {');
const IS_RELATIONSHIP_EXPANSION_SRC = extractBlock('isRelationshipExpansionOpportunity', 2765, 2768, 'function isRelationshipExpansionOpportunity(');
const ESCAPE_HTML_SRC = extractBlock('escapeHtml', 8679, 8682, 'function escapeHtml(');
const FMT_MONEY_SRC = extractBlock('fmtMoney', 6233, 6235, 'function fmtMoney(');
const CLAMP_SCORE_SRC = extractBlock('clampScore', 6238, 6240, 'function clampScore(');
// QA round 3, item 4: the exact "Newly Detected" single-source-of-truth
// helper, plus the small dedup-key generator the dashboard metric tile
// (and, since the fix, the summary banner) both route through.
const FORMAT_DASHBOARD_SCAN_DATE_SRC = extractBlock('formatDashboardScanDate', 2660, 2665, 'function formatDashboardScanDate(');
const UNIQUE_DASHBOARD_OPPORTUNITIES_SRC = extractBlock('uniqueDashboardOpportunities', 2667, 2680, 'function uniqueDashboardOpportunities(');
const NEWLY_DETECTED_COUNT_SRC = extractBlock('newlyDetectedCount', 3135, 3137, 'function newlyDetectedCount(');
const RENDER_CUSTOMER_DASHBOARD_SRC = extractBlock('renderCustomerDashboard', 3139, 3172, 'function renderCustomerDashboard(');

function makeSandbox(){
  const domElements = {};
  const sandbox = {
    console,
    window: { accountRadarAccounts: [] },
    document: {
      getElementById: (id) => { domElements[id] = domElements[id] || { textContent: '', innerHTML: '' }; return domElements[id]; },
      querySelectorAll: () => []
    },
    // isWarmAccount is only reached by renderAccountContextSection's
    // no-order-history fallback branch, which none of the fixtures below
    // exercise (each gives the account real order history) -- stubbed
    // defensively rather than left undefined.
    isWarmAccount: () => false,
    URL, Array, Object, String, Number, Math, Date, RegExp, Map, Set, Boolean, JSON
  };
  vm.createContext(sandbox);
  // Node's vm module does not attach top-level const/let bindings to the
  // context object (only function declarations and `var` do) -- these three
  // tiny getter/setter functions are test-only scaffolding (not part of the
  // extracted dashboard source) that let this file read/drive the real
  // TIMEBOX_CONFIG/activeTimebox/showAllWeeklyPriorities module state that
  // renderWeeklyPrioritiesFeed() and friends close over, exactly as the
  // browser's own module scope would.
  const fullSource = [
    TIMEBOX_CONFIG_SRC,
    `let activeTimebox = 'week';`,
    `let showAllWeeklyPriorities = false;`,
    `function __setActiveTimebox(v){ activeTimebox = v; }`,
    `function __setShowAllWeeklyPriorities(v){ showAllWeeklyPriorities = v; }`,
    `function __getTimeboxConfig(){ return TIMEBOX_CONFIG; }`,
    IS_RELATIONSHIP_EXPANSION_SRC,
    ESCAPE_HTML_SRC,
    FMT_MONEY_SRC,
    CLAMP_SCORE_SRC,
    FORMAT_DASHBOARD_SCAN_DATE_SRC,
    UNIQUE_DASHBOARD_OPPORTUNITIES_SRC,
    DEDUPE_AND_IDENTITY_BLOCK,
    CARD_AND_MODAL_BLOCK,
    SALES_PLAY_BLOCK,
    SCORING_AND_TIMEBOX_BLOCK,
    NEWLY_DETECTED_COUNT_SRC,
    RENDER_CUSTOMER_DASHBOARD_SRC
  ].join('\n\n');
  new vm.Script(fullSource, { filename: 'dashboard-paid-beta-extract.js' }).runInContext(sandbox);
  sandbox.__domElements = domElements;
  return sandbox;
}

// ---------------------------------------------------------------------------
// Required test 7: Conversation Starter uses the persisted generated field.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const grounded = 'Saw HPGR has HRCe product webinar coming up. Is Marketing the right team to ask about that?';
  const opp = { conversationStarter: grounded, account: 'HPGR', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com' };
  assert(sandbox.getSuggestedOpener(opp) === grounded, 'getSuggestedOpener() returns opp.conversationStarter verbatim when it is present and grounded, instead of silently regenerating a separate opener');
}
{
  const sandbox = makeSandbox();
  const legacy = 'noticed some event or community activity on your end. Is there anything coming up where it would help to think through merch, attendee gifts, or staff gear?';
  assert(sandbox.isGroundedOpener(legacy) === false, 'the exact pre-fix ungrounded legacy string is correctly identified as NOT grounded (protects already-persisted old signals from being treated as if they were fixed)');
  assert(sandbox.isGroundedOpener('') === false && sandbox.isGroundedOpener(null) === false, 'an empty/missing conversationStarter is never treated as grounded');
  assert(sandbox.isGroundedOpener('Saw Acme Corp has a trade show coming up.') === true, 'a real, specific opener is correctly identified as grounded');
}

// ---------------------------------------------------------------------------
// Required test 8 (client-side half): deterministic fallback contains the
// exact signal.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const opener = sandbox.businessSuggestedOpener({ account: 'Acme Manufacturing', signalTitle: 'Acme Manufacturing opens new Richmond distribution center', contact: 'Jordan Lee' });
  assert(opener.includes('Acme Manufacturing opens new Richmond distribution center'), `the client-side fallback references the exact signal title, not a generic phrase (got: "${opener}")`);
  assert(!/noticed some event or community activity/i.test(opener), 'the client-side fallback no longer produces the exact ungrounded legacy phrase');
}
{
  // Transparent limited state when there truly is no signal detail.
  const sandbox = makeSandbox();
  const opener = sandbox.businessSuggestedOpener({ account: 'Acme Manufacturing', contact: 'Jordan Lee' });
  assert(/not enough detail yet/i.test(opener), 'when there is no real signal detail, the fallback states that plainly instead of inventing a specific-sounding reason');
}

// ---------------------------------------------------------------------------
// Required test 9: dashboard timeframe counts cannot produce "21 of 7".
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // Reproduces the exact structural mismatch: 3 accounts, each with TWO
  // opportunities -- a high-scoring one that does NOT match "week", and a
  // lower-scoring one that DOES match "week". Under the OLD dedup-then-filter
  // vs filter-then-dedup mismatch, allOpportunities (computed dedup-first)
  // would keep only each account's #1 globally-ranked item, filtered by
  // timebox afterward -- losing accounts whose top item isn't this week's
  // even though a lower-ranked item of theirs is. priorityOpportunities
  // (filter-first) would keep all three. That is the exact shape that could
  // render as "3 of 0" or any other non-nested pairing.
  const opportunities = [];
  for(let i = 1; i <= 3; i++){
    const account = `Account ${i}`;
    opportunities.push({
      account, isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/high',
      confidenceScore: 95, evidence: ['high-confidence, but not this week'],
      publishedDate: new Date(NOW.getTime() - 200 * 86400000).toISOString(), // old -> planning window = month, not week
      signalDate: new Date(NOW.getTime() - 200 * 86400000).toISOString()
    });
    opportunities.push({
      account, isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/low',
      confidenceScore: 40, evidence: ['lower-confidence, but genuinely this week'],
      publishedDate: new Date(NOW.getTime() - 2 * 86400000).toISOString(), // recent -> planning window = week
      signalDate: new Date(NOW.getTime() - 2 * 86400000).toISOString()
    });
  }
  sandbox.__setActiveTimebox('week');
  sandbox.__setShowAllWeeklyPriorities(false);
  const grid = sandbox.document.getElementById('opportunitiesGrid');
  const resultCount = sandbox.document.getElementById('resultCount');
  sandbox.renderWeeklyPrioritiesFeed(opportunities, [{ name: 'Account 1' }, { name: 'Account 2' }, { name: 'Account 3' }]);
  const label = resultCount.innerHTML;
  assert(!/\d+ of \d+/.test(label), `required test 9: the rendered summary never uses an "X of Y" comparison that could produce a false subset claim like "21 of 7" (got: "${label}")`);
  assert(/accounts? worth reviewing/i.test(label), `required test 9: the summary uses the preferred "N accounts worth reviewing <timeframe>" phrasing (got: "${label}")`);
}

// ---------------------------------------------------------------------------
// Required test 10: proper singular/plural and timeframe empty states.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  assert(sandbox.pluralize(1, 'business trigger') === '1 business trigger', 'pluralize(1, ...) is singular');
  assert(sandbox.pluralize(21, 'business trigger') === '21 business triggers', 'pluralize(21, ...) is plural');
  assert(sandbox.pluralize(0, 'business trigger') === '0 business triggers', 'pluralize(0, ...) is plural (zero is not singular)');
  assert(sandbox.pluralize(1, 'reorder opportunity', 'reorder opportunities') === '1 reorder opportunity', 'pluralize with an explicit irregular plural is correct at 1');
  assert(sandbox.pluralize(2, 'reorder opportunity', 'reorder opportunities') === '2 reorder opportunities', 'pluralize with an explicit irregular plural is correct at 2+');

  const summary = sandbox.feedSummary([
    { isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/1' },
    { evidence: ['recent order'] },
    {}
  ]);
  assert(/\d+ business triggers?/.test(summary) && /\d+ reorder opportunit(y|ies)/.test(summary) && /\d+ follow-ups?/.test(summary), `feedSummary() uses the preferred category labels with correct pluralization (got: "${summary}")`);
}
for(const timebox of ['week', 'month', 'quarter', 'annual']){
  const sandbox = makeSandbox();
  sandbox.__setActiveTimebox(timebox);
  sandbox.__setShowAllWeeklyPriorities(false);
  const grid = sandbox.document.getElementById('opportunitiesGrid');
  sandbox.renderWeeklyPrioritiesFeed([], []);
  const label = sandbox.__getTimeboxConfig()[timebox].label.toLowerCase();
  assert(grid.innerHTML.includes(label), `required test 10: the empty-state message for the "${timebox}" tab reflects that specific timeframe ("${label}"), not a hardcoded "this week" (got: "${grid.innerHTML}")`);
  assert(!/nothing urgent this week/i.test(grid.innerHTML) || timebox === 'week', `required test 10: the "${timebox}" tab's empty state is not the old hardcoded "this week" text when the active tab isn't week`);
}

// ---------------------------------------------------------------------------
// Required test 11: dormant-account logic uses the correct scale.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // A genuinely ACTIVE account (ordered 30 days ago -> recency close to 1,
  // the "just ordered" end of the 0-1 scale) with revenue and orders must
  // NOT be classified Dormant under the fixed threshold.
  const activeOpp = { account: 'Acme Corp', accountRevenue: 20000, accountOrderCount: 5, accountRecencyScore: 0.92, evidence: [] };
  assert(sandbox.getRecommendationType(activeOpp) !== 'Dormant High-Value Account', 'required test 11: a recently-active, high-revenue account is NOT classified Dormant (the pre-fix bug classified it as Dormant regardless of recency)');

  // A genuinely STALE account (recency near 0 -> no order in ~a year) with
  // revenue and orders SHOULD be classified Dormant.
  const staleOpp = { account: 'Harborline Logistics', accountRevenue: 20000, accountOrderCount: 5, accountRecencyScore: 0.05, evidence: [] };
  assert(sandbox.getRecommendationType(staleOpp) === 'Dormant High-Value Account', 'required test 11: a genuinely stale, high-revenue account IS correctly classified Dormant on the fixed 0-1 scale');
}

// ---------------------------------------------------------------------------
// Required test 12: Prior Categories never displays inferred categories.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  sandbox.window.accountRadarAccounts = [
    { name: 'Northfield Bank', categoryTypes: new Set(['Apparel', 'Drinkware']) }
  ];
  const opp = { account: 'Northfield Bank', commonPromoCategories: ['Launch Kits', 'Executive Gifts'] }; // AI-suggested, deliberately different from real history
  const priorCategories = sandbox.realPriorCategories(opp);
  assert(priorCategories.join(',') === 'Apparel,Drinkware', `required test 12: realPriorCategories() returns the REAL order-derived categories (Apparel, Drinkware), never the AI-suggested commonPromoCategories (got: ${JSON.stringify(priorCategories)})`);

  const rows = sandbox.structuredEvidenceRows(opp);
  const priorRow = rows.find(r => r.label.includes('Prior categories'));
  assert(priorRow && priorRow.value === 'Apparel, Drinkware', 'the Evidence "Prior categories" row uses the real order history, not the inferred/suggested list');

  // When there is no real order history, the row is hidden entirely --
  // never displays inferred categories as though they were purchase history.
  sandbox.window.accountRadarAccounts = [{ name: 'Brand New Prospect', categoryTypes: new Set() }];
  const noHistoryOpp = { account: 'Brand New Prospect', commonPromoCategories: ['Launch Kits'] };
  assert(sandbox.realPriorCategories(noHistoryOpp).length === 0, 'required test 12: with no real historical categories, realPriorCategories() returns empty rather than falling back to inferred ones');
  const noHistoryRows = sandbox.structuredEvidenceRows(noHistoryOpp);
  assert(!noHistoryRows.some(r => r.label.includes('Prior categories')), 'required test 12: the Prior Categories row is hidden entirely when no real order history exists, not shown with invented data');
}

// ---------------------------------------------------------------------------
// Commercial-readiness correction round (final), required tests 14/15:
// Previously Purchased Categories must remain visibly distinct from
// inferred ideas EVEN when the live window.accountRadarAccounts lookup
// (findAccountForOpp) misses -- e.g. the account list hasn't loaded a
// matching entry yet, or the name no longer matches exactly. Before this
// round's fix, realPriorCategories() depended entirely on that live join
// succeeding; this proves the opportunity's own historicalPurchaseData
// (captured once, at creation time) is a working fallback source, so the
// Evidence card's "Previously purchased categories" row does not silently
// disappear -- leaving only "Related suggested categories" visible, the
// exact defect reported from live Preview.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // Deliberately empty -- simulates findAccountForOpp() finding no match at
  // all (e.g. the account list not yet loaded, or a name mismatch).
  sandbox.window.accountRadarAccounts = [];
  const opp = {
    account: 'Ridgeline Auto Group',
    commonPromoCategories: ['caps', 'beanies', 'employee hats'], // inferred idea, deliberately different
    historicalPurchaseData: [
      { project: 'Fall Headwear Order', category: 'Headwear', revenue: 4200, date: '2025-09-12' },
      { project: 'Spring Headwear Order', category: 'Headwear', revenue: 3100, date: '2025-03-04' }
    ]
  };
  const priorCategories = sandbox.realPriorCategories(opp);
  assert(priorCategories.join(',') === 'Headwear', `required test 14: with no live account-list match, realPriorCategories() still recovers the real purchased category (Headwear) from the opportunity's own historicalPurchaseData (got: ${JSON.stringify(priorCategories)})`);

  const evidenceHtml = sandbox.renderSupportingResearchDetails(opp);
  assert(evidenceHtml.includes('Previously purchased categories') && evidenceHtml.includes('Headwear') && evidenceHtml.includes('from your uploaded order history'), 'required test 14: the Evidence card renders a visibly distinct, clearly-labeled Previously Purchased Categories row from the fallback data, not just Related Suggested Categories');
  assert(evidenceHtml.includes('Related suggested categories') && evidenceHtml.includes('caps') && evidenceHtml.includes('inferred idea, not purchase history'), 'required test 14: Related Suggested Categories still renders separately, clearly labeled as an inferred idea');
  assert(evidenceHtml.indexOf('Previously purchased categories') < evidenceHtml.indexOf('Related suggested categories'), 'required test 14: the purchased-categories row appears before the inferred-ideas row, never merged into one label');

  // required test 15: the inferred ideas never leak into or replace the
  // real purchased-category row itself.
  const purchasedRowMatch = evidenceHtml.match(/Previously purchased categories<\/strong>([^<]*)/);
  assert(!!purchasedRowMatch && !/caps|beanies|employee hats/.test(purchasedRowMatch[1]), 'required test 15: the inferred category words never appear inside the Previously Purchased Categories row itself');

  // No fallback data either (a genuinely new/no-history account) -- the row
  // is still correctly hidden entirely, not filled with invented data.
  const noHistoryOpp = { account: 'Brand New Prospect', commonPromoCategories: ['Launch Kits'], historicalPurchaseData: [] };
  assert(sandbox.realPriorCategories(noHistoryOpp).length === 0, 'required test 14: with neither a live account match nor historicalPurchaseData, realPriorCategories() still returns empty rather than inventing data');
}

// ---------------------------------------------------------------------------
// Required test 13: card detail moved into Prepare for Call without data
// loss.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  sandbox.window.accountRadarAccounts = [
    { name: 'Acme Corp', categoryTypes: new Set(['Apparel']), orderCount: 4, revenue: 12000, totalRevenue: 12000, mostRecentDate: '2026-02-01', contacts: [{ name: 'Jordan Lee', email: 'jordan@acme.test' }], notes: 'Prefers email outreach.' }
  ];
  const opp = {
    account: 'Acme Corp', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/acme-expansion',
    signalTitle: 'Acme Corp opens new Richmond distribution center', conversationStarter: 'Saw Acme Corp has a new Richmond distribution center opening up.',
    recommendedBuyingTeam: ['Operations'], commonPromoCategories: ['Launch Kits'],
    actionabilityStatus: { status: 'ongoing', usesPublicationDate: true }, publicationDate: '2026-07-20'
  };

  const cardHtml = sandbox.renderRepOpportunityCard(opp);
  assert(!/Evidence/.test(cardHtml), 'required test 13: the card no longer renders the Evidence block');
  assert(!/Recommended Buying Team/i.test(cardHtml), 'required test 13: the card no longer renders the Recommended Buying Team tags');
  assert(!/Common promo categories/i.test(cardHtml), 'required test 13: the card no longer renders Common/Suggested promo category tags');
  assert(!/Supporting research/i.test(cardHtml), 'required test 13: the card no longer renders the Supporting Research footer label');
  assert(cardHtml.includes('Acme Corp') && cardHtml.includes('Recommended contact'), 'the card still shows account and a compact recommended-contact line (per the new 7-item hierarchy)');

  // The same data is genuinely still reachable -- in Prepare for Call's
  // Research Details / Account Context, via real function calls, not just
  // "trust me it's still in the JS object."
  const evidenceHtml = sandbox.renderSupportingResearchDetails(opp);
  assert(evidenceHtml.includes('Operations') && evidenceHtml.includes('Launch Kits'), 'required test 13: buying team and suggested categories are still rendered, in Prepare for Call\'s Research Details, not deleted');

  const accountContextHtml = sandbox.renderAccountContextSection(opp);
  assert(accountContextHtml.includes('Apparel') && accountContextHtml.includes('4 orders') && accountContextHtml.includes('Jordan Lee'), `required test 13: real order history (categories, order count, uploaded contact) is preserved and shown in Account Context (got: "${accountContextHtml}")`);

  const verifiedHtml = sandbox.renderVerifiedOpportunitySection(opp);
  assert(verifiedHtml.includes('Acme Corp opens new Richmond distribution center'), 'required test 13: the exact signal is preserved and shown in Verified Opportunity');
}

// ---------------------------------------------------------------------------
// Reconciliation item 1, sub-tests 2 and 4 (dashboard side): a retained
// non-priority-eligible signal is absent from This Week/Month/Quarter/Year
// priorities (including the "View All Opportunities" toggle) but remains
// visible in Research Details/account history (renderVerifiedSignals),
// clearly labeled.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const staleOpp = {
    account: 'New Hope Network', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/expo-west-2023',
    signalTitle: 'Natural Products Expo West 2023', title: 'Natural Products Expo West 2023', signalDetail: 'Natural Products Expo West 2023', signalType: 'Event', isReal: true,
    actionabilityStatus: { status: 'stale', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: false, label: 'Past event' },
    eventDate: '2023-06-15'
  };
  const eligibleOpp = {
    account: 'Acme Corp', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/acme-hiring',
    signalTitle: 'Acme is hiring field marketing coordinators', signalType: 'Hiring', isReal: true,
    actionabilityStatus: { status: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: true, label: 'Recent activity' },
    publishedDate: new Date(NOW.getTime() - 5 * 86400000).toISOString(), publicationDate: new Date(NOW.getTime() - 5 * 86400000).toISOString()
  };

  const allOpps = sandbox.prepareAllOpportunities([staleOpp, eligibleOpp]);
  assert(!allOpps.some(o => o.account === 'New Hope Network'), 'reconciliation item 1, sub-test 2: a retained stale signal is absent from prepareAllOpportunities() -- including the "View All Opportunities" listing, not just the default priority view');
  assert(allOpps.some(o => o.account === 'Acme Corp'), 'sanity: the priority-eligible signal is still present in prepareAllOpportunities()');

  sandbox.__setActiveTimebox('week');
  sandbox.__setShowAllWeeklyPriorities(false);
  const grid = sandbox.document.getElementById('opportunitiesGrid');
  sandbox.renderWeeklyPrioritiesFeed([staleOpp, eligibleOpp], [{ name: 'New Hope Network' }, { name: 'Acme Corp' }]);
  assert(!grid.innerHTML.includes('Natural Products Expo West 2023'), 'reconciliation item 1, sub-test 2: the retained stale signal never renders as a priority card in the weekly priorities feed');

  // Still reachable via Research Details/account history, clearly labeled.
  const historyHtml = sandbox.renderVerifiedSignals([staleOpp, eligibleOpp]);
  assert(historyHtml.includes('Natural Products Expo West 2023'), 'reconciliation item 1, sub-test 4: the retained stale signal remains visible in Research Details/account history (renderVerifiedSignals)');
  assert(/no longer current|past event/i.test(historyHtml), `reconciliation item 1, sub-test 4: the retained stale signal is clearly labeled as no longer current in account history (got: "${historyHtml.slice(0, 400)}")`);
}

// ---------------------------------------------------------------------------
// QA round 3, item 1: an undated event-like signal (the HPGR webinar shape)
// is excluded from ALL FOUR priority timeframes -- This Week, This Month,
// This Quarter, This Year -- not just the default "week" tab, while
// remaining visible in Research Details/account history.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const undatedWebinar = {
    account: 'HPGR', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/hpgr-webinar',
    signalTitle: 'HPGR HRCe product webinar', title: 'HPGR HRCe product webinar', signalType: 'Event', isReal: true,
    actionabilityStatus: { status: 'unknown-date', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: false, label: 'Date unavailable' }
  };
  const eligibleOpp = {
    account: 'Acme Corp', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/acme-hiring',
    signalTitle: 'Acme is hiring field marketing coordinators', signalType: 'Hiring', isReal: true,
    actionabilityStatus: { status: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: true, label: 'Ongoing business change' },
    publishedDate: new Date(NOW.getTime() - 5 * 86400000).toISOString(), publicationDate: new Date(NOW.getTime() - 5 * 86400000).toISOString()
  };
  for(const timebox of ['week', 'month', 'quarter', 'annual']){
    sandbox.__setActiveTimebox(timebox);
    sandbox.__setShowAllWeeklyPriorities(false);
    sandbox.renderWeeklyPrioritiesFeed([undatedWebinar, eligibleOpp], [{ name: 'HPGR' }, { name: 'Acme Corp' }]);
    const grid = sandbox.document.getElementById('opportunitiesGrid');
    assert(!grid.innerHTML.includes('HPGR HRCe product webinar'), `required coverage 1: the undated HPGR webinar never renders as a priority card in the "${timebox}" timeframe`);
    // View All Opportunities toggle for this timeframe must exclude it too.
    sandbox.__setShowAllWeeklyPriorities(true);
    sandbox.renderWeeklyPrioritiesFeed([undatedWebinar, eligibleOpp], [{ name: 'HPGR' }, { name: 'Acme Corp' }]);
    assert(!grid.innerHTML.includes('HPGR HRCe product webinar'), `required coverage 1: the undated HPGR webinar is excluded from "View All Opportunities" in the "${timebox}" timeframe too`);
  }
  const historyHtml = sandbox.renderVerifiedSignals([undatedWebinar, eligibleOpp]);
  assert(historyHtml.includes('HPGR HRCe product webinar'), 'required coverage 1: the undated HPGR webinar remains visible in Research Details/account history across every timeframe');
  assert(/date unavailable/i.test(historyHtml), `required coverage 1: the undated webinar is clearly labeled Date unavailable in account history (got: "${historyHtml.slice(0, 400)}")`);
}

// ---------------------------------------------------------------------------
// Reconciliation item 5: prove account.categoryTypes provenance -- Prior
// Categories stays hidden when there is no real order history even though
// AI-inferred "suggested" categories exist for the same opportunity, and
// Suggested merchandise categories remains visible in Research Details.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // Real order-history categories are EMPTY for this account -- only
  // inferred/suggested categories exist on the opportunity object.
  sandbox.window.accountRadarAccounts = [
    { name: 'Fresh Prospect Co', categoryTypes: new Set() }
  ];
  const opp = {
    account: 'Fresh Prospect Co', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/fresh-prospect',
    commonPromoCategories: ['Executive Gifts', 'Launch Kits'], recommendedBuyingTeam: ['Marketing']
  };

  assert(sandbox.realPriorCategories(opp).length === 0, 'reconciliation item 5: realPriorCategories() is empty -- it never reads commonPromoCategories/suggestedProducts as a fallback');
  const rows = sandbox.structuredEvidenceRows(opp);
  assert(!rows.some(r => r.label.includes('Prior categories')), 'reconciliation item 5: Prior Categories row is hidden entirely -- no real historical categories exist for this account');

  const researchDetailsHtml = sandbox.renderSupportingResearchDetails(opp);
  // Commercial-readiness correction round, item 4: relabeled "Suggested
  // merchandise categories" -> "Related suggested categories" so it reads
  // as a clear pair with the new "Previously purchased categories" row
  // (see renderSupportingResearchDetails()) -- still the same inferred-idea
  // data, still visible in Research Details regardless of order history.
  assert(/Related suggested categories/.test(researchDetailsHtml) && researchDetailsHtml.includes('Executive Gifts'), 'reconciliation item 5: Related suggested categories remains visible in Research Details, clearly labeled as inferred, independent of whether real order history exists');
}

// ---------------------------------------------------------------------------
// QA round 2, item 2 (required coverage 10-12): event-level dedup collapses
// the L.L.Bean flagship-store variants into one initiative, retains useful
// supporting evidence, and leaves a genuinely distinct event untouched.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const variants = [
    {
      account: 'L.L.Bean', isVerifiedSignalOpportunity: true, opportunityType: 'RENOVATION_COMPLETION',
      signalTitle: 'Multi-Year Investment in Flagship Store', signalSummary: 'L.L.Bean completes a multi-year investment in its flagship store.',
      sourceUrl: 'https://www.pressherald.com/llbean-flagship-1', cleanSourceName: 'Press Herald',
      publishedDate: '2026-06-01', confidenceScore: 70
    },
    {
      account: 'L.L.Bean', isVerifiedSignalOpportunity: true, opportunityType: 'RENOVATION_COMPLETION',
      signalTitle: 'L.L.Bean investing more than $50 million to reimagine the flagship store',
      signalSummary: 'L.L.Bean is investing more than $50 million to reimagine the flagship store in Freeport, with new employee and customer experiences planned.',
      sourceUrl: 'https://www.pressherald.com/llbean-flagship-1', cleanSourceName: 'Press Herald',
      publishedDate: '2026-06-01', confidenceScore: 88, conversationStarter: 'Saw the $50M+ Freeport flagship investment.',
      recommendedBuyingTeam: ['Marketing']
    },
    {
      account: 'L.L.Bean', isVerifiedSignalOpportunity: true, opportunityType: 'LOCATION_REOPENING',
      signalTitle: 'Flagship Store Reopening in Freeport', signalSummary: 'L.L.Bean flagship store reopening after a significant renovation in Freeport, Maine.',
      sourceUrl: 'https://www.pressherald.com/llbean-flagship-2', cleanSourceName: 'Press Herald',
      publishedDate: '2026-06-03', confidenceScore: 75
    },
    {
      account: 'L.L.Bean', isVerifiedSignalOpportunity: true, opportunityType: 'LOCATION_REOPENING',
      signalTitle: 'L.L.Bean flagship reopening after a significant renovation',
      signalSummary: 'The flagship store reopened after a significant renovation, part of the broader Freeport investment.',
      sourceUrl: 'https://www.bangordailynews.com/llbean-flagship-reopens', cleanSourceName: 'Bangor Daily News',
      publishedDate: '2026-06-05', confidenceScore: 65
    }
  ];
  const distinctEvent = {
    account: 'L.L.Bean', isVerifiedSignalOpportunity: true, opportunityType: 'HIRING_ACTIVITY',
    signalTitle: 'L.L.Bean is hiring seasonal warehouse staff', signalSummary: 'L.L.Bean posted openings for seasonal warehouse staff.',
    sourceUrl: 'https://www.example.com/llbean-hiring', cleanSourceName: 'Example News',
    publishedDate: '2026-01-15', confidenceScore: 60
  };

  const deduped = sandbox.dedupeOpportunities([...variants, distinctEvent]);
  const llbeanFlagshipCards = deduped.filter(o => o.account === 'L.L.Bean' && /flagship|investment|renovation|reopening/i.test(`${o.signalTitle} ${o.signalSummary}`));
  assert(llbeanFlagshipCards.length === 1, `required coverage 10: only one L.L.Bean flagship renovation/reopening initiative is rendered, not one per AI-worded variant (got ${llbeanFlagshipCards.length}: ${JSON.stringify(llbeanFlagshipCards.map(o=>o.signalTitle))})`);

  const winner = llbeanFlagshipCards[0];
  assert(winner.signalTitle === 'L.L.Bean investing more than $50 million to reimagine the flagship store', `required coverage 10: the surviving candidate is the strongest one (most specific description, real conversationStarter/recommendedBuyingTeam) (got: "${winner.signalTitle}")`);
  assert(Array.isArray(winner.additionalSources) && winner.additionalSources.length >= 1, `required coverage 11: supporting evidence from the merged-away variants survives as additionalSources on the winner (got: ${JSON.stringify(winner.additionalSources)})`);
  assert(winner.additionalSources.some(s => /bangordailynews/i.test(s.url || '')), 'required coverage 11: the distinct-domain Bangor Daily News source specifically survives dedup, merged onto the winner');
  assert(winner.mergedDuplicateCount === 3, `required coverage 10: the winner records how many duplicate variants were merged away (got ${winner.mergedDuplicateCount})`);

  const distinctCard = deduped.find(o => o.account === 'L.L.Bean' && o.signalTitle === 'L.L.Bean is hiring seasonal warehouse staff');
  assert(!!distinctCard, 'required coverage 12: a genuinely unrelated L.L.Bean event (a hiring signal, different type/source/date) remains a separate opportunity, not collapsed into the flagship initiative');
  assert(deduped.filter(o => o.account === 'L.L.Bean').length === 2, `required coverage 12: exactly two distinct L.L.Bean opportunities remain overall -- the merged flagship initiative and the unrelated hiring signal (got ${deduped.filter(o => o.account === 'L.L.Bean').length})`);
}
{
  // Simple title equality alone must never be the ONLY duplicate check --
  // two DIFFERENT companies with coincidentally similar titles must never
  // merge into each other.
  const sandbox = makeSandbox();
  const a = { account: 'Acme Corp', isVerifiedSignalOpportunity: true, opportunityType: 'RENOVATION_COMPLETION', signalTitle: 'Flagship store reopening', sourceUrl: 'https://example.com/acme-reopen', publishedDate: '2026-06-01', confidenceScore: 70 };
  const b = { account: 'Beta Retail', isVerifiedSignalOpportunity: true, opportunityType: 'RENOVATION_COMPLETION', signalTitle: 'Flagship store reopening', sourceUrl: 'https://example.com/beta-reopen', publishedDate: '2026-06-01', confidenceScore: 70 };
  const deduped = sandbox.dedupeOpportunities([a, b]);
  assert(deduped.length === 2, 'different accounts with identical titles are never merged -- account identity is always required, title equality alone is never sufficient');
}

// ---------------------------------------------------------------------------
// QA round 2, item 3 (required coverage 13-14): recommended department/Best
// Next Move/Questions to Ask reflect the real initiative and recommended
// buying team -- never the inferred merchandise category.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // recommendedBuyingTeam says Marketing; the only promo-category evidence
  // is "Apparel" -- department must come from the former, never the latter.
  const opp = {
    account: 'L.L.Bean', signalTitle: 'L.L.Bean investing more than $50 million to reimagine the flagship store',
    recommendedBuyingTeam: ['Marketing'], commonPromoCategories: ['Apparel'], suggestedProducts: ['Apparel']
  };
  const department = sandbox.groundedDepartmentForOpportunity(opp);
  assert(department === 'Marketing', `required coverage 13: groundedDepartmentForOpportunity() returns the real recommendedBuyingTeam ("Marketing"), never the inferred "Apparel" category (got: "${department}")`);
  assert(department !== 'Apparel', 'required coverage 13: "Apparel" (an inferred merchandise category) never becomes the assumed responsible department');

  const initiativeTitle = sandbox.groundedInitiativeTitle(opp);
  assert(initiativeTitle.includes('$50 million') && initiativeTitle.includes('flagship'), `required coverage 14: groundedInitiativeTitle() returns the exact surfaced initiative (got: "${initiativeTitle}")`);

  const play = sandbox.buildConciseSalesPlay({
    account: 'L.L.Bean', firstName: 'there', mode: 'Cold', reasonTitle: initiativeTitle, whyNow: '',
    category: 'apparel', signalType: 'expansion', department, initiativeTitle, isUpcoming: false, actionabilityTense: 'ongoing', hasKnownContact: false
  });
  assert(play.bestNextMove.includes('Marketing'), `required coverage 14: Best Next Move references the real department ("Marketing"), not the category (got: "${play.bestNextMove}")`);
  assert(!/apparel/i.test(play.bestNextMove), `required coverage 14: Best Next Move never asks about "apparel" as if it were the responsible department (got: "${play.bestNextMove}")`);
  assert(play.bestNextMove.includes('flagship') || play.bestNextMove.includes('$50 million'), `required coverage 14: Best Next Move references the exact initiative (got: "${play.bestNextMove}")`);
  assert(play.questionsToAsk.some(q => q.includes('Marketing')), `required coverage 14: Questions to Ask reference the real department (got: ${JSON.stringify(play.questionsToAsk)})`);
}
{
  // Separate event types produce appropriately different contact guidance --
  // a hiring signal's department/question differs from an expansion
  // signal's, each grounded in ITS OWN recommendedBuyingTeam.
  const sandbox = makeSandbox();
  const hiringOpp = { account: 'Acme Corp', signalTitle: 'Acme is hiring field marketing coordinators', recommendedBuyingTeam: ['HR / People'] };
  const expansionOpp = { account: 'Acme Corp', signalTitle: 'Acme opens new Richmond distribution center', recommendedBuyingTeam: ['Operations'] };
  const hiringDept = sandbox.groundedDepartmentForOpportunity(hiringOpp);
  const expansionDept = sandbox.groundedDepartmentForOpportunity(expansionOpp);
  assert(hiringDept === 'HR / People' && expansionDept === 'Operations', `required coverage 14: different signal types produce genuinely different, correctly-grounded department guidance (got hiring:"${hiringDept}", expansion:"${expansionDept}")`);
}

// ---------------------------------------------------------------------------
// QA round 2, item 4 (required coverage 15): outreach remains low pressure,
// references the exact initiative, and never invents needs or urgency.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const ctxA = { account: 'L.L.Bean', firstName: 'there', mode: 'Cold', category: 'apparel', signalType: 'expansion', department: 'Marketing', initiativeTitle: 'investing more than $50 million to reimagine the flagship store', isUpcoming: false, actionabilityTense: 'ongoing', hasKnownContact: false };
  const ctxB = { account: 'Acme Manufacturing', firstName: 'there', mode: 'Cold', category: 'uniforms', signalType: 'hiring', department: 'HR / People', initiativeTitle: 'hiring field marketing coordinators', isUpcoming: false, actionabilityTense: 'ongoing', hasKnownContact: false };
  const emailA = sandbox.buildReplyFirstEmail(ctxA);
  const emailB = sandbox.buildReplyFirstEmail(ctxB);
  assert(emailA !== emailB, 'required coverage 15: two different companies/signals receive meaningfully distinct outreach copy');
  assert(emailA.includes('flagship') || emailA.includes('$50 million'), `required coverage 15: the L.L.Bean email references the exact initiative (got: "${emailA}")`);
  assert(emailB.includes('hiring field marketing coordinators'), `required coverage 15: the Acme email references its own exact initiative (got: "${emailB}")`);
  assert(!/discussing promotional products/i.test(emailA) && !/discussing promotional products/i.test(emailB), 'required coverage 15: outreach never defaults to "discussing promotional products" as the first ask');
  assert(!/some event or community activity/i.test(emailA), 'required coverage 15: the exact ungrounded legacy phrase never appears');
  assert(!/already need|already planning to buy|need to order/i.test(emailA), 'required coverage 15: outreach never claims the company already needs merchandise');
  assert(!/\bupcoming\b/i.test(emailA), 'required coverage 15: outreach never says "upcoming" when the actionability state (ongoing, not upcoming) does not support it');

  const upcomingCtx = { ...ctxA, isUpcoming: true };
  const upcomingEmail = sandbox.buildReplyFirstEmail(upcomingCtx);
  assert(/coming up/i.test(upcomingEmail), 'required coverage 15: "coming up" phrasing IS used when the actionability state genuinely supports it (isUpcoming:true)');

  const staleCtx = { account: 'New Hope Network', firstName: 'there', mode: 'Cold', category: '', signalType: 'event', department: '', initiativeTitle: 'Natural Products Expo West 2023', isUpcoming: false, actionabilityTense: 'past', hasKnownContact: false };
  const staleEmail = sandbox.buildReplyFirstEmail(staleCtx);
  assert(!/\bupcoming\b/i.test(staleEmail) && !/coming up/i.test(staleEmail), `required coverage 15: a stale signal (isUpcoming:false) never produces upcoming-tense language (got: "${staleEmail}")`);

  const callScript = sandbox.buildNaturalCallScript(ctxA);
  assert(callScript.join(' ').includes('No pitch yet'), 'required coverage 15: the call script keeps the first ask low pressure, explicitly deferring the pitch');
}

// ---------------------------------------------------------------------------
// QA round 2, item 5 (required coverage): all 5 honest actionability/date
// states render with the correct label and date/tense treatment.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const cases = [
    { status: { status: 'upcoming' }, eventDate: '2026-09-15', expectSubstr: 'Upcoming' },
    { status: { status: 'recent-past' }, eventDate: '2026-07-01', expectSubstr: 'Recent event' },
    { status: { status: 'ongoing', usesPublicationDate: true }, publicationDate: '2026-07-20', expectSubstr: 'Ongoing business change' },
    { status: { status: 'unknown-date' }, expectSubstr: 'Date unavailable' },
    { status: { status: 'ongoing-undated', usesPublicationDate: true }, expectSubstr: 'Date unavailable' },
    { status: { status: 'stale' }, expectSubstr: 'No longer current' },
    { status: { status: 'ongoing-stale', usesPublicationDate: true }, expectSubstr: 'No longer current' }
  ];
  for(const c of cases){
    const opp = { actionabilityStatus: c.status, eventDate: c.eventDate || '', publicationDate: c.publicationDate || '' };
    const line = sandbox.signalDateAndActionabilityLine(opp);
    assert(line.includes(c.expectSubstr), `status "${c.status.status}" renders with the expected honest label (expected to include "${c.expectSubstr}", got "${line}")`);
  }
  // Never fabricates a date, never labels a publication date as an event
  // date, never uses discovery time for freshness.
  const noDateOpp = { actionabilityStatus: { status: 'upcoming' }, eventDate: '' };
  assert(sandbox.signalDateAndActionabilityLine(noDateOpp) === 'Upcoming', 'an upcoming signal with no real date string still never fabricates one -- shows the bare label only');
  const ongoingOpp = { actionabilityStatus: { status: 'ongoing', usesPublicationDate: true }, eventDate: '2026-01-01', publicationDate: '2026-07-20' };
  assert(!sandbox.signalDateAndActionabilityLine(ongoingOpp).includes('Upcoming'), 'an ongoing business-change signal is never labeled as having an event date -- only its publication date is shown');
}

// ---------------------------------------------------------------------------
// QA round 2, item 6 (required coverage 16): Account Context never claims
// uploaded contact data when none exists, and correctly distinguishes all 4
// required states.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // State: no order history, no usable uploaded contact, no public contact.
  sandbox.window.accountRadarAccounts = [{ name: 'No History No Contact Co', categoryTypes: new Set(), contacts: [] }];
  const opp1 = { account: 'No History No Contact Co' };
  const html1 = sandbox.renderAccountContextSection(opp1);
  assert(!/you already have/i.test(html1), `required coverage 16: never claims "you already have" a relationship/contact when none exists (got: "${html1}")`);
  assert(/no order history or usable contact/i.test(html1) && /suggested department/i.test(html1), `state (no history/no contact): honest department-only fallback message (got: "${html1}")`);

  // State: no order history, no usable uploaded contact, but a public
  // contact WAS discovered.
  const opp1b = { account: 'No History No Contact Co', suggestedContactDetails: { name: 'Jamie Rivera' } };
  const html1b = sandbox.renderAccountContextSection(opp1b);
  assert(/publicly discovered contact/i.test(html1b), `state (no history/no contact, public contact found): honest message names the public contact source (got: "${html1b}")`);

  // State: no order history, but a real usable uploaded contact exists.
  sandbox.window.accountRadarAccounts = [{ name: 'Contact No History Co', categoryTypes: new Set(), contacts: [{ name: 'Jordan Lee', email: 'jordan@example.com' }] }];
  const opp2 = { account: 'Contact No History Co' };
  const html2 = sandbox.renderAccountContextSection(opp2);
  assert(html2.includes('Jordan Lee'), `state (contact/no history): the real uploaded contact is shown (got: "${html2}")`);
  assert(!/no order history or usable contact/i.test(html2), 'state (contact/no history): does not fall into the no-contact fallback message when a real contact exists');

  // State: real order history, no usable uploaded contact.
  sandbox.window.accountRadarAccounts = [{ name: 'History No Contact Co', categoryTypes: new Set(['Apparel']), orderCount: 3, contacts: [] }];
  const opp3 = { account: 'History No Contact Co' };
  const html3 = sandbox.renderAccountContextSection(opp3);
  assert(/3 orders on file/.test(html3), `state (history/no contact): real order history is shown (got: "${html3}")`);
  assert(!/Uploaded contacts/.test(html3), 'state (history/no contact): no contact row is fabricated when none exists');

  // State: both real order history and a real usable uploaded contact.
  sandbox.window.accountRadarAccounts = [{ name: 'Full History Co', categoryTypes: new Set(['Apparel']), orderCount: 5, contacts: [{ name: 'Sam Patel', email: 'sam@example.com' }] }];
  const opp4 = { account: 'Full History Co' };
  const html4 = sandbox.renderAccountContextSection(opp4);
  assert(/5 orders on file/.test(html4) && html4.includes('Sam Patel'), `state (history and contact): both real order history and the real contact are shown (got: "${html4}")`);
}

// ---------------------------------------------------------------------------
// QA round 3, item 4: "Newly Detected" single source of truth. Reproduces
// the exact discrepancy from Preview QA -- a raw data.newThisWeek array
// with 18 signal rows where two rows are the same real-world initiative
// (same account/signalType/title/sourceUrl -- an exact duplicate the way a
// re-run or a second source pass can legitimately produce), so the
// deduped count is 17. The old banner code read data.newThisWeek.length
// directly (18); the tile already deduped first (17). Both call sites now
// route through the single newlyDetectedCount() helper, so this proves
// they agree.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const newThisWeek = [];
  for(let i = 1; i <= 17; i++){
    newThisWeek.push({
      account: `Account ${i}`, isVerifiedSignalOpportunity: true, sourceUrl: `https://example.com/${i}`,
      signalType: 'Business Activity', signalTitle: `Account ${i} business update`, evidence: ['real evidence']
    });
  }
  // The 18th raw row is an EXACT duplicate of row 1 (same account, same
  // signalType, same title, same sourceUrl) -- the precise shape that
  // collapses under dedup, reproducing 18 raw rows / 17 real initiatives.
  newThisWeek.push({
    account: 'Account 1', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/1',
    signalType: 'Business Activity', signalTitle: 'Account 1 business update', evidence: ['real evidence']
  });
  const data = { newThisWeek };

  assert(data.newThisWeek.length === 18, 'sanity: the raw fixture really does have 18 signal rows, reproducing the Preview QA banner count');
  const deduped = sandbox.newlyDetectedCount(data);
  assert(deduped === 17, `required coverage 17 (Newly Detected): newlyDetectedCount() collapses the exact-duplicate row, matching the previously-correct tile value of 17, not the raw 18 (got: ${deduped})`);

  // Directly prove the two real call sites -- the metric tile
  // (renderCustomerDashboard) and the summary banner -- now render the
  // SAME number for the SAME data, closing the exact regression reported
  // ("18 newly detected" banner vs "17 newly detected" tile).
  sandbox.document.getElementById('customerDashboard').style = {};
  const tileEl = sandbox.document.getElementById('dashNewThisWeek');
  sandbox.renderCustomerDashboard(data);
  assert(tileEl.textContent === 17, `required coverage 17 (Newly Detected): the dashboard metric tile shows the deduped count (got: ${tileEl.textContent})`);
  const bannerCount = sandbox.newlyDetectedCount(data);
  assert(bannerCount === Number(tileEl.textContent), `required coverage 17 (Newly Detected): the banner's own count computation (newlyDetectedCount()) exactly matches what the tile rendered -- the two surfaces can no longer disagree (banner: ${bannerCount}, tile: ${tileEl.textContent})`);
}
{
  // A raw array with NO duplicates must not be under-counted -- proves the
  // fix didn't just hardcode dedup, it genuinely reflects distinct
  // initiatives when there are no duplicates to collapse.
  const sandbox = makeSandbox();
  const newThisWeek = [1, 2, 3].map(i => ({
    account: `Distinct Account ${i}`, isVerifiedSignalOpportunity: true, sourceUrl: `https://example.com/distinct-${i}`,
    signalType: 'Business Activity', signalTitle: `Distinct Account ${i} update`, evidence: ['real evidence']
  }));
  assert(sandbox.newlyDetectedCount({ newThisWeek }) === 3, 'Newly Detected: three genuinely distinct new signals are never under-counted by dedup');
}
{
  // Newly Detected must exclude stale/date-unavailable event-like signals
  // -- this is enforced server-side (api/get-dashboard.js's newThisWeek
  // filter already routes through classifyLegacySignalActionability()
  // before newThisWeek is ever sent to the client), so the client-side
  // count over an already-filtered array must not re-admit anything; an
  // empty/undated feed simply produces zero, not a fabricated count.
  const sandbox = makeSandbox();
  assert(sandbox.newlyDetectedCount({ newThisWeek: [] }) === 0, 'Newly Detected: an empty (nothing new/eligible this window) newThisWeek array counts as zero, not undefined/NaN');
  assert(sandbox.newlyDetectedCount({}) === 0, 'Newly Detected: a missing newThisWeek field on the response never throws and counts as zero');
}

// ---------------------------------------------------------------------------
// QA round 3, item 5: outreach text normalization. Reproduces the exact
// New Hope Network / Nutrition Capital Network acquisition defects from the
// Preview QA report against the SHARED generation path (buildConciseSalesPlay/
// buildReplyFirstEmail/buildNaturalCallScript/questionsForSignal/
// conciseSubject/ownerAskPhrase), not a one-account patch.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // The exact reported opportunity: an acquisition signal where the AI
  // returned "Marketing" as the suggestedContact (no real named contact),
  // recommendedBuyingTeam is Marketing, and the raw signalTitle already
  // ends in a period AND already names the account as its own subject --
  // the precise shape that produced every defect in the report.
  const opp = {
    account: 'New Hope Network',
    contact: 'Marketing', contactTitle: 'Marketing',
    signalTitle: 'New Hope Network has acquired the assets of Nutrition Capital Network, expanding its portfolio.',
    canonicalEventType: 'ACQUISITION', opportunityType: 'ACQUISITION',
    recommendedBuyingTeam: ['Marketing'], likelyBuyers: ['Marketing'],
    commonPromoCategories: ['Onboarding Kits'], suggestedProducts: ['Onboarding Kits']
  };

  // required coverage 10/11: department never used as a greeting; unknown
  // contact renders "Hi there,".
  const knownBuyer = sandbox.likelyKnownBuyer(opp);
  assert(knownBuyer === '', `required coverage 10/11: likelyKnownBuyer() never treats a department/role placeholder ("Marketing") as a real contact name (got: "${knownBuyer}")`);

  const department = sandbox.groundedDepartmentForOpportunity(opp);
  const initiativeTitle = sandbox.groundedInitiativeTitle(opp);
  const canonicalKind = sandbox.canonicalSignalKind(opp);
  assert(canonicalKind === 'acquisition', `sanity: the fixture is genuinely classified as an acquisition (got: "${canonicalKind}")`);
  assert(!initiativeTitle.endsWith('.'), `groundedInitiativeTitle() strips trailing sentence punctuation at the source (got: "${initiativeTitle}")`);

  const ctx = {
    account: opp.account, firstName: knownBuyer && !knownBuyer.includes('/') ? knownBuyer.split(' ')[0] : 'there',
    mode: 'Cold', reasonTitle: initiativeTitle, whyNow: '', category: 'onboarding kits',
    signalType: 'expansion', canonicalKind, department, initiativeTitle,
    isUpcoming: false, actionabilityTense: 'ongoing', hasKnownContact: false
  };
  assert(ctx.firstName === 'there', `required coverage 11: with no verified contact, the greeting name resolves to "there" (renders "Hi there,"), never the department (got: "${ctx.firstName}")`);

  const play = sandbox.buildConciseSalesPlay(ctx);

  // required coverage 11: department never used as email or call greeting.
  assert(play.outreachEmail.startsWith('Hi there,'), `required coverage 11: the email greeting is "Hi there," -- never a department (got: "${play.outreachEmail.slice(0, 30)}")`);
  assert(!/^Hi Marketing/.test(play.outreachEmail), 'required coverage 11: the email never greets with the department name "Hi Marketing,"');

  // required coverage 12: proper nouns remain correctly capitalized
  // throughout every generated surface -- never lowercased mid-sentence.
  assert(play.outreachEmail.includes('New Hope Network') && play.outreachEmail.includes('Nutrition Capital Network'), `required coverage 12: proper nouns keep their real capitalization in the email (got: "${play.outreachEmail}")`);
  assert(!/new hope network|nutrition capital network/.test(play.outreachEmail), `required coverage 12: proper nouns are never lowercased (got: "${play.outreachEmail}")`);
  assert(play.bestNextMove.includes('New Hope Network') || play.bestNextMove.includes('Nutrition Capital Network'), `required coverage 12: Best Next Move also preserves proper-noun capitalization (got: "${play.bestNextMove}")`);
  assert(!/new hope network|nutrition capital network/.test(play.bestNextMove), `required coverage 12: Best Next Move never lowercases the account/initiative name (got: "${play.bestNextMove}")`);

  // required coverage 13: no duplicated account phrase, no double period,
  // no "- -" artifact -- the initiative already names New Hope Network as
  // its own subject, so "at New Hope Network" must never be appended.
  assert(!/expanding its portfolio\.\s*at New Hope Network/i.test(play.outreachEmail), `required coverage 13: the account is never named a second time when the factual sentence already names it (got: "${play.outreachEmail}")`);
  assert(!/at New Hope Network at New Hope Network/i.test(play.outreachEmail), 'required coverage 13: no duplicated account phrase');
  assert(!/\.\./.test(play.outreachEmail) && !/\.\./.test(play.bestNextMove), `required coverage 13: no double period anywhere in the email or Best Next Move (email: "${play.outreachEmail}", bestNextMove: "${play.bestNextMove}")`);
  assert(!/-\s+-/.test(play.outreachEmail) && !/-\s+-/.test(play.bestNextMove), `required coverage 13: no malformed doubled-hyphen artifact ("- -") in the email or Best Next Move (email: "${play.outreachEmail}", bestNextMove: "${play.bestNextMove}")`);

  // required coverage 14: subject lines are concise and grounded -- never
  // the full factual sentence, never truncated mid-word.
  assert(play.emailSubject === 'Question about the recent acquisition', `required coverage 14: an acquisition signal gets the natural, non-hardcoded acquisition subject (got: "${play.emailSubject}")`);
  assert(!/New Hope Network has acquired the\.\.\./.test(play.emailSubject), 'required coverage 14: the subject is never the full run-on sentence truncated mid-word');
  assert(play.emailSubject.length < 60, `required coverage 14: the subject stays concise (got ${play.emailSubject.length} chars: "${play.emailSubject}")`);

  // Avoid: "on the Marketing side" phrasing (explicitly called out as
  // awkward); the call script/questions still ask about ownership using
  // the acquisition-specific integration/communications phrasing.
  assert(!/on the Marketing side/i.test(play.outreachEmail), `outreach avoids the awkward "on the Marketing side" phrasing (got: "${play.outreachEmail}")`);
  assert(/integration or communications/i.test(play.outreachEmail), `an acquisition signal's owner-ask references integration/communications, matching the call-script guidance (got: "${play.outreachEmail}")`);

  // email/Best Next Move/phone opener (call script)/questions all share the
  // same factual initiative and the same normalized owner-ask.
  const callScriptText = play.callScript.join(' ');
  assert(callScriptText.includes('New Hope Network') || callScriptText.includes('Nutrition Capital Network'), `the call script opener shares the same factual initiative as the email (got: "${callScriptText}")`);
  assert(/integration or communications/i.test(callScriptText), 'the call script uses the same normalized owner-ask as the email');
  assert(play.questionsToAsk.some(q => /integration or communications/i.test(q)), `Questions to Ask uses the same normalized owner-ask as the email/call script (got: ${JSON.stringify(play.questionsToAsk)})`);
  assert(!/on the Marketing side/i.test(callScriptText) && !play.questionsToAsk.some(q => /on the Marketing side/i.test(q)), 'neither the call script nor Questions to Ask uses the awkward "on the Marketing side" phrasing');
}
{
  // required coverage 10 (direct unit proof): unknown contact -> "Hi there,"
  // across every greeting-deriving function, not just the acquisition
  // fixture above.
  const sandbox = makeSandbox();
  assert(sandbox.likelyKnownBuyer({ contact: 'HR' }) === '', 'likelyKnownBuyer(): "HR" (a department) is never treated as a real contact name');
  assert(sandbox.likelyKnownBuyer({ contact: 'Relevant department lead' }) === '', 'likelyKnownBuyer(): the generic placeholder "Relevant department lead" is never treated as a real contact name');
  assert(sandbox.likelyKnownBuyer({ contact: 'Jordan Lee' }) === 'Jordan Lee', 'likelyKnownBuyer(): a genuine two-word person name IS accepted as a real contact');

  const opener = sandbox.businessSuggestedOpener({ account: 'Acme Co', contact: 'Marketing', signalTitle: 'Acme Co opens new facility' });
  assert(opener.startsWith('Hey there'), `businessSuggestedOpener() never greets with a department name (got: "${opener}")`);
  const opener2 = sandbox.getSuggestedOpener({ account: 'Acme Co', contact: 'Operations', opportunity: 'Repeat order', evidence: [] });
  assert(!/^Hey Operations/.test(opener2), `getSuggestedOpener() never greets with a department name (got: "${opener2}")`);
}
{
  // required coverage 13 (direct unit proof): leadAlreadyNamesAccount()/
  // leadWithAccountContext() -- the account is appended ONLY when the
  // lead phrase doesn't already name it, proven both ways.
  const sandbox = makeSandbox();
  assert(sandbox.leadAlreadyNamesAccount('New Hope Network has acquired the assets', 'New Hope Network') === true, 'leadAlreadyNamesAccount() detects the account name already present in the lead phrase');
  assert(sandbox.leadAlreadyNamesAccount('hiring field marketing coordinators', 'Acme Manufacturing') === false, 'leadAlreadyNamesAccount() correctly reports false when the account is genuinely not named');

  const withAccount = sandbox.leadWithAccountContext({ initiativeTitle: 'hiring field marketing coordinators', account: 'Acme Manufacturing', isUpcoming: false });
  assert(withAccount === 'hiring field marketing coordinators at Acme Manufacturing', `leadWithAccountContext() appends "at <account>" when the account is not already named (got: "${withAccount}")`);
  const withoutDuplicate = sandbox.leadWithAccountContext({ initiativeTitle: 'New Hope Network has acquired the assets of Nutrition Capital Network', account: 'New Hope Network', isUpcoming: false });
  assert(withoutDuplicate === 'New Hope Network has acquired the assets of Nutrition Capital Network', `leadWithAccountContext() does NOT append the account a second time when the lead already names it (got: "${withoutDuplicate}")`);
}
{
  // required coverage 13/15 (direct unit proof): normalizeOutreachText()
  // collapses doubled hyphens/dashes (with or without a space between
  // them) into a single proper em dash -- QA final round, item 6: rendered
  // outreach may never contain a literal "--"/"- -" ASCII artifact AT ALL,
  // not even as an intentional dash-off-clause separator -- and collapses
  // doubled terminal punctuation, but preserves a genuine 3-dot ellipsis
  // and paragraph line breaks.
  const sandbox = makeSandbox();
  const collapsedDash = sandbox.normalizeOutreachText('Not trying to jump straight to a pitch - - just want to start');
  assert(collapsedDash === 'Not trying to jump straight to a pitch — just want to start', `normalizeOutreachText() collapses a spaced-out doubled hyphen ("- -") into a single proper em dash, never "--" (got: "${collapsedDash}")`);
  assert(!collapsedDash.includes('--'), 'required coverage 15: normalizeOutreachText() output never contains a literal "--"');
  assert(!/-\s+-/.test(collapsedDash), 'required coverage 15: normalizeOutreachText() output never contains a literal "- -"');
  const collapsedDoubleDash = sandbox.normalizeOutreachText('portfolio -- quick question');
  assert(collapsedDoubleDash === 'portfolio — quick question', `normalizeOutreachText() collapses an existing "--" separator into a single em dash (got: "${collapsedDoubleDash}")`);
  assert(sandbox.normalizeOutreachText('reimagine the flagship store..') === 'reimagine the flagship store.', 'normalizeOutreachText() collapses a doubled terminal period into one');
  assert(sandbox.normalizeOutreachText('Quick question on onboarding...') === 'Quick question on onboarding...', 'normalizeOutreachText() preserves a genuine 3-dot ellipsis (e.g. from trimToWords() truncation)');
  assert(sandbox.normalizeOutreachText('Hi there,\n\nSaw something.\n\nBest,\n[Rep Name]').includes('\n\n'), 'normalizeOutreachText() preserves paragraph line breaks (does not collapse newlines like ordinary whitespace)');
  assert(sandbox.normalizeOutreachText('too   many   spaces') === 'too many spaces', 'normalizeOutreachText() collapses doubled/tripled spaces');
}
{
  // required coverage 14 (non-acquisition subjects still behave sanely):
  // a short, ungrounded-in-punctuation initiative still produces a
  // concise subject, and a long one falls back to the per-signal-type
  // template instead of a truncated run-on sentence.
  const sandbox = makeSandbox();
  const shortSubject = sandbox.conciseSubject({ mode: 'Cold', account: 'Test Co', initiativeTitle: 'new Richmond distribution center', signalType: 'expansion' });
  assert(shortSubject === 'Question about new Richmond distribution center', `a short (<=6 word) initiative is used verbatim, untruncated, in the subject (got: "${shortSubject}")`);
  // QA final round, item 6: "Do not use generic subjects such as 'Saw the
  // expansion' when a named initiative is available" -- a long initiative
  // whose first clause is still too long for the subject now falls back to
  // an account-grounded, specific subject instead of the old flat generic
  // template.
  const longSubject = sandbox.conciseSubject({ mode: 'Cold', account: 'New Hope Network', initiativeTitle: 'New Hope Network has acquired the assets of Nutrition Capital Network, expanding its portfolio', signalType: 'expansion' });
  assert(!longSubject.includes('...'), `a long initiative never falls back to a mid-word-truncated subject (got: "${longSubject}")`);
  assert(longSubject === 'Quick question about the New Hope Network expansion', `a long, non-acquisition initiative falls back to an account-grounded specific subject, never the generic "Saw the expansion" (got: "${longSubject}")`);
  assert(longSubject !== 'Saw the expansion', 'required coverage 16: "Saw the expansion" is never used when a named initiative is available');
  // Only when there is genuinely NO named initiative at all does the
  // generic per-signal-type fallback remain.
  const noInitiativeSubject = sandbox.conciseSubject({ mode: 'Cold', account: 'Acme Co', initiativeTitle: '', signalType: 'expansion' });
  assert(noInitiativeSubject === 'Saw the expansion', `with no initiative title at all, the generic per-signal-type fallback is still used (got: "${noInitiativeSubject}")`);
}

// ===========================================================================
// Section D — Final narrow QA correction round: priority-eligibility
// invariant tied to the rendered status, end-to-end date-range extraction,
// corrected acquisition/investment/grant classification, L.L.Bean flagship
// merge with actionability inheritance, a legacy-copy quality gate, and the
// final outreach-language cleanup (em dash instead of "--", named-initiative
// subjects, natural owner-ask phrasing).
// ===========================================================================

// ---------------------------------------------------------------------------
// required proofs 1-3: undated event-like signals remain detail-only. These
// exact examples were still visibly leaking into Week/Month priorities in
// Preview -- reproduced end-to-end via makeSignal() (the real production
// signal-creation path) rather than a synthetic fixture.
// ---------------------------------------------------------------------------
{
  const cases = [
    { name: 'HPGR webinar', title: "HPGR's HRCe product webinar", account: 'HPGR' },
    { name: 'Marriott anniversary', title: 'New York Marriott Marquis anniversary celebration', account: 'New York Marriott Marquis' },
    { name: 'The Other Women workshops', title: 'The Other Women workshops', account: 'The Other Women' }
  ];
  for(const c of cases){
    const signal = makeSignal({ accountName: c.account, signalTitle: c.title, whatChanged: c.title, sourceUrl: `https://example.com/${c.account.toLowerCase().replace(/\s+/g,'-')}` }, { name: c.account });
    assert(signal, `required proof (${c.name}): makeSignal() retains the signal instead of discarding it`);
    assert(signal.eventCategory === 'event-like', `required proof (${c.name}): classified event-like (got "${signal.eventCategory}")`);
    assert(signal.actionabilityStatus.status === 'unknown-date', `required proof (${c.name}): with no explicit date, status is "unknown-date"/Date unavailable (got "${signal.actionabilityStatus.status}")`);
    assert(signal.actionabilityStatus.isPriorityEligible === false, `required proof (${c.name}): excluded from priority/digest eligibility`);
    assert(signal.isUpcoming === false, `required proof (${c.name}): never flagged isUpcoming`);
  }
}

// ---------------------------------------------------------------------------
// required proof 4: L.L.Bean's "grand opening scheduled for September
// 18-20, 2026" (and equivalent phrasings) parses as an exact Upcoming date,
// not "Date unavailable" -- item 2's end-to-end date-range extraction fix.
// ---------------------------------------------------------------------------
{
  const phrasings = [
    'grand opening scheduled for September 18-20, 2026',
    'grand opening scheduled for September 18–20, 2026',
    'Sep. 18 through 20, 2026'
  ];
  for(const text of phrasings){
    const resolved = resolveSignalEventDate({}, `L.L.Bean flagship ${text}`, '', '', 'event-like');
    assert(resolved.dateConfidence === 'exact', `required proof 4: "${text}" parses with exact date confidence, not unknown (got "${resolved.dateConfidence}")`);
    assert(resolved.eventDate === '2026-09-18', `required proof 4: "${text}" anchors to the range's first day, 2026-09-18 (got "${resolved.eventDate}")`);
    assert(resolved.displayEventDate === 'September 18–20, 2026', `required proof 4: "${text}" preserves the full human-readable date range for display (got "${resolved.displayEventDate}")`);
    const status = computeActionability({ eventCategory: 'event-like', eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
    assert(status.status === 'upcoming', `required proof 4: "${text}", viewed as of ${NOW.toISOString().slice(0,10)}, is Upcoming (got "${status.status}")`);
    assert(status.isPriorityEligible === true, `required proof 4: "${text}" is priority eligible`);
  }
  // End-to-end through the canonical legacy-normalization boundary too.
  const legacy = classifyLegacySignalActionability({
    signalTitle: 'L.L.Bean flagship grand opening',
    whatChanged: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026'
  });
  assert(legacy.actionabilityStatus.status === 'upcoming', `required proof 4: classifyLegacySignalActionability() also resolves the date range to Upcoming (got "${legacy.actionabilityStatus.status}")`);
  assert(legacy.eventDateDisplay === 'September 18–20, 2026', `required proof 4: classifyLegacySignalActionability() carries the display range through (got "${legacy.eventDateDisplay}")`);
}

// ---------------------------------------------------------------------------
// required proof 5: "ribbon-cutting ceremony on October 9, 2025" viewed in
// August 2026 (NOW) becomes stale and excluded from priorities. Event date
// and publication date/discovery timestamps remain genuinely separate
// fields throughout.
// ---------------------------------------------------------------------------
{
  const resolved = resolveSignalEventDate({}, 'Propane Gas Association of New England ribbon-cutting ceremony on October 9, 2025', '', '', 'event-like');
  assert(resolved.eventDate === '2025-10-09' && resolved.dateConfidence === 'exact', `required proof 5: the ribbon-cutting date parses exactly (got: ${JSON.stringify(resolved)})`);
  const status = computeActionability({ eventCategory: 'event-like', eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(status.status === 'stale', `required proof 5: viewed in August 2026, the October 9, 2025 ribbon-cutting is "No longer current" (got "${status.status}")`);
  assert(status.isPriorityEligible === false, 'required proof 5: the stale ribbon-cutting signal is excluded from priorities');
}

// ---------------------------------------------------------------------------
// required proof 6: a bare-year-only reference ("San Diego Comic-Con 2022")
// is enough to prove staleness in 2026, but is never precise enough to
// fabricate an exact event date -- it stays "approximate" confidence, never
// "exact".
// ---------------------------------------------------------------------------
{
  const resolved = resolveSignalEventDate({}, 'Warner Bros. Discovery San Diego Comic-Con 2022 exhibit booth', 'San Diego Comic-Con 2022 exhibit booth', '', 'event-like');
  assert(resolved.dateConfidence === 'approximate', `required proof 6: a bare-year-only event reference gets approximate confidence, never fabricated exact precision (got "${resolved.dateConfidence}")`);
  const status = computeActionability({ eventCategory: 'event-like', eventDate: resolved.eventDate, dateConfidence: resolved.dateConfidence, now: NOW });
  assert(status.status === 'stale', `required proof 6: viewed in 2026, "Comic-Con 2022" is stale (got "${status.status}")`);
}

// ---------------------------------------------------------------------------
// required proofs 7-10: corrected canonical business-signal classification.
// ---------------------------------------------------------------------------
{
  const llbeanInvestment = resolveCanonicalEventType({ signalTitle: 'L.L.Bean investing more than $50 million to reimagine the flagship store' });
  assert(llbeanInvestment.eventType !== 'ACQUISITION', `required proof 7: L.L.Bean's capital-investment/renovation signal never classifies as Acquisition (got "${llbeanInvestment.eventType}")`);

  const readingSymphonyGrant = resolveCanonicalEventType({ signalTitle: 'Reading Symphony received a $15,000 grant', whatChanged: 'Reading Symphony was awarded a $15,000 grant from the NEA' });
  assert(readingSymphonyGrant.eventType !== 'ACQUISITION', `required proof 8: Reading Symphony's grant/funding signal never classifies as Acquisition (got "${readingSymphonyGrant.eventType}")`);
  assert(readingSymphonyGrant.eventType === 'EVENT_AWARD', `required proof 8: the grant is grouped with Award/Recognition (got "${readingSymphonyGrant.eventType}")`);

  const newHopeAcquisition = resolveCanonicalEventType({ signalTitle: 'New Hope Network has acquired the assets of Nutrition Capital Network, expanding its portfolio' });
  assert(newHopeAcquisition.eventType === 'ACQUISITION', `required proof 9: New Hope Network's genuine business acquisition still classifies as Acquisition (got "${newHopeAcquisition.eventType}")`);

  const withoutMerch = resolveCanonicalEventType({ signalTitle: 'L.L.Bean investing more than $50 million to reimagine the flagship store' });
  const withMerch = resolveCanonicalEventType({ signalTitle: 'L.L.Bean investing more than $50 million to reimagine the flagship store', commonPromoCategories: ['Onboarding Kits'], suggestedProducts: ['Onboarding Kits'] });
  assert(withoutMerch.eventType === withMerch.eventType, `required proof 10: an inferred merchandise category never alters the canonical classification (got "${withoutMerch.eventType}" vs "${withMerch.eventType}")`);
  assert(withMerch.eventType !== 'HIRING_ACTIVITY', 'required proof 10: an onboarding-kit merch suggestion never reclassifies a non-hiring signal as hiring');
  // Hiring itself remains correctly classified as hiring (never suppressed
  // by the acquisition/grant/investment guards above).
  const genuineHiring = resolveCanonicalEventType({ signalTitle: 'Acme is hiring field marketing coordinators' });
  assert(genuineHiring.eventType === 'HIRING_ACTIVITY', `required proof 10: genuine hiring language still classifies as hiring (got "${genuineHiring.eventType}")`);
}

// ---------------------------------------------------------------------------
// required proofs 11-12: the L.L.Bean flagship investment, reopening, and
// grand-opening-date variants merge into ONE rich opportunity that retains
// every variant's distinguishing fact and adopts the most actionable date
// found across all of them.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const account = 'L.L.Bean';
  const variantInvestment = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    opportunityType: 'RENOVATION_COMPLETION', canonicalEventType: 'RENOVATION_COMPLETION',
    signalTitle: 'L.L.Bean investing more than $50 million to reimagine the flagship store',
    signalSummary: 'L.L.Bean investing more than $50 million to reimagine the flagship store',
    sourceUrl: 'https://example.com/llbean-investment', cleanSourceName: 'Example Business News',
    recommendedBuyingTeam: ['Marketing'], confidence: 80,
    actionabilityStatus: { status: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, label: 'Ongoing business change' },
    evidence: ['Source: Example Business News', 'L.L.Bean investing more than $50 million to reimagine the flagship store']
  };
  const variantReopening = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    opportunityType: 'RENOVATION_COMPLETION', canonicalEventType: 'RENOVATION_COMPLETION',
    signalTitle: 'L.L.Bean flagship reopening after renovation',
    signalSummary: 'L.L.Bean flagship reopening after renovation',
    sourceUrl: 'https://www.bangordailynews.com/llbean-flagship-reopens', cleanSourceName: 'Bangor Daily News',
    confidence: 70,
    actionabilityStatus: { status: 'unknown-date', isPriorityEligible: false, excludeFromPriorities: true, label: 'Date unavailable' },
    evidence: ['Source: Bangor Daily News', 'L.L.Bean flagship reopening after renovation']
  };
  const variantGrandOpening = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    opportunityType: 'RENOVATION_COMPLETION', canonicalEventType: 'RENOVATION_COMPLETION',
    signalTitle: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026',
    signalSummary: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026',
    sourceUrl: 'https://example.com/llbean-grand-opening', cleanSourceName: 'Portland Press Herald',
    confidence: 85, eventDate: '2026-09-18', event_date: '2026-09-18', eventDateDisplay: 'September 18–20, 2026', eventDateConfidence: 'exact',
    actionabilityStatus: { status: 'upcoming', isPriorityEligible: true, excludeFromPriorities: false, label: 'Upcoming' }
  };
  const merged = sandbox.dedupeOpportunities([variantInvestment, variantReopening, variantGrandOpening]);
  assert(merged.length === 1, `required coverage 11: the three L.L.Bean flagship variants merge into exactly one opportunity, not left as separate Additional Opportunities (got ${merged.length})`);
  const winner = merged[0];
  assert(winner.mergedDuplicateCount === 2, `required coverage 11: the merged winner records 2 duplicate variants merged away (got ${winner.mergedDuplicateCount})`);
  assert(winner.actionabilityStatus?.status === 'upcoming', `required coverage 11: the merged initiative becomes Upcoming because it contains the grand-reopening variant's trustworthy future date (got "${winner.actionabilityStatus?.status}")`);
  assert(winner.eventDateDisplay === 'September 18–20, 2026', `required coverage 11: the merged winner carries the real September 18-20, 2026 reopening date range (got "${winner.eventDateDisplay}")`);
  assert(Array.isArray(winner.recommendedBuyingTeam) && winner.recommendedBuyingTeam.includes('Marketing'), `required coverage 11: the merged winner retains the strongest department/contact guidance found across variants (got ${JSON.stringify(winner.recommendedBuyingTeam)})`);
  const evidenceText = JSON.stringify(winner.evidence || []);
  assert(evidenceText.includes('50 million') || evidenceText.includes('investing'), `required coverage 12: the merged initiative retains the $50 million investment fact (got: ${evidenceText})`);
  assert(evidenceText.includes('reopening') || evidenceText.includes('renovation'), `required coverage 12: the merged initiative retains the renovation/reopening context (got: ${evidenceText})`);
  const sourceNames = JSON.stringify(winner.additionalSources || []);
  assert(sourceNames.includes('Bangor') || sourceNames.includes('Portland') || sourceNames.includes('Example'), `required coverage 12: distinct supporting sources from the merged-away variants survive as additionalSources on the winner (got: ${sourceNames})`);

  // Distinct, genuinely unrelated L.L.Bean events must remain separate.
  const unrelatedHiring = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    opportunityType: 'HIRING_ACTIVITY', canonicalEventType: 'HIRING_ACTIVITY',
    signalTitle: 'L.L.Bean is hiring seasonal warehouse staff', signalSummary: 'L.L.Bean is hiring seasonal warehouse staff',
    sourceUrl: 'https://example.com/llbean-hiring', cleanSourceName: 'Different Source', confidence: 60,
    actionabilityStatus: { status: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, label: 'Ongoing business change' }
  };
  const mergedWithUnrelated = sandbox.dedupeOpportunities([variantInvestment, variantReopening, variantGrandOpening, unrelatedHiring]);
  assert(mergedWithUnrelated.length === 2, `required coverage 11: an unrelated L.L.Bean hiring signal remains a separate opportunity, not folded into the flagship initiative (got ${mergedWithUnrelated.length})`);
}

// ---------------------------------------------------------------------------
// required proofs 13-14: the legacy persisted-copy quality gate rejects
// unsupported/pitchy stored conversationStarter text and preserves strong,
// grounded, low-pressure persisted copy.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const opp = { account: 'Acme Co' };
  const pitchy = 'Would you be interested in discussing promotional products for your upcoming event?';
  assert(sandbox.isGroundedOpener(pitchy, opp) === false, `required coverage 13: legacy copy that immediately pitches promotional products is rejected by the quality gate (got accepted: "${pitchy}")`);
  const vague = 'This could be a great opportunity to partner up.';
  assert(sandbox.isGroundedOpener(vague, opp) === false, 'required coverage 13: a vague "great opportunity" hook with no factual connection is rejected');
  const inventedCelebration = 'We would love to help enhance the celebration with branded merchandise.';
  assert(sandbox.isGroundedOpener(inventedCelebration, opp) === false, 'required coverage 13: copy inventing a celebration/merchandise plan the source never described is rejected');
  const integration = 'Happy to help celebrate the integration with custom gifts.';
  assert(sandbox.isGroundedOpener(integration, opp) === false, 'required coverage 13: invented "celebrate the integration" copy is rejected');
  const genericAssist = 'Can we discuss how we can assist with your goals?';
  assert(sandbox.isGroundedOpener(genericAssist, opp) === false, 'required coverage 13: generic "how can we assist" filler is rejected');

  const grounded = 'Saw New Hope Network has acquired the assets of Nutrition Capital Network. Do you know who is leading the integration?';
  assert(sandbox.isGroundedOpener(grounded, { account: 'New Hope Network' }) === true, `required coverage 14: specific, factual, low-pressure persisted copy is preserved, not silently overwritten (got rejected: "${grounded}")`);
  const groundedLLBean = 'Saw L.L.Bean is reopening the Freeport flagship in September. Do you know who is leading the reopening?';
  assert(sandbox.isGroundedOpener(groundedLLBean, { account: 'L.L.Bean' }) === true, `required coverage 14: a second real, factual, grounded opener also survives the gate (got rejected: "${groundedLLBean}")`);

  // Malformed punctuation / duplicated account phrasing on a LEGACY row is
  // rejected outright (never silently rewritten -- storage is untouched).
  const malformedPunctuation = 'Saw L.L.Bean is investing -- - pitch - - just wanted to check in.';
  assert(sandbox.isGroundedOpener(malformedPunctuation, { account: 'L.L.Bean' }) === false, `required coverage 13/15: legacy copy with a malformed "- -" artifact is rejected (got accepted: "${malformedPunctuation}")`);
  const doubledAccount = 'Saw L.L.Bean is investing in the flagship store at L.L.Bean this year.';
  assert(sandbox.isGroundedOpener(doubledAccount, { account: 'L.L.Bean' }) === false, `required coverage 13/15: legacy copy with a duplicated account mention is rejected (got accepted: "${doubledAccount}")`);
}

// ---------------------------------------------------------------------------
// required proof 15: no freshly generated outreach copy anywhere contains a
// literal "--", "- -", a duplicate period, or a duplicated account mention
// -- proven across every outreach surface (email, Best Next Move, call
// script, questions, subject, opportunity summary) for a realistic
// acquisition scenario with a trailing-punctuation, account-repeating raw
// signal title (the exact shape that produced every artifact in the
// Preview report).
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const opp = {
    account: 'L.L.Bean', contact: 'Marketing', contactTitle: 'Marketing',
    signalTitle: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026.',
    canonicalEventType: 'RENOVATION_COMPLETION', opportunityType: 'RENOVATION_COMPLETION',
    recommendedBuyingTeam: ['Retail Operations'], likelyBuyers: ['Retail Operations']
  };
  const department = sandbox.groundedDepartmentForOpportunity(opp);
  const initiativeTitle = sandbox.groundedInitiativeTitle(opp);
  const canonicalKind = sandbox.canonicalSignalKind(opp);
  const ctx = {
    account: opp.account, firstName: 'there', mode: 'Cold', reasonTitle: initiativeTitle, whyNow: '',
    category: 'apparel', signalType: 'expansion', canonicalKind, department, initiativeTitle,
    isUpcoming: true, actionabilityTense: 'future', hasKnownContact: false
  };
  const play = sandbox.buildConciseSalesPlay(ctx);
  const surfaces = {
    outreachEmail: play.outreachEmail,
    bestNextMove: play.bestNextMove,
    bestNextMoveCombined: play.bestNextMoveCombined,
    emailSubject: play.emailSubject,
    callScript: play.callScript.join(' '),
    questionsToAsk: play.questionsToAsk.join(' '),
    opportunitySummary: play.opportunitySummary.join(' ')
  };
  for(const [name, text] of Object.entries(surfaces)){
    assert(!text.includes('--'), `required proof 15: ${name} never contains a literal "--" (got: "${text}")`);
    assert(!/-\s+-/.test(text), `required proof 15: ${name} never contains a literal "- -" (got: "${text}")`);
    assert(!/\.\.(?!\.)/.test(text), `required proof 15: ${name} never contains a duplicate period (got: "${text}")`);
    assert(!/L\.L\.Bean.*L\.L\.Bean/.test(text), `required proof 15: ${name} never mentions the account twice (got: "${text}")`);
  }
  assert(surfaces.emailSubject.length < 60, `subject stays concise (got: "${surfaces.emailSubject}")`);
}

// ---------------------------------------------------------------------------
// required proof 16: subject lines use the named initiative/event family
// when one is available -- proven for the L.L.Bean flagship reopening.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const subj = sandbox.conciseSubject({ mode: 'Cold', account: 'L.L.Bean', initiativeTitle: 'L.L.Bean flagship reopening after renovation, grand opening scheduled for September 18-20, 2026', signalType: 'expansion' });
  assert(/reopening/i.test(subj), `required coverage 16: the subject uses the named reopening initiative, not a generic subject (got: "${subj}")`);
  assert(subj !== 'Saw the expansion', 'required coverage 16: never falls back to the generic "Saw the expansion" when a named initiative is available');
}

// ---------------------------------------------------------------------------
// required proof 17: the defensive rendered-output invariant -- no
// opportunity whose rendered status is "Date unavailable" or "No longer
// current" may ever enter a current priority feed (This Week, "View All
// Opportunities", or the summary count), even when a missing/malformed
// actionabilityStatus flag would have (under the OLD check) claimed it was
// eligible. This is the actual dashboard leak traced and fixed this round
// -- priorityEligibleOpportunities() is the real, single choke point behind
// This Week/Month/Quarter/Year, "View All Opportunities", and the summary
// count (all reachable via renderWeeklyPrioritiesFeed() below), not an
// unused parallel helper.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  // Reproduces the exact leak: a signal-derived opportunity with NO
  // actionabilityStatus at all (a malformed/legacy shape) -- its own
  // rendered status is honestly "Date unavailable", but the OLD filter
  // (`actionabilityStatus?.isPriorityEligible !== false`) would have
  // treated it as eligible, since `undefined !== false` is true.
  const leakingOpp = {
    account: 'HPGR', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/hpgr-webinar',
    signalLayerType: 'Business Activity Signal', signalType: 'Event',
    signalTitle: "HPGR's HRCe product webinar", signalSummary: "HPGR's HRCe product webinar",
    confidence: 70, publishedDate: new Date(NOW.getTime() - 2 * 86400000).toISOString(), signalDate: new Date(NOW.getTime() - 2 * 86400000).toISOString()
  };
  const renderedLabel = sandbox.signalDateAndActionabilityLine(leakingOpp);
  assert(renderedLabel === 'Date unavailable', `sanity: the leaking fixture's own rendered status really is "Date unavailable" (got: "${renderedLabel}")`);
  const oldStyleEligible = leakingOpp?.actionabilityStatus?.isPriorityEligible !== false;
  assert(oldStyleEligible === true, 'sanity: the OLD flag-based check alone would have wrongly treated this fixture as eligible (undefined !== false)');
  assert(sandbox.isPriorityEligibleOpportunity(leakingOpp) === false, 'required proof 17: isPriorityEligibleOpportunity() correctly excludes an opportunity whose rendered status is "Date unavailable", regardless of what a missing/stale flag would have claimed');
  assert(sandbox.priorityEligibleOpportunities([leakingOpp]).length === 0, 'required proof 17: priorityEligibleOpportunities() excludes the leaking fixture');

  for(const timebox of ['week', 'month', 'quarter', 'annual']){
    for(const showAll of [false, true]){
      sandbox.__setActiveTimebox(timebox);
      sandbox.__setShowAllWeeklyPriorities(showAll);
      const result = sandbox.renderWeeklyPrioritiesFeed([leakingOpp], [{ name: 'HPGR' }]);
      assert(result.displayedOpportunities.length === 0, `required proof 17: the undated HPGR webinar never renders as a priority card in "${timebox}" (showAll=${showAll}) (got ${result.displayedOpportunities.length} displayed)`);
      const gridHtml = sandbox.document.getElementById('opportunitiesGrid').innerHTML;
      assert(!gridHtml.includes('HRCe product webinar'), `required proof 17: the rendered grid HTML never contains the undated card in "${timebox}" (showAll=${showAll})`);
    }
  }

  // A "No longer current" (stale) opportunity is excluded the same way.
  const staleOpp = {
    account: 'Propane Gas Association of New England', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/propane-ribbon',
    signalLayerType: 'Business Activity Signal', signalType: 'Event',
    signalTitle: 'ribbon-cutting ceremony', confidence: 70,
    eventDate: '2025-10-09', event_date: '2025-10-09', eventDateConfidence: 'exact',
    actionabilityStatus: { status: 'stale', isPriorityEligible: false, excludeFromPriorities: true, label: 'No longer current' }
  };
  assert(sandbox.isPriorityEligibleOpportunity(staleOpp) === false, 'required proof 17: a "No longer current" (stale) opportunity is never priority-eligible');
}

// ---------------------------------------------------------------------------
// required proof 18: the priority summary count is recomputed from the
// FINAL eligible/deduped set -- it can never be inflated by a hidden/
// ineligible card, and always exactly equals the number of cards actually
// rendered.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  sandbox.__setActiveTimebox('week');
  sandbox.__setShowAllWeeklyPriorities(false);
  const eligibleOpp = {
    account: 'Acme Co', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/acme-tradeshow',
    signalLayerType: 'Business Activity Signal', signalType: 'Event', signalTitle: 'Acme trade show',
    confidenceScore: 80, evidence: ['genuinely this week'],
    publishedDate: new Date(NOW.getTime() - 2 * 86400000).toISOString(),
    signalDate: new Date(NOW.getTime() - 2 * 86400000).toISOString(),
    eventDate: new Date(NOW.getTime() + 10 * 86400000).toISOString().slice(0,10), eventDateConfidence: 'exact',
    actionabilityStatus: { status: 'upcoming', isPriorityEligible: true, excludeFromPriorities: false, label: 'Upcoming' }
  };
  // The exact leaking shape from required proof 17 -- must never inflate
  // the count even though it is included in the input array.
  const ineligibleOpp = {
    account: 'HPGR', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/hpgr-webinar-2',
    signalLayerType: 'Business Activity Signal', signalType: 'Event', signalTitle: 'HPGR webinar',
    confidenceScore: 70, publishedDate: new Date(NOW.getTime() - 2 * 86400000).toISOString(), signalDate: new Date(NOW.getTime() - 2 * 86400000).toISOString()
  };
  const result = sandbox.renderWeeklyPrioritiesFeed([eligibleOpp, ineligibleOpp], [{ name: 'Acme Co' }, { name: 'HPGR' }]);
  const label = sandbox.document.getElementById('resultCount').innerHTML;
  const match = label.match(/(\d+) accounts? worth reviewing/);
  assert(Boolean(match), `required proof 18: the summary label has the expected "N accounts worth reviewing" shape (got: "${label}")`);
  const summaryCount = match ? Number(match[1]) : -1;
  assert(summaryCount === result.displayedOpportunities.length, `required proof 18: the displayed summary count exactly equals the number of rendered eligible cards (summary: ${summaryCount}, rendered: ${result.displayedOpportunities.length})`);
  assert(summaryCount === 1, `required proof 18: only the genuinely eligible opportunity is counted -- the ineligible one never inflates the summary (got ${summaryCount})`);
}

// ===========================================================================
// Section E — Fourth QA correction round: the read-time classification
// boundary (classifyLegacySignalActionability now also returns
// canonicalEventType), the opportunityType/canonicalEventType field-name
// collision (opp.opportunityType doubles as a generic "SIGNAL-DRIVEN"/
// "REPEAT PATTERN" display label, which previously masked the real
// classification from canonicalSignalKind()/opportunitiesLikelySameInitiative()
// whenever it was set), event-like classification gaps (open house/
// festival/rodeo/bare tournament), and the expanded legacy-copy quality
// gate.
// ===========================================================================

// ---------------------------------------------------------------------------
// acceptance test 1: L.L.Bean's flagship initiative is not Acquisition, now
// proven through the read-time boundary too (not just the raw classifier).
// ---------------------------------------------------------------------------
{
  const legacy = classifyLegacySignalActionability({
    signalTitle: 'L.L.Bean investing more than $50 million to reimagine the flagship store',
    whatChanged: 'L.L.Bean investing more than $50 million to reimagine the flagship store in Freeport, Maine.'
  });
  assert(legacy.canonicalEventType !== 'ACQUISITION', `acceptance 1: classifyLegacySignalActionability() (the legacy read-time boundary) never classifies L.L.Bean's investment as Acquisition (got "${legacy.canonicalEventType}")`);
  assert(legacy.canonicalEventType === 'RENOVATION_COMPLETION', `acceptance 1: the read-time boundary now returns the specific classification, not just the coarse eventCategory (got "${legacy.canonicalEventType}")`);
  assert(legacy.opportunityType === legacy.canonicalEventType, 'acceptance 1: classifyLegacySignalActionability() returns opportunityType as a direct alias of canonicalEventType, consistent with makeSignal()');
}

// ---------------------------------------------------------------------------
// acceptance tests 2-3: New Hope's true acquisition remains Acquisition;
// Reading Symphony's grant remains Grant/Award, both re-verified through the
// SAME legacy read-time boundary this round fixed (not just the raw
// resolveCanonicalEventType() already covered by required proofs 8-9 above).
// ---------------------------------------------------------------------------
{
  const newHope = classifyLegacySignalActionability({
    signalTitle: 'New Hope Network has acquired the assets of Nutrition Capital Network, expanding its portfolio.'
  });
  assert(newHope.canonicalEventType === 'ACQUISITION', `acceptance 2: New Hope Network's genuine acquisition still reads as Acquisition through the legacy boundary (got "${newHope.canonicalEventType}")`);

  const readingSymphony = classifyLegacySignalActionability({
    signalTitle: 'Reading Symphony received a $15,000 grant', whatChanged: 'Reading Symphony was awarded a $15,000 grant from the NEA'
  });
  assert(readingSymphony.canonicalEventType === 'EVENT_AWARD', `acceptance 3: Reading Symphony's grant reads as Grant/Award, not Acquisition, through the legacy boundary (got "${readingSymphony.canonicalEventType}")`);
}

// ---------------------------------------------------------------------------
// acceptance tests 4-5: the actual production regression -- reproduced by
// building opportunity objects the way addSignalDerivedOpportunities()
// (dashboard/index.html) really does: opportunityType forced to the generic
// display label 'SIGNAL-DRIVEN' (used for the "Signal-driven" badge
// elsewhere), with canonicalEventType carrying the real classification
// alongside it. Before this round's fix, opportunitiesLikelySameInitiative()
// and canonicalSignalKind() read opp.opportunityType FIRST, so this exact
// shape defeated clustering (both variants disagreed on "type" because both
// showed 'SIGNAL-DRIVEN', which is not in CANONICAL_KIND_BY_EVENT_TYPE) --
// and if two variants' overlap fell into the exact-type-match branch, the
// mismatch could keep them apart entirely.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const account = 'L.L.Bean';
  const investment = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    opportunityType: 'SIGNAL-DRIVEN', canonicalEventType: 'RENOVATION_COMPLETION',
    signalTitle: 'L.L.Bean is investing more than $50 million to reimagine the flagship store',
    signalSummary: 'L.L.Bean is investing more than $50 million to reimagine the flagship store in Freeport, Maine',
    sourceUrl: 'https://example.com/llbean-investment-2', cleanSourceName: 'Example Business News',
    recommendedBuyingTeam: ['Marketing'], confidence: 78,
    actionabilityStatus: { status: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, label: 'Ongoing business change' }
  };
  const reopening = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    opportunityType: 'SIGNAL-DRIVEN', canonicalEventType: 'RENOVATION_COMPLETION',
    signalTitle: 'L.L.Bean is reopening its flagship store after a significant renovation',
    signalSummary: 'L.L.Bean is reopening its flagship store after a significant renovation in Freeport, Maine',
    sourceUrl: 'https://www.bangordailynews.com/llbean-flagship-reopens-2', cleanSourceName: 'Bangor Daily News',
    confidence: 74,
    actionabilityStatus: { status: 'unknown-date', isPriorityEligible: false, excludeFromPriorities: true, label: 'Date unavailable' }
  };
  const grandOpening = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    opportunityType: 'SIGNAL-DRIVEN', canonicalEventType: 'RENOVATION_COMPLETION',
    signalTitle: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026',
    signalSummary: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026 in Freeport, Maine',
    sourceUrl: 'https://example.com/llbean-grand-opening-2', cleanSourceName: 'Portland Press Herald',
    confidence: 88, eventDate: '2026-09-18', event_date: '2026-09-18', eventDateDisplay: 'September 18–20, 2026', eventDateConfidence: 'exact',
    actionabilityStatus: { status: 'upcoming', isPriorityEligible: true, excludeFromPriorities: false, label: 'Upcoming' }
  };
  const deduped = sandbox.dedupeOpportunities([investment, reopening, grandOpening]);
  assert(deduped.length === 1, `acceptance 4: the investment/reopening/grand-opening variants (with the real opp.opportunityType='SIGNAL-DRIVEN' collision reproduced) still merge into exactly one opportunity (got ${deduped.length})`);
  const winner = deduped[0];
  assert(winner.canonicalEventType !== 'ACQUISITION', `acceptance 4: the merged winner's classification is never Acquisition (got "${winner.canonicalEventType}")`);
  const headline = sandbox.opportunityHeadline(winner);
  assert(headline !== 'Acquisition creates a reason to reconnect', `acceptance 4: the card headline for the merged L.L.Bean flagship initiative is never the acquisition headline (got "${headline}")`);
  assert(/growth|activity|upcoming|relevant/i.test(headline), `acceptance 4: the headline reflects the real expansion/event classification (got "${headline}")`);

  // acceptance 5: the losing "reopening" variant must not remain as a
  // separate opportunity -- this is exactly the array
  // accountOpportunityCluster()/additionalOpportunitiesFor() (Research
  // Details' "Additional Opportunities Found" section) draws from.
  const reopeningStillPresent = deduped.some(o => o !== winner && /reopening its flagship store/i.test(o.signalTitle || ''));
  assert(!reopeningStillPresent, 'acceptance 5: the merged-away reopening variant does not survive as its own Additional Opportunity');
  assert(deduped.length === 1 && winner.mergedDuplicateCount === 2, `acceptance 5: the winner records exactly 2 variants merged away, confirming all three collapsed into one card (got length=${deduped.length}, mergedDuplicateCount=${winner.mergedDuplicateCount})`);
}

// ---------------------------------------------------------------------------
// acceptance tests 6-8: event actionability consistency -- Aileen Graf's
// undated open house stays detail-only (never "Ongoing business change"),
// Sandwich Stampede's explicit July 17-18, 2026 range is a Recent event, and
// event-like signals never fall back to Ongoing business change through the
// generic-family fallback path.
// ---------------------------------------------------------------------------
{
  // acceptance 6: Aileen Graf -- exact stored text from the frozen fixture
  // in scripts/test-canonical-classification.js (rank 4).
  const aileenGraf = makeSignal({
    accountName: 'Aileen Graf', signalTitle: 'Open House Event',
    whatChanged: 'An open house is scheduled for a property designed by Aileen Graf.',
    business_context: 'The open house indicates a marketing push for the property, which may require promotional materials.',
    sourceUrl: 'https://destinyagents.com/home-search/listings/x'
  }, { name: 'Aileen Graf' });
  assert(!!aileenGraf, 'acceptance 6: makeSignal() retains the Aileen Graf open house signal');
  assert(aileenGraf.canonicalEventType === 'EVENT_COMMUNITY', `acceptance 6: the open house classifies event-like (EVENT_COMMUNITY), not the generic ongoing bucket (got "${aileenGraf.canonicalEventType}")`);
  assert(aileenGraf.eventCategory === 'event-like', `acceptance 6: eventCategory is event-like (got "${aileenGraf.eventCategory}")`);
  assert(aileenGraf.actionabilityStatus.status === 'unknown-date', `acceptance 6: with no trustworthy date, status is Date unavailable, not Ongoing business change (got "${aileenGraf.actionabilityStatus.status}")`);
  assert(aileenGraf.actionabilityStatus.isPriorityEligible === false, 'acceptance 6: the undated open house is excluded from current priorities (detail-only)');

  // acceptance 7: Sandwich Stampede -- an explicit July 17-18, 2026 event
  // date range, viewed August 4, 2026 (NOW), must read as a Recent event.
  const sandwichStampede = makeSignal({
    accountName: 'Sandwich Stampede', signalTitle: 'Sandwich Stampede festival',
    whatChanged: 'The Sandwich Stampede festival took place July 17-18, 2026, drawing thousands of attendees.',
    business_context: 'The festival is a major annual community draw for the town.',
    sourceUrl: 'https://example.com/sandwich-stampede-2026'
  }, { name: 'Sandwich Stampede' });
  assert(!!sandwichStampede, 'acceptance 7: makeSignal() retains the Sandwich Stampede signal');
  assert(sandwichStampede.canonicalEventType === 'EVENT_COMMUNITY', `acceptance 7: the festival classifies event-like (EVENT_COMMUNITY) (got "${sandwichStampede.canonicalEventType}")`);
  assert(sandwichStampede.eventDate === '2026-07-17', `acceptance 7: the explicit July 17-18, 2026 range anchors to its first day (got "${sandwichStampede.eventDate}")`);
  assert(sandwichStampede.actionabilityStatus.status === 'recent-past', `acceptance 7: viewed August 4, 2026, the July 17-18, 2026 festival is a Recent event (got "${sandwichStampede.actionabilityStatus.status}")`);
  assert(sandwichStampede.actionabilityStatus.label !== 'Ongoing business change', `acceptance 7: the label is never "Ongoing business change" for this explicit-date event (got "${sandwichStampede.actionabilityStatus.label}")`);

  // acceptance 8: event-like signals cannot become Ongoing business change
  // merely because their wording doesn't hit one of the narrower categories
  // -- rodeo and bare "tournament" (not just "golf tournament") are
  // additional examples of the same class of gap this round closed.
  const rodeo = resolveCanonicalEventType({ signalTitle: 'Downtown rodeo returns for its 40th year' });
  assert(EVENT_LIKE_TYPES.has(rodeo.eventType), `acceptance 8: a rodeo signal classifies as an event-like type (got "${rodeo.eventType}")`);
  const tournament = resolveCanonicalEventType({ signalTitle: 'Company hosts annual fishing tournament for employees' });
  assert(EVENT_LIKE_TYPES.has(tournament.eventType), `acceptance 8: a bare (non-golf) tournament signal classifies as an event-like type (got "${tournament.eventType}")`);
}

// ---------------------------------------------------------------------------
// acceptance tests 9-11: the expanded legacy-copy quality gate rejects the
// exact pitchy phrases still visible in Preview on the L.L.Bean, Farmers,
// Sandwich Stampede, and Aileen Graf cards, while preserving strong,
// low-pressure grounded copy and catching duplicated account phrasing.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const llbean = { account: 'L.L.Bean' };
  const farmers = { account: 'Farmers' };
  const sandwich = { account: 'Sandwich Stampede' };
  const aileen = { account: 'Aileen Graf' };

  const pitchyMerch = 'Would you be interested in discussing promotional products for your upcoming event?';
  assert(sandbox.isGroundedOpener(pitchyMerch, llbean) === false, `acceptance 9: "${pitchyMerch}" is rejected by the quality gate`);

  const vagueOpportunity = 'This could be a great opportunity for your team.';
  assert(sandbox.isGroundedOpener(vagueOpportunity, farmers) === false, `acceptance 9: "${vagueOpportunity}" is rejected by the quality gate`);

  const canWeDiscuss = 'Can we discuss this further?';
  assert(sandbox.isGroundedOpener(canWeDiscuss, sandwich) === false, `acceptance 9: "${canWeDiscuss}" is rejected by the quality gate`);

  const anythingComingUp = 'Anything coming up that we should be thinking about?';
  assert(sandbox.isGroundedOpener(anythingComingUp, aileen) === false, `acceptance 9: "${anythingComingUp}" is rejected by the quality gate`);

  const customMerchandise = 'I would be interested in discussing custom merchandise options with your team.';
  assert(sandbox.isGroundedOpener(customMerchandise, farmers) === false, `acceptance 9: "${customMerchandise}" is rejected by the quality gate`);

  const canWeChat = 'Can we chat about this?';
  assert(sandbox.isGroundedOpener(canWeChat, sandwich) === false, `acceptance 9: "${canWeChat}" is rejected by the quality gate`);

  // acceptance 10: strong, low-pressure, factual persisted copy remains
  // preserved -- the gate rejects pitchy/generic copy, not every legacy row.
  const groundedFarmers = 'Saw Farmers is expanding its downtown branch. Do you know who is leading that project?';
  assert(sandbox.isGroundedOpener(groundedFarmers, farmers) === true, `acceptance 10: specific, factual, low-pressure persisted copy for Farmers survives the gate (got rejected: "${groundedFarmers}")`);
  const groundedSandwich = 'Saw the Sandwich Stampede festival wrapped up last month. Do you know who organizes it each year?';
  assert(sandbox.isGroundedOpener(groundedSandwich, sandwich) === true, `acceptance 10: specific, factual, low-pressure persisted copy for Sandwich Stampede survives the gate (got rejected: "${groundedSandwich}")`);

  // acceptance 11: no duplicated account phrase, exactly the shape reported
  // in Preview.
  const doubledLLBean = 'Saw L.L.Bean is investing in the flagship store at L.L.Bean this year.';
  assert(sandbox.isGroundedOpener(doubledLLBean, llbean) === false, `acceptance 11: "${doubledLLBean}" (duplicated account mention) is rejected by the quality gate`);
}

// ---------------------------------------------------------------------------
// acceptance test 12: Opportunity Summary is grammatically complete even
// when the underlying initiative title is a full clause ("L.L.Bean is
// investing... coming up"), and the fix is generic/dynamic -- proven with a
// SECOND, unrelated account/initiative to confirm nothing is hardcoded to
// L.L.Bean-specific wording.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const ctxLLBean = {
    account: 'L.L.Bean', firstName: 'there', mode: 'Cold',
    reasonTitle: 'L.L.Bean is investing more than $50 million to reimagine the flagship store',
    whyNow: '', category: 'apparel', signalType: 'expansion', department: 'Marketing',
    initiativeTitle: 'L.L.Bean is investing more than $50 million to reimagine the flagship store',
    isUpcoming: false, actionabilityTense: 'ongoing', hasKnownContact: false
  };
  const playLLBean = sandbox.buildConciseSalesPlay(ctxLLBean);
  const summaryLLBean = playLLBean.opportunitySummary.join(' ');
  assert(/\. That creates a timely reason to reach out\./.test(summaryLLBean) || /creates a timely reason to reach out\./.test(summaryLLBean), `acceptance 12: L.L.Bean's Opportunity Summary is grammatically complete (got: "${summaryLLBean}")`);
  assert(!/store coming up creates a timely reason/.test(summaryLLBean), `acceptance 12: the summary is never the run-on "...store coming up creates a timely reason..." shape (got: "${summaryLLBean}")`);

  // A second, unrelated account/initiative proves the fix is generic, not
  // hardcoded to L.L.Bean's own wording.
  const ctxFarmers = {
    account: 'Farmers', firstName: 'there', mode: 'Cold',
    reasonTitle: 'Farmers is expanding its downtown branch',
    whyNow: '', category: 'apparel', signalType: 'expansion', department: 'Operations',
    initiativeTitle: 'Farmers is expanding its downtown branch',
    isUpcoming: false, actionabilityTense: 'ongoing', hasKnownContact: false
  };
  const playFarmers = sandbox.buildConciseSalesPlay(ctxFarmers);
  const summaryFarmers = playFarmers.opportunitySummary.join(' ');
  assert(summaryFarmers.includes('That creates a timely reason to reach out.'), `acceptance 12: Farmers' Opportunity Summary uses the same generic, dynamic construction (got: "${summaryFarmers}")`);
  assert(!/branch coming up creates a timely reason/.test(summaryFarmers), `acceptance 12: Farmers' summary is never a run-on either (got: "${summaryFarmers}")`);
}

// ---------------------------------------------------------------------------
// acceptance test 13: priority summary counts remain equal to visible
// eligible cards -- re-verified end to end with the Aileen Graf/Sandwich
// Stampede fixtures from acceptance tests 6-7 mixed into the same feed.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  sandbox.__setActiveTimebox('week');
  sandbox.__setShowAllWeeklyPriorities(false);
  const eligibleStampede = {
    account: 'Sandwich Stampede', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/sandwich-stampede-2026',
    signalLayerType: 'Business Activity Signal', signalType: 'Event', signalTitle: 'Sandwich Stampede festival',
    canonicalEventType: 'EVENT_COMMUNITY', confidenceScore: 75,
    publishedDate: new Date(NOW.getTime() - 18 * 86400000).toISOString(),
    signalDate: new Date(NOW.getTime() - 18 * 86400000).toISOString(),
    eventDate: '2026-07-17', eventDateConfidence: 'exact',
    actionabilityStatus: { status: 'recent-past', isPriorityEligible: true, excludeFromPriorities: false, label: 'Recent event' }
  };
  const ineligibleAileen = {
    account: 'Aileen Graf', isVerifiedSignalOpportunity: true, sourceUrl: 'https://destinyagents.com/home-search/listings/x',
    signalLayerType: 'Business Activity Signal', signalType: 'Event', signalTitle: 'Open House Event',
    canonicalEventType: 'EVENT_COMMUNITY', confidenceScore: 33,
    publishedDate: new Date(NOW.getTime() - 5 * 86400000).toISOString(),
    signalDate: new Date(NOW.getTime() - 5 * 86400000).toISOString(),
    actionabilityStatus: { status: 'unknown-date', isPriorityEligible: false, excludeFromPriorities: true, label: 'Date unavailable' }
  };
  const result = sandbox.renderWeeklyPrioritiesFeed([eligibleStampede, ineligibleAileen], [{ name: 'Sandwich Stampede' }, { name: 'Aileen Graf' }]);
  const label = sandbox.document.getElementById('resultCount').innerHTML;
  const match = label.match(/(\d+) accounts? worth reviewing/);
  assert(Boolean(match), `acceptance 13: the summary label has the expected shape (got: "${label}")`);
  const summaryCount = match ? Number(match[1]) : -1;
  assert(summaryCount === result.displayedOpportunities.length, `acceptance 13: the displayed summary count exactly equals the number of rendered eligible cards (summary: ${summaryCount}, rendered: ${result.displayedOpportunities.length})`);
  assert(summaryCount === 1, `acceptance 13: only Sandwich Stampede (Recent event) is counted -- Aileen Graf's undated open house never inflates the summary (got ${summaryCount})`);
}


// ===========================================================================
// Section F — Fifth QA correction round (narrow): complete absorption of
// merged-cluster members whose SPECIFIC classification differs even though
// they belong to the same RELATED_EVENT_TYPE_CLUSTERS family, and the
// remaining ungated Conversation Starter surface (Research Details' "likely
// conversations" preview, read directly from signal.conversationStarter
// without going through getSuggestedOpener()/isGroundedOpener()).
// ===========================================================================

// ---------------------------------------------------------------------------
// root cause 1: three real L.L.Bean flagship article titles, EACH one's
// canonicalEventType computed by the actual production classifier
// (resolveCanonicalEventType(), not hand-set) -- proving they land on three
// DIFFERENT specific types (RENOVATION_COMPLETION / LOCATION_REOPENING /
// LOCATION_EVENT_UNSPECIFIED) despite describing the same real initiative.
// Before this round's fix, opportunitiesLikelySameInitiative()'s last branch
// required an EXACT type match on top of 50%+ title-token overlap, so any
// pairing among these three that lacked a shared source domain or a close
// date (the investment article carries no event date at all) never merged.
// ---------------------------------------------------------------------------
{
  const investmentType = resolveCanonicalEventType({ signalTitle: 'L.L.Bean is investing more than $50 million to reimagine the flagship store' });
  const reopeningType = resolveCanonicalEventType({ signalTitle: 'L.L.Bean flagship store to reopen this fall' });
  const grandOpeningType = resolveCanonicalEventType({ signalTitle: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026' });
  assert(investmentType.eventType === 'RENOVATION_COMPLETION', `root cause 1: the investment article classifies RENOVATION_COMPLETION (got "${investmentType.eventType}")`);
  assert(reopeningType.eventType === 'LOCATION_REOPENING', `root cause 1: the reopening article classifies LOCATION_REOPENING (got "${reopeningType.eventType}")`);
  assert(grandOpeningType.eventType === 'LOCATION_EVENT_UNSPECIFIED', `root cause 1: the ambiguous "grand opening" article classifies LOCATION_EVENT_UNSPECIFIED (got "${grandOpeningType.eventType}")`);
  assert(investmentType.eventType !== reopeningType.eventType && reopeningType.eventType !== grandOpeningType.eventType, 'root cause 1: confirms all three real articles land on three DIFFERENT specific types -- the exact-type-match requirement this round removes was the actual clustering gap');
}

// ---------------------------------------------------------------------------
// acceptance test: rendered-output regression using these exact three
// variants (real titles, real computed classification, no shared source
// domain, no close/shared dates between the investment article and the
// others) -- proving one flagship opportunity exists, it is Upcoming with
// the September 18-20, 2026 date, it carries the investment/renovation/
// reopening facts, and no absorbed variant remains under Additional
// Opportunities.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const account = 'L.L.Bean';
  const investment = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    canonicalEventType: resolveCanonicalEventType({ signalTitle: 'L.L.Bean is investing more than $50 million to reimagine the flagship store' }).eventType,
    opportunityType: 'SIGNAL-DRIVEN',
    signalTitle: 'L.L.Bean is investing more than $50 million to reimagine the flagship store',
    signalSummary: 'L.L.Bean is investing more than $50 million to reimagine the flagship store in Freeport, Maine',
    sourceUrl: 'https://example.com/llbean-50-million-investment', cleanSourceName: 'Example Business News',
    recommendedBuyingTeam: ['Marketing'], confidence: 78,
    actionabilityStatus: { status: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, label: 'Ongoing business change' }
  };
  const reopening = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    canonicalEventType: resolveCanonicalEventType({ signalTitle: 'L.L.Bean flagship store to reopen this fall' }).eventType,
    opportunityType: 'SIGNAL-DRIVEN',
    signalTitle: 'L.L.Bean flagship store to reopen this fall',
    signalSummary: 'L.L.Bean flagship store in Freeport, Maine to reopen this fall',
    sourceUrl: 'https://www.bangordailynews.com/llbean-flagship-reopens-fall', cleanSourceName: 'Bangor Daily News',
    confidence: 74,
    actionabilityStatus: { status: 'unknown-date', isPriorityEligible: false, excludeFromPriorities: true, label: 'Date unavailable' }
  };
  const grandOpening = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    canonicalEventType: resolveCanonicalEventType({ signalTitle: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026' }).eventType,
    opportunityType: 'SIGNAL-DRIVEN',
    signalTitle: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026',
    signalSummary: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026 in Freeport, Maine',
    sourceUrl: 'https://example.com/llbean-grand-opening-sept-2026', cleanSourceName: 'Portland Press Herald',
    confidence: 88, eventDate: '2026-09-18', event_date: '2026-09-18', eventDateDisplay: 'September 18–20, 2026', eventDateConfidence: 'exact',
    actionabilityStatus: { status: 'upcoming', isPriorityEligible: true, excludeFromPriorities: false, label: 'Upcoming' }
  };
  const deduped = sandbox.dedupeOpportunities([investment, reopening, grandOpening]);
  assert(deduped.length === 1, `acceptance: the investment/reopening/grand-opening articles (three different specific types, same related-cluster family) merge into exactly one opportunity (got ${deduped.length})`);
  const winner = deduped[0];
  assert(winner.actionabilityStatus?.status === 'upcoming', `acceptance: the merged flagship opportunity is Upcoming, inheriting the grand-opening variant's real date (got "${winner.actionabilityStatus?.status}")`);
  assert(winner.eventDateDisplay === 'September 18–20, 2026', `acceptance: the merged opportunity carries the September 18-20, 2026 date range (got "${winner.eventDateDisplay}")`);
  const evidenceText = JSON.stringify(winner.evidence || []);
  assert(evidenceText.includes('50 million') || evidenceText.includes('investing'), `acceptance: the merged opportunity retains the $50 million investment fact (got: ${evidenceText})`);
  assert(evidenceText.includes('reopen'), `acceptance: the merged opportunity retains the reopening fact (got: ${evidenceText})`);
  assert(evidenceText.includes('grand opening') || evidenceText.includes('September'), `acceptance: the merged opportunity retains the grand-opening/September fact (got: ${evidenceText})`);
  const investmentStillSeparate = deduped.some(o => o !== winner && /50 million/i.test(o.signalTitle || ''));
  assert(!investmentStillSeparate, 'acceptance: the $50 million investment variant does not survive as a separate Additional Opportunity');
  assert(winner.mergedDuplicateCount === 2, `acceptance: the winner records exactly 2 absorbed variants (got ${winner.mergedDuplicateCount})`);

  // Distinct, genuinely unrelated L.L.Bean initiatives must remain separate
  // even with this looser type-family matching -- a hiring signal shares
  // neither the type family nor meaningful title overlap.
  const unrelatedHiring = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    canonicalEventType: 'HIRING_ACTIVITY', opportunityType: 'SIGNAL-DRIVEN',
    signalTitle: 'L.L.Bean is hiring seasonal warehouse staff', signalSummary: 'L.L.Bean is hiring seasonal warehouse staff',
    sourceUrl: 'https://example.com/llbean-hiring-3', cleanSourceName: 'Different Source', confidence: 60,
    actionabilityStatus: { status: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, label: 'Ongoing business change' }
  };
  const dedupedWithUnrelated = sandbox.dedupeOpportunities([investment, reopening, grandOpening, unrelatedHiring]);
  assert(dedupedWithUnrelated.length === 2, `acceptance: the unrelated hiring signal remains a separate opportunity, not folded into the flagship initiative (got ${dedupedWithUnrelated.length})`);
}

// ---------------------------------------------------------------------------
// root cause 2 / acceptance: Research Details' "likely conversations"
// preview (renderSingleVerifiedSignal(), part of renderVerifiedSignals())
// read signal.conversationStarter directly, bypassing getSuggestedOpener()/
// isGroundedOpener() entirely -- so pitchy, truncated, or duplicate-account
// legacy copy could still surface there even after the dashboard card and
// Prepare for Call panel were both correctly gated in the prior round. Fixed
// by routing it through the SAME shared selector, getSuggestedOpener().
// Every exact phrase reported in Preview is proven rejected end-to-end
// through the real render function, not just through isGroundedOpener()
// directly.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const badPhrases = [
    'Anything coming up that we should be thinking about?',
    'Would you be interested in discussing promotional products for your upcoming event?',
    'Would you be interested in discussing custom merchandise options with your team?',
    'Can we discuss this further?',
    'Can we chat about this?',
    'Saw L.L.Bean is investing in the flagship store, coming up at L.L.Bean.',
    'Saw L.L.Bean is reopening with a grand....'
  ];
  for(const phrase of badPhrases){
    const signal = {
      account: 'L.L.Bean', isReal: true, sourceUrl: 'https://example.com/llbean-legacy',
      signalTitle: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026',
      signalDetail: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026',
      conversationStarter: phrase, confidenceScore: 80, confidence: 80
    };
    const html = sandbox.renderSingleVerifiedSignal(signal);
    assert(!html.includes(phrase), `root cause 2: renderSingleVerifiedSignal() never renders the ungated legacy phrase verbatim (checked: "${phrase}")`);
  }
  // Sanity: a strong, grounded, low-pressure persisted starter IS preserved
  // through this same render path (the gate rejects bad copy, not all
  // legacy copy).
  const groundedSignal = {
    account: 'L.L.Bean', isReal: true, sourceUrl: 'https://example.com/llbean-legacy-good',
    signalTitle: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026',
    signalDetail: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026',
    conversationStarter: 'Saw the Freeport flagship reopening is scheduled for September. Do you know who is leading it?',
    confidenceScore: 80, confidence: 80
  };
  const goodHtml = sandbox.renderSingleVerifiedSignal(groundedSignal);
  assert(goodHtml.includes('Do you know who is leading it?'), `root cause 2: a genuinely grounded, low-pressure persisted starter is still preserved through the same render path (got: "${goodHtml}")`);
}

// ---------------------------------------------------------------------------
// proof: the same fixes apply to a FRESH, newly-researched signal -- built
// with makeSignal(), the real production-bound function api/research-batch.js
// calls after every provider run (and that api/weekly-scan.js's automated
// scans call too), not a hand-shaped legacy fixture. Proves canonical
// classification, initiative deduplication, actionability/priority
// eligibility, and the render-time quality gate all apply identically to
// output that has never touched a database row.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const account = { name: 'L.L.Bean', contacts: [] };

  // Simulates two DIFFERENT provider results for the SAME real-world
  // initiative, exactly as a live search might return -- one with an
  // AI-declared "suggested_opener" that would still read as pitchy under
  // this round's expanded gate.
  const freshInvestment = makeSignal({
    accountName: 'L.L.Bean',
    signalTitle: 'L.L.Bean is investing more than $50 million to reimagine the flagship store',
    whatChanged: 'L.L.Bean is investing more than $50 million to reimagine the flagship store in Freeport, Maine.',
    sourceUrl: 'https://example.com/fresh-llbean-investment',
    suggested_opener: 'Would you be interested in discussing promotional products for your upcoming event?'
  }, account);
  const freshGrandOpening = makeSignal({
    accountName: 'L.L.Bean',
    signalTitle: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026',
    whatChanged: 'L.L.Bean flagship grand opening scheduled for September 18-20, 2026 in Freeport, Maine.',
    sourceUrl: 'https://example.com/fresh-llbean-grand-opening'
  }, account);

  assert(!!freshInvestment && !!freshGrandOpening, 'proof: makeSignal() (the real production new-research path) returns both fresh signals');
  assert(freshInvestment.canonicalEventType !== 'ACQUISITION', `proof: the fresh investment signal is never classified Acquisition (got "${freshInvestment.canonicalEventType}")`);
  assert(freshGrandOpening.actionabilityStatus.status === 'upcoming', `proof: the fresh grand-opening signal is correctly Upcoming (got "${freshGrandOpening.actionabilityStatus.status}")`);
  assert(freshGrandOpening.actionabilityStatus.isPriorityEligible === true, 'proof: the fresh Upcoming signal is priority-eligible');

  // Shape both fresh signals the way signalToOpportunity() (api/get-dashboard.js)
  // does, then run them through the SAME production dedupe/classification/
  // quality-gate functions used above for legacy rows.
  const toOpp = (s) => ({
    account: s.accountName, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    canonicalEventType: s.canonicalEventType, opportunityType: 'SIGNAL-DRIVEN',
    signalTitle: s.signalTitle || s.title, signalSummary: s.signalDetail,
    sourceUrl: s.sourceUrl, cleanSourceName: s.cleanSourceName,
    confidence: s.confidenceScore, recommendedBuyingTeam: s.recommendedBuyingTeam,
    eventDate: s.eventDate, event_date: s.event_date, eventDateDisplay: s.eventDateDisplay, eventDateConfidence: s.eventDateConfidence,
    actionabilityStatus: s.actionabilityStatus, conversationStarter: s.conversationStarter
  });
  const freshDeduped = sandbox.dedupeOpportunities([toOpp(freshInvestment), toOpp(freshGrandOpening)]);
  assert(freshDeduped.length === 1, `proof: initiative deduplication merges the two fresh provider results into one opportunity, exactly as it does for legacy data (got ${freshDeduped.length})`);
  assert(freshDeduped[0].actionabilityStatus?.status === 'upcoming', `proof: the fresh merged opportunity is Upcoming (got "${freshDeduped[0].actionabilityStatus?.status}")`);

  // The fresh signal's OWN pitchy AI-declared opener is rejected by the
  // SAME render-time gate that protects legacy rows -- the deterministic
  // grounded fallback is used instead.
  const freshOpener = sandbox.getSuggestedOpener(toOpp(freshInvestment));
  assert(freshOpener !== freshInvestment.conversationStarter, 'proof: the fresh signal\'s pitchy persisted opener is rejected at render time, not trusted merely because it is brand new');
  assert(sandbox.isGroundedOpener(freshOpener, toOpp(freshInvestment)) === true, 'proof: the deterministic fallback used for the fresh signal itself passes the quality gate');

  // Legacy read path retained: classifyLegacySignalActionability() still
  // protects an OLDER, already-persisted row the same way (see acceptance
  // test 1 above for the full L.L.Bean legacy-boundary proof; re-verified
  // here with a second account to confirm it is not case-specific).
  const legacyProof = classifyLegacySignalActionability({
    signalTitle: 'Reading Symphony received a $15,000 grant', whatChanged: 'Reading Symphony was awarded a $15,000 grant from the NEA'
  });
  assert(legacyProof.canonicalEventType === 'EVENT_AWARD', `proof: the legacy read path still protects older rows identically (got "${legacyProof.canonicalEventType}")`);
}

// ===========================================================================
// Section G — Sixth QA correction round: the real end-to-end Preview
// research run disproved two synthetic assumptions. Fixtures below use the
// EXACT text quoted from the real Preview run's UI report (Supabase read
// access was not available in this session; the exact rendered/quoted text
// the user captured from the live run is the ground truth used here, per
// the round's own instruction to use the real shape rather than guess it).
// ===========================================================================

// ---------------------------------------------------------------------------
// root cause (clustering): the REAL investment/reopening article pair share
// only ~29% of their significant title tokens (2 of 7: the account's own
// name, which is trivially present in nearly every article about the
// account, plus "flagship") -- well under the 50% bar every previous round's
// fix still required. Confirmed the two real titles classify to the SAME
// exact canonicalEventType (RENOVATION_COMPLETION), so this was never an
// exact-type-match problem; it was the overlap ratio itself.
// ---------------------------------------------------------------------------
{
  const investmentTitle = 'L.L.Bean is investing over $50 million to reimagine its flagship store and retail campus in Freeport.';
  const reopeningTitle = 'L.L.Bean is reopening its flagship store after a significant renovation, with a grand opening scheduled for September 18-20, 2026.';
  const investmentType = resolveCanonicalEventType({ signalTitle: investmentTitle });
  const reopeningType = resolveCanonicalEventType({ signalTitle: reopeningTitle });
  assert(investmentType.eventType === reopeningType.eventType, `root cause: the real investment/reopening titles classify to the SAME type (got "${investmentType.eventType}" vs "${reopeningType.eventType}") -- the previous merge gap was the title-overlap ratio, not classification`);
}

// ---------------------------------------------------------------------------
// acceptance tests 1-3 / 8: the real fresh signal shapes (exact quoted text)
// merge into one initiative, the absorbed variant never remains in
// Additional Opportunities, the survivor retains both facts and every
// source, and the same behavior holds for a second, unrelated company with
// an equivalent investment/reopening signal shape (proving the fix is
// generic, not L.L.Bean-specific).
// ---------------------------------------------------------------------------
function realFlagshipMergeCase(sandbox, account, investmentUrl, reopeningUrl){
  const investment = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    canonicalEventType: resolveCanonicalEventType({ signalTitle: `${account} is investing over $50 million to reimagine its flagship store and retail campus in Freeport.` }).eventType,
    opportunityType: 'SIGNAL-DRIVEN',
    signalTitle: `${account} is investing over $50 million to reimagine its flagship store and retail campus in Freeport.`,
    signalSummary: `${account} is investing over $50 million to reimagine its flagship store and retail campus in Freeport.`,
    sourceUrl: investmentUrl, cleanSourceName: 'Example Business News',
    recommendedBuyingTeam: ['Marketing'], confidence: 78,
    actionabilityStatus: { status: 'upcoming', isPriorityEligible: true, excludeFromPriorities: false, label: 'Upcoming' },
    eventDate: '2026-09-18', event_date: '2026-09-18', eventDateDisplay: 'September 18–20, 2026', eventDateConfidence: 'exact'
  };
  const reopening = {
    account, signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true,
    canonicalEventType: resolveCanonicalEventType({ signalTitle: `${account} is reopening its flagship store after a significant renovation, with a grand opening scheduled for September 18-20, 2026.` }).eventType,
    opportunityType: 'SIGNAL-DRIVEN',
    signalTitle: `${account} is reopening its flagship store after a significant renovation, with a grand opening scheduled for September 18-20, 2026.`,
    signalSummary: `${account} is reopening its flagship store after a significant renovation, with a grand opening scheduled for September 18-20, 2026.`,
    sourceUrl: reopeningUrl, cleanSourceName: 'Bangor Daily News', confidence: 74,
    actionabilityStatus: { status: 'upcoming', isPriorityEligible: true, excludeFromPriorities: false, label: 'Upcoming' }
  };
  return sandbox.dedupeOpportunities([investment, reopening]);
}
{
  const sandbox = makeSandbox();
  const deduped = realFlagshipMergeCase(sandbox, 'L.L.Bean', 'https://example.com/llbean-investment-real', 'https://www.bangordailynews.com/llbean-flagship-reopens-real');
  assert(deduped.length === 1, `acceptance 1: the real two-signal shape (exact quoted titles) merges into exactly one opportunity (got ${deduped.length})`);
  const winner = deduped[0];
  assert(winner.mergedDuplicateCount === 1, `acceptance 2: the winner records exactly 1 absorbed variant (got ${winner.mergedDuplicateCount})`);
  const evidenceText = JSON.stringify(winner.evidence || []);
  assert(evidenceText.includes('50 million') || evidenceText.includes('investing'), `acceptance 3: the survivor retains the $50 million investment fact (got: ${evidenceText})`);
  assert(evidenceText.includes('reopening') || evidenceText.includes('renovation'), `acceptance 3: the survivor retains the reopening/renovation fact (got: ${evidenceText})`);
  const sourceNames = JSON.stringify(winner.additionalSources || []);
  assert(sourceNames.includes('Bangor') || sourceNames.includes('Example'), `acceptance 3: the absorbed variant's distinct source survives as an additionalSource (got: ${sourceNames})`);

  // acceptance 8: a second, unrelated company with the EXACT SAME signal
  // shape (only the account name changes) proves the fix is generic.
  const dedupedFarmers = realFlagshipMergeCase(sandbox, 'Farmers Mercantile', 'https://example.com/farmers-investment-real', 'https://example.com/farmers-flagship-reopens-real');
  assert(dedupedFarmers.length === 1, `acceptance 8: the identical signal shape merges correctly for a different company (Farmers Mercantile), proving the fix is not L.L.Bean-specific (got ${dedupedFarmers.length})`);
}

// ---------------------------------------------------------------------------
// acceptance tests 4-6: the truncation-artifact starter (real quoted text,
// with the source excerpt's own trailing "...." clip) is rejected/cleaned,
// the rendered starter is specific/complete/referral-focused, and no
// duplicate account phrase is produced -- reproduced through the actual
// getSuggestedOpener()/leadWithAccountContext() production functions, using
// an account name whose punctuation differs from how the source text writes
// it (the real "L.L.Bean" vs. a source correctly writing "L.L. Bean").
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const truncatedOpp = {
    account: 'L.L.Bean',
    signalTitle: 'L.L.Bean is investing over $50 million to reimagine its flagship store and retail campus....',
    signalDetail: 'L.L.Bean is investing over $50 million to reimagine its flagship store and retail campus....',
    opportunity: 'Business Activity', signalLayerType: 'Business Activity Signal',
    canonicalEventType: 'RENOVATION_COMPLETION', opportunityType: 'SIGNAL-DRIVEN'
  };
  const starter = sandbox.getSuggestedOpener(truncatedOpp);
  assert(!starter.includes('....'), `acceptance 4: the rendered Conversation Starter never contains the source excerpt's raw "...." truncation artifact (got: "${starter}")`);
  assert(!/…/.test(starter), `acceptance 4: the rendered Conversation Starter never contains an unresolved unicode ellipsis either (got: "${starter}")`);
  assert(/campus\. /.test(starter) || /campus,/.test(starter), `acceptance 5: the starter reads as a complete clause ending the fact cleanly before the next sentence (got: "${starter}")`);
  assert(/is that|do you know|who|leading/i.test(starter), `acceptance 5: the starter still asks a referral-focused question (got: "${starter}")`);

  // acceptance 6: leadWithAccountContext() with a source-text account
  // reference that differs in punctuation/spacing from the stored account
  // name ("L.L. Bean" with a space vs. the stored "L.L.Bean").
  const ctx = {
    account: 'L.L.Bean', firstName: 'there', mode: 'Cold',
    initiativeTitle: 'L.L. Bean is investing more than $50 million in its Freeport flagship',
    isUpcoming: false, department: 'Retail Operations', canonicalKind: 'expansion'
  };
  const email = sandbox.buildReplyFirstEmail(ctx);
  assert(!/L\.?L\.?\s?Bean.*at L\.?L\.?\s?Bean/i.test(email), `acceptance 6: no duplicated account phrase even when the source text's spacing/punctuation differs from the stored account name (got: "${email}")`);
  assert(sandbox.leadAlreadyNamesAccount(ctx.initiativeTitle, ctx.account) === true, 'acceptance 6: leadAlreadyNamesAccount() recognizes "L.L. Bean" (with a space) as already naming the stored account "L.L.Bean" (no space)');
}

// ---------------------------------------------------------------------------
// acceptance test 7: inferred apparel does not drive the first-contact
// offer for a flagship renovation/reopening -- the offer must derive from
// the grounded canonicalKind, never the inferred commonPromoCategories.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const ctx = {
    account: 'L.L.Bean', firstName: 'there', mode: 'Cold',
    initiativeTitle: 'L.L.Bean is investing over $50 million to reimagine its flagship store',
    isUpcoming: true, department: 'Retail Operations', canonicalKind: 'expansion',
    category: 'apparel' // inferred merch category -- must NOT drive the offer
  };
  const email = sandbox.buildReplyFirstEmail(ctx);
  assert(!/apparel/i.test(email), `acceptance 7: the first-contact email never mentions "apparel" merely because it is an inferred category (got: "${email}")`);
  const offer = sandbox.ideaOfferPhrase(ctx);
  assert(offer !== 'a few apparel-related ideas', `acceptance 7: ideaOfferPhrase() does not use the inferred apparel category for a renovation/reopening initiative (got: "${offer}")`);
  assert(offer === 'a few launch-related ideas', `acceptance 7: a reopening/renovation ("expansion" kind) offers grounded launch-related ideas instead (got: "${offer}")`);

  // An unclassified/generic kind still falls back to a neutral offer, never
  // forcing any category.
  const genericCtx = { ...ctx, canonicalKind: '', category: 'apparel' };
  assert(sandbox.ideaOfferPhrase(genericCtx) === 'a few relevant ideas', `acceptance 7: with no grounded kind, the offer is neutral, not the inferred category (got: "${sandbox.ideaOfferPhrase(genericCtx)}")`);
}

// ---------------------------------------------------------------------------
// acceptance test 9: legacy compatibility remains green -- re-verified via
// classifyLegacySignalActionability() (the same read-time boundary earlier
// rounds fixed) using a third, distinct account, confirming this round's
// changes did not regress the legacy read path.
// ---------------------------------------------------------------------------
{
  const legacy = classifyLegacySignalActionability({
    signalTitle: 'New Hope Network has acquired the assets of Nutrition Capital Network, expanding its portfolio.'
  });
  assert(legacy.canonicalEventType === 'ACQUISITION', `acceptance 9: legacy read-time classification remains correct after this round's changes (got "${legacy.canonicalEventType}")`);
}

// ---------------------------------------------------------------------------
// Commercial-readiness correction round -- required test 8: purchased
// categories and inferred ideas remain distinct in the SAME Evidence card
// (not just in two separate places on the page).
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  sandbox.window.accountRadarAccounts = [
    { name: 'Ridgeline Auto Group', categoryTypes: new Set(['Headwear']) }
  ];
  const opp = {
    account: 'Ridgeline Auto Group', signalLayerType: 'Repeat / Pattern Signal', opportunityType: 'REPEAT PATTERN',
    commonPromoCategories: ['caps', 'beanies', 'seasonal headwear', 'employee hats']
  };
  const html = sandbox.renderSupportingResearchDetails(opp);
  assert(/Previously purchased categories/.test(html) && html.includes('Headwear'), `required test 8: Evidence shows "Previously purchased categories" with the real purchased category (got: "${html}")`);
  assert(/Related suggested categories/.test(html) && html.includes('caps'), `required test 8: Evidence ALSO shows "Related suggested categories" with the inferred ideas, in the same card (got: "${html}")`);
  assert(/\(from your uploaded order history\)/.test(html), 'required test 8: the purchased-categories row is explicitly labeled as coming from the uploaded order history');
  assert(/\(inferred idea, not purchase history\)/.test(html), 'required test 8: the suggested-categories row is explicitly labeled as an inferred idea, not purchase history');
  const purchasedIdx = html.indexOf('Previously purchased categories');
  const suggestedIdx = html.indexOf('Related suggested categories');
  assert(purchasedIdx !== -1 && suggestedIdx !== -1 && purchasedIdx < suggestedIdx, 'required test 8: the two rows appear as a distinct, ordered pair (purchased before suggested), never merged into one label');
}

// ---------------------------------------------------------------------------
// Commercial-readiness correction round -- required test 9: exact
// Brightview-style duplicates (two generic Follow-Up-Signal templates for
// the SAME single recent order) render once in Additional Opportunities.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const brightviewFollowUps = [
    {
      account: 'Brightview Dental Group', opportunity: 'Employee Recognition Program', opportunityName: 'Employee Recognition Program',
      signalLayerType: 'Follow-Up Signal', opportunityType: 'HR', department: 'HR / People',
      reasonToReachOut: 'Recent order delivered or completed', conversationStarter: 'Check in and ask how the recent order was received.',
      confidence: 60, quickWinScore: 60, closeProbability: 55, estimatedValue: 3000, evidence: []
    },
    {
      account: 'Brightview Dental Group', opportunity: 'New Provider Onboarding Kits', opportunityName: 'New Provider Onboarding Kits',
      signalLayerType: 'Follow-Up Signal', opportunityType: 'Onboarding', department: 'HR / People',
      reasonToReachOut: 'Recent order delivered or completed', conversationStarter: 'Check in and ask how the recent order was received.',
      confidence: 58, quickWinScore: 58, closeProbability: 53, estimatedValue: 2800, evidence: []
    }
  ];
  sandbox.window.accountRadarAccounts = [{ name: 'Brightview Dental Group', futureOpportunities: brightviewFollowUps }];
  const cluster = sandbox.accountOpportunityCluster({ account: 'Brightview Dental Group' });
  const followUpsInCluster = cluster.filter(o => o.signalLayerType === 'Follow-Up Signal');
  assert(brightviewFollowUps.length === 2, 'sanity: the fixture really does start with 2 separate generic Follow-Up templates for the same order');
  assert(followUpsInCluster.length === 1, `required test 9: Brightview's Additional Opportunities cluster renders the follow-up ONCE, not twice, even though two generic templates were generated for the same underlying order (got ${followUpsInCluster.length})`);
}

// ---------------------------------------------------------------------------
// Commercial-readiness correction round -- required test 10: exact
// Ridgeline-style duplicates (three generic Repeat/Pattern-Signal
// templates that never became a real REPEAT PATTERN) render once, while
// the genuine REPEAT PATTERN opportunity remains separate.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const genericTemplate = (name, category) => ({
    account: 'Ridgeline Auto Group', opportunity: name, opportunityName: name,
    signalLayerType: 'Repeat / Pattern Signal', opportunityType: 'EXPANSION', department: 'Operations / Facilities',
    reasonToReachOut: 'Repeat or seasonal buying pattern', conversationStarter: 'Ask whether a similar program, order, or event is happening again.',
    confidence: 60, quickWinScore: 60, closeProbability: 55, estimatedValue: 3000, evidence: [], buyingCategory: category
  });
  const ridgelineOpps = [
    { ...genericTemplate('Service Department Apparel Program', 'Apparel / Headwear') },
    { ...genericTemplate('Technician Onboarding Kits', 'Onboarding / Recruiting') },
    { ...genericTemplate('Customer Appreciation Program', 'Client Gifts') },
    {
      account: 'Ridgeline Auto Group', opportunity: 'Headwear Program', opportunityName: 'Headwear Program',
      signalLayerType: 'Repeat / Pattern Signal', opportunityType: 'REPEAT PATTERN', department: 'Marketing',
      reasonToReachOut: 'Headwear Program may be coming up again', conversationStarter: 'Ask if the headwear program is happening again this year.',
      confidence: 82, quickWinScore: 82, closeProbability: 77, estimatedValue: 3500, evidence: ['4 headwear orders found'], buyingCategory: 'Apparel / Headwear'
    }
  ];
  sandbox.window.accountRadarAccounts = [{ name: 'Ridgeline Auto Group', futureOpportunities: ridgelineOpps }];
  const cluster = sandbox.accountOpportunityCluster({ account: 'Ridgeline Auto Group' });
  const genericRepeatInCluster = cluster.filter(o => o.signalLayerType === 'Repeat / Pattern Signal' && o.opportunityType !== 'REPEAT PATTERN');
  const realPatternInCluster = cluster.filter(o => o.opportunityType === 'REPEAT PATTERN');
  assert(ridgelineOpps.filter(o => o.opportunityType !== 'REPEAT PATTERN').length === 3, 'sanity: the fixture really does start with 3 separate generic Repeat/Pattern templates');
  assert(genericRepeatInCluster.length === 1, `required test 10: Ridgeline's Additional Opportunities cluster collapses the 3 generic (non-grounded) Repeat/Pattern templates into ONE entry, not three (got ${genericRepeatInCluster.length})`);
  assert(realPatternInCluster.length === 1, `required test 10: the genuine REPEAT PATTERN (headwear) opportunity remains its own separate entry, never collapsed into the generic bucket (got ${realPatternInCluster.length})`);
}

// ---------------------------------------------------------------------------
// Commercial-readiness correction round -- required test 11: the SAME
// collapse function that dedupes Additional Opportunities/the priorities
// feed also prevents duplicate account-history entries from ever reaching
// a digest-style consumer that iterates an account's collapsed
// opportunities (the layer any future digest integration would draw from,
// since account-history signals are not yet persisted into ha_signals --
// see the accompanying report's honest statement of that gap).
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  const duplicateFollowUps = [
    { account: 'Brightview Dental Group', opportunity: 'A', opportunityName: 'A', signalLayerType: 'Follow-Up Signal', reasonToReachOut: 'Recent order delivered or completed', conversationStarter: 'Check in and ask how the recent order was received.', confidence: 60, quickWinScore: 60, evidence: [] },
    { account: 'Brightview Dental Group', opportunity: 'B', opportunityName: 'B', signalLayerType: 'Follow-Up Signal', reasonToReachOut: 'Recent order delivered or completed', conversationStarter: 'Check in and ask how the recent order was received.', confidence: 58, quickWinScore: 58, evidence: [] }
  ];
  const collapsed = sandbox.collapseDuplicateAccountHistorySignals(duplicateFollowUps);
  const collapsedFollowUps = collapsed.filter(o => o.signalLayerType === 'Follow-Up Signal');
  assert(collapsedFollowUps.length === 1, `required test 11: collapseDuplicateAccountHistorySignals() -- the same function accountOpportunityCluster() uses -- reduces duplicate account-history opportunities for one account to a single entry a digest-style consumer would see (got ${collapsedFollowUps.length})`);
}

// ---------------------------------------------------------------------------
// Commercial-readiness correction round -- required test 12: the Your
// Accounts panel's heading/subtitle accurately reflects whether it is
// showing one upload or accounts combined across multiple uploads.
// ---------------------------------------------------------------------------
{
  const sandbox = makeSandbox();
  sandbox.document.getElementById('customerDashboard').style = {};
  const subtitleEl = sandbox.document.getElementById('customerDashboardSubtitle');
  const singleUploadData = {
    upload: { upload_name: 'QA List.csv' },
    accounts: [{ name: 'A', uploadId: 'upload-1' }, { name: 'B', uploadId: 'upload-1' }],
    signals: [], weeklyRuns: []
  };
  sandbox.renderCustomerDashboard(singleUploadData);
  assert(subtitleEl.textContent.includes('QA List.csv'), `required test 12: a genuinely single-upload aggregate still names that one upload (got: "${subtitleEl.textContent}")`);
  assert(!/combined across/.test(subtitleEl.textContent), 'required test 12: a single-upload aggregate never claims to be "combined across" multiple lists');

  const multiUploadData = {
    upload: { upload_name: 'QA List.csv' },
    accounts: [{ name: 'A', uploadId: 'upload-old-qa' }, { name: 'B', uploadId: 'upload-new-fixture' }, { name: 'C', uploadId: 'upload-new-fixture' }],
    signals: [], weeklyRuns: []
  };
  sandbox.renderCustomerDashboard(multiUploadData);
  assert(!subtitleEl.textContent.includes('QA List.csv'), `required test 12: when accounts span multiple uploads, the subtitle no longer names just ONE of them by name -- avoids the exact mismatch reported (a stale upload name shown while the account/opportunity summary reflects a different, newer upload) (got: "${subtitleEl.textContent}")`);
  assert(/combined across 2 uploaded lists/.test(subtitleEl.textContent), `required test 12: the subtitle instead clearly states the accounts are combined across multiple uploaded lists, with an accurate count (got: "${subtitleEl.textContent}")`);
  assert(subtitleEl.textContent.includes('3'), `required test 12: the combined-accounts subtitle states the real total account count (3), not a stale/mismatched number (got: "${subtitleEl.textContent}")`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
