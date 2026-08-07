# Research Runtime Benchmark Spike — Engineering Report

Branch: `scale/research-runtime-benchmark`. This is a measurement/architecture
spike, not an implementation. Nothing in this document changes production
behavior; no code outside this file and `scripts/benchmark-research-batch-mechanics.js`
(plus one `package.json` script entry) was touched. This is the decision
checkpoint the spike was scoped to produce, per the task's own instructions —
no whole-list orchestration is built here.

**Headline finding, stated up front:** this repo has no real-provider runtime
data for any chunk size, ever (`COMMERCIAL_READINESS_BENCHMARK.md` says so
explicitly). This sandbox has no OpenAI/Firecrawl/Serper credentials, no
`APP_BASE_URL`, no dev/start server, and no Preview/Production access —
confirmed by inspection, not assumed. Generating real provider traffic from
here is not possible, so per the task's own cost/external-call guardrail,
**this report stops short of a measured-safe chunk size** and instead hands
back the exact bounded procedure to run it (§3.2). Everything else below —
architecture, bottlenecks, persistence/failure semantics, and the
recommended MVP shape — is derived from reading the real, current code, not
from guessing.

---

## 1. Current runtime architecture

`api/research-batch.js` (`handler`, `:2263`) is a single Vercel serverless
function, `maxDuration: 58` (`vercel.json:9-16`), invoked once per HTTP
request. One request can carry 1 to `RESEARCH_BATCH_MAX_ACCOUNTS` (default
250, hard ceiling 500, `:2507`) accounts. Within one request:

1. **Auth/lease housekeeping** (once per request): resolve upload owner if
   `uploadId` is present, heartbeat-gate the current research-run attempt,
   start a 45s-interval background lease-renewal loop for the request's
   duration, check for cross-upload duplicate-company collisions.
2. **Candidate discovery — per account, worker-pool parallel.** A hand-rolled
   `mapLimit()` (`:536-548`) runs `discoverCandidatesForAccounts()` across
   accounts with concurrency `min(max(1, RESEARCH_ACCOUNT_CONCURRENCY), 8)`
   (default 4, `:577`). Inside each account's worker: up to
   `RESEARCH_QUERIES_PER_ACCOUNT` queries (default 10–12, clamped 6–18,
   `:588`) fired **fully in parallel** via `Promise.all` (`:590`) — one
   Serper call per query, no timeout, no retry (`serperSearch()` `:361-409`).
3. **Firecrawl enrichment — once per request, not per account.**
   `enrichCandidatesWithFirecrawl()` (`:152-180`) runs after discovery
   finishes for the whole candidate pool, `mapLimit` concurrency 8, capped
   globally at 100 scrapes and 6 per account.
4. **Signal synthesis — ONE OpenAI call for the entire batch, not per
   account.** All account context and up to 180 ranked candidates are
   serialized into a single prompt and sent as a single
   `POST https://api.openai.com/v1/responses` call (`callOpenAIJson`,
   `:720-734`, invoked `:2721`). No timeout, no retry. `!resp.ok` throws
   (`:731`); the caller logs usage and **re-throws** (`:2727-2730`).
5. **Response.** One JSON object per request: `signals[]`, `byAccount{}`,
   `providerUsage{}`, `diagnostics{elapsedMs, structuredSummary{...}}` — a
   real per-account breakdown, but only inside a *successful* response.

The dashboard drives this from two different client functions with two
different levels of built-in safety:

- **`researchTopAccounts()`** (`dashboard/index.html:6804-6972`, the main
  "Research Top Accounts" button) already caps its input client-side —
  `getAccountsForResearch()` (`:6607-6620`) sends at most 25 accounts, or 50
  for a pure lead-gen list with no order history — in **one**
  `/api/research-batch` call, then falls back to a 4-way concurrent
  per-account loop against `/api/research-account` only if that one call
  fails or returns zero signals entirely.
- **`researchListFromManageModal()`** (`:6262-6430`, "Research Entire List" /
  "Research Entire List Again" in the paginated Manage Customer Accounts
  modal) has **no cap at all** — every active, non-duplicate, warm/mixed
  account in the list goes into **one** `/api/research-batch` call,
  regardless of list size. For a 1,000-account list this is exactly the
  function that would send ~1,000 accounts in a single request against a
  58s ceiling. **This is the function whole-list orchestration needs to
  replace with chunked calls** — not `researchTopAccounts()`, which already
  self-limits.

