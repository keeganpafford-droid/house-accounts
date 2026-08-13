// Phase 2A / B3 — validates that classification is now computed once, from
// canonical evidence, and can no longer be overridden by an independent
// AI-declared type. Test cases use the exact title/evidence text from the
// frozen Phase 1B baseline export for the six ranks the audit flagged as
// having contradictory persisted classification fields, plus known-good
// cases that must continue to classify correctly.
//
// Usage: node scripts/test-canonical-classification.js
import { makeSignal, resolveCanonicalEventType } from '../api/research-batch.js';
import { resolveOpportunityEvents, displayLabelForEventType } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function internallyConsistent(signal){
  return signal.signal_type === signal.signalType &&
         signal.signalType === signal.type &&
         signal.opportunityType === signal.canonicalEventType;
}

// ---------------------------------------------------------------------------
// The six frozen Phase 1B ranks with confirmed classification mismatches.
// declaredType below is exactly what the AI declared in the frozen export
// (raw.signal_type) — the whole point of this test is that it is now
// irrelevant to the outcome.
// ---------------------------------------------------------------------------
const cases = [
  {
    rank: 4, account: 'Aileen Graf', declaredType: 'Promotion',
    raw: { accountName: 'Aileen Graf', signal_type: 'Promotion', signalTitle: 'Open House Event',
      whatChanged: 'An open house is scheduled for a property designed by Aileen Graf.',
      business_context: 'The open house indicates a marketing push for the property, which may require promotional materials.',
      confidence: 33, sourceUrl: 'https://destinyagents.com/home-search/listings/x' },
    expectNotEventType: 'LEADERSHIP_APPOINTMENT' // sanity: must not land on an unrelated type either
  },
  {
    // NOTE: this case surfaces a real, pre-existing limitation of
    // resolveEventType()/classifySignalFamily()'s regex rules, not a
    // consistency bug: the business_context field's phrase "new branding"
    // contains the substring "new brand", which classifySignalFamily()'s
    // rebrand pattern (/rebrand|new brand|.../) matches, so the generic
    // BUSINESS_ACTIVITY_ fallback lands on REBRAND rather than a facility/
    // expansion type — the same wrong-family result as before B3, just now
    // reached deterministically from content rather than trusted from the
    // AI's declaration. B3's scope was consistency (this field no longer
    // disagrees with signal_type/opportunityType/event_fingerprint, which it
    // now provably doesn't — see assertions below), not perfecting the
    // underlying regex classifier's accuracy; see the Phase 2A validation
    // report for this finding, logged rather than hidden.
    rank: 5, account: 'Haycon', declaredType: 'Rebrand',
    raw: { accountName: 'Haycon', signal_type: 'Rebrand', signalTitle: 'Expansion Phase 2 of a 3-Phase Project',
      whatChanged: 'Haycon is in the expansion phase of a significant project, indicating growth and increased operational capacity.',
      business_context: 'Haycon is expanding its facilities, which typically requires new branding and employee engagement materials.',
      confidence: 49, sourceUrl: 'https://www.instagram.com/reel/x' },
    logOnly: true
  },
  {
    rank: 8, account: 'The Firm', declaredType: 'New Location',
    raw: { accountName: 'The Firm', signal_type: 'New Location', signalTitle: 'Launch of AI and Innovation Office',
      whatChanged: 'The Firm launched its Office of AI and Innovation, embedding AI and technology into operations.',
      business_context: 'The Firm is enhancing its operational capabilities through AI, indicating a strategic shift towards innovation.',
      confidence: 46, sourceUrl: 'https://www.tarterkrinsky.com/news/x' },
    expectEventType: 'PRODUCT_LAUNCH'
  },
  {
    rank: 11, account: 'Triggerhouse', declaredType: 'Merger',
    raw: { accountName: 'Triggerhouse', signal_type: 'Merger', signalTitle: 'Partnership with MotionBazaar',
      whatChanged: 'Triggerhouse has officially partnered with MotionBazaar, enhancing their capabilities in content production.',
      business_context: 'The partnership is expected to enhance Triggerhouse\'s service offerings, particularly in content production.',
      confidence: 51, sourceUrl: 'https://triggerhouse.com/news-and-views/x' },
    expectEventType: 'PARTNERSHIP'
  },
  {
    // Final bounded Beta trust correction (Round C): this WAS a discovered
    // classifier-accuracy limitation -- resolveEventType()'s
    // LEADERSHIP_APPOINTMENT pattern (\bnamed\b.*\bas\b) matched across the
    // concatenated evidence text -- "Named No. 1 Best..." (signalTitle)
    // followed later by "recognized AS the No. 1..." (whatChanged) --
    // because the regex was not anchored to a single sentence/field and
    // "named"/"as" both appeared, even though this is an award announcement,
    // not a personnel appointment (confirmed live-QA production shape: a
    // generic BerryDunn careers page containing "named ... Best Place to
    // Work ... as recognized ..." was misclassified the identical way). Now
    // fixed: LEADERSHIP_APPOINTMENT requires a real ROLE word (CEO, Chief
    // Financial Officer, Director, etc.) in the same local clause as the
    // verb, so a bare "named"/"as" co-occurrence with no actual role no
    // longer qualifies.
    rank: 14, account: 'New York Marriott Marquis', declaredType: 'Conference / Summit',
    raw: { accountName: 'New York Marriott Marquis', signal_type: 'Conference / Summit', signalTitle: 'Named No. 1 Best Conference Hotel in NYC for 2026-2027',
      whatChanged: 'The New York Marriott Marquis has been recognized as the No. 1 Best Conference Hotel in New York City for 2026-2027.',
      business_context: 'This recognition can enhance the hotel\'s reputation and attract more events, leading to increased demand for promotional products.',
      confidence: 33, sourceUrl: 'https://www.linkedin.com/posts/x' },
    expectNotEventType: 'LEADERSHIP_APPOINTMENT'
  },
  {
    // NOTE: also a discovered classifier-accuracy limitation: resolveEventType()
    // checks its EVENT_COMMUNITY pattern (which matches "community event(s)")
    // before its facility/expansion qualifiers, and the business_context
    // field's closing inference "...potential for community events" matches
    // it, even though the actual content (construction/renovation projects
    // underway) is not a community event. Logged for the validation report.
    rank: 17, account: 'Ben Wheeler', declaredType: 'Community Event',
    raw: { accountName: 'Ben Wheeler', signal_type: 'Community Event', signalTitle: 'New Construction Projects in Ben Wheeler',
      whatChanged: 'Three new construction projects and two renovation projects are underway, indicating growth in the area.',
      business_context: 'The construction projects indicate economic growth and potential for community events.',
      confidence: 50, sourceUrl: 'https://www.zabalist.com/projects/city/ben-wheeler' },
    logOnly: true
  }
];

