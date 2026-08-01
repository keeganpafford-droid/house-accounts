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
