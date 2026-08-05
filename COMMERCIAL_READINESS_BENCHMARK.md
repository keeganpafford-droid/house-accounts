# Commercial-Readiness Benchmark Procedure & Pricing-Model Template

Status: **procedure and template only — no benchmark has been run, no pricing
decision has been made.** Every numeric field below is a placeholder to be
filled in from a real measured run using the tooling this document points to.
Per the task constraints this branch was built under: do not fill assumptions
with invented numbers when measurement is unavailable — the "TBD (run
benchmark)" placeholders are intentional and should not be replaced with
guesses.

This document does not recommend final pricing limits. It defines how to
produce the numbers a pricing decision would need.

## 1. What this measures, and what it does not

The provider-usage instrumentation shipped in this branch (`api/research-batch.js`'s
`[research-batch.provider-usage]` structured log line, aggregated by
`scripts/aggregate-provider-usage.js`, priced by `scripts/provider-pricing.js`)
measures cost and reliability at the **research-batch invocation** level —
OpenAI tokens, Serper queries, Firecrawl requests, elapsed time, and how many
of the requested accounts actually produced a signal. It does not measure
signal *quality* (see `scripts/run-signal-benchmark.js` for the separate,
offline, deterministic classification/dedup accuracy benchmark — a different
concern from cost).

## 2. Controlled benchmark procedure (10 / 25 / 50 accounts)

Run this procedure three times, once per account-count tier, against
**Preview**, never Production, and only after explicit approval to run
providers for this purpose (this branch does not run providers on its own).

### 2.1 Setup (once per tier)

1. Assemble a real-shaped account list of exactly 10, then 25, then 50
   accounts, using the same CSV columns validated in
   `scripts/fixtures/repeat-order-follow-up-fixture.csv` (real company names
   are fine; this is a controlled internal benchmark, not a customer-facing
   test). Vary industries and order-history shapes so the tier isn't
   artificially easy or hard for the research pipeline.
2. Upload the list in Preview and let it reach a normal `/api/research-batch`
   invocation (either the standard "Research Top Accounts" flow or a direct
   authenticated call) — do not call research-batch with a hand-crafted
   payload that bypasses the real upload/claim/attempt lifecycle; the point
   is to measure what a real customer run actually costs.
