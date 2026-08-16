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
- [ ] **Verify `CRON_SECRET` is set.** `api/monitoring-scheduler.js`,
      `api/notification-scheduler.js`, and the weekly-monitoring path in
      `api/research-batch.js` all fail closed (503) without it — this is
      correct and required, not a bug to work around.
- [ ] **Verify `RESEND_API_KEY` and `ALERTS_FROM_EMAIL`.** Required for
      notification digest email and any transactional email to actually
      send.
- [ ] **Verify `QUEUE_MANAGED_ORGANIZATION_IDS` and
      `NOTIFICATION_ENABLED_ORGANIZATION_IDS`.** Both are fail-closed
      allowlists (empty = nobody is monitored/notified). Confirm they
      contain exactly the organizations you intend to be live in Production
      — an organization absent from `QUEUE_MANAGED_ORGANIZATION_IDS`
      receives no recurring monitoring at all; an organization absent from
      `NOTIFICATION_ENABLED_ORGANIZATION_IDS` is monitored but never
      emailed.
- [ ] **Confirm the monitoring and notification crons are enabled for
      Production.** `vercel.json` configures `/api/monitoring-scheduler` at
      `*/5 * * * *` and `/api/notification-scheduler` at `0 12 * * *`.
      Vercel Cron only runs against Production deployments, so whether they
      are actually firing depends on the currently promoted Production
      deployment, which this session cannot verify — check the Vercel
      dashboard's Cron tab directly before telling a customer to expect
      monitoring or email.
- [ ] **Run a real signup → login → dashboard → upload smoke test** against
      Production using a disposable test account. Confirm a CSV upload
      completes and at least one account appears on the dashboard.
- [ ] **Confirm `/pricing.html`, `/privacy.html`, and `/terms.html` are
      live and current.**
- [ ] **Confirm `/contact.html` (the support/feedback route) is live.**
      `FEEDBACK_TO_EMAIL` and `ADMIN_EMAIL` are the addresses that receive
      contact-form/feedback submissions — confirm they're addresses you
      actually monitor.

## Billing: Stripe Checkout (capacity bands)

As of the pricing/checkout sprint, House Accounts has a real self-serve
paid path: `pricing.html`'s slider → `POST /api/create-checkout-session`
→ Stripe-hosted Checkout → `POST /api/stripe-webhook` writes the result
back onto `ha_organizations`. Pricing is per monitored-account capacity
band only — see `pricing-bands.js` for the one canonical band list (same
prices, same bands, used by the page, checkout, and the webhook). There
are no feature tiers; every band unlocks the same product, just at a
different monitored-account ceiling. Each band is its own Stripe Product
(one Product, one recurring Price, per band) — see the live-catalog note
under "One-time manual Stripe dashboard setup" below for why.

**Required environment variables (Production):**
- `STRIPE_SECRET_KEY` — the account's secret API key.
- `STRIPE_WEBHOOK_SECRET` — the signing secret for the webhook endpoint
  below.
- `STRIPE_PRICE_ID_100`, `STRIPE_PRICE_ID_250`, `STRIPE_PRICE_ID_500`,
  `STRIPE_PRICE_ID_750`, `STRIPE_PRICE_ID_1000`, `STRIPE_PRICE_ID_1500`,
  `STRIPE_PRICE_ID_2500` — one recurring monthly Stripe Price ID per paid
  band (see `pricing-bands.js` for the band→amount mapping this must
  match). Free has no Price ID (no Stripe call at all); Enterprise is a
  contact-sales state, also no Price ID.

