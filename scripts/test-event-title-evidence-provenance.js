// Founder correction (BerryDunn Careers): a founder manual inspection of
// the real source (a Consulting.us BerryDunn careers/profile page) found
// GENUINE leadership-change news embedded in it -- BerryDunn hiring Carson
// Hanrahan as Chief Transformation Officer, plus 10 people promoted to
// principal. The canonical LEADERSHIP_APPOINTMENT classification was never
// wrong. The real defect: HA correctly classified the specific nested
// event, but then persisted/rendered only the generic CONTAINER page title
// ("BerryDunn - Careers") as the seller-facing "What changed" -- useless
// intelligence even though the underlying classification was correct.
//
// Root cause (api/signal-intelligence.js):
//   1. extractFromOneField()'s appointmentMatch regex recognized
//      "appoints"/"names"/"promotes" as leadership-appointment verbs, but
//      not "hires"/"hired"/"the hiring of" -- a very common way to phrase
//      exactly this kind of story -- so the specific
//      person/role (Carson Hanrahan / Chief Transformation Officer) was
//      never extracted from the evidence text in the first place.
//   2. Even when extraction DID succeed elsewhere (e.g. a genuine
//      NEW_LOCATION_OPENING/ACQUISITION shape), resolveEvents()'s final
//      per-event object preferred the RAW candidate's own title/headline
//      (the container/aggregator page's own title) over the specifically
//      generated one from generateCanonicalTitle() -- the generated title
//      was computed, then silently discarded into an unused
//      `canonicalTitle` field nothing downstream ever read.
//
// Final rule (verbatim from the founder): if canonical event classification
// is derived from a specific article/event nested inside an aggregator/
// profile/careers/news/listing page, the seller-facing signal must preserve
// the specific grounded event that caused the classification, not the
// generic container-page title. Canonical event TYPE is never changed when
// the evidence genuinely supports it -- only the event TITLE/evidence
// provenance is fixed.
//
// Usage: node scripts/test-event-title-evidence-provenance.js
import { resolveCanonicalEventType } from '../api/research-batch.js';
import { extractEventEntities, resolveOpportunityEvents, generateCanonicalTitle } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const BERRYDUNN_CONTAINER_TITLE = 'BerryDunn - Careers';
const BERRYDUNN_HIRE_TEXT = 'BerryDunn hires Carson Hanrahan as Chief Transformation Officer.';
const BERRYDUNN_SOURCE_URL = 'https://www.consulting.us/news/berrydunn-careers';

// ===========================================================================
// 1. REQUIRED: canonical classification is NOT changed -- the genuine
// leadership-appointment evidence still classifies as LEADERSHIP_APPOINTMENT.
// This is the founder's explicit correction to the prior round's assumption
// that this shape was a misclassification -- it was not.
// ===========================================================================
{
  const canonical = resolveCanonicalEventType({ signalTitle: BERRYDUNN_CONTAINER_TITLE, business_context: BERRYDUNN_HIRE_TEXT });
  assert(canonical.eventType === 'LEADERSHIP_APPOINTMENT', `REQUIRED: genuine BerryDunn leadership-hire evidence still classifies as LEADERSHIP_APPOINTMENT, even though the container page title is a generic "Careers" page (got ${canonical.eventType})`);
}

