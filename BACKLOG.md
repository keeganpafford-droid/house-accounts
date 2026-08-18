# Backlog

Durable near-term items identified during active engineering work but deliberately not built in the sprint that surfaced them. Each entry should say what to build, why, and where the investigation that produced it lives.

Organized by how soon each item should be picked up, not by when it was written down. Explicit dependencies between items are called out inline — respect them; don't promote a dependent item ahead of what it depends on.

The current commercial path stays the anchor for prioritization: **existing customer intelligence → reason to reach out → opportunity/play → Prepare for Call → rep action → outcome**. Larger strategic bets (LATER) exist to eventually extend this path, not to compete with it for near-term attention.

---

## Recently completed (banked — not open work)

Noted here only so these are never rediscovered as gaps. No action needed.

### Notification & Outcome Loop V1 — COMPLETED / BANKED (2026-08-16)

Merged to `main` at `03bd7ee9679a5b37345dadeaa98d09b200eb4073` (merge commit, `feature/notification-outcome-loop-v1` → `main`), founder-approved after full Preview QA including a real live scheduler invocation matching its read-only preflight exactly (`notDue`/`emptyDigest`, zero unintended sends). Activation remains fail-closed — see the Production cutover note below.

**Banked capability:**
- Independent notification transport (`api/notification-scheduler.js`), structurally separate from the legacy Monday Brief (`api/weekly-scan.js`) — not a second implementation layered onto it.
- Daily / Weekly / In-app-only user preference, backed by `ha_users.notification_preference` and exposed in Settings (`settings.html`).
- No empty emails — `selectDigestContent()`'s `hasContent` gate means a digest with nothing new/eligible is never sent and never logged.
- Only a positively-confirmed transport success (a real, non-empty provider message id) ever advances the notification watermark or writes `status:'success'` — a skipped/ambiguous/failed send never does, and is logged honestly as `status:'failed'` with a real reason.
- Proactive "New Intelligence" content obeys the same centralized `classifyMonitoringSignalEligibility()`/`classifyLegacySignalActionability()` priority/secondary/hidden doctrine the dashboard and legacy digest already use — never a second, looser eligibility notion.
- Unresolved-outreach prompts begin around 5 days after `outreach_made`/`opportunity_outreach_made` (`INITIAL_PROMPT_DAYS`).
- `no_response_yet` is itself a real report, remains "still open," and becomes re-eligible for another automatic prompt roughly 7 days later (`NO_RESPONSE_RECHECK_DAYS`) — it is never silent absence of a report.
- `engaged`, `progressed`, and `went_nowhere` are terminal for *automatic* prompting only.
- `outcome_reported` is an append-only child of the specific `outreach_made`/`opportunity_outreach_made` event it reports on (via `parent_event_id`) — never deduped, multiple later updates are valid real history.
- The latest reported outcome is visible back on the account, next to the existing outreach state (`api/signal-events.js` read-back → the Prepare for Call outreach row), not just consumed and hidden.
- One-click dashboard outcome capture (the unresolved-outreach panel) with an explicit, persistent confirmation the rep must actively close — no auto-dismiss timer, no modal, no forced note.
- Contextual outreach deep link: a notification's "Tell us how it went →" link carries `?outreach=<outreachEventId>` and lands the rep on that exact dashboard row, scrolled into view with a strengthened, visually unmistakable highlight (colored border + ring + pulse) — proven distinguishable from otherwise-identical sibling rows. Reuses the existing `next=`-preserving auth-redirect flow; no new auth/session logic. The per-signal "View opportunity →" half was investigated and intentionally not built this sprint — see "Notification Deep Links / Actionable Re-entry" below.
- Intentional Gmail subject line (concise, count-based: "N accounts worth a look [+ M follow-ups]") and hidden preheader (dynamic per signal/follow-up counts), plus a CTA hierarchy where the contextual outreach action visually wins over the generic dashboard link whenever one exists.
- Established users are not blocked by first-time onboarding when re-entering via a notification on a new browser/device/origin — the automatic Beta-welcome popup now fires only once the server has confirmed a genuinely empty workspace, never merely because a session exists.
- Durable delivery history (`ha_notification_deliveries`) and fail-safe transport semantics (an isolated per-user Resend failure never blocks other users' sends; an unknown/failed send is logged, not silently dropped, and never advances the watermark).
- Activation was fail-closed at banking time — both `NOTIFICATION_ENABLED_ORGANIZATION_IDS` and `QUEUE_MANAGED_ORGANIZATION_IDS` were empty/unset in Production as of this merge. Both are now populated — see "Full Beta Monitoring + Notification Cutover" immediately below for the completed Production activation.

**Important limitation — preserve, do not overstate (updated 2026-08-17):** House Accounts captures durable behavioral evidence today (`ha_signal_events`: feedback, selections, outreach, approach notes, and now outcome reports). As of 2026-08-17, dashboard recommendation ranking consumes a first, bounded slice of this evidence — see "Behavioral Learning V1 — Dashboard Foundation" below. Notification ordering, account prioritization eligibility, and rep/org behavioral profiles still do not consume it. Do not claim broader behavioral learning than what is actually banked — see that entry for the precise shipped/not-shipped boundary.

- **Notification preferences UX** (Part A4): a simple Daily / Weekly / In-app only control lives in Settings, backed by `POST /api/settings` `action:'update-notification-preference'` and the existing `ha_users.notification_preference` field. No new settings architecture — reused the existing preference field/API pattern verbatim.
- **Notification deep link — unresolved outreach** (Part A3, CTA hierarchy strengthened in later live-QA rounds): see the banked capability list above for full detail.

### Full Beta Monitoring + Notification Cutover — COMPLETED / BANKED (2026-08-16)

Merged to `main` at `8bb8f3469fbf85bdf1d83808f16e895b7a9df593`, founder-approved after live Production proof of the full autonomous chain (not just Preview QA). Retires the legacy Monday-cron/Monday-Brief architecture entirely — `api/weekly-scan.js` and its weekly-scan-only tests/dev tooling are deleted from `main`; `vercel.json`'s single Monday cron is replaced by `/api/monitoring-scheduler` (`*/5 * * * *`) and `/api/notification-scheduler` (`0 12 * * *`). No parallel/fallback weekly architecture is retained.

**Production activation allowlist (both `QUEUE_MANAGED_ORGANIZATION_IDS` and `NOTIFICATION_ENABLED_ORGANIZATION_IDS`):** Keegan Test, GMG, PromoCentric, Sweet Grass Farm — the complete set of organizations with legitimate active monitored usage at cutover time. Phase1test (founder/internal test infra) and `audra.pafford@gmail.com` (retired legacy demo usage, no organization) were deliberately excluded; both keep their historical data untouched.

**Also banked in this cutover:** migration 23 (`supabase-schema-migration-23-monitoring-coverage-classification-restore.sql`), restoring `ha_monitoring_attempts.coverage_classification` persistence in `complete_ha_monitoring_attempt()` — a regression migration 20 silently introduced when it added `p_cooldown_hours` (copied the pre-migration-17 INSERT shape). Applied to and independently read-verified in Production; every migration-20 cooldown behavior is unchanged.

**Live autonomous Production proof (not manually invoked):** Vercel Cron's first natural `GET /api/monitoring-scheduler` firing (2026-08-16 23:20:41 UTC) published the one naturally-due target (Timberland, Sweet Grass Farm) — `dueActiveCount:13, queueManagedDueCount:1, publishedCount:1`. The Queue consumer autonomously claimed, researched, and completed it (`coverage:'complete'`, 2 signals discovered and persisted, ~$0.0247, capacity acquired/released normally, `queueAction:'ack'`). Two subsequent natural cron firings (~23:25, ~23:31 UTC) correctly found and published zero work. No Production runtime errors. This proves the complete chain end to end: Vercel Cron (GET) → monitoring scheduler → due-only/allowlist-gated selection → Queue publish → bounded worker → research → validated signal persistence → cadence advancement → Queue ack. The independent notification scheduler was separately proven in Production (empty-digest preflight matched exactly, zero unintended sends).

**Founder determination — do not reopen or further optimize this infrastructure absent a confirmed Production failure or meaningful scale evidence.** Queue monitoring + independent notification is the canonical Production architecture going forward; the legacy weekly architecture is not retained as a fallback. Continue tracking monitoring cost/coverage as real usage accumulates (see "Monitoring Economics founder telemetry" below), but do not tune anything off this initial single-target sample.

**Behavioral Learning V1's dashboard foundation is now shipped** (2026-08-17) — see "Behavioral Learning V1 — Dashboard Foundation" below for the precise, bounded scope. Notification-learning wiring and richer learning are deliberately deferred until real Beta usage accumulates.

### Behavioral Learning V1 — Dashboard Foundation — COMPLETED / BANKED (2026-08-17)

Merged to `main` at `4b62e3308028832ae4779843a4c82092f5a21cd5` (merge commit, `feature/behavioral-learning-v1-phase1` → `main`), founder-approved after live Preview QA (deployment `dpl_9oatWvhP5Lva4JYmXxYWv7JLPwDq`, matching commit `34b7ce0`) and a code/privacy review. Deterministic suite: 157/157 passing before and after merge.

**Two-layer doctrine (preserve):** House Accounts gets better at understanding signals globally, while the way a specific team sells becomes private intelligence for that organization. This ships the **private organization layer only** (Layer B). The global cross-customer layer (Layer A) remains future work and is not implemented — see `api/lib/org-preference-learning.js`'s own header comment for the exact boundary rules.

**Shipped:**
- Private, organization-scoped behavioral preference learning (`api/lib/org-preference-learning.js`), structurally isolated per organization — one org's evidence can never influence another's adjustment.
- Three canonical evidence families: `FOLLOW_UP`, `REPEAT_PATTERN`, `BUSINESS_ACTIVITY` (any signal-type business activity, pooled — not the ~25 raw signal-type labels).
- Two evidence streams: direct `useful`/`not_useful` quality feedback, and conservative outcome evidence (`outcome_reported` status `engaged`/`progressed` only — `no_response_yet`/`went_nowhere` never count as evidence).
- Latest-opinion and latest-outcome dedup semantics — a changed rep judgment or a sequential outcome update on the same outreach counts once, not as multiple independent votes.
- N=5 minimum evidence floor per family before any adjustment applies; 90-day evidence recency window.
- Bounded ±8 additive ranking adjustment — one term added to the existing dashboard score, never a rewrite of baseline scoring weights.
- Dashboard "This Week's Priorities" ranking consumes the learned adjustment (`api/get-dashboard.js` computes it once per request server-side; `dashboard/index.html`'s `calculateOpportunityScore()` applies it).
- Insufficient evidence (the real state for every current Beta org as of banking) leaves ranking byte-identical to baseline — proven both by deterministic tests and by live Preview QA.
- Truth/identity/actionability gates (`classifyMonitoringSignalEligibility()`/`classifyLegacySignalActionability()`) remain entirely upstream and untouched — learning only reorders already-eligible candidates, never changes what's eligible.
- Fail-closed: any preference fetch/compute failure falls back to baseline dashboard ranking and logs the failure — never a dashboard error.

**Not shipped — do not overstate:**
- Notification ranking does not consume Behavioral Learning yet.
- No rep-level personalization (organization-level only).
- No manager-learning dashboard.
- No richer event-type/industry/contact dimensions beyond the three families above.
- No global cross-customer learning implementation (Layer A remains future work).
- Current Beta organizations do not yet have enough accumulated evidence to produce any active (non-zero) adjustment in Production.

**Founder sequencing decision (2026-08-17) — do not begin notification-learning wiring next.** Deliberately let real users accumulate genuine behavioral evidence first. Do not tune N=5, ±8, the 90-day window, or evidence weights, and do not add new dimensions, based on fixtures or this founder QA round. Revisit after meaningful Beta usage accumulates, and decide from real data whether thresholds/weights are sensible, preferences are emerging, ranking changes look commercially correct, notification ordering should consume the same learning primitive, and richer dimensions are warranted.

### Account Expansion / Whitespace Intelligence — Buying Center × Offering Matrix — MERGED TO MAIN, PENDING PRODUCTION VERIFICATION (build started 2026-08-18; two founder correction rounds, 2026-08-19; merged 2026-08-19)

**Status: founder approved round 2 and directed the merge.** Fast-forward merged to `main` at `da777c6` (was Preview `dpl_AETUG4T8kjMZJYWrjbPWraKiUwy2`, READY). Merged-`main` suite reconfirmed 160/160 locally after the merge. **Not yet marked BANKED**: the founder's instruction was to bank only after Production is verified, and this session has no Vercel API/dashboard access to independently confirm the resulting Production deployment reached READY — every prior Preview/Production verification in this engagement was performed by the founder's own Vercel access, not this session's tooling. Awaiting that confirmation before flipping this line to BANKED.

**Product reframe this sprint (founder/Vantage review):** "Expansion" was being used for two different sales motions that must not be conflated. **Account Expansion / Growth Map** — how much of an *existing* customer do we currently own, and where is the whitespace (departments, product/program categories) — is the near-term priority below. **Find More Like Them / Lookalike Expansion** — net-new companies resembling accounts we already win with — is a separate, later capability; see its own entry under LATER.

**Design evolution this sprint:** started as a two-list (departments/categories) chip view, then reframed to a two-axis matrix (rows = buying centers, columns = offerings) after founder review of ARPEDIO/DemandFarm-style whitespace tooling. A real, read-only Supabase production query (not assumption) found contact department/title fields at ~0% population across every real Beta org's uploaded order history — this shaped both the cell-linkage discipline below and the mapping-prompt fallback.

**Founder correction round 1 (2026-08-19), after independent Production verification of the initial ship (`99b9fa1`):** approved the overall UX direction but held back banking on two trust/architecture issues:
1. **Persistence.** The buying-center mapping prompt's confirmation was client-local (localStorage) — organization/account intelligence, not a browser preference. Promoted to a durable, organization-scoped, cross-device Supabase table (see "Durable persistence" below).
2. **"Covered" truth standard, first pass.** Corrected same-row co-occurrence (too permissive — a repeated static contact would falsely "cover" every category an account ever bought) to a per-contact category-discrimination standard (a contact's own evidenced rows must span exactly one category to back a cell). **This first-pass correction was itself found still insufficient in round 2 below — see the current standard there, not this one.**
Also fixed while auditing: the matrix's responsive behavior now scrolls horizontally with the Buying Center column sticky, rather than risking shrunk/illegible cells at ordinary laptop widths.

**Founder correction round 2 (2026-08-19), after independent Preview verification of round 1 (`ba34cf5`):** round 1's persistence architecture was approved as correct for V1. Two things still required correction before founder approval:
1. **"Covered" truth standard, corrected again.** Per-contact category discrimination (round 1) still only proved correlation within data HA already had, never that a specific buying center purchased a specific offering. Worked example: a generic HR contact repeated on every row, account happens to have purchased only Apparel — even though HR is the only contact and Apparel the only category (so the round-1 rule would call it "genuinely discriminating"), this still doesn't prove "HR bought Apparel." **Current, standing V1 truth rule** (see the doctrine bullet below): a cell may render Covered only when (1) source data explicitly proves the specific buying-center-to-offering linkage, or (2) a rep explicitly confirms they sell that offering into that buying center. Neither exists today, so `computeAccountWhitespaceMatrix()` never assigns `covered` from real data — every cell is whitespace, every real purchased category renders in the unattributed panel. This is an accepted, honest V1 result, not a bug or a regression.
2. **Persistence identity caveat.** Founder asked to record explicitly that `(organization_id, normalized_company_name)` is a V1 account-resolution key, not an immutable account identifier, and to verify rename/re-upload doesn't silently corrupt data. Verified: there is no rename UI in the product today (`saveAccountMetadataEdit()` explicitly cannot rename an account); only a CSV re-upload with a differently-normalizing account name could shift the key, and when it does, old confirmations go inert (never deleted, never leaked to the renamed account) while the account safely falls back to the mapping prompt — the same state as never-confirmed, never stale/wrong data. This mirrors `ha_monitoring_targets`' own accepted, already-documented exposure to the identical failure mode (migration 15's identity doctrine) — not a new risk this table introduces. Smallest safe mitigation identified and applied: explicitly documented in the migration/API/BACKLOG (this entry) and deliberately did **not** add fuzzy/best-effort relinking of orphaned rows to a same-named new account, since that risks silently misattributing one company's confirmations to an unrelated company that happens to share a name. A real fix needs a stable, cross-upload account identity — a larger Canonical Account Identity project, out of V1 scope.

**Doctrine (governs every future slice, not just this one):**
- **Absence of evidence is never confirmed absence.** A cell with no evidence is "whitespace," never a claim of certainty either way.
- **V1 Covered truth rule (current, standing — round 2, 2026-08-19, supersedes round 1's per-contact-discrimination rule above).** A cell may render Covered only when (1) source data explicitly proves a specific buying center purchased a specific offering, or (2) a rep explicitly confirms they sell that offering into that buying center. Co-occurrence, uniqueness, repetition patterns, and single-category discrimination are all explicitly insufficient — none of them prove the intersection, only two independent facts (a known buying-center relationship; an account-wide observed purchase). Neither condition exists in this codebase today: no CSV field carries per-offering buying-center-purchase semantics, and today's durable rep confirmation is buying-center-level only, never offering-specific. Result: zero automatic Covered intersections is the correct, accepted current state — not a defect to work around.
- **Known-relationship context is row-level metadata, not a cell state.** Knowing a contact in a buying center describes that row's label (e.g. "Jane Doe · known contact"), never paints every cell in that row — and a buying-center-level rep confirmation is exactly the same: row-level only, never implies coverage of any specific offering cell.
- **Whitespace is not automatically an opportunity.** A recommended Active Expansion Play (not built yet) will require grounded commercial rationale (a real signal, a recurring/program pattern, an introduction path as supporting evidence only) in addition to a whitespace cell existing — an industry template alone remains insufficient.
- **Only real-evidence states render in Production.** Whitespace is the only cell state real computation assigns today. Covered, Not-Applicable, and Active-Expansion-Play have reserved markup/CSS (explicit "✓"/"N/A"/"EXPAND", no mystery icons) but are never assigned without a real per-offering source field, a cell-level rep confirmation mechanism (not built), or grounded expansion-play logic — no synthetic/demo cells in a real account.
- **Unattributed purchases are never a fake buying-center row.** Every real category purchase renders in a separate "Account-wide purchases not yet attributed" panel, outside the organizational grid, since no automatic attribution exists under the current truth rule.
- **`(organization_id, normalized_company_name)` is a V1 account-resolution key, not an immutable account identifier.** See round 2's persistence-identity finding above for the full rename/re-upload safety analysis.

**Shipped:**
- Explicit department taxonomy (7 buying centers, reusing `departmentFromText()`'s vocabulary) and category taxonomy (11 offerings, reusing `inferPromoCategory()`'s vocabulary) — unchanged, no new classification scheme.
- `computeAccountWhitespaceMatrix(account, confirmedCenters)` — pure function producing the real matrix under the current V1 Covered truth rule above (always whitespace today), per-row known-contact metadata, and the unattributed-category list.
- The "🗺️ Account Whitespace" matrix UI on the existing per-account expandable card (Manage Customer Accounts) — clean horizontal wrapped column headers (no rotated all-caps), no legend, CSS-grid tiles rather than a raw table. Fixed-width columns, horizontally scrollable, with the Buying Center row-label column and header corner `position:sticky` — ordinary laptop widths no longer clip or shrink right-side offerings.
- **Lightweight buying-center mapping prompt** for the current real-world common case (zero classifiable buying centers): "Help House Accounts map this customer" + clickable buying-center chips, matching the doctrine that HA builds the map wherever it has evidence and the rep supplies only small corrections — never per-cell manual data entry.
- **Durable persistence:** `ha_whitespace_confirmations` (migration 24) — keyed by `(organization_id, normalizeCompanyName(account_name), buying_center)`, reusing `ha_monitoring_targets`'s identity convention deliberately without a hard FK to that table's row (different lifecycle; not every account has a matching monitoring target). `api/whitespace-map.js` — Bearer-token-authenticated, server-derived `organization_id` only; `GET` with no `accountName` returns the whole org's confirmations in one batched map (`{confirmations:{normalizedName:[...]}}`, one bounded request per render, matching the `org-preference-learning.js` fetch doctrine), `GET ?accountName=` returns one account's array for callers that only need one, `POST {accountName, buyingCenter}` toggles (insert/delete, existence-then-write, concurrent-insert races on the unique constraint treated as success not error). Confirmations are cross-device and visible to every authorized org member, not a per-browser preference.
- Fixed a real, narrow gap this work depended on: `normalizeSavedAccount()` never restored `allRecords` from `rawData.records` after a save/reload, so a previously-saved (not just freshly-uploaded) account would have silently shown empty per-row evidence. Purely additive.
- **Explicitly not built yet:** grounded Active Expansion Play generation, any change to Relationship Expansion opportunity-generation logic, cell-level (as opposed to buying-center-level) confirm/correct — the second condition of the V1 Covered truth rule above. Full suite: 160/160.
- **Ingestion recon finding (2026-08-18, real production query):** widening CSV department/title column aliases has low expected yield — commonsku/Facilis/Antera/generic-Excel order-history exports generally don't contain these fields at all; the real levers are future integration contact APIs (Antera's confirmed schema already exposes per-contact title data) and the rep-confirm loop this entry ships.

---

## NOW — Activation & launch quality

Bounded, near-term work that directly completes or polishes what's already live. Ship before or alongside Production monitoring/notification activation.

### Notification Deep Links / Actionable Re-entry (remainder)

**Priority: High — near-term.**

**Status:** partially built. The outreach-prompt half ("Tell us how it went →" → the specific unresolved outreach) shipped in Notification & Outcome Loop V1, Part A3 (2026-08-16) — see "Recently completed" above.

**Remaining scope:** the intelligence-item half — clicking a specific "New Intelligence" line in an email should land the rep on that exact signal/opportunity (e.g. auto-opening its Prepare for Call), not just the general dashboard.

**Why not built yet:** investigated in the same sprint. The outreach panel is one small, self-contained fetch-then-render function, which is what made its deep link safely bounded. The priorities feed a signal-level deep link needs to target is a much larger, async, collapsing/deduping render pipeline (`renderWeeklyPrioritiesFeed()` and its supporting dedup/collapse logic) where the exact same signal may no longer render as a distinct card by the time a rep opens an email days later (superseded, marked useful/not-useful, collapsed into a duplicate group, etc.). Building this safely needs real handling for "target no longer exists" plus a wait-for-async-render mechanism — genuinely new client-side logic, not a small reuse of an existing mechanism like the outreach case was.

**What to build when picked up:** a stable per-signal identifier (`eventFingerprint` + `accountName`, the same composite key `/api/signal-events` read-back already uses) passed as a query param; on dashboard load, once the priorities feed has rendered, locate the matching card and either scroll to it or open Prepare for Call directly; gracefully do nothing (land on a normal working dashboard) if the target can't be found. Preserve the existing `next=/dashboard/...` auth-return flow for logged-out clicks — do not invent new auth/session handling.

### Company Website — strongly recommended CSV/onboarding field

**Surfaced by:** Monitoring Identity V1 (Phase 2C grounding-policy investigation, 2026-08-15). Reconciled against the founder's 2026-08-16 backlog inventory — same item, no material change to scope.

**Problem:** `api/save-upload.js` has no website/domain column mapping at all today. Of the accounts monitored in production, only one has an uploaded website; the rest either have no usable identity anchor or fall back to a contact-email business domain, which is a weaker, less direct signal (see `api/lib/monitoring-identity.js`'s resolution order). Company website/domain is not merely optional metadata — it is the strongest automatic anchor for `resolveTargetIdentity()`, and better identity input directly improves signal quality (more monitoring targets reach `derived` status, more grounded signals reach `priority` instead of sitting in `secondary`/Research Details), and reduces namesake-company identity mistakes.

**What to build:**
- Support a standard `Website` / `Company Website` CSV column in the upload/import mapping (`api/save-upload.js`) if that mapping does not already exist.
- Label it **Strongly recommended**, not required — never block upload when it's missing.
- Explain the product benefit in plain language at the point of collection. Suggested copy:

  > **Company Website — strongly recommended**
  > Including a company website helps House Accounts identify the correct business online and deliver more accurate, higher-confidence signals.

- Consider including the field prominently in the recommended CSV template/example.

**Product framing:**
- Best case: customer supplies a website → strongest automatic identity anchor (`identity_domain_source = 'uploaded-website'`).
- Fallback: no website → House Accounts derives identity from a unique non-free-mail business-domain contact email when safely possible (`'contact-derived'`).
- Still unresolved: House Accounts continues researching, but uncertain results remain `secondary` (visible to the rep, framed as uncertain) rather than being promoted to `priority`.

**Scope note:** UI/onboarding work only — no backend identity-resolution logic changes needed; `resolveTargetIdentity()` already prioritizes an uploaded website over contact-derived domains and will pick this up automatically once the field exists.

### Repeated unresolved outreach grouping

**Surfaced by:** live Preview QA of Notification & Outcome Loop V1 (2026-08-16) — the "Albany International" case: four genuinely distinct, real `outreach_made` events (confirmed via direct Supabase read, not a rendering bug) produced four separate near-identical rows in the dashboard's unresolved-outreach panel and would produce four separate email prompts.

**Not a bug:** each row is a real, distinct outreach attempt; the "Save outreach" flow already has proper double-submit protection, so this reflects genuinely repeated manual logging, not a defect.

**Idea for later, not built:** group several open outreach attempts to the *same account* into one line in both the dashboard panel and the notification digest, e.g. `4 open outreach attempts to Albany International`, rather than repeating the "how did it go?" prompt once per attempt. Do not erase or collapse the underlying event history — `ha_signal_events` stays append-only; this is presentation-only grouping.

### Monitoring Economics founder telemetry

**Surfaced by:** founder backlog reconciliation (2026-08-16), consolidating cost-guardrail context that has accumulated across the Phase 2D (concurrency/vendor-rate safety) and Production activation recon work.

**What to build:** a small founder/admin-only view exposing:
- scans attempted vs. successful;
- average/median research cost per account;
- 7-day and 30-day monitoring COGS;
- projected monthly cost;
- outcome breakdown (complete / degraded / insufficient);
- runtime;
- provider usage;
- Research COGS ÷ subscription revenue.

**Guardrails to keep documented alongside this view (do not silently drop these numbers when building it):**
- historic baseline approximately 1.645¢ per attempted account;
- ≤1.5¢ is good for production;
- ~1.0–1.2¢ is excellent at scale;
- investigate any sustained period above 2¢;
- pricing concern begins around ~3¢+;
- Research COGS under 10% of subscription revenue is healthy; 5–8% is preferred.

**Do not optimize from tiny samples** — this view is for trend visibility, not a trigger for reactive tuning off small statistical noise.

---

## NEXT — Compounding product intelligence

Work that makes House Accounts' recommendations get better over time, not just visible. Build in this order — the second item explicitly depends on the first.

**Current priority framing (updated 2026-08-18 after the Account Expansion / Find More Like Them product reframe):** 1) real Beta usage / selling; 2) adoption-critical integrations where demand is proven; 3) Account Expansion / Whitespace Intelligence remaining work (Slice 1 shipped — see Recently completed above) — reuses the existing account/order/contact foundation, no Behavioral Learning dependency; 4) selected seller-UX correctness fixes driven by observed friction; 5) Behavioral Learning V1 remaining work (notification-learning wiring, richer dimensions), once meaningful Beta usage has accumulated; 6) Manager Intelligence / team reporting, once enough behavior/outcome data exists; 7) Find More Like Them / Lookalike Expansion (see LATER), sequenced behind Account Expansion. Not a permanent frozen order. Older cleanup/hardening ideas still do not displace real Beta usage/selling unless they represent a genuine sell-the-product blocker.

