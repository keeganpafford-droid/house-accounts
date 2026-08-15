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