for(const c of cases){
  const signal = makeSignal(c.raw, { name: c.account }, { enableProspectQuality: false });
  assert(!!signal, `rank ${c.rank} (${c.account}): makeSignal() still returns a signal for this content`);
  if(!signal) continue;
  assert(internallyConsistent(signal), `rank ${c.rank} (${c.account}): signal_type, signalType, type all agree, and opportunityType matches canonicalEventType`);
  if(c.expectEventType){
    assert(signal.canonicalEventType === c.expectEventType, `rank ${c.rank} (${c.account}): canonical type is ${c.expectEventType}, not the AI-declared "${c.declaredType}" (got ${signal.canonicalEventType})`);
  }
  if(c.expectNotEventType){
    assert(signal.canonicalEventType !== c.expectNotEventType, `rank ${c.rank} (${c.account}): canonical type is not the unrelated ${c.expectNotEventType}`);
  }
  if(c.logOnly){
    console.log(`INFO: rank ${c.rank} (${c.account}): AI declared "${c.declaredType}", canonical classifier now deterministically produces ${signal.canonicalEventType} ("${signal.signal_type}") from content alone -- see note above on classifier-accuracy limitations distinct from the consistency fix.`);
  }
  assert(signal.signal_type === displayLabelForEventType(signal.canonicalEventType), `rank ${c.rank} (${c.account}): persisted signal_type is exactly the mapped display label for the canonical type ("${signal.canonicalEventType}" -> "${signal.signal_type}")`);

  // End-to-end: run this single signal through resolveOpportunityEvents(), the
  // same function api/save-upload.js and api/weekly-scan.js call immediately
  // before persistence, and confirm event_fingerprint uses the SAME canonical
  // type rather than recomputing an independent one.
  const resolved = resolveOpportunityEvents([signal]);
  assert(resolved.length === 1, `rank ${c.rank} (${c.account}): resolves to exactly one canonical event`);
  if(resolved.length === 1){
    assert(resolved[0].eventIdentity.eventType === signal.canonicalEventType, `rank ${c.rank} (${c.account}): eventIdentity.eventType (from resolveOpportunityEvents) matches the canonical type computed at generation time, not a freshly-recomputed independent one`);
    // Fingerprint Stability sprint: canonical type is deliberately EXCLUDED
    // from the persisted event_fingerprint -- classification is proven
    // unstable across reruns (the same real event can classify differently
    // run to run) and must not decide identity. Type remains available as
    // refreshable display metadata via eventIdentity.eventType/signal_type,
    // asserted above; the fingerprint itself only needs to be a v2-tagged,
    // non-empty, company-scoped identity string.
    //
    // Foundation-freeze correction: the embed check below is now
    // case-insensitive. Every fingerprint segment is lowercase (company/
    // discriminator pass through normalizeForMatch(), the temporal anchor is
    // a date or bare year), while canonicalEventType is always ALL_CAPS
    // (e.g. "ACQUISITION") -- the original case-SENSITIVE .includes() check
    // could therefore never fail regardless of whether type actually leaked
    // into the fingerprint, since no fingerprint segment can ever contain an
    // ALL_CAPS substring. This was a provably vacuous assertion, not a real
    // regression guard. (The stronger, genuinely non-vacuous proof that type
    // cannot drive identity already lives in scripts/test-fingerprint-stability-v2.js's
    // mandatory cases 1/2: the SAME real event classified under two
    // DIFFERENT canonical types there still resolves to one merged identity.)
    assert(resolved[0].eventFingerprint.startsWith('v2|'), `rank ${c.rank} (${c.account}): the persisted event_fingerprint is v2-tagged ("${resolved[0].eventFingerprint}")`);
    assert(!resolved[0].eventFingerprint.toLowerCase().includes(String(signal.canonicalEventType).toLowerCase()), `rank ${c.rank} (${c.account}): the persisted event_fingerprint no longer embeds canonical type, by design, case-insensitively ("${resolved[0].eventFingerprint}")`);
  }
}

