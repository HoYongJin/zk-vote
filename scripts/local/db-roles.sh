#!/usr/bin/env bash
# Applies the least-privilege role model (AR-M3) to the local docker-compose
# Postgres. Idempotent. Local-only default passwords; production must inject real
# ones via ZKVOTE_MIGRATOR_PASSWORD / ZKVOTE_APP_PASSWORD /
# ZKVOTE_READONLY_PASSWORD.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

MIGRATOR_PASSWORD="${ZKVOTE_MIGRATOR_PASSWORD:-zkvote_migrator_dev_password}"
APP_PASSWORD="${ZKVOTE_APP_PASSWORD:-zkvote_app_dev_password}"
READONLY_PASSWORD="${ZKVOTE_READONLY_PASSWORD:-zkvote_readonly_dev_password}"

sql_literal() {
  local value="$1"
  value=${value//\'/\'\'}
  printf "'%s'" "${value}"
}

roles_sql_with_password_preamble() {
  printf "SELECT set_config('zkvote.migrator_password', %s, false);\n" "$(sql_literal "${MIGRATOR_PASSWORD}")"
  printf "SELECT set_config('zkvote.app_password', %s, false);\n" "$(sql_literal "${APP_PASSWORD}")"
  printf "SELECT set_config('zkvote.readonly_password', %s, false);\n" "$(sql_literal "${READONLY_PASSWORD}")"
  cat "${PROJECT_ROOT}/rust-backend/db/roles.sql"
}

docker compose -f "${PROJECT_ROOT}/docker-compose.yml" up --wait -d zkvote-postgres

# Feed role passwords through stdin, not process arguments.
roles_sql_with_password_preamble | docker compose -f "${PROJECT_ROOT}/docker-compose.yml" exec -T zkvote-postgres \
  psql -U zkvote -d zkvote -v ON_ERROR_STOP=1 -f /dev/stdin

echo "Database privilege model applied (zkvote_migrator / zkvote_app / zkvote_readonly)."
