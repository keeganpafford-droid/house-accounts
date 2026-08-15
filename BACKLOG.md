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

## Duplicate monitoring target: "L.L. Bean" vs "L.L.Bean"

**Surfaced by:** Monitoring Identity V1 backfill audit (2026-08-15).

**Finding:** Two separate `ha_monitoring_targets` rows exist for what is almost certainly the same real company, from two different uploads: "L.L. Bean" (with a space; has an explicit uploaded website, `identity_domain_source = 'uploaded-website'` → `llbean.com`) and "L.L.Bean" (no space; no website, no usable contact domain, `unresolved`). This is a canonical-identity/account-hygiene issue — normalized-company-name matching (`normalizeCompanyName()`) doesn't currently collapse "L.L. Bean" and "L.L.Bean" into the same target.

**Explicitly out of scope for Monitoring Identity V1** — this is account-level deduplication/canonical-identity work, not target-identity resolution. Logged here, not touched. Do not merge or delete either row without deliberate, separate account-hygiene work.
