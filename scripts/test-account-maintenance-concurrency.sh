#!/usr/bin/env bash
# Phase 2A implementation-review ROUND 7, item 3 (hardened ROUND 8, item 3)
# — two-SESSION concurrency test for replace_ha_accounts_snapshot()'s
# p_mode=accounts_maintenance active-run check
# (supabase-schema-migration-7-mode-scoped-account-writes.sql).
#
# Every other *.sql test file in this repo runs single-session, sequential
# PL/pgSQL and can only ASSERT that the check-then-write is atomic (one
# function body, one implicit transaction) — it cannot demonstrate the thing
# that actually matters under real concurrency: that a research claim
# (claim_ha_research_run()) and an accounts_maintenance write
# (replace_ha_accounts_snapshot()) racing for the SAME upload_id are
# genuinely SERIALIZED by the advisory lock they share (hashtext(upload_id)),
# not merely "checked" against a snapshot that could be stale by the time
# the write happens. This script drives that with two REAL, concurrent
# psql connections and deterministic pg_sleep-based interleaving.
#
# NOT executed in this session — no live database connection is available
# here (same constraint as scripts/phase2a-rpc-authorization-tests.sql).
# Run this manually against a non-production Supabase/Postgres instance,
# AFTER migration 7 has been applied there, before trusting this behavior
# in production. Requires: bash and psql only (see ROUND 8 item 3 fix notes
# below for why `bc` is no longer required). DATABASE_URL must point at a
# direct (non-PgBouncer-transaction-mode) Postgres connection — advisory
# locks and multi-statement transactions require a session-level
# connection, exactly like the rest of this schema's locking model.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/test-account-maintenance-concurrency.sh
#
# =============================================================================
# ROUND 8, item 3 — what changed from the ROUND 7 version, and why
# =============================================================================
# 1. SQLSTATE detection: the old version grepped session B's raw psql error
#    output for the literal string "55P03". Default psql error formatting
#    (VERBOSITY=default) does NOT include the SQLSTATE code in that output
#    at all — the grep could silently never match even when the RPC
#    correctly raised 55P03, misreporting a PASS as a FAIL (or worse,
#    matching some unrelated coincidental substring). Every RPC call this
#    script makes is now wrapped in its own `do $$ ... exception when
#    others then raise notice 'CONCURRENCY_RESULT:SQLSTATE=%', sqlstate;
#    end $$;` block (the same explicit-capture pattern
#    scripts/phase2a-rpc-authorization-tests.sql already uses throughout) --
#    this prints a single, deterministic, greppable marker line regardless
#    of any client-side verbosity setting, because it is emitted by our own
#    RAISE NOTICE, not parsed out of Postgres's error-formatting output.
# 2. `bc` is no longer used anywhere. Elapsed-time measurement now uses
#    `date +%s%N` (whole nanoseconds, an integer) and bash's native integer
#    arithmetic (`$(( ... ))`) exclusively -- no floating-point comparison,
#    no external dependency beyond bash and psql themselves.
# 3. `set -e` is no longer used. A failed assertion (or a genuinely
#    unexpected command failure) no longer aborts the script before
#    cleanup runs -- every check funnels through pass()/fail() below, which
#    record the outcome and let the script continue, and a `trap cleanup
#    EXIT` (registered immediately after the shared fixture is created)
#    guarantees the DELETE statements at the bottom run on EVERY exit path,
#    not just the successful one.
# 4. The script now exits non-zero if ANY assertion failed (tracked via a
#    FAILURES counter, checked at the very end), so it is safe to wire into
#    CI/automation and have a failure actually be noticed.
#
# =============================================================================
# WHAT EACH SCENARIO PROVES
# =============================================================================
# Scenario 1 — "research claim occurs before account replacement, only one
# operation can win under the shared advisory lock, account maintenance
# cannot write after the run becomes active":
#   Session A opens an explicit transaction, calls claim_ha_research_run()
#   (which internally takes pg_advisory_xact_lock(hashtext(upload_id))) and
#   then SLEEPS for 3 seconds BEFORE committing -- simulating "the claim is
#   in flight." Session B, started concurrently, calls
#   replace_ha_accounts_snapshot(..., 'accounts_maintenance') for the SAME
#   upload_id. Because both functions take the SAME lock key, B blocks for
#   the full 3 seconds session A is sleeping -- B cannot even begin its
#   active-run check until A's transaction ends. Once A commits (the run is
#   now genuinely 'running' and durably visible), B proceeds, sees the
#   now-active run, and is rejected with errcode 55P03. This is the
#   guarantee that matters: B's check is never evaluated against a
#   pre-claim snapshot, because it physically cannot run until A's
#   transaction has fully resolved one way or the other.
#
# Scenario 2 — the reverse interleaving, to confirm the serialization is
# genuinely mutual, not a one-way effect: session B (accounts_maintenance)
# takes the lock FIRST (via a deliberately slow, sleeping transaction) while
# NO research history exists yet, so its own check passes; session A
# (a research claim) is blocked until B commits, then proceeds normally
# afterward. This confirms a legitimate maintenance edit that starts first
# is not spuriously blocked or corrupted by a claim racing in behind it, and
# that lock ownership -- not call order in application code -- is what
# determines who wins.
#
# =============================================================================
set -uo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a direct (session-mode) Postgres connection string before running this script.}"

