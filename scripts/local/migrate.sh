#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

docker compose -f "${PROJECT_ROOT}/docker-compose.yml" up --wait -d zkvote-postgres

for migration in "${PROJECT_ROOT}"/rust-backend/migrations/*.sql; do
  echo "Applying $(basename "${migration}")"
  docker compose -f "${PROJECT_ROOT}/docker-compose.yml" exec -T zkvote-postgres \
    psql -U zkvote -d zkvote -v ON_ERROR_STOP=1 < "${migration}"
done

echo "Local database migrations applied."