// ---------------------------------------------------------------------------
// Known-good cases: signals whose original AI-declared type already agreed
// with the content must still classify identically under the new pipeline.
// ---------------------------------------------------------------------------
const goodCases = [
  {
    label: 'Zeta Global acquisition (Phase 1B rank 3, no prior mismatch)',
    raw: { accountName: 'Zeta Global', signal_type: 'Acquisition', signalTitle: "Acquisition of Marigold's Enterprise Business",
      whatChanged: "Zeta Global announced the acquisition of Marigold's enterprise software business, enhancing its capabilities and expanding its global footprint.",
      business_context: "The acquisition is expected to enhance Zeta's market position and increase subscription revenue streams.",
      confidence: 49, sourceUrl: 'https://zetaglobal.com/news/x' },
    expectEventType: 'ACQUISITION'
  },
  {
    label: 'Portsmouth Rotary Club golf tournament (Phase 1B rank 6, no prior mismatch)',
    raw: { accountName: 'Portsmouth Rotary Club', signal_type: 'Community Event', signalTitle: '2026 33rd Annual Portsmouth Rotary Club Golf Tournament',
      whatChanged: 'The Portsmouth Rotary Club is hosting its annual golf tournament, which is a significant community event.',
      business_context: 'The golf tournament serves as a fundraiser and community engagement opportunity.',
      confidence: 48, sourceUrl: 'https://events.golfstatus.com/event/x' },
    expectEventType: 'EVENT_COMMUNITY'
  }
];
for(const c of goodCases){
  const signal = makeSignal(c.raw, { name: c.raw.accountName }, { enableProspectQuality: false });
  assert(!!signal, `${c.label}: makeSignal() returns a signal`);
  if(!signal) continue;
  assert(internallyConsistent(signal), `${c.label}: classification fields remain internally consistent`);
  assert(signal.canonicalEventType === c.expectEventType, `${c.label}: canonical type is ${c.expectEventType} (got ${signal.canonicalEventType}), unchanged from the already-correct prior behavior`);
}

// ---------------------------------------------------------------------------
// Direct unit test of resolveCanonicalEventType() ignoring a wrong declared type.
// ---------------------------------------------------------------------------
{
  const result = resolveCanonicalEventType({ signal_type: 'Totally Wrong Made Up Label', whatChanged: 'Acme Corp completes acquisition of Rival Inc.' });
  assert(result.eventType === 'ACQUISITION', 'resolveCanonicalEventType() ignores an arbitrary AI-declared label entirely and classifies from content alone');
  assert(result.label === 'Acquisition', 'the mapped display label for ACQUISITION is "Acquisition"');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
