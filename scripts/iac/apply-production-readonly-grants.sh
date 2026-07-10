#!/usr/bin/env bash
# Apply the fixed zkvote_readonly grants inside production, then remove the
# temporary Cloud Run Job and its privileged service account.
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
JOB_NAME="zkvote-prod-readonly-grants"
SERVICE_ACCOUNT_NAME="zkvote-prod-readonly-grants"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="docker.io/library/postgres:16.14-alpine3.24@sha256:7a396fd264a2067788b6551122b50f162bf6136312c7fc9d74381cb92c648382"
ENTRYPOINT="${PROJECT_ROOT}/infra/gcp/production-readonly-grants-entrypoint.sh"

[[ "${CONFIRM_COSTS:-}" == "yes" ]] || {
  echo "Refusing to apply production readonly grants: set CONFIRM_COSTS=yes." >&2
  exit 1
}
[[ -f "${ENTRYPOINT}" ]] || { echo "Missing ${ENTRYPOINT}" >&2; exit 1; }

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
[[ -n "${CONNECTION_NAME}" ]] || { echo "Cloud SQL connection name is empty" >&2; exit 1; }

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
  --display-name "zk-vote temporary readonly grant repair" \
  --quiet 2>/dev/null || true
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/cloudsql.client \
  --quiet >/dev/null
gcloud secrets add-iam-policy-binding zkvote-prod-postgres-password \
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
  --set-env-vars "CLOUD_SQL_CONNECTION_NAME=${CONNECTION_NAME}" \
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

echo "Applied readonly grants through a temporary production-side job; cleanup follows."
