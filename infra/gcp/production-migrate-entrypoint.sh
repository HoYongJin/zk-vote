#!/bin/sh
# Runs the fixed migration set inside the production private network.
set -eu

: "${CLOUD_SQL_CONNECTION_NAME:?missing CLOUD_SQL_CONNECTION_NAME}"
: "${SQL_DATABASE:=zkvote}"
: "${POSTGRES_PASSWORD:?missing POSTGRES_PASSWORD}"
: "${MIGRATOR_DATABASE_URL:?missing MIGRATOR_DATABASE_URL}"
: "${APP_DATABASE_URL:?missing APP_DATABASE_URL}"
: "${READONLY_DATABASE_URL:?missing READONLY_DATABASE_URL}"

psql_as_admin() {
  PGPASSWORD="${POSTGRES_PASSWORD}" psql \
    "host=/cloudsql/${CLOUD_SQL_CONNECTION_NAME} user=postgres dbname=${SQL_DATABASE}" \
    -X -v ON_ERROR_STOP=1 "$@"
}

ready=false
for _ in $(seq 1 20); do
  if psql_as_admin -tAc 'SELECT 1' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
[ "${ready}" = true ] || { echo "Cloud SQL is not reachable through its socket" >&2; exit 1; }

# `zkvote-production-setup.sh` creates these Cloud SQL principals before this
# recovery path runs. Do not recover passwords from DATABASE_URL values: URI
# decoding is error-prone and would unnecessarily materialize secrets in shell.
missing_roles="$(psql_as_admin -Atc "
  SELECT string_agg(expected.rolname, ',' ORDER BY expected.rolname)
  FROM (VALUES
    ('zkvote_migrator'),
    ('zkvote_app'),
    ('zkvote_readonly')
  ) AS expected(rolname)
  LEFT JOIN pg_roles actual ON actual.rolname = expected.rolname
  WHERE actual.oid IS NULL
")"
[ -z "${missing_roles}" ] || {
  echo "missing expected Cloud SQL roles; run zkvote-production-setup.sh first" >&2
  exit 1
}

psql_as_admin <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
GRANT USAGE, CREATE ON SCHEMA public TO zkvote_migrator;
GRANT zkvote_migrator TO postgres;
SQL

for migration in /opt/zkvote/migrations/*.sql; do
  echo "applying $(basename "${migration}")"
  psql "${MIGRATOR_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 < "${migration}"
done

psql_as_admin -f /opt/zkvote/roles.sql

psql "${READONLY_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 -tAc \
  'SELECT 1 FROM elections LIMIT 1' >/dev/null
if psql "${READONLY_DATABASE_URL}" -X -q -v ON_ERROR_STOP=1 -c \
  'UPDATE elections SET name = name WHERE false' >/dev/null 2>&1; then
  echo "readonly role unexpectedly has UPDATE on elections" >&2
  exit 1
fi

echo "production migrations and role checks completed"
