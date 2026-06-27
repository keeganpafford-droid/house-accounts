# House Accounts v40 — Returning Dashboard + Weekly Email Links

Upload/replace:
- `index.html`
- `api/get-dashboard.js`
- `api/weekly-scan.js`

Keep from v39:
- `api/save-upload.js`
- `api/research-account.js`
- `api/research-batch.js`
- `vercel.json`
- `supabase-schema.sql` already run

What changed:
- Adds returning-user email lookup on the homepage.
- Adds `/api/get-dashboard?email=` to load saved account lists and signals from Supabase.
- Weekly emails now include a dashboard link back to the saved account view.
- New users still see signup + upload.
- Returning users can view their saved dashboard without passwords during beta.

Required Vercel env vars:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `ALERTS_FROM_EMAIL`
- `APP_BASE_URL`
- `CRON_SECRET`

Test flow:
1. Upload a CSV and confirm Supabase rows save.
2. Refresh the site.
3. Use “Returning user? View dashboard” with the same email.
4. Confirm saved accounts/signals load.
5. Test weekly scan manually with `/api/weekly-scan?secret=YOUR_CRON_SECRET&dryRun=true`.


## V42 Marketing Site

Added public pages:
- `/pricing.html`
- `/security.html`
- `/privacy.html`
- `/terms.html`
- `/contact.html`
- `/favicon.svg`

Updated homepage header/footer navigation. Stripe not connected yet.
