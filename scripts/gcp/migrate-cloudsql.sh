#!/usr/bin/env bash
# Applies rust-backend/migrations/*.sql + db/roles.sql to a Cloud SQL Postgres
# instance via the Cloud SQL Auth Proxy (IAM-authenticated — NO public-IP
# authorized-networks change) + a docker postgres:16 psql (no local psql needed).
#
# Honors the AR-M3 two-role model on Cloud SQL, working around two Cloud SQL
# behaviours the local docker model never hits (both verified live on
# zkvote-staging):
#   1. `gcloud sql users create` users join the cloudsqlsuperuser role AND get
#      CREATEDB/CREATEROLE — db/roles.sql now strips both (a NO-OP locally).
#   2. cloudsqlsuperuser (the `postgres` user) is NOT a real superuser, so to
#      GRANT on migrator-OWNED tables it must first be granted membership in
#      zkvote_migrator (done in Step A).
#
# Sequence: (postgres) extensions + migrator CREATE grant + admin->migrator
# membership -> (zkvote_migrator) migrations -> (postgres) roles.sql -> verify.
#
# Requires (env):
#   SQL_CONNECTION_NAME   project:region:instance (gcloud sql instances describe ... --format='value(connectionName)')
#   ADMIN_PASSWORD        the `postgres` user password (gcloud sql users set-password postgres ...)
#   MIGRATOR_PASSWORD     zkvote_migrator password
#   APP_PASSWORD          zkvote_app password
#   SQL_DATABASE          default: zkvote
# Auth: the active gcloud account's OAuth token (needs roles/cloudsql.client).
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

: "${SQL_CONNECTION_NAME:?set SQL_CONNECTION_NAME=project:region:instance}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD (the postgres user password)}"
: "${MIGRATOR_PASSWORD:?set MIGRATOR_PASSWORD}"
: "${APP_PASSWORD:?set APP_PASSWORD}"
SQL_DATABASE="${SQL_DATABASE:-zkvote}"
PORT="${PORT:-5433}"
PROXY_BIN="${PROXY_BIN:-/tmp/cloud-sql-proxy}"
PGIMAGE="${PGIMAGE:-postgres:16}"

command -v docker >/dev/null || { echo "docker is required (used for psql)." >&2; exit 1; }
command -v gcloud >/dev/null || { echo "gcloud is required." >&2; exit 1; }

# Fetch the Cloud SQL Auth Proxy if absent (os/arch auto-detected).
if [[ ! -x "${PROXY_BIN}" ]]; then
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "${arch}" in arm64 | aarch64) arch=arm64 ;; *) arch=amd64 ;; esac
  echo "Downloading cloud-sql-proxy (${os}.${arch})..."
  curl -fsSL -o "${PROXY_BIN}" "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.${os}.${arch}"
  chmod +x "${PROXY_BIN}"
fi

# Start the proxy (IAM token auth; mTLS tunnel — no DB public exposure).
"${PROXY_BIN}" --token "$(gcloud auth print-access-token)" --address 127.0.0.1 --port "${PORT}" "${SQL_CONNECTION_NAME}" &
PROXY_PID=$!
trap 'kill "${PROXY_PID}" 2>/dev/null || true' EXIT

# psql via docker reaches the host proxy through host.docker.internal.
psql_as() { # usage: psql_as <user> <password> [psql args...]   (SQL on stdin)
  local user="$1" pw="$2"
  shift 2
  docker run --rm -i -e PGPASSWORD="${pw}" "${PGIMAGE}" \
    psql "host=host.docker.internal port=${PORT} user=${user} dbname=${SQL_DATABASE} sslmode=disable" \
    -v ON_ERROR_STOP=1 "$@"
}

# Wait for the proxy to accept connections.
ready=false
for _ in $(seq 1 20); do
  if psql_as postgres "${ADMIN_PASSWORD}" -tAc 'select 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
[[ "${ready}" == true ]] || { echo "Proxy/DB not reachable on 127.0.0.1:${PORT}." >&2; exit 1; }

echo "== Step A: extensions + migrator grants (as postgres) =="
psql_as postgres "${ADMIN_PASSWORD}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
GRANT USAGE, CREATE ON SCHEMA public TO zkvote_migrator;
-- cloudsqlsuperuser is not a real superuser; grant the admin membership in the
-- migrator so it can GRANT on the migrator-owned tables in roles.sql (Step C).
GRANT zkvote_migrator TO postgres;
SQL

echo "== Step B: migrations 0001.. (as zkvote_migrator, owns DDL) =="
for m in "${PROJECT_ROOT}"/rust-backend/migrations/*.sql; do
  echo "  applying $(basename "${m}")"
  psql_as zkvote_migrator "${MIGRATOR_PASSWORD}" -q < "${m}"
done

echo "== Step C: roles.sql (as postgres) — per-table app DML + AR-M3 + Cloud SQL hardening =="
psql_as postgres "${ADMIN_PASSWORD}" \
  -v migrator_password="${MIGRATOR_PASSWORD}" \
  -v app_password="${APP_PASSWORD}" \
  < "${PROJECT_ROOT}/rust-backend/db/roles.sql"

echo "== Verify AR-M3 boundary =="
psql_as postgres "${ADMIN_PASSWORD}" -tA <<'SQL'
SELECT 'app CREATE public (want f):     ' || has_schema_privilege('zkvote_app','public','CREATE');
SELECT 'app createrole (want f):        ' || rolcreaterole FROM pg_roles WHERE rolname='zkvote_app';
SELECT 'app memberships (want none):    ' || COALESCE((SELECT string_agg(r.rolname,',') FROM pg_auth_members am JOIN pg_roles r ON am.roleid=r.oid JOIN pg_roles u ON am.member=u.oid WHERE u.rolname='zkvote_app'),'(none)');
SELECT 'app SELECT elections (want t):  ' || has_table_privilege('zkvote_app','elections','SELECT');
SELECT 'app DELETE elections (want f):  ' || has_table_privilege('zkvote_app','elections','DELETE');
SELECT 'app UPDATE zk_artifacts (want f):' || has_table_privilege('zkvote_app','zk_artifacts','UPDATE');
SQL

echo "Cloud SQL migrations + roles + hardening complete."
