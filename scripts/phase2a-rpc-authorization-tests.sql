-- Phase 2A implementation-review item 1 — authorization tests for
-- replace_ha_accounts_snapshot(). These are genuine Postgres privilege/logic
-- tests (role switching, RLS-equivalent grant enforcement, exception
-- handling) that cannot be meaningfully verified with a JS/HTTP mock — they
-- require a real Postgres instance. NOT executed from this session (no
-- database connection available). Run manually against a non-production
-- Supabase project AFTER migration 4 has been applied there, before trusting
-- this function against production.
--
-- Each block is self-contained and prints PASS/FAIL via RAISE NOTICE. Run
-- the whole file in the Supabase SQL editor (as a role that can execute
-- `set role`, i.e. the postgres/service_role connection, NOT through
-- PostgREST) and read the output.

-- ===========================================================================
-- Setup: two fake users and two uploads, one per user, plus a stray
-- nonexistent upload id for the "nonexistent upload" case. Cleaned up at the
-- end so this file is safe to re-run.
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
  insert into public.ha_users (email, name) values ('phase2a-test-owner-a@example.com', 'Test Owner A') returning id into v_user_a;
  insert into public.ha_users (email, name) values ('phase2a-test-owner-b@example.com', 'Test Owner B') returning id into v_user_b;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user_a, 'Phase 2A RPC test upload A', 'uploaded') returning id into v_upload_a;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user_b, 'Phase 2A RPC test upload B', 'uploaded') returning id into v_upload_b;

  raise notice '--- Test 1: correct owner and upload ---';
  begin
    perform public.replace_ha_accounts_snapshot(v_upload_a, v_user_a, '[{"account_name":"Test Co"}]'::jsonb);
    select count(*) into v_count from public.ha_accounts where upload_id = v_upload_a and account_name = 'Test Co';
    if v_count = 1 then raise notice 'PASS: correct owner successfully replaces their own upload''s accounts';
    else raise notice 'FAIL: expected 1 row for the correct owner, got %', v_count; end if;
  exception when others then
    raise notice 'FAIL: correct owner/upload call raised an unexpected exception: %', sqlerrm;
  end;

  raise notice '--- Test 2: wrong user against another user''s upload ---';
  begin
    perform public.replace_ha_accounts_snapshot(v_upload_a, v_user_b, '[{"account_name":"Hijacked"}]'::jsonb);
    raise notice 'FAIL: user B was able to replace user A''s upload accounts -- no exception raised';
  exception when others then
    if sqlstate = '42501' then raise notice 'PASS: wrong-user call against another user''s upload is rejected with the expected ownership exception (42501)';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload_a and account_name = 'Hijacked';
  if v_count = 0 then raise notice 'PASS: no row was written to upload A as a result of the rejected cross-user call';
  else raise notice 'FAIL: % row(s) were written to upload A despite the rejection', v_count; end if;

  raise notice '--- Test 3: nonexistent upload ---';
  begin
    perform public.replace_ha_accounts_snapshot(v_nonexistent_upload, v_user_a, '[{"account_name":"Ghost"}]'::jsonb);
    raise notice 'FAIL: a nonexistent upload_id was accepted -- no exception raised';
  exception when others then
    if sqlstate = '42501' then raise notice 'PASS: a nonexistent upload_id is rejected with the same ownership exception (42501) as a real ownership mismatch -- does not leak whether the upload exists at all';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;

  -- cleanup
  delete from public.ha_accounts where upload_id in (v_upload_a, v_upload_b);
  delete from public.ha_uploads where id in (v_upload_a, v_upload_b);
  delete from public.ha_users where id in (v_user_a, v_user_b);
  raise notice '--- Tests 1-3 cleanup complete ---';
end $$;

-- ===========================================================================
-- Test 4: anon call — must be rejected at the GRANT level, before the
-- function body's own logic ever runs. Requires the `anon` role to actually
-- exist (it does in any standard Supabase project).
-- ===========================================================================
do $$
begin
  set role anon;
  begin
    perform public.replace_ha_accounts_snapshot(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb);
    raise notice 'FAIL: anon role was able to call replace_ha_accounts_snapshot at all -- EXECUTE grant is not properly revoked';
  exception when insufficient_privilege then
    raise notice 'PASS: anon role is rejected at the privilege level (insufficient_privilege) before the function body runs';
  when others then
    raise notice 'FAIL: anon call raised an unexpected error (expected insufficient_privilege): % (sqlstate %)', sqlerrm, sqlstate;
  end;
  reset role;
