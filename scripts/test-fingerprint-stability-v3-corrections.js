// Fingerprint Stability sprint, correction round -- regressions for the
// three defects Preview QA found against the real Dover Honda data:
// (1) the sponsorship anchor didn't recognize the actual "X Signs on as Y
//     Sponsor" source construction, (2) non-ISO date text was parsed in the
//     runtime's local timezone instead of UTC, making the same event's exact
//     date (and therefore its v2 fingerprint) unstable across environments,
//     (3) the legacy compatibility bridge required literal fingerprint-
//     string equality, which an incomplete legacy payload can never satisfy
//     against a fully-resolved fresh candidate.
//
// Usage: node scripts/test-fingerprint-stability-v3-corrections.js
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import { resolveOpportunityEvents, extractEventEntities, extractEventDate } from '../api/signal-intelligence.js';
import { chooseRetainedLegacyRow, applyLegacyFingerprintBridge, legacyBridgeCompatible } from '../api/save-upload.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Real captured Dover fixtures (Preview QA round). Not hypothetical --
// these are the exact shapes the founder pulled from ha_signals.
// ===========================================================================
const DOVER_LEGACY_ROW = {
  id: '4f228d7d-0b4c-4f4a-bd73-d26a44f24385',
  account_name: 'Dover Honda',
  event_fingerprint: 'dover honda|EVENT_COMMUNITY||2026',
  confidence: 22,
  first_seen_at: '2026-08-09T15:42:38.065251+00:00',
  source_url: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026',
  title: 'Dover Honda Signs on as Dover Holiday Parade Sponsor',
  // The real legacy payload's exact shape is unknown (no DB access to
  // confirm it) -- modeled here as data-incomplete relative to v2's
  // expectations (no rawTitle/rawSnippet, no resolved exact eventDate),
  // which is the most likely explanation the diagnosis round identified.
  payload: {
    accountName: 'Dover Honda',
    headline: 'Dover Honda Signs on as Dover Holiday Parade Sponsor',
    whatChanged: 'Dover Honda signs on as Dover Holiday Parade sponsor.',
    sourceUrl: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026'
  }
};

const DOVER_FRESH_SIGNAL = {
  companyName: 'Dover Honda',
  canonicalEventType: 'EVENT_COMMUNITY',
  headline: 'Lead Platinum Sponsor for the 2026 Dover Holiday Parade',
  whatChanged: 'Dover Honda is the lead Platinum Sponsor for the 2026 Dover Holiday Parade, taking place November 29, 2026.',
  sourceUrl: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026',
  confidenceScore: 48
};

// ===========================================================================
// 1) Sponsorship anchor recognizes the real Dover Chamber headline
//    construction ("X Signs on as Y Sponsor"), not just "sponsor for/of X".
// ===========================================================================
{
  const real = extractEventEntities('Dover Honda Signs on as Dover Holiday Parade Sponsor', '', '', 'dover honda');
  assert(real.anchor && real.anchor.toLowerCase() === 'dover holiday parade', `1) the real Dover Chamber headline extracts "Dover Holiday Parade" as a distinctive anchor (got "${real.anchor}")`);

  const variants = [
    ['Acme Corp Signs on as City Marathon Sponsor', 'city marathon'],
    ['Acme Corp is the City Marathon Sponsor', 'city marathon']
  ];
  for (const [text, expected] of variants) {
    const r = extractEventEntities(text, '', '', 'acme corp');
    assert(r.anchor && r.anchor.toLowerCase() === expected, `1) reversed sponsorship word order "${text}" extracts "${expected}" (got "${r.anchor}")`);
  }
}

