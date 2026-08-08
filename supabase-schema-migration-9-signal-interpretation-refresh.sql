-- Migration 9: re-research must refresh a canonical event's commercial
-- interpretation, not silently preserve the first one forever.
--
-- =============================================================================
-- 1. WHAT THIS CLOSES
-- =============================================================================
-- persist_ha_research_output() (migration 6, re-issued unchanged in
-- migration 7 §8) inserts ha_signals with
-- `on conflict (user_id, event_fingerprint) do nothing`. That is correct
-- identity/notification behavior -- a retried/duplicate save for an event
-- already known must never look like a second discovery -- but it ALSO
-- meant that re-researching an already-known event (the interactive
-- "Research Account"/"Research All" flow, which always goes through this
-- RPC) could NEVER refresh commercialPlay/activationIdeas/
-- expansionPotential/conversationStarter/relatedPurchase, even when the
-- new research produced materially better commercial intelligence. The
-- founder confirmed this explains why re-researched accounts (Dover Honda,
-- Catalyst Investment Partners) kept showing pre-correction-round
-- interpretations after prompt/policy changes that should have improved
-- them -- the write was silently discarded every time, forever.
--
-- api/save-upload.js's OWN untracked-path insert and api/weekly-scan.js's
-- plain-REST insert already had this same fix applied at the JS/PostgREST
-- level (a second, explicit `resolution=merge-duplicates` upsert) in the
-- prior QA correction round. This migration is the equivalent fix for the
-- ONE remaining path that could not be fixed at the application layer: the
-- attempt-guarded RPC used by the interactive research flow.
--
-- =============================================================================
-- 2. THE INVARIANT
-- =============================================================================
-- event_fingerprint remains the stable identity of the factual event.
-- Re-researching that event refreshes the CURRENT INTERPRETATION attached
-- to it -- it never creates a second row for the same event, and it never
-- silently discards the new interpretation. Concretely:
--   same event identity + newer commercial intelligence
--     = update the existing signal's payload (and the handful of top-level
--       columns mirroring it -- see api/get-dashboard.js's rowToSignal(),
--       which prefers the top-level column over the JSONB payload field for
--       title/why_reach_out/etc., so both must move together or a refresh
--       would look partial to readers)
--   NEVER creates another event, NEVER silently discards the refresh.
--
-- =============================================================================
-- 3. EXACTLY WHAT CHANGES: ON CONFLICT DO NOTHING -> DO UPDATE, ONE
--    STATEMENT, xmax TRICK PRESERVES "genuinely new" COUNTING
-- =============================================================================
-- Only the `on conflict` clause of the ha_signals insert changes. Refreshed
-- (interpretation) columns: signal_hash, signal_type, title, why_reach_out,
-- confidence, source_url, source_domain, published_at, payload,
-- last_seen_at -- exactly the founder-approved allowlist, identical to the
-- refreshableSignalRow() allowlist already applied at the JS/PostgREST
-- layer in api/save-upload.js and api/weekly-scan.js. NEVER refreshed:
--   - user_id, event_fingerprint -- the conflict target itself; identity,
--     must stay stable by construction (an UPDATE can never change the
--     columns it matched on).
--   - first_seen_at -- when we first learned about this event. Refreshing
--     interpretation must never look like rediscovering the event.
--   - upload_id, account_name -- conservative per explicit instruction: no
--     concrete correctness reason to move a signal to a different upload or
--     rename its account merely because it was re-researched (account_name
--     for a given user+event_fingerprint does not change across a
--     re-research call in the current architecture; upload_id reassignment
--     was explicitly flagged as an unintended side effect risk in the prior
--     round's investigation -- re-scoping which uploaded list "owns" an
--     event is a separate, undecided product question, not something this
--     migration should silently resolve).
--
-- v_signals_persisted must keep meaning "genuinely NEW rows" (the
-- pre-existing contract api/save-upload.js's response and
-- result_summary.signalsPersisted/signalsConflictIgnored already depend
-- on) even though the INSERT now always matches every submitted row one
-- way or another. Postgres's `xmax = 0` on the RETURNING row is true only
-- for a row this statement itself INSERTED (its xmax system column is
-- still unset) and false for a row it only UPDATED (xmax is set to the
-- current transaction's id) -- exactly the "inserted vs. updated" signal
-- needed, in the SAME statement, no second round-trip required.
--
-- =============================================================================
-- 4. NOTIFICATION/DIGEST IDEMPOTENCY -- TRACED, CONFIRMED UNAFFECTED
-- =============================================================================
-- ha_signals carries NO notified/digest-state/first-surfaced column at all
-- (see supabase-schema.sql's table definition -- id, user_id, upload_id,
-- weekly_run_id, account_name, signal_hash, event_fingerprint, signal_type,
-- title, why_reach_out, confidence, source_url, source_domain,
-- published_at, payload, first_seen_at, last_seen_at; nothing else).
-- Notification/digest idempotency lives entirely in application code, and
-- entirely OUTSIDE this RPC:
--   - api/weekly-scan.js never calls persist_ha_research_output() at all --
--     it does its own plain-REST ha_signals upsert (already fixed at the
--     JS layer last round) and derives its digest-eligible "genuinely new"
--     set (newSignalRows) EXCLUSIVELY from its OWN ignore-duplicates call's
--     return value, never from the merge-duplicates refresh call's return
--     value. This RPC is not in that call chain at all -- untouched by this
--     migration, by construction, not merely by care.
--   - api/save-upload.js (this RPC's only caller) sends no digest/
--     notification email at all for the interactive tracked-research path;
--     the response's signalsPersisted/signalsConflictIgnored counters are
--     the only consumer of "was this genuinely new," and the xmax trick
--     above preserves their exact pre-existing meaning.
-- Conclusion: there is no notified/digest state on or around ha_signals for
-- this migration to preserve beyond what is already preserved by (a) never
-- touching first_seen_at and (b) keeping v_signals_persisted counting only
-- genuine inserts. No new regression test category is needed beyond the
-- refresh-semantics and stale-attempt tests below, which already assert
-- first_seen_at is unchanged and persisted-vs-refreshed counts stay
-- correct.
--
-- =============================================================================
-- 5. STALE-ATTEMPT PROTECTION -- UNCHANGED, VERIFIED STILL SUFFICIENT
-- =============================================================================
-- The attempt-validation UPDATE (renews the lease and proves p_attempt_id
-- is still the current, running attempt for this research_run_id) runs
-- BEFORE this function ever reaches the accounts or signals writes, inside
-- the SAME transaction, holding the SAME pg_advisory_xact_lock(upload_id)
-- for the upload the whole time (migration 6 §3, unchanged by this
-- migration). A stale/superseded attempt fails that check and the entire
-- call raises HA001 before the modified INSERT ever runs -- this migration
-- adds no new code path that could let a rejected call's signal payload
-- reach the table. The advisory lock also serializes every call for the
-- same upload_id, so two attempts for the same upload can never interleave;
-- whichever one is current when a later one's attempt-validation UPDATE
-- runs is the only one whose writes ever land. Verified by (new) test 68
-- below: a stale attempt whose lease already expired, arriving AFTER a
-- reclaimed attempt has already refreshed the same event_fingerprint's
-- payload, is rejected exactly as before, and the refreshed payload is
-- left completely untouched by the rejected call.
--
-- =============================================================================
-- 6. WHY THIS IS A NEW MIGRATION, NOT ANOTHER REVISION OF 6/7
-- =============================================================================
-- Migrations 6 and 7 have each already been applied to the live database
-- (migration 7's own header note: migration 6's body, "as corrected," is
-- ALREADY DEPLOYED). Revising either file in place would not change
-- anything already running; a new migration is required to change deployed
-- function behavior, exactly the same reasoning migration 7 itself
-- documented for superseding migration 6. This migration carries FORWARD
-- migration 7's complete, current body (mode='tracked_research' passed to
-- replace_ha_accounts_snapshot(), the lease_expires_at > now() attempt
-- check) with the ON CONFLICT change as the ONLY functional difference --
-- re-issuing an older base here would silently regress those already-
-- deployed corrections the moment this migration is applied.
-- =============================================================================
create or replace function public.persist_ha_research_output(
  p_upload_id uuid,
  p_user_id uuid,
  p_research_run_id text,
  p_attempt_id uuid,
  p_accounts jsonb default null,
  p_signals jsonb default null,
  p_upload_stage text default null,
  p_upload_summary jsonb default null,
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_run public.ha_research_runs;
  v_accounts_result public.ha_accounts[];
  v_accounts_count int := 0;
  v_signals_attempted int := 0;
  v_signals_persisted int := 0;
begin
  perform pg_advisory_xact_lock(hashtext(p_upload_id::text));

  if not exists (
    select 1 from public.ha_uploads where id = p_upload_id and user_id = p_user_id
  ) then
    raise exception 'persist_ha_research_output: upload % does not belong to user % (or does not exist)', p_upload_id, p_user_id
      using errcode = '42501';
  end if;

  -- Attempt validation + atomic lease renewal, UNCHANGED from migration 7 --
  -- see §5 above. This is what makes the DO UPDATE change below safe: a
  -- stale/replaced attempt never reaches it.
  update public.ha_research_runs
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 300), 900)))
  where user_id = p_user_id
    and upload_id = p_upload_id
    and research_run_id = p_research_run_id
    and attempt_id = p_attempt_id
    and status = 'running'
    and lease_expires_at > now()
  returning * into v_run;

  if not found then
    raise exception 'persist_ha_research_output: attempt % for run % is no longer the active attempt for upload % (reclaimed, completed, failed, or its lease had already expired)', p_attempt_id, p_research_run_id, p_upload_id
      using errcode = 'HA001';
  end if;

  if p_accounts is not null then
    select array_agg(a) into v_accounts_result
    from public.replace_ha_accounts_snapshot(p_upload_id, p_user_id, p_accounts, 'tracked_research', p_research_run_id, p_attempt_id) a;
    v_accounts_count := coalesce(array_length(v_accounts_result, 1), 0);
  end if;

  if p_signals is not null and jsonb_typeof(p_signals) = 'array' and jsonb_array_length(p_signals) > 0 then
    v_signals_attempted := (
      select count(*) from jsonb_array_elements(p_signals) s
      where nullif(s->>'event_fingerprint', '') is not null
    );
    -- Migration 9: ON CONFLICT DO NOTHING -> DO UPDATE for exactly the
    -- interpretation columns (§3 above). user_id/event_fingerprint are the
    -- conflict target (cannot change by construction); first_seen_at,
    -- upload_id, account_name are deliberately absent from the SET list.
    -- `(xmax = 0)` distinguishes a genuinely-inserted row from a row this
    -- statement only updated, in the same statement -- see §3.
    with upserted as (
      insert into public.ha_signals (
        user_id, upload_id, account_name, signal_hash, event_fingerprint,
        signal_type, title, why_reach_out, confidence, source_url,
        source_domain, published_at, payload, first_seen_at, last_seen_at
      )
      select
        p_user_id,
        p_upload_id,
        nullif(btrim(s->>'account_name'), ''),
        s->>'signal_hash',
        s->>'event_fingerprint',
        nullif(s->>'signal_type', ''),
        nullif(s->>'title', ''),
        nullif(s->>'why_reach_out', ''),
        nullif(s->>'confidence', '')::numeric,
        nullif(s->>'source_url', ''),
        nullif(s->>'source_domain', ''),
        nullif(s->>'published_at', ''),
        coalesce(s->'payload', '{}'::jsonb),
        now(),
        now()
      from jsonb_array_elements(p_signals) as s
      where nullif(s->>'event_fingerprint', '') is not null
      on conflict (user_id, event_fingerprint) do update set
        signal_hash = excluded.signal_hash,
        signal_type = excluded.signal_type,
        title = excluded.title,
        why_reach_out = excluded.why_reach_out,
        confidence = excluded.confidence,
        source_url = excluded.source_url,
        source_domain = excluded.source_domain,
        published_at = excluded.published_at,
        payload = excluded.payload,
        last_seen_at = excluded.last_seen_at
      returning (xmax = 0) as inserted
    )
    select count(*) filter (where inserted) into v_signals_persisted from upserted;
  end if;

  if p_upload_stage is not null or p_upload_summary is not null then
    update public.ha_uploads
    set stage = coalesce(p_upload_stage, stage),
        summary = coalesce(p_upload_summary, summary),
        updated_at = now()
    where id = p_upload_id;
  end if;

  -- Finalization, UNCHANGED from migration 6/7.
  update public.ha_research_runs
  set status = 'completed',
      completed_at = now(),
      result_summary = jsonb_build_object(
        'accountsPersisted', v_accounts_count,
        'signalsAttempted', v_signals_attempted,
        'signalsPersisted', v_signals_persisted,
        'signalsConflictIgnored', greatest(0, v_signals_attempted - v_signals_persisted)
      ),
      heartbeat_at = now(),
      lease_expires_at = now()
  where id = v_run.id
    and attempt_id = p_attempt_id
  returning * into v_run;

  if not found then
    raise exception 'persist_ha_research_output: finalization update for attempt % / run % matched no row -- the locking invariant this function depends on was violated', p_attempt_id, p_research_run_id
      using errcode = 'HA002';
  end if;

  return jsonb_build_object(
    'accountsPersisted', v_accounts_count,
    'signalsAttempted', v_signals_attempted,
    'signalsPersisted', v_signals_persisted,
    'signalsConflictIgnored', greatest(0, v_signals_attempted - v_signals_persisted),
    'status', v_run.status,
    'completedAt', v_run.completed_at,
    'attemptId', v_run.attempt_id
  );
end;
$$;

revoke all on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) from public;
revoke all on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) from anon;
revoke all on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) from authenticated;
grant execute on function public.persist_ha_research_output(uuid, uuid, text, uuid, jsonb, jsonb, text, jsonb, integer) to service_role;
