# Account Radar MVP

A lightweight promo-industry account intelligence prototype.

## What it does

- Upload a CSV locally in the browser
- Scores accounts by revenue, frequency, recency, and project diversity
- Adds a **Research Account** button
- Calls a secure backend endpoint instead of calling AI directly from the browser
- If `OPENAI_API_KEY` is missing, returns demo-mode research so the app still works

## Run locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Enable live web research

Create a `.env` file:

```bash
OPENAI_API_KEY=your_key_here
```

Then restart:

```bash
npm start
```

## Deploy to Vercel

1. Upload this folder to Vercel
2. Add environment variable: `OPENAI_API_KEY`
3. Deploy

## Important

ChatGPT Plus does not automatically provide API access for apps. To use live AI research in this app, you need an API key with billing enabled.