Persistence is entirely separate from research-batch.js — see §9.

## 2. Primary runtime bottlenecks

In order of how directly they threaten the 58s ceiling:

1. **The single whole-batch OpenAI synthesis call is the dominant, least
   controllable cost, and it is all-or-nothing.** It has no timeout and no
   retry; if it is slow or fails, the *entire* request's signals are lost —
   not just the slow account's. Larger chunk size directly enlarges (a) this
   call's blast radius and (b) its input size (see §4's mechanics data: at
   n=250 the prompt is already ~180K tokens estimated).
2. **Discovery-stage wall-clock scales with `ceil(N / concurrency)`, not
   with N directly** — concurrency is fixed at 4 by default regardless of
   chunk size, so a larger chunk doesn't get more parallelism, it gets more
   sequential *waves* of the same per-account discovery cost. This is the
   most linear, most predictable part of the pipeline, and the main lever
   chunk size actually controls.
3. **No soft-timeout/time-budget guard exists inside `api/research-batch.js`
   at all** — confirmed absent by inspection. `api/weekly-scan.js` has one
   (`computeDeadline()`, checked before every chunk, `:717-722`); this file
   has nothing analogous. Whatever chunk size is chosen, the function relies
   entirely on the Vercel platform's hard kill at 58s with zero chance to
   respond gracefully first.
4. **Firecrawl enrichment and per-account candidate ranking are bounded
   (concurrency 8, global cap 100 scrapes, 30 candidates/account pre-cap)**
   — these are not where risk concentrates as N grows.
5. **The historical-account path (`/api/research-account`, one account at a
   time, sequential `for` loop in `researchListFromManageModal()`,
   `:6368-6395`) has no client-side time budget either.** A list with a
   large *historical* (non-warm) fraction accumulates unbounded sequential
   wall-clock with nothing watching the clock — a separate, smaller risk
   from the main batch-call risk, worth noting but out of this spike's
   primary scope (historical accounts don't currently go through
   `/api/research-batch` at all).

## 3. Benchmark methodology

### 3.1 What was actually run here: a mechanics-only mocked sweep

`scripts/benchmark-research-batch-mechanics.js` (new, committed this round;
`npm run benchmark:research-batch-mechanics`) drives the **real, unmodified
`handler` export from `api/research-batch.js`** (same pattern as the
existing `scripts/test-provider-usage-instrumentation.js`) across account
counts `1, 3, 5, 8, 10, 15, 20, 25, 50, 100, 150, 250`, with every outbound
`fetch()` (Serper, Firecrawl, OpenAI) mocked to resolve with realistic
*shapes* but **zero injected latency**. Workload is mixed across three
payload-richness classes (rich/ordinary/sparse — varying contacts, notes,
website, order history) cycled through the batch, since a mock cannot
honestly vary real search difficulty, only payload shape.

**This measures exactly one thing honestly: the pipeline's own code-driven
scaling** — outbound call fan-out counts, prompt size growth, response
payload size, and CPU-bound wall-clock (JSON building, regex scoring,
dedup/clustering, `mapLimit` scheduling) — independent of real network
latency. It does **not**, and cannot, measure real wall-clock duration,
real p90 latency, or a production-safe chunk size in absolute seconds. Every
mocked call returns in ~0ms; real provider calls do not. This limitation is
by design (per the task's own instruction not to manufacture runtime
conclusions from mocks) and is restated at the top of the script and in its
own output.

### 3.2 What was NOT run, and the exact bounded procedure to run it

Real-provider benchmarking — the only way to get an actual p90/wall-clock
answer — was **not attempted**, for concrete, verified reasons, not caution
for its own sake:

- This sandbox has no `OPENAI_API_KEY`, `SERPER_API_KEY`, `FIRECRAWL_API_KEY`,
  or `SUPABASE_SERVICE_ROLE_KEY` set (checked directly — none present).
