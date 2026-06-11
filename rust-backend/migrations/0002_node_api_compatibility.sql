CREATE EXTENSION IF NOT EXISTS citext;

ALTER TABLE elections ADD COLUMN IF NOT EXISTS name text;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'elections' AND column_name = 'title'
    ) THEN
        EXECUTE 'UPDATE elections SET name = title WHERE name IS NULL AND title IS NOT NULL';
    END IF;
END $$;

ALTER TABLE elections ADD COLUMN IF NOT EXISTS registration_start_time timestamptz;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'elections' AND column_name = 'registration_start_at'
    ) THEN
        EXECUTE 'UPDATE elections SET registration_start_time = registration_start_at WHERE registration_start_time IS NULL AND registration_start_at IS NOT NULL';
    END IF;
END $$;

ALTER TABLE elections ADD COLUMN IF NOT EXISTS registration_end_time timestamptz;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'elections' AND column_name = 'registration_end_at'
    ) THEN
        EXECUTE 'UPDATE elections SET registration_end_time = registration_end_at WHERE registration_end_time IS NULL AND registration_end_at IS NOT NULL';
    END IF;
END $$;

ALTER TABLE elections ADD COLUMN IF NOT EXISTS voting_start_time timestamptz;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'elections' AND column_name = 'voting_start_at'
    ) THEN
        EXECUTE 'UPDATE elections SET voting_start_time = voting_start_at WHERE voting_start_time IS NULL AND voting_start_at IS NOT NULL';
    END IF;
END $$;

ALTER TABLE elections ADD COLUMN IF NOT EXISTS voting_end_time timestamptz;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'elections' AND column_name = 'voting_end_at'
    ) THEN
        EXECUTE 'UPDATE elections SET voting_end_time = voting_end_at WHERE voting_end_time IS NULL AND voting_end_at IS NOT NULL';
    END IF;
END $$;

ALTER TABLE elections ADD COLUMN IF NOT EXISTS completed boolean NOT NULL DEFAULT false;
ALTER TABLE elections ADD COLUMN IF NOT EXISTS verifier_address text;

ALTER TABLE voters ADD COLUMN IF NOT EXISTS user_secret numeric(78, 0);
ALTER TABLE voters ADD COLUMN IF NOT EXISTS user_secret_commitment numeric(78, 0);

CREATE TABLE IF NOT EXISTS admins (
    id uuid PRIMARY KEY,
    email citext,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_invitations (
    email citext PRIMARY KEY,
    invited_by uuid REFERENCES admins(id),
    accepted_by uuid REFERENCES admins(id),
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_elections_registration_window
    ON elections(registration_start_time, registration_end_time);

CREATE INDEX IF NOT EXISTS idx_elections_voting_window
    ON elections(voting_start_time, voting_end_time);
