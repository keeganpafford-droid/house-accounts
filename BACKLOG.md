# Backlog

Durable near-term items identified during active engineering work but deliberately not built in the sprint that surfaced them. Each entry should say what to build, why, and where the investigation that produced it lives.

Organized by how soon each item should be picked up, not by when it was written down. Explicit dependencies between items are called out inline — respect them; don't promote a dependent item ahead of what it depends on.

The current commercial path stays the anchor for prioritization: **existing customer intelligence → reason to reach out → opportunity/play → Prepare for Call → rep action → outcome**. Larger strategic bets (LATER) exist to eventually extend this path, not to compete with it for near-term attention.

---

## Recently completed (banked — not open work)

Noted here only so these are never rediscovered as gaps. No action needed.

- **Notification preferences UX** (Notification & Outcome Loop V1, Part A4, 2026-08-16): a simple Daily / Weekly / In-app only control now lives in Settings (`settings.html`), backed by `POST /api/settings` `action:'update-notification-preference'` and the existing `ha_users.notification_preference` field. No new settings architecture — reused the existing preference field/API pattern verbatim.
- **Notification deep link — unresolved outreach** (Notification & Outcome Loop V1, Part A3, 2026-08-16): a notification's "Report outcome →" link now carries `?outreach=<outreachEventId>` and lands the rep on that exact item in the dashboard's unresolved-outreach panel (scrolled into view, briefly highlighted), reusing the existing stable `ha_signal_events` primary key and the existing `next=`-preserving auth-redirect flow. This is the *bounded half* of "Notification Deep Links / Actionable Re-entry" below — the per-signal "View opportunity →" half remains open, see that entry.

---

## NOW — Activation & launch quality

Bounded, near-term work that directly completes or polishes what's already live. Ship before or alongside Production monitoring/notification activation.

### Notification Deep Links / Actionable Re-entry (remainder)

**Priority: High — near-term.**

**Status:** partially built. The outreach-prompt half ("Report outcome →" → the specific unresolved outreach) shipped in Notification & Outcome Loop V1, Part A3 (2026-08-16) — see "Recently completed" above.

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

### Behavioral Learning V1 — close the recommendation → outcome → better recommendation loop

**Priority: High — near-term, sequenced immediately after monitoring + notification activation** (Notification & Outcome Loop V1's own Steps 4–6).

**Surfaced by:** Notification & Outcome Loop V1 live outcome QA, downstream-consumer audit (2026-08-16) — see the read-only trace of every consumer of `ha_signal_events`/`outcome_reported` performed during that sprint.

**Confirmed gap:** `ha_signal_events` already durably captures rep behavioral evidence — signal feedback (`signal_useful`/`signal_not_useful`), selections (`signal_selected`/`opportunity_selected`), outreach (`outreach_made`/`opportunity_outreach_made`), approach notes (`approach_shared`), and now outcome reports (`outcome_reported`: `no_response_yet`/`engaged`/`progressed`/`went_nowhere`). None of this accumulated evidence currently influences:
- future recommendation ranking
- account prioritization
- signal-type weighting
- rep/org-level behavioral profiles
- Expansion (which accounts/signals surface as expansion opportunities, e.g. the "Why It Could Grow" surface)

The audit traced every real consumer of this data: `classifyMonitoringSignalEligibility()`/`classifyLegacySignalActionability()` (priority/secondary/hidden policy) derive entirely from a signal's own research payload; Organizational Learning V1B (`api/lib/account-opportunities.js`) derives account-history opportunities entirely from raw purchase history. Neither reads `ha_signal_events` at all. The table's own foundational commit (V1A, `1ec79ad`) explicitly describes it as being built "so House Accounts can **eventually** learn how a specific organization sells" — a deliberate foundation for future work, not a live learning system. Today, `outcome_reported`'s only functional effect is stopping the notification/dashboard nag loop (`api/lib/outcome-prompts.js`) — nothing more.

**What Behavioral Learning V1 should eventually do:** close the loop — `recommendation → rep action → outcome → better future recommendation` — using the behavioral evidence already being captured, without inventing ad-hoc weights mid-sprint. Design as its own deliberate system (data model, what "better" means, how weights/profiles are computed and applied, how they interact with the existing priority/secondary eligibility policy) rather than layering scoring logic onto an unrelated sprint. This must eventually support the strategic promise that House Accounts learns how an organization wins — see the "Why House Accounts vs. ChatGPT/Claude" positioning entry under LATER, which explicitly depends on this.

**Explicitly not started:** no scoring, weighting, ranking, or profile logic has been implemented. This entry exists so the gap the audit confirmed doesn't get silently re-litigated or re-discovered — it's a known, named, prioritized next system, not a surprise.

### Manager intelligence / organizational insights

**Depends on:** Behavioral Learning V1 above — do not build as a separate analytics feature ahead of or instead of that foundation.

**Surfaced by:** founder backlog reconciliation (2026-08-16).

**Eventual scope:** once Behavioral Learning V1 exists, allow managers to see patterns such as: which signal types reps actually act on; which signals lead to real engagement/progress; what top-performing reps do differently; team opportunity coverage; account risk/neglect (accounts nobody is reaching out to). This should be a natural view built on top of Behavioral Learning's data model, not a bespoke analytics feature built in parallel to it.

---

## SOON — Adoption & workflow

Work that grows and organizes who uses House Accounts and how, once the core intelligence loop is solid. Not blocking near-term activation.

### Account identity / duplicate hygiene

Keep distinct from Monitoring Identity V1, which is already banked (`a5abea8`) — do not reopen that classifier absent a confirmed real-user failure. These are the remaining, explicitly out-of-scope-for-V1 hygiene items.

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

**Adoption-critical (near-term within this tier):** Commonsku, Facilis, Antera.

**Longer-term / broader:** Salesforce, HubSpot, Essent, Pipedrive.

CSV remains the current Beta path and should stay fully supported — do not turn the first sale of any single integration into a hard requirement for adoption generally.

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

### Expansion / growth intelligence — "Companies like my customers"

**Major strategic wedge — not generic prospecting.**

**Depends on:** real behavioral/outcome evidence (Behavioral Learning V1) to be genuinely differentiated rather than a generic lookalike-company tool.

**Eventual scope:** identify characteristics of successful existing accounts; combine that with actual behavioral/outcome evidence (not just firmographic similarity); find companies resembling accounts where the organization actually wins; surface timely reasons to approach those companies.

**Economic discipline:** keep Expansion/prospect research economically separate from monitored-customer capacity. Customer monitoring subscription tiers must not silently make unlimited large-scale prospect research free. When Expansion research scales, define a separate research allowance/economic model for it — do not let it ride on the existing monitoring-capacity guardrails (see "Monitoring Economics founder telemetry" under NOW).

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

### Longer-term / older parked ideas

Kept clearly lower priority unless current strategy explicitly promotes one of these — do not let them outrank the current commercial path (existing customer intelligence → reason to reach out → opportunity/play → Prepare for Call → rep action → outcome):

- CRM live sync / OAuth / scheduled imports
- Supplier intelligence
- Forecasting
- Advanced analytics (beyond Manager intelligence under NEXT, which is scoped and dependency-gated)
- AI-agent-like workflows
- Chrome/mobile experiences
- Public roadmap/voting
- Universal any-company research (research on companies that are not existing customers at all — distinct from Account Intelligence/account search under SOON, which stays scoped to existing customer data, and distinct from Expansion above, which is customer-similarity-driven, not universal)
- More sophisticated enterprise permissions/admin
