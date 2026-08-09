// Foundation freeze, Phase 1E: rawTitle/rawSnippet (normalizeOpportunity(),
// api/signal-intelligence.js) exist to preserve the original candidate's
// source-derived text so downstream identity resolution
// (resolveOpportunityEvents()) can prefer genuinely raw text over
// LLM-resynthesized wording. Confirmed by direct inspection of both
// production candidate-construction paths (api/research-batch.js's
// discoverCandidatesForAccounts()/scoreCandidate(), api/research-account.js's
// search-result mapping): every real candidate carries the search
// provider's own title under `.title` -- never `.headline` -- so the
// pre-fix `rawTitle: clean(candidate.headline || '')` was always ''  on the
// real path, inert since it was introduced. This is the batch-shaped
// candidate regression required to prove the fix.
//
// Usage: node scripts/test-foundation-freeze-raw-title-provenance.js
import { normalizeOpportunity } from '../api/signal-intelligence.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// A real, production-batch-shaped candidate: exactly the object shape
// discoverCandidatesForAccounts()/scoreCandidate() (api/research-batch.js)
// construct from a search provider result -- `.title`, no `.headline`.
// ===========================================================================
{
  const batchShapedCandidate = {
    title: 'Acme Manufacturing Breaks Ground on New Distribution Center',
    snippet: 'Acme Manufacturing announced plans for a new 200,000 sq ft distribution center in Riverside.',
    url: 'https://example.com/acme-distribution-center',
    source: 'example.com',
    date: '2 days ago'
  };
  const raw = {
    whatChanged: 'Acme is expanding its logistics footprint with a new facility.',
    signalTitle: 'Acme Facility Expansion'
  };
  const normalized = normalizeOpportunity(raw, { name: 'Acme Manufacturing' }, batchShapedCandidate);

  assert(
    normalized.rawTitle === 'Acme Manufacturing Breaks Ground on New Distribution Center',
    `rawTitle is populated from the real batch-shaped candidate's .title field, not left empty (got "${normalized.rawTitle}")`
  );
  assert(
    normalized.rawSnippet === 'Acme Manufacturing announced plans for a new 200,000 sq ft distribution center in Riverside.',
    `rawSnippet is populated from the candidate's .snippet field (got "${normalized.rawSnippet}")`
  );

  // Additive only: rawTitle must never overwrite headline/whatChanged, the
  // model-authored fields every existing consumer already expects.
  assert(normalized.headline === 'Acme Facility Expansion', `rawTitle is additive only -- normalizeOpportunity()'s model-authored headline field is untouched (got "${normalized.headline}")`);
  assert(normalized.whatChanged === 'Acme is expanding its logistics footprint with a new facility.', `rawTitle is additive only -- normalizeOpportunity()'s model-authored whatChanged field is untouched (got "${normalized.whatChanged}")`);
}

// ===========================================================================
// Confirm the OLD (pre-fix) inert-path failure mode is what actually
// happened: a candidate.headline-only lookup against a real batch-shaped
// candidate (title only, no headline) resolves to ''.
// ===========================================================================
{
  const batchShapedCandidate = { title: 'Acme Wins Regional Contract', snippet: 'Acme was awarded a major regional supply contract.', url: 'https://example.com/acme-contract' };
  const oldBehaviorResult = (batchShapedCandidate.headline || '');
  assert(oldBehaviorResult === '', `sanity: the pre-fix candidate.headline-only lookup is confirmed inert against a real batch-shaped candidate (got "${oldBehaviorResult}")`);
}

// ===========================================================================
// Backward compatibility: a candidate that DOES carry .headline (no .title)
// -- defensive fallback, in case any future or non-batch caller passes that
// shape -- still populates rawTitle correctly, title taking precedence when
// both are present.
// ===========================================================================
{
  const headlineOnlyCandidate = { headline: 'Legacy-shaped candidate headline', snippet: 'Legacy snippet.', url: 'https://example.com/legacy' };
  const normalizedHeadlineOnly = normalizeOpportunity({}, { name: 'Legacy Co' }, headlineOnlyCandidate);
  assert(normalizedHeadlineOnly.rawTitle === 'Legacy-shaped candidate headline', `rawTitle falls back to candidate.headline when .title is absent (got "${normalizedHeadlineOnly.rawTitle}")`);

  const bothCandidate = { title: 'Real Title', headline: 'Should Not Win', snippet: '' };
  const normalizedBoth = normalizeOpportunity({}, { name: 'Both Co' }, bothCandidate);
  assert(normalizedBoth.rawTitle === 'Real Title', `rawTitle prefers candidate.title over candidate.headline when both are present, matching every other candidate-title read in this function (got "${normalizedBoth.rawTitle}")`);
}

// ===========================================================================
// No candidate at all (the {} default) -- rawTitle stays '', never throws.
// ===========================================================================
{
  const normalizedNoCandidate = normalizeOpportunity({ signalTitle: 'Standalone signal' }, { name: 'No Candidate Co' });
  assert(normalizedNoCandidate.rawTitle === '', `rawTitle is '' (not thrown/undefined) when no candidate is passed at all (got "${normalizedNoCandidate.rawTitle}")`);
}

if(failures > 0){
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
