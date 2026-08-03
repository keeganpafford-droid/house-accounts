-- Migration 8 (HA005) — narrow, live-Supabase-safe verification script.
--
-- =============================================================================
-- SAFETY CONTRACT (read before running)
-- =============================================================================
-- - Touches ONLY freshly-INSERTed fixture rows created by this script itself,
--   identified by a per-run random suffix embedded in every fixture's email/
--   name (v_suffix below). Every delete at the end is scoped by the EXACT
--   captured fixture id(s) from this run -- never by LIKE, prefix match, or
--   wildcard, and never by any condition that could match a pre-existing row.
-- - Makes ZERO HTTP calls and ZERO calls to any AI/search provider -- every
--   operation here is a direct SQL/PL-pgSQL call to
--   claim_ha_research_run() / replace_ha_accounts_snapshot(), the same RPCs
--   api/research-batch.js and api/save-upload.js call, but with no network
--   request of any kind involved.
-- - Never reads, writes, or references any existing customer's upload,
--   account, signal, or research-run row. In particular it does NOT touch
--   upload_id 55225cc8-ab4c-490b-a637-f40ddaf7c00e (the corrupted QA Preview
--   upload) or 47382817-d219-4633-b889-6d51c8c60939 (Phase 1) -- this script
--   never references either id anywhere.
-- - Tables this script INSERTS into: public.ha_users, public.ha_uploads,
--   public.ha_accounts (via replace_ha_accounts_snapshot(), not a raw
--   INSERT), public.ha_signals, public.ha_research_runs (via
--   claim_ha_research_run()).
-- - Tables this script DELETES from at the end, each scoped to the exact
--   fixture ids captured during setup: public.ha_signals, public.ha_accounts,
--   public.ha_research_runs, public.ha_uploads, public.ha_users. If the
--   script is interrupted before reaching cleanup, the fixture rows are
--   trivially identifiable (email/upload names containing 'ha005-verify-')
--   for manual removal.
-- - Requires a service_role-equivalent connection (the Supabase SQL editor,
--   or a direct psql connection as the postgres role) -- these RPCs are
--   revoked from anon/authenticated by design (see migration 8 and the
--   grants in supabase-schema.sql), exactly like every other RPC test file
--   in this repo.
-- - Prints PASS/FAIL via RAISE NOTICE, exactly like
--   scripts/phase2a-rpc-authorization-tests.sql. Read the output; a clean
--   run ends with "HA005 LIVE VERIFICATION: N/N PASSED" and
--   "--- fixture cleanup complete ---".
-- =============================================================================
do $$
declare
  v_suffix text := substr(gen_random_uuid()::text, 1, 8);
  v_email text;
  v_user uuid;
  v_upload_a uuid;
  v_upload_b uuid;
  v_claim jsonb;
  v_attempt_id uuid;
  v_run_id text := 'auto';
  v_count int;
  v_industry_check text;
  -- Full-row, byte-for-byte / value-for-value snapshots -- not row counts
  -- or single-column checks. Each captures every column the "unchanged"
  -- proof needs, per table:
  --   ha_accounts:      id, user_id, upload_id, account_name, industry,
  --                      contact_name, contact_email, metrics, raw_data,
  --                      created_at, updated_at (both uploads, every row)
  --   ha_signals:        every column, for every fixture signal row
  --   ha_uploads:        id, user_id, upload_name, stage, summary,
  --                      source_page, created_at, updated_at (Upload A)
  --   ha_research_runs: every column (the one fixture run row)
  v_before_accounts text;
  v_after_accounts text;
  v_before_signals text;
  v_after_signals text;
  v_before_upload text;
  v_after_upload text;
  v_before_run text;
  v_after_run text;
  v_pass int := 0;
  v_fail int := 0;
