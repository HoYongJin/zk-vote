#!/usr/bin/env bash
# Applies the two-role privilege model (AR-M3) to the local docker-compose
# Postgres. Idempotent. Local-only default passwords; staging must inject
# real ones via ZKVOTE_MIGRATOR_PASSWORD / ZKVOTE_APP_PASSWORD.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

MIGRATOR_PASSWORD="${ZKVOTE_MIGRATOR_PASSWORD:-zkvote_migrator_dev_password}"
APP_PASSWORD="${ZKVOTE_APP_PASSWORD:-zkvote_app_dev_password}"

docker compose -f "${PROJECT_ROOT}/docker-compose.yml" up --wait -d zkvote-postgres

# Session-level settings carry the passwords into roles.sql without putting
# them in argv or the SQL file itself.
{
  echo "SET zkvote.migrator_password = '${MIGRATOR_PASSWORD}';"
  echo "SET zkvote.app_password = '${APP_PASSWORD}';"
  cat "${PROJECT_ROOT}/rust-backend/db/roles.sql"
} | docker compose -f "${PROJECT_ROOT}/docker-compose.yml" exec -T zkvote-postgres \
      psql -U zkvote -d zkvote -v ON_ERROR_STOP=1

echo "Two-role privilege model applied (zkvote_migrator / zkvote_app)."