- There is no dev/start script (`package.json` has none) and no
  `APP_BASE_URL` configured — `scripts/run-live-research.js`, the repo's own
  real-provider-calling tool, requires a reachable running server and would
  have nowhere to send its request from here.
- This sandbox has no Vercel Preview or Production access.
- The repo's own established procedure for this exact measurement,
  `COMMERCIAL_READINESS_BENCHMARK.md`, explicitly requires running **against
  Preview only, never Production, only after explicit approval to run
  providers for this purpose** — a human/product decision this sandbox
  cannot make on its own even if it had credentials.

This is precisely the task's own stop condition: *"If the benchmark would
create material external spend, require Production access you do not have
... STOP before those calls and give me the exact bounded benchmark
procedure I should run."* Here it is, adapted from
`COMMERCIAL_READINESS_BENCHMARK.md` (already written, already in the repo,
never executed) and narrowed to runtime rather than cost:

1. In Preview (never Production), assemble three real-shaped account lists
   at your candidate chunk sizes — start with the smallest few of `1, 3, 5,
   8, 10, 15, 20` rather than all seven, to bound cost — each list mixing an
   easy/well-known company, an ordinary small/midsize business, and a
   sparse/difficult one (per the task's own workload-class guidance).
2. Trigger each list through the **real** `researchListFromManageModal()`
   path (upload → Manage Customer Accounts → Research Entire List), not a
   hand-crafted payload — this is what makes the measurement represent a
   real customer run.
3. Capture Vercel function logs for each invocation window (`vercel logs
   --output raw <preview-deployment> --since <start> --until <end>`).
4. Record, per tier: wall-clock (the log timestamp span, and/or
   `diagnostics.elapsedMs` from the response), `structuredSummary`'s
   attempted/processed/failed counts, and run
   `node scripts/aggregate-provider-usage.js path/to/exported-logs.txt` for
   the provider-usage/cost side (already-built tooling, zero new code
   needed).
5. Repeat at the next tier only after recording the first — three
   independent runs, not one cumulative run, exactly as
   `COMMERCIAL_READINESS_BENCHMARK.md §2.2` already specifies.
6. Estimated cost at the existing measured baseline (`$0.1316 / 8 attempted
   accounts` ≈ `$0.01645/account`): a 1+3+5+8+10 sweep (27 accounts total)
   would cost roughly **$0.44**; extending through 15 and 20 as well (62
   accounts total) roughly **$1.02**. Small enough that cost is not the
   real gate here — Preview/provider access is.

**Bottom line: I need your (or someone with Preview access's) go-ahead and
credentials to actually run §3.2. I did not fabricate numbers in its place.**

## 4. Results

### 4.1 Mechanics-only sweep (real code, zero-latency mocks)

| N | wall-clock (ms, mocked) | Serper calls | Firecrawl calls | OpenAI calls | Prompt size (chars / est. tokens) | Response bytes |
|---|---|---|---|---|---|---|
| 1 | 77 | 12 | 6 | 1 | 40,957 / 10,239 | 5,974 |
| 3 | 39 | 36 | 12 | 1 | 74,940 / 18,735 | 13,213 |
| 5 | 81 | 60 | 24 | 1 | 142,522 / 35,631 | 22,118 |
| 8 | 64 | 96 | 36 | 1 | 210,546 / 52,637 | 33,334 |
| 10 | 76 | 120 | 42 | 1 | 245,029 / 61,257 | 39,860 |
| 15 | 176 | 180 | 60 | 1 | 347,249 / 86,812 | 56,806 |
| 20 | 127 | 240 | 84 | 1 | 483,137 / 120,784 | 74,741 |
| 25 | 167 | 300 | 100 | 1 | 571,339 / 142,835 | 91,660 |
| 50 | 410 | 600 | 100 | 1 | 588,030 / 147,008 | 178,316 |
| 100 | 507 | 1,200 | 100 | 1 | 621,789 / 155,447 | 350,602 |
| 150 | 712 | 1,800 | 100 | 1 | 655,233 / 163,808 | 524,050 |
| 250 | 1,193 | 3,000 | 100 | 1 | 723,189 / 180,797 | 871,953 |

Reproducible via `npm run benchmark:research-batch-mechanics`.

**What this actually shows, honestly:**

- **Serper call count is exactly linear in N** (12 calls/account at
  `RESEARCH_QUERIES_PER_ACCOUNT` default 12 for the warm-account deep-search
  path) — confirms §2's architectural read directly, in real executed code,
  not inference.
- **Firecrawl call count plateaus at exactly 100 once N is large enough** —
  the global cap (`enrichCandidatesWithFirecrawl(..., totalLimit=100)`)
  visibly takes over between N=20 and N=25 in this run.
- **OpenAI prompt size grows with N but tapers sharply** — 17.7× growth from
  n=1→250 against a 250× growth in N, because the candidate-context portion
  of the prompt caps at 180 items regardless of N while only the
  uncapped per-account metadata block (`accountPromptContext()`, `:550-570`,
  no `.slice()` at all) keeps growing linearly. Concretely: **the accounts
  themselves are cheap in prompt tokens; the candidate evidence is what
  dominates, and it's capped.**
- **Mechanics-only (zero-network) CPU wall-clock is small in absolute terms
  even at N=250 (~1.2s)** and grows sub-linearly relative to N (15.4× for a
  250× increase) — no evidence of a pathological O(N²) code path in the
  range tested. This rules out "the code itself blows up" as the runtime
  risk; the risk is entirely in real provider latency and the all-or-nothing
  synthesis call, neither of which this sweep can measure.

### 4.2 Real-provider results

None. Per §3.2, not run from this sandbox. `COMMERCIAL_READINESS_BENCHMARK.md`'s
results table remains 100% `TBD` — this spike did not change that, and could
not responsibly change that from here.

## 5. Slow-case / p90 finding

**There is no real p90 data, for any chunk size, anywhere in this repo's
history.** Averages don't exist either — nothing has ever been measured.
Stating a p90 number here would be exactly the "manufactured benchmark
conclusion" the task explicitly prohibits. What can be said with real
grounding:

- The **single biggest slow-case risk is the whole-batch OpenAI synthesis
  call** — it has no timeout, so its own tail latency (OpenAI having a slow
  moment, a large prompt taking longer to process) is completely
  unbounded from this code's perspective, and a slow-but-not-infinite
  response there consumes 58s-ceiling budget with nothing watching the
  clock.
- The **discovery stage's slow-case is dominated by whichever single
  account in the current concurrency-4 wave is slowest** — `Promise.all`
  per account's queries means one query hanging drags that entire wave;
  `mapLimit`'s per-item try/catch means it degrades to `null` for that
  account rather than throwing, so a hung/slow account does not by itself
  crash the batch, but it does hold up that wave's completion, and if
  `Promise.all` genuinely never resolves (a fetch with no timeout, against
  a non-responsive endpoint), that wave never advances at all.
- Real p90 chunk-size safety requires §3.2's actual measurement. This
  report should not be read as substituting for that.

## 6. Recommended initial chunk size

**8 accounts per chunk**, as a provisional MVP starting point — not a
measured-safe value; explicitly a starting hypothesis to validate against
§3.2's real data before treating it as a real default.

Reasoning, all grounded in §1/§2/§4, not guesswork:

- At the default discovery concurrency of 4, 8 accounts = exactly **2 clean
  concurrency waves** — small, predictable, easy to reason about.
- It's the midpoint of the task's own candidate list (`1, 3, 5, 8, 10, 15,
  20`), landing before the range where the mechanics sweep shows Firecrawl
  fan-out approaching its global cap (which starts mattering at N≈20-25) —
  staying comfortably inside the "each account still gets its full
  per-account Firecrawl allowance" zone rather than the "accounts start
  competing for a capped shared pool" zone.
- It keeps the single all-or-nothing OpenAI call's blast radius to 8
  accounts' worth of lost work per failure, not 25-50 (today's *implicit*,
  never-measured ceiling from `getAccountsForResearch()`) and nowhere near
  250 (the server's default clamp).
- It is close enough to today's already-shipping, already-running-in-
  production 25-account "Research Top Accounts" batch call that it is not a
  radical behavioral jump — it is smaller and therefore strictly
  lower-risk than what already runs today, not an unprecedented size.

## 7. Safety margin

No real per-account discovery latency is measured, so this margin is
structural/architectural, not a computed number of seconds:

- 8 accounts ÷ concurrency 4 = 2 sequential discovery waves. Even a
  pessimistic real-world per-wave time (network-bound Serper calls under
  load, cold starts, provider slowness) would need to average roughly
  **~17.5s per wave** to consume the user's own 35s internal target, or
  **~29s per wave** to approach the 58s hard ceiling — both far above what
  a handful of parallel search-API calls plus scoring should normally take,
  giving real headroom for the slow-case factors the task lists (slower
  providers, network variance, cold starts, unusual accounts) without
  requiring a single number to be measured first.
- Firecrawl enrichment for 8 accounts (≤48 candidates eligible at
  perAccountLimit=6) sits nowhere near the 100-scrape global cap, so it
  runs at its own concurrency-8 pace without contention from other
  accounts in the same or a different concurrent chunk.
- The OpenAI synthesis prompt at N=8 is ~52,637 tokens estimated (§4.1) —
  well under typical context-window ceilings, and the smallest practical
  chunk size that still meaningfully amortizes the fixed per-request
  overhead (auth, duplicate-check, heartbeat) across more than a couple of
  accounts.
- This margin is a hypothesis, sized to be conservative *given the
  unknowns*, not a substitute for §3.2.

## 8. Adaptive-sizing recommendation

Build the smallest thing that's actually justified by what's known, not
everything that sounds useful:

- **Shrink after a slow/failed chunk: yes, build this.** It's cheap
  (client already receives `diagnostics.elapsedMs`) and directly answers a
  real, known risk (the unbounded synthesis call). Simple rule: if a
  chunk's server-reported `elapsedMs` exceeds a threshold (e.g. 30s, near
  the user's own 35s internal target) or the chunk's HTTP call fails
  outright, halve the next chunk's size (floor of 1, which is simply
  today's existing single-account path).
- **Grow after fast runs: not yet.** No data justifies it, and growing is
  strictly riskier than shrinking (a wrong grow enlarges the all-or-nothing
  blast radius; a wrong shrink only costs a bit of throughput). Revisit only
  after §3.2's real numbers exist.
- **Split/retry failed chunks: yes, this falls out of "shrink and retry"
  for free** — a failed chunk of 8 becomes two attempts of 4, or ultimately
  8 attempts of 1, using the exact same request shape each time.
- **Fall back to individual-account research: yes, and it already exists**
  — chunk size 1 through `/api/research-batch` (mode `warm-account`) is
  today's own single-account path; no new fallback code is needed, it's the
  floor of the same halving strategy.
- **Do not build:** exponential backoff curves, per-provider adaptive
  tuning, or persisted historical-latency-driven chunk sizing. All of that
  requires real latency data this spike could not collect; building it now
  would be tuning against nothing.

## 9. Persistence semantics

**Not yet safe for naive chunked-and-resumed use, in one specific,
well-understood way — and the safe path forward needs no schema change.**

What's already safe: whenever a full account-list snapshot is persisted
(via `replace_ha_accounts_snapshot()`/`persist_ha_research_output()`), the
established convention (used today by both `researchAccountFromManageModal()`
and `researchListFromManageModal()`) is to always pass the **complete**
current account list, not just the accounts just researched — because
`replace_ha_accounts_snapshot()` replaces the whole snapshot atomically.
Persisting more often (once per chunk instead of once per whole list) is
safe **as long as this same "always pass the full list" convention is kept**
— no accounts get silently wiped by a chunk-scoped save, because no save is
ever actually chunk-scoped at the persistence layer, only at the research
layer.

**The one real gap:** `persist_ha_research_output()` (migration 6) was
deliberately built so that *every successful call is the terminal action for
its attempt* — it finalizes the run (`status='completed'`) as part of the
same transaction, by design, because today it is only ever called once, at
the very end. A naive chunked loop calling it after every intermediate
chunk would mark the *entire* multi-chunk pass `completed` after chunk 1 —
which would then make `claim_ha_research_run()`'s "auto" guard (migration 5
§7, guard A) treat the whole upload as already-researched and block anything
else, silently truncating the list-level research pass to just its first
chunk.

**The minimal, zero-schema-change fix:** don't try to keep one continuous
research run alive across all chunks. Instead, generalize the pattern
`researchAccountFromManageModal()` already uses for one account — claim a
short-lived `manual-rerun`-style run, research, persist-and-finalize — to
one chunk of N accounts instead of one account. Each chunk becomes its own
independent claim → research → persist(full snapshot)-and-finalize cycle,
reusing `claimAutomaticResearchRun('manual-rerun', uploadId, chunkAccountNames)`
and `persist_ha_research_output()` exactly as they exist today, just called
once per chunk instead of once per account or once per whole list. Zero new
RPCs, zero new columns, zero migration.

**One narrow, known, and acceptable trade-off of that approach:** between
chunk K completing (its run row now `completed`) and chunk K+1 claiming a
new run, there's a brief window where the upload has no actively-`running`
row. A second browser tab clicking "Research Entire List Again" during that
exact window could start its own concurrent chunk sequence. This is not a
new risk this spike introduces — it's the same narrow gap the existing
per-account path already has between consecutive accounts today — and it's
partially mitigated by the existing duplicate-company collision check. If
closing it durably is ever judged necessary, the fix would be a small,
additive DB change (e.g. an optional `p_finalize` parameter on
`persist_ha_research_output()`, defaulting to `true`, so only the last
chunk's call actually finalizes). **Not proposing to build that now** — it
requires a migration, which per this spike's own boundary needs explicit
approval first, and there's no evidence yet that the narrow gap matters in
practice.

## 10. Failure semantics

**If `research-batch.js` itself is killed mid-request (hits the 58s
ceiling): zero rows land in `ha_signals`/`ha_accounts`.** Confirmed by
reading the file — it makes no writes to either table at all; its only DB
writes are `ha_research_runs` bookkeeping (claim/heartbeat/complete/fail).
A killed invocation leaves, at most, a stale lease that a later claim
reclaims — no partial account-level results survive, because none were ever
written mid-flight.

**If the whole request succeeds but the browser is closed/network drops
before the client's terminal `saveCurrentUpload()` call completes:** the
fetched signals, held only in browser memory, are also lost — nothing is
durable until that one RPC call lands.

**Under the chunked design recommended in §9:** a chunk that times out or
fails loses only that chunk's accounts' work (not the whole list), and every
already-completed chunk's work is already durably persisted (full-snapshot,
finalized) before the failing chunk even started — this is the entire point
of chunking from a failure-semantics perspective, and it requires the §9
per-chunk-claim change to actually deliver on it (without that change,
persistence still only happens once at the very end regardless of how many
chunks the *research* calls are split into).

## 11. Browser-orchestrated MVP viability

**Viable, and closer to the existing codebase's own patterns than a new
design would be.** `researchListFromManageModal()` already is a
browser-driven loop that claims a run, calls the server, and persists once
at the end; `researchTopAccounts()` already has a batch-then-fallback-loop
shape. The MVP is:

```
browser: pick next unresearched chunk (≤8 accounts, per §6)
  → claim a manual-rerun-style run scoped to that chunk (§9)
  → POST /api/research-batch for just that chunk
  → merge results into the full in-memory account list
  → persist the FULL list (finalizing this chunk's run)
  → repeat until every active account has been researched, or the user stops
```

This **requires the browser tab to stay open** — nothing server-side
advances to the next chunk; the client's own loop does. This report makes
no claim that the browser can be closed mid-pass, and none should be made
to users: closing the tab mid-pass simply stops the loop, leaving whatever
chunks already completed safely persisted (per §9/§10) and the rest
un-researched until the user reopens and resumes.

**One necessary addition for "resume" to mean anything real:** the chunk
selection logic must skip accounts already freshly researched *in this same
pass* (or generally, recently researched), not just paused/duplicate
accounts as it does today — otherwise reopening after an interruption just
re-researches everyone from scratch, and chunking would only have solved
the timeout-blast-radius problem, not the interruption-recovery problem the
user actually wants from resumability. This is an application-level
filter change (comparing `lastResearchedAt`/presence of `signals` against
the current pass), not a DB or architecture change.

## 12. Server-owned queue

**No evidence it's needed now.** Confirmed by inspection: no queue, worker
pool, or durable job infrastructure exists anywhere in this repo today (one
cron entry, `/api/weekly-scan`, which does its own in-process chunked HTTP
fan-out, not a queue). The browser-orchestrated chunk loop in §11 fully
covers the stated near-term need (research an entire large list, safely,
without the browser's tab needing to survive an unbounded single request)
without any server-side durable state beyond what `ha_research_runs`
already provides. Introducing a queue now would be solving a problem
("what if no browser is available to drive the loop") nobody has asked for
yet and this spike found no evidence for.

## 13. Database implications

**No migration, table, column, or index is needed to ship the §11 MVP.**
The per-chunk claim/persist pattern in §9 reuses `claim_ha_research_run()`
and `persist_ha_research_output()` exactly as they exist today, just called
more frequently with smaller account groups — both RPCs already handle this
correctly with zero changes. The one *possible* future addition —an
optional `p_finalize` parameter to close the narrow §9 concurrency gap — is
explicitly **not proposed for this round**; it would need its own
migration and explicit approval, and there's no evidence yet that the gap
it would close matters in practice. Nothing in this spike touched the
database, applied a migration, or should be read as recommending one now.

## 14. Recommended orchestration architecture

The smallest durable thing that closes the real gap (§1's unbounded
`researchListFromManageModal()` call) without over-building:

1. **Client-side chunking**, replacing `researchListFromManageModal()`'s
   single unbounded `/api/research-batch` call with a loop over chunks of
   (provisionally, pending §3.2) 8 accounts.
2. **Per-chunk claim/research/persist-and-finalize**, reusing the existing
   `manual-rerun` claim lifecycle and `persist_ha_research_output()`
   unchanged (§9) — zero new server code required for this piece.
3. **A simple shrink-on-slow/failure adaptive rule** (§8) — halve chunk
   size down to a floor of 1 on a slow or failed chunk; no growth logic yet.
4. **A "skip already-researched-this-pass" filter** (§11) added to chunk
   selection, so resuming after an interruption is actually meaningful.
5. **Optionally, a soft-timeout guard added to `api/research-batch.js`
   itself** (mirroring `api/weekly-scan.js`'s existing `computeDeadline()`
   pattern) — this is a genuine, low-risk, already-precedented
   architecture improvement independent of chunk size, but it is a change
   to `api/research-batch.js`'s production behavior, so per this spike's
   own boundaries it is a **recommendation for a future round, not
   something built here.**

None of this requires a queue, Redis, a new worker platform, or a database
migration.

## 15. What NOT to build yet

Explicitly, per the task's own boundaries and this spike's findings:

- No server-owned durable job queue (§12 — no evidence it's needed).
- No Redis, no new worker platform.
- No background/close-the-browser execution, and no claim that it works —
  the §11 MVP requires the tab to stay open; do not represent otherwise to
  users.
- No database migration (§13) — including the `p_finalize` idea from §9,
  which stays a documented-but-unbuilt option pending approval.
- No adaptive growth logic (§8) — only shrink-on-failure, until real
  latency data exists to justify anything more.
- No chunk-size default treated as final — 8 (§6) is a provisional starting
  hypothesis pending §3.2's real measurement, not a shipped constant to
  stop questioning.
- No changes to temporal-integrity rules, opportunity canonicalization,
  Conversation Starter policy, duplicate-company protections, or the
  dashboard's visual design — none of this spike's findings touch those
  systems, and none should be used to justify touching them.

---

## Appendix: environment/tooling notes from this spike

- `npm test` was run in full: **35/39 pass**; the 4 failures are all
  Playwright-based browser tests (`test-contact-success-panel-browser.js`,
  `test-help-dropdown-visibility.js`, `test-manage-accounts-pagination-client.js`,
  `test-whats-new-browser.js`) failing on `Cannot find package 'playwright'`
  — confirmed to be a pre-existing environment gap in this sandbox
  (`node_modules` has no installed devDependencies at all), not a regression
  from anything in this round. No dashboard/API production code was
  touched this round, so no test content changed.
- New files this round: `scripts/benchmark-research-batch-mechanics.js`
  (mechanics-only sweep tool, reusable for future rounds) and this report.
  One additive `package.json` script entry
  (`benchmark:research-batch-mechanics`). No other files changed.
