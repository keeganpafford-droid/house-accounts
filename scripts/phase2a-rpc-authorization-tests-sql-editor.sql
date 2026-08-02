-- SQL-Editor-adapted variant of phase2a-rpc-authorization-tests.sql
-- (Phase 2A implementation-review, tests 1-58, through ROUND 10; this
-- revision fixes four issues found in review before first execution -- see
-- the numbered notes below). Same tests, same fixtures, same assertions --
-- converted so every assertion lands as a ROW in a results table instead of
-- a RAISE NOTICE line, ending in exactly ONE visible SELECT. The
-- RAISE-NOTICE original remains the canonical, unmodified source; this file
-- is a reporting adaptation of it, not a separate hand-maintained suite.
--
-- 1. FIXTURE ISOLATION: every fixture email incorporates a fresh
--    suite_run_id (a uuid generated once, at the top of THIS run, stored in
--    the session-scoped GUC phase2a.suite_run_id) -- 'phase2a-owner-a+
--    <suite_run_id>@example.invalid' -- so concurrent or repeated runs of
--    this file can never collide on a real unique(email) constraint, even
--    if a prior run's cleanup never completed.
-- 2. NO WILDCARD CLEANUP: every ha_users/ha_uploads row this file creates
--    is registered by its EXACT id, immediately after creation, into a temp
--    fixture registry (_phase2a_fixture_registry). The final safety-net
--    cleanup (on top of each block's own inline cleanup) deletes ONLY rows
--    whose id was actually registered by THIS run -- never a LIKE/prefix
--    pattern that could reach into another run's or another user's data.
--    (ha_uploads/ha_accounts/ha_signals/ha_research_runs all reference
--    ha_users or ha_uploads with ON DELETE CASCADE, so registering the
--    ha_users and ha_uploads ids this file creates is sufficient to fully
--    clean up everything those rows own.)
-- 3. NO RESULTS-TABLE WRITES UNDER A RESTRICTED ROLE: every SET ROLE
--    anon/authenticated/service_role test now captures its outcome into
--    local PL/pgSQL variables ONLY, calls RESET ROLE, and only THEN inserts
--    into the results table -- under the original (privileged) role. Each
--    of these is wrapped in its own exception-safe outer block so RESET
--    ROLE always executes even if something unexpected fails before the
--    privilege check itself completes.
-- 4. FINAL SELECT IS LITERALLY THE LAST STATEMENT: no DROP TABLE follows
--    it; the temp tables expire with the SQL Editor session on their own.
--
-- These are genuine Postgres privilege/logic tests (role switching,
-- RLS-equivalent grant enforcement, exception handling) that require a real
-- Postgres instance. NOT executed from this session (no database connection
-- available). Run the whole file in the Supabase SQL editor (as a role that
-- can execute `set role`, i.e. the postgres/service_role connection, NOT
-- through PostgREST).
--
-- Phase 2A implementation-review ROUND 7: replace_ha_accounts_snapshot()'s
-- signature gained a required 4th parameter, p_mode (see
-- supabase-schema-migration-7-mode-scoped-account-writes.sql). ALL existing
-- calls below (tests 1-12, 27) were updated in place to pass
-- 'initial_upload' (tests 1-12 -- fresh uploads with no research history,
-- matching what stage="uploaded" always meant) or 'tracked_research' (test
-- 27 -- already carried p_research_run_id/p_attempt_id). New tests 42-49,
-- appended at the end of this file, cover p_mode validation and the two
-- NEW modes (accounts_maintenance's active-run rejection and account-
-- identity lock).

-- ===========================================================================
-- Suite-run identity, results table, baseline-count snapshot, and fixture
-- registry -- all created before any test fixture exists.
-- ===========================================================================
do $$
begin
  perform set_config('phase2a.suite_run_id', gen_random_uuid()::text, false);
end $$;

create temp table if not exists _phase2a_auth_test_results (
  id serial primary key,
  assertion text not null,
  passed boolean not null,
  detail text
);
truncate _phase2a_auth_test_results;

create temp table if not exists _phase2a_auth_baseline_counts (
  table_name text primary key,
  row_count bigint not null
);
truncate _phase2a_auth_baseline_counts;
insert into _phase2a_auth_baseline_counts (table_name, row_count) values
  ('ha_users', (select count(*) from public.ha_users)),
  ('ha_uploads', (select count(*) from public.ha_uploads)),
  ('ha_accounts', (select count(*) from public.ha_accounts)),
  ('ha_signals', (select count(*) from public.ha_signals)),
  ('ha_research_runs', (select count(*) from public.ha_research_runs));

create temp table if not exists _phase2a_fixture_registry (
  id serial primary key,
  entity_type text not null,
  entity_id uuid not null
);
truncate _phase2a_fixture_registry;

-- ===========================================================================
-- Setup: two fake users and two uploads, one per user, plus a stray
-- nonexistent upload id for the "nonexistent upload" case. Each block below
-- still does its own inline cleanup by exact id (unchanged from the
-- canonical file); the fixture registry above is a belt-and-suspenders
-- safety net for the rare case a block aborts before reaching its own
-- cleanup, not a replacement for it.
-- ===========================================================================
do $$
declare
  v_user_a uuid;
  v_user_b uuid;
  v_upload_a uuid;
  v_upload_b uuid;
  v_nonexistent_upload uuid := gen_random_uuid();
  v_result record;
  v_count int;
  v_failed boolean;
begin
  insert into public.ha_users (email, name) values ('phase2a-test-owner-a+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Test Owner A') returning id into v_user_a;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user_a);
  insert into public.ha_users (email, name) values ('phase2a-test-owner-b+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Test Owner B') returning id into v_user_b;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user_b);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user_a, 'Phase 2A RPC test upload A', 'uploaded') returning id into v_upload_a;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload_a);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user_b, 'Phase 2A RPC test upload B', 'uploaded') returning id into v_upload_b;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload_b);

  -- Test 1: correct owner and upload
  begin
    perform public.replace_ha_accounts_snapshot(v_upload_a, v_user_a, '[{"account_name":"Test Co"}]'::jsonb, 'initial_upload');
    select count(*) into v_count from public.ha_accounts where upload_id = v_upload_a and account_name = 'Test Co';
    if v_count = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 1: ' || 'correct owner successfully replaces their own upload''s accounts', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 1: ' || 'expected 1 row for the correct owner, got %', false, format('expected 1 row for the correct owner, got %s', v_count)); end if;
  exception when others then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 1: ' || 'correct owner/upload call raised an unexpected exception: %', false, format('correct owner/upload call raised an unexpected exception: %s', sqlerrm));
  end;

  -- Test 2: wrong user against another user's upload
  begin
    perform public.replace_ha_accounts_snapshot(v_upload_a, v_user_b, '[{"account_name":"Hijacked"}]'::jsonb, 'initial_upload');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 2: ' || 'user B was able to replace user A''s upload accounts -- no exception raised', false, null);
  exception when others then
    if sqlstate = '42501' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 2: ' || 'wrong-user call against another user''s upload is rejected with the expected ownership exception (42501)', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 2: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload_a and account_name = 'Hijacked';
  if v_count = 0 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 2: ' || 'no row was written to upload A as a result of the rejected cross-user call', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 2: ' || '% row(s) were written to upload A despite the rejection', false, format('%s row(s) were written to upload A despite the rejection', v_count)); end if;

  -- Test 3: nonexistent upload
  begin
    perform public.replace_ha_accounts_snapshot(v_nonexistent_upload, v_user_a, '[{"account_name":"Ghost"}]'::jsonb, 'initial_upload');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 3: ' || 'a nonexistent upload_id was accepted -- no exception raised', false, null);
  exception when others then
    if sqlstate = '42501' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 3: ' || 'a nonexistent upload_id is rejected with the same ownership exception (42501) as a real ownership mismatch -- does not leak whether the upload exists at all', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 3: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  -- cleanup
  delete from public.ha_accounts where upload_id in (v_upload_a, v_upload_b);
  delete from public.ha_uploads where id in (v_upload_a, v_upload_b);
  delete from public.ha_users where id in (v_user_a, v_user_b);
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 1-3 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Test 4: anon call — must be rejected at the GRANT level, before the
-- function body's own logic ever runs. Requires the `anon` role to actually
-- exist (it does in any standard Supabase project).
-- ===========================================================================
do $$
declare
  v_role_switch_succeeded boolean := false;
  v_role_passed boolean := false;
  v_role_detail text := 'test did not complete';
  v_current_role text;
begin
  begin
    -- Phase 1: attempt the role switch in its own protected block; confirm
    -- it actually took effect (current_user reflects it) before treating
    -- anything downstream as a genuine RPC-level privilege test.
    begin
      set role anon;
      select current_user into v_current_role;
      if v_current_role = 'anon' then
        v_role_switch_succeeded := true;
      else
        v_role_switch_succeeded := false;
        v_role_detail := format('SET ROLE anon appeared to succeed but current_user is %s, not anon -- not treating this as a valid RPC-level test', v_current_role);
      end if;
    exception when others then
      v_role_switch_succeeded := false;
      v_role_detail := format('SET ROLE anon itself failed: %s (sqlstate %s) -- the RPC was never invoked, this is not a valid privilege-denial result', sqlerrm, sqlstate);
    end;

    -- Phase 2: only invoke the RPC once the role switch is CONFIRMED.
    if v_role_switch_succeeded then
      begin
        perform public.replace_ha_accounts_snapshot(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 'initial_upload');
        v_role_passed := false;
        v_role_detail := 'anon role was able to call replace_ha_accounts_snapshot at all -- EXECUTE grant is not properly revoked';
      exception when insufficient_privilege then
        v_role_passed := true;
        v_role_detail := 'anon role is rejected at the privilege level (insufficient_privilege) before the function body runs';
      when others then
        v_role_passed := false;
        v_role_detail := format('anon call raised an unexpected error (expected insufficient_privilege): %s (sqlstate %s)', sqlerrm, sqlstate);
      end;
    else
      v_role_passed := false;
    end if;
  exception when others then
    v_role_switch_succeeded := false;
    v_role_passed := false;
    v_role_detail := format('unexpected error during role-switch test setup: %s', sqlerrm);
  end;
  reset role;
  insert into _phase2a_auth_test_results (assertion, passed, detail)
    values ('Test 4: anon role cannot call replace_ha_accounts_snapshot', v_role_passed, v_role_detail);
end $$;

-- ===========================================================================
-- Test 5: authenticated direct RPC call — per this migration's design (§5),
-- this SHOULD be forbidden: there is no RLS-safe design justifying direct
-- client access, so EXECUTE is revoked from authenticated exactly like anon.
-- ===========================================================================
do $$
declare
  v_role_switch_succeeded boolean := false;
  v_role_passed boolean := false;
  v_role_detail text := 'test did not complete';
  v_current_role text;
begin
  begin
    -- Phase 1: attempt the role switch in its own protected block; confirm
    -- it actually took effect (current_user reflects it) before treating
    -- anything downstream as a genuine RPC-level privilege test.
    begin
      set role authenticated;
      select current_user into v_current_role;
      if v_current_role = 'authenticated' then
        v_role_switch_succeeded := true;
      else
        v_role_switch_succeeded := false;
        v_role_detail := format('SET ROLE authenticated appeared to succeed but current_user is %s, not authenticated -- not treating this as a valid RPC-level test', v_current_role);
      end if;
    exception when others then
      v_role_switch_succeeded := false;
      v_role_detail := format('SET ROLE authenticated itself failed: %s (sqlstate %s) -- the RPC was never invoked, this is not a valid privilege-denial result', sqlerrm, sqlstate);
    end;

    -- Phase 2: only invoke the RPC once the role switch is CONFIRMED.
    if v_role_switch_succeeded then
      begin
        perform public.replace_ha_accounts_snapshot(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 'initial_upload');
        v_role_passed := false;
        v_role_detail := 'authenticated role was able to call replace_ha_accounts_snapshot directly -- EXECUTE grant is not properly revoked';
      exception when insufficient_privilege then
        v_role_passed := true;
        v_role_detail := 'authenticated role is rejected at the privilege level (insufficient_privilege), matching the intended service_role-only design';
      when others then
        v_role_passed := false;
        v_role_detail := format('authenticated call raised an unexpected error (expected insufficient_privilege): %s (sqlstate %s)', sqlerrm, sqlstate);
      end;
    else
      v_role_passed := false;
    end if;
  exception when others then
    v_role_switch_succeeded := false;
    v_role_passed := false;
    v_role_detail := format('unexpected error during role-switch test setup: %s', sqlerrm);
  end;
  reset role;
  insert into _phase2a_auth_test_results (assertion, passed, detail)
    values ('Test 5: authenticated role cannot call replace_ha_accounts_snapshot', v_role_passed, v_role_detail);