// ===========================================================================
// 2) Identity-critical date parsing is timezone-independent. Spawns real
//    child processes under different TZ values (in-process TZ mutation is
//    not reliably honored by V8's Intl/Date internals) and asserts the
//    extracted date, and the full v2 fingerprint, are byte-identical.
// ===========================================================================
{
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, '..');
  const script = `
    import { extractEventDate, resolveOpportunityEvents } from './api/signal-intelligence.js';
    const dateResult = extractEventDate('The parade will take place on November 29, 2026.');
    const resolved = resolveOpportunityEvents([{
      companyName: 'Dover Honda', canonicalEventType: 'EVENT_COMMUNITY',
      headline: 'Dover Honda Signs on as Dover Holiday Parade Sponsor',
      whatChanged: 'Dover Honda is the lead Platinum Sponsor for the 2026 Dover Holiday Parade, taking place November 29, 2026.',
      sourceUrl: 'https://www.dovernh.org/news/details/dover-honda-signs-on-as-dover-holiday-parade-sponsor-07-23-2026'
    }]);
    console.log(JSON.stringify({ dateResult, fingerprint: resolved[0]?.eventFingerprint, eventDate: resolved[0]?.eventIdentity?.eventDate }));
  `;
  const timezones = ['UTC', 'America/New_York', 'Pacific/Kiritimati'];
  const outputs = timezones.map(tz => {
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      env: { ...process.env, TZ: tz },
      encoding: 'utf8'
    });
    return { tz, ...JSON.parse(out.trim().split('\n').pop()) };
  });

  assert(outputs.every(o => o.dateResult.eventDate === '2026-11-29'), `2) extractEventDate() resolves the exact same calendar day ("2026-11-29") under every timezone tested (got ${JSON.stringify(outputs.map(o => ({ tz: o.tz, eventDate: o.dateResult.eventDate })))})`);
  assert(outputs.every(o => o.eventDate === '2026-11-29'), `2) the resolved event identity carries "2026-11-29" under every timezone tested`);
  const fingerprints = new Set(outputs.map(o => o.fingerprint));
  assert(fingerprints.size === 1, `2) the persisted v2 fingerprint is byte-identical across all timezones tested (got ${JSON.stringify([...fingerprints])})`);
  assert([...fingerprints][0].endsWith('|2026-11-29'), `2) the canonical Dover fingerprint ends with the correct exact date (got "${[...fingerprints][0]}")`);
}

// ===========================================================================
// 3) Legacy bridge temporal compatibility -- exact captured Dover regression.
//    Legacy row (bare year 2026, no exact date resolved) must bridge against
//    a fresh exact-date (2026-11-29) representation of the same event.
// ===========================================================================
{
  const resolved = resolveOpportunityEvents([DOVER_FRESH_SIGNAL]);
  assert(resolved.length === 1, `3) the fresh Dover Parade signal resolves to one event (got ${resolved.length})`);
  const fresh = resolved[0];
  assert(fresh.eventFingerprint.startsWith('v2|dover honda|'), `3) the fresh signal computes a v2 fingerprint before bridging (got "${fresh.eventFingerprint}")`);

  const stats = applyLegacyFingerprintBridge([DOVER_LEGACY_ROW], resolved);
  assert(stats.bridged === 1 && stats.multiMatch === 0, `3) exactly one signal is bridged against the legacy Dover Parade row, no multi-match (got ${JSON.stringify(stats)})`);
  assert(resolved[0].eventFingerprint === DOVER_LEGACY_ROW.event_fingerprint, `3) the fresh signal's fingerprint is replaced with the legacy row's own literal fingerprint -- refresh in place, no new v2 row (got "${resolved[0].eventFingerprint}")`);
}

