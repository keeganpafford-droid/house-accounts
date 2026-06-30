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
1. Upload a customer list and confirm Supabase rows save.
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

## V43.1 — Opportunity Score Engine

This release adds an internal Opportunity Score / Why Now Score used to rank recommendations. It combines historical revenue, timing, repeat patterns, business-signal freshness, confidence, actionability, category expansion, and dormancy. No major UI redesign was added in this release; the score is used behind the scenes to make the feed more opinionated and prioritize the strongest reasons to reach out.

## v43.2 — This Week's Priorities

This release turns the main feed from a broad list of reasons into a focused weekly work queue.

- Renamed the main feed to **This Week's Priorities**.
- Defaults to the top 15 recommendations by Opportunity Score.
- Limits repeated accounts in the priority feed so one account does not dominate.
- Adds **View All Opportunities** for users who want to review the full dataset.
- Replaces “today” language with “this week” to match the weekly monitoring product promise.

## V43.3 — Signal Type Badges

This release makes every recommendation easier to understand at a glance.

### Added
- Recommendation badges: Reorder Due, Annual Buying Pattern, Business Trigger, Category Expansion, Dormant High-Value, Recent Project Follow-Up.
- Clear “Why this account” language on each priority card.
- Why Now score displayed inside the confidence line.
- Account Intelligence reasons now lead with the recommendation type instead of generic labels.

### Goal
A rep should immediately know why an account appears in the weekly feed before reading the evidence.
