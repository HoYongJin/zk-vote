#!/usr/bin/env bash
# Runs production migrations inside a temporary Cloud Run Job. The job is the
# only principal that receives bootstrap and migrator database secrets.
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
SQL_DATABASE="${SQL_DATABASE:-zkvote}"
VPC_CONNECTOR="${VPC_CONNECTOR:-zkvote-prod-vpc}"
REPOSITORY="${ARTIFACT_REPOSITORY:-zkvote-prod}"
CLOUD_BUILD_SERVICE_ACCOUNT="${CLOUD_BUILD_SERVICE_ACCOUNT:-zkvote-prod-cloud-build}"
CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL="${CLOUD_BUILD_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
RUN_ID="${MIGRATION_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"
JOB_NAME="zkvote-prod-migrate-${RUN_ID}"
SERVICE_ACCOUNT_NAME="zkvote-mig-${RUN_ID}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/zkvote-prod-db-migration"
SOURCE_SHA="$(git -C "${PROJECT_ROOT}" rev-parse --short HEAD)"
# A temporary migration image must not reuse a branch/SHA tag while the local
# tree contains uncommitted changes. The Job is deployed by immutable digest,
# while this unique tag makes its source build traceable in Artifact Registry.
IMAGE_TAG="${IMAGE_BASE}:${SOURCE_SHA}-${RUN_ID}"

[[ "${CONFIRM_COSTS:-}" == "yes" ]] || {
  echo "Refusing to run production migrations: set CONFIRM_COSTS=yes." >&2
  exit 1
}
[[ -z "$(git -C "${PROJECT_ROOT}" status --porcelain)" ]] || {
  echo "Refusing to build production migrations from a dirty working tree; commit or stash the source first." >&2
  exit 1
}
[[ "${RUN_ID}" =~ ^[a-zA-Z0-9]+$ ]] || { echo "MIGRATION_RUN_ID must be alphanumeric" >&2; exit 1; }

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
[[ -n "${CONNECTION_NAME}" ]] || { echo "Cloud SQL connection name is empty" >&2; exit 1; }

MIGRATION_SECRETS=(
  zkvote-prod-postgres-password
  zkvote-prod-migrator-database-url
  zkvote-prod-database-url
  zkvote-prod-readonly-database-url
)

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
  for secret_name in "${MIGRATION_SECRETS[@]}"; do
    gcloud secrets remove-iam-policy-binding "${secret_name}" \
      --project "${PROJECT_ID}" \
      --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
      --role roles/secretmanager.secretAccessor \
      --quiet >/dev/null 2>&1 || true
  done
  gcloud projects remove-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/cloudsql.client \
    --quiet >/dev/null 2>&1 || true
  gcloud iam service-accounts delete "${SERVICE_ACCOUNT_EMAIL}" --project "${PROJECT_ID}" --quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

gcloud artifacts repositories describe "${REPOSITORY}" --project "${PROJECT_ID}" --location "${REGION}" >/dev/null
gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
  --project "${PROJECT_ID}" \
  --display-name "zk-vote temporary production migrator" \
  --quiet

retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/cloudsql.client \
  --quiet >/dev/null
for secret_name in "${MIGRATION_SECRETS[@]}"; do
  retry gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
done

gcloud builds submit "${PROJECT_ROOT}" \
  --config "${PROJECT_ROOT}/scripts/cicd/cloudbuild-production-migrate.yaml" \
  --substitutions "_IMAGE=${IMAGE_TAG}" \
  --service-account "projects/${PROJECT_ID}/serviceAccounts/${CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --project "${PROJECT_ID}"

echo "Resolving immutable migration image digest."
IMAGE_DIGEST="$(gcloud artifacts docker images describe "${IMAGE_TAG}" \
  --project "${PROJECT_ID}" \
  --format='value(image_summary.digest)')"
[[ "${IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Unable to resolve immutable migration image digest" >&2; exit 1; }
IMAGE="${IMAGE_BASE}@${IMAGE_DIGEST}"

echo "Deploying temporary production migration job."
gcloud run jobs deploy "${JOB_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --service-account "${SERVICE_ACCOUNT_EMAIL}" \
  --set-cloudsql-instances "${CONNECTION_NAME}" \
  --vpc-connector "${VPC_CONNECTOR}" \
  --vpc-egress private-ranges-only \
  --set-secrets "POSTGRES_PASSWORD=zkvote-prod-postgres-password:latest,MIGRATOR_DATABASE_URL=zkvote-prod-migrator-database-url:latest,APP_DATABASE_URL=zkvote-prod-database-url:latest,READONLY_DATABASE_URL=zkvote-prod-readonly-database-url:latest" \
  --set-env-vars "CLOUD_SQL_CONNECTION_NAME=${CONNECTION_NAME},SQL_DATABASE=${SQL_DATABASE}" \
  --max-retries 0 \
  --task-timeout 10m \
  --cpu 1 \
  --memory 512Mi \
  --quiet

echo "Executing temporary production migration job."
gcloud run jobs execute "${JOB_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --wait \
  --quiet

echo "Production migrations completed from immutable image ${IMAGE}; temporary access cleanup follows."