### Account Expansion / Whitespace Intelligence / Growth Map — remaining work

**Priority: near-term — the Buying Center × Offering matrix is merged to `main`, pending Production verification before it's marked banked, see "Account Expansion / Whitespace Intelligence — Buying Center × Offering Matrix" under Recently completed above.** No Behavioral Learning dependency — this track reuses the existing contact/order/category foundation directly.

**CRM boundary (standing constraint on all future slices):** House Accounts answers "where can I grow this account," never "what happened and when." No activity/call logging, deal/pipeline stages, task/reminder management, email history/sync, or custom-field CRM configuration. The whitespace grid must stay a derived, evidence-backed inference with rep correction — never a form a rep is expected to keep up to date from memory.

**Remaining scope, sequenced:**
- **Cell-level confirm/correct — now the ONLY rep-driven path to a Covered cell.** Durable, org-shared buying-center-level confirmation persistence shipped 2026-08-19 (see the entry above — `ha_whitespace_confirmations` / `api/whitespace-map.js`), but per the round-2 founder correction (2026-08-19), buying-center-level confirmation alone can never mark any offering cell Covered — only a real per-offering source field or a genuine cell-level (buying center × offering) rep confirmation can. Remaining: extend beyond the buying-center-level prompt to real cell-level confirm/correct (Covered / Whitespace / Confirmed whitespace / Not applicable), once the row-level flow has real usage to learn from. Until this ships (or a real integration field arrives), the matrix will legitimately show zero automatic Covered cells in Production — that is accepted, not a defect to route around.
- **Slice 3 — rework Relationship Expansion opportunity generation.** Today's `generateFutureOpportunities()` industry-template gate (`if(industry === 'Automotive...') if(cats.has('Apparel'))...`) must stop being a standalone trigger. A recommended expansion play requires an evidence-backed whitespace cell (non-confirmed-absent) PLUS at least one grounded commercial trigger — a real public signal, a detected recurring/program pattern (`findRepeatPatternGroups()`), or a rep-supplied introduction path (`suggestedIntroductionPath()`). An industry template alone becomes necessary-but-not-sufficient, never sufficient by itself. This touches live, revenue-relevant opportunity-generation logic with existing test dependencies — the highest-risk slice, do carefully with a full regression pass.
- **Location/subsidiary/division whitespace** — explicitly deferred. Current data (a flat city/state string) cannot support this dimension truthfully; would need richer CSV input or a live integration (see Integrations) before it's worth building.
- Rep confirmations should eventually feed the existing private org-scoped Behavioral Learning event foundation's *pattern* (not necessarily its literal table) — a confirm/correct action is structurally similar to the quality-feedback events `org-preference-learning.js` already consumes.