end $$;

-- ===========================================================================
-- Test 5: authenticated direct RPC call — per this migration's design (§5),
-- this SHOULD be forbidden: there is no RLS-safe design justifying direct
-- client access, so EXECUTE is revoked from authenticated exactly like anon.
-- ===========================================================================
do $$
begin
  set role authenticated;
  begin
    perform public.replace_ha_accounts_snapshot(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb);
    raise notice 'FAIL: authenticated role was able to call replace_ha_accounts_snapshot directly -- EXECUTE grant is not properly revoked';
  exception when insufficient_privilege then
    raise notice 'PASS: authenticated role is rejected at the privilege level (insufficient_privilege), matching the intended service_role-only design';
  when others then
    raise notice 'FAIL: authenticated call raised an unexpected error (expected insufficient_privilege): % (sqlstate %)', sqlerrm, sqlstate;
  end;
  reset role;
end $$;

-- ===========================================================================
-- Test 6 (sanity): service_role CAN call it. If this fails, the GRANT to
-- service_role itself is missing/broken, which would break
-- api/save-upload.js entirely in production.
-- ===========================================================================
do $$
begin
  set role service_role;
  begin
    perform public.replace_ha_accounts_snapshot(gen_random_uuid(), gen_random_uuid(), '[]'::jsonb);
    raise notice 'FAIL: service_role call unexpectedly succeeded against a nonexistent upload/user (should hit the ownership check, sqlstate 42501)';
  exception when sqlstate '42501' then
    raise notice 'PASS: service_role CAN call the function (reaches the function body -- rejected here only because the test upload/user do not exist, which is the correct, expected outcome for this specific call)';
  when insufficient_privilege then
    raise notice 'FAIL: service_role itself is blocked at the privilege level -- the GRANT to service_role is missing';
  end;
  reset role;
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
  insert into public.ha_users (email, name) values ('phase2a-round2-owner@example.com', 'Round 2 Owner') returning id into v_user;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 2 RPC test upload', 'uploaded') returning id into v_upload;

  raise notice '--- Test 7: malformed JSON (a JSON object instead of an array) is rejected atomically ---';
  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user, '{"account_name":"Not An Array"}'::jsonb);
    raise notice 'FAIL: a JSON object was accepted in place of an array -- no exception raised';
  exception when others then
    if sqlstate = '22023' then raise notice 'PASS: a non-array p_accounts value is rejected with the expected errcode 22023, and the exception is explicit rather than a generic internal error';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload;
  if v_count = 0 then raise notice 'PASS: the malformed-input call did not delete or insert anything for this upload (atomic failure -- see the accounts already present from Test 1''s upload A are a DIFFERENT upload, so this is expected to be empty for a fresh upload)';
  else raise notice 'FAIL: % row(s) exist for this upload despite the rejected malformed call', v_count; end if;

  raise notice '--- Test 8: malformed JSON (a bare scalar) is also rejected ---';
  begin
    perform public.replace_ha_accounts_snapshot(v_upload, v_user, '"just a string"'::jsonb);
    raise notice 'FAIL: a bare JSON scalar was accepted in place of an array -- no exception raised';
  exception when others then
    if sqlstate = '22023' then raise notice 'PASS: a scalar p_accounts value is rejected with errcode 22023';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;

  raise notice '--- Test 9: duplicate account_name values within one p_accounts array are resolved deterministically (last occurrence wins), not an error ---';
  begin
    v_rows := public.replace_ha_accounts_snapshot(v_upload, v_user,
      '[{"account_name":"Acme Corp","industry":"first"},{"account_name":"Acme Corp","industry":"second-and-last"}]'::jsonb);
  exception when others then
    raise notice 'FAIL: an in-array duplicate account_name raised an exception instead of being resolved deterministically: % (sqlstate %)', sqlerrm, sqlstate;
  end;
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Acme Corp';
  if v_count = 1 then raise notice 'PASS: exactly one row survives for the duplicated account_name (not two, not zero, not an error)';
  else raise notice 'FAIL: expected exactly 1 row for the duplicated account_name, got %', v_count; end if;
  if exists (select 1 from public.ha_accounts where upload_id = v_upload and account_name = 'Acme Corp' and industry = 'second-and-last') then
    raise notice 'PASS: the surviving row reflects the LAST occurrence in the array (industry=second-and-last), matching the documented deterministic tie-break';
  else raise notice 'FAIL: the surviving row does not reflect the last occurrence in the array as documented';
  end if;

  raise notice '--- Test 10: a spoofed per-row "user_id" field inside an account object is ignored -- ownership always comes from the verified p_user_id parameter ---';
  perform public.replace_ha_accounts_snapshot(v_upload, v_user,
    ('[{"account_name":"Spoof Target","user_id":"' || gen_random_uuid()::text || '"}]')::jsonb);
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Spoof Target' and user_id = v_user;
  if v_count = 1 then raise notice 'PASS: the inserted row''s user_id is the verified p_user_id parameter, not the spoofed per-row value from the JSON payload';
  else raise notice 'FAIL: the spoofed per-row user_id was NOT correctly overridden by p_user_id -- expected 1 row owned by the real user, got %', v_count; end if;

  raise notice '--- Test 11: an empty p_accounts array explicitly clears the upload''s account list ---';
  v_rows := public.replace_ha_accounts_snapshot(v_upload, v_user, '[]'::jsonb);
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload;
  if v_count = 0 then raise notice 'PASS: calling with an empty array clears all accounts for the upload (explicit full-snapshot-replace semantics), rather than being a no-op or an error';
  else raise notice 'FAIL: expected 0 accounts remaining after an empty-array call, got %', v_count; end if;

  raise notice '--- Test 12: returned rows belong ONLY to p_upload_id and p_user_id ---';
  perform public.replace_ha_accounts_snapshot(v_upload, v_user, '[{"account_name":"Scoping Check A"},{"account_name":"Scoping Check B"}]'::jsonb);
  select count(distinct (upload_id, user_id)) into v_distinct_owner_pairs
  from public.ha_accounts where upload_id = v_upload;
  if v_distinct_owner_pairs = 1 then raise notice 'PASS: every returned/persisted row for this call carries exactly one (upload_id, user_id) pair -- (%, %)', v_upload, v_user;
  else raise notice 'FAIL: expected exactly one distinct (upload_id, user_id) pair among the persisted rows, found %', v_distinct_owner_pairs; end if;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  raise notice '--- Tests 7-12 cleanup complete ---';
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
  insert into public.ha_users (email, name) values ('phase2a-round2-run-owner@example.com', 'Round 2 Run Owner') returning id into v_user_a;
  insert into public.ha_users (email, name) values ('phase2a-round2-run-other@example.com', 'Round 2 Run Other') returning id into v_user_b;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user_a, 'Phase 2A round 2 run test upload', 'uploaded') returning id into v_upload_a;

  raise notice '--- Test 13: correct owner claims a brand-new run ---';
  v_result := public.claim_ha_research_run(v_user_a, v_upload_a, 'auto', 300);
  if v_result->>'outcome' = 'claimed-new' then raise notice 'PASS: a fresh claim for a new (user, upload, run_id) triple returns outcome=claimed-new';
  else raise notice 'FAIL: expected outcome=claimed-new, got %', v_result->>'outcome'; end if;

  raise notice '--- Test 14: the SAME run id while still actively leased attaches, does not create a second row ---';
  v_result := public.claim_ha_research_run(v_user_a, v_upload_a, 'auto', 300);
  if v_result->>'outcome' = 'attached-active' then raise notice 'PASS: re-claiming the same run id while its lease is still valid returns outcome=attached-active (idempotent, does not restart research)';
  else raise notice 'FAIL: expected outcome=attached-active, got %', v_result->>'outcome'; end if;
  select count(*) into v_count from public.ha_research_runs where upload_id = v_upload_a and research_run_id = 'auto';
  if v_count = 1 then raise notice 'PASS: exactly one row exists for (user_a, upload_a, auto) after two claim attempts';
  else raise notice 'FAIL: expected exactly 1 row, found %', v_count; end if;

  raise notice '--- Test 15: a DIFFERENT run id while "auto" is actively leased is rejected (55P03), not joined ---';
  begin
    perform public.claim_ha_research_run(v_user_a, v_upload_a, 'manual-test-1', 300);
    raise notice 'FAIL: a second, different run id was allowed to claim while another run is actively leased';
  exception when others then
    if sqlstate = '55P03' then raise notice 'PASS: a different run id is rejected with errcode 55P03 while "auto" is still actively leased';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;

  raise notice '--- Test 16: wrong user cannot claim against another user''s upload ---';
  begin
    perform public.claim_ha_research_run(v_user_b, v_upload_a, 'hijack-attempt', 300);
    raise notice 'FAIL: user B was able to claim a run against user A''s upload -- no exception raised';
  exception when others then
    if sqlstate = '42501' then raise notice 'PASS: a wrong-user claim against another user''s upload is rejected with errcode 42501';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;

  raise notice '--- Test 17: nonexistent upload is rejected the same way (no existence leak) ---';
  begin
    perform public.claim_ha_research_run(v_user_a, gen_random_uuid(), 'ghost', 300);
    raise notice 'FAIL: a nonexistent upload_id was accepted -- no exception raised';
  exception when others then
    if sqlstate = '42501' then raise notice 'PASS: a nonexistent upload_id is rejected with the same errcode 42501 as a real ownership mismatch';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;

  raise notice '--- Test 18: a manually expired lease is reclaimable, and reclaiming mints a NEW attempt_id ---';
  declare
    v_old_attempt uuid;
    v_new_attempt uuid;
  begin
    select attempt_id into v_old_attempt from public.ha_research_runs where upload_id = v_upload_a and research_run_id = 'auto';
    update public.ha_research_runs set lease_expires_at = now() - interval '1 minute' where upload_id = v_upload_a and research_run_id = 'auto';
    v_result := public.claim_ha_research_run(v_user_a, v_upload_a, 'auto', 300);
    v_new_attempt := (v_result->'run'->>'attempt_id')::uuid;
    if v_result->>'outcome' = 'reclaimed-after-expired-lease' then raise notice 'PASS: a claim against a row with an expired lease reclaims it (outcome=reclaimed-after-expired-lease), simulating recovery from a process that died mid-flight without ever marking the run failed';
    else raise notice 'FAIL: expected outcome=reclaimed-after-expired-lease, got %', v_result->>'outcome'; end if;
    if v_new_attempt <> v_old_attempt then raise notice 'PASS: reclaiming an expired lease mints a NEW attempt_id (% -> %)', v_old_attempt, v_new_attempt;
    else raise notice 'FAIL: attempt_id did not change after reclaiming an expired lease'; end if;
  end;

  raise notice '--- Test 19: a DIFFERENT run id can now claim, because "auto"''s lease was expired (not merely status=running) at claim time ---';
  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute' where upload_id = v_upload_a and research_run_id = 'auto';
  v_result := public.claim_ha_research_run(v_user_a, v_upload_a, 'manual-test-2', 300);
  if v_result->>'outcome' = 'claimed-new' then raise notice 'PASS: a different run id successfully claims once the previously-active run''s lease has expired -- proves the claim logic checks lease_expires_at, not just status=''running''';
  else raise notice 'FAIL: expected outcome=claimed-new for the new run id after the old one''s lease expired, got %', v_result->>'outcome'; end if;

  raise notice '--- Test 20 (sanity): anon and authenticated cannot call claim_ha_research_run at all ---';
  set role anon;
  begin
    perform public.claim_ha_research_run(gen_random_uuid(), gen_random_uuid(), 'x', 300);
    raise notice 'FAIL: anon role was able to call claim_ha_research_run -- EXECUTE grant is not properly revoked';
  exception when insufficient_privilege then
    raise notice 'PASS: anon role is rejected at the privilege level before the function body runs';
  when others then
    raise notice 'FAIL: anon call raised an unexpected error (expected insufficient_privilege): % (sqlstate %)', sqlerrm, sqlstate;
  end;
  reset role;
  set role authenticated;
  begin
    perform public.claim_ha_research_run(gen_random_uuid(), gen_random_uuid(), 'x', 300);
    raise notice 'FAIL: authenticated role was able to call claim_ha_research_run directly -- EXECUTE grant is not properly revoked';
  exception when insufficient_privilege then
    raise notice 'PASS: authenticated role is rejected at the privilege level, matching the intended service_role-only design';
  when others then
    raise notice 'FAIL: authenticated call raised an unexpected error (expected insufficient_privilege): % (sqlstate %)', sqlerrm, sqlstate;
  end;
  reset role;

  delete from public.ha_research_runs where upload_id = v_upload_a;
  delete from public.ha_uploads where id = v_upload_a;
  delete from public.ha_users where id in (v_user_a, v_user_b);
  raise notice '--- Tests 13-20 cleanup complete ---';
end $$;