3. Capture the Vercel function logs for that invocation window (`vercel logs
   --output raw <preview-deployment> --since <start> --until <end>`, or the
   equivalent from the Vercel dashboard's Logs tab).

### 2.2 Run

4. Trigger the research run for the full account list (10, then repeat setup
   for 25, then repeat for 50 — three independent runs, not one cumulative
   run, so each tier's numbers are self-contained).
5. Let it run to completion (all chunks/accounts attempted, not cancelled
   early).

### 2.3 Collect

6. Export the captured logs and run:
   ```
   node scripts/aggregate-provider-usage.js path/to/exported-logs.txt
   ```
   This prints, per the format already implemented in
   `scripts/aggregate-provider-usage.js`:
   - provider usage (OpenAI calls/tokens, Serper queries, Firecrawl requests) —
     **provider usage**
   - `totals.totalCostUsd` — **estimated cost**, using the configurable
     `PROVIDER_PRICING` in `scripts/provider-pricing.js` (update those
     per-unit prices first if actual contracted provider rates differ from
     the placeholder defaults there)
   - `totals.accountsWithSignals` — **successful accounts**
   - `totals.accountsWithNoSignals` — **failed / non-actionable accounts**
   - `totals.signalsProduced` — **signals produced**
   - `totals.elapsedMs` — **runtime**
   - `costPerResearchedAccount` — **cost per researched account**
   - `costPerActionableSignal` — **cost per actionable signal**
7. Record all eight figures below for each tier. Do not average across tiers
   or extrapolate a tier you did not actually run — each row must come from
   its own real invocation.

### 2.4 Results table (fill in from real runs — every cell starts as TBD)

| Metric | 10 accounts | 25 accounts | 50 accounts |
|---|---|---|---|
| Accounts attempted | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| Accounts with signals (successful) | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| Accounts with no signals (failed/non-actionable) | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| Signals produced | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| Runtime (elapsed ms) | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| OpenAI tokens (input + output) | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| Serper queries | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| Firecrawl requests | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| Total estimated provider cost | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| Cost per researched account | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |
| Cost per actionable signal | TBD (run benchmark) | TBD (run benchmark) | TBD (run benchmark) |

### 2.5 What to watch for across tiers

- Whether cost per account is roughly flat across 10/25/50 (expected, since
  research-batch chunks accounts rather than doing anything list-size-aware)
  or grows non-linearly (would indicate a scaling problem worth
  investigating before setting any plan's account limit).
- Whether accounts-with-no-signals as a fraction of accounts-attempted stays
  stable across tiers — a rising failure rate at larger tiers would suggest a
  timeout/rate-limit issue rather than a pricing issue.

## 3. Pricing-model template

Fill in every `TBD` cell from Section 2's real measurements before using this
for a pricing decision. Nothing here is a recommendation.

| | Free | Solo — $99/month | Team — $299/month |
|---|---|---|---|
| Monitored accounts (limit) | TBD (product decision, not a measurement) | TBD (product decision, not a measurement) | TBD (product decision, not a measurement) |
| Typical monthly usage (accounts researched) | TBD (needs real beta usage data) | TBD (needs real beta usage data) | TBD (needs real beta usage data) |
| Typical monthly provider cost (typical usage × cost-per-account from §2.4) | TBD | TBD | TBD |
| Heavy monthly usage (accounts researched, high end) | TBD (needs real beta usage data) | TBD (needs real beta usage data) | TBD (needs real beta usage data) |
| Heavy monthly provider cost | TBD | TBD | TBD |
| Manual "Research Again" usage (typical re-research events/month/account) | TBD (needs real beta usage data) | TBD (needs real beta usage data) | TBD (needs real beta usage data) |
| Automated weekly-monitoring cadence | Not available on this tier (product decision) | TBD (product decision — e.g. weekly, per `api/weekly-scan.js`'s current one-run-per-upload-per-invocation model; cron is not enabled in this branch) | TBD (product decision) |
| Monthly provider cost at typical usage + monitoring cadence | TBD | TBD | TBD |
| Target gross margin | N/A (no revenue) | TBD (business decision — not derivable from usage data alone) | TBD (business decision — not derivable from usage data alone) |
| Implied cost ceiling at target margin ($99 or $299 × (1 − target margin)) | N/A | TBD (once target margin is set) | TBD (once target margin is set) |

### 3.1 How "automated monitoring cadence" affects the model

The scheduled cron for weekly monitoring is explicitly **not enabled** in
this branch (see the standing constraint at the top of this task). Any
monitoring-cadence cost projection in the table above is therefore
necessarily hypothetical until cron is enabled in a controlled way and at
least one real weekly-scan cost is measured the same way as Section 2
(the same `[research-batch.provider-usage]` log line is emitted by
`api/weekly-scan.js`'s internal calls to `/api/research-batch`, so
`scripts/aggregate-provider-usage.js` works unchanged against weekly-scan
logs — no separate tooling is needed once cron is turned on for a
controlled test).

### 3.2 Known unknowns this template does not resolve

- **Typical vs. heavy usage** requires real beta customer behavior, not a
  synthetic benchmark — Section 2's benchmark measures *cost per account*,
  not *how many accounts a typical Solo customer researches per month*. That
  number can only come from actual beta usage once Preview is live with
  real users.
- **Target gross margin** is a business decision (competitive positioning,
  runway, provider contract terms), not something derivable from usage
  data. This template intentionally leaves it blank rather than picking a
  number.
- **Monitored-account limits** per tier are explicitly out of scope for this
  branch (per "Do not build billing," "no guessed monitored-account
  limits" in the task's exclusion list) — the blank cells above are
  deliberate, not an oversight.