// ===========================================================================
// 2. REQUIRED: extractFromOneField()/extractEventEntities() now recognizes
// "hires"/"hired"/"the hiring of" as a leadership-appointment verb, not just
// "appoints"/"names"/"promotes" -- so the specific person/role is actually
// extractable from this exact phrasing.
// ===========================================================================
{
  const entities = extractEventEntities(BERRYDUNN_HIRE_TEXT, BERRYDUNN_HIRE_TEXT, '', 'berrydunn');
  assert(entities.subjectEntity === 'Carson Hanrahan', `REQUIRED: "hires X as Y" phrasing extracts the specific person (got ${JSON.stringify(entities.subjectEntity)})`);
  assert(entities.role === 'Chief Transformation Officer', `REQUIRED: "hires X as Y" phrasing extracts the specific role (got ${JSON.stringify(entities.role)})`);

  // Preserve: the pre-existing "hired as" (passive/reversed order) and
  // "appoints/names/promotes" phrasings still extract correctly -- the fix
  // only ADDS hire-related verbs, it does not disturb the existing ones.
  const hiredAs = extractEventEntities('Carson Hanrahan was hired as Chief Transformation Officer at BerryDunn.', '', '', 'berrydunn');
  assert(hiredAs.subjectEntity === 'Carson Hanrahan', `preserve: "X was hired as Y" still extracts the person (got ${JSON.stringify(hiredAs.subjectEntity)})`);
  const appointed = extractEventEntities('Arthur J. Gallagher & Co. appoints Jane Smith as Chief Financial Officer.', '', '', 'arthur j gallagher co');
  assert(appointed.subjectEntity === 'Jane Smith' && appointed.role === 'Chief Financial Officer', `preserve: "appoints X as Y" still extracts correctly (got ${JSON.stringify(appointed)})`);
}

// ===========================================================================
// 3. REQUIRED (the actual reproduced bug): the container/aggregator page
// title is never what "What changed" ends up showing when a specific event
// was extractable -- resolveOpportunityEvents() (the shared, canonical
// event-resolution boundary used by both the live-research persist path and
// get-dashboard.js's read-time reconciliation) now surfaces the specific
// grounded event as title/headline/signalTitle.
// ===========================================================================
{
  const rawSignal = {
    accountName: 'BerryDunn',
    headline: BERRYDUNN_CONTAINER_TITLE,
    signalTitle: BERRYDUNN_CONTAINER_TITLE,
    whatChanged: BERRYDUNN_HIRE_TEXT,
    businessContext: BERRYDUNN_HIRE_TEXT,
    sourceUrl: BERRYDUNN_SOURCE_URL,
    canonicalEventType: 'LEADERSHIP_APPOINTMENT'
  };
  const [resolved] = resolveOpportunityEvents([rawSignal]);
  assert(resolved.title === 'Carson Hanrahan Appointed Chief Transformation Officer', `REQUIRED: the resolved event's title is the specific grounded event, not the container page title (got "${resolved.title}")`);
  assert(resolved.headline === 'Carson Hanrahan Appointed Chief Transformation Officer', `REQUIRED: headline agrees with title (got "${resolved.headline}")`);
  assert(resolved.signalTitle === 'Carson Hanrahan Appointed Chief Transformation Officer', `REQUIRED: signalTitle (what every dashboard "What changed"/How to Approach/Email/Call Script surface actually reads) agrees too, not a stale value leaked through from the original candidate (got "${resolved.signalTitle}")`);
  assert(resolved.title !== BERRYDUNN_CONTAINER_TITLE, `REQUIRED (the actual reproduced bug): the generic "BerryDunn - Careers" container title is never what "What changed" shows once a specific event was extractable (got "${resolved.title}")`);
  assert(resolved.canonicalEventType === undefined || resolved.eventIdentity.eventType === 'LEADERSHIP_APPOINTMENT', `REQUIRED: the canonical event TYPE itself is unchanged by this fix -- only the title/evidence provenance (got eventIdentity.eventType="${resolved.eventIdentity.eventType}")`);
}

// ===========================================================================
// 4. Preserve: when nothing specific is extractable from the evidence text,
// the candidate's own (real, non-generic) title is used exactly as before --
// this fix never invents a title, it only stops discarding a genuinely
// better one when one exists.
// ===========================================================================
{
  const noExtraction = {
    accountName: 'Acme Corp',
    headline: 'Acme Corp News',
    signalTitle: 'Acme Corp News',
    whatChanged: 'Acme Corp is doing well this quarter with steady growth.',
    businessContext: 'Acme Corp is doing well this quarter with steady growth.',
    sourceUrl: 'https://news.example.com/acme-corp-news',
    canonicalEventType: 'BUSINESS_ACTIVITY_UNKNOWN'
  };
  const [resolved] = resolveOpportunityEvents([noExtraction]);
  assert(resolved.title === 'Acme Corp News', `preserve: with nothing extractable, the candidate's own title is used exactly as before (got "${resolved.title}")`);
}

