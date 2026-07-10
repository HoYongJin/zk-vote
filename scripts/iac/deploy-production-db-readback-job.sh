#!/usr/bin/env bash
# Deploy the production-side, readonly Cloud SQL verification job.
#
# This avoids a workstation Cloud SQL proxy for a private-IP-only instance.
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
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-zkvote-prod-api}@${PROJECT_ID}.iam.gserviceaccount.com"
JOB_NAME="${PRODUCTION_DB_READBACK_JOB:-zkvote-prod-db-readback}"
IMAGE="docker.io/library/postgres:16.14-alpine3.24@sha256:7a396fd264a2067788b6551122b50f162bf6136312c7fc9d74381cb92c648382"

if [[ "${CONFIRM_COSTS:-}" != "yes" ]]; then
  echo "Refusing to deploy ${JOB_NAME}: set CONFIRM_COSTS=yes after explicit approval." >&2
  exit 1
fi

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
[[ -n "${CONNECTION_NAME}" ]] || { echo "Cloud SQL connection name is empty" >&2; exit 1; }

entrypoint="${PROJECT_ROOT}/infra/gcp/production-db-readback-entrypoint.sh"
[[ -f "${entrypoint}" ]] || { echo "Missing ${entrypoint}" >&2; exit 1; }
encoded_script="$(base64 < "${entrypoint}" | tr -d '\n')"
job_command="echo ${encoded_script} | base64 -d | /bin/sh"

gcloud run jobs deploy "${JOB_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --service-account "${SERVICE_ACCOUNT}" \
  --set-cloudsql-instances "${CONNECTION_NAME}" \
  --vpc-connector "${VPC_CONNECTOR}" \
  --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=zkvote-prod-readonly-database-url:latest" \
  --set-env-vars "READBACK_MODE=unset,READBACK_ELECTION_ID=unset" \
  --command /bin/sh \
  --args "-ec,${job_command}" \
  --max-retries 0 \
  --task-timeout 5m \
  --cpu 1 \
  --memory 512Mi \
  --quiet

echo "Deployed ${JOB_NAME}; it runs fixed readonly queries through Cloud SQL socket ${CONNECTION_NAME}."
