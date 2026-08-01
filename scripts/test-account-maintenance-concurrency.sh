#!/usr/bin/env bash
# Phase 2A implementation-review ROUND 7, item 3 — two-SESSION concurrency
# test for replace_ha_accounts_snapshot()'s p_mode=accounts_maintenance
# active-run check (supabase-schema-migration-7-mode-scoped-account-writes.sql).
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
# in production. Requires: bash, psql, and a DATABASE_URL env var pointing
# at a direct (non-PgBouncer-transaction-mode) Postgres connection --
# advisory locks and multi-statement transactions require a session-level
# connection, exactly like the rest of this schema's locking model.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/test-account-maintenance-concurrency.sh
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
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a direct (session-mode) Postgres connection string before running this script.}"

PSQL="psql \"$DATABASE_URL\" -X -q -v ON_ERROR_STOP=1"
SCRATCH_DIR="$(mktemp -d)"
trap 'rm -rf "$SCRATCH_DIR"' EXIT

echo "=== Phase 2A ROUND 7 two-session concurrency test ==="
echo "Scratch dir: $SCRATCH_DIR"

# ---------------------------------------------------------------------------
# Shared setup: one user, one fresh upload, captured as psql variables via a
# small bootstrap file both sessions source.
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
cat "$SCRATCH_DIR/setup.out"
USER_ID=$(grep '^USER_ID' "$SCRATCH_DIR/setup.out" | awk '{print $2}')
UPLOAD_ID=$(grep '^UPLOAD_ID' "$SCRATCH_DIR/setup.out" | awk '{print $2}')
echo "user_id=$USER_ID upload_id=$UPLOAD_ID"

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

cat > "$SCRATCH_DIR/session_b_maintenance.sql" <<SQL
select clock_timestamp() as b_started \gset
select public.replace_ha_accounts_snapshot(
  '$UPLOAD_ID'::uuid, '$USER_ID'::uuid,
  '[{"account_name":"Blocked Maintenance Edit"}]'::jsonb,
  'accounts_maintenance'
);
\echo SESSION_B_UNEXPECTED_SUCCESS
SQL

( eval $PSQL -f "$SCRATCH_DIR/session_a_claim.sql" > "$SCRATCH_DIR/session_a.out" 2>&1 ) &
A_PID=$!
sleep 0.5 # let session A acquire the advisory lock first
START_B=$(date +%s.%N)
if eval $PSQL -f "$SCRATCH_DIR/session_b_maintenance.sql" > "$SCRATCH_DIR/session_b.out" 2>&1; then
  echo "FAIL: session B (accounts_maintenance) unexpectedly succeeded -- it should have blocked on A's lock and then been rejected 55P03 once A committed with an active run"
  cat "$SCRATCH_DIR/session_b.out"
else
  END_B=$(date +%s.%N)
  ELAPSED=$(echo "$END_B - $START_B" | bc)
  if grep -q "55P03" "$SCRATCH_DIR/session_b.out"; then
    echo "PASS: session B was rejected with errcode 55P03 (a research run is currently active), only after actually being able to see A's committed claim"
  else
    echo "FAIL: session B was rejected, but not with 55P03 -- see output below"
    cat "$SCRATCH_DIR/session_b.out"
  fi
  if (( $(echo "$ELAPSED >= 2.5" | bc -l) )); then
    echo "PASS: session B was genuinely BLOCKED for ~3s by session A's advisory lock (measured ${ELAPSED}s) -- it did not race ahead and evaluate a stale pre-claim state"
  else
    echo "FAIL: session B returned too quickly (${ELAPSED}s) to have actually been blocked by A's lock -- the two calls may not be sharing the same advisory lock key"
  fi
fi
wait "$A_PID"
grep -q SESSION_A_DONE "$SCRATCH_DIR/session_a.out" && echo "PASS: session A's claim committed successfully" || { echo "FAIL: session A did not complete as expected"; cat "$SCRATCH_DIR/session_a.out"; }

if ! eval $PSQL -c "select count(*) from public.ha_accounts where upload_id = '$UPLOAD_ID'::uuid;" | grep -q " 0"; then
  echo "FAIL: the rejected accounts_maintenance call in scenario 1 still wrote a row"
else
  echo "PASS: no account row was written by the rejected accounts_maintenance call"
fi

eval $PSQL -c "delete from public.ha_research_runs where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null

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
select clock_timestamp() as a_started \gset
select public.claim_ha_research_run('$USER_ID'::uuid, '$UPLOAD_ID'::uuid, 'auto', 300);
\echo SESSION_A_CLAIM_DONE
SQL

( eval $PSQL -f "$SCRATCH_DIR/session_b_maintenance_first.sql" > "$SCRATCH_DIR/session_b2.out" 2>&1 ) &
B_PID=$!
sleep 0.5
START_A=$(date +%s.%N)
eval $PSQL -f "$SCRATCH_DIR/session_a_claim_second.sql" > "$SCRATCH_DIR/session_a2.out" 2>&1
END_A=$(date +%s.%N)
ELAPSED_A=$(echo "$END_A - $START_A" | bc)
wait "$B_PID"

grep -q SESSION_B_DONE "$SCRATCH_DIR/session_b2.out" && echo "PASS: session B's (first) maintenance edit committed successfully -- no active run existed yet, so its own check passed" || { echo "FAIL: session B did not complete as expected"; cat "$SCRATCH_DIR/session_b2.out"; }
grep -q SESSION_A_CLAIM_DONE "$SCRATCH_DIR/session_a2.out" && echo "PASS: session A's claim succeeded once it could finally acquire the lock after B committed" || { echo "FAIL: session A's claim did not complete as expected"; cat "$SCRATCH_DIR/session_a2.out"; }
if (( $(echo "$ELAPSED_A >= 2.5" | bc -l) )); then
  echo "PASS: session A was genuinely BLOCKED for ~3s by session B's advisory lock (measured ${ELAPSED_A}s) -- lock ownership, not call order in application code, determines who proceeds first"
else
  echo "FAIL: session A returned too quickly (${ELAPSED_A}s) to have actually been blocked by B's lock"
fi

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
eval $PSQL -c "delete from public.ha_signals where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null
eval $PSQL -c "delete from public.ha_accounts where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null
eval $PSQL -c "delete from public.ha_research_runs where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null
eval $PSQL -c "delete from public.ha_uploads where id = '$UPLOAD_ID'::uuid;" > /dev/null
eval $PSQL -c "delete from public.ha_users where id = '$USER_ID'::uuid;" > /dev/null
echo ""
echo "=== cleanup complete ==="
