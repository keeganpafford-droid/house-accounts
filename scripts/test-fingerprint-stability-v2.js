// Fingerprint Stability sprint -- targeted regression coverage for the v2
// event-identity model: canonical-type-independent fingerprints, the
// distinctive-anchor extraction, the conservative anchor/same-URL merge
// rule (Guardrails 1-2), and the lazy legacy compatibility bridge in
// api/save-upload.js. See the sprint's design-round conversation for the
// full rationale; this file proves the mandatory regression list against
// the real implementation, not a re-derivation of the design.
//
// Usage: node scripts/test-fingerprint-stability-v2.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import { resolveEvents, resolveOpportunityEvents } from '../api/signal-intelligence.js';
import { chooseRetainedLegacyRow, applyLegacyFingerprintBridge } from '../api/save-upload.js';
import handler from '../api/save-upload.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Mandatory case 1 -- Indianapolis: same real event, classified REBRAND then
// PRODUCT_LAUNCH, same source URL, no distinctive anchor in either wording.
// Must resolve to ONE logical identity via the same-URL + exact-date bridge.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Dover Honda', canonicalEventType: 'REBRAND',
      headline: 'Dover Honda Announces Rebrand', whatChanged: 'Dover Honda rebranded its dealership with new signage and a refreshed look today.',
      sourceUrl: 'https://indynews.example.com/dover-honda-story', eventDate: '2028-03-01', candidateScore: 80
    },
    {
      companyName: 'Dover Honda', canonicalEventType: 'PRODUCT_LAUNCH',
      headline: 'Dover Honda Rebrand Coverage', whatChanged: 'Dover Honda rebranded its dealership with new signage and a refreshed look today.',
      sourceUrl: 'https://indynews.example.com/dover-honda-story', eventDate: '2028-03-01', candidateScore: 78
    }
  ];
  const events = resolveOpportunityEvents(candidates);
  assert(events.length === 1, `case 1 (Indianapolis): REBRAND vs PRODUCT_LAUNCH representations of the same event resolve to one identity (got ${events.length})`);
  if (events.length === 1) assert(events[0].eventFingerprint.startsWith('v2|dover honda|'), `case 1: fingerprint is v2-tagged and company-scoped (got "${events[0].eventFingerprint}")`);
}

// ===========================================================================
// Mandatory case 2 -- Presidents' Award: same real event, classified
// LEADERSHIP_APPOINTMENT then EVENT_AWARD, DIFFERENT source URLs, but the
// award's own proper name is present in both. Must merge via anchor match
// alone (no shared URL needed).
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Dover Honda', canonicalEventType: 'LEADERSHIP_APPOINTMENT',
      headline: 'Dover Honda Team Named for Presidents Award', whatChanged: 'Dover Honda was named as a recipient of the Presidents Award this year.',
      sourceUrl: 'https://a.example.com/story1', candidateScore: 80
    },
    {
      companyName: 'Dover Honda', canonicalEventType: 'EVENT_AWARD',
      headline: 'Dover Honda Wins Presidents Award', whatChanged: 'Dover Honda received the Presidents Award for outstanding service.',
      sourceUrl: 'https://b.example.com/story2', candidateScore: 75
    }
  ];
  const events = resolveOpportunityEvents(candidates);
  assert(events.length === 1, `case 2 (Presidents' Award): LEADERSHIP_APPOINTMENT vs EVENT_AWARD representations resolve to one identity (got ${events.length})`);
  if (events.length === 1) assert(events[0].eventFingerprint.includes('a:presidents award'), `case 2: fingerprint carries the "Presidents Award" anchor (got "${events[0].eventFingerprint}")`);
}

// ===========================================================================
// Mandatory case 3 -- same company/location/year, genuinely different events
// (a facility opening vs. an unrelated summit), different URLs on the same
// domain. Must stay distinct.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Acme Corp', headline: 'Acme Corp Celebrates Grand Opening of its New Boston Location',
      whatChanged: 'Acme Corp opened a new office this year.',
      sourceUrl: 'https://acmenews.example.com/boston-office-opening', eventDate: '2026-05-01', candidateScore: 80
    },
    {
      companyName: 'Acme Corp', headline: 'Acme Corp Hosts Annual Leadership Summit',
      whatChanged: 'Acme Corp hosted its annual leadership summit in Boston, MA this year.',
      sourceUrl: 'https://acmenews.example.com/leadership-summit', eventDate: '2026-05-01', candidateScore: 70
    }
  ];
  const events = resolveOpportunityEvents(candidates);
  assert(events.length === 2, `case 3: same company/location/year but genuinely different events stay distinct (got ${events.length})`);
}

