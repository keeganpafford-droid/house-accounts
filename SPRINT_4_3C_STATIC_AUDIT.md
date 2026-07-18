# Sprint 4.3C — Static Research Coverage Audit

## Confirmed code behavior before this sprint

- `api/weekly-scan.js` loaded at most 75 rows per upload and then sliced the payload to 50 accounts. Any account beyond that cutoff could not receive a weekly research pass.
- `api/research-batch.js` also deduplicated and sliced incoming accounts to 50.
- The weekly scanner processed uploads sequentially and treated a failed batch as a failed upload run. It did not subdivide the account book, so one batch-level failure prevented later accounts in that upload from being attempted.
- `api/research-batch.js` used bounded concurrency of four accounts, but its generic `mapLimit` converted account-level exceptions to `null` without recording an account name or failure reason.
- The batch endpoint did not require a company domain. Domain-specific owned-page discovery was skipped when `website` was absent, while general company-name searches still ran.
- The free-plan upload path stores only the first 10 newly monitored customer accounts. Accounts marked `_locked` are not inserted into `ha_accounts`; this is an entitlement behavior, not a research queue bug.
- `api/get-dashboard.js` scopes member data through upload ownership. Team owners/admins can read organization-wide user rows. A member with no owned upload receives an empty personal dashboard even when the organization has data.
- `api/monitoring-lists.js` already supported list rename, pause/resume, and destructive list deletion, but it did not return account-level details or support account-level pause/delete actions.
- The dashboard contained a hidden research diagnostics panel plus rendering code capable of showing raw results, accepted/rejected counts, provider coverage, and elapsed research time.

## Causes that could explain “1 of 40 researched”

### Confirmed possible from code

- The UI can execute per-account fallback research only for selected/top accounts after batch research fails or returns no signals.
- Batch-level failure could stop the upload’s weekly run before later work was attempted.
- Account-level failures in `mapLimit` were silently converted to null.
- Upload/list stage `paused` or `archived` excludes the upload from free-plan monitored usage calculations and should exclude it from scheduled processing.
- Duplicate normalized company names are removed before research.
- Rows without an account name are removed.
- Member dashboard ownership filters can make organization accounts invisible in “My View.”

### Suspected runtime causes requiring logs/database

- The browser may have sent only one account in the `/api/research-batch` request.
- The saved upload may contain only one unlocked row because the organization was on the 10-account free entitlement and the remaining submitted accounts were locked or never persisted.
- The relevant upload may be paused, duplicated, owned by another user, or not the upload selected by the dashboard.
- Serper/OpenAI/Firecrawl errors, Vercel duration limits, or malformed account rows may have interrupted a live request.
- A stale deployed build may differ from this archive.

## Changes in Sprint 4.3C

- Removed the 50-account research-batch hard cap in favor of a configurable maximum.
- Weekly research now loads the full upload, processes it in bounded chunks, retries transient batch failures, records failed chunks, and continues.
- Added a structured diagnostic summary to batch output and persisted weekly-run summaries.
- Restored customer-account management with explicit Stop Monitoring and Delete Account Data actions.
- Kept destructive uploaded-list deletion separate and confirmed.
- Hid customer-facing research diagnostics while leaving structured diagnostics in API responses, logs, and weekly-run records.
- Added the Arthur J. Gallagher development fixture and live runner.
