#!/usr/bin/env bash
# Phase 2A implementation-review ROUND 7, item 3 (hardened ROUND 8, item 3;
# hardened again ROUND 9 for live-Supabase approval)
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
# Verified end-to-end against a real local PostgreSQL 16 instance loaded
# from supabase-schema.sql (see ROUND 9 execution notes). Run it manually
# against a non-production Supabase/Postgres instance, AFTER migration 7
# has been applied there, before trusting this behavior in production.
#
# Required utilities: bash (native integer arithmetic, arrays, $RANDOM) and
# psql only. Elapsed-time measurement is done via Postgres's own
# clock_timestamp(), read back through psql, NOT via `date +%s%N` — that
# %N field is a GNU coreutils extension absent from e.g. macOS/BSD date, so
# depending on it while claiming "bash and psql only" would be inaccurate.
# No `bc`, no other external dependency.
#
# DATABASE_URL must point at a direct (non-PgBouncer-transaction-mode)
# Postgres connection. Advisory locks and multi-statement transactions
# require a session-level connection, exactly like the rest of this
# schema's locking model — a Supabase transaction-pooler (port 6543)
# connection would silently invalidate this test's premise, so the script
# preflights the port below and refuses to run against one.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/test-account-maintenance-concurrency.sh
#
# =============================================================================
# ROUND 9 — what changed from the ROUND 8 version, and why
# =============================================================================
# 1. Unique fixture user, no UPSERT. The fixed, reusable
#    'phase2a-round7-concurrency@example.com' email + `ON CONFLICT (email) DO
#    UPDATE` is gone. Every run generates its own run id and its own
#    never-reused email (phase2a-concurrency+<run_id>@example.invalid), then
#    creates that user with a plain INSERT. This script must never adopt,
#    and later delete, a user row left behind by an earlier run.
# 2. Atomic fixture setup. The user and its upload are created together in
#    ONE statement (a CTE: insert into ha_users ... returning id, then
#    insert into ha_uploads selecting that id ... returning id) — a single
#    implicit transaction, so either both rows exist or neither does. The
#    exact fixture email is also kept in a shell variable so cleanup can
#    resolve the exact row by that exact value if the statement committed
#    but output parsing somehow failed to capture the IDs.
# 3. Exact-ID cleanup only, unchanged in spirit from ROUND 8: dependency-
#    first deletes (signals -> accounts -> research_runs -> upload -> user),
#    always scoped to a specific captured id. No LIKE, no prefix match, no
#    wildcard delete anywhere, including in the email-based fallback path
#    (the email is used only to look up the exact row's id, never as a
#    delete predicate against ha_accounts/ha_research_runs/ha_uploads).
# 4. No `eval`. `PSQL` is a bash array (`PSQL=(psql "$DATABASE_URL" -X -q -v
#    ON_ERROR_STOP=1)`), invoked everywhere as `"${PSQL[@]}" ...` — nothing
#    in DATABASE_URL can be reinterpreted by the shell the way a string
#    passed through `eval` could be.
# 5. Finite timeouts. `PGCONNECT_TIMEOUT=10` bounds connection attempts;
#    `PGOPTIONS='-c statement_timeout=20000'` bounds every statement in
#    every session (including the ones deliberately blocked on the shared
#    advisory lock) to 20s. Both scenarios' ~3s blocking windows sit
#    comfortably inside that budget. A stuck connection or a genuinely
#    wedged lock now produces a clear, bounded failure instead of an
#    indefinite hang.
# 6. Timing portability. `date +%s%N` is gone. Elapsed time is measured by
#    asking Postgres itself, via a tiny `select
#    (extract(epoch from clock_timestamp()) * 1000)::bigint` round trip
#    before and after the blocking call, and diffing the two millisecond
#    integers with bash's native `$(( ... ))` — no GNU-specific `date`, no
#    `bc`, matching the "bash and psql only" requirement literally.
# 7. Connection preflight. Before doing anything else, the script parses
#    just the host:port portion out of DATABASE_URL (without ever printing
#    DATABASE_URL itself) and refuses to run if the port is 6543 (Supabase's
#    transaction-pooler port), since transaction pooling does not give
#    session-scoped advisory locks and would silently invalidate every
#    assertion this script makes.
#
# =============================================================================
# ROUND 8, item 3 (retained) — SQLSTATE detection, no `bc`, no `set -e`
# =============================================================================
# - Every RPC call is wrapped in `do $$ ... exception when others then raise
#   notice 'CONCURRENCY_RESULT:SQLSTATE=%', sqlstate; end $$;` so the result
#   is a single, deterministic, greppable marker line regardless of client
#   verbosity settings, rather than grepping psql's own error formatting
#   (which does not reliably include the SQLSTATE code at all).
# - `set -e` is not used. A failed assertion no longer aborts the script
#   before cleanup runs — every check funnels through pass()/fail(), and a
#   `trap cleanup EXIT` (registered before any SQL work) guarantees the
#   DELETE statements run on every exit path.
# - The script exits non-zero if ANY assertion failed (tracked via a
#   FAILURES counter), so it is safe to wire into CI/automation.
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

