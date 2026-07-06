#!/usr/bin/env bash
# Bootstraps the first staging superadmin row from a GCIP/Firebase test user.
#
# This is intentionally out-of-band: the public API has no first-superadmin
# endpoint. Use it only for staging E2E setup, then drive the actual election
# flow through public API routes.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

: "${FIREBASE_WEB_API_KEY:?set FIREBASE_WEB_API_KEY}"
: "${E2E_SUPERADMIN_EMAIL:?set E2E_SUPERADMIN_EMAIL}"
: "${E2E_SUPERADMIN_PASSWORD:?set E2E_SUPERADMIN_PASSWORD}"
: "${SQL_CONNECTION_NAME:?set SQL_CONNECTION_NAME=project:region:instance}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD for the postgres Cloud SQL user}"

SQL_DATABASE="${SQL_DATABASE:-zkvote}"
PORT="${PORT:-5433}"
PROXY_BIN="${PROXY_BIN:-/tmp/cloud-sql-proxy}"
PGIMAGE="${PGIMAGE:-postgres:16}"

if [[ "${CONFIRM_E2E_BOOTSTRAP:-}" != "yes" ]]; then
  echo "Refusing to bootstrap: set CONFIRM_E2E_BOOTSTRAP=yes after confirming this should mutate the staging admins table." >&2
  exit 1
fi

command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required (used for psql)." >&2; exit 1; }
command -v gcloud >/dev/null || { echo "gcloud is required." >&2; exit 1; }
command -v node >/dev/null || { echo "node is required." >&2; exit 1; }

json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

email_json="$(json_escape "${E2E_SUPERADMIN_EMAIL}")"
password_json="$(json_escape "${E2E_SUPERADMIN_PASSWORD}")"
auth_json="$(
  curl -fsS \
    -H "content-type: application/json" \
    -X POST \
    -d "{\"email\":${email_json},\"password\":${password_json},\"returnSecureToken\":true}" \
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}"
)"

uid="$(
  AUTH_JSON="${auth_json}" node <<'NODE'
const body = JSON.parse(process.env.AUTH_JSON || "{}");
const uid = String(body.localId || "");
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uid)) {
  throw new Error(`Firebase localId must be a UUID for zk-vote auth, got ${uid || "(empty)"}`);
}
process.stdout.write(uid);
NODE
)"
email="$(
  AUTH_JSON="${auth_json}" node <<'NODE'
const body = JSON.parse(process.env.AUTH_JSON || "{}");
const email = String(body.email || "").trim().toLowerCase();
if (!email || !email.includes("@")) throw new Error("Firebase sign-in returned no valid email");
process.stdout.write(email);
NODE
)"

if [[ ! -x "${PROXY_BIN}" ]]; then
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "${arch}" in arm64 | aarch64) arch=arm64 ;; *) arch=amd64 ;; esac
  echo "Downloading cloud-sql-proxy (${os}.${arch})..."
  curl -fsSL -o "${PROXY_BIN}" "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.${os}.${arch}"
  chmod +x "${PROXY_BIN}"
fi

"${PROXY_BIN}" --token "$(gcloud auth print-access-token)" --address 127.0.0.1 --port "${PORT}" "${SQL_CONNECTION_NAME}" &
PROXY_PID=$!
trap 'kill "${PROXY_PID}" 2>/dev/null || true' EXIT

psql_as_postgres() {
  docker run --rm -i -e PGPASSWORD="${ADMIN_PASSWORD}" "${PGIMAGE}" \
    psql "host=host.docker.internal port=${PORT} user=postgres dbname=${SQL_DATABASE} sslmode=disable" \
    -v ON_ERROR_STOP=1 "$@"
}

ready=false
for _ in $(seq 1 20); do
  if psql_as_postgres -tAc 'select 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
[[ "${ready}" == true ]] || { echo "Proxy/DB not reachable on 127.0.0.1:${PORT}." >&2; exit 1; }

psql_as_postgres -v uid="${uid}" -v email="${email}" <<'SQL'
INSERT INTO admins (id, email, is_superadmin, revoked_at)
VALUES (:'uid', :'email', true, NULL)
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    is_superadmin = true,
    revoked_at = NULL,
    updated_at = now();
SQL

echo "Staging superadmin bootstrapped: uid=${uid} email=${email}"
echo "Next: run scripts/verify/e2e-staging.ts with the same E2E_SUPERADMIN_* account."
