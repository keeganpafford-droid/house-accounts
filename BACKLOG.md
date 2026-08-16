# Backlog

Durable near-term items identified during active engineering work but deliberately not built in the sprint that surfaced them. Each entry should say what to build, why, and where the investigation that produced it lives.

## Website / Company Website — strongly recommended CSV/onboarding field

**Surfaced by:** Monitoring Identity V1 (Phase 2C grounding-policy investigation, 2026-08-15).

**Problem:** `api/save-upload.js` has no website/domain column mapping at all today. Of the accounts monitored in production, only one has an uploaded website; the rest either have no usable identity anchor or fall back to a contact-email business domain, which is a weaker, less direct signal (see `api/lib/monitoring-identity.js`'s resolution order). Company website/domain is not merely optional metadata — it is the strongest automatic anchor for `resolveTargetIdentity()`, and better identity input directly improves signal quality (more monitoring targets reach `derived` status, more grounded signals reach `priority` instead of sitting in `secondary`/Research Details).

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

## Lightweight cross-target identity diagnostic (data-quality signal, not a policy change)

**Surfaced by:** Monitoring Identity V1 backfill audit (2026-08-15) — the "Insurcomm Restoration Group" / "Rytech Resoration" case.

**Finding:** Of 32 real (non-fixture) contact-derived identities in the production backfill, exactly one collided: two distinctly-named monitoring targets for the same user — "Insurcomm Restoration Group" and "Rytech Resoration" — both derived `insurcomm.com` because both accounts' only contact on file is the same person (`awelsh@insurcomm.com`), most likely a shared account manager/channel contact rather than each company's own domain. The derived domain has no lexical relationship to "Rytech" at all, unlike every other case in the dataset. This is the only target in 88 that trips either flag below.

**Decision (2026-08-15):** contact-derived business domain remains a Strong corroborator under the existing safeguards (free-mail exclusion, per-target uniqueness). This single edge case does not justify adding new restrictions — do not build a policy change from it.

**Idea for later, not built:** a read-only diagnostic (not an auto-demotion) that flags, for a rep's/founder's attention:
- the same derived domain attached to two or more distinctly-named monitoring targets for the same user, and/or
- a derived domain with no lexical relationship to the account's own name.

Either condition alone would have caught the Insurcomm/Rytech case; neither is close to tripping on any other current target. Cheap to add later if this pattern recurs; not worth building against a single occurrence today.

## Behavioral Learning V1 — close the recommendation → outcome → better recommendation loop

**Priority: High — near-term, sequenced immediately after monitoring + notification activation** (Notification & Outcome Loop V1's own Steps 4–6).

**Surfaced by:** Notification & Outcome Loop V1 live outcome QA, downstream-consumer audit (2026-08-16) — see the read-only trace of every consumer of `ha_signal_events`/`outcome_reported` performed during that sprint.

**Confirmed gap:** `ha_signal_events` already durably captures rep behavioral evidence — signal feedback (`signal_useful`/`signal_not_useful`), selections (`signal_selected`/`opportunity_selected`), outreach (`outreach_made`/`opportunity_outreach_made`), approach notes (`approach_shared`), and now outcome reports (`outcome_reported`: `no_response_yet`/`engaged`/`progressed`/`went_nowhere`). None of this accumulated evidence currently influences:
- future recommendation ranking
- account prioritization
- signal-type weighting
- rep/org-level behavioral profiles
- Expansion (which accounts/signals surface as expansion opportunities, e.g. the "Why It Could Grow" surface)

The audit traced every real consumer of this data: `classifyMonitoringSignalEligibility()`/`classifyLegacySignalActionability()` (priority/secondary/hidden policy) derive entirely from a signal's own research payload; Organizational Learning V1B (`api/lib/account-opportunities.js`) derives account-history opportunities entirely from raw purchase history. Neither reads `ha_signal_events` at all. The table's own foundational commit (V1A, `1ec79ad`) explicitly describes it as being built "so House Accounts can **eventually** learn how a specific organization sells" — a deliberate foundation for future work, not a live learning system. Today, `outcome_reported`'s only functional effect is stopping the notification/dashboard nag loop (`api/lib/outcome-prompts.js`) — nothing more.

**What Behavioral Learning V1 should eventually do:** close the loop — `recommendation → rep action → outcome → better future recommendation` — using the behavioral evidence already being captured, without inventing ad-hoc weights mid-sprint. Design as its own deliberate system (data model, what "better" means, how weights/profiles are computed and applied, how they interact with the existing priority/secondary eligibility policy) rather than layering scoring logic onto an unrelated sprint.

**Explicitly not started:** no scoring, weighting, ranking, or profile logic has been implemented. This entry exists so the gap the audit confirmed doesn't get silently re-litigated or re-discovered — it's a known, named, prioritized next system, not a surprise.

## Duplicate monitoring target: "L.L. Bean" vs "L.L.Bean"

**Surfaced by:** Monitoring Identity V1 backfill audit (2026-08-15).

**Finding:** Two separate `ha_monitoring_targets` rows exist for what is almost certainly the same real company, from two different uploads: "L.L. Bean" (with a space; has an explicit uploaded website, `identity_domain_source = 'uploaded-website'` → `llbean.com`) and "L.L.Bean" (no space; no website, no usable contact domain, `unresolved`). This is a canonical-identity/account-hygiene issue — normalized-company-name matching (`normalizeCompanyName()`) doesn't currently collapse "L.L. Bean" and "L.L.Bean" into the same target.

**Explicitly out of scope for Monitoring Identity V1** — this is account-level deduplication/canonical-identity work, not target-identity resolution. Logged here, not touched. Do not merge or delete either row without deliberate, separate account-hygiene work.
