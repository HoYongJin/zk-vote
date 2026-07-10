#!/usr/bin/env bash
# Bootstraps the first production superadmin row from a GCIP/Firebase test user.
#
# This is intentionally out-of-band: the public API has no first-superadmin
# endpoint. Use it only for production synthetic E2E setup, then drive the actual election
# flow through public API routes.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)
source "${PROJECT_ROOT}/scripts/lib/cloud-sql-proxy.sh"

: "${FIREBASE_WEB_API_KEY:?set FIREBASE_WEB_API_KEY}"
: "${E2E_SUPERADMIN_EMAIL:?set E2E_SUPERADMIN_EMAIL}"
: "${E2E_SUPERADMIN_PASSWORD:?set E2E_SUPERADMIN_PASSWORD}"
: "${SQL_CONNECTION_NAME:?set SQL_CONNECTION_NAME=project:region:instance}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD for the postgres Cloud SQL user}"

SQL_DATABASE="${SQL_DATABASE:-zkvote}"
PORT="${PORT:-5433}"
PGIMAGE="${PGIMAGE:-postgres:16}"
PROJECT_ID="${GCP_PROJECT_ID:-${SQL_CONNECTION_NAME%%:*}}"
JWT_ISSUER="${JWT_ISSUER:-https://securetoken.google.com/${PROJECT_ID}}"

if [[ "${CONFIRM_E2E_BOOTSTRAP:-}" != "yes" ]]; then
  echo "Refusing to bootstrap: set CONFIRM_E2E_BOOTSTRAP=yes after confirming this should mutate the production admins table." >&2
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

read -r uid email < <(
  AUTH_JSON="${auth_json}" PROJECT_ID="${PROJECT_ID}" node <<'NODE'
const body = JSON.parse(process.env.AUTH_JSON || "{}");
const email = String(body.email || "").trim().toLowerCase();
if (!email || !email.includes("@")) throw new Error("Firebase sign-in returned no valid email");
const uid = String(body.localId || "");
if (!uid.trim()) throw new Error("Firebase sign-in returned no localId");
const idToken = String(body.idToken || "");
const [, payload] = idToken.split(".");
if (!payload) throw new Error("Firebase sign-in returned no ID token payload");
const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
const expectedIssuer = `https://securetoken.google.com/${process.env.PROJECT_ID}`;
if (claims.email_verified !== true) throw new Error("Firebase ID token email_verified is not true");
if (String(claims.sub || "") !== uid) throw new Error("Firebase ID token sub does not match localId");
if (String(claims.email || "").trim().toLowerCase() !== email) throw new Error("Firebase ID token email does not match response email");
if (String(claims.iss || "") !== expectedIssuer) throw new Error("Firebase ID token issuer does not match GCIP project");
if (String(claims.aud || "") !== String(process.env.PROJECT_ID || "")) throw new Error("Firebase ID token audience does not match GCIP project");
process.stdout.write(`${uid} ${email}`);
NODE
)

start_cloud_sql_proxy "${SQL_CONNECTION_NAME}" "${PORT}"
trap 'stop_cloud_sql_proxy' EXIT

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

psql_as_postgres -v subject="${uid}" -v email="${email}" -v issuer="${JWT_ISSUER}" <<'SQL'
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
    updated_at = now()
RETURNING id;
SQL

echo "Production superadmin bootstrapped: provider_subject=${uid} email=${email}"
echo "Next: run scripts/verify/e2e-production.ts with the same E2E_SUPERADMIN_* account."
