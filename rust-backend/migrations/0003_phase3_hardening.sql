-- Phase 3: data model hardening.
-- Decisions recorded in docs/DATA_MODEL.md:
--   M7  -> elections.circuit_id becomes nullable (backfilled at artifact selection)
--   M8  -> field elements stored as text with a decimal-string CHECK
--   H2  -> the plaintext voters.user_secret column is removed from the target schema
-- This file is idempotent: scripts/local/migrate.sh re-runs every migration.

-- --- M6 convergence: retire the legacy title/*_at election columns ----------
-- Databases created before 0002 carry `title` and `*_at` time columns next to
-- the canonical `name`/`*_time` ones 0002 added (and 0001-fresh databases
-- never had them). Backfill once more, enforce the canonical NOT NULLs, and
-- drop the legacy columns so every environment converges on one shape.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'elections' AND column_name = 'title'
    ) THEN
        UPDATE elections SET name = title WHERE name IS NULL;
        ALTER TABLE elections ALTER COLUMN name SET NOT NULL;
        ALTER TABLE elections DROP COLUMN title;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_elections_name_nonempty') THEN
            ALTER TABLE elections ADD CONSTRAINT chk_elections_name_nonempty
                CHECK (length(trim(name)) > 0);
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'elections' AND column_name = 'registration_start_at'
    ) THEN
        UPDATE elections SET registration_start_time = registration_start_at WHERE registration_start_time IS NULL;
        UPDATE elections SET registration_end_time   = registration_end_at   WHERE registration_end_time   IS NULL;
        UPDATE elections SET voting_start_time       = voting_start_at       WHERE voting_start_time       IS NULL;
        UPDATE elections SET voting_end_time         = voting_end_at         WHERE voting_end_time         IS NULL;
        ALTER TABLE elections ALTER COLUMN registration_start_time SET NOT NULL;
        ALTER TABLE elections ALTER COLUMN registration_end_time   SET NOT NULL;
        ALTER TABLE elections DROP COLUMN registration_start_at;
        ALTER TABLE elections DROP COLUMN registration_end_at;
        ALTER TABLE elections DROP COLUMN voting_start_at;
        ALTER TABLE elections DROP COLUMN voting_end_at;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_elections_registration_window') THEN
            ALTER TABLE elections ADD CONSTRAINT chk_elections_registration_window
                CHECK (registration_end_time > registration_start_time);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_elections_voting_window') THEN
            ALTER TABLE elections ADD CONSTRAINT chk_elections_voting_window
                CHECK (
                    (voting_start_time IS NULL AND voting_end_time IS NULL)
                    OR (voting_start_time IS NOT NULL AND voting_end_time IS NOT NULL
                        AND voting_end_time > voting_start_time)
                );
        END IF;
    END IF;
END $$;

-- --- M7: Node-style election creation provides no circuit_id ----------------
ALTER TABLE elections ALTER COLUMN circuit_id DROP NOT NULL;

-- --- H2 target schema: no plaintext-secret column ---------------------------
-- The hosted-Supabase legacy column `Voters.user_secret` holds H(secret) after
-- the H2 fix; the Phase 19 ETL maps it into voters.user_secret_commitment.
ALTER TABLE voters DROP COLUMN IF EXISTS user_secret;

-- AR-H5 privacy invariant: durable ticket storage, if used by the Rust port,
-- follows the Redis ticket payload and never persists the submit nullifier.
ALTER TABLE submission_tickets DROP COLUMN IF EXISTS nullifier_hash;

-- --- M8: field elements as decimal-string text ------------------------------
-- Every API boundary (Node today, Rust after parity) treats Merkle roots,
-- commitments, and nullifiers as decimal strings fed to BigInt; numeric(78,0)
-- round-trips ambiguously through JSON serializers. text + CHECK is lossless.
ALTER TABLE elections          ALTER COLUMN merkle_root            TYPE text USING merkle_root::text;
ALTER TABLE voters             ALTER COLUMN user_secret_commitment TYPE text USING user_secret_commitment::text;
ALTER TABLE submission_tickets ALTER COLUMN merkle_root            TYPE text USING merkle_root::text;
ALTER TABLE vote_submissions   ALTER COLUMN nullifier_hash         TYPE text USING nullifier_hash::text;
ALTER TABLE finalization_jobs  ALTER COLUMN desired_merkle_root    TYPE text USING desired_merkle_root::text;

DO $$
DECLARE
    spec record;
BEGIN
    FOR spec IN
        SELECT * FROM (VALUES
            ('elections',          'merkle_root',            'chk_elections_merkle_root_field_element'),
            ('voters',             'user_secret_commitment', 'chk_voters_commitment_field_element'),
            ('submission_tickets', 'merkle_root',            'chk_tickets_merkle_root_field_element'),
            ('vote_submissions',   'nullifier_hash',         'chk_submissions_nullifier_field_element'),
            ('finalization_jobs',  'desired_merkle_root',    'chk_jobs_merkle_root_field_element')
        ) AS t(table_name, column_name, constraint_name)
    LOOP
        EXECUTE format(
            'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
            spec.table_name, spec.constraint_name
        );
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NULL OR CASE WHEN %I ~ ''^[0-9]+$'' THEN (%I)::numeric < 21888242871839275222246405745257275088548364400416034343698204186575808495617 ELSE false END)',
            spec.table_name, spec.constraint_name, spec.column_name,
            spec.column_name, spec.column_name
        );
    END LOOP;
END $$;

-- --- updated_at maintenance -------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'elections', 'admins', 'admin_invitations', 'voters',
        'vote_submissions', 'finalization_jobs'
    ]
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', t, t);
        EXECUTE format(
            'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            t, t
        );
    END LOOP;
END $$;

-- --- list-page indexes -------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_elections_completed ON elections(completed);
CREATE INDEX IF NOT EXISTS idx_voters_election_registered
    ON voters(election_id) WHERE user_id IS NOT NULL;