// ===========================================================================
// 5. The fix generalizes to every event family generateCanonicalTitle()
// already had a template for, not just leadership -- a location-opening
// signal buried in a generic "News & Press" container page also now
// surfaces its specific event.
// ===========================================================================
{
  const opening = {
    accountName: 'L.L.Bean',
    headline: 'L.L.Bean News & Press',
    signalTitle: 'L.L.Bean News & Press',
    whatChanged: 'L.L.Bean is opening its newest branch location in Bangor, Maine.',
    businessContext: 'L.L.Bean is opening its newest branch location in Bangor, Maine.',
    sourceUrl: 'https://news.example.com/llbean-news',
    canonicalEventType: 'NEW_LOCATION_OPENING'
  };
  const [resolved] = resolveOpportunityEvents([opening]);
  assert(resolved.title === 'Bangor Branch Opening', `REQUIRED (generalization): a location-opening event buried in a generic "News & Press" container page also surfaces its specific title (got "${resolved.title}")`);
}

// ===========================================================================
// 6. Sanity: generateCanonicalTitle()'s own titleSource flag correctly
// distinguishes a real extraction from the source-title fallback -- the
// signal resolveOpportunityEvents() actually gates on.
// ===========================================================================
{
  const generated = generateCanonicalTitle('LEADERSHIP_APPOINTMENT', { subjectEntity: 'Carson Hanrahan', role: 'Chief Transformation Officer' }, []);
  assert(generated.titleSource === 'generated', `sanity: a real extraction reports titleSource "generated" (got "${generated.titleSource}")`);
  const fallback = generateCanonicalTitle('BUSINESS_ACTIVITY_UNKNOWN', {}, [{ sourceTitle: 'Acme Corp News', authorityScore: 1 }]);
  assert(fallback.titleSource === 'fallback-source-title', `sanity: no extraction reports titleSource "fallback-source-title" (got "${fallback.titleSource}")`);
}