# ---------------------------------------------------------------------------
# Connection preflight: refuse a Supabase transaction-pooler (port 6543)
# connection. Parses only the host:port segment out of the URL -- never
# echoes DATABASE_URL itself, anywhere, including in error output.
# ---------------------------------------------------------------------------
url_no_scheme="${DATABASE_URL#*://}"
url_no_userinfo="${url_no_scheme#*@}"
hostport="${url_no_userinfo%%/*}"
hostport="${hostport%%\?*}"
if [[ "$hostport" == *:6543 ]]; then
  echo "ERROR: DATABASE_URL targets port 6543 (Supabase's transaction-pooler port)." >&2
  echo "Advisory locks and multi-statement transactions require a direct or" >&2
  echo "session-mode connection (Supabase: port 5432, direct or session pooler)." >&2
  echo "Refusing to run this test against a transaction-pooler connection." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Finite timeouts: a bounded connection attempt and a bounded per-statement
# execution budget, so a bad connection or a genuinely wedged lock produces
# a clear failure instead of an indefinite hang. Both scenarios' ~3s
# blocking windows sit comfortably inside a 20s statement timeout.
# ---------------------------------------------------------------------------
export PGCONNECT_TIMEOUT=10
export PGOPTIONS='-c statement_timeout=20000'

# psql invoked as an array everywhere below, never via `eval` on a string --
# nothing in DATABASE_URL can be reinterpreted by the shell.
PSQL=(psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1)

SCRATCH_DIR="$(mktemp -d)"

