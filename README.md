# House Accounts v36 – Targeted Business Signal Pipeline

This release changes the business signal engine to mirror the Google-AI style workflow:

1. Entity / signal search using targeted search operators.
2. Candidate snippet ranking.
3. LLM synthesis into promo-relevant business signals.

## Upload / Replace
- `index.html`
- `api/research-batch.js`
- `api/research-account.js`

## Strongly Recommended Environment Variable
Add at least one search provider key in Vercel for best results:

- `SERPER_API_KEY` (recommended)
- `TAVILY_API_KEY`
- `BRAVE_SEARCH_API_KEY`

Keep:
- `OPENAI_API_KEY`
- `OPENAI_MODEL=gpt-4o-mini`

If no search provider is configured, the app falls back to OpenAI web search, but dedicated search APIs usually return cleaner candidate snippets for the LLM.
