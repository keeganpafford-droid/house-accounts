# House Accounts v38 — Unified Signal Sprint

Upload/replace:
- index.html
- api/research-account.js
- api/research-batch.js

Requires environment variables:
- OPENAI_API_KEY
- OPENAI_MODEL (recommended: gpt-4o-mini)
- SERPER_API_KEY
- FIRECRAWL_API_KEY

What changed:
- Unified business signals so feed, detailed views, and sales plays use the same signal objects.
- Stronger targeted search query set per company.
- Improved AI prompt: senior promo salesperson, top 1–2 legitimate reasons only.
- Dedupes similar signals and merges multiple evidence sources.
- Adds freshness/source quality into confidence scoring.
- Lets strong business signals surface quiet accounts in Today’s Best Reasons.
- Re-renders detailed account views after research so account rankings and signal counts stay in sync.
