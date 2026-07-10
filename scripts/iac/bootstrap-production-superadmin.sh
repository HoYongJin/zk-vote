#!/usr/bin/env bash
# Bootstraps the first production superadmin without exposing the Cloud SQL
# private address or postgres password to the workstation process.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)
EXTERNAL_CONFIRM_COSTS="${CONFIRM_COSTS:-}"

if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/.env"
  set +a
fi
if [[ -n "${EXTERNAL_CONFIRM_COSTS}" ]]; then
  CONFIRM_COSTS="${EXTERNAL_CONFIRM_COSTS}"
fi

PROJECT_ID="${GCP_PROJECT_ID:-zkvote-prod-hhyyj}"
REGION="${GCP_REGION:-asia-northeast3}"
SQL_INSTANCE="${SQL_INSTANCE:-zkvote-prod-pg}"
VPC_CONNECTOR="${VPC_CONNECTOR:-zkvote-prod-vpc}"
RUN_ID="${BOOTSTRAP_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"
JOB_NAME="zkvote-prod-bootstrap-${RUN_ID}"
SERVICE_ACCOUNT_NAME="zkvote-boot-${RUN_ID}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="docker.io/library/postgres:16.14-alpine3.24@sha256:7a396fd264a2067788b6551122b50f162bf6136312c7fc9d74381cb92c648382"
ENTRYPOINT="${PROJECT_ROOT}/infra/gcp/production-superadmin-bootstrap-entrypoint.sh"

[[ "${CONFIRM_COSTS:-}" == "yes" ]] || { echo "Refusing bootstrap: set CONFIRM_COSTS=yes." >&2; exit 1; }
[[ "${CONFIRM_E2E_BOOTSTRAP:-}" == "yes" ]] || { echo "Refusing bootstrap: set CONFIRM_E2E_BOOTSTRAP=yes." >&2; exit 1; }
[[ "${RUN_ID}" =~ ^[a-zA-Z0-9]+$ ]] || { echo "BOOTSTRAP_RUN_ID must be alphanumeric" >&2; exit 1; }
[[ -f "${ENTRYPOINT}" ]] || { echo "Missing ${ENTRYPOINT}" >&2; exit 1; }

secret_value() {
  gcloud secrets versions access latest --project "${PROJECT_ID}" --secret "$1"
}

FIREBASE_WEB_API_KEY="${FIREBASE_WEB_API_KEY:-$(secret_value zkvote-prod-firebase-web-api-key)}"
E2E_SUPERADMIN_EMAIL="${E2E_SUPERADMIN_EMAIL:-$(secret_value zkvote-prod-e2e-superadmin-email)}"
E2E_SUPERADMIN_PASSWORD="${E2E_SUPERADMIN_PASSWORD:-$(secret_value zkvote-prod-e2e-superadmin-password)}"
CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
[[ -n "${CONNECTION_NAME}" ]] || { echo "Cloud SQL connection name is empty" >&2; exit 1; }

request_json="$(FIREBASE_EMAIL="${E2E_SUPERADMIN_EMAIL}" FIREBASE_PASSWORD="${E2E_SUPERADMIN_PASSWORD}" node <<'NODE'
process.stdout.write(JSON.stringify({
  email: process.env.FIREBASE_EMAIL,
  password: process.env.FIREBASE_PASSWORD,
  returnSecureToken: true,
}));
NODE
)"
auth_json="$(printf '%s' "${request_json}" | curl -fsS \
  -H 'content-type: application/json' \
  --data-binary @- \
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}")"
unset request_json E2E_SUPERADMIN_PASSWORD

identity_json="$(AUTH_JSON="${auth_json}" PROJECT_ID="${PROJECT_ID}" node <<'NODE'
const body = JSON.parse(process.env.AUTH_JSON || "{}");
const email = String(body.email || "").trim().toLowerCase();
const uid = String(body.localId || "").trim();
const token = String(body.idToken || "");
const [, payload] = token.split(".");
if (!email || !email.includes("@") || !uid || !payload) throw new Error("Firebase sign-in returned incomplete identity");
const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
const issuer = `https://securetoken.google.com/${process.env.PROJECT_ID}`;
if (claims.email_verified !== true) throw new Error("Firebase ID token email_verified is not true");
if (String(claims.sub || "") !== uid) throw new Error("Firebase ID token sub does not match localId");
if (String(claims.email || "").trim().toLowerCase() !== email) throw new Error("Firebase ID token email does not match response email");
if (String(claims.iss || "") !== issuer || String(claims.aud || "") !== String(process.env.PROJECT_ID)) {
  throw new Error("Firebase ID token issuer or audience does not match the production project");
}
process.stdout.write(JSON.stringify({ subject: uid, email, issuer }));
NODE
)"
unset auth_json

BOOTSTRAP_SUBJECT="$(IDENTITY_JSON="${identity_json}" node -e 'process.stdout.write(JSON.parse(process.env.IDENTITY_JSON).subject)')"
BOOTSTRAP_EMAIL="$(IDENTITY_JSON="${identity_json}" node -e 'process.stdout.write(JSON.parse(process.env.IDENTITY_JSON).email)')"
BOOTSTRAP_ISSUER="$(IDENTITY_JSON="${identity_json}" node -e 'process.stdout.write(JSON.parse(process.env.IDENTITY_JSON).issuer)')"
unset identity_json

retry() {
  local attempts=0
  until "$@"; do
    attempts=$((attempts + 1))
    if [[ "${attempts}" -ge 12 ]]; then
      echo "retry exhausted: $*" >&2
      return 1
    fi
    sleep 3
  done
}

cleanup() {
  gcloud run jobs delete "${JOB_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --quiet >/dev/null 2>&1 || true
  gcloud secrets remove-iam-policy-binding zkvote-prod-postgres-password \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null 2>&1 || true
  gcloud projects remove-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/cloudsql.client \
    --quiet >/dev/null 2>&1 || true
  gcloud iam service-accounts delete "${SERVICE_ACCOUNT_EMAIL}" --project "${PROJECT_ID}" --quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
  --project "${PROJECT_ID}" \
  --display-name "zk-vote temporary superadmin bootstrap" \
  --quiet
retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/cloudsql.client \
  --quiet >/dev/null
retry gcloud secrets add-iam-policy-binding zkvote-prod-postgres-password \
  --project "${PROJECT_ID}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/secretmanager.secretAccessor \
  --quiet >/dev/null

encoded_entrypoint="$(base64 < "${ENTRYPOINT}" | tr -d '\n')"
gcloud run jobs deploy "${JOB_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --service-account "${SERVICE_ACCOUNT_EMAIL}" \
  --set-cloudsql-instances "${CONNECTION_NAME}" \
  --vpc-connector "${VPC_CONNECTOR}" \
  --vpc-egress private-ranges-only \
  --set-secrets "POSTGRES_PASSWORD=zkvote-prod-postgres-password:latest" \
  --set-env-vars "CLOUD_SQL_CONNECTION_NAME=${CONNECTION_NAME},BOOTSTRAP_SUBJECT=${BOOTSTRAP_SUBJECT},BOOTSTRAP_EMAIL=${BOOTSTRAP_EMAIL},BOOTSTRAP_ISSUER=${BOOTSTRAP_ISSUER}" \
  --command /bin/sh \
  --args "-ec,echo ${encoded_entrypoint} | base64 -d | /bin/sh" \
  --max-retries 0 \
  --task-timeout 5m \
  --cpu 1 \
  --memory 512Mi \
  --quiet

gcloud run jobs execute "${JOB_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --wait \
  --quiet

echo "Production superadmin bootstrap completed; temporary access cleanup follows."