### Behavioral Learning V1 — remaining work (notification wiring, richer dimensions)

**Priority: deliberately paused, not high.** The dashboard-ranking foundation is shipped and banked — see "Behavioral Learning V1 — Dashboard Foundation" under Recently completed above for exactly what exists today. **Founder sequencing decision (2026-08-17): do not begin notification-learning wiring or any of the items below until real Beta usage has accumulated meaningful evidence.** This is an explicit pause, not a forgotten dependency — do not resume it absent that evidence or a specific founder decision to do so.

**Two distinct kinds of evidence this system keeps separate, not collapsed into one signal** — already encoded in the shipped dashboard foundation and equally applicable to any future notification wiring: direct signal-quality feedback (`signal_useful`/`signal_not_useful`, a rep's judgment on the *signal itself*) vs. outcome evidence (`outreach_made`/`opportunity_outreach_made` → `outcome_reported`, what happened *after a rep acted*). A signal can be good and never acted on; a rep can act on a good signal and get no response. Do not blend these into one score — see `api/lib/org-preference-learning.js` for the live implementation of this separation.

**Organization-level learning before rep-level personalization** — the shipped foundation models how an *organization* wins, not individual reps. Rep-level personalization remains a later refinement, not assumed as the next step, unless a future reconciliation says otherwise.

**Remaining scope, once resumed (do not build ahead of the founder sequencing decision above):**
- **Notification-learning wiring** — have `api/notification-scheduler.js`'s digest ordering consume the same `computeOrgSignalPreferences()` primitive the dashboard already uses, rather than inventing a second ranking notion.
- **Richer learning dimensions** — beyond the three current families (`FOLLOW_UP`/`REPEAT_PATTERN`/`BUSINESS_ACTIVITY`), once real usage shows the pooled `BUSINESS_ACTIVITY` bucket is too coarse to be commercially useful.
- **Rep-level personalization**, once the organization-level foundation has real signal to build on.
- **Manager-learning views** — see "Manager intelligence / organizational insights" below, which depends on this.
- **Global cross-customer learning (Layer A)** — a separate module from the private org layer; not started, not scoped yet. See the two-layer doctrine note under the Dashboard Foundation entry above.

Do not build a parallel opportunity-scoring system alongside any of this — it belongs inside this same data model and weighting design, not a separate scoring project.

### Manager intelligence / organizational insights

**Depends on:** Behavioral Learning V1's remaining work above (richer dimensions, real accumulated evidence) — do not build as a separate analytics feature ahead of or instead of that foundation. Also sequenced behind real Beta usage and adoption-critical integrations (see the current priority framing above) — the dashboard-ranking foundation shipping does not itself unblock this; meaningful behavioral data actually needs to accumulate first.

**Surfaced by:** founder backlog reconciliation (2026-08-16); reconciled again (2026-08-16) against older printed roadmap notes describing rep activity/follow-up visibility, opportunities being worked, meetings, quotes, wins, revenue, adoption by rep, ignored/aging opportunities, team-level ROI, and executive summaries — folded into this single entry rather than becoming a separate project.

**Eventual scope:** once Behavioral Learning V1 exists, allow managers to see patterns such as: which signal types reps actually act on; which signals lead to real engagement/progress; what top-performing reps do differently; team opportunity coverage; account risk/neglect (accounts nobody is reaching out to); rep activity and follow-up visibility; opportunities currently being worked; adoption by rep; ignored/aging opportunities; team-level ROI and executive-summary views. This should be a natural view built on top of Behavioral Learning's data model, not a bespoke analytics feature built in parallel to it.

**Explicitly not a CRM:** House Accounts is not becoming a full CRM (no generic meeting/quote/win/revenue tracking system of its own) — any of the above that requires data House Accounts doesn't already capture stays out of scope until there's a specific, evidence-backed reason to capture it.

**Permission role vs. selling role stay separate** — see "Manager/team workflow" under SOON below, which already establishes this distinction; do not conflate the two here either.

---

## SOON — Adoption & workflow

Work that grows and organizes who uses House Accounts and how, once the core intelligence loop is solid. Not blocking near-term activation.

### Account identity / duplicate hygiene

Keep distinct from Monitoring Identity V1, which is already banked (`a5abea8`) — do not reopen that classifier absent a confirmed real-user failure. These are the remaining, explicitly out-of-scope-for-V1 hygiene items.

**Architectural lesson to preserve:** account name alone is not globally safe identity in an aggregate, multi-upload workspace — Monitoring Identity V1 has already hardened target-side identity resolution substantially (domain-based anchors, corroborator tiers); the items below are the remaining name-only/aggregate-matching paths that lesson doesn't yet cover, not a reason to redo the work already banked.

**Related, unverified — public-article duplication under Additional Opportunities:** an older note claimed related public articles could still duplicate under the "Additional Opportunities" surface (`additionalOpportunitiesFor()`, `dashboard/index.html`). Substantial same-account/clean-persisted-opportunity dedup work already exists in that code path (see its own inline comments), and the general "duplicate primary/additional opportunity bug" is already banked — but this narrower related-public-article case hasn't been specifically re-verified against current code. **NEEDS EVIDENCE** — reproduce against a real account with multiple related public articles before treating as a live bug; do not let this become a roadmap driver either way.

**Cross-target identity diagnostic (data-quality signal, not a policy change)**

*Surfaced by:* Monitoring Identity V1 backfill audit (2026-08-15) — the "Insurcomm Restoration Group" / "Rytech Resoration" case.

*Finding:* Of 32 real (non-fixture) contact-derived identities in the production backfill, exactly one collided: two distinctly-named monitoring targets for the same user — "Insurcomm Restoration Group" and "Rytech Resoration" — both derived `insurcomm.com` because both accounts' only contact on file is the same person (`awelsh@insurcomm.com`), most likely a shared account manager/channel contact rather than each company's own domain. The derived domain has no lexical relationship to "Rytech" at all, unlike every other case in the dataset. This is the only target in 88 that trips either flag below.

*Decision (2026-08-15):* contact-derived business domain remains a Strong corroborator under the existing safeguards (free-mail exclusion, per-target uniqueness). This single edge case does not justify adding new restrictions — do not build a policy change from it.

*Idea for later, not built:* a read-only diagnostic (not an auto-demotion) that flags, for a rep's/founder's attention:
- the same derived domain attached to two or more distinctly-named monitoring targets for the same user, and/or
- a derived domain with no lexical relationship to the account's own name.

Either condition alone would have caught the Insurcomm/Rytech case; neither is close to tripping on any other current target. Cheap to add later if this pattern recurs; not worth building against a single occurrence today.

**Duplicate monitoring target: "L.L. Bean" vs "L.L.Bean"**

*Surfaced by:* Monitoring Identity V1 backfill audit (2026-08-15).

*Finding:* Two separate `ha_monitoring_targets` rows exist for what is almost certainly the same real company, from two different uploads: "L.L. Bean" (with a space; has an explicit uploaded website, `identity_domain_source = 'uploaded-website'` → `llbean.com`) and "L.L.Bean" (no space; no website, no usable contact domain, `unresolved`). This is a canonical-identity/account-hygiene issue — normalized-company-name matching (`normalizeCompanyName()`) doesn't currently collapse "L.L. Bean" and "L.L.Bean" into the same target.

*Explicitly out of scope for Monitoring Identity V1* — this is account-level deduplication/canonical-identity work, not target-identity resolution. Logged here, not touched. Do not merge or delete either row without deliberate, separate account-hygiene work.

**Broader hygiene work (not yet started, added 2026-08-16 reconciliation):**
- Canonical, durable account identity across re-uploads and naming variants, longer-term — the general case the L.L. Bean pair is one instance of.
- Duplicate-account reconciliation more broadly (beyond the one known pair above).
- Exact-name duplicate defenses where appropriate, at upload/import time.
- Normalized-name collisions should remain cautious/visible rather than silently auto-unified — a false merge is worse than a visible duplicate.
- Rep-confirmed identity, eventually — letting a rep explicitly assert "these are the same company" as a strong signal, rather than only inferring it automatically.

### Integrations

**Adoption-critical, based on real Beta feedback (near-term within this tier):** Commonsku, Facilis, Antera. Older guidance to "wait for more demand" before prioritizing specific integrations is now stale for these three specifically — current Beta usage has made them adoption-critical, not merely requested.

**Longer-term / broader, no proven demand yet:** Salesforce, HubSpot, Essent, Pipedrive, and others — revisit if customer demand changes.

**Desired long-term model:** continuous synchronization with the source system, not repeated manual CSV exports — the eventual integration shape to design toward, not a one-time import connector.

CSV remains the current Beta path and should stay fully supported — do not turn the first sale of any single integration into a hard requirement for adoption generally.

### Opportunity lifecycle / snoozing / repetition control

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16 against current event/outcome semantics.

**Already shipped — do not reopen:** "mark contacted"/outreach logging, outcome/result states (`engaged`/`progressed`/`went_nowhere`/`no_response_yet`), and unresolved-follow-up tracking are all live via Notification & Outcome Loop V1 (`ha_signal_events`, the unresolved-outreach panel, `api/lib/outcome-prompts.js`).

**Genuinely still missing, merged into this one entry rather than a mini-CRM of separate features:**
- Snooze an opportunity/signal until a chosen date.
- Dismiss with a reason, or mark "no longer relevant" (distinct from an outcome report — this is a rep saying the item itself isn't worth surfacing again, not reporting what happened after outreach).
- Resurfacing rules for a snoozed/dismissed item.
- Suppressing repetitive resurfacing of essentially the same actionable item (e.g. a reorder/follow-up opportunity) after a rep has already acted on, dismissed, or resolved it — the current terminal-outcome logic stops the *automatic outcome-prompt nag* for a specific outreach, but does not confirm whether the underlying signal/opportunity itself is prevented from re-entering the priorities feed or a future notification digest as if it were new. **Needs verification against current dedup/eligibility logic before scoping further** — if it turns out already handled, drop this bullet.

Reconciles the older, now-architecturally-obsolete "reorder opportunities may repeat in multiple weekly digests" note (the weekly-digest architecture it referred to no longer exists) into the same real, still-open question above: can essentially the same opportunity repeatedly re-enter *any* current proactive surface (priorities feed or notification digest) after a rep has already acted on it.

**Explicitly do not build a full opportunity-management CRM layer** — this is bounded lifecycle/resurfacing control on top of the existing priority/secondary eligibility policy, not a parallel task-management system.

### Contact intelligence

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16.

**Classification: DEFER / NEEDS EVIDENCE.** Do not elevate to a near-term build absent Beta feedback specifically showing "who do I contact?" is a bigger obstacle than "why should I contact them?" — the current product's core value is squarely the latter.

**Already partially covered — do not duplicate:** deterministic department/contact suggestion (`suggestedContact`/`recommendedBuyingTeam`/`likelyBuyers`) already flows into recommendations and Prepare for Call today, and uploaded contacts already reach the research prompt (`knownContacts`).

**Genuinely new, if this ever gets picked up:** inferring a likely decision-maker when no contact was uploaded at all; contact-role confidence scoring; relationship history (who the rep has contacted before, whether that person replied); identifying internal champions; signal-specific contact suggestions (which contact fits *this particular* signal, not just the account generally).

### Truthful research-result states — remaining correctness gaps

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16 against current code.

**Already shipped — do not reopen:** "View Research" only renders when `signalCount > 0` (the Manage Customer Accounts panel already gates on this — see its own "Beta correction" comment); a genuinely empty research result is already distinguished from "not yet researched" in the places this was checked.

**Doctrine to hold going forward (already banked elsewhere, restated here as the standard this item measures against):** distinguish, everywhere a research result is shown — actionable priority opportunity found; valid secondary/non-priority signals found (still real, still worth showing in Research Details — a signal doesn't need a priority opportunity to be legitimate); nothing found (an honest true negative); research failed/retrying. CTA and copy must match the actual state, never imply more or less than what's true.

**Unverified — narrow, possibly-still-open gaps, not confirmed either way:**
- "Recently Researched"'s compact summary count going stale relative to what the underlying research modal actually shows once opened.
- Account-level research-failure/retry messaging clarity.
- List-level OpenAI-timeout messaging being generic/vague rather than a clear, actionable message.

Bounded correctness audit if picked up — verify each bullet against current code before building anything; several research-result-state gaps in this general area have already been fixed (see above), so re-confirm before assuming these three are still open.

### Dashboard card density / information hierarchy

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16.

**Preserve the principle, not stale literal guidance:** a compact priority card should quickly communicate Why Now, current status/timing, the Play, best ideas, a recommended contact, a concise approach, and a Prepare for Call CTA — deeper explanation belongs in Prepare for Call/detail surfaces, not the compact card.

**Do not act on the old literal instruction to remove "Why It Could Grow"** — that field still exists in the current dashboard (`dashboard/index.html`) and there is no current Beta evidence it's causing density problems. Treat this whole entry as Beta-driven UX backlog: revisit if/when real usage shows the compact card is too dense, not as a standing polish sprint.

### Manual research queue

**Classification: DEFER.** Separate from the banked background monitoring Queue (Queue monitoring architecture, Full Beta Cutover) — this is about the *interactive* single/warm-account research flow.

**Current behavior:** requesting research while another run is active for the same uploaded list fails outright ("Another research run is currently active for this uploaded list. Please wait for it to finish." — `dashboard/index.html`, `api/monitoring-lists.js`, `api/save-upload.js`), rather than queuing.

**Desired eventual UX, only if Beta behavior proves this is a real friction point:** requesting research for account A, then B, then C while A is still running queues B and C instead of failing. Must preserve the existing authoritative run lock, the Stop control, bounded execution, and truthful progress reporting — this is additive queuing on top of the existing lock, not a redesign of it.

**Do not build this from the old note alone** — defer until real concurrent-research friction is actually observed in Beta usage.

### Account Intelligence / account search

**Long-standing product direction:** House Accounts should become the place reps live during outbound and the first stop for researching an existing customer — not just a weekly digest source.

**Eventual scope:** search an existing customer and get a fast Account Brief: what changed; existing customer context; relevant contacts/context where available; reasons to reach out; current sales plays; existing generated intelligence; optional refresh-research action.

**Scope discipline:** start with accounts already present in uploaded customer data. Universal any-company research (research on a company that isn't an existing customer at all) is a separate, later capability — see "Longer-term / older parked ideas" under LATER; do not conflate the two.

### Manager/team workflow

**Principle to preserve:** permission role and selling role are orthogonal. The current app roles (owner/admin/member) are access-control roles, not the eventual selling-role model, and must not be conflated with it.

**Future concepts (not built):** rep / manager / both, as a selling-role concept distinct from the permission role. Manager-only users should eventually receive team intelligence views, not the same giant individual-rep digest a selling rep gets. Outcome prompts belong to the outreach actor (the rep who logged the outreach) — a manager should never be prompted to report an outcome they didn't personally own.

**Explicitly do not build this role model until usage justifies it** — this is a real architectural decision, not a quick add.

### Onboarding/upload polish

Ongoing, not a single deliverable. Keep improving: import clarity; upload troubleshooting; clear CSV language; Company Website guidance (see the NOW entry above); empty-state behavior; first-use experience; Import Guides.

Keep onboarding centered on existing customers, not cold prospecting — matches the current product's own doctrine (see the top of this file).

---

## LATER — Larger systems & strategic bets

Real, worth preserving, but should not outrank NOW/NEXT/SOON for attention. Several of these explicitly depend on Behavioral Learning V1 landing first — do not promote them ahead of that dependency.

### Find More Like Them / Lookalike Expansion — "Companies like the customers you already win with"

**Major strategic wedge — not generic prospecting. Distinct from Account Expansion / Whitespace Intelligence (see NEXT) — that track grows existing accounts; this one finds net-new companies resembling them.** Do not conflate the two names or the two capabilities.

**Sequenced behind Account Expansion / Whitespace Intelligence** (see NEXT) — not because it structurally requires it, but because Account Expansion reuses far more of the existing foundation and directly serves the existing-customer core loop first. Recon (2026-08-17) found the public-signal research/grounding/actionability engine this needs already exists (`research-batch.js`'s `prospect-intelligence` mode, currently feature-flagged off via `MVP_FEATURES.prospectIntelligence`) — the genuinely missing piece is candidate-company discovery, a bounded task, not a rebuild.

**No longer hard-gated on mature Behavioral Learning (corrected 2026-08-17):** Behavioral Learning should make this smarter about *how* an organization wins, as an optional future weighting input — it does not need to be the prerequisite that makes this possible at all. A conservative V1 can seed candidates from existing customer/order/account evidence already in hand (revenue, frequency, recency, category diversity — the same fields `getRelationshipStrength()` already computes) without waiting on Behavioral Learning evidence to clear its threshold.

**Eventual scope:** identify characteristics of successful existing accounts from real order/account data; generate lookalike candidates from that profile (never from an open, rep-uploaded target list — that is Prospecting, stays separate); require every candidate to clear the same identity-grounding gate (`verifyCandidateCompanyGrounding()`) and carry a real, timely, dated reason to engage before ever surfacing — never similarity alone. Deeper research capability belongs here specifically, not in current Core: Hussey-style deep-research depth, business-model mapping, dealer/channel network mapping, campaign/program-level research, multi-signal synthesis across a prospect, and bespoke concept generation.

**Economic discipline:** keep this research economically separate from monitored-customer capacity. The existing `monitoring-capacity.js` guardrail bounds global worker concurrency, not per-org spend — it does not by itself provide economic separation. Customer monitoring subscription tiers must not silently make unlimited large-scale lookalike research free; define a separate research allowance/economic model when this scales (see "Monitoring Economics founder telemetry" under NOW).

**Explicitly separate from and does not unblock Prospecting** (universal any-company research, not customer-similarity-driven) — see "Longer-term / older parked ideas" below. Candidate sourcing here must stay system-generated from the winning-customer profile, never an open rep-uploaded list, or this quietly reopens the door to generic prospecting the product has deliberately stayed closed to.

### Website / positioning / commercialization — "Why House Accounts vs. ChatGPT / Claude?"

**Depends on:** Behavioral Learning V1 for its strongest claim.

**Future messaging direction:** general assistants wait for prompts; House Accounts is persistent, proactive, account-aware, workflow-native, organization-specific, continuously watching the customer book, and remembers what happened.

**Explicit constraint:** once Behavioral Learning is truly wired, add the stronger claim that House Accounts improves based on how the organization actually wins. **Do not claim behavioral learning publicly before it exists** — this messaging must trail the real capability, never lead it.

### Customer proof / stories

Preserve validation examples for eventual use as sales/customer-story proof rather than letting them remain anecdotal internal notes:
- Dover Honda holiday parade public signal → real outbound reply.
- Route 236 field outreach, where specific signals/opportunity ideas produced real contacts/conversations.

### Later notification/channel expansion

Explicitly backlog, do not build now: SMS; Slack; instant notifications; custom delivery times; sophisticated manager/team digests; advanced per-signal notification toggles.

House Accounts remains the canonical state; notification channels are transport only, never a second source of truth. See the Notification & Outcome Loop V1 architecture doctrine this constraint comes from.

### Historical Business Activity reinterpretation (conditional — verify before building)

**Surfaced by:** older printed roadmap notes, reconciled 2026-08-16.

**Candidate bounded enrichment:** re-run current commercial interpretation logic only against already-grounded, already-persisted signal evidence created under older reasoning generations — no new web searches, no Firecrawl, no rediscovery, no identity mutation, and never a silent bulk rewrite.

**Only worth doing if a real gap is confirmed:** this is worth building only if old-generation persisted intelligence can still materially surface to current users today and degrade their experience relative to what current reasoning would produce for the same evidence. Verify that before scoping further — do not build speculatively.

**If retained, frame correctly:** a founder-approved, explicit one-time enrichment operation with a clear before/after evidence trail — never an ongoing background reinterpretation system.

### Longer-term / older parked ideas

Kept clearly lower priority unless current strategy explicitly promotes one of these — do not let them outrank the current commercial path (existing customer intelligence → reason to reach out → opportunity/play → Prepare for Call → rep action → outcome):

- CRM live sync / OAuth / scheduled imports
- Supplier intelligence
- Forecasting
- Advanced analytics (beyond Manager intelligence under NEXT, which is scoped and dependency-gated)
- AI-agent-like workflows
- Chrome/mobile experiences
- Public roadmap/voting
- Universal any-company research (research on companies that are not existing customers at all — distinct from Account Intelligence/account search under SOON, which stays scoped to existing customer data, and distinct from Find More Like Them above, which is customer-similarity-driven, not universal)
- More sophisticated enterprise permissions/admin
