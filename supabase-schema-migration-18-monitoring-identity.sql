-- Migration 18: Monitoring Identity V1 -- durable target-level identity
-- anchor, attached once to ha_monitoring_targets, never reinvented per
-- candidate signal. See the Phase 2C grounding-policy design for the full
-- rationale; this migration is intentionally the smallest schema this
-- requires.
--
-- identity_status:
--   'unresolved' (default) -- no account-side identity anchor available yet.
--     A legitimate, common account state, not a failure. Monitoring cycles
--     still run and complete normally for an unresolved target.
--   'derived' -- an identity_domain was derived from account-side evidence
--     (an uploaded website, or a unique non-free-mail business-domain
--     contact email) that existed BEFORE any research candidate was
--     discovered.
--   'confirmed' -- reserved for a future explicit rep-confirmation action.
--     Not written by any code in this migration; the enum value exists now
--     so a later feature does not require a schema change. A target-level
--     'rejected' state is deliberately NOT added here -- a monitored
--     customer itself is never "rejected"; individual candidate
--     identities/signals can be, and that is unaffected by this migration.
--
-- identity_domain: the resolved business domain (normalized: lowercase,
-- no scheme, no "www.", no path), or null.
--
-- identity_domain_source: where identity_domain came from. Deliberately
-- account-side only -- never a discovered candidate/search result. A
-- future rep-confirmed domain is a fourth value this enum already has room
-- for ('rep-confirmed'), not built by this migration.
alter table public.ha_monitoring_targets
  add column if not exists identity_status text not null default 'unresolved'
    check (identity_status in ('unresolved', 'derived', 'confirmed'));

alter table public.ha_monitoring_targets
  add column if not exists identity_domain text;

alter table public.ha_monitoring_targets
  drop constraint if exists ha_monitoring_targets_identity_domain_source_check;

alter table public.ha_monitoring_targets
  add column if not exists identity_domain_source text;

alter table public.ha_monitoring_targets
  add constraint ha_monitoring_targets_identity_domain_source_check
  check (identity_domain_source is null or identity_domain_source in ('uploaded-website', 'contact-derived', 'rep-confirmed'));

alter table public.ha_monitoring_targets
  add column if not exists identity_resolved_at timestamptz;

comment on column public.ha_monitoring_targets.identity_status is
  'unresolved (default, legitimate/common) | derived (from account-side evidence) | confirmed (reserved for future rep confirmation, not yet written by any code)';
comment on column public.ha_monitoring_targets.identity_domain is
  'Normalized business domain (lowercase, no scheme, no www., no path) this target''s identity is anchored to, or null.';
comment on column public.ha_monitoring_targets.identity_domain_source is
  'uploaded-website | contact-derived | rep-confirmed (reserved). Never a discovered candidate/search result -- see resolveTargetIdentity()''s own circularity-guard comment in api/lib/monitoring-identity.js.';
comment on column public.ha_monitoring_targets.identity_resolved_at is
  'When identity_status/identity_domain last actually changed (not touched on a no-op resolution pass).';
