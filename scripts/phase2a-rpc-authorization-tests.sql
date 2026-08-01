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
  insert into public.ha_users (email, name) values ('phase2a-round3-heartbeat@example.com', 'Round 3 Heartbeat') returning id into v_user;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 3 heartbeat test upload', 'uploaded') returning id into v_upload;

  raise notice '--- Test 21: heartbeat succeeds for the current owning attempt and extends the lease ---';
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  v_attempt_id := (v_claim->'run'->>'attempt_id')::uuid;
  v_lease_1 := (v_claim->'run'->>'lease_expires_at')::timestamptz;
  perform pg_sleep(1);
  v_heartbeat := public.heartbeat_ha_research_run(v_user, v_upload, 'auto', v_attempt_id, 300);
  v_lease_2 := (v_heartbeat->'run'->>'lease_expires_at')::timestamptz;
  if (v_heartbeat->>'ok')::boolean = true then raise notice 'PASS: heartbeat succeeds for the current owning attempt (ok=true)';
  else raise notice 'FAIL: expected ok=true, got %', v_heartbeat->>'ok'; end if;
  if v_lease_2 > v_lease_1 then raise notice 'PASS: heartbeat extends lease_expires_at forward (% -> %)', v_lease_1, v_lease_2;
  else raise notice 'FAIL: lease_expires_at did not advance after heartbeat'; end if;

  raise notice '--- Test 22: heartbeat with a WRONG (stale/replaced) attempt_id fails without raising, and does not extend the lease ---';
  v_heartbeat := public.heartbeat_ha_research_run(v_user, v_upload, 'auto', gen_random_uuid(), 300);
  if (v_heartbeat->>'ok')::boolean = false and v_heartbeat->>'reason' = 'not-current-attempt' then
    raise notice 'PASS: a heartbeat with a non-matching attempt_id returns ok=false, reason=not-current-attempt -- not an exception';
  else raise notice 'FAIL: expected ok=false/not-current-attempt, got %', v_heartbeat; end if;

  raise notice '--- Test 23: an excessive client-requested lease duration is clamped server-side, not honored verbatim ---';
  v_heartbeat := public.heartbeat_ha_research_run(v_user, v_upload, 'auto', v_attempt_id, 999999999);
  if (v_heartbeat->'run'->>'lease_expires_at')::timestamptz <= now() + interval '901 seconds' then
    raise notice 'PASS: an excessive p_lease_seconds request is clamped to the server-side maximum (900s), not honored verbatim';
  else raise notice 'FAIL: lease_expires_at reflects an unclamped, excessive lease duration'; end if;

  raise notice '--- Test 24: anon/authenticated cannot call heartbeat_ha_research_run at all ---';
  set role anon;
  begin
    perform public.heartbeat_ha_research_run(gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 300);
    raise notice 'FAIL: anon role was able to call heartbeat_ha_research_run -- EXECUTE grant is not properly revoked';
  exception when insufficient_privilege then
    raise notice 'PASS: anon role is rejected at the privilege level before the function body runs';
  end;
  reset role;
  set role authenticated;
  begin
    perform public.heartbeat_ha_research_run(gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), 300);
    raise notice 'FAIL: authenticated role was able to call heartbeat_ha_research_run directly -- EXECUTE grant is not properly revoked';
  exception when insufficient_privilege then
    raise notice 'PASS: authenticated role is rejected at the privilege level, matching the intended service_role-only design';
  end;
  reset role;

  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  raise notice '--- Tests 21-24 cleanup complete ---';
end $$;

do $$
declare
  v_user uuid;
  v_upload uuid;
  v_manual jsonb;
  v_auto jsonb;
