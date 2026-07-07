#!/usr/bin/env bash
# Bootstraps the first production synthetic E2E superadmin row.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

PROJECT_ID="${GCP_PROJECT_ID:-zkvote-prod-hhyyj}"
SQL_INSTANCE="${SQL_INSTANCE:-zkvote-prod-pg}"
SQL_DATABASE="${SQL_DATABASE:-zkvote}"

FIREBASE_WEB_API_KEY="${FIREBASE_WEB_API_KEY:-$(gcloud secrets versions access latest --secret zkvote-prod-firebase-web-api-key --project "${PROJECT_ID}")}"
E2E_SUPERADMIN_EMAIL="${E2E_SUPERADMIN_EMAIL:-$(gcloud secrets versions access latest --secret zkvote-prod-e2e-superadmin-email --project "${PROJECT_ID}")}"
E2E_SUPERADMIN_PASSWORD="${E2E_SUPERADMIN_PASSWORD:-$(gcloud secrets versions access latest --secret zkvote-prod-e2e-superadmin-password --project "${PROJECT_ID}")}"
SQL_CONNECTION_NAME="${SQL_CONNECTION_NAME:-$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(gcloud secrets versions access latest --secret zkvote-prod-postgres-password --project "${PROJECT_ID}")}"
JWT_ISSUER="${JWT_ISSUER:-https://securetoken.google.com/${PROJECT_ID}}"

FIREBASE_WEB_API_KEY="${FIREBASE_WEB_API_KEY}" \
E2E_SUPERADMIN_EMAIL="${E2E_SUPERADMIN_EMAIL}" \
E2E_SUPERADMIN_PASSWORD="${E2E_SUPERADMIN_PASSWORD}" \
SQL_CONNECTION_NAME="${SQL_CONNECTION_NAME}" \
ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
GCP_PROJECT_ID="${PROJECT_ID}" \
JWT_ISSUER="${JWT_ISSUER}" \
SQL_DATABASE="${SQL_DATABASE}" \
CONFIRM_E2E_BOOTSTRAP="${CONFIRM_E2E_BOOTSTRAP:-}" \
  bash "${PROJECT_ROOT}/scripts/iac/bootstrap-staging-superadmin.sh"
