# Beta Operations Runbook

This document describes how to run House Accounts as a founder-led, manually
billed paid beta with the system as it exists today. It uses only real
tables, fields, and routes that already exist in this codebase — nothing
here is a proposed or future feature.

## Before onboarding customer #1

Run through this checklist once, before the first paying customer is
created, and re-check it before onboarding any customer after a Production
deploy.

- [ ] **Verify the deployed commit.** Confirm the Vercel Production
      deployment is built from the commit you intend to ship (check the
      Vercel dashboard directly — this repo has no way to query Vercel
      deployment state from the command line).
- [ ] **Verify provider keys are set in Production.** `OPENAI_API_KEY`,
      `SERPER_API_KEY`, `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`,
      `FIRECRAWL_API_KEY` — research quality depends on which of these are
      configured; confirm the set matches what you expect research quality
      to be.
- [ ] **Verify `CRON_SECRET` is set.** `api/weekly-scan.js` and the
      weekly-monitoring path in `api/research-batch.js` fail closed (503)
      without it — this is correct and required, not a bug to work around.
- [ ] **Verify `RESEND_API_KEY` and `RESEND_FROM_EMAIL`.** Required for the
      weekly digest email and any transactional email to actually send.
- [ ] **Confirm whether the Monday digest is enabled for Production.** The
      cron is configured in `vercel.json` as `0 12 * * 1` (Mondays, 12:00
      UTC) hitting `/api/weekly-scan`. Vercel Cron only runs against
      Production deployments, so whether it is actually firing depends on
      the currently promoted Production deployment, which this session
      cannot verify — check the Vercel dashboard's Cron tab directly before
      telling a customer to expect a Monday email.
- [ ] **Run a real signup → login → dashboard → upload smoke test** against
      Production using a disposable test account. Confirm a CSV upload
      completes and at least one account appears on the dashboard.
- [ ] **Confirm `/pricing.html`, `/privacy.html`, and `/terms.html` are
      live and current.**
- [ ] **Confirm `/contact.html` (the support/feedback route) is live.**
      `FEEDBACK_TO_EMAIL` and `ADMIN_EMAIL` are the addresses that receive
      contact-form/feedback submissions — confirm they're addresses you
      actually monitor.

## Manual beta billing process

There is no billing provider (Stripe or otherwise) wired into this
codebase. Plan state lives entirely on `ha_organizations` and is changed
either by the organization owner through Settings, or manually by you
directly against Supabase. Beta billing is a manual, out-of-band process
layered on top of these real fields:

**Relevant `ha_organizations` fields** (see `api/settings.js`):
- `plan` — one of `free`, `solo`, `team`, `enterprise`. `solo` grants a
  1-seat allowance, `team` a 25-seat allowance, `enterprise` unlimited
  seats (`seat_limit: null`).
- `subscription_status` — one of `inactive`, `trialing`, `active`, `paid`,
  `manual`. `active`, `paid`, and `manual` are all treated as
  "paid and unlimited" by `entitlement()`.
- `trial_status` — `inactive` or `active`.
- `trial_started_at`, `trial_end`, `trial_used` — the built-in 30-day
  self-service trial. `trial_used` is a one-time flag; once a trial has
  been consumed, `planPatch()` refuses to grant a second trial for that
  organization ("Your 30-day trial has already been used.").
- `seat_limit` — numeric or `null` (unlimited).

**To manually put a beta customer on a paid plan today:**
1. Have the customer sign up normally (creates their `ha_organizations`
   row with `plan: 'free'`).
2. Collect payment out-of-band (invoice, ACH, whatever you've agreed with
   the customer — there is no in-app payment flow to use instead).
3. Update that organization's row directly (Supabase SQL editor or a
   PATCH to `/api/settings` as an authenticated owner) to set:
   - `plan` to `solo`, `team`, or `enterprise` per what they're paying for.
   - `subscription_status` to `manual` — this is the status value that
     exists specifically to represent "paid outside the app," and
     `entitlement()` already treats it as fully paid/unlimited.
   - `trial_status` to `inactive` and `trial_end` to `null`, so the UI
     doesn't show trial messaging to a customer who is actually paid.
4. Confirm via a real login as (or with) that customer that
   `GET /api/settings` now reports `paidActive: true` and
   `isLimitedPlan: false`.

There is no automated renewal, dunning, or downgrade. Revisit each beta
customer's `ha_organizations` row manually on whatever billing cadence you
agreed with them (e.g., monthly) and update `subscription_status` by hand
if they lapse.

**Owner-only enforcement:** `api/settings.js` only allows a user whose
`ha_users.app_role` is `owner` to call the `update-plan` self-service
action; every attempt is written to the audit log (`auditLog()` calls in
`api/settings.js`). Manual Supabase-side edits bypass this entirely, which
is expected for beta operator use — just be aware it will not show up in
that audit log.

## Known beta disclosures

Share these with every beta customer before or during onboarding — they
are honest limitations of the system as built today, not hypothetical:

- **Public research may honestly return no signal for a given account.**
  Research is a best-effort search across public web sources; a company
  with no recent public activity will correctly show zero verified
  signals. That is a true negative, not a broken feature.
- **Uploaded order/contact history materially improves what House
  Accounts can tell you.** Accounts with real purchase history (via CSV
  upload) unlock reorder/follow-up intelligence that public research alone
  cannot produce. Customers who only want public-signal research on
  prospect lists will see a thinner product than customers who upload real
  account history.
- **Weekly digest email availability depends on Production
  configuration** (`RESEND_API_KEY`/`RESEND_FROM_EMAIL` set, and the
  Vercel Cron actually enabled on the promoted Production deployment).
  Confirm this is actually live before promising a customer a Monday
  email.
- **Outcome tracking does not exist yet.** House Accounts surfaces
  opportunities and signals; it does not yet track whether a rep acted on
  one or what happened if they did. This is understood to be the next
  major product feature, not a beta gap you need to apologize for, but
  don't promise it either.
- **Beta includes founder-led onboarding and support.** There is no
  self-service billing, no in-app support chat, and no automated account
  recovery flow beyond what's described above. Every beta customer is
  supported directly by you via `/contact.html` or direct contact.

## Customer onboarding checklist

Run this for every new beta customer:

- [ ] **Account creation.** Customer signs up via `/signup.html` (or you
      create the account for them) with their real work email.
- [ ] **Organization/team setup.** Confirm their `ha_users.organization_id`
      is set and, if they have teammates, invite them (`accept-invite.html`
      flow) so usage/company-limit counting is correctly org-scoped rather
      than each teammate accidentally forming their own solo organization.
- [ ] **Customer/order export.** Walk them through exporting their
      customer/order history from their existing system (see
      `/export-guides/` pages) into the CSV format House Accounts expects.
- [ ] **First upload.** Have them upload that CSV via Add Customer Data
      and confirm accounts appear on the dashboard.
- [ ] **First research run.** Run research on at least one real account
      with them present, so they see what a signal (or an honest "no
      verified signals found") looks like before they're on their own.
- [ ] **Dashboard walkthrough.** Walk through Your Accounts, Recently
      Researched, and the weekly-priorities view together.
- [ ] **"Prepare for Call" walkthrough.** Show them the Prepare for Call
      flow on at least one account with a real signal or real order
      history, since this is the feature most directly tied to the value
      they're paying for.
- [ ] **Set support expectations.** Tell them how to reach you
      (`/contact.html`, or direct contact) and what response time to
      expect — there is no SLA infrastructure, so be explicit about what
      you're actually committing to.