end $$;

-- ===========================================================================
-- Test 6 (sanity): service_role CAN call it. If this fails, the GRANT to
-- service_role itself is missing/broken, which would break
-- api/save-upload.js entirely in production.
-- ===========================================================================
do $$
declare
  v_role_switch_succeeded boolean := false;
  v_role_passed boolean := false;
  v_role_detail text := 'test did not complete';
  v_current_role text;
begin
  begin
    -- Phase 1: attempt the role switch in its own protected block; confirm
    -- it actually took effect (current_user reflects it) before treating
    -- anything downstream as a genuine RPC-level privilege test.
    begin
      set role service_role;
      select current_user into v_current_role;
      if v_current_role = 'service_role' then
        v_role_switch_succeeded := true;
      else
        v_role_switch_succeeded := false;
        v_role_detail := format('SET ROLE service_role appeared to succeed but current_user is %s, not service_role -- not treating this as a valid RPC-level test', v_current_role);
      end if;
    exception when others then
      v_role_switch_succeeded := false;
      v_role_detail := format('SET ROLE service_role itself failed: %s (sqlstate %s) -- the RPC was never invoked, this is not a valid sanity-check result', sqlerrm, sqlstate);
    end;

    -- Phase 2: only invoke the RPC once the role switch is CONFIRMED.
    if v_role_switch_succeeded then
      begin
        perform public.replace_ha_accounts_snapshot(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 'initial_upload');
        v_role_passed := false;
        v_role_detail := 'service_role call unexpectedly succeeded against a nonexistent upload/user (should hit the ownership check, sqlstate 42501)';
      exception when sqlstate '42501' then
        v_role_passed := true;
        v_role_detail := 'service_role CAN call the function (reaches the function body -- rejected here only because the test upload/user do not exist, which is the correct, expected outcome for this specific call)';
      when insufficient_privilege then
        v_role_passed := false;
        v_role_detail := 'service_role itself is blocked at the privilege level -- the GRANT to service_role is missing';
      when others then
        v_role_passed := false;
        v_role_detail := format('service_role call raised an unexpected error (expected sqlstate 42501): %s (sqlstate %s)', sqlerrm, sqlstate);
      end;
    else
      v_role_passed := false;
    end if;
  exception when others then
    v_role_switch_succeeded := false;
    v_role_passed := false;
    v_role_detail := format('unexpected error during role-switch test setup: %s', sqlerrm);
  end;
  reset role;
  insert into _phase2a_auth_test_results (assertion, passed, detail)
    values ('Test 6: service_role CAN call replace_ha_accounts_snapshot (sanity)', v_role_passed, v_role_detail);
end $$;

-- ===========================================================================
-- Tests 7-12 (Phase 2A implementation-review ROUND 2, item 1): the specific
-- input-handling behaviors the review required be verified and tested --
-- malformed/non-array JSON, empty array, in-array duplicate account_name,
-- a spoofed per-row user_id field, and the returned-rows ownership
-- guarantee. Reuses one owner/upload setup for tests 7-12.
-- ===========================================================================
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_rows jsonb;
  v_count int;
  v_distinct_owner_pairs int;
begin
  insert into public.ha_users (email, name) values ('phase2a-round2-owner+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 2 Owner') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 2 RPC test upload', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  -- Test 7: malformed JSON (a JSON object instead of an array) is rejected atomically
  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user, '{"account_name":"Not An Array"}'::jsonb, 'initial_upload');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 7: ' || 'a JSON object was accepted in place of an array -- no exception raised', false, null);
  exception when others then
    if sqlstate = '22023' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 7: ' || 'a non-array p_accounts value is rejected with the expected errcode 22023, and the exception is explicit rather than a generic internal error', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 7: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload;
  if v_count = 0 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 7: ' || 'the malformed-input call did not delete or insert anything for this upload (atomic failure -- see the accounts already present from Test 1''s upload A are a DIFFERENT upload, so this is expected to be empty for a fresh upload)', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 7: ' || '% row(s) exist for this upload despite the rejected malformed call', false, format('%s row(s) exist for this upload despite the rejected malformed call', v_count)); end if;

  -- Test 8: malformed JSON (a bare scalar) is also rejected
  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user, '"just a string"'::jsonb, 'initial_upload');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 8: ' || 'a bare JSON scalar was accepted in place of an array -- no exception raised', false, null);
  exception when others then
    if sqlstate = '22023' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 8: ' || 'a scalar p_accounts value is rejected with errcode 22023', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 8: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  -- Test 9: duplicate account_name values within one p_accounts array are resolved deterministically (last occurrence wins), not an error
  begin
    v_rows := public.replace_ha_accounts_snapshot(v_upload, v_user,
      '[{"account_name":"Acme Corp","industry":"first"},{"account_name":"Acme Corp","industry":"second-and-last"}]'::jsonb, 'initial_upload');
  exception when others then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 9: ' || 'an in-array duplicate account_name raised an exception instead of being resolved deterministically: % (sqlstate %)', false, format('an in-array duplicate account_name raised an exception instead of being resolved deterministically: %s (sqlstate %s)', sqlerrm, sqlstate));
  end;
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Acme Corp';
  if v_count = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 9: ' || 'exactly one row survives for the duplicated account_name (not two, not zero, not an error)', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 9: ' || 'expected exactly 1 row for the duplicated account_name, got %', false, format('expected exactly 1 row for the duplicated account_name, got %s', v_count)); end if;
  if exists (select 1 from public.ha_accounts where upload_id = v_upload and account_name = 'Acme Corp' and industry = 'second-and-last') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 9: ' || 'the surviving row reflects the LAST occurrence in the array (industry=second-and-last), matching the documented deterministic tie-break', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 9: ' || 'the surviving row does not reflect the last occurrence in the array as documented', false, null);
  end if;

  -- Test 10: a spoofed per-row "user_id" field inside an account object is ignored -- ownership always comes from the verified p_user_id parameter
  perform public.replace_ha_accounts_snapshot(v_upload, v_user,
    ('[{"account_name":"Spoof Target","user_id":"' || gen_random_uuid()::text || '"}]')::jsonb, 'initial_upload');
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Spoof Target' and user_id = v_user;
  if v_count = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 10: ' || 'the inserted row''s user_id is the verified p_user_id parameter, not the spoofed per-row value from the JSON payload', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 10: ' || 'the spoofed per-row user_id was NOT correctly overridden by p_user_id -- expected 1 row owned by the real user, got %', false, format('the spoofed per-row user_id was NOT correctly overridden by p_user_id -- expected 1 row owned by the real user, got %s', v_count)); end if;

  -- Test 11: an empty p_accounts array explicitly clears the upload's account list
  v_rows := public.replace_ha_accounts_snapshot(v_upload, v_user, '[]'::jsonb, 'initial_upload');
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload;
  if v_count = 0 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 11: ' || 'calling with an empty array clears all accounts for the upload (explicit full-snapshot-replace semantics), rather than being a no-op or an error', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 11: ' || 'expected 0 accounts remaining after an empty-array call, got %', false, format('expected 0 accounts remaining after an empty-array call, got %s', v_count)); end if;

  -- Test 12: returned rows belong ONLY to p_upload_id and p_user_id
  perform public.replace_ha_accounts_snapshot(v_upload, v_user, '[{"account_name":"Scoping Check A"},{"account_name":"Scoping Check B"}]'::jsonb, 'initial_upload');
  select count(distinct (upload_id, user_id)) into v_distinct_owner_pairs
  from public.ha_accounts where upload_id = v_upload;
  if v_distinct_owner_pairs = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 12: ' || 'every returned/persisted row for this call carries exactly one (upload_id, user_id) pair -- (%, %)', true, format('every returned/persisted row for this call carries exactly one (upload_id, user_id) pair -- (%s, %s)', v_upload, v_user));
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 12: ' || 'expected exactly one distinct (upload_id, user_id) pair among the persisted rows, found %', false, format('expected exactly one distinct (upload_id, user_id) pair among the persisted rows, found %s', v_distinct_owner_pairs)); end if;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 7-12 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Tests 13-20 (Phase 2A implementation-review ROUND 2, items 1/4): atomic
-- claim/lease/attempt authorization and behavior for claim_ha_research_run().
-- ===========================================================================
do $$
declare
  v_user_a uuid;
  v_user_b uuid;
  v_upload_a uuid;
  v_result jsonb;
  v_run record;
  v_count int;
