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
  dedupeOpportunities
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

const deterministicReport = {
  benchmarkCompanies: fixture.length,
  legacyTypeOnlyClassificationAccuracy: Number((legacyCorrect / legacyDeclaredTypeSamples.length * 100).toFixed(1)),
  v1EvidenceAwareClassificationAccuracy: Number((v1Correct / legacyDeclaredTypeSamples.length * 100).toFixed(1)),
  deterministicClassificationAccuracy: Number((classification * 100).toFixed(1)),
  duplicateClusterCount: clustered.length,
  normalizedOpportunityValid: validation.valid,
  normalizedOpportunityRejectionReasons: validation.reasons,
  opportunityDeduplicationCount: deduped.length
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
if (classification < 1 || clustered.length !== 1 || !validation.valid || deduped.length !== 1) process.exitCode = 1;
