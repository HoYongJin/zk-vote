#!/bin/sh
# Upserts a verified GCIP identity as the first superadmin inside the private VPC.
set -eu

: "${CLOUD_SQL_CONNECTION_NAME:?missing CLOUD_SQL_CONNECTION_NAME}"
: "${POSTGRES_PASSWORD:?missing POSTGRES_PASSWORD}"
: "${BOOTSTRAP_SUBJECT:?missing BOOTSTRAP_SUBJECT}"
: "${BOOTSTRAP_EMAIL:?missing BOOTSTRAP_EMAIL}"
: "${BOOTSTRAP_ISSUER:?missing BOOTSTRAP_ISSUER}"

export PGPASSWORD="${POSTGRES_PASSWORD}"
psql "host=/cloudsql/${CLOUD_SQL_CONNECTION_NAME} user=postgres dbname=zkvote" \
  -X -v ON_ERROR_STOP=1 \
  -v subject="${BOOTSTRAP_SUBJECT}" \
  -v email="${BOOTSTRAP_EMAIL}" \
  -v issuer="${BOOTSTRAP_ISSUER}" <<'SQL'
WITH app_user AS (
    INSERT INTO app_users (email, last_seen_at)
    VALUES (:'email', now())
    ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE
    SET last_seen_at = now(),
        updated_at = now()
    RETURNING id
),
identity AS (
    INSERT INTO auth_identities (user_id, issuer, subject, email, email_verified, last_seen_at)
    SELECT id, :'issuer', :'subject', :'email', true, now()
    FROM app_user
    ON CONFLICT (issuer, subject) DO UPDATE
    SET email = EXCLUDED.email,
        email_verified = EXCLUDED.email_verified,
        last_seen_at = now(),
        updated_at = now()
    RETURNING user_id
)
INSERT INTO admins (id, email, is_superadmin, revoked_at)
SELECT user_id, :'email', true, NULL
FROM identity
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    is_superadmin = true,
    revoked_at = NULL,
    updated_at = now();
SQL

echo "verified superadmin identity upsert completed"