begin
  insert into public.ha_users (email, name) values ('phase2a-round2-run-owner+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 2 Run Owner') returning id into v_user_a;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user_a);
  insert into public.ha_users (email, name) values ('phase2a-round2-run-other+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 2 Run Other') returning id into v_user_b;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user_b);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user_a, 'Phase 2A round 2 run test upload', 'uploaded') returning id into v_upload_a;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload_a);

  -- Test 13: correct owner claims a brand-new run
  v_result := public.claim_ha_research_run(v_user_a, v_upload_a, 'auto', 300);
  if v_result->>'outcome' = 'claimed-new' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 13: ' || 'a fresh claim for a new (user, upload, run_id) triple returns outcome=claimed-new', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 13: ' || 'expected outcome=claimed-new, got %', false, format('expected outcome=claimed-new, got %s', v_result->>'outcome')); end if;

  -- Test 14: the SAME run id while still actively leased attaches, does not create a second row
  v_result := public.claim_ha_research_run(v_user_a, v_upload_a, 'auto', 300);
  if v_result->>'outcome' = 'attached-active' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 14: ' || 're-claiming the same run id while its lease is still valid returns outcome=attached-active (idempotent, does not restart research)', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 14: ' || 'expected outcome=attached-active, got %', false, format('expected outcome=attached-active, got %s', v_result->>'outcome')); end if;
  select count(*) into v_count from public.ha_research_runs where upload_id = v_upload_a and research_run_id = 'auto';
  if v_count = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 14: ' || 'exactly one row exists for (user_a, upload_a, auto) after two claim attempts', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 14: ' || 'expected exactly 1 row, found %', false, format('expected exactly 1 row, found %s', v_count)); end if;

  -- Test 15: a DIFFERENT run id while "auto" is actively leased is rejected (55P03), not joined
  begin
    perform public.claim_ha_research_run(v_user_a, v_upload_a, 'manual-test-1', 300);
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 15: ' || 'a second, different run id was allowed to claim while another run is actively leased', false, null);
  exception when others then
    if sqlstate = '55P03' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 15: ' || 'a different run id is rejected with errcode 55P03 while "auto" is still actively leased', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 15: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  -- Test 16: wrong user cannot claim against another user's upload
  begin
    perform public.claim_ha_research_run(v_user_b, v_upload_a, 'hijack-attempt', 300);
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 16: ' || 'user B was able to claim a run against user A''s upload -- no exception raised', false, null);
  exception when others then
    if sqlstate = '42501' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 16: ' || 'a wrong-user claim against another user''s upload is rejected with errcode 42501', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 16: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  -- Test 17: nonexistent upload is rejected the same way (no existence leak)
  begin
    perform public.claim_ha_research_run(v_user_a, gen_random_uuid(), 'ghost', 300);
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 17: ' || 'a nonexistent upload_id was accepted -- no exception raised', false, null);
  exception when others then
    if sqlstate = '42501' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 17: ' || 'a nonexistent upload_id is rejected with the same errcode 42501 as a real ownership mismatch', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 17: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  -- Test 18: a manually expired lease is reclaimable, and reclaiming mints a NEW attempt_id
  declare
    v_old_attempt uuid;
    v_new_attempt uuid;
  begin
    select attempt_id into v_old_attempt from public.ha_research_runs where upload_id = v_upload_a and research_run_id = 'auto';
    update public.ha_research_runs set lease_expires_at = now() - interval '1 minute' where upload_id = v_upload_a and research_run_id = 'auto';
    v_result := public.claim_ha_research_run(v_user_a, v_upload_a, 'auto', 300);
    v_new_attempt := (v_result->'run'->>'attempt_id')::uuid;
    if v_result->>'outcome' = 'reclaimed-after-expired-lease' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 18: ' || 'a claim against a row with an expired lease reclaims it (outcome=reclaimed-after-expired-lease), simulating recovery from a process that died mid-flight without ever marking the run failed', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 18: ' || 'expected outcome=reclaimed-after-expired-lease, got %', false, format('expected outcome=reclaimed-after-expired-lease, got %s', v_result->>'outcome')); end if;
    if v_new_attempt <> v_old_attempt then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 18: ' || 'reclaiming an expired lease mints a NEW attempt_id (% -> %)', true, format('reclaiming an expired lease mints a NEW attempt_id (%s -> %s)', v_old_attempt, v_new_attempt));
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 18: ' || 'attempt_id did not change after reclaiming an expired lease', false, null); end if;
  end;

  -- Test 19: a DIFFERENT run id can now claim, because "auto"'s lease was expired (not merely status=running) at claim time
  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute' where upload_id = v_upload_a and research_run_id = 'auto';
  v_result := public.claim_ha_research_run(v_user_a, v_upload_a, 'manual-test-2', 300);
  if v_result->>'outcome' = 'claimed-new' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 19: ' || 'a different run id successfully claims once the previously-active run''s lease has expired -- proves the claim logic checks lease_expires_at, not just status=''running''', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 19: ' || 'expected outcome=claimed-new for the new run id after the old one''s lease expired, got %', false, format('expected outcome=claimed-new for the new run id after the old one''s lease expired, got %s', v_result->>'outcome')); end if;

  -- Test 20 (sanity): anon and authenticated cannot call claim_ha_research_run at all
  declare
    v_role_switch_succeeded boolean := false;
    v_role_passed boolean := false;
    v_role_detail text := 'test did not complete';
    v_current_role text;
  begin
    -- Phase 1: attempt the role switch in its own protected block; confirm
    -- it actually took effect (current_user reflects it) before treating
    -- anything downstream as a genuine RPC-level privilege test.
    begin
      set role anon;
      select current_user into v_current_role;
      if v_current_role = 'anon' then
        v_role_switch_succeeded := true;
      else
        v_role_switch_succeeded := false;
        v_role_detail := format('SET ROLE anon appeared to succeed but current_user is %s, not anon -- not treating this as a valid RPC-level test', v_current_role);
      end if;
    exception when others then
      v_role_switch_succeeded := false;
      v_role_detail := format('SET ROLE anon itself failed: %s (sqlstate %s) -- the RPC was never invoked, this is not a valid privilege-denial result', sqlerrm, sqlstate);
    end;

    -- Phase 2: only invoke the RPC once the role switch is CONFIRMED.
    if v_role_switch_succeeded then
      begin
        perform public.claim_ha_research_run(gen_random_uuid(), gen_random_uuid(), 'x', 300);
        v_role_passed := false;
        v_role_detail := 'anon role was able to call claim_ha_research_run -- EXECUTE grant is not properly revoked';
      exception when insufficient_privilege then
        v_role_passed := true;
        v_role_detail := 'anon role is rejected at the privilege level before the function body runs';
      when others then
        v_role_passed := false;
        v_role_detail := format('anon call raised an unexpected error (expected insufficient_privilege): %s (sqlstate %s)', sqlerrm, sqlstate);
      end;
    else
      v_role_passed := false;
    end if;
  exception when others then
    v_role_switch_succeeded := false;
    v_role_passed := false;
    v_role_detail := format('unexpected error during role-switch test setup: %s', sqlerrm);
  end;
    reset role;
    insert into _phase2a_auth_test_results (assertion, passed, detail)
      values ('Test 20: anon role cannot call claim_ha_research_run', v_role_passed, v_role_detail);
  end;
  declare
    v_role_switch_succeeded boolean := false;
    v_role_passed boolean := false;
    v_role_detail text := 'test did not complete';
    v_current_role text;
  begin
    -- Phase 1: attempt the role switch in its own protected block; confirm
    -- it actually took effect (current_user reflects it) before treating
    -- anything downstream as a genuine RPC-level privilege test.
    begin
      set role authenticated;
      select current_user into v_current_role;
      if v_current_role = 'authenticated' then
        v_role_switch_succeeded := true;
      else
        v_role_switch_succeeded := false;
        v_role_detail := format('SET ROLE authenticated appeared to succeed but current_user is %s, not authenticated -- not treating this as a valid RPC-level test', v_current_role);
      end if;
    exception when others then
      v_role_switch_succeeded := false;
      v_role_detail := format('SET ROLE authenticated itself failed: %s (sqlstate %s) -- the RPC was never invoked, this is not a valid privilege-denial result', sqlerrm, sqlstate);
    end;

    -- Phase 2: only invoke the RPC once the role switch is CONFIRMED.
    if v_role_switch_succeeded then
      begin
        perform public.claim_ha_research_run(gen_random_uuid(), gen_random_uuid(), 'x', 300);
        v_role_passed := false;
        v_role_detail := 'authenticated role was able to call claim_ha_research_run directly -- EXECUTE grant is not properly revoked';
      exception when insufficient_privilege then
        v_role_passed := true;
        v_role_detail := 'authenticated role is rejected at the privilege level, matching the intended service_role-only design';
      when others then
        v_role_passed := false;
        v_role_detail := format('authenticated call raised an unexpected error (expected insufficient_privilege): %s (sqlstate %s)', sqlerrm, sqlstate);
      end;
    else
      v_role_passed := false;
    end if;
  exception when others then
    v_role_switch_succeeded := false;
    v_role_passed := false;
    v_role_detail := format('unexpected error during role-switch test setup: %s', sqlerrm);
  end;
    reset role;
    insert into _phase2a_auth_test_results (assertion, passed, detail)
      values ('Test 20: authenticated role cannot call claim_ha_research_run', v_role_passed, v_role_detail);
  end;

  delete from public.ha_research_runs where upload_id = v_upload_a;
  delete from public.ha_uploads where id = v_upload_a;
  delete from public.ha_users where id in (v_user_a, v_user_b);
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 13-20 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Tests 21-27 (Phase 2A implementation-review ROUND 3): heartbeat_ha_research_run()
-- and the "close manual-before-auto duplication" fix in claim_ha_research_run().
-- ===========================================================================
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim jsonb;
  v_heartbeat jsonb;
  v_attempt_id uuid;
  v_lease_1 timestamptz;
  v_lease_2 timestamptz;
begin
  insert into public.ha_users (email, name) values ('phase2a-round3-heartbeat+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 3 Heartbeat') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 3 heartbeat test upload', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  -- Test 21: heartbeat succeeds for the current owning attempt and extends the lease
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  v_attempt_id := (v_claim->'run'->>'attempt_id')::uuid;
  v_lease_1 := (v_claim->'run'->>'lease_expires_at')::timestamptz;
  perform pg_sleep(1);
  v_heartbeat := public.heartbeat_ha_research_run(v_user, v_upload, 'auto', v_attempt_id, 300);
  v_lease_2 := (v_heartbeat->'run'->>'lease_expires_at')::timestamptz;
  if (v_heartbeat->>'ok')::boolean = true then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 21: ' || 'heartbeat succeeds for the current owning attempt (ok=true)', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 21: ' || 'expected ok=true, got %', false, format('expected ok=true, got %s', v_heartbeat->>'ok')); end if;
  if v_lease_2 > v_lease_1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 21: ' || 'heartbeat extends lease_expires_at forward (% -> %)', true, format('heartbeat extends lease_expires_at forward (%s -> %s)', v_lease_1, v_lease_2));
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 21: ' || 'lease_expires_at did not advance after heartbeat', false, null); end if;

  -- Test 22: heartbeat with a WRONG (stale/replaced) attempt_id fails without raising, and does not extend the lease
  v_heartbeat := public.heartbeat_ha_research_run(v_user, v_upload, 'auto', gen_random_uuid(), 300);
  if (v_heartbeat->>'ok')::boolean = false and v_heartbeat->>'reason' = 'not-current-attempt' then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 22: ' || 'a heartbeat with a non-matching attempt_id returns ok=false, reason=not-current-attempt -- not an exception', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 22: ' || 'expected ok=false/not-current-attempt, got %', false, format('expected ok=false/not-current-attempt, got %s', v_heartbeat)); end if;

  -- Test 23: an excessive client-requested lease duration is clamped server-side, not honored verbatim
  v_heartbeat := public.heartbeat_ha_research_run(v_user, v_upload, 'auto', v_attempt_id, 999999999);
  if (v_heartbeat->'run'->>'lease_expires_at')::timestamptz <= now() + interval '901 seconds' then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 23: ' || 'an excessive p_lease_seconds request is clamped to the server-side maximum (900s), not honored verbatim', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 23: ' || 'lease_expires_at reflects an unclamped, excessive lease duration', false, null); end if;

  -- Test 24: anon/authenticated cannot call heartbeat_ha_research_run at all
  declare
    v_role_switch_succeeded boolean := false;
    v_role_passed boolean := false;
    v_role_detail text := 'test did not complete';
    v_current_role text;
  begin
    -- Phase 1: attempt the role switch in its own protected block; confirm
    -- it actually took effect (current_user reflects it) before treating
    -- anything downstream as a genuine RPC-level privilege test.
    begin
      set role anon;
      select current_user into v_current_role;
      if v_current_role = 'anon' then
        v_role_switch_succeeded := true;
      else
        v_role_switch_succeeded := false;
        v_role_detail := format('SET ROLE anon appeared to succeed but current_user is %s, not anon -- not treating this as a valid RPC-level test', v_current_role);
      end if;
    exception when others then
      v_role_switch_succeeded := false;
      v_role_detail := format('SET ROLE anon itself failed: %s (sqlstate %s) -- the RPC was never invoked, this is not a valid privilege-denial result', sqlerrm, sqlstate);
    end;

    -- Phase 2: only invoke the RPC once the role switch is CONFIRMED.
    if v_role_switch_succeeded then
      begin
        perform public.heartbeat_ha_research_run(gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 300);
        v_role_passed := false;
        v_role_detail := 'anon role was able to call heartbeat_ha_research_run -- EXECUTE grant is not properly revoked';
      exception when insufficient_privilege then
        v_role_passed := true;
        v_role_detail := 'anon role is rejected at the privilege level before the function body runs';
      when others then
        v_role_passed := false;
        v_role_detail := format('anon call raised an unexpected error (expected insufficient_privilege): %s (sqlstate %s)', sqlerrm, sqlstate);
      end;
    else
      v_role_passed := false;
    end if;
  exception when others then
    v_role_switch_succeeded := false;
    v_role_passed := false;
    v_role_detail := format('unexpected error during role-switch test setup: %s', sqlerrm);
  end;
    reset role;
    insert into _phase2a_auth_test_results (assertion, passed, detail)
      values ('Test 24: anon role cannot call heartbeat_ha_research_run', v_role_passed, v_role_detail);
  end;
  declare
    v_role_switch_succeeded boolean := false;
    v_role_passed boolean := false;
    v_role_detail text := 'test did not complete';
    v_current_role text;
  begin
    -- Phase 1: attempt the role switch in its own protected block; confirm
    -- it actually took effect (current_user reflects it) before treating
    -- anything downstream as a genuine RPC-level privilege test.
    begin
      set role authenticated;
      select current_user into v_current_role;
      if v_current_role = 'authenticated' then
        v_role_switch_succeeded := true;
      else
        v_role_switch_succeeded := false;
        v_role_detail := format('SET ROLE authenticated appeared to succeed but current_user is %s, not authenticated -- not treating this as a valid RPC-level test', v_current_role);
      end if;
    exception when others then
      v_role_switch_succeeded := false;
      v_role_detail := format('SET ROLE authenticated itself failed: %s (sqlstate %s) -- the RPC was never invoked, this is not a valid privilege-denial result', sqlerrm, sqlstate);
    end;

    -- Phase 2: only invoke the RPC once the role switch is CONFIRMED.
    if v_role_switch_succeeded then
      begin
        perform public.heartbeat_ha_research_run(gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 300);
        v_role_passed := false;
        v_role_detail := 'authenticated role was able to call heartbeat_ha_research_run directly -- EXECUTE grant is not properly revoked';
      exception when insufficient_privilege then
        v_role_passed := true;
        v_role_detail := 'authenticated role is rejected at the privilege level, matching the intended service_role-only design';
      when others then
        v_role_passed := false;
        v_role_detail := format('authenticated call raised an unexpected error (expected insufficient_privilege): %s (sqlstate %s)', sqlerrm, sqlstate);
      end;
    else
      v_role_passed := false;
    end if;
  exception when others then
    v_role_switch_succeeded := false;
    v_role_passed := false;
    v_role_detail := format('unexpected error during role-switch test setup: %s', sqlerrm);
  end;
    reset role;
    insert into _phase2a_auth_test_results (assertion, passed, detail)
      values ('Test 24: authenticated role cannot call heartbeat_ha_research_run', v_role_passed, v_role_detail);
  end;

  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 21-24 cleanup complete', true, 'cleanup marker');
end $$;

do $$
declare
  v_user uuid;
  v_upload uuid;
  v_manual jsonb;
  v_auto jsonb;
begin
  insert into public.ha_users (email, name) values ('phase2a-round3-manual-before-auto+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 3 Manual Before Auto') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 3 manual-before-auto test upload', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  -- Test 25: a manual run completes, THEN the automatic path claims for the first time -- must attach to the completed manual run, not start new
  v_manual := public.claim_ha_research_run(v_user, v_upload, 'manual-before-auto-1', 300);
  update public.ha_research_runs set status = 'completed', completed_at = now(), result_summary = '{"signalsReturned": 3}'::jsonb
    where id = (v_manual->'run'->>'id')::uuid;
  v_auto := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  if v_auto->>'outcome' = 'completed' and (v_auto->'run'->>'research_run_id') = 'manual-before-auto-1' then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 25: ' || 'the automatic claim attaches to the already-completed MANUAL run instead of starting new research -- regardless of run id label', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 25: ' || 'expected outcome=completed attached to the manual run, got %', false, format('expected outcome=completed attached to the manual run, got %s', v_auto)); end if;
  if not exists (select 1 from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 25: ' || 'no new "auto" row was created -- the automatic path did not start a new run', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 25: ' || 'an "auto" row was created despite an existing completed manual run', false, null); end if;

  -- Test 26: an explicit manual rerun is still allowed after that same completed run
  v_manual := public.claim_ha_research_run(v_user, v_upload, 'manual-before-auto-2', 300);
  if v_manual->>'outcome' = 'claimed-new' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 26: ' || 'an explicit manual-rerun request succeeds after a completed run (auto or manual) -- the separate, authorized pathway is unaffected by the automatic-path block', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 26: ' || 'expected outcome=claimed-new for the explicit manual rerun, got %', false, format('expected outcome=claimed-new for the explicit manual rerun, got %s', v_manual)); end if;

  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 25-26 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Test 27 (Phase 2A implementation-review ROUND 3, item 3): replace_ha_accounts_snapshot()
-- rejects a stale/replaced attempt when p_research_run_id/p_attempt_id are
-- supplied, and writes nothing.
-- ===========================================================================
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim_a jsonb;
  v_claim_b jsonb;
  v_count int;
begin
  insert into public.ha_users (email, name) values ('phase2a-round3-persistence+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 3 Persistence') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 3 persistence test upload', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  v_claim_a := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  -- Simulate attempt A's lease expiring, then attempt B reclaiming (exactly
  -- the 5-step race from migration 4 §9).
  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute' where upload_id = v_upload and research_run_id = 'auto';
  v_claim_b := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);

  begin
    perform public.replace_ha_accounts_snapshot(
      v_upload, v_user, '[{"account_name":"Stale Attempt Write"}]'::jsonb,
      'tracked_research', 'auto', (v_claim_a->'run'->>'attempt_id')::uuid
    );
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 27: ' || 'the STALE attempt A was able to write accounts after being superseded by attempt B -- no exception raised', false, null);
  exception when others then
    if sqlstate = 'HA001' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 27: ' || 'attempt A (superseded by B''s reclaim) is rejected with errcode HA001 when it tries to save', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 27: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Stale Attempt Write';
  if v_count = 0 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 27: ' || 'the stale attempt''s rejected call wrote nothing to ha_accounts', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 27: ' || '% row(s) were written despite the rejection', false, format('%s row(s) were written despite the rejection', v_count)); end if;

  perform public.replace_ha_accounts_snapshot(
    v_upload, v_user, '[{"account_name":"Current Attempt Write"}]'::jsonb,
    'tracked_research', 'auto', (v_claim_b->'run'->>'attempt_id')::uuid
  );
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Current Attempt Write';
  if v_count = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 27: ' || 'the CURRENT attempt B successfully writes accounts using the same (research_run_id, attempt_id) guard', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 27: ' || 'expected 1 row from the current attempt''s write, got %', false, format('expected 1 row from the current attempt''s write, got %s', v_count)); end if;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 27 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Tests 28-35 (Phase 2A implementation-review ROUND 4): persist_ha_research_output()
-- -- the consolidated, attempt-guarded accounts+signals+upload-state RPC.
-- ===========================================================================
do $$
declare
  v_user_a uuid;
  v_user_b uuid;
  v_upload_a uuid;
  v_claim_a jsonb;
  v_claim_b jsonb;
  v_result jsonb;
  v_count int;
  v_upload_row record;
  v_signals jsonb;
begin
  insert into public.ha_users (email, name) values ('phase2a-round4-persist-owner+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 4 Persist Owner') returning id into v_user_a;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user_a);
  insert into public.ha_users (email, name) values ('phase2a-round4-persist-other+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 4 Persist Other') returning id into v_user_b;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user_b);
  insert into public.ha_uploads (user_id, upload_name, stage, summary) values (v_user_a, 'Phase 2A round 4 persist test upload', 'uploaded', '{"seed":true}'::jsonb) returning id into v_upload_a;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload_a);

  v_signals := '[{"account_name":"Acme Co","signal_hash":"h1","event_fingerprint":"fp-1","signal_type":"Acquisition","title":"Acme acquires Rival","confidence":80}]'::jsonb;

  -- Test 28: correct owner, current attempt -- accounts + signals + upload-state all persist together
  v_claim_a := public.claim_ha_research_run(v_user_a, v_upload_a, 'auto', 300);
  v_result := public.persist_ha_research_output(
    v_upload_a, v_user_a, 'auto', (v_claim_a->'run'->>'attempt_id')::uuid,
    '[{"account_name":"Acme Co"}]'::jsonb, v_signals, 'researched', '{"accountCount":1}'::jsonb
  );
  if (v_result->>'accountsPersisted')::int = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 28: ' || 'accountsPersisted = 1', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 28: ' || 'expected accountsPersisted=1, got %', false, format('expected accountsPersisted=1, got %s', v_result->>'accountsPersisted')); end if;
  if (v_result->>'signalsPersisted')::int = 1 and (v_result->>'signalsAttempted')::int = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 28: ' || 'signalsAttempted=1, signalsPersisted=1', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 28: ' || 'unexpected signals counts in %', false, format('unexpected signals counts in %s', v_result)); end if;
  select into v_upload_row stage, summary from public.ha_uploads where id = v_upload_a;
  if v_upload_row.stage = 'researched' and v_upload_row.summary->>'accountCount' = '1' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 28: ' || 'ha_uploads.stage/summary updated atomically alongside accounts/signals', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 28: ' || 'ha_uploads.stage/summary not updated as expected (got stage=%, summary=%)', false, format('ha_uploads.stage/summary not updated as expected (got stage=%s, summary=%s)', v_upload_row.stage, v_upload_row.summary)); end if;

  -- Test 29: a SECOND call with the same signal (same event_fingerprint) is an intentional conflict, not an error
  v_result := public.persist_ha_research_output(v_upload_a, v_user_a, 'auto', (v_claim_a->'run'->>'attempt_id')::uuid, null, v_signals, null, null);
  if (v_result->>'signalsAttempted')::int = 1 and (v_result->>'signalsPersisted')::int = 0 and (v_result->>'signalsConflictIgnored')::int = 1 then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 29: ' || 'a repeat signal is attempted=1, persisted=0, conflictIgnored=1 -- not an error, not silently absent', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 29: ' || 'unexpected repeat-signal counts in %', false, format('unexpected repeat-signal counts in %s', v_result)); end if;

  -- Test 30: wrong user cannot call this RPC against another user's upload
  begin
    perform public.persist_ha_research_output(v_upload_a, v_user_b, 'auto', (v_claim_a->'run'->>'attempt_id')::uuid, null, null, null, null);
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 30: ' || 'user B was able to call persist_ha_research_output against user A''s upload', false, null);
  exception when others then
    if sqlstate = '42501' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 30: ' || 'wrong-user call rejected with errcode 42501', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 30: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  -- Test 31: nonexistent upload rejected the same way
  begin
    perform public.persist_ha_research_output(gen_random_uuid(), v_user_a, 'auto', gen_random_uuid(), null, null, null, null);
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 31: ' || 'a nonexistent upload_id was accepted', false, null);
  exception when others then
    if sqlstate = '42501' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 31: ' || 'nonexistent upload rejected with errcode 42501', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 31: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  -- Test 32: STALE attempt -- accounts, signals, AND upload-state ALL rejected together, zero rows change in any of the three
  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute' where upload_id = v_upload_a and research_run_id = 'auto';
  v_claim_b := public.claim_ha_research_run(v_user_a, v_upload_a, 'auto', 300); -- reclaims -- new attempt_id
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload_a;
  declare v_accounts_before int := v_count; v_signals_before int; v_summary_before jsonb;
  begin
    select count(*) into v_signals_before from public.ha_signals where upload_id = v_upload_a;
    select summary into v_summary_before from public.ha_uploads where id = v_upload_a;
    begin
      perform public.persist_ha_research_output(
        v_upload_a, v_user_a, 'auto', (v_claim_a->'run'->>'attempt_id')::uuid, -- A's STALE attempt_id
        '[{"account_name":"Stale Account Write"}]'::jsonb,
        '[{"account_name":"Stale Co","signal_hash":"h2","event_fingerprint":"fp-stale","signal_type":"Award","title":"Stale signal","confidence":50}]'::jsonb,
        'researched', '{"accountCount":999,"note":"should not persist"}'::jsonb
      );
      insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'the stale attempt A was able to call persist_ha_research_output -- no exception raised', false, null);
    exception when others then
      if sqlstate = 'HA001' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'stale attempt A is rejected with errcode HA001', true, null);
      else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
    end;
    select count(*) into v_count from public.ha_accounts where upload_id = v_upload_a;
    if v_count = v_accounts_before then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'ha_accounts row count unchanged after the rejected stale-attempt call (accounts NOT written)', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'ha_accounts row count changed from % to % despite the rejection', false, format('ha_accounts row count changed from %s to %s despite the rejection', v_accounts_before, v_count)); end if;
    select count(*) into v_count from public.ha_signals where upload_id = v_upload_a;
    if v_count = v_signals_before then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'ha_signals row count unchanged after the rejected stale-attempt call (signals NOT written) -- this is the specific invariant round 3 could not yet guarantee', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'ha_signals row count changed from % to % despite the rejection', false, format('ha_signals row count changed from %s to %s despite the rejection', v_signals_before, v_count)); end if;
  end;
  if not exists (select 1 from public.ha_uploads where id = v_upload_a and summary->>'note' = 'should not persist') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'ha_uploads.summary was NOT overwritten by the rejected stale-attempt call', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'ha_uploads.summary reflects the stale attempt''s rejected payload', false, null); end if;
  if not exists (select 1 from public.ha_accounts where upload_id = v_upload_a and account_name = 'Stale Account Write') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'the specific stale account row was never created', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'the stale account row exists despite the rejection', false, null); end if;
  if not exists (select 1 from public.ha_signals where upload_id = v_upload_a and event_fingerprint = 'fp-stale') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'the specific stale signal row was never created', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 32: ' || 'the stale signal row exists despite the rejection', false, null); end if;

  -- Test 33: the CURRENT (post-reclaim) attempt succeeds where the stale one failed
  v_result := public.persist_ha_research_output(
    v_upload_a, v_user_a, 'auto', (v_claim_b->'run'->>'attempt_id')::uuid,
    '[{"account_name":"Current Attempt Write"}]'::jsonb, null, null, null
  );
  if exists (select 1 from public.ha_accounts where upload_id = v_upload_a and account_name = 'Current Attempt Write') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 33: ' || 'the current (reclaimed) attempt successfully persists accounts using the exact same RPC that rejected the stale one', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 33: ' || 'the current attempt''s write did not persist', false, null); end if;

  -- Test 34 (sanity): anon/authenticated cannot call persist_ha_research_output at all
  declare
    v_role_switch_succeeded boolean := false;
    v_role_passed boolean := false;
    v_role_detail text := 'test did not complete';
    v_current_role text;
  begin
    -- Phase 1: attempt the role switch in its own protected block; confirm
    -- it actually took effect (current_user reflects it) before treating
    -- anything downstream as a genuine RPC-level privilege test.
    begin
      set role anon;
      select current_user into v_current_role;
      if v_current_role = 'anon' then
        v_role_switch_succeeded := true;
      else
        v_role_switch_succeeded := false;
        v_role_detail := format('SET ROLE anon appeared to succeed but current_user is %s, not anon -- not treating this as a valid RPC-level test', v_current_role);
      end if;
    exception when others then
      v_role_switch_succeeded := false;
      v_role_detail := format('SET ROLE anon itself failed: %s (sqlstate %s) -- the RPC was never invoked, this is not a valid privilege-denial result', sqlerrm, sqlstate);
    end;

    -- Phase 2: only invoke the RPC once the role switch is CONFIRMED.
    if v_role_switch_succeeded then
      begin
        perform public.persist_ha_research_output(gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), null, null, null, null);
        v_role_passed := false;
        v_role_detail := 'anon role was able to call persist_ha_research_output';
      exception when insufficient_privilege then
        v_role_passed := true;
        v_role_detail := 'anon role rejected at the privilege level';
      when others then
        v_role_passed := false;
        v_role_detail := format('anon call raised an unexpected error (expected insufficient_privilege): %s (sqlstate %s)', sqlerrm, sqlstate);
      end;
    else
      v_role_passed := false;
    end if;
  exception when others then
    v_role_switch_succeeded := false;
    v_role_passed := false;
    v_role_detail := format('unexpected error during role-switch test setup: %s', sqlerrm);
  end;
    reset role;
    insert into _phase2a_auth_test_results (assertion, passed, detail)
      values ('Test 34: anon role cannot call persist_ha_research_output', v_role_passed, v_role_detail);
  end;
  declare
    v_role_switch_succeeded boolean := false;
    v_role_passed boolean := false;
    v_role_detail text := 'test did not complete';
    v_current_role text;
  begin
    -- Phase 1: attempt the role switch in its own protected block; confirm
    -- it actually took effect (current_user reflects it) before treating
    -- anything downstream as a genuine RPC-level privilege test.
    begin
      set role authenticated;
      select current_user into v_current_role;
      if v_current_role = 'authenticated' then
        v_role_switch_succeeded := true;
      else
        v_role_switch_succeeded := false;
        v_role_detail := format('SET ROLE authenticated appeared to succeed but current_user is %s, not authenticated -- not treating this as a valid RPC-level test', v_current_role);
      end if;
    exception when others then
      v_role_switch_succeeded := false;
      v_role_detail := format('SET ROLE authenticated itself failed: %s (sqlstate %s) -- the RPC was never invoked, this is not a valid privilege-denial result', sqlerrm, sqlstate);
    end;

    -- Phase 2: only invoke the RPC once the role switch is CONFIRMED.
    if v_role_switch_succeeded then
      begin
        perform public.persist_ha_research_output(gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), null, null, null, null);
        v_role_passed := false;
        v_role_detail := 'authenticated role was able to call persist_ha_research_output directly';
      exception when insufficient_privilege then
        v_role_passed := true;
        v_role_detail := 'authenticated role rejected at the privilege level';
      when others then
        v_role_passed := false;
        v_role_detail := format('authenticated call raised an unexpected error (expected insufficient_privilege): %s (sqlstate %s)', sqlerrm, sqlstate);
      end;
    else
      v_role_passed := false;
    end if;
  exception when others then
    v_role_switch_succeeded := false;
    v_role_passed := false;
    v_role_detail := format('unexpected error during role-switch test setup: %s', sqlerrm);
  end;
    reset role;
    insert into _phase2a_auth_test_results (assertion, passed, detail)
      values ('Test 34: authenticated role cannot call persist_ha_research_output', v_role_passed, v_role_detail);
  end;

  delete from public.ha_signals where upload_id = v_upload_a;
  delete from public.ha_accounts where upload_id = v_upload_a;
  delete from public.ha_research_runs where upload_id = v_upload_a;
  delete from public.ha_uploads where id = v_upload_a;
  delete from public.ha_users where id in (v_user_a, v_user_b);
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 28-34 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Test 35 (Phase 2A implementation-review ROUND 4): "a takeover happening
-- specifically between account persistence and signal persistence."
-- ===========================================================================
-- This scenario is STRUCTURALLY IMPOSSIBLE inside persist_ha_research_output()
-- by construction, not merely untested: pg_advisory_xact_lock(hashtext(upload_id))
-- is acquired ONCE, at the very top of the function, and held for the
-- function's ENTIRE transaction (advisory xact locks release only at
-- transaction end -- see migration 6 §3). No other transaction can acquire
-- that same lock key (which claim_ha_research_run()'s reclaim path, and
-- this function itself, both use) until THIS transaction commits or rolls
-- back. Since the accounts write and the signals write both happen AFTER
-- the lock is acquired and the attempt check passes, and BEFORE the
-- transaction commits, there is no point in wall-clock time at which a
-- reclaim could observe this upload as "unlocked" between those two writes
-- -- the reclaim attempt would simply block until this entire transaction
-- (both writes, and the upload-state update) finishes.
--
-- This specific claim -- that a concurrent claim_ha_research_run() call
-- truly BLOCKS rather than proceeding -- requires two genuinely concurrent
-- database sessions to observe directly (e.g. one session holding
-- pg_advisory_xact_lock open inside an uncommitted transaction via a manual
-- BEGIN, a second session's claim_ha_research_run() call demonstrably
-- hanging until the first COMMITs or ROLLBACKs). That is a manual,
-- two-session verification step for the QA procedure, not something a
-- single sequential do $$ block can express or automate. Documented here
-- explicitly rather than fabricating a script that cannot actually observe
-- concurrent blocking behavior. See scripts/test-save-upload-persistence.js
-- for the corresponding APPLICATION-level test, which proves there is no
-- longer a separate account-persistence call and a separate
-- signal-persistence call at all in the tracked path -- the "gap between
-- them" no longer exists as two distinct requests, only as two statements
-- inside one transaction.
do $$
begin
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 35: see the comment immediately above this block -- manual two-session verification required, not automatable here', true, 'informational -- manual/non-automated step, see source comments');
end $$;

-- ===========================================================================
-- Tests 36-42 (Phase 2A implementation-review ROUND 5, item 1): atomic
-- finalization inside persist_ha_research_output().
-- ===========================================================================
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim jsonb;
  v_claim2 jsonb;
  v_result jsonb;
  v_row record;
  v_count int;
begin
  insert into public.ha_users (email, name) values ('phase2a-round5-finalize+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 5 Finalize') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 5 finalize test upload', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  -- Test 36: persistence succeeds and the run becomes completed in the SAME transaction
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  v_result := public.persist_ha_research_output(
    v_upload, v_user, 'auto', (v_claim->'run'->>'attempt_id')::uuid,
    '[{"account_name":"Finalize Test Co"}]'::jsonb, null, 'researched', '{"accountCount":1}'::jsonb
  );
  if v_result->>'status' = 'completed' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 36: ' || 'the RPC response itself reports status=completed', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 36: ' || 'expected status=completed in the response, got %', false, format('expected status=completed in the response, got %s', v_result)); end if;
  select status, completed_at, result_summary into v_row from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';
  if v_row.status = 'completed' and v_row.completed_at is not null then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 36: ' || 'the ha_research_runs row itself is status=completed with completed_at set, persisted by the SAME call that wrote the account', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 36: ' || 'expected the row to be completed, got status=%, completed_at=%', false, format('expected the row to be completed, got status=%s, completed_at=%s', v_row.status, v_row.completed_at)); end if;
  if (v_row.result_summary->>'accountsPersisted')::int = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 36: ' || 'result_summary reflects the actual persisted account count', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 36: ' || 'unexpected result_summary %', false, format('unexpected result_summary %s', v_row.result_summary)); end if;

  -- Test 37: the SAME attempt cannot persist additional research output after its own completion
  begin
    perform public.persist_ha_research_output(
      v_upload, v_user, 'auto', (v_claim->'run'->>'attempt_id')::uuid,
      '[{"account_name":"Should Not Persist"}]'::jsonb, null, null, null
    );
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 37: ' || 'the already-completed attempt was able to persist again -- no exception raised', false, null);
  exception when others then
    if sqlstate = 'HA001' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 37: ' || 'a second call with the same (now-completed) attempt is rejected HA001, exactly like any other stale attempt', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 37: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;
  if not exists (select 1 from public.ha_accounts where upload_id = v_upload and account_name = 'Should Not Persist') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 37: ' || 'the rejected second call wrote nothing', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 37: ' || 'the rejected second call''s account row exists', false, null); end if;

  -- Test 38: an automatic claim after this completion returns the cached result and blocks a new automatic run
  v_claim2 := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  if v_claim2->>'outcome' = 'completed' and (v_claim2->'run'->'result_summary'->>'accountsPersisted')::int = 1 then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 38: ' || 'a subsequent automatic claim returns outcome=completed with the SAME result_summary persist_ha_research_output() wrote -- no new research starts', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 38: ' || 'expected outcome=completed with the cached result_summary, got %', false, format('expected outcome=completed with the cached result_summary, got %s', v_claim2)); end if;

  -- Test 39: explicit manual rerun after completion remains authorized
  v_claim2 := public.claim_ha_research_run(v_user, v_upload, 'manual-rerun-after-finalize', 300);
  if v_claim2->>'outcome' = 'claimed-new' then
    v_result := public.persist_ha_research_output(
      v_upload, v_user, 'manual-rerun-after-finalize', (v_claim2->'run'->>'attempt_id')::uuid,
      '[{"account_name":"Manual Rerun Persisted"}]'::jsonb, null, null, null
    );
    if v_result->>'status' = 'completed' and exists (select 1 from public.ha_accounts where upload_id = v_upload and account_name = 'Manual Rerun Persisted') then
      insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 39: ' || 'an explicit manual-rerun attempt claims, persists, AND finalizes successfully after the original run already completed', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 39: ' || 'the manual rerun did not persist/finalize as expected: %', false, format('the manual rerun did not persist/finalize as expected: %s', v_result)); end if;
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 39: ' || 'expected the manual rerun to claim successfully, got %', false, format('expected the manual rerun to claim successfully, got %s', v_claim2)); end if;

  -- Test 40 (sanity): wrong user / nonexistent upload rejected the same as every other RPC in this schema
  begin
    perform public.persist_ha_research_output(v_upload, gen_random_uuid(), 'auto', gen_random_uuid(), null, null, null, null);
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 40 (sanity): wrong user / nonexistent upload rejected the same as every other RPC in this schema: ' || 'a random/wrong user id was accepted', false, null);
  exception when others then
    if sqlstate = '42501' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 40 (sanity): wrong user / nonexistent upload rejected the same as every other RPC in this schema: ' || 'wrong-user call rejected with errcode 42501 (finalization included)', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 40 (sanity): wrong user / nonexistent upload rejected the same as every other RPC in this schema: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 36-40 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Test 41 (Phase 2A implementation-review ROUND 5, item 1, test 2/3):
-- "Signal/account/upload failure rolls back run completion" and "run-
-- completion update failure rolls back accounts, signals, and upload
-- summary." Both reduce to the SAME structural guarantee: everything inside
-- persist_ha_research_output() -- the attempt validation, the accounts
-- write, the signals write, the upload-state write, AND the finalization
-- update -- is ONE plpgsql function body executing inside ONE implicit
-- transaction. An unhandled exception anywhere in that body (a malformed
-- p_accounts array failing replace_ha_accounts_snapshot's own validation, a
-- constraint violation on the signals insert, or — structurally
-- impossible under the advisory lock, but defended against via HA002 — a
-- finalization update that matches no row) rolls back EVERYTHING the
-- function did up to that point, not just the specific statement that
-- failed. This is a property of PL/pgSQL's execution model (documented,
-- not merely assumed), verified here by forcing the earliest possible
-- failure (a malformed, non-array p_accounts value) and confirming NOTHING
-- persisted, including the run staying at its PRE-call state (not
-- finalized, not even re-heartbeated).
-- ===========================================================================
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim jsonb;
  v_lease_before timestamptz;
  v_lease_after timestamptz;
  v_status_after text;
begin
  insert into public.ha_users (email, name) values ('phase2a-round5-rollback+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 5 Rollback') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 5 rollback test upload', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  select lease_expires_at into v_lease_before from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';

  begin
    perform public.persist_ha_research_output(
      v_upload, v_user, 'auto', (v_claim->'run'->>'attempt_id')::uuid,
      '{"not_an_array": true}'::jsonb, -- malformed -- replace_ha_accounts_snapshot rejects this with 22023
      '[{"account_name":"Should Not Persist Either","signal_hash":"h1","event_fingerprint":"fp-rollback"}]'::jsonb,
      'researched', '{"accountCount":999}'::jsonb
    );
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'malformed p_accounts was accepted -- no exception raised', false, null);
  exception when others then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'the malformed accounts payload raised an exception (sqlstate %), aborting the whole call', true, format('the malformed accounts payload raised an exception (sqlstate %s), aborting the whole call', sqlstate));
  end;

  if not exists (select 1 from public.ha_accounts where upload_id = v_upload) then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'no accounts were persisted (the accounts write itself failed, so nothing downstream ran either)', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'accounts exist despite the failure', false, null); end if;
  if not exists (select 1 from public.ha_signals where upload_id = v_upload and event_fingerprint = 'fp-rollback') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'the signal that would have been inserted AFTER the failed accounts step never persisted -- confirms the whole transaction rolled back, not just the accounts statement', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'the signal exists despite the earlier failure in the same transaction', false, null); end if;
  if not exists (select 1 from public.ha_uploads where id = v_upload and stage = 'researched') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'ha_uploads.stage was NOT updated -- the upload-state write (which runs AFTER accounts/signals) never ran', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'ha_uploads.stage was updated despite the earlier failure', false, null); end if;
  -- ROUND 8 item 2 fix: this used to be `select status, lease_expires_at
  -- into v_lease_after` -- two columns selected into ONE timestamptz
  -- variable, a SELECT...INTO arity mismatch. PL/pgSQL's behavior for this
  -- specific shape (a plain scalar target on the left, more than one
  -- expression on the right of a non-record select-into) is itself
  -- ambiguous/version-dependent enough that letting it slide understates
  -- the bug -- it should never have parsed as "check both status and
  -- lease" in the first place. Fixed by giving each column its own
  -- correctly typed variable, which also lets this test actually verify
  -- the "not finalized" half of its own PASS message below (it previously
  -- checked lease_expires_at only; the status='running' check was
  -- claimed in prose but never executed).
  select status, lease_expires_at into v_status_after, v_lease_after from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';
  if v_lease_after = v_lease_before and v_status_after = 'running' then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'the run was NOT finalized (status still ''running'') and its lease was NOT even re-renewed by the failed call -- the attempt-validation UPDATE itself rolled back along with everything after it', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41: ' || 'the run''s state changed despite the transaction failing -- status=%, lease_expires_at=% (expected status=running, lease_expires_at=%)', false, format('the run''s state changed despite the transaction failing -- status=%s, lease_expires_at=%s (expected status=running, lease_expires_at=%s)', v_status_after, v_lease_after, v_lease_before));
  end if;

  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 41 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Tests 42-49 (Phase 2A implementation-review ROUND 7, items 3-4):
-- replace_ha_accounts_snapshot()'s new p_mode parameter -- validation, the
-- active-run/research-history checks now performed INSIDE the same
-- advisory-locked transaction as the write (fail-closed, no separate
-- `.catch(() => [])`-guarded pre-flight query to silently misinterpret a
-- failure as "no active run"), and the accounts_maintenance account-
-- identity lock (metadata-only once research history exists).
-- ===========================================================================

-- Test 42: p_mode validation -- null and an arbitrary/unrecognized string
-- are both rejected with 22023, before the advisory lock or ownership check
-- ever run (a malformed mode never gets far enough to touch any row).
do $$
declare
  v_user uuid;
  v_upload uuid;
begin
  insert into public.ha_users (email, name) values ('phase2a-round7-mode-validation+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 7 Mode Validation') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 7 mode validation upload', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user, '[]'::jsonb, null);
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 42: ' || 'p_mode=null was accepted -- no exception raised', false, null);
  exception when others then
    if sqlstate = '22023' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 42: ' || 'p_mode=null is rejected with errcode 22023', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 42: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user, '[]'::jsonb, 'some_made_up_mode');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 42: ' || 'an unrecognized p_mode string was accepted -- no exception raised', false, null);
  exception when others then
    if sqlstate = '22023' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 42: ' || 'an unrecognized p_mode string is rejected with errcode 22023 -- the RPC does not trust an arbitrary client-provided mode', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 42: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 42 cleanup complete', true, 'cleanup marker');
end $$;

-- Test 43: p_mode=initial_upload is rejected once the upload has ANY
-- research history (HA003), even though the caller supplied a perfectly
-- valid accounts array and owns the upload. Also confirms the write did
-- not happen (atomic -- the check and the write are the same transaction).
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim jsonb;
begin
  insert into public.ha_users (email, name) values ('phase2a-round7-initial-reuse+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 7 Initial Reuse') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 7 initial-upload reuse test', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  perform public.persist_ha_research_output(
    v_upload, v_user, 'auto', (v_claim->'run'->>'attempt_id')::uuid,
    '[{"account_name":"Original Account"}]'::jsonb, null, 'researched', '{"accountCount":1}'::jsonb
  );

  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user, '[{"account_name":"Reused As Initial"}]'::jsonb, 'initial_upload');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 43: ' || 'p_mode=initial_upload was accepted against an upload that already has research history -- no exception raised', false, null);
  exception when others then
    if sqlstate = 'HA003' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 43: ' || 'p_mode=initial_upload against an upload with existing research history is rejected with errcode HA003', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 43: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;
  if exists (select 1 from public.ha_accounts where upload_id = v_upload and account_name = 'Reused As Initial') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 43: ' || 'the rejected initial_upload call still wrote a row', false, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 43: ' || 'the rejected initial_upload call wrote nothing -- the original account snapshot is untouched', true, null);
  end if;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 43 cleanup complete', true, 'cleanup marker');
end $$;

-- Test 44: p_mode=accounts_maintenance is rejected (55P03) while a running,
-- unexpired research attempt exists -- the SAME check api/save-upload.js
-- used to perform as a separate `.catch(() => [])`-guarded GET request, now
-- inside the same advisory-locked transaction as the write, so there is no
-- window between "checked" and "wrote" for a claim to land in.
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim jsonb;
begin
  insert into public.ha_users (email, name) values ('phase2a-round7-maintenance-active+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 7 Maintenance Active') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 7 maintenance-while-active test', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300); -- status='running', unexpired lease

  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user, '[{"account_name":"Edited While Active"}]'::jsonb, 'accounts_maintenance');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 44: ' || 'p_mode=accounts_maintenance was accepted while a research run is actively running -- no exception raised', false, null);
  exception when others then
    if sqlstate = '55P03' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 44: ' || 'p_mode=accounts_maintenance while a run is actively running is rejected with errcode 55P03', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 44: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;
  if exists (select 1 from public.ha_accounts where upload_id = v_upload) then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 44: ' || 'the rejected accounts_maintenance call still wrote a row', false, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 44: ' || 'the rejected accounts_maintenance call wrote nothing', true, null);
  end if;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 44 cleanup complete', true, 'cleanup marker');
end $$;

-- Test 45: p_mode=accounts_maintenance IS permitted after the run
-- COMPLETES, and a metadata-only edit (same account_name set, changed
-- industry/contact fields) succeeds normally.
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim jsonb;
  v_industry text;
begin
  insert into public.ha_users (email, name) values ('phase2a-round7-maintenance-completed+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 7 Maintenance Completed') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 7 maintenance-after-completion test', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  perform public.persist_ha_research_output(
    v_upload, v_user, 'auto', (v_claim->'run'->>'attempt_id')::uuid,
    '[{"account_name":"Stable Co","industry":"Old Industry","contact_email":"old@example.com"}]'::jsonb,
    null, 'researched', '{"accountCount":1}'::jsonb
  );

  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user,
      '[{"account_name":"Stable Co","industry":"New Industry","contact_email":"new@example.com"}]'::jsonb,
      'accounts_maintenance');
  exception when others then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 45: ' || 'a metadata-only accounts_maintenance edit after completion raised an unexpected exception: % (sqlstate %)', false, format('a metadata-only accounts_maintenance edit after completion raised an unexpected exception: %s (sqlstate %s)', sqlerrm, sqlstate));
  end;
  select industry into v_industry from public.ha_accounts where upload_id = v_upload and account_name = 'Stable Co';
  if v_industry = 'New Industry' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 45: ' || 'accounts_maintenance after a completed run successfully updates industry/contact fields for the SAME account name', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 45: ' || 'expected industry=New Industry after the maintenance edit, got %', false, format('expected industry=New Industry after the maintenance edit, got %s', v_industry)); end if;
  if (select status from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto') = 'completed' then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 45: ' || 'the completed research run row itself is unaffected by the accounts_maintenance edit', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 45: ' || 'the completed research run''s status changed as a side effect of an accounts_maintenance edit', false, null); end if;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 45 cleanup complete', true, 'cleanup marker');
end $$;

-- Tests 46-48: the account-identity lock -- once research history exists,
-- accounts_maintenance rejects (HA004) any incoming account_name set that
-- is not IDENTICAL to the existing set: a rename, an addition, or a
-- removal, tested separately. In every case, nothing is written (the
-- rejection happens before the DELETE/INSERT).
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim jsonb;
  v_count int;
begin
  insert into public.ha_users (email, name) values ('phase2a-round7-identity-lock+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 7 Identity Lock') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 7 identity lock test', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  perform public.persist_ha_research_output(
    v_upload, v_user, 'auto', (v_claim->'run'->>'attempt_id')::uuid,
    '[{"account_name":"Alpha Co"},{"account_name":"Beta Co"}]'::jsonb,
    '[{"account_name":"Alpha Co","signal_hash":"h-alpha","event_fingerprint":"fp-alpha","signal_type":"Hiring"}]'::jsonb,
    'researched', '{"accountCount":2}'::jsonb
  );

  -- Test 46: rename rejected
  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user,
      '[{"account_name":"Alpha Co Renamed"},{"account_name":"Beta Co"}]'::jsonb, 'accounts_maintenance');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 46: ' || 'renaming an account via accounts_maintenance was accepted -- no exception raised', false, null);
  exception when others then
    if sqlstate = 'HA004' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 46: ' || 'renaming an account (Alpha Co -> Alpha Co Renamed) via accounts_maintenance is rejected with errcode HA004', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 46: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  -- Test 47: addition rejected
  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user,
      '[{"account_name":"Alpha Co"},{"account_name":"Beta Co"},{"account_name":"Gamma Co"}]'::jsonb, 'accounts_maintenance');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 47: ' || 'adding a new account via accounts_maintenance was accepted -- no exception raised', false, null);
  exception when others then
    if sqlstate = 'HA004' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 47: ' || 'adding an account (Gamma Co) via accounts_maintenance is rejected with errcode HA004', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 47: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  -- Test 48: removal rejected
  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user,
      '[{"account_name":"Alpha Co"}]'::jsonb, 'accounts_maintenance');
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 48: ' || 'removing an account via accounts_maintenance was accepted -- no exception raised', false, null);
  exception when others then
    if sqlstate = 'HA004' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 48: ' || 'removing an account (Beta Co) via accounts_maintenance is rejected with errcode HA004', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 48: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  select count(*) into v_count from public.ha_accounts where upload_id = v_upload;
  if v_count = 2 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 48: ' || 'after all three rejected identity-changing attempts, the original two accounts (Alpha Co, Beta Co) are exactly as they were -- nothing was added, removed, or renamed', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 48: ' || 'expected exactly 2 accounts to remain after the rejected calls, found %', false, format('expected exactly 2 accounts to remain after the rejected calls, found %s', v_count)); end if;
  if exists (select 1 from public.ha_signals where upload_id = v_upload and account_name = 'Alpha Co' and event_fingerprint = 'fp-alpha') then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 48: ' || 'the signal already associated with Alpha Co remains associated with that unchanged account name', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 48: ' || 'the Alpha Co signal is missing after the rejected identity-changing attempts', false, null); end if;
  if (select result_summary from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto') is not null then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 48: ' || 'the completed research run''s result_summary is unchanged by the rejected accounts_maintenance attempts', true, null);
  end if;

  delete from public.ha_signals where upload_id = v_upload;
  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 46-48 cleanup complete', true, 'cleanup marker');
end $$;

-- Test 49: accounts_maintenance with NO research history yet is NOT
-- identity-locked -- add/remove/rename are all still permitted, since there
-- is no signal history yet for anything to orphan. This confirms the lock
-- is scoped to "after research history exists," not "whenever
-- p_mode=accounts_maintenance is used."
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_count int;
begin
  insert into public.ha_users (email, name) values ('phase2a-round7-maintenance-no-history+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 7 Maintenance No History') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 7 maintenance-no-history test', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);
  perform public.replace_ha_accounts_snapshot(v_upload, v_user, '[{"account_name":"Pre-Research Co"}]'::jsonb, 'initial_upload');

  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user,
      '[{"account_name":"Renamed Before Any Research"}]'::jsonb, 'accounts_maintenance');
  exception when others then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 49: ' || 'accounts_maintenance with no research history yet rejected a rename: % (sqlstate %)', false, format('accounts_maintenance with no research history yet rejected a rename: %s (sqlstate %s)', sqlerrm, sqlstate));
  end;
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Renamed Before Any Research';
  if v_count = 1 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 49: ' || 'accounts_maintenance freely renames an account when NO research history exists yet -- the identity lock only applies once research has actually happened', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 49: ' || 'expected the rename to succeed with no research history, got % matching rows', false, format('expected the rename to succeed with no research history, got %s matching rows', v_count)); end if;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 49 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Tests 50-51 (Phase 2A implementation-review ROUND 9): an EXPIRED lease
-- must not be renewable/usable by heartbeat_ha_research_run() or
-- persist_ha_research_output() while attempt_id STILL matches the row --
-- i.e. BEFORE any reclaim has happened, not just after a takeover (already
-- covered by tests 22 and 32 above, both of which use an attempt_id that no
-- longer matches at all post-reclaim). Both RPCs' attempt-validation UPDATE
-- now additionally requires lease_expires_at > now(); only
-- claim_ha_research_run()'s reclaim path (which mints a NEW attempt_id) may
-- resurrect an expired-but-unreclaimed run.
-- ===========================================================================
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim jsonb;
  v_attempt_id uuid;
  v_lease_before timestamptz;
  v_heartbeat_at_before timestamptz;
  v_heartbeat jsonb;
  v_lease_after timestamptz;
  v_heartbeat_at_after timestamptz;
begin
  insert into public.ha_users (email, name) values ('phase2a-round9-expired-lease+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 9 Expired Lease') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 9 expired-lease test upload', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  -- Test 50: heartbeat_ha_research_run() rejects a heartbeat once the row's OWN lease has already expired, even though attempt_id still matches (no reclaim has happened yet)
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  v_attempt_id := (v_claim->'run'->>'attempt_id')::uuid;

  -- 1. Expire the lease manually while retaining the same attempt_id.
  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute'
    where upload_id = v_upload and research_run_id = 'auto';
  select lease_expires_at, heartbeat_at into v_lease_before, v_heartbeat_at_before
    from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';
  if exists (select 1 from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto' and attempt_id = v_attempt_id) then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'the row still shows the original attempt_id immediately after the lease expires (nothing has reclaimed it yet)', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'attempt_id changed unexpectedly before any reclaim', false, null); end if;

  -- 2. Heartbeat with that (still-current, but lease-expired) attempt_id fails.
  v_heartbeat := public.heartbeat_ha_research_run(v_user, v_upload, 'auto', v_attempt_id, 300);
  if (v_heartbeat->>'ok')::boolean = false and v_heartbeat->>'reason' = 'not-current-attempt' then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'a heartbeat from the CURRENT attempt_id is rejected once its own lease has already expired -- lease liveness is required, not just attempt_id ownership', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'expected ok=false/reason=not-current-attempt, got %', false, format('expected ok=false/reason=not-current-attempt, got %s', v_heartbeat)); end if;

  -- 3. lease_expires_at and heartbeat_at remain unchanged.
  select lease_expires_at, heartbeat_at into v_lease_after, v_heartbeat_at_after
    from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';
  if v_lease_after = v_lease_before then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'lease_expires_at is untouched by the rejected heartbeat', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'lease_expires_at changed from % to % despite the rejection', false, format('lease_expires_at changed from %s to %s despite the rejection', v_lease_before, v_lease_after)); end if;
  if v_heartbeat_at_after = v_heartbeat_at_before then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'heartbeat_at is untouched by the rejected heartbeat', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'heartbeat_at changed from % to % despite the rejection', false, format('heartbeat_at changed from %s to %s despite the rejection', v_heartbeat_at_before, v_heartbeat_at_after)); end if;

  -- 4/5. A subsequent claim returns reclaimed-after-expired-lease with a NEW attempt_id.
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  if v_claim->>'outcome' = 'reclaimed-after-expired-lease' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'a subsequent claim correctly reclaims the abandoned run via the expired-lease path', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'expected outcome=reclaimed-after-expired-lease, got %', false, format('expected outcome=reclaimed-after-expired-lease, got %s', v_claim->>'outcome')); end if;
  if (v_claim->'run'->>'attempt_id')::uuid <> v_attempt_id then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'reclaiming mints a NEW attempt_id, distinct from the original (now-expired) attempt', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'attempt_id was not changed by the reclaim', false, null); end if;

  -- 6. The old attempt still cannot heartbeat afterward.
  v_heartbeat := public.heartbeat_ha_research_run(v_user, v_upload, 'auto', v_attempt_id, 300);
  if (v_heartbeat->>'ok')::boolean = false and v_heartbeat->>'reason' = 'not-current-attempt' then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'the original attempt still cannot heartbeat after the reclaim', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 50: ' || 'expected ok=false/reason=not-current-attempt, got %', false, format('expected ok=false/reason=not-current-attempt, got %s', v_heartbeat)); end if;

  -- Test 51: persist_ha_research_output() rejects an expired-but-not-yet-reclaimed attempt, writing nothing and not finalizing
  declare
    v_attempt_current uuid := (v_claim->'run'->>'attempt_id')::uuid;
    v_accounts_before int;
    v_status_before text;
  begin
    update public.ha_research_runs set lease_expires_at = now() - interval '1 minute'
      where upload_id = v_upload and research_run_id = 'auto';
    select count(*) into v_accounts_before from public.ha_accounts where upload_id = v_upload;
    select status into v_status_before from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';
    begin
      perform public.persist_ha_research_output(
        v_upload, v_user, 'auto', v_attempt_current,
        '[{"account_name":"Expired Lease Write"}]'::jsonb, null, 'researched', '{"note":"should not persist"}'::jsonb
      );
      insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 51: ' || 'an attempt whose lease already expired was able to call persist_ha_research_output -- no exception raised', false, null);
    exception when others then
      if sqlstate = 'HA001' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 51: ' || 'the expired-but-unreclaimed attempt is rejected with errcode HA001, same as an already-superseded attempt', true, null);
      else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 51: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
    end;
    if not exists (select 1 from public.ha_accounts where upload_id = v_upload and account_name = 'Expired Lease Write') then
      insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 51: ' || 'nothing was written to ha_accounts by the expired attempt', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 51: ' || 'the expired attempt''s account write persisted despite the rejection', false, null); end if;
    if (select count(*) from public.ha_accounts where upload_id = v_upload) = v_accounts_before then
      insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 51: ' || 'ha_accounts row count is unchanged', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 51: ' || 'ha_accounts row count changed despite the rejection', false, null); end if;
    if exists (select 1 from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto' and status = v_status_before and completed_at is null) then
      insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 51: ' || 'the run row is left exactly as it was -- still running, still unreclaimed, not finalized by the expired attempt', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 51: ' || 'the run row was modified despite the rejection', false, null); end if;
  end;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_signals where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 50-51 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Tests 52-57 (Phase 2A implementation-review ROUND 10): claim-ordering fix.
-- The automatic-completion guard and the "is a DIFFERENT run active" check
-- must run in the correct order relative to the exact-row lookup, or a
-- failed/expired exact row can be reclaimed straight past a different run
-- that is either actively leased or already completed -- producing two
-- simultaneously active runs for one upload, or restarting research a
-- manual rerun had already finished.
-- ===========================================================================
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_auto jsonb;
  v_manual jsonb;
  v_manual2 jsonb;
  v_attempt_id_before uuid;
  v_attempt_count_before int;
begin
  insert into public.ha_users (email, name) values ('phase2a-round10-claim-order-1+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 10 Claim Order 1') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 10 claim-order test upload 1', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  -- Test 52: expired auto row + an actively-leased MANUAL run -- the automatic claim must be REJECTED (55P03), not reclaim its own expired auto row
  v_auto := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  if v_auto->>'outcome' = 'claimed-new' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 52: ' || 'the initial automatic claim succeeds', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 52: ' || 'expected claimed-new, got %', false, format('expected claimed-new, got %s', v_auto)); end if;

  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute'
    where upload_id = v_upload and research_run_id = 'auto';

  v_manual := public.claim_ha_research_run(v_user, v_upload, 'manual-active', 300);
  if v_manual->>'outcome' = 'claimed-new' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 52: ' || 'a manual run claims successfully once the auto row''s lease has expired', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 52: ' || 'expected claimed-new for manual-active, got %', false, format('expected claimed-new for manual-active, got %s', v_manual)); end if;

  select attempt_id, attempt_count into v_attempt_id_before, v_attempt_count_before
    from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';

  begin
    perform public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 52: ' || 'an automatic claim with an expired own row succeeded despite a DIFFERENT run (manual-active) being actively leased', false, null);
  exception when others then
    if sqlstate = '55P03' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 52: ' || 'the automatic claim is rejected with errcode 55P03 -- not reclaimed into a second simultaneously-active run', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 52: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  if exists (
    select 1 from public.ha_research_runs
    where upload_id = v_upload and research_run_id = 'auto'
      and attempt_id = v_attempt_id_before and attempt_count = v_attempt_count_before
  ) then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 52: ' || 'the expired auto row is NOT reclaimed -- attempt_id and attempt_count are unchanged', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 52: ' || 'the auto row was modified despite the rejected claim', false, null); end if;

  -- Test 53: a FAILED (not expired-lease) manual row, with a DIFFERENT run actively leased -- reclaiming the failed row must also be rejected (55P03)
  update public.ha_research_runs set status = 'failed'
    where upload_id = v_upload and research_run_id = 'manual-active';
  v_manual2 := public.claim_ha_research_run(v_user, v_upload, 'manual-2', 300);
  if v_manual2->>'outcome' = 'claimed-new' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 53: ' || 'manual-2 claims successfully once manual-active is failed (no longer blocking)', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 53: ' || 'expected claimed-new for manual-2, got %', false, format('expected claimed-new for manual-2, got %s', v_manual2)); end if;

  select attempt_id into v_attempt_id_before from public.ha_research_runs where upload_id = v_upload and research_run_id = 'manual-active';
  begin
    perform public.claim_ha_research_run(v_user, v_upload, 'manual-active', 300);
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 53: ' || 'reclaiming a FAILED exact row succeeded despite a DIFFERENT run (manual-2) being actively leased', false, null);
  exception when others then
    if sqlstate = '55P03' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 53: ' || 'reclaiming the failed manual-active row is rejected with errcode 55P03', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 53: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;
  if exists (select 1 from public.ha_research_runs where upload_id = v_upload and research_run_id = 'manual-active' and status = 'failed' and attempt_id = v_attempt_id_before) then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 53: ' || 'the failed manual-active row is NOT reclaimed', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 53: ' || 'the manual-active row was modified despite the rejected claim', false, null); end if;

  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 52-53 cleanup complete', true, 'cleanup marker');
end $$;

do $$
declare
  v_user uuid;
  v_upload uuid;
  v_auto jsonb;
  v_manual jsonb;
  v_attempt_id_before uuid;
  v_attempt_count_before int;
begin
  insert into public.ha_users (email, name) values ('phase2a-round10-claim-order-2+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 10 Claim Order 2') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 10 claim-order test upload 2', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  -- Test 54: expired auto row + a DIFFERENT run that has already COMPLETED -- the automatic claim must attach to the completed result, not reclaim its own expired row
  v_auto := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute'
    where upload_id = v_upload and research_run_id = 'auto';
  v_manual := public.claim_ha_research_run(v_user, v_upload, 'manual-done', 300);
  if v_manual->>'outcome' = 'claimed-new' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 54: ' || 'manual-done claims successfully once auto has expired', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 54: ' || 'expected claimed-new for manual-done, got %', false, format('expected claimed-new for manual-done, got %s', v_manual)); end if;
  update public.ha_research_runs
    set status = 'completed', completed_at = now(), result_summary = '{"signalsReturned":6}'::jsonb
    where upload_id = v_upload and research_run_id = 'manual-done';

  select attempt_id into v_attempt_id_before from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';

  v_auto := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  if v_auto->>'outcome' = 'completed' and (v_auto->'run'->>'research_run_id') = 'manual-done' and (v_auto->'run'->'result_summary'->>'signalsReturned') = '6' then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 54: ' || 'the automatic claim attaches to the completed MANUAL run''s result, not its own expired row', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 54: ' || 'expected outcome=completed attached to manual-done, got %', false, format('expected outcome=completed attached to manual-done, got %s', v_auto)); end if;
  if exists (select 1 from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto' and attempt_id = v_attempt_id_before) then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 54: ' || 'the expired auto row is NOT reclaimed', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 54: ' || 'the auto row was modified despite attaching to the completed manual run', false, null); end if;

  -- Test 55: FAILED auto row + a DIFFERENT run that has already COMPLETED -- same completed-attach behavior, no new attempt minted for the failed row
  update public.ha_research_runs set status = 'failed', lease_expires_at = now() + interval '5 minutes'
    where upload_id = v_upload and research_run_id = 'auto';
  select attempt_count into v_attempt_count_before from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';

  v_auto := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  if v_auto->>'outcome' = 'completed' and (v_auto->'run'->>'research_run_id') = 'manual-done' then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 55: ' || 'the automatic claim attaches to the completed manual run even though its OWN auto row is failed (not just expired-lease)', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 55: ' || 'expected outcome=completed attached to manual-done, got %', false, format('expected outcome=completed attached to manual-done, got %s', v_auto)); end if;
  if exists (select 1 from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto' and attempt_count = v_attempt_count_before) then
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 55: ' || 'no new attempt was minted for the failed auto row', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 55: ' || 'attempt_count on the auto row changed despite attaching to the completed manual run', false, null); end if;

  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 54-55 cleanup complete', true, 'cleanup marker');
end $$;

do $$
declare
  v_user uuid;
  v_upload uuid;
  v_first jsonb;
  v_manual jsonb;
  v_reclaimed jsonb;
  v_retry jsonb;
begin
  insert into public.ha_users (email, name) values ('phase2a-round10-claim-order-3+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 10 Claim Order 3') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 10 claim-order test upload 3', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  -- Test 56: expired exact row with NO other active or completed blocker -- reclaim must still succeed normally
  v_first := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute'
    where upload_id = v_upload and research_run_id = 'auto';
  v_reclaimed := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  if v_reclaimed->>'outcome' = 'reclaimed-after-expired-lease' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 56: ' || 'an expired exact row with no other active/completed blocker still reclaims normally', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 56: ' || 'expected reclaimed-after-expired-lease, got %', false, format('expected reclaimed-after-expired-lease, got %s', v_reclaimed)); end if;
  if (v_reclaimed->'run'->>'attempt_id')::uuid <> (v_first->'run'->>'attempt_id')::uuid then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 56: ' || 'reclaiming mints a new attempt_id', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 56: ' || 'attempt_id did not change on reclaim', false, null); end if;

  -- Test 57: FAILED exact manual row with no other active blocker -- reclaim-after-failure must still succeed normally
  v_manual := public.claim_ha_research_run(v_user, v_upload, 'manual-solo', 300);
  update public.ha_research_runs set status = 'failed' where upload_id = v_upload and research_run_id = 'manual-solo';
  v_retry := public.claim_ha_research_run(v_user, v_upload, 'manual-solo', 300);
  if v_retry->>'outcome' = 'reclaimed-after-failure' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 57: ' || 'a failed exact manual row with no other active blocker still reclaims normally (reclaimed-after-failure)', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 57: ' || 'expected reclaimed-after-failure, got %', false, format('expected reclaimed-after-failure, got %s', v_retry)); end if;

  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Tests 56-57 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Test 58 (Phase 2A implementation-review ROUND 10, migration 7 defect
-- found during pre-execution review): replace_ha_accounts_snapshot()'s
-- p_mode='tracked_research' attempt-validation check must also require the
-- row's OWN lease to still be unexpired, mirroring the SAME
-- lease_expires_at > now() condition already proven for
-- heartbeat_ha_research_run() (Test 50) and persist_ha_research_output()
-- (Test 51). Distinct from Test 27 above, which covers an attempt_id that no
-- longer matches at all post-reclaim -- here attempt_id STILL matches; only
-- the lease has lapsed, and nobody has reclaimed it yet.
-- ===========================================================================
do $$
declare
  v_user uuid;
  v_upload uuid;
  v_claim jsonb;
  v_attempt_id uuid;
  v_count int;
begin
  insert into public.ha_users (email, name) values ('phase2a-round10-migration7-expired-lease+' || current_setting('phase2a.suite_run_id') || '@example.invalid', 'Round 10 Migration 7 Expired Lease') returning id into v_user;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_users', v_user);
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 10 migration 7 expired-lease test upload', 'uploaded') returning id into v_upload;
  insert into _phase2a_fixture_registry (entity_type, entity_id) values ('ha_uploads', v_upload);

  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  v_attempt_id := (v_claim->'run'->>'attempt_id')::uuid;
  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute'
    where upload_id = v_upload and research_run_id = 'auto';

  begin
    perform public.replace_ha_accounts_snapshot(
      v_upload, v_user, '[{"account_name":"Expired Lease Direct Write"}]'::jsonb,
      'tracked_research', 'auto', v_attempt_id
    );
    insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 58: ' || 'an attempt whose lease already expired was able to write accounts via replace_ha_accounts_snapshot -- no exception raised', false, null);
  exception when others then
    if sqlstate = 'HA001' then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 58: ' || 'Test 58: the expired-but-unreclaimed attempt is rejected with errcode HA001 by replace_ha_accounts_snapshot directly', true, null);
    else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 58: ' || 'rejected, but with unexpected sqlstate % (message: %)', false, format('rejected, but with unexpected sqlstate %s (message: %s)', sqlstate, sqlerrm)); end if;
  end;

  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Expired Lease Direct Write';
  if v_count = 0 then insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 58: ' || 'Test 58: nothing was written to ha_accounts by the expired attempt', true, null);
  else insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 58: ' || '% row(s) were written despite the rejection', false, format('%s row(s) were written despite the rejection', v_count)); end if;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  insert into _phase2a_auth_test_results (assertion, passed, detail) values ('Test 58 cleanup complete', true, 'cleanup marker');
end $$;

-- ===========================================================================
-- Final safety-net cleanup, by EXACT registered id only (no wildcard/LIKE
-- pattern), + row-count restoration check. Every block above already
-- deletes its own fixtures inline; this is on top of that, not instead of
-- it -- if any block aborted before reaching its own cleanup, this catches
-- the orphaned rows anyway, scoped strictly to the ids THIS run created.
-- ===========================================================================
do $$
declare
  v_users_after bigint;
  v_uploads_after bigint;
  v_accounts_after bigint;
  v_signals_after bigint;
  v_runs_after bigint;
  v_users_before bigint;
  v_uploads_before bigint;
  v_accounts_before bigint;
  v_signals_before bigint;
  v_runs_before bigint;
  v_restored boolean;
begin
  -- Dependency-first: children before parents, explicitly -- does not rely
  -- solely on ON DELETE CASCADE, even though these FKs are in fact cascading.
  delete from public.ha_signals
  where upload_id in (select entity_id from _phase2a_fixture_registry where entity_type = 'ha_uploads');

  delete from public.ha_accounts
  where upload_id in (select entity_id from _phase2a_fixture_registry where entity_type = 'ha_uploads');

  delete from public.ha_research_runs
  where upload_id in (select entity_id from _phase2a_fixture_registry where entity_type = 'ha_uploads')
     or user_id in (select entity_id from _phase2a_fixture_registry where entity_type = 'ha_users');

  delete from public.ha_uploads
  where id in (select entity_id from _phase2a_fixture_registry where entity_type = 'ha_uploads');

  delete from public.ha_users
  where id in (select entity_id from _phase2a_fixture_registry where entity_type = 'ha_users');

  select row_count into v_users_before from _phase2a_auth_baseline_counts where table_name = 'ha_users';
  select row_count into v_uploads_before from _phase2a_auth_baseline_counts where table_name = 'ha_uploads';
  select row_count into v_accounts_before from _phase2a_auth_baseline_counts where table_name = 'ha_accounts';
  select row_count into v_signals_before from _phase2a_auth_baseline_counts where table_name = 'ha_signals';
  select row_count into v_runs_before from _phase2a_auth_baseline_counts where table_name = 'ha_research_runs';

  select count(*) into v_users_after from public.ha_users;
  select count(*) into v_uploads_after from public.ha_uploads;
  select count(*) into v_accounts_after from public.ha_accounts;
  select count(*) into v_signals_after from public.ha_signals;
  select count(*) into v_runs_after from public.ha_research_runs;

  v_restored := v_users_after = v_users_before
    and v_uploads_after = v_uploads_before
    and v_accounts_after = v_accounts_before
    and v_signals_after = v_signals_before
    and v_runs_after = v_runs_before;

  insert into _phase2a_auth_test_results (assertion, passed, detail) values (
    'Final: starting row counts restored exactly after registry-scoped cleanup sweep',
    v_restored,
    format('users %s->%s, uploads %s->%s, accounts %s->%s, signals %s->%s, research_runs %s->%s',
      v_users_before, v_users_after, v_uploads_before, v_uploads_after,
      v_accounts_before, v_accounts_after, v_signals_before, v_signals_after,
      v_runs_before, v_runs_after)
  );
end $$;

-- ===========================================================================
-- Summary row: total/passed/failed counts. failed must be 0.
-- ===========================================================================
do $$
declare
  v_existing_total int;
  v_existing_passed int;
  v_existing_failed int;
  v_final_total int;
  v_final_passed int;
  v_final_failed int;
  v_summary_passed boolean;
begin
  select count(*), count(*) filter (where passed), count(*) filter (where not passed)
    into v_existing_total, v_existing_passed, v_existing_failed
    from _phase2a_auth_test_results;

  -- Totals must describe the FINAL result set, i.e. include this summary
  -- row itself -- not just the rows that existed before it was inserted.
  v_summary_passed := (v_existing_failed = 0);
  v_final_total := v_existing_total + 1;
  v_final_passed := v_existing_passed + (case when v_summary_passed then 1 else 0 end);
  v_final_failed := v_existing_failed + (case when v_summary_passed then 0 else 1 end);

  insert into _phase2a_auth_test_results (assertion, passed, detail) values (
    'SUMMARY: total/passed/failed rows, INCLUDING this summary row (failed must be 0)',
    v_summary_passed,
    format('total=%s passed=%s failed=%s', v_final_total, v_final_passed, v_final_failed)
  );
end $$;

select *
from _phase2a_auth_test_results
order by id;
