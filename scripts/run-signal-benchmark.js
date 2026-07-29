/* Development-only deterministic benchmark smoke test.
 * This does not call Serper, Firecrawl, OpenAI, or production APIs.
 * Use --input <json> to score captured engine output against the fixture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifySignalFamily,
  normalizeCandidate,
  clusterCandidates,
  normalizeOpportunity,
  validateOpportunity,
  dedupeOpportunities,
  resolveEvents
} from '../api/signal-intelligence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, '..', 'benchmarks', 'signal-benchmark.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const args = process.argv.slice(2);
const inputIndex = args.indexOf('--input');

function familyAccuracy(samples) {
  let correct = 0;
  samples.forEach(sample => {
    const got = classifySignalFamily(sample.text);
    if (got === sample.expected) correct += 1;
    else console.error(`classification miss: ${sample.text} => ${got}, expected ${sample.expected}`);
  });
  return correct / samples.length;
}

const classificationSamples = [
  { text: 'Gallagher acquired Safe T Professionals', expected: 'financial' },
  { text: 'Avidia received an innovation award', expected: 'award' },
  { text: 'Company reopened its renovated branch', expected: 'growth' },
  { text: 'Company will exhibit at PACK EXPO', expected: 'events' },
  { text: 'Board appointed a new chief marketing officer', expected: 'leadership' },
  { text: 'Company launched a new merchant settlement product', expected: 'product' },
  { text: 'Company is recruiting 120 production employees', expected: 'hiring' },
  { text: 'Company sponsored a regional charity golf tournament', expected: 'community' }
];

const duplicateSamples = [
  normalizeCandidate({ accountName: 'Arthur J. Gallagher', title: 'Gallagher acquires Safe T Professionals', snippet: 'Arthur J. Gallagher acquired Safe T Professionals and expands risk-control services.', url: 'https://example.com/a?utm_source=x', date: '2026-07-01' }, { name: 'Arthur J. Gallagher' }),
  normalizeCandidate({ accountName: 'Arthur J. Gallagher', title: 'Arthur J. Gallagher Announces Acquisition of Safe T Professionals', snippet: 'Gallagher acquired Safe T Professionals.', url: 'https://wire.example.com/story', date: '2026-07-01' }, { name: 'Arthur J. Gallagher' })
];

const legacyDeclaredTypeSamples = [
  { declared: 'Recent Hiring', evidence: 'Gallagher acquired Safe T Professionals', expected: 'financial' },
  { declared: 'Recent Hiring', evidence: 'Avidia received an innovation award', expected: 'award' },
  { declared: 'Growth Activity', evidence: 'Company reopened its renovated branch', expected: 'growth' },
  { declared: 'Trade Show', evidence: 'Company will exhibit at PACK EXPO', expected: 'events' },
  { declared: 'Leadership Change', evidence: 'Board appointed a new chief marketing officer', expected: 'leadership' },
  { declared: 'Product Launch', evidence: 'Company launched a new merchant settlement product', expected: 'product' },
  { declared: 'Hiring', evidence: 'Company is recruiting 120 production employees', expected: 'hiring' },
  { declared: 'Community', evidence: 'Company sponsored a regional charity golf tournament', expected: 'community' }
];
function legacyFamily(type = '') {
  const t = String(type).toLowerCase();
  if (/hiring|job|career|recruit|talent|staff/.test(t)) return 'hiring';
  if (/trade|expo|conference|summit|event|webinar/.test(t)) return 'events';
  if (/award|recognition|milestone|anniversary/.test(t)) return 'award';
  if (/expansion|facility|location|office|opening|growth/.test(t)) return 'growth';
  if (/leadership|appoint|promot|ceo|president|director|vp/.test(t)) return 'leadership';
  if (/launch|product|service/.test(t)) return 'product';
  if (/acquisition|merger|funding|investment/.test(t)) return 'financial';
  if (/community|charity|sponsor|volunteer/.test(t)) return 'community';
  return 'unknown';
}
const legacyCorrect = legacyDeclaredTypeSamples.filter(x => legacyFamily(x.declared) === x.expected).length;
const v1Correct = legacyDeclaredTypeSamples.filter(x => classifySignalFamily(`${x.declared} ${x.evidence}`) === x.expected).length;
const classification = familyAccuracy(classificationSamples);
const clustered = clusterCandidates(duplicateSamples);
const smokeOpportunity = normalizeOpportunity({
  companyName: 'Arthur J. Gallagher',
  signalTitle: 'Acquisition of Safe T Professionals',
  whatChanged: 'Arthur J. Gallagher acquired Safe T Professionals.',
  whyThisMatters: 'The acquisition may create onboarding, internal communication, safety-program, and brand-integration needs across the combined workforce.',
  sourceUrl: 'https://example.com/a',
  confidenceScore: 88
}, { name: 'Arthur J. Gallagher' }, duplicateSamples[0]);
const validation = validateOpportunity(smokeOpportunity);
const deduped = dedupeOpportunities([smokeOpportunity, { ...smokeOpportunity, confidenceScore: 80 }]);

// ---------------------------------------------------------------------------
// Sprint 4.5.1 Stage A — Business Event resolution fixtures.
// resolveEvents() is compared against clusterCandidates() (the current
// production path, unchanged) on every fixture. No production call site
// uses resolveEvents() yet.
// ---------------------------------------------------------------------------
function evCand(overrides) {
  return normalizeCandidate({ accountName: 'Acme Corp', url: `https://example.com/${Math.random().toString(36).slice(2)}`, ...overrides }, { name: 'Acme Corp' });
}

const eventResolutionFixtures = [
  { name: 'Westborough — 4 independent sources', expectEvents: 1, expectEvidence: [4], candidates: [
    evCand({ title: 'Acme Corp Announces New Westborough Branch', snippet: 'Acme Corp today announced the grand opening of its new Westborough branch, part of continued regional growth.', url: 'https://acmecorp.com/press/westborough', sourceName: 'acmecorp.com' }),
    evCand({ title: 'Acme Corp Westborough Branch — Grand Opening', snippet: 'Join us for the ribbon cutting celebrating our brand new Westborough branch location.', url: 'https://eventbrite.com/e/acme-westborough', sourceName: 'Eventbrite' }),
    evCand({ title: 'Chamber Welcomes Acme Corp Westborough Branch', snippet: 'The Westborough Chamber of Commerce congratulates Acme Corp on opening its new branch in Westborough.', url: 'https://westboroughchamber.org/news/acme', sourceName: 'Westborough Chamber' }),
    evCand({ title: 'New Acme Corp Location Opens Doors in Westborough', snippet: 'Local business Acme Corp celebrated the opening of a new location in Westborough this week with a ribbon cutting ceremony.', url: 'https://localnewsdaily.com/acme-westborough', sourceName: 'Local News Daily' })
  ]},
  { name: 'Westborough — syndicated wire reposts', expectEvents: 1, expectEvidence: [4], candidates: [
    evCand({ title: 'Acme Corp Announces New Westborough Branch', snippet: 'Acme Corp today announced the grand opening of its new Westborough branch as part of continued regional growth plans.', url: 'https://businesswire.com/acme-westborough', sourceName: 'BusinessWire' }),
    evCand({ title: 'Acme Corp Announces New Westborough Branch', snippet: 'Acme Corp today announced the grand opening of its new Westborough branch as part of continued regional growth plans.', url: 'https://financeportal.com/wire/acme-westborough', sourceName: 'FinancePortal' }),
    evCand({ title: 'Acme Corp Announces New Westborough Branch', snippet: 'Acme Corp today announced the grand opening of its new Westborough branch as part of continued regional growth plans.', url: 'https://marketwatchclone.com/acme-westborough', sourceName: 'MarketWatchClone' }),
    evCand({ title: 'Westborough Welcomes New Acme Corp Branch', snippet: 'Local reporters visited the new Acme Corp branch in Westborough and spoke with staff about the opening celebration.', url: 'https://localnewsdaily.com/acme-westborough-visit', sourceName: 'Local News Daily' })
  ]},
  { name: 'Two genuinely different branch openings', expectEvents: 2, candidates: [
    evCand({ title: 'Acme Corp Opens New Branch in Springfield', snippet: 'Acme Corp opens new branch in Springfield, MA this month.', url: 'https://acmecorp.com/press/springfield' }),
    evCand({ title: 'Acme Corp Opens New Branch in Worcester', snippet: 'Acme Corp opens new branch in Worcester, MA this month.', url: 'https://acmecorp.com/press/worcester' })
  ]},
  { name: 'Recurring annual event — different years', expectEvents: 2, candidates: [
    evCand({ title: 'Acme Corp Annual User Conference 2025', snippet: 'Acme Corp hosts its Annual User Conference 2025 for customers and partners.', url: 'https://acmecorp.com/conference-2025' }),
    evCand({ title: 'Acme Corp Annual User Conference 2026', snippet: 'Acme Corp hosts its Annual User Conference 2026 for customers and partners.', url: 'https://acmecorp.com/conference-2026' })
  ]},
  { name: 'Ambiguous/incomplete mention does not force-merge', expectEvents: 2, candidates: [
    evCand({ title: 'Acme Corp Expanding Branch Network', snippet: 'Acme Corp is expanding its branch network with a new location coming soon.', url: 'https://acmecorp.com/press/expansion-teaser' }),
    evCand({ title: 'Acme Corp Announces New Westborough Branch', snippet: 'Acme Corp opens new branch in Westborough, MA.', url: 'https://acmecorp.com/press/westborough2' })
  ]},
  { name: 'Synonym set (ribbon cutting / grand opening / branch opening / new branch / new location)', expectEvents: 1, expectEvidence: [5], candidates: [
    evCand({ title: 'Ribbon Cutting Held', snippet: 'Acme Corp holds ribbon cutting for its new Westborough branch.', url: 'https://source1.com/a' }),
    evCand({ title: 'Grand Opening', snippet: 'Acme Corp celebrates grand opening of new Westborough location.', url: 'https://source2.com/b' }),
    evCand({ title: 'Branch Opening', snippet: 'Acme Corp announces Westborough branch opening.', url: 'https://source3.com/c' }),
    evCand({ title: 'New Branch', snippet: 'Acme Corp opens new branch in Westborough.', url: 'https://source4.com/d' }),
    evCand({ title: 'New Location', snippet: 'Acme Corp expands to new location in Westborough.', url: 'https://source5.com/e' })
  ]},
  { name: 'Leadership appointment phrasing variants', expectEvents: 1, expectEvidence: [4], candidates: [
    evCand({ title: 'Nelson Named EVP', snippet: 'Jonathan Nelson was appointed Executive Vice President and CFO.', url: 'https://s1.com/a' }),
    evCand({ title: 'Nelson Appointment', snippet: 'Acme Corp names Jonathan Nelson as Executive Vice President and CFO.', url: 'https://s2.com/b' }),
    evCand({ title: 'Nelson Promotion', snippet: 'Jonathan Nelson was promoted to Executive Vice President and CFO.', url: 'https://s3.com/c' }),
    evCand({ title: 'Nelson Joins', snippet: 'Jonathan Nelson joins as Executive Vice President and CFO.', url: 'https://s4.com/d' })
  ]},
  { name: 'Acquisition phrasing variants', expectEvents: 1, expectEvidence: [4], candidates: [
    evCand({ title: 'Acme Acquires ABC', snippet: 'Acme Corp acquired ABC Company in a deal announced today.', url: 'https://s1.com/a' }),
    evCand({ title: 'ABC Acquisition', snippet: 'Acme Corp acquisition of ABC Company finalized.', url: 'https://s2.com/b' }),
    evCand({ title: 'ABC Deal Closes', snippet: 'Acme Corp completes acquisition of ABC Company.', url: 'https://s3.com/c' }),
    evCand({ title: 'ABC Purchase', snippet: 'Acme Corp finalizes purchase of ABC Company.', url: 'https://s4.com/d' })
  ]},
  { name: 'Facility expansion phrasing variants', expectEvents: 1, expectEvidence: [4], candidates: [
    evCand({ title: 'Lebanon Facility', snippet: 'Acme Corp opens new facility in Lebanon.', url: 'https://s1.com/a' }),
    evCand({ title: 'Lebanon Capacity', snippet: 'Acme Corp capacity expansion underway at its Lebanon plant.', url: 'https://s2.com/b' }),
    evCand({ title: 'Lebanon Operations', snippet: 'Acme Corp expanding operations at its facility in Lebanon.', url: 'https://s3.com/c' }),
    evCand({ title: 'Lebanon Plant', snippet: 'Acme Corp new plant in Lebanon nears completion.', url: 'https://s4.com/d' })
  ]},
  { name: 'Ribbon cutting (new) vs ribbon cutting (renovation)', expectEvents: 2, candidates: [
    evCand({ title: 'Westborough Ribbon Cutting', snippet: 'Acme Corp holds ribbon cutting for its new Westborough branch.', url: 'https://s1.com/a' }),
    evCand({ title: 'Westborough Renovation Ribbon Cutting', snippet: 'Acme Corp holds ribbon cutting after completing renovations at its Westborough branch.', url: 'https://s2.com/b' })
  ]},
  { name: 'New branch opening vs reopening of same branch', expectEvents: 2, candidates: [
    evCand({ title: 'Nashua New Branch', snippet: 'Acme Corp announces new branch opening in Nashua, NH.', url: 'https://s1.com/a' }),
    evCand({ title: 'Nashua Reopens', snippet: "Acme Corp's Nashua branch reopens after temporary closure.", url: 'https://s2.com/b' })
  ]},
  { name: 'Two branches, two cities, same month', expectEvents: 2, candidates: [
    evCand({ title: 'Springfield Opening', snippet: 'Acme Corp opens new branch in Springfield, MA this month.', url: 'https://s1.com/a' }),
    evCand({ title: 'Worcester Opening', snippet: 'Acme Corp opens new branch in Worcester, MA this month.', url: 'https://s2.com/b' })
  ]},
  { name: 'Branch announcement then later ribbon cutting, location aligns', expectEvents: 1, expectEvidence: [2], candidates: [
    evCand({ title: 'Westborough Announcement', snippet: 'Acme Corp announces new branch opening in Westborough, MA.', url: 'https://s1.com/a', publishedAt: '2026-05-01' }),
    evCand({ title: 'Westborough Ribbon Cutting', snippet: "Ribbon cutting held for Acme Corp's Westborough location.", url: 'https://s2.com/b', publishedAt: '2026-07-10' })
  ]},
  { name: 'Publication date must not become event date', expectEvents: 1, checkEventDate: '2026-03-03', candidates: [
    evCand({ title: 'Nelson Appointment', snippet: 'Jonathan Nelson was appointed Executive Vice President and CFO effective March 3, 2026.', url: 'https://s1.com/a', publishedAt: '2026-06-15' })
  ]},
  { name: 'SEO-headline source must not become the canonical title', expectEvents: 1, checkTitleSource: 'generated', checkTitleExcludes: "You Won't Believe", candidates: [
    evCand({ title: "You Won't Believe What Acme Corp Just Acquired | TechBlog Daily", snippet: 'Acme Corp completes acquisition of ABC Company in a surprising move.', url: 'https://businesswire.com/acme-abc', sourceName: 'BusinessWire' })
  ]}
];

const eventResolutionResults = eventResolutionFixtures.map(fx => {
  const resolved = resolveEvents(fx.candidates);
  const clusteredForFixture = clusterCandidates(fx.candidates);
  const checks = [['eventCount', resolved.length === fx.expectEvents]];
  if (fx.expectEvidence) {
    const counts = resolved.map(e => e.corroboratingCandidates).sort((a, b) => b - a);
    checks.push(['evidenceCounts', JSON.stringify(counts) === JSON.stringify([...fx.expectEvidence].sort((a, b) => b - a))]);
  }
  if (fx.checkEventDate) checks.push(['eventDate', resolved[0]?.eventIdentity?.eventDate === fx.checkEventDate]);
  if (fx.checkTitleSource) checks.push(['titleSource', resolved[0]?.eventIdentity?.titleSource === fx.checkTitleSource]);
  if (fx.checkTitleExcludes) checks.push(['titleExcludesSeoJunk', !(resolved[0]?.canonicalTitle || '').includes(fx.checkTitleExcludes)]);
  const pass = checks.every(([, ok]) => ok);
  return {
    fixture: fx.name,
    pass,
    failedChecks: checks.filter(([, ok]) => !ok).map(([label]) => label),
    resolveEventsCount: resolved.length,
    clusterCandidatesCount: clusteredForFixture.length,
    events: resolved.map(e => ({
      canonicalTitle: e.canonicalTitle,
      eventType: e.eventIdentity.eventType,
      location: e.eventIdentity.location,
      eventDate: e.eventIdentity.eventDate,
      dateConfidence: e.eventIdentity.dateConfidence,
      titleSource: e.eventIdentity.titleSource,
      evidenceCount: e.corroboratingCandidates,
      corroboration: e.evidence.map(ev => ev.corroboration)
    }))
  };
});
const eventResolutionPassCount = eventResolutionResults.filter(r => r.pass).length;

const deterministicReport = {
  benchmarkCompanies: fixture.length,
  legacyTypeOnlyClassificationAccuracy: Number((legacyCorrect / legacyDeclaredTypeSamples.length * 100).toFixed(1)),
  v1EvidenceAwareClassificationAccuracy: Number((v1Correct / legacyDeclaredTypeSamples.length * 100).toFixed(1)),
  deterministicClassificationAccuracy: Number((classification * 100).toFixed(1)),
  duplicateClusterCount: clustered.length,
  normalizedOpportunityValid: validation.valid,
  normalizedOpportunityRejectionReasons: validation.reasons,
  opportunityDeduplicationCount: deduped.length,
  eventResolutionStageA: {
    fixturesTotal: eventResolutionFixtures.length,
    fixturesPassed: eventResolutionPassCount,
    fixturesFailed: eventResolutionFixtures.length - eventResolutionPassCount,
    results: eventResolutionResults
  }
};

if (inputIndex >= 0 && args[inputIndex + 1]) {
  const output = JSON.parse(fs.readFileSync(args[inputIndex + 1], 'utf8'));
  const signals = Array.isArray(output) ? output : (output.signals || []);
  let expected = 0, found = 0, classificationCorrect = 0;
  const misses = [];
  fixture.forEach(company => {
    const companySignals = signals.filter(s => String(s.companyName || s.accountName || '').toLowerCase().includes(company.company.toLowerCase()));
    company.essential.forEach(item => {
      expected += 1;
      const hit = companySignals.find(s => classifySignalFamily(`${s.signalType || ''} ${s.headline || s.signalTitle || ''} ${s.whatChanged || s.summary || ''}`) === item.family);
      if (hit) { found += 1; classificationCorrect += 1; }
      else misses.push({ company: company.company, expected: item });
    });
  });
  deterministicReport.capturedOutput = {
    expectedEssentialSignals: expected,
    essentialSignalsFound: found,
    recall: expected ? Number((found / expected * 100).toFixed(1)) : 0,
    classificationAccuracy: found ? Number((classificationCorrect / found * 100).toFixed(1)) : 0,
    misses
  };
}

console.log(JSON.stringify(deterministicReport, null, 2));
if (classification < 1 || clustered.length !== 1 || !validation.valid || deduped.length !== 1 || eventResolutionPassCount !== eventResolutionFixtures.length) process.exitCode = 1;