FAILURES=0
pass(){ echo "PASS: $1"; }
fail(){ echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# ---------------------------------------------------------------------------
# Unique fixture identity: a fresh run id and a fresh, never-reused email.
# No ON CONFLICT / UPSERT anywhere in this script -- it must never adopt,
# and later delete, a user row left behind by an earlier run.
# ---------------------------------------------------------------------------
RUN_ID="$(date +%s)-$$-$RANDOM"
FIXTURE_EMAIL="phase2a-concurrency+${RUN_ID}@example.invalid"

# Registered EARLY (before either session's SQL work below) so cleanup
# fires no matter how the script exits -- a failed assertion (no `set -e`),
# a genuine command failure, Ctrl-C, or normal completion all route here.
USER_ID=""
UPLOAD_ID=""
cleanup(){
  rm -rf "$SCRATCH_DIR"

  # Fallback: if the atomic setup statement below committed but output
  # parsing somehow failed to capture USER_ID/UPLOAD_ID, resolve them from
  # the exact unique fixture email. This is still an exact-identity lookup,
  # not a wildcard match -- the email is freshly generated per run and
  # inserted with a plain INSERT, so an exact `= $FIXTURE_EMAIL` match can
  # only ever resolve to a row this specific run created.
  if [ -z "$USER_ID" ]; then
    USER_ID="$("${PSQL[@]}" -t -A -c "select id from public.ha_users where email = '$FIXTURE_EMAIL';" 2>/dev/null)"
  fi
  if [ -z "$UPLOAD_ID" ] && [ -n "$USER_ID" ]; then
    UPLOAD_ID="$("${PSQL[@]}" -t -A -c "select id from public.ha_uploads where user_id = '$USER_ID'::uuid;" 2>/dev/null)"
  fi

  if [ -n "$UPLOAD_ID" ]; then
    "${PSQL[@]}" -c "delete from public.ha_signals where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1
    "${PSQL[@]}" -c "delete from public.ha_accounts where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1
    "${PSQL[@]}" -c "delete from public.ha_research_runs where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1
    "${PSQL[@]}" -c "delete from public.ha_uploads where id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1
  fi
  if [ -n "$USER_ID" ]; then
    "${PSQL[@]}" -c "delete from public.ha_users where id = '$USER_ID'::uuid;" > /dev/null 2>&1
  fi
  echo ""
  echo "=== cleanup complete ==="
}
trap cleanup EXIT

echo "=== Phase 2A ROUND 7/8/9 two-session concurrency test ==="
echo "Scratch dir: $SCRATCH_DIR"
echo "Fixture run id: $RUN_ID"

# ---------------------------------------------------------------------------
# Shared setup: the user and its upload are created together in ONE atomic
# statement (a CTE, one implicit transaction) -- if either insert fails,
# both roll back, so there is never a user row without its upload or vice
# versa. Captures USER_ID/UPLOAD_ID from that same statement.
# ---------------------------------------------------------------------------
"${PSQL[@]}" <<SQL > "$SCRATCH_DIR/setup.out"
with new_user as (
  insert into public.ha_users (email, name)
  values ('$FIXTURE_EMAIL', 'Round 7 Concurrency')
  returning id
), new_upload as (
  insert into public.ha_uploads (user_id, upload_name, stage)
  select id, 'Phase 2A round 7 concurrency test upload', 'uploaded' from new_user
  returning id, user_id
)
select new_upload.user_id as user_id, new_upload.id as upload_id from new_upload \gset
\echo USER_ID :user_id
\echo UPLOAD_ID :upload_id
SQL
SETUP_STATUS=$?
cat "$SCRATCH_DIR/setup.out"
if [ $SETUP_STATUS -ne 0 ]; then
  fail "atomic shared setup (user + upload) failed -- cannot run either scenario"
  echo ""
  echo "$((FAILURES)) FAILURE(S)"
  exit 1
fi
USER_ID=$(grep '^USER_ID' "$SCRATCH_DIR/setup.out" | awk '{print $2}')
UPLOAD_ID=$(grep '^UPLOAD_ID' "$SCRATCH_DIR/setup.out" | awk '{print $2}')
if [ -z "$USER_ID" ] || [ -z "$UPLOAD_ID" ]; then
  fail "atomic setup appears to have committed but USER_ID/UPLOAD_ID could not be parsed from output -- cleanup will fall back to the exact fixture email ($FIXTURE_EMAIL) to resolve and remove this run's rows"
  echo ""
  echo "$((FAILURES)) FAILURE(S)"
  exit 1
fi
echo "user_id=$USER_ID upload_id=$UPLOAD_ID"

# Returns milliseconds since epoch as a plain integer, read from Postgres's
# own clock_timestamp() -- used for elapsed-time assertions via bash integer
# arithmetic only (no bc, no floating point, no GNU-specific `date +%s%N`).
now_ms(){ "${PSQL[@]}" -t -A -c "select (extract(epoch from clock_timestamp()) * 1000)::bigint;"; }

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

( "${PSQL[@]}" -f "$SCRATCH_DIR/session_a_claim.sql" > "$SCRATCH_DIR/session_a.out" 2>&1 ) &
A_PID=$!
sleep 0.5 # let session A acquire the advisory lock first
START_B=$(now_ms)
"${PSQL[@]}" -f "$SCRATCH_DIR/session_b_maintenance.sql" > "$SCRATCH_DIR/session_b.out" 2>&1
END_B=$(now_ms)
ELAPSED_B_MS=$((END_B - START_B))

if grep -q 'CONCURRENCY_RESULT:SQLSTATE=55P03' "$SCRATCH_DIR/session_b.out"; then
  pass "session B was rejected with errcode 55P03 (a research run is currently active), only after actually being able to see A's committed claim"
elif grep -q 'CONCURRENCY_RESULT:SUCCESS' "$SCRATCH_DIR/session_b.out"; then
  fail "session B (accounts_maintenance) unexpectedly succeeded -- it should have blocked on A's lock and then been rejected 55P03 once A committed with an active run"
  cat "$SCRATCH_DIR/session_b.out"
else
  fail "session B produced neither a CONCURRENCY_RESULT:SUCCESS nor a CONCURRENCY_RESULT:SQLSTATE= line -- see output below (a connection error, a syntax error, or psql itself failing would all land here)"
  cat "$SCRATCH_DIR/session_b.out"
fi

# 2500 ms = 2.5s -- integer millisecond comparison, no bc.
if [ "$ELAPSED_B_MS" -ge 2500 ]; then
  pass "session B was genuinely BLOCKED for ~3s by session A's advisory lock (measured ${ELAPSED_B_MS}ms) -- it did not race ahead and evaluate a stale pre-claim state"
else
  fail "session B returned too quickly (${ELAPSED_B_MS}ms) to have actually been blocked by A's lock -- the two calls may not be sharing the same advisory lock key"
fi

wait "$A_PID"
if grep -q SESSION_A_DONE "$SCRATCH_DIR/session_a.out"; then
  pass "session A's claim committed successfully"
else
  fail "session A did not complete as expected"
  cat "$SCRATCH_DIR/session_a.out"
fi

ACCOUNT_COUNT=$("${PSQL[@]}" -t -A -c "select count(*) from public.ha_accounts where upload_id = '$UPLOAD_ID'::uuid;" 2>/dev/null)
if [ "$ACCOUNT_COUNT" = "0" ]; then
  pass "no account row was written by the rejected accounts_maintenance call"
else
  fail "the rejected accounts_maintenance call in scenario 1 still wrote a row (count=$ACCOUNT_COUNT)"
fi

"${PSQL[@]}" -c "delete from public.ha_research_runs where upload_id = '$UPLOAD_ID'::uuid;" > /dev/null 2>&1

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

( "${PSQL[@]}" -f "$SCRATCH_DIR/session_b_maintenance_first.sql" > "$SCRATCH_DIR/session_b2.out" 2>&1 ) &
B_PID=$!
sleep 0.5
START_A=$(now_ms)
"${PSQL[@]}" -f "$SCRATCH_DIR/session_a_claim_second.sql" > "$SCRATCH_DIR/session_a2.out" 2>&1
END_A=$(now_ms)
ELAPSED_A_MS=$((END_A - START_A))
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
if [ "$ELAPSED_A_MS" -ge 2500 ]; then
  pass "session A was genuinely BLOCKED for ~3s by session B's advisory lock (measured ${ELAPSED_A_MS}ms) -- lock ownership, not call order in application code, determines who proceeds first"
else
  fail "session A returned too quickly (${ELAPSED_A_MS}ms) to have actually been blocked by B's lock"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CONCURRENCY ASSERTIONS PASSED"
else
  echo "$FAILURES CONCURRENCY ASSERTION(S) FAILED"
fi
exit $([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)
