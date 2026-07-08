#!/usr/bin/env bash
# Applies migrations/roles to the production Cloud SQL instance.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

PROJECT_ID="${GCP_PROJECT_ID:-zkvote-prod-hhyyj}"
SQL_INSTANCE="${SQL_INSTANCE:-zkvote-prod-pg}"
SQL_DATABASE="${SQL_DATABASE:-zkvote}"

database_password_from_url() {
  node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password));' "$1"
}

SQL_CONNECTION_NAME="${SQL_CONNECTION_NAME:-$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(gcloud secrets versions access latest --secret zkvote-prod-postgres-password --project "${PROJECT_ID}")}"
APP_DATABASE_URL="$(gcloud secrets versions access latest --secret zkvote-prod-database-url --project "${PROJECT_ID}")"
MIGRATOR_DATABASE_URL="$(gcloud secrets versions access latest --secret zkvote-prod-migrator-database-url --project "${PROJECT_ID}")"
READONLY_DATABASE_URL="$(gcloud secrets versions access latest --secret zkvote-prod-readonly-database-url --project "${PROJECT_ID}")"
APP_PASSWORD="${APP_PASSWORD:-$(database_password_from_url "${APP_DATABASE_URL}")}"
MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:-$(database_password_from_url "${MIGRATOR_DATABASE_URL}")}"
READONLY_PASSWORD="${READONLY_PASSWORD:-$(database_password_from_url "${READONLY_DATABASE_URL}")}"

SQL_CONNECTION_NAME="${SQL_CONNECTION_NAME}" \
ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
APP_PASSWORD="${APP_PASSWORD}" \
MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD}" \
READONLY_PASSWORD="${READONLY_PASSWORD}" \
SQL_DATABASE="${SQL_DATABASE}" \
  bash "${PROJECT_ROOT}/scripts/migration/migrate-cloudsql.sh"