**One-time manual Stripe dashboard setup:**
1. Create **seven separate Stripe Products**, one per capacity band (e.g.
   "House Accounts — Up to 100 accounts" ... "House Accounts — Up to
   2,500 accounts"). One Product per band is required, not optional: the
   Stripe Customer Portal rejects adding a second Price to its
   plan-switching list when two Prices share the same Product + billing
   interval + currency ("This pricing plan can't be added"), so a single
   shared Product cannot support Portal-driven upgrade/downgrade across
   bands. (An earlier version of this doc had all seven Prices under one
   shared Product; that structure hit exactly this Portal limitation and
   was migrated away from.)
2. Under each Product, create exactly one recurring **monthly** Price
   matching that band's amount in `pricing-bands.js` exactly, and set each
   Price ID into its `STRIPE_PRICE_ID_*` variable above. Nothing in this
   codebase reads or stores a Stripe Product ID anywhere — `pricing-bands.js`,
   `api/create-checkout-session.js`, and `api/stripe-webhook.js` all resolve
   everything from the Price ID alone, so which Product a Price lives under
   has no effect on checkout, entitlement, or webhook handling.
3. Add a webhook endpoint pointed at `https://<domain>/api/stripe-webhook`,
   subscribed to `checkout.session.completed`,
   `customer.subscription.updated`, and `customer.subscription.deleted`
   (the only three events this codebase understands). Copy the generated
   signing secret into `STRIPE_WEBHOOK_SECRET`.
4. In the Stripe Dashboard's Customer Portal settings, add all seven
   per-band Prices to the "Products customers can switch to" list, with
   plan switching enabled and prorations enabled. Leave quantity changes
   disabled — capacity is selected by choosing a band/Price, not by
   changing a Price's quantity. Set `trial_update_behavior` to
   `continue_trial` so a Portal-driven plan change never resets an
   in-progress grandfathered legacy trial.
5. Do all of the above in **test mode** first and run a real test-mode
   checkout before switching any of these variables to live-mode values.

**What the webhook does and does not do:** it keeps
`subscription_status`, `stripe_price_id`, and `account_capacity` in sync
with what Stripe reports — nothing more. There is no automatic
band-crossing upgrade, no proration, no grace period, and no
dunning/retry handling. A canceled subscription (`customer.subscription.
deleted`) simply flips `subscription_status` to `canceled`; the unified
entitlement logic (`api/lib/entitlement.js`) then falls back to Free (or
to an active Beta trial still in its window, if one applies) on its own —
nothing separately resets `account_capacity` or `plan`.

**Legacy manual billing still exists** for anything Stripe shouldn't
handle (e.g. a hand-negotiated Enterprise deal). Plan state still lives on
`ha_organizations` and can still be set directly:
- `plan` — one of `free`, `solo`, `team`, `enterprise`, `paid`. `paid` is
  what a real Stripe Checkout sets; `solo`/`team`/`enterprise` are legacy
  values, still valid but no longer reachable through self-service.
- `subscription_status` — `inactive`, `trialing`, `active`, `paid`,
  `manual`, `canceled`, or a raw Stripe subscription status string written
  by the webhook (e.g. `past_due`). `active`, `paid`, and `manual` are all
  treated as "paid" by `entitlement()`.
- `account_capacity` — numeric or `null` (unlimited). This is what
  `entitlement()` actually enforces for a paid/manual org; set it directly
  when manually granting access (e.g. `null` for a hand-negotiated
  Enterprise deal, or a specific number to match what was agreed).
- `seat_limit` — legacy column, no longer enforced anywhere. Every
  organization has unlimited users/seats regardless of plan or capacity.

**To manually put a beta customer on a paid plan without Stripe:**
1. Have the customer sign up normally (creates their `ha_organizations`
   row with `plan: 'free'`).
2. Collect payment out-of-band.
3. Update that organization's row directly (Supabase SQL editor, or a
   PATCH to `/api/settings` for a plan value — `/api/settings` only
   accepts `free` self-service now, so a non-free manual grant must be a
   direct Supabase edit) to set `plan` (`enterprise` or `paid`),
   `subscription_status` to `manual`, and `account_capacity` to the
   agreed number of monitored accounts (or `null` for unlimited).
4. Confirm via a real login that `GET /api/settings` now reports
   `paidActive: true` and `isLimitedPlan: false`.

**No new 30-day trials are granted going forward** — Free (up to 10
monitored accounts, no credit card) is the only no-payment entry point
now. Existing Beta organizations already mid-trial keep their promised
access until their existing `trial_end` (nothing was changed about
already-active trials); once that trial ends, they fall back to Free
unless they have a real paid/manual subscription by then.

**Owner-only enforcement:** `api/settings.js` only allows a user whose
`ha_users.app_role` is `owner` to call the `update-plan` self-service
action or start Stripe Checkout (`api/create-checkout-session.js`); every
`update-plan` attempt is written to the audit log (`auditLog()` calls in
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
- **Notification email availability depends on Production configuration**
  (`RESEND_API_KEY`/`ALERTS_FROM_EMAIL` set, both allowlists populated with
  the customer's organization, and the Vercel Cron actually enabled on the
  promoted Production deployment). Confirm this is actually live before
  promising a customer proactive email — a customer's own
  `notification_preference` (daily/weekly/in_app_only, set in Settings)
  also governs whether and how often they receive email at all.
- **Outcome tracking exists.** House Accounts prompts a rep to report what
  happened after an outreach (via the dashboard's unresolved-outreach
  panel and the "Tell us how it went →" link in notification email), and
  terminal outcomes stop further auto-prompting for that outreach. This
  captured outcome evidence does not yet change recommendations or ranking
  — that's Behavioral Learning, a separate, not-yet-started feature.
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