// ===========================================================================
// Mandatory case 4 -- same company, same exact day, no anchor on either
// side, different URLs. Must stay distinct -- exact date alone never proves
// identity (Guardrail 2).
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Beacon Supply', headline: 'Beacon Supply Update One',
      whatChanged: 'Beacon Supply made some internal operational adjustments this week.',
      sourceUrl: 'https://one.example.com/beacon-a', eventDate: '2026-09-15', candidateScore: 60
    },
    {
      companyName: 'Beacon Supply', headline: 'Beacon Supply Update Two',
      whatChanged: 'Beacon Supply reported a routine internal process change this week.',
      sourceUrl: 'https://two.example.com/beacon-b', eventDate: '2026-09-15', candidateScore: 55
    }
  ];
  const events = resolveOpportunityEvents(candidates);
  assert(events.length === 2, `case 4: same company + same exact day, no anchor, no shared URL -- distinct events never merge on date alone (got ${events.length})`);
}

// ===========================================================================
// Mandatory case 5 -- same domain, same bare location, same year, different
// URLs/events, no anchor on either side. Domain agreement alone must never
// establish identity.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Beacon Supply', headline: 'Beacon Supply News Item A',
      whatChanged: 'Beacon Supply discussed regional plans while visiting Denver, CO this quarter.',
      sourceUrl: 'https://beaconnews.example.com/articles/a', eventDate: '2026-02-01', candidateScore: 60
    },
    {
      companyName: 'Beacon Supply', headline: 'Beacon Supply News Item B',
      whatChanged: 'Beacon Supply held an unrelated regional meeting in Denver, CO this quarter.',
      sourceUrl: 'https://beaconnews.example.com/articles/b', eventDate: '2026-02-01', candidateScore: 55
    }
  ];
  const events = resolveOpportunityEvents(candidates);
  assert(events.length === 2, `case 5: same domain/bare-location/year but different URLs/events stay distinct (got ${events.length})`);
}

// ===========================================================================
// Mandatory case 6 -- same URL, two different anchored events. A genuine
// anchor disagreement is never overridden by a shared URL.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Acme Corp', headline: 'Acme Corp Wins Presidents Award',
      whatChanged: 'Acme Corp received the Presidents Award this year.',
      sourceUrl: 'https://acme.example.com/roundup', eventDate: '2026-06-01', candidateScore: 70
    },
    {
      companyName: 'Acme Corp', headline: 'Acme Corp Wins Innovation Award',
      whatChanged: 'Acme Corp separately received the Innovation Award this year.',
      sourceUrl: 'https://acme.example.com/roundup', eventDate: '2026-06-01', candidateScore: 65
    }
  ];
  const events = resolveOpportunityEvents(candidates);
  assert(events.length === 2, `case 6: same URL but two distinct, disagreeing anchors never merge (got ${events.length})`);
}

// ===========================================================================
// Mandatory case 7 -- same URL, same generic headline, different
// event-specific evidence. No anchor on either side means they never even
// attempt to merge (the same-URL bridge requires at least one anchor), and
// their fallback discriminators must still differ, not collide.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Acme Corp', headline: 'Acme Corp Update',
      whatChanged: 'Acme Corp promoted a marketing initiative in the region this quarter.',
      sourceUrl: 'https://acme.example.com/page', eventDate: '2026-04-01', candidateScore: 60
    },
    {
      companyName: 'Acme Corp', headline: 'Acme Corp Update',
      whatChanged: 'Acme Corp finalized a new supplier contract for the region this quarter.',
      sourceUrl: 'https://acme.example.com/page', eventDate: '2026-04-01', candidateScore: 55
    }
  ];
  const events = resolveOpportunityEvents(candidates);
  assert(events.length === 2, `case 7: same URL + same generic headline, but different underlying evidence, stay distinct (got ${events.length})`);
  if (events.length === 2) {
    assert(events[0].eventFingerprint !== events[1].eventFingerprint, `case 7: the two events' fallback discriminators do not collide despite sharing URL and headline ("${events[0].eventFingerprint}" vs "${events[1].eventFingerprint}")`);
  }
}

// ===========================================================================
// Mandatory case 8 -- anchor survives source rewording: a distinctive branch
// name merges two differently-worded, differently-sourced representations.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Avidia Bank', headline: 'Avidia Bank Celebrates Westborough Branch Ribbon Cutting',
      whatChanged: 'Avidia Bank held a ribbon cutting for its renovated Westborough Branch.',
      sourceUrl: 'https://businesswire.example.com/avidia-a', eventDate: '2026-06-23', candidateScore: 80
    },
    {
      companyName: 'Avidia Bank', headline: 'Community Notes',
      whatChanged: 'The local chamber welcomed the reopening of the Westborough Branch this week.',
      sourceUrl: 'https://chamber.example.org/avidia-b', eventDate: '2026-06-23', candidateScore: 70
    }
  ];
  const events = resolveOpportunityEvents(candidates);
  assert(events.length === 1, `case 8: a distinctive anchor ("Westborough Branch") survives differently-worded, differently-sourced coverage and merges (got ${events.length})`);
}

