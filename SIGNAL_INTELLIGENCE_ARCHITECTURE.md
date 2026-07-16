# Business Signal Intelligence Engine v1

## Current shared flow

1. Intent-based query planning
2. Serper candidate collection and provider retry behavior
3. Candidate normalization at the API boundary
4. Deterministic entity, source-authority, freshness, and commercial scoring
5. Event-level clustering and source consolidation
6. Firecrawl enrichment for the strongest bounded candidates
7. OpenAI structured opportunity extraction
8. Canonical event classification independent of buyer recommendation
9. Opportunity validation and event-fingerprint deduplication
10. Existing workflow ranking, persistence, and presentation

## Workflow entry points

- `api/research-batch.js`: prospect batches, warm/existing customer batch research, weekly research callers
- `api/research-account.js`: one-account manual research
- `api/signal-intelligence.js`: shared deterministic normalization, verification, classification, scoring, clustering, and opportunity validation
- `api/weekly-scan.js`: scheduled customer monitoring using the batch path

## Why classifications previously collapsed

The model-supplied `signalType` was trusted before the complete event evidence was evaluated. Buyer-team language such as HR/Talent could also reinforce a Hiring label even when the source described an acquisition or award. Classification now evaluates the event headline, summary, context, and source candidate before buyer generation.

## Why duplicate event coverage previously survived

URL/title normalization removed exact copies, but did not consistently group company press releases, wire copies, and publication coverage describing the same underlying event. The shared engine now creates an event fingerprint and clusters corroborating sources before final opportunity deduplication.

## Cost and latency guardrails

- Query plans are bounded and deduplicated.
- Existing Serper queue/retry controls remain in place.
- Deterministic rejection occurs before Firecrawl/OpenAI where the workflow allows it.
- Firecrawl remains limited to top candidates.
- OpenAI receives normalized event candidates rather than unbounded raw search results.
- Diagnostics include candidate counts and score breakdowns for future cost-per-accepted-signal measurement.

## Benchmarking

Run deterministic smoke tests:

```bash
node scripts/run-signal-benchmark.js
```

Score a captured API response:

```bash
node scripts/run-signal-benchmark.js --input captured-signals.json
```

The fixture is development-only and is not imported by production code.
