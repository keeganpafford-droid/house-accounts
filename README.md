# House Accounts v26 — AI Business Signal Qualification

Adds an optional OpenAI-powered qualification layer to the business signal pipeline.

If `OPENAI_API_KEY` is configured in Vercel, the research endpoint will:
1. Search candidate public pages/results.
2. Ask AI whether each candidate is a legitimate promo-relevant business signal.
3. Return only meaningful signals with signal type, why reach out, suggested opener, contact role, and confidence.

If no API key is configured, the app safely falls back to the existing keyword-based signal logic.

Required Vercel environment variable:
- `OPENAI_API_KEY`

Optional:
- `OPENAI_MODEL` defaults to `gpt-4o-mini`

Upload/replace:
- `api/research-account.js`
- `index.html`

Keep other files as included if you want a full v26 replacement.