// ===========================================================================
// Mandatory case 9 -- anchorless cross-source same event: tolerated
// duplicate, never a false merge, when no anchor and no shared URL exist.
// ===========================================================================
{
  const candidates = [
    {
      companyName: 'Dispatch Goods', headline: 'Follow-on Investment from Santa Cruz Ventures',
      whatChanged: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods.',
      sourceUrl: 'https://santacruzworks.example.org/dispatch-goods-follow-on-investment', eventDate: '2026-06-23', candidateScore: 82
    },
    {
      companyName: 'Dispatch Goods', headline: 'Dispatch Goods Business Update',
      whatChanged: 'Santa Cruz Ventures made a follow-on investment in Dispatch Goods, indicating confidence in their business model.',
      sourceUrl: 'https://santacruzworks.example.org/articles/dispatch-goods-follow-on', eventDate: '2026-06-23', candidateScore: 78
    }
  ];
  const events = resolveOpportunityEvents(candidates);
  assert(events.length === 2, `case 9: anchorless, cross-source coverage of what may be the same real event is a tolerated duplicate, not a false merge (got ${events.length})`);
}

// ===========================================================================
// Mandatory case 10 -- multiple-legacy-match bridge: deterministic winner,
// no third row, non-winner untouched.
// ===========================================================================
{
  const rows = [
    { id: 'row-a', account_name: 'Dover Honda', event_fingerprint: 'dover honda|LEADERSHIP_APPOINTMENT||unknown', confidence: 60, first_seen_at: '2026-01-01T00:00:00Z' },
    { id: 'row-b', account_name: 'Dover Honda', event_fingerprint: 'dover honda|EVENT_AWARD||unknown', confidence: 85, first_seen_at: '2026-01-05T00:00:00Z' }
  ];
  const winner = chooseRetainedLegacyRow(rows);
  assert(winner.id === 'row-b', `case 10: the deterministic winner is the highest-confidence row regardless of array order (got "${winner.id}")`);

  const reordered = chooseRetainedLegacyRow([rows[1], rows[0]]);
  assert(reordered.id === 'row-b', 'case 10: winner selection does not depend on input ordering');

  const tie = chooseRetainedLegacyRow([
    { id: 'row-x', confidence: 70, first_seen_at: '2026-02-01T00:00:00Z' },
    { id: 'row-y', confidence: 70, first_seen_at: '2026-01-01T00:00:00Z' }
  ]);
  assert(tie.id === 'row-y', 'case 10: a confidence tie breaks on earliest first_seen_at (original discovery preserved)');
}

// ===========================================================================
// Mandatory case 11 -- first v2 rediscovery of an event matching ONE legacy
// row: that row's own fingerprint is submitted for the write (refreshed in
// place), not the fresh v2 string; no duplicate insert.
// ===========================================================================
{
  const legacyRows = [
    {
      id: 'legacy-1', account_name: 'Dover Honda', event_fingerprint: 'dover honda|EVENT_AWARD||unknown',
      confidence: 70, first_seen_at: '2026-01-01T00:00:00Z',
      payload: { accountName: 'Dover Honda', headline: 'Dover Honda Wins Presidents Award', whatChanged: 'Dover Honda received the Presidents Award for outstanding service.', sourceUrl: 'https://b.example.com/story2' }
    }
  ];
  const newResolved = resolveOpportunityEvents([{
    companyName: 'Dover Honda', canonicalEventType: 'LEADERSHIP_APPOINTMENT',
    headline: 'Dover Honda Team Named for Presidents Award', whatChanged: 'Dover Honda was named as a recipient of the Presidents Award this year.',
    sourceUrl: 'https://a.example.com/story1', candidateScore: 80
  }]);
  const before = newResolved[0].eventFingerprint;
  assert(before.startsWith('v2|'), `case 11 setup: the freshly-resolved signal computes a v2 fingerprint before bridging (got "${before}")`);
  const stats = applyLegacyFingerprintBridge(legacyRows, newResolved);
  assert(stats.bridged === 1 && stats.multiMatch === 0, `case 11: exactly one signal is bridged, no multi-match (got ${JSON.stringify(stats)})`);
  assert(newResolved[0].eventFingerprint === 'dover honda|EVENT_AWARD||unknown', `case 11: the signal's fingerprint is replaced with the existing legacy row's own literal fingerprint, not the fresh v2 string (got "${newResolved[0].eventFingerprint}")`);
}