begin
  insert into public.ha_users (email, name) values ('phase2a-round3-manual-before-auto@example.com', 'Round 3 Manual Before Auto') returning id into v_user;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 3 manual-before-auto test upload', 'uploaded') returning id into v_upload;

  raise notice '--- Test 25: a manual run completes, THEN the automatic path claims for the first time -- must attach to the completed manual run, not start new ---';
  v_manual := public.claim_ha_research_run(v_user, v_upload, 'manual-before-auto-1', 300);
  update public.ha_research_runs set status = 'completed', completed_at = now(), result_summary = '{"signalsReturned": 3}'::jsonb
    where id = (v_manual->'run'->>'id')::uuid;
  v_auto := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  if v_auto->>'outcome' = 'completed' and (v_auto->'run'->>'research_run_id') = 'manual-before-auto-1' then
    raise notice 'PASS: the automatic claim attaches to the already-completed MANUAL run instead of starting new research -- regardless of run id label';
  else raise notice 'FAIL: expected outcome=completed attached to the manual run, got %', v_auto; end if;
  if not exists (select 1 from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto') then
    raise notice 'PASS: no new "auto" row was created -- the automatic path did not start a new run';
  else raise notice 'FAIL: an "auto" row was created despite an existing completed manual run'; end if;

  raise notice '--- Test 26: an explicit manual rerun is still allowed after that same completed run ---';
  v_manual := public.claim_ha_research_run(v_user, v_upload, 'manual-before-auto-2', 300);
  if v_manual->>'outcome' = 'claimed-new' then raise notice 'PASS: an explicit manual-rerun request succeeds after a completed run (auto or manual) -- the separate, authorized pathway is unaffected by the automatic-path block';
  else raise notice 'FAIL: expected outcome=claimed-new for the explicit manual rerun, got %', v_manual; end if;

  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  raise notice '--- Tests 25-26 cleanup complete ---';
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
  insert into public.ha_users (email, name) values ('phase2a-round3-persistence@example.com', 'Round 3 Persistence') returning id into v_user;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 3 persistence test upload', 'uploaded') returning id into v_upload;

  v_claim_a := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  -- Simulate attempt A's lease expiring, then attempt B reclaiming (exactly
  -- the 5-step race from migration 4 §9).
  update public.ha_research_runs set lease_expires_at = now() - interval '1 minute' where upload_id = v_upload and research_run_id = 'auto';
  v_claim_b := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);

  begin
    perform public.replace_ha_accounts_snapshot(
      v_upload, v_user, '[{"account_name":"Stale Attempt Write"}]'::jsonb,
      'auto', (v_claim_a->'run'->>'attempt_id')::uuid
    );
    raise notice 'FAIL: the STALE attempt A was able to write accounts after being superseded by attempt B -- no exception raised';
  exception when others then
    if sqlstate = 'HA001' then raise notice 'PASS: attempt A (superseded by B''s reclaim) is rejected with errcode HA001 when it tries to save';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Stale Attempt Write';
  if v_count = 0 then raise notice 'PASS: the stale attempt''s rejected call wrote nothing to ha_accounts';
  else raise notice 'FAIL: % row(s) were written despite the rejection', v_count; end if;

  perform public.replace_ha_accounts_snapshot(
    v_upload, v_user, '[{"account_name":"Current Attempt Write"}]'::jsonb,
    'auto', (v_claim_b->'run'->>'attempt_id')::uuid
  );
  select count(*) into v_count from public.ha_accounts where upload_id = v_upload and account_name = 'Current Attempt Write';
  if v_count = 1 then raise notice 'PASS: the CURRENT attempt B successfully writes accounts using the same (research_run_id, attempt_id) guard';
  else raise notice 'FAIL: expected 1 row from the current attempt''s write, got %', v_count; end if;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  raise notice '--- Test 27 cleanup complete ---';
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
  insert into public.ha_users (email, name) values ('phase2a-round4-persist-owner@example.com', 'Round 4 Persist Owner') returning id into v_user_a;
  insert into public.ha_users (email, name) values ('phase2a-round4-persist-other@example.com', 'Round 4 Persist Other') returning id into v_user_b;
  insert into public.ha_uploads (user_id, upload_name, stage, summary) values (v_user_a, 'Phase 2A round 4 persist test upload', 'uploaded', '{"seed":true}'::jsonb) returning id into v_upload_a;

  v_signals := '[{"account_name":"Acme Co","signal_hash":"h1","event_fingerprint":"fp-1","signal_type":"Acquisition","title":"Acme acquires Rival","confidence":80}]'::jsonb;

  raise notice '--- Test 28: correct owner, current attempt -- accounts + signals + upload-state all persist together ---';
  v_claim_a := public.claim_ha_research_run(v_user_a, v_upload_a, 'auto', 300);
  v_result := public.persist_ha_research_output(
    v_upload_a, v_user_a, 'auto', (v_claim_a->'run'->>'attempt_id')::uuid,
    '[{"account_name":"Acme Co"}]'::jsonb, v_signals, 'researched', '{"accountCount":1}'::jsonb
  );
  if (v_result->>'accountsPersisted')::int = 1 then raise notice 'PASS: accountsPersisted = 1';
  else raise notice 'FAIL: expected accountsPersisted=1, got %', v_result->>'accountsPersisted'; end if;
  if (v_result->>'signalsPersisted')::int = 1 and (v_result->>'signalsAttempted')::int = 1 then raise notice 'PASS: signalsAttempted=1, signalsPersisted=1';
  else raise notice 'FAIL: unexpected signals counts in %', v_result; end if;
  select into v_upload_row stage, summary from public.ha_uploads where id = v_upload_a;
  if v_upload_row.stage = 'researched' and v_upload_row.summary->>'accountCount' = '1' then raise notice 'PASS: ha_uploads.stage/summary updated atomically alongside accounts/signals';
  else raise notice 'FAIL: ha_uploads.stage/summary not updated as expected (got stage=%, summary=%)', v_upload_row.stage, v_upload_row.summary; end if;

  raise notice '--- Test 29: a SECOND call with the same signal (same event_fingerprint) is an intentional conflict, not an error ---';
  v_result := public.persist_ha_research_output(v_upload_a, v_user_a, 'auto', (v_claim_a->'run'->>'attempt_id')::uuid, null, v_signals, null, null);
  if (v_result->>'signalsAttempted')::int = 1 and (v_result->>'signalsPersisted')::int = 0 and (v_result->>'signalsConflictIgnored')::int = 1 then
    raise notice 'PASS: a repeat signal is attempted=1, persisted=0, conflictIgnored=1 -- not an error, not silently absent';
  else raise notice 'FAIL: unexpected repeat-signal counts in %', v_result; end if;

  raise notice '--- Test 30: wrong user cannot call this RPC against another user''s upload ---';
  begin
    perform public.persist_ha_research_output(v_upload_a, v_user_b, 'auto', (v_claim_a->'run'->>'attempt_id')::uuid, null, null, null, null);
    raise notice 'FAIL: user B was able to call persist_ha_research_output against user A''s upload';
  exception when others then
    if sqlstate = '42501' then raise notice 'PASS: wrong-user call rejected with errcode 42501';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;

  raise notice '--- Test 31: nonexistent upload rejected the same way ---';
  begin
    perform public.persist_ha_research_output(gen_random_uuid(), v_user_a, 'auto', gen_random_uuid(), null, null, null, null);
    raise notice 'FAIL: a nonexistent upload_id was accepted';
  exception when others then
    if sqlstate = '42501' then raise notice 'PASS: nonexistent upload rejected with errcode 42501';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;

  raise notice '--- Test 32: STALE attempt -- accounts, signals, AND upload-state ALL rejected together, zero rows change in any of the three ---';
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
      raise notice 'FAIL: the stale attempt A was able to call persist_ha_research_output -- no exception raised';
    exception when others then
      if sqlstate = 'HA001' then raise notice 'PASS: stale attempt A is rejected with errcode HA001';
      else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
    end;
    select count(*) into v_count from public.ha_accounts where upload_id = v_upload_a;
    if v_count = v_accounts_before then raise notice 'PASS: ha_accounts row count unchanged after the rejected stale-attempt call (accounts NOT written)';
    else raise notice 'FAIL: ha_accounts row count changed from % to % despite the rejection', v_accounts_before, v_count; end if;
    select count(*) into v_count from public.ha_signals where upload_id = v_upload_a;
    if v_count = v_signals_before then raise notice 'PASS: ha_signals row count unchanged after the rejected stale-attempt call (signals NOT written) -- this is the specific invariant round 3 could not yet guarantee';
    else raise notice 'FAIL: ha_signals row count changed from % to % despite the rejection', v_signals_before, v_count; end if;
  end;
  if not exists (select 1 from public.ha_uploads where id = v_upload_a and summary->>'note' = 'should not persist') then
    raise notice 'PASS: ha_uploads.summary was NOT overwritten by the rejected stale-attempt call';
  else raise notice 'FAIL: ha_uploads.summary reflects the stale attempt''s rejected payload'; end if;
  if not exists (select 1 from public.ha_accounts where upload_id = v_upload_a and account_name = 'Stale Account Write') then
    raise notice 'PASS: the specific stale account row was never created';
  else raise notice 'FAIL: the stale account row exists despite the rejection'; end if;
  if not exists (select 1 from public.ha_signals where upload_id = v_upload_a and event_fingerprint = 'fp-stale') then
    raise notice 'PASS: the specific stale signal row was never created';
  else raise notice 'FAIL: the stale signal row exists despite the rejection'; end if;

  raise notice '--- Test 33: the CURRENT (post-reclaim) attempt succeeds where the stale one failed ---';
  v_result := public.persist_ha_research_output(
    v_upload_a, v_user_a, 'auto', (v_claim_b->'run'->>'attempt_id')::uuid,
    '[{"account_name":"Current Attempt Write"}]'::jsonb, null, null, null
  );
  if exists (select 1 from public.ha_accounts where upload_id = v_upload_a and account_name = 'Current Attempt Write') then
    raise notice 'PASS: the current (reclaimed) attempt successfully persists accounts using the exact same RPC that rejected the stale one';
  else raise notice 'FAIL: the current attempt''s write did not persist'; end if;

  raise notice '--- Test 34 (sanity): anon/authenticated cannot call persist_ha_research_output at all ---';
  set role anon;
  begin
    perform public.persist_ha_research_output(gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), null, null, null, null);
    raise notice 'FAIL: anon role was able to call persist_ha_research_output';
  exception when insufficient_privilege then
    raise notice 'PASS: anon role rejected at the privilege level';
  end;
  reset role;
  set role authenticated;
  begin
    perform public.persist_ha_research_output(gen_random_uuid(), gen_random_uuid(), 'x', gen_random_uuid(), null, null, null, null);
    raise notice 'FAIL: authenticated role was able to call persist_ha_research_output directly';
  exception when insufficient_privilege then
    raise notice 'PASS: authenticated role rejected at the privilege level';
  end;
  reset role;

  delete from public.ha_signals where upload_id = v_upload_a;
  delete from public.ha_accounts where upload_id = v_upload_a;
  delete from public.ha_research_runs where upload_id = v_upload_a;
  delete from public.ha_uploads where id = v_upload_a;
  delete from public.ha_users where id in (v_user_a, v_user_b);
  raise notice '--- Tests 28-34 cleanup complete ---';
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
  raise notice '--- Test 35: see the comment immediately above this block -- manual two-session verification required, not automatable here ---';
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
  insert into public.ha_users (email, name) values ('phase2a-round5-finalize@example.com', 'Round 5 Finalize') returning id into v_user;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 5 finalize test upload', 'uploaded') returning id into v_upload;

  raise notice '--- Test 36: persistence succeeds and the run becomes completed in the SAME transaction ---';
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  v_result := public.persist_ha_research_output(
    v_upload, v_user, 'auto', (v_claim->'run'->>'attempt_id')::uuid,
    '[{"account_name":"Finalize Test Co"}]'::jsonb, null, 'researched', '{"accountCount":1}'::jsonb
  );
  if v_result->>'status' = 'completed' then raise notice 'PASS: the RPC response itself reports status=completed';
  else raise notice 'FAIL: expected status=completed in the response, got %', v_result; end if;
  select status, completed_at, result_summary into v_row from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';
  if v_row.status = 'completed' and v_row.completed_at is not null then
    raise notice 'PASS: the ha_research_runs row itself is status=completed with completed_at set, persisted by the SAME call that wrote the account';
  else raise notice 'FAIL: expected the row to be completed, got status=%, completed_at=%', v_row.status, v_row.completed_at; end if;
  if (v_row.result_summary->>'accountsPersisted')::int = 1 then raise notice 'PASS: result_summary reflects the actual persisted account count';
  else raise notice 'FAIL: unexpected result_summary %', v_row.result_summary; end if;

  raise notice '--- Test 37: the SAME attempt cannot persist additional research output after its own completion ---';
  begin
    perform public.persist_ha_research_output(
      v_upload, v_user, 'auto', (v_claim->'run'->>'attempt_id')::uuid,
      '[{"account_name":"Should Not Persist"}]'::jsonb, null, null, null
    );
    raise notice 'FAIL: the already-completed attempt was able to persist again -- no exception raised';
  exception when others then
    if sqlstate = 'HA001' then raise notice 'PASS: a second call with the same (now-completed) attempt is rejected HA001, exactly like any other stale attempt';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;
  if not exists (select 1 from public.ha_accounts where upload_id = v_upload and account_name = 'Should Not Persist') then
    raise notice 'PASS: the rejected second call wrote nothing';
  else raise notice 'FAIL: the rejected second call''s account row exists'; end if;

  raise notice '--- Test 38: an automatic claim after this completion returns the cached result and blocks a new automatic run ---';
  v_claim2 := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  if v_claim2->>'outcome' = 'completed' and (v_claim2->'run'->'result_summary'->>'accountsPersisted')::int = 1 then
    raise notice 'PASS: a subsequent automatic claim returns outcome=completed with the SAME result_summary persist_ha_research_output() wrote -- no new research starts';
  else raise notice 'FAIL: expected outcome=completed with the cached result_summary, got %', v_claim2; end if;

  raise notice '--- Test 39: explicit manual rerun after completion remains authorized ---';
  v_claim2 := public.claim_ha_research_run(v_user, v_upload, 'manual-rerun-after-finalize', 300);
  if v_claim2->>'outcome' = 'claimed-new' then
    v_result := public.persist_ha_research_output(
      v_upload, v_user, 'manual-rerun-after-finalize', (v_claim2->'run'->>'attempt_id')::uuid,
      '[{"account_name":"Manual Rerun Persisted"}]'::jsonb, null, null, null
    );
    if v_result->>'status' = 'completed' and exists (select 1 from public.ha_accounts where upload_id = v_upload and account_name = 'Manual Rerun Persisted') then
      raise notice 'PASS: an explicit manual-rerun attempt claims, persists, AND finalizes successfully after the original run already completed';
    else raise notice 'FAIL: the manual rerun did not persist/finalize as expected: %', v_result; end if;
  else raise notice 'FAIL: expected the manual rerun to claim successfully, got %', v_claim2; end if;

  raise notice '--- Test 40 (sanity): wrong user / nonexistent upload rejected the same as every other RPC in this schema ---';
  begin
    perform public.persist_ha_research_output(v_upload, gen_random_uuid(), 'auto', gen_random_uuid(), null, null, null, null);
    raise notice 'FAIL: a random/wrong user id was accepted';
  exception when others then
    if sqlstate = '42501' then raise notice 'PASS: wrong-user call rejected with errcode 42501 (finalization included)';
    else raise notice 'FAIL: rejected, but with unexpected sqlstate % (message: %)', sqlstate, sqlerrm; end if;
  end;

  delete from public.ha_accounts where upload_id = v_upload;
  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  raise notice '--- Tests 36-40 cleanup complete ---';
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
begin
  insert into public.ha_users (email, name) values ('phase2a-round5-rollback@example.com', 'Round 5 Rollback') returning id into v_user;
  insert into public.ha_uploads (user_id, upload_name, stage) values (v_user, 'Phase 2A round 5 rollback test upload', 'uploaded') returning id into v_upload;
  v_claim := public.claim_ha_research_run(v_user, v_upload, 'auto', 300);
  select lease_expires_at into v_lease_before from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';

  begin
    perform public.persist_ha_research_output(
      v_upload, v_user, 'auto', (v_claim->'run'->>'attempt_id')::uuid,
      '{"not_an_array": true}'::jsonb, -- malformed -- replace_ha_accounts_snapshot rejects this with 22023
      '[{"account_name":"Should Not Persist Either","signal_hash":"h1","event_fingerprint":"fp-rollback"}]'::jsonb,
      'researched', '{"accountCount":999}'::jsonb
    );
    raise notice 'FAIL: malformed p_accounts was accepted -- no exception raised';
  exception when others then
    raise notice 'PASS: the malformed accounts payload raised an exception (sqlstate %), aborting the whole call', sqlstate;
  end;

  if not exists (select 1 from public.ha_accounts where upload_id = v_upload) then
    raise notice 'PASS: no accounts were persisted (the accounts write itself failed, so nothing downstream ran either)';
  else raise notice 'FAIL: accounts exist despite the failure'; end if;
  if not exists (select 1 from public.ha_signals where upload_id = v_upload and event_fingerprint = 'fp-rollback') then
    raise notice 'PASS: the signal that would have been inserted AFTER the failed accounts step never persisted -- confirms the whole transaction rolled back, not just the accounts statement';
  else raise notice 'FAIL: the signal exists despite the earlier failure in the same transaction'; end if;
  if not exists (select 1 from public.ha_uploads where id = v_upload and stage = 'researched') then
    raise notice 'PASS: ha_uploads.stage was NOT updated -- the upload-state write (which runs AFTER accounts/signals) never ran';
  else raise notice 'FAIL: ha_uploads.stage was updated despite the earlier failure'; end if;
  select status, lease_expires_at into v_lease_after from public.ha_research_runs where upload_id = v_upload and research_run_id = 'auto';
  if v_lease_after = v_lease_before then
    raise notice 'PASS: the run was NOT finalized and its lease was NOT even re-renewed by the failed call -- the attempt-validation UPDATE itself rolled back along with everything after it';
  else raise notice 'FAIL: the run''s lease_expires_at changed (%) despite the transaction failing -- partial commit occurred', v_lease_after;
  end if;

  delete from public.ha_research_runs where upload_id = v_upload;
  delete from public.ha_uploads where id = v_upload;
  delete from public.ha_users where id = v_user;
  raise notice '--- Test 41 cleanup complete ---';
end $$;
