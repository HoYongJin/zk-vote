#!/usr/bin/env bash
# Phase 3 verification gates (docs/PROJECT_PLAN.md): asserts that the local
# schema enforces the core invariants even if an API bug is introduced, and
# that the runtime role cannot execute DDL (AR-M3). Runs inside a transaction
# that is rolled back — leaves no data behind. Fails non-zero on any gate.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

docker compose -f "${PROJECT_ROOT}/docker-compose.yml" up --wait -d zkvote-postgres >/dev/null

docker compose -f "${PROJECT_ROOT}/docker-compose.yml" exec -T zkvote-postgres \
  psql -U zkvote -d zkvote -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

-- Gate: Node-style election creation (no circuit_id, no state) is representable (M7).
INSERT INTO elections (id, name, merkle_tree_depth, num_candidates, candidates,
                       registration_start_time, registration_end_time)
VALUES ('00000000-0000-0000-0000-000000000001', 'gate election', 4, 2,
        '["A","B"]'::jsonb, now(), now() + interval '1 hour');

DO $gates$
BEGIN
    -- Gate: duplicate voter email per election rejected.
    BEGIN
        INSERT INTO voters (election_id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'dup@example.com');
        INSERT INTO voters (election_id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'dup@example.com');
        RAISE EXCEPTION 'GATE FAILED: duplicate voter email accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'gate ok: duplicate voter email rejected';
    END;

    -- Gate: duplicate voter user_id per election rejected.
    BEGIN
        INSERT INTO voters (election_id, email, user_id)
        VALUES ('00000000-0000-0000-0000-000000000001', 'u1@example.com', '00000000-0000-0000-0000-0000000000aa');
        INSERT INTO voters (election_id, email, user_id)
        VALUES ('00000000-0000-0000-0000-000000000001', 'u2@example.com', '00000000-0000-0000-0000-0000000000aa');
        RAISE EXCEPTION 'GATE FAILED: duplicate voter user_id accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'gate ok: duplicate voter user_id rejected';
    END;

    -- Gate: duplicate nullifier per election rejected.
    BEGIN
        INSERT INTO vote_submissions (election_id, nullifier_hash, status)
        VALUES ('00000000-0000-0000-0000-000000000001', '42', 'pending');
        INSERT INTO vote_submissions (election_id, nullifier_hash, status)
        VALUES ('00000000-0000-0000-0000-000000000001', '42', 'pending');
        RAISE EXCEPTION 'GATE FAILED: duplicate nullifier accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'gate ok: duplicate nullifier rejected';
    END;

    -- Gate: invalid election state rejected.
    BEGIN
        UPDATE elections SET state = 'definitely_not_a_state'
        WHERE id = '00000000-0000-0000-0000-000000000001';
        RAISE EXCEPTION 'GATE FAILED: invalid election state accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'gate ok: invalid election state rejected';
    END;

    -- Gate: invalid date ordering rejected.
    BEGIN
        INSERT INTO elections (name, merkle_tree_depth, num_candidates, candidates,
                               registration_start_time, registration_end_time)
        VALUES ('bad dates', 4, 2, '["A","B"]'::jsonb, now(), now() - interval '1 hour');
        RAISE EXCEPTION 'GATE FAILED: inverted registration window accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'gate ok: invalid date ordering rejected';
    END;

    -- Gate: malformed field element rejected (M8 text + CHECK).
    BEGIN
        UPDATE elections SET merkle_root = '0xdeadbeef'
        WHERE id = '00000000-0000-0000-0000-000000000001';
        RAISE EXCEPTION 'GATE FAILED: non-decimal field element accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'gate ok: non-decimal field element rejected';
    END;
END
$gates$;

-- Gate: 77-digit field element round-trips byte-identically (M8).
UPDATE elections
SET merkle_root = '21663839004416932945382355908790599225266501822907911457504978515578255421292'
WHERE id = '00000000-0000-0000-0000-000000000001';
DO $$
DECLARE v text;
BEGIN
    SELECT merkle_root INTO v FROM elections WHERE id = '00000000-0000-0000-0000-000000000001';
    IF v <> '21663839004416932945382355908790599225266501822907911457504978515578255421292' THEN
        RAISE EXCEPTION 'GATE FAILED: field element did not round-trip exactly (got %)', v;
    END IF;
    RAISE NOTICE 'gate ok: field element round-trips exactly';
END $$;

-- Gate: updated_at trigger fires on UPDATE.
DO $$
DECLARE c timestamptz; u timestamptz;
BEGIN
    UPDATE elections SET created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'
    WHERE id = '00000000-0000-0000-0000-000000000001';
    UPDATE elections SET name = 'gate election renamed'
    WHERE id = '00000000-0000-0000-0000-000000000001';
    SELECT created_at, updated_at INTO c, u FROM elections
    WHERE id = '00000000-0000-0000-0000-000000000001';
    IF u <= c THEN
        RAISE EXCEPTION 'GATE FAILED: updated_at trigger did not fire';
    END IF;
    RAISE NOTICE 'gate ok: updated_at trigger fires';
END $$;

-- Gate (AR-M3): runtime role cannot execute DDL but can perform granted DML.
SET LOCAL ROLE zkvote_app;
DO $$
BEGIN
    BEGIN
        CREATE TABLE gate_should_fail (x int);
        RAISE EXCEPTION 'GATE FAILED: runtime role executed DDL';
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'gate ok: runtime role cannot execute DDL';
    END;

    INSERT INTO admins (id) VALUES ('00000000-0000-0000-0000-0000000000bb');
    RAISE NOTICE 'gate ok: runtime role can perform granted DML';
END $$;
RESET ROLE;

ROLLBACK;
SQL

echo "All Phase 3 database gates passed (transaction rolled back, no data persisted)."