// ===========================================================================
// 7. LIVE-QA PARITY: the exact real persisted ha_signals row (id
// 18430666-5650-4e32-af7a-3dc1f5ee4a29, traced directly via Supabase
// execute_sql during this follow-up round) -- not a synthetic
// extraction-friendly fixture. Field values below are copied verbatim from
// the real stored `payload` JSONB column.
//
// Trace result: the deterministic reproduction in section 3 above passed
// against a SYNTHETIC evidence sentence ("BerryDunn hires Carson Hanrahan
// as Chief Transformation Officer") that does not match what was actually
// captured for this real row. The real row's rawSnippet is a GROUP
// promotion sentence ("has promoted 10 team members in its 2025 principal
// class") with no named individual at all -- rawContent is empty (no full
// page scrape was ever captured), so the Carson Hanrahan fact genuinely
// does not exist anywhere in this row's persisted evidence. This is
// founder root cause #1 ("the legacy persisted row does not contain enough
// raw evidence for the new extractor") -- NOT #2 (reconciliation not
// running -- it runs, unconditionally, on every dashboard read via
// api/get-dashboard.js's canonicalizeAccountOpportunities()) and NOT #3
// (no later hydration step restores the old title -- resolveOpportunityEvents()
// is the last write before the client ever sees the object).
//
// Fix: extractFromOneField()'s new groupPromotionMatch captures the count
// and role actually present in the real evidence ("10" / "principal") --
// never a fabricated name -- so generateCanonicalTitle() has a second,
// narrower path to a real title when no named appointee exists.
// ===========================================================================
{
  const LIVE_BERRYDUNN_ROW = {
    url: 'https://www.consulting.us/firms/berrydunn/careers',
    type: 'Leadership Change',
    title: 'BerryDunn - Careers',
    whyNow: 'BerryDunn has public leadership or team-change activity. Ask whether the leadership change connects to any team engagement, recognition, or internal brand moments.',
    snippet: 'BerryDunn',
    headline: 'BerryDunn - Careers',
    rawTitle: 'BerryDunn - Careers',
    eventDate: '',
    sourceUrl: 'https://www.consulting.us/firms/berrydunn/careers',
    confidence: 0.86,
    rawContent: '',
    rawSnippet: 'BerryDunn promotes 10 to principal BerryDunn, a Portland, Maine-based accounting and consulting firm, has promoted 10 team members in its 2025 principal class.',
    signalType: 'Leadership Change',
    sourceName: 'consulting.us',
    sourceType: 'Careers / job posting',
    accountName: 'BerryDunn',
    companyName: 'BerryDunn',
    publishedAt: '',
    signalTitle: 'BerryDunn - Careers',
    signal_type: 'Leadership Change',
    whatChanged: 'BerryDunn',
    businessContext: 'BerryDunn',
    signalDetail: 'BerryDunn has public leadership or team-change activity.',
    signalFamily: 'leadership',
    signalSubtype: 'Promotion',
    canonicalTitle: 'BerryDunn - Careers',
    opportunityType: 'LEADERSHIP_APPOINTMENT',
    canonicalEventType: 'LEADERSHIP_APPOINTMENT',
    identityConfidence: 'unconfirmed',
    affectedDepartment: 'Marketing / HR'
  };

  // Sanity: reproduces the exact live-QA symptom BEFORE tracing why -- title
  // and whatChanged are both still the generic container title/bare company
  // name in the raw stored payload itself (this is what the founder's
  // screenshot showed).
  assert(LIVE_BERRYDUNN_ROW.title === 'BerryDunn - Careers', 'sanity: the real stored payload\'s title is the generic container page title, exactly as founder QA reported');
  assert(LIVE_BERRYDUNN_ROW.whatChanged === 'BerryDunn', 'sanity: the real stored payload\'s whatChanged is literally just the bare company name, exactly as founder QA reported');

  const [resolved] = resolveOpportunityEvents([LIVE_BERRYDUNN_ROW]);
  assert(resolved.title === 'BerryDunn Promotes 10 to Principal', `REQUIRED (live-QA parity): the exact real persisted row now resolves to a specific, non-fabricated title built from the real evidence (got "${resolved.title}")`);
  assert(resolved.headline === 'BerryDunn Promotes 10 to Principal', `REQUIRED: headline agrees (got "${resolved.headline}")`);
  assert(resolved.signalTitle === 'BerryDunn Promotes 10 to Principal', `REQUIRED: signalTitle (the field every dashboard surface reads) agrees (got "${resolved.signalTitle}")`);
  assert(resolved.whatChanged === 'BerryDunn Promotes 10 to Principal', `REQUIRED: "What changed" is no longer the bare company name (got "${resolved.whatChanged}")`);
  assert(resolved.title !== 'BerryDunn - Careers', 'REQUIRED: "BerryDunn - Careers" is never used as the customer-facing event title for this row');
  assert(resolved.whatChanged !== 'BerryDunn', 'REQUIRED: "What changed: BerryDunn" is never emitted as a substitute for the event for this row');
  assert(resolved.eventIdentity.eventType === 'LEADERSHIP_APPOINTMENT', `REQUIRED: canonical event TYPE is unchanged -- still Leadership Change, never reclassified (got "${resolved.eventIdentity.eventType}")`);
  assert(!/Carson Hanrahan/i.test(resolved.title), 'REQUIRED: no name is fabricated for this row -- the real evidence never mentions Carson Hanrahan, so the title correctly uses only the group-promotion fact (count + role) actually present');

  // Preserve: this exact row's event_fingerprint/identity path is untouched
  // -- the fix is display-only, never fed into the discriminator/anchor.
  assert(resolved.eventFingerprint.startsWith('v2|'), `preserve: the event_fingerprint is still v2-tagged, identity logic untouched by this fix (got "${resolved.eventFingerprint}")`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
