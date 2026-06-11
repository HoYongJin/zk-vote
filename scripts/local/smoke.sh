#!/usr/bin/env bash
set -euo pipefail

docker compose up --wait -d zkvote-postgres zkvote-redis
docker compose exec -T zkvote-postgres pg_isready -U zkvote -d zkvote
docker compose exec -T zkvote-redis redis-cli PING
test -d .data/zk-artifacts
echo "Local infra smoke check passed."