begin
  v_email := 'ha005-verify-' || v_suffix || '@example.invalid';
  raise notice '=== HA005 live verification starting -- fixture suffix: % (email: %) ===', v_suffix, v_email;

  -- ---------------------------------------------------------------------
  -- Setup: one fixture user, two fixture uploads (A with one real
  -- account, B with two unrelated accounts -- mirrors the exact QA
  -- Preview / Phase 1 shape), plus one fixture signal row on Upload A
  -- (present to prove the "signals unchanged" assertion directly, not
  -- just by inference -- replace_ha_accounts_snapshot() never touches
  -- ha_signals at all, so this is a hard structural guarantee, verified
  -- explicitly anyway).
  -- ---------------------------------------------------------------------
  insert into public.ha_users (email, name) values (v_email, 'HA005 Verify Fixture') returning id into v_user;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'ha005-verify-upload-a-' || v_suffix, 'uploaded') returning id into v_upload_a;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'ha005-verify-upload-b-' || v_suffix, 'uploaded') returning id into v_upload_b;

  perform public.replace_ha_accounts_snapshot(v_upload_a, v_user, '[{"account_name":"HA005 Verify Alpha"}]'::jsonb, 'initial_upload');
  perform public.replace_ha_accounts_snapshot(v_upload_b, v_user, '[{"account_name":"HA005 Verify Beta One"},{"account_name":"HA005 Verify Beta Two"}]'::jsonb, 'initial_upload');
  insert into public.ha_signals (user_id, upload_id, account_name, signal_hash, event_fingerprint, signal_type, title, confidence, first_seen_at, last_seen_at)
    values (v_user, v_upload_a, 'HA005 Verify Alpha', 'ha005-verify-hash-' || v_suffix, 'ha005-verify-fp-' || v_suffix, 'Hiring', 'Fixture signal', 60, now(), now());

  v_claim := public.claim_ha_research_run(v_user, v_upload_a, v_run_id, 300);
  v_attempt_id := (v_claim->'run'->>'attempt_id')::uuid;
  if v_claim->>'outcome' = 'claimed-new' then
    v_pass := v_pass + 1; raise notice 'PASS: setup -- fixture research run claimed cleanly';
  else
    v_fail := v_fail + 1; raise notice 'FAIL: setup -- expected claimed-new, got %', v_claim;
  end if;

  -- ---------------------------------------------------------------------
  -- Test 1: exact tracked-research account-set equality succeeds.
  -- ---------------------------------------------------------------------
  begin
    perform public.replace_ha_accounts_snapshot(
      v_upload_a, v_user,
      '[{"account_name":"HA005 Verify Alpha","industry":"Verified"}]'::jsonb,
      'tracked_research', v_run_id, v_attempt_id
    );
    select count(*) into v_count from public.ha_accounts where upload_id = v_upload_a;
    if v_count = 1 then v_pass := v_pass + 1; raise notice 'PASS: Test 1 -- exact-match tracked-research save succeeds; Upload A still has exactly 1 account';
    else v_fail := v_fail + 1; raise notice 'FAIL: Test 1 -- expected 1 account, got %', v_count; end if;
  exception when others then
    v_fail := v_fail + 1; raise notice 'FAIL: Test 1 -- exact-match save unexpectedly raised % (%)', sqlstate, sqlerrm;
  end;

  -- Snapshot everything the three rejected calls below must leave
  -- untouched: FULL rows, not row counts or single columns -- see the
  -- declare block's comment for the exact column list per table.
  select coalesce(array_agg(row(id, user_id, upload_id, account_name, industry, contact_name, contact_email, metrics, raw_data, created_at, updated_at)::text order by upload_id, account_name), array[]::text[])::text
    into v_before_accounts from public.ha_accounts where upload_id in (v_upload_a, v_upload_b);
  select coalesce(array_agg(row(id, user_id, upload_id, weekly_run_id, account_name, signal_hash, event_fingerprint, signal_type, title, why_reach_out, confidence, source_url, source_domain, published_at, payload, first_seen_at, last_seen_at)::text order by id), array[]::text[])::text
    into v_before_signals from public.ha_signals where upload_id = v_upload_a;
  select row(id, user_id, upload_name, stage, summary, source_page, created_at, updated_at)::text
    into v_before_upload from public.ha_uploads where id = v_upload_a;
  select row(id, research_run_id, user_id, upload_id, status, attempt_id, attempt_count, lease_expires_at, heartbeat_at, started_at, completed_at, result_summary, error_message, created_at)::text
    into v_before_run from public.ha_research_runs where upload_id = v_upload_a and research_run_id = v_run_id;

  -- ---------------------------------------------------------------------
  -- Test 2: an ADDED, foreign (Upload B) account name -> HA005.
  -- ---------------------------------------------------------------------
  begin
    perform public.replace_ha_accounts_snapshot(
      v_upload_a, v_user,
      '[{"account_name":"HA005 Verify Alpha"},{"account_name":"HA005 Verify Beta One"}]'::jsonb,
      'tracked_research', v_run_id, v_attempt_id
    );
    v_fail := v_fail + 1; raise notice 'FAIL: Test 2 -- a foreign account name was accepted, no exception raised';
  exception when others then
    if sqlstate = 'HA005' then v_pass := v_pass + 1; raise notice 'PASS: Test 2 -- adding a foreign (Upload B) account name is rejected with HA005';
    else v_fail := v_fail + 1; raise notice 'FAIL: Test 2 -- rejected, but with unexpected sqlstate % (%)', sqlstate, sqlerrm; end if;
  end;

  -- ---------------------------------------------------------------------
  -- Test 3: a MISSING account (empty submission) -> HA005.
  -- ---------------------------------------------------------------------
  begin
    perform public.replace_ha_accounts_snapshot(v_upload_a, v_user, '[]'::jsonb, 'tracked_research', v_run_id, v_attempt_id);
    v_fail := v_fail + 1; raise notice 'FAIL: Test 3 -- an empty account submission was accepted, no exception raised';
  exception when others then
    if sqlstate = 'HA005' then v_pass := v_pass + 1; raise notice 'PASS: Test 3 -- submitting zero accounts (removing the existing one) is rejected with HA005';
    else v_fail := v_fail + 1; raise notice 'FAIL: Test 3 -- rejected, but with unexpected sqlstate % (%)', sqlstate, sqlerrm; end if;
  end;

  -- ---------------------------------------------------------------------
  -- Test 4: a RENAMED account -> HA005.
  -- ---------------------------------------------------------------------
  begin
    perform public.replace_ha_accounts_snapshot(
      v_upload_a, v_user,
      '[{"account_name":"HA005 Verify Alpha Renamed"}]'::jsonb,
      'tracked_research', v_run_id, v_attempt_id
    );
    v_fail := v_fail + 1; raise notice 'FAIL: Test 4 -- a renamed account name was accepted, no exception raised';
  exception when others then
    if sqlstate = 'HA005' then v_pass := v_pass + 1; raise notice 'PASS: Test 4 -- renaming the account is rejected with HA005';
    else v_fail := v_fail + 1; raise notice 'FAIL: Test 4 -- rejected, but with unexpected sqlstate % (%)', sqlstate, sqlerrm; end if;
  end;

  -- ---------------------------------------------------------------------
  -- Prove all three rejections above changed NOTHING: full-row,
  -- value-for-value comparisons across accounts (both uploads), signals,
  -- upload state, and run state -- not row counts or single columns.
  -- ---------------------------------------------------------------------
  select coalesce(array_agg(row(id, user_id, upload_id, account_name, industry, contact_name, contact_email, metrics, raw_data, created_at, updated_at)::text order by upload_id, account_name), array[]::text[])::text
    into v_after_accounts from public.ha_accounts where upload_id in (v_upload_a, v_upload_b);
  select coalesce(array_agg(row(id, user_id, upload_id, weekly_run_id, account_name, signal_hash, event_fingerprint, signal_type, title, why_reach_out, confidence, source_url, source_domain, published_at, payload, first_seen_at, last_seen_at)::text order by id), array[]::text[])::text
    into v_after_signals from public.ha_signals where upload_id = v_upload_a;
  select row(id, user_id, upload_name, stage, summary, source_page, created_at, updated_at)::text
    into v_after_upload from public.ha_uploads where id = v_upload_a;
  select row(id, research_run_id, user_id, upload_id, status, attempt_id, attempt_count, lease_expires_at, heartbeat_at, started_at, completed_at, result_summary, error_message, created_at)::text
    into v_after_run from public.ha_research_runs where upload_id = v_upload_a and research_run_id = v_run_id;

  if v_after_accounts = v_before_accounts then v_pass := v_pass + 1; raise notice 'PASS: Test 5 -- ha_accounts (both uploads; id, user_id, upload_id, account_name, industry, contact_name, contact_email, metrics, raw_data, created_at, updated_at) is byte-for-byte identical after all 3 rejected calls';
  else v_fail := v_fail + 1; raise notice 'FAIL: Test 5 -- ha_accounts changed. Before: % After: %', v_before_accounts, v_after_accounts; end if;

  if v_after_signals = v_before_signals then v_pass := v_pass + 1; raise notice 'PASS: Test 6 -- ha_signals (every column, every fixture signal row on Upload A) is value-for-value identical after all 3 rejected calls';
  else v_fail := v_fail + 1; raise notice 'FAIL: Test 6 -- ha_signals changed. Before: % After: %', v_before_signals, v_after_signals; end if;

  if v_after_upload = v_before_upload then v_pass := v_pass + 1; raise notice 'PASS: Test 7 -- ha_uploads (id, user_id, upload_name, stage, summary, source_page, created_at, updated_at) for Upload A is value-for-value identical after all 3 rejected calls';
  else v_fail := v_fail + 1; raise notice 'FAIL: Test 7 -- ha_uploads changed. Before: % After: %', v_before_upload, v_after_upload; end if;

  if v_after_run = v_before_run then v_pass := v_pass + 1; raise notice 'PASS: Test 8 -- ha_research_runs (the complete fixture row: status, attempt_id, attempt_count, lease_expires_at, heartbeat_at, started_at, completed_at, result_summary, error_message, created_at) is value-for-value identical after all 3 rejected calls -- the attempt was never finalized as successfully persisted';
  else v_fail := v_fail + 1; raise notice 'FAIL: Test 8 -- ha_research_runs changed. Before: % After: %', v_before_run, v_after_run; end if;

  -- Bonus: duplicate-name dedup still works and does not false-positive
  -- HA005 (same check as the local suite's Test 63), confirming migration
  -- 8 behaves identically live.
  begin
    perform public.replace_ha_accounts_snapshot(
      v_upload_a, v_user,
      '[{"account_name":"HA005 Verify Alpha","industry":"First"},{"account_name":"HA005 Verify Alpha","industry":"Second (wins)"}]'::jsonb,
      'tracked_research', v_run_id, v_attempt_id
    );
    select industry into v_industry_check from public.ha_accounts where upload_id = v_upload_a and account_name = 'HA005 Verify Alpha';
    if v_industry_check = 'Second (wins)' then v_pass := v_pass + 1; raise notice 'PASS: Test 9 -- duplicate incoming rows for the same existing name are deduplicated before comparison, no false-positive HA005';
    else v_fail := v_fail + 1; raise notice 'FAIL: Test 9 -- expected industry=Second (wins), got %', v_industry_check; end if;
  exception when others then
    v_fail := v_fail + 1; raise notice 'FAIL: Test 9 -- duplicate-name submission for an EXISTING account unexpectedly raised % (%)', sqlstate, sqlerrm;
  end;

  -- ---------------------------------------------------------------------
  -- Cleanup -- every delete scoped to the exact fixture ids captured
  -- above. Nothing here can match a pre-existing row.
  -- ---------------------------------------------------------------------
  delete from public.ha_signals where upload_id in (v_upload_a, v_upload_b);
  delete from public.ha_accounts where upload_id in (v_upload_a, v_upload_b);
  delete from public.ha_research_runs where upload_id in (v_upload_a, v_upload_b);
  delete from public.ha_uploads where id in (v_upload_a, v_upload_b);
  delete from public.ha_users where id = v_user;
  raise notice '--- fixture cleanup complete (user %, uploads %, %) ---', v_user, v_upload_a, v_upload_b;

  raise notice 'HA005 LIVE VERIFICATION: %/% PASSED', v_pass, (v_pass + v_fail);
  if v_fail > 0 then
    raise exception 'HA005 live verification had % failure(s) -- see NOTICEs above', v_fail;
  end if;
end $$;
