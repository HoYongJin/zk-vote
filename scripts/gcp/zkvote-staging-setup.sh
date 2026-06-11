#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

PROJECT_ID="${GCP_PROJECT_ID:-scopeball-registry-poc-g}"
REGION="${GCP_REGION:-asia-northeast3}"
BUCKET="${ARTIFACT_BUCKET:-zkvote-staging-artifacts-scopeball-registry-poc-g}"
SQL_INSTANCE="${SQL_INSTANCE:-zkvote-staging-pg}"
SQL_DATABASE="${SQL_DATABASE:-zkvote}"
SQL_USER="${SQL_USER:-zkvote_app}"
REDIS_INSTANCE="${REDIS_INSTANCE:-zkvote-staging-redis}"
VPC_CONNECTOR="${VPC_CONNECTOR:-zkvote-staging-vpc}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-zkvote-staging-api}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
NETWORK="${NETWORK:-default}"
VPC_RANGE="${VPC_RANGE:-10.8.0.0/28}"

required_apis=(
  sqladmin.googleapis.com
  redis.googleapis.com
  secretmanager.googleapis.com
  vpcaccess.googleapis.com
  compute.googleapis.com
  cloudkms.googleapis.com
)

ensure_secret() {
  local secret_name="$1"
  if ! gcloud secrets describe "${secret_name}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud secrets create "${secret_name}" \
      --project "${PROJECT_ID}" \
      --replication-policy automatic \
      --quiet
  fi
}

add_secret_version() {
  local secret_name="$1"
  local secret_value="$2"
  printf "%s" "${secret_value}" | gcloud secrets versions add "${secret_name}" \
    --project "${PROJECT_ID}" \
    --data-file=- \
    --quiet >/dev/null
}

echo "Using project=${PROJECT_ID}, region=${REGION}"

for api in "${required_apis[@]}"; do
  gcloud services enable "${api}" --project "${PROJECT_ID}" --quiet
done

if ! gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" \
    --uniform-bucket-level-access \
    --quiet
fi
gcloud storage buckets update "gs://${BUCKET}" --versioning --quiet
gcloud storage buckets update "gs://${BUCKET}" \
  --lifecycle-file "${PROJECT_ROOT}/infra/gcp/artifact-lifecycle.json" \
  --quiet

if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SERVICE_ACCOUNT}" \
    --project "${PROJECT_ID}" \
    --display-name "zk-vote staging API" \
    --quiet
fi

for role in roles/cloudsql.client roles/logging.logWriter roles/monitoring.metricWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role "${role}" \
    --quiet >/dev/null
done

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/storage.objectAdmin \
  --quiet >/dev/null

if ! gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud sql instances create "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --database-version POSTGRES_16 \
    --edition ENTERPRISE \
    --region "${REGION}" \
    --tier db-f1-micro \
    --availability-type ZONAL \
    --storage-type SSD \
    --storage-size 10 \
    --backup-start-time 19:00 \
    --quiet
fi

if ! gcloud sql databases describe "${SQL_DATABASE}" --instance "${SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud sql databases create "${SQL_DATABASE}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --quiet
fi

DB_PASSWORD="${DB_PASSWORD:-}"
SQL_USER_CREATED="false"
DATABASE_URL_SECRET_WRITTEN="false"
ensure_secret zkvote-staging-database-url
if ! gcloud sql users list --instance "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format="value(name)" | grep -Fxq "${SQL_USER}"; then
  DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 24)}"
  gcloud sql users create "${SQL_USER}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --password "${DB_PASSWORD}" \
    --quiet
  SQL_USER_CREATED="true"
  CONNECTION_NAME_FOR_SECRET="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
  DATABASE_URL="postgres://${SQL_USER}:${DB_PASSWORD}@localhost/${SQL_DATABASE}?host=/cloudsql/${CONNECTION_NAME_FOR_SECRET}"
  add_secret_version zkvote-staging-database-url "${DATABASE_URL}"
  DATABASE_URL_SECRET_WRITTEN="true"
fi

if ! gcloud redis instances describe "${REDIS_INSTANCE}" --region "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud redis instances create "${REDIS_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --tier basic \
    --size 1 \
    --redis-version redis_7_0 \
    --quiet
fi

if ! gcloud compute networks vpc-access connectors describe "${VPC_CONNECTOR}" --region "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute networks vpc-access connectors create "${VPC_CONNECTOR}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --network "${NETWORK}" \
    --range "${VPC_RANGE}" \
    --min-instances 2 \
    --max-instances 3 \
    --machine-type e2-micro \
    --quiet
fi

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
REDIS_HOST="$(gcloud redis instances describe "${REDIS_INSTANCE}" --region "${REGION}" --project "${PROJECT_ID}" --format='value(host)')"
REDIS_URL="redis://${REDIS_HOST}:6379"

secrets=(
  zkvote-staging-database-url
  zkvote-staging-redis-url
  zkvote-staging-supabase-url
  zkvote-staging-supabase-jwks-url
  zkvote-staging-sepolia-rpc-url
  zkvote-staging-relayer-private-key
  zkvote-staging-secret-salt
  zkvote-staging-artifact-bucket
)
for secret_name in "${secrets[@]}"; do
  ensure_secret "${secret_name}"
  gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
done

if [[ -n "${DB_PASSWORD}" && "${DATABASE_URL_SECRET_WRITTEN}" == "false" ]]; then
  DATABASE_URL="postgres://${SQL_USER}:${DB_PASSWORD}@localhost/${SQL_DATABASE}?host=/cloudsql/${CONNECTION_NAME}"
  add_secret_version zkvote-staging-database-url "${DATABASE_URL}"
elif [[ "${SQL_USER_CREATED}" == "false" ]]; then
  echo "Skipping database-url secret version because SQL user already exists and DB_PASSWORD was not provided."
fi
add_secret_version zkvote-staging-redis-url "${REDIS_URL}"
add_secret_version zkvote-staging-artifact-bucket "${BUCKET}"

[[ -n "${SUPABASE_URL:-}" ]] && add_secret_version zkvote-staging-supabase-url "${SUPABASE_URL}"
[[ -n "${SUPABASE_JWKS_URL:-}" ]] && add_secret_version zkvote-staging-supabase-jwks-url "${SUPABASE_JWKS_URL}"
[[ -n "${SEPOLIA_RPC_URL:-}" ]] && add_secret_version zkvote-staging-sepolia-rpc-url "${SEPOLIA_RPC_URL}"
[[ -n "${RELAYER_PRIVATE_KEY:-}" ]] && add_secret_version zkvote-staging-relayer-private-key "${RELAYER_PRIVATE_KEY}"
[[ -n "${SECRET_SALT:-}" ]] && add_secret_version zkvote-staging-secret-salt "${SECRET_SALT}"

echo "GCP staging setup complete."
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Bucket: gs://${BUCKET}"
echo "Cloud SQL instance: ${SQL_INSTANCE}"
echo "Redis instance: ${REDIS_INSTANCE}"
echo "Service account: ${SERVICE_ACCOUNT_EMAIL}"