// ===========================================================================
// 4) Weak-to-strong temporal enrichment rules, directly against
//    legacyBridgeCompatible(), per the founder's exact rule list.
// ===========================================================================
{
  const base = { companyNorm: 'dover honda', anchor: null, dateConfidence: 'unknown', eventDate: null, year: null, normalizedUrl: 'x.example.com/a', evidenceText: 'dover honda parade sponsor 2026' };

  assert(
    legacyBridgeCompatible({ ...base, dateConfidence: 'exact', eventDate: '2026-11-29', year: null }, { ...base, year: '2026' }),
    '4) legacy year 2026 + fresh exact date 2026-11-29 (same year) may match'
  );
  assert(
    !legacyBridgeCompatible({ ...base, dateConfidence: 'exact', eventDate: '2027-11-29', year: null }, { ...base, year: '2026' }),
    '4) legacy year 2026 + fresh exact date in 2027 (year conflict) never matches'
  );
  assert(
    !legacyBridgeCompatible({ ...base, dateConfidence: 'exact', eventDate: '2026-11-29' }, { ...base, dateConfidence: 'exact', eventDate: '2026-11-28' }),
    '4) exact-date vs exact-date conflict never matches, even same year'
  );
  assert(
    !legacyBridgeCompatible({ ...base, anchor: 'Dover Holiday Parade' }, { ...base, anchor: 'Presidents Award' }),
    '4) conflicting distinctive anchors never match'
  );
  assert(
    legacyBridgeCompatible({ ...base, anchor: 'Dover Holiday Parade' }, { ...base, anchor: 'Dover Holiday Parade', normalizedUrl: 'different.example.com/b' }),
    '4) BOTH sides anchored and agreeing matches even with different URLs (case A -- distinct from one-sided anchor, which is never sufficient alone)'
  );
  assert(
    !legacyBridgeCompatible({ ...base, normalizedUrl: 'a.example.com/x' }, { ...base, normalizedUrl: 'b.example.com/y' }),
    '4) same URL alone is insufficient -- different URLs with no anchor never match'
  );
  assert(
    !legacyBridgeCompatible({ ...base, evidenceText: 'acme corp opens new office' }, { ...base, evidenceText: 'acme corp wins regional award' }),
    '4) same URL but non-agreeing evidence text never matches when neither side has an anchor'
  );
  assert(
    legacyBridgeCompatible(base, base),
    '4) same URL + materially agreeing evidence, no anchor either side, matches ("strong event evidence")'
  );

  // Correction round 2: one-sided anchor existence must NOT establish
  // identity by itself, even with agreeing year and no conflict -- the
  // founder's exact negative fixture (same company/year, fresh side
  // anchored, legacy side anchorless, different URL/evidence).
  assert(
    !legacyBridgeCompatible(
      { ...base, anchor: 'Dover Holiday Parade', year: '2026', normalizedUrl: 'fresh.example.com/parade', evidenceText: 'dover honda sponsors the 2026 dover holiday parade' },
      { ...base, anchor: null, year: '2026', normalizedUrl: 'legacy.example.com/unrelated', evidenceText: 'dover honda opens a new detailing bay this spring' }
    ),
    '4) one-sided anchor existence alone never bridges, even with agreeing year and no explicit conflict -- different URL/evidence means tolerate the duplicate'
  );

  // Case B positive: exactly one side anchored, but the SAME URL and
  // materially agreeing evidence supply the required corroboration -- the
  // bridge is not categorically closed for a one-sided anchor, only for a
  // one-sided anchor with nothing else behind it.
  assert(
    legacyBridgeCompatible(
      { ...base, anchor: 'Dover Holiday Parade', year: '2026', normalizedUrl: 'shared.example.com/parade-story', evidenceText: 'dover honda signs on as dover holiday parade sponsor for 2026' },
      { ...base, anchor: null, year: '2026', normalizedUrl: 'shared.example.com/parade-story', evidenceText: 'dover honda signs on as dover holiday parade sponsor for 2026' }
    ),
    '4) one-sided anchor PLUS same URL and materially agreeing evidence does bridge -- the anchor alone was the problem, not real corroboration'
  );
}

// ===========================================================================
// 5) Presidents' Award multi-legacy bridge remains unaffected by the
//    compatibility-rule rewrite: deterministic winner selected, refreshed;
//    non-winning duplicate untouched.
// ===========================================================================
{
  const rows = [
    { id: 'row-a', account_name: 'Dover Honda', event_fingerprint: 'dover honda|LEADERSHIP_APPOINTMENT||unknown', confidence: 22, first_seen_at: '2026-08-09T04:32:26.924787+00:00', payload: { accountName: 'Dover Honda', headline: 'Dover Honda Team Named for Presidents Award', whatChanged: 'Dover Honda was named as a recipient of the Presidents Award this year.' } },
    { id: 'row-b', account_name: 'Dover Honda', event_fingerprint: 'dover honda|EVENT_AWARD||unknown', confidence: 22, first_seen_at: '2026-08-09T15:42:38.065251+00:00', payload: { accountName: 'Dover Honda', headline: 'Dover Honda Wins Presidents Award', whatChanged: 'Dover Honda received the Presidents Award for outstanding service.' } }
  ];
  const resolved = resolveOpportunityEvents([{
    companyName: 'Dover Honda', canonicalEventType: 'EVENT_AWARD',
    headline: 'Dover Honda Receives Presidents Award', whatChanged: 'Dover Honda was honored with the Presidents Award this year.',
    sourceUrl: 'https://c.example.com/story3', confidenceScore: 45
  }]);
  const stats = applyLegacyFingerprintBridge(rows, resolved);
  assert(stats.bridged === 1 && stats.multiMatch === 1, `5) multi-legacy-match still detected and bridged exactly once, diagnostic emitted (got ${JSON.stringify(stats)})`);
  const winner = chooseRetainedLegacyRow(rows);
  assert(resolved[0].eventFingerprint === winner.event_fingerprint, `5) the deterministic winner (highest confidence, then earliest first_seen_at) is the one refreshed (got "${resolved[0].eventFingerprint}", winner "${winner.event_fingerprint}")`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
