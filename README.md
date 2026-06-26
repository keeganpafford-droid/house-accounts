# House Accounts v39 — Supabase Storage + Weekly Email Pipeline

## Upload / Replace
- `index.html`
- `api/save-upload.js`
- `api/weekly-scan.js`
- `api/research-account.js`
- `api/research-batch.js`
- `vercel.json`
- `supabase-schema.sql` is for Supabase SQL Editor only.

## Required Vercel Environment Variables
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- Existing: `OPENAI_API_KEY`, `OPENAI_MODEL`, `SERPER_API_KEY`, `FIRECRAWL_API_KEY`

## Recommended Vercel Environment Variables
- `ALERTS_FROM_EMAIL=House Accounts <alerts@yourdomain.com>`
- `APP_BASE_URL=https://yourdomain.com`
- `CRON_SECRET=<random-long-secret>`

## Supabase Setup
Run `supabase-schema.sql` once in Supabase SQL Editor before testing saves.

## What v39 Adds
- Saves lead + uploaded account list to Supabase.
- Saves analyzed account records and verified business signals.
- Adds `/api/weekly-scan` for Monday cron monitoring.
- Weekly scan researches stored uploads, compares new signals against existing signal hashes, stores only new signals, and emails users through Resend.

## Manual Test
After deploy and schema setup:
1. Upload a CSV.
2. Confirm rows appear in Supabase: `ha_users`, `ha_uploads`, `ha_accounts`.
3. Run: `/api/weekly-scan?dryRun=true`
4. If you set `CRON_SECRET`, run: `/api/weekly-scan?dryRun=true&secret=YOUR_SECRET`
