CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Internal users are stable UUIDs owned by zk-vote. External IdP subjects
-- (Firebase/GCIP localId, Google provider UID, legacy Supabase UUID subjects)
-- map to these rows through auth_identities.
CREATE TABLE IF NOT EXISTS app_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email citext,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS auth_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id),
    issuer text NOT NULL CHECK (length(trim(issuer)) > 0),
    subject text NOT NULL CHECK (length(trim(subject)) > 0),
    email citext,
    email_verified boolean,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    UNIQUE (issuer, subject)
);

-- Preserve already-bootstrapped UUID users as internal app users.
WITH admin_source AS (
    SELECT id,
           CASE
               WHEN email IS NOT NULL
                    AND row_number() OVER (PARTITION BY email ORDER BY created_at, id) = 1
               THEN email
               ELSE NULL
           END AS email,
           created_at,
           updated_at
    FROM admins
)
INSERT INTO app_users (id, email, created_at, updated_at)
SELECT id, email, created_at, updated_at
FROM admin_source
ON CONFLICT (id) DO UPDATE
SET email = CASE
        WHEN app_users.email IS NOT NULL THEN app_users.email
        WHEN EXCLUDED.email IS NOT NULL
             AND NOT EXISTS (
                 SELECT 1
                 FROM app_users other
                 WHERE other.email = EXCLUDED.email
                   AND other.id <> app_users.id
             )
        THEN EXCLUDED.email
        ELSE NULL
    END,
    updated_at = now();

WITH voter_source AS (
    SELECT DISTINCT ON (user_id)
           user_id AS id,
           email,
           min(created_at) OVER (PARTITION BY user_id) AS created_at,
           max(updated_at) OVER (PARTITION BY user_id) AS updated_at
    FROM voters
    WHERE user_id IS NOT NULL
    ORDER BY user_id, created_at
),
ranked_voter_source AS (
    SELECT id,
           CASE
               WHEN email IS NOT NULL
                    AND row_number() OVER (PARTITION BY email ORDER BY created_at, id) = 1
               THEN email
               ELSE NULL
           END AS email,
           created_at,
           updated_at
    FROM voter_source
)
INSERT INTO app_users (id, email, created_at, updated_at)
SELECT id, email, created_at, updated_at
FROM ranked_voter_source
ON CONFLICT (id) DO UPDATE
SET email = CASE
        WHEN app_users.email IS NOT NULL THEN app_users.email
        WHEN EXCLUDED.email IS NOT NULL
             AND NOT EXISTS (
                 SELECT 1
                 FROM app_users other
                 WHERE other.email = EXCLUDED.email
                   AND other.id <> app_users.id
             )
        THEN EXCLUDED.email
        ELSE NULL
    END,
    updated_at = now();

-- If legacy rows reused the same e-mail with different UUID ids, keep one
-- canonical e-mail owner so the unique verified-email resolver can be enabled.
WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY email ORDER BY created_at, id) AS rn
    FROM app_users
    WHERE email IS NOT NULL
)
UPDATE app_users
SET email = NULL,
    updated_at = now()
FROM ranked
WHERE app_users.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_email_unique
    ON app_users(email)
    WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id
    ON auth_identities(user_id);