// ===========================================================================
// Mandatory case 12 -- batched bridge lookup: no N+1. One save-upload call
// covering two accounts, each with a pre-existing legacy row, must issue
// exactly ONE GET request against ha_signals for the whole save.
// ===========================================================================
{
  function jsonResponse(data, ok = true, status = 200) {
    return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
  }
  function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.setHeader = () => {};
    return res;
  }
  const USER_ID = 'user-batch-1';
  const UPLOAD_ID = 'upload-batch-1';
  let fakeSignals = [
    { id: 'sig-alpha', user_id: USER_ID, account_name: 'Alpha Co', event_fingerprint: 'alpha co|EVENT_AWARD||unknown', confidence: 60, first_seen_at: '2026-01-01T00:00:00Z', payload: { accountName: 'Alpha Co', headline: 'Alpha Co Wins Presidents Award', whatChanged: 'Alpha Co received the Presidents Award this year.' } },
    { id: 'sig-beta', user_id: USER_ID, account_name: 'Beta Co', event_fingerprint: 'beta co|EVENT_AWARD||unknown', confidence: 60, first_seen_at: '2026-01-01T00:00:00Z', payload: { accountName: 'Beta Co', headline: 'Beta Co Wins Presidents Award', whatChanged: 'Beta Co received the Presidents Award this year.' } }
  ];
  let researchRuns = [{ user_id: USER_ID, upload_id: UPLOAD_ID, research_run_id: 'auto', status: 'running', attempt_id: 'attempt-1', lease_expires_at_ms: Date.now() + 300000 }];
  let signalsGetCalls = [];

  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-batch-1', email: 'qa@example.com' });
    if (u.includes('/rest/v1/ha_users?auth_user_id=eq.')) return jsonResponse([{ id: USER_ID, email: 'qa@example.com', organization_id: null }]);
    if (u.includes('/rest/v1/ha_uploads') && u.includes('user_id=eq.') && (!options.method || options.method === 'GET')) return jsonResponse([{ id: UPLOAD_ID }]);
    if (u.includes('/rest/v1/ha_organizations')) return jsonResponse([]);
    if (u.includes('/rest/v1/ha_signals') && (!options.method || options.method === 'GET')) {
      signalsGetCalls.push(u);
      return jsonResponse(fakeSignals);
    }
    if (u.includes('/rest/v1/rpc/persist_ha_research_output')) {
      const body = JSON.parse(options.body);
      const run = researchRuns.find(r => r.research_run_id === body.p_research_run_id && r.attempt_id === body.p_attempt_id);
      if (!run) return jsonResponse({ message: 'stale' }, false, 400);
      run.status = 'completed';
      const attempted = (body.p_signals || []).length;
      return jsonResponse({ accountsPersisted: 2, signalsAttempted: attempted, signalsPersisted: 0, signalsConflictIgnored: attempted, status: 'completed', completedAt: new Date().toISOString(), attemptId: body.p_attempt_id });
    }
    // Organizational Learning V1B: post-snapshot reconciliation hook -- see
    // scripts/test-save-upload-persistence.js's identical comment.
    if (u.includes('/rest/v1/ha_account_opportunities')) return jsonResponse([]);
    throw new Error(`Unhandled mock fetch URL in batching test: ${u}`);
  };

  const req = {
    method: 'POST', headers: { authorization: 'Bearer valid-token' },
    body: {
      lead: { email: 'qa@example.com' }, uploadId: UPLOAD_ID, stage: 'researched',
      researchRunId: 'auto', attemptId: 'attempt-1',
      accounts: [
        { name: 'Alpha Co', signals: [{ accountName: 'Alpha Co', headline: 'Alpha Co Named for Presidents Award', whatChanged: 'Alpha Co was named as a recipient of the Presidents Award this year.', sourceUrl: 'https://x.example.com/alpha', confidenceScore: 75 }] },
        { name: 'Beta Co', signals: [{ accountName: 'Beta Co', headline: 'Beta Co Named for Presidents Award', whatChanged: 'Beta Co was named as a recipient of the Presidents Award this year.', sourceUrl: 'https://x.example.com/beta', confidenceScore: 75 }] }
      ]
    }
  };
  const res = fakeRes();
  await handler(req, res);
  assert(res.statusCode === 200, `case 12: the multi-account save succeeds (got status ${res.statusCode}, body ${JSON.stringify(res.body)})`);
  assert(signalsGetCalls.length === 1, `case 12: exactly ONE ha_signals GET request covers both accounts in this save -- no N+1 (got ${signalsGetCalls.length})`);
  if (signalsGetCalls.length === 1) {
    assert(/account_name=in\.\(.*Alpha Co.*Beta Co.*\)|account_name=in\.\(.*Beta Co.*Alpha Co.*\)/.test(decodeURIComponent(signalsGetCalls[0])), `case 12: the single batched request scopes to both accounts actually present in this save (got "${signalsGetCalls[0]}")`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