PSQL="psql \"$DATABASE_URL\" -X -q -v ON_ERROR_STOP=1"
SCRATCH_DIR="$(mktemp -d)"

FAILURES=0
pass(){ echo "PASS: $1"; }
fail(){ echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# Registered EARLY (before either session's SQL work below) so cleanup
# fires no matter how the script exits -- a failed assertion (which no
# longer calls `set -e`-triggered early exit, see item 3 above), a genuine
# command failure, Ctrl-C, or normal completion all route through here.
USER_ID=""
UPLOAD_ID=""
cleanup(){
  rm -rf "$SCRATCH_DIR"
  if [ -n "$UPLOAD_ID" ]; then
    eval $PSQL -c "delete from public.ha_signals where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1
    eval $PSQL -c "delete from public.ha_accounts where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1
    eval $PSQL -c "delete from public.ha_research_runs where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1
    eval $PSQL -c "delete from public.ha_uploads where id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1
  fi
  if [ -n "$USER_ID" ]; then
    eval $PSQL -c "delete from public.ha_users where id = '$USER_ID'::uuid;" > /dev/null 2>&1
  fi
  echo ""
  echo "=== cleanup complete ==="
}
trap cleanup EXIT

echo "=== Phase 2A ROUND 7/8 two-session concurrency test ==="
echo "Scratch dir: $SCRATCH_DIR"

# ---------------------------------------------------------------------------
# Shared setup: one user, one fresh upload.
# ---------------------------------------------------------------------------
eval $PSQL <<'SQL' > "$SCRATCH_DIR/setup.out"
insert into public.ha_users (email, name)
  values ('phase2a-round7-concurrency@example.com', 'Round 7 Concurrency')
  on conflict (email) do update set name = excluded.name
  returning id as user_id \gset
insert into public.ha_uploads (user_id, upload_name, stage)
  values (:'user_id', 'Phase 2A round 7 concurrency test upload', 'uploaded')
  returning id as upload_id \gset
\echo USER_ID :user_id
\echo UPLOAD_ID :upload_id
SQL
SETUP_STATUS=$?
cat "$SCRATCH_DIR/setup.out"
if [ $SETUP_STATUS -ne 0 ]; then
  fail "shared setup (user + upload) failed -- cannot run either scenario"
  echo ""
  echo "$((FAILURES)) FAILURE(S)"
  exit 1
fi
USER_ID=$(grep '^USER_ID' "$SCRATCH_DIR/setup.out" | awk '{print $2}')
UPLOAD_ID=$(grep '^UPLOAD_ID' "$SCRATCH_DIR/setup.out" | awk '{print $2}')
if [ -z "$USER_ID" ] || [ -z "$UPLOAD_ID" ]; then
  fail "shared setup did not produce a USER_ID/UPLOAD_ID -- cannot run either scenario"
  exit 1
fi
echo "user_id=$USER_ID upload_id=$UPLOAD_ID"

# Returns nanoseconds since epoch as a plain integer -- used for elapsed-time
# assertions via bash integer arithmetic only (no bc, no floating point).
now_ns(){ date +%s%N; }

# ---------------------------------------------------------------------------
# Scenario 1: claim wins the lock first; accounts_maintenance blocks, then
# is correctly rejected once it can finally see the (now-committed) active run.
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 1: claim first, maintenance blocks then is rejected (55P03) ---"

cat > "$SCRATCH_DIR/session_a_claim.sql" <<SQL
begin;
select public.claim_ha_research_run('$USER_ID'::uuid, '$UPLOAD_ID'::uuid, 'auto', 300);
select pg_sleep(3); -- hold the advisory lock while "claiming" is in flight
commit;
\echo SESSION_A_DONE
SQL

# Wrapped so the SQLSTATE of any exception is captured deterministically --
# see "ROUND 8, item 3" note above. This prints exactly one
# CONCURRENCY_RESULT: line no matter what happens.
cat > "$SCRATCH_DIR/session_b_maintenance.sql" <<SQL
do \$outer\$
begin
  perform public.replace_ha_accounts_snapshot(
    '$UPLOAD_ID'::uuid, '$USER_ID'::uuid,
    '[{"account_name":"Blocked Maintenance Edit"}]'::jsonb,
    'accounts_maintenance'
  );
  raise notice 'CONCURRENCY_RESULT:SUCCESS';
exception when others then
  raise notice 'CONCURRENCY_RESULT:SQLSTATE=%', sqlstate;
end
\$outer\$;
SQL

( eval $PSQL -f "$SCRATCH_DIR/session_a_claim.sql" > "$SCRATCH_DIR/session_a.out" 2>&1 ) &
A_PID=$!
sleep 0.5 # let session A acquire the advisory lock first
START_B=$(now_ns)
eval $PSQL -f "$SCRATCH_DIR/session_b_maintenance.sql" > "$SCRATCH_DIR/session_b.out" 2>&1
END_B=$(now_ns)
ELAPSED_B_NS=$((END_B - START_B))

if grep -q 'CONCURRENCY_RESULT:SQLSTATE=55P03' "$SCRATCH_DIR/session_b.out"; then
  pass "session B was rejected with errcode 55P03 (a research run is currently active), only after actually being able to see A's committed claim"
elif grep -q 'CONCURRENCY_RESULT:SUCCESS' "$SCRATCH_DIR/session_b.out"; then
  fail "session B (accounts_maintenance) unexpectedly succeeded -- it should have blocked on A's lock and then been rejected 55P03 once A committed with an active run"
  cat "$SCRATCH_DIR/session_b.out"
else
  fail "session B produced neither a CONCURRENCY_RESULT:SUCCESS nor a CONCURRENCY_RESULT:SQLSTATE= line -- see output below (a connection error, a syntax error, or psql itself failing would all land here)"
  cat "$SCRATCH_DIR/session_b.out"
fi

# 2,500,000,000 ns = 2.5s -- integer nanosecond comparison, no bc.
if [ "$ELAPSED_B_NS" -ge 2500000000 ]; then
  pass "session B was genuinely BLOCKED for ~3s by session A's advisory lock (measured $((ELAPSED_B_NS / 1000000))ms) -- it did not race ahead and evaluate a stale pre-claim state"
else
  fail "session B returned too quickly ($((ELAPSED_B_NS / 1000000))ms) to have actually been blocked by A's lock -- the two calls may not be sharing the same advisory lock key"
fi

wait "$A_PID"
if grep -q SESSION_A_DONE "$SCRATCH_DIR/session_a.out"; then
  pass "session A's claim committed successfully"
else
  fail "session A did not complete as expected"
  cat "$SCRATCH_DIR/session_a.out"
fi

ACCOUNT_COUNT=$(eval $PSQL -t -A -c "select count(*) from public.ha_accounts where upload_id = '$UPLOAD_ID'::uuid;" 2>/dev/null)
if [ "$ACCOUNT_COUNT" = "0" ]; then
  pass "no account row was written by the rejected accounts_maintenance call"
else
  fail "the rejected accounts_maintenance call in scenario 1 still wrote a row (count=$ACCOUNT_COUNT)"
fi

eval $PSQL -c "delete from public.ha_research_runs where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1

# ---------------------------------------------------------------------------
# Scenario 2: reverse interleaving -- maintenance takes the lock first (no
# active run yet, so its own check passes), claim blocks until maintenance
# commits, then proceeds normally.
# ---------------------------------------------------------------------------
echo ""
echo "--- Scenario 2: maintenance first (legitimate, no history yet), claim blocks then proceeds normally ---"

cat > "$SCRATCH_DIR/session_b_maintenance_first.sql" <<SQL
begin;
select public.replace_ha_accounts_snapshot(
  '$UPLOAD_ID'::uuid, '$USER_ID'::uuid,
  '[{"account_name":"Pre-Research Maintenance Edit"}]'::jsonb,
  'accounts_maintenance'
);
select pg_sleep(3); -- hold the advisory lock while "maintenance" is in flight
commit;
\echo SESSION_B_DONE
SQL

cat > "$SCRATCH_DIR/session_a_claim_second.sql" <<SQL
select public.claim_ha_research_run('$USER_ID'::uuid, '$UPLOAD_ID'::uuid, 'auto', 300);
\echo SESSION_A_CLAIM_DONE
SQL

( eval $PSQL -f "$SCRATCH_DIR/session_b_maintenance_first.sql" > "$SCRATCH_DIR/session_b2.out" 2>&1 ) &
B_PID=$!
sleep 0.5
START_A=$(now_ns)
eval $PSQL -f "$SCRATCH_DIR/session_a_claim_second.sql" > "$SCRATCH_DIR/session_a2.out" 2>&1
END_A=$(now_ns)
ELAPSED_A_NS=$((END_A - START_A))
wait "$B_PID"

if grep -q SESSION_B_DONE "$SCRATCH_DIR/session_b2.out"; then
  pass "session B's (first) maintenance edit committed successfully -- no active run existed yet, so its own check passed"
else
  fail "session B did not complete as expected"
  cat "$SCRATCH_DIR/session_b2.out"
fi
if grep -q SESSION_A_CLAIM_DONE "$SCRATCH_DIR/session_a2.out"; then
  pass "session A's claim succeeded once it could finally acquire the lock after B committed"
else
  fail "session A's claim did not complete as expected"
  cat "$SCRATCH_DIR/session_a2.out"
fi
if [ "$ELAPSED_A_NS" -ge 2500000000 ]; then
  pass "session A was genuinely BLOCKED for ~3s by session B's advisory lock (measured $((ELAPSED_A_NS / 1000000))ms) -- lock ownership, not call order in application code, determines who proceeds first"
else
  fail "session A returned too quickly ($((ELAPSED_A_NS / 1000000))ms) to have actually been blocked by B's lock"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CONCURRENCY ASSERTIONS PASSED"
else
  echo "$FAILURES CONCURRENCY ASSERTION(S) FAILED"
fi
exit $([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)
