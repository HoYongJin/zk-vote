#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

PROJECT_ID="${GCP_PROJECT_ID:-scopeball-registry-poc-g}"
REGION="${GCP_REGION:-asia-northeast3}"
BUCKET="${ARTIFACT_BUCKET:-zkvote-staging-artifacts-scopeball-registry-poc-g}"
SQL_INSTANCE="${SQL_INSTANCE:-zkvote-staging-pg}"
SQL_DATABASE="${SQL_DATABASE:-zkvote}"
SQL_APP_USER="${SQL_APP_USER:-${SQL_USER:-zkvote_app}}"
SQL_MIGRATOR_USER="${SQL_MIGRATOR_USER:-zkvote_migrator}"
REDIS_INSTANCE="${REDIS_INSTANCE:-zkvote-staging-redis}"
VPC_CONNECTOR="${VPC_CONNECTOR:-zkvote-staging-vpc}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-zkvote-staging-api}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
NETWORK="${NETWORK:-default}"
VPC_RANGE="${VPC_RANGE:-10.8.0.0/28}"

if [[ "${CONFIRM_COSTS:-}" != "yes" ]]; then
  echo "Refusing to run: set CONFIRM_COSTS=yes after explicit user approval (this creates billable GCP resources)." >&2
  exit 1
fi

required_apis=(
  sqladmin.googleapis.com
  redis.googleapis.com
  secretmanager.googleapis.com
  vpcaccess.googleapis.com
  compute.googleapis.com
  cloudkms.googleapis.com
  run.googleapis.com
  cloudbuild.googleapis.com
  artifactregistry.googleapis.com
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

secret_has_enabled_version() {
  local secret_name="$1"
  local version
  version="$(gcloud secrets versions list "${secret_name}" \
    --project "${PROJECT_ID}" \
    --filter "state:enabled" \
    --limit 1 \
    --format "value(name)" 2>/dev/null || true)"
  [[ -n "${version}" ]]
}

sql_user_exists() {
  local user_name="$1"
  local users
  users="$(gcloud sql users list \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --format="value(name)")"
  grep -Fxq "${user_name}" <<< "${users}"
}

assert_database_url_safe_password() {
  local password="$1"
  local source_name="$2"
  if [[ ! "${password}" =~ ^[A-Za-z0-9._~-]+$ ]]; then
    echo "Refusing to write ${source_name} into a DATABASE_URL secret: use URL-safe password characters [A-Za-z0-9._~-] or let the script generate one." >&2
    exit 1
  fi
}

cloud_sql_database_url() {
  local user_name="$1"
  local password="$2"
  local connection_name="$3"
  assert_database_url_safe_password "${password}" "${user_name} password"
  printf "postgres://%s:%s@localhost/%s?host=/cloudsql/%s" \
    "${user_name}" "${password}" "${SQL_DATABASE}" "${connection_name}"
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

SQL_APP_PASSWORD="${SQL_APP_PASSWORD:-${DB_PASSWORD:-}}"
SQL_MIGRATOR_PASSWORD="${SQL_MIGRATOR_PASSWORD:-}"
SQL_APP_USER_CREATED="false"
SQL_MIGRATOR_USER_CREATED="false"
APP_DATABASE_URL_SECRET_WRITTEN="false"
MIGRATOR_DATABASE_URL_SECRET_WRITTEN="false"
ensure_secret zkvote-staging-database-url
ensure_secret zkvote-staging-migrator-database-url
if sql_user_exists "${SQL_APP_USER}"; then
  if [[ -n "${SQL_APP_PASSWORD}" ]]; then
    gcloud sql users set-password "${SQL_APP_USER}" \
      --instance "${SQL_INSTANCE}" \
      --project "${PROJECT_ID}" \
      --password "${SQL_APP_PASSWORD}" \
      --quiet
    CONNECTION_NAME_FOR_SECRET="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
    add_secret_version zkvote-staging-database-url "$(cloud_sql_database_url "${SQL_APP_USER}" "${SQL_APP_PASSWORD}" "${CONNECTION_NAME_FOR_SECRET}")"
    APP_DATABASE_URL_SECRET_WRITTEN="true"
  fi
else
  SQL_APP_PASSWORD="${SQL_APP_PASSWORD:-$(openssl rand -hex 24)}"
  gcloud sql users create "${SQL_APP_USER}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --password "${SQL_APP_PASSWORD}" \
    --quiet
  SQL_APP_USER_CREATED="true"
  CONNECTION_NAME_FOR_SECRET="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
  add_secret_version zkvote-staging-database-url "$(cloud_sql_database_url "${SQL_APP_USER}" "${SQL_APP_PASSWORD}" "${CONNECTION_NAME_FOR_SECRET}")"
  APP_DATABASE_URL_SECRET_WRITTEN="true"
fi

if sql_user_exists "${SQL_MIGRATOR_USER}"; then
  if [[ -n "${SQL_MIGRATOR_PASSWORD}" ]]; then
    gcloud sql users set-password "${SQL_MIGRATOR_USER}" \
      --instance "${SQL_INSTANCE}" \
      --project "${PROJECT_ID}" \
      --password "${SQL_MIGRATOR_PASSWORD}" \
      --quiet
    CONNECTION_NAME_FOR_SECRET="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
    add_secret_version zkvote-staging-migrator-database-url "$(cloud_sql_database_url "${SQL_MIGRATOR_USER}" "${SQL_MIGRATOR_PASSWORD}" "${CONNECTION_NAME_FOR_SECRET}")"
    MIGRATOR_DATABASE_URL_SECRET_WRITTEN="true"
  fi
else
  SQL_MIGRATOR_PASSWORD="${SQL_MIGRATOR_PASSWORD:-$(openssl rand -hex 24)}"
  gcloud sql users create "${SQL_MIGRATOR_USER}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --password "${SQL_MIGRATOR_PASSWORD}" \
    --quiet
  SQL_MIGRATOR_USER_CREATED="true"
  CONNECTION_NAME_FOR_SECRET="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
  add_secret_version zkvote-staging-migrator-database-url "$(cloud_sql_database_url "${SQL_MIGRATOR_USER}" "${SQL_MIGRATOR_PASSWORD}" "${CONNECTION_NAME_FOR_SECRET}")"
  MIGRATOR_DATABASE_URL_SECRET_WRITTEN="true"
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

if [[ -n "${RELAYER_PRIVATE_KEY:-}" && -n "${OWNER_PRIVATE_KEY:-}" && "${RELAYER_PRIVATE_KEY}" == "${OWNER_PRIVATE_KEY}" ]]; then
  echo "Refusing to write staging secrets: RELAYER_PRIVATE_KEY and OWNER_PRIVATE_KEY must be different." >&2
  exit 1
fi

secrets=(
  zkvote-staging-database-url
  zkvote-staging-redis-url
  zkvote-staging-supabase-url
  zkvote-staging-supabase-jwks-url
  zkvote-staging-sepolia-rpc-url
  zkvote-staging-relayer-private-key
  zkvote-staging-owner-private-key
  zkvote-staging-artifact-bucket
)
# zkvote-staging-secret-salt was removed: the server no longer derives voter
# secrets (audit H2 / architecture review AR-L5).
for secret_name in "${secrets[@]}"; do
  ensure_secret "${secret_name}"
  gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
done

if [[ "${APP_DATABASE_URL_SECRET_WRITTEN}" == "false" && "${SQL_APP_USER_CREATED}" == "false" ]]; then
  if secret_has_enabled_version zkvote-staging-database-url; then
    echo "Keeping existing runtime database-url secret version for existing ${SQL_APP_USER}."
  else
    echo "Refusing to continue: ${SQL_APP_USER} already exists but zkvote-staging-database-url has no enabled version. Provide SQL_APP_PASSWORD/DB_PASSWORD so the script can write the runtime DATABASE_URL secret." >&2
    exit 1
  fi
fi
if [[ "${MIGRATOR_DATABASE_URL_SECRET_WRITTEN}" == "false" && "${SQL_MIGRATOR_USER_CREATED}" == "false" ]]; then
  if secret_has_enabled_version zkvote-staging-migrator-database-url; then
    echo "Keeping existing migrator database-url secret version for existing ${SQL_MIGRATOR_USER}."
  else
    echo "Refusing to continue: ${SQL_MIGRATOR_USER} already exists but zkvote-staging-migrator-database-url has no enabled version. Provide SQL_MIGRATOR_PASSWORD so the script can write the migrator DATABASE_URL secret." >&2
    exit 1
  fi
fi
add_secret_version zkvote-staging-redis-url "${REDIS_URL}"
add_secret_version zkvote-staging-artifact-bucket "${BUCKET}"

[[ -n "${SUPABASE_URL:-}" ]] && add_secret_version zkvote-staging-supabase-url "${SUPABASE_URL}"
[[ -n "${SUPABASE_JWKS_URL:-}" ]] && add_secret_version zkvote-staging-supabase-jwks-url "${SUPABASE_JWKS_URL}"
[[ -n "${SEPOLIA_RPC_URL:-}" ]] && add_secret_version zkvote-staging-sepolia-rpc-url "${SEPOLIA_RPC_URL}"
[[ -n "${RELAYER_PRIVATE_KEY:-}" ]] && add_secret_version zkvote-staging-relayer-private-key "${RELAYER_PRIVATE_KEY}"
if [[ -n "${OWNER_PRIVATE_KEY:-}" ]]; then
  add_secret_version zkvote-staging-owner-private-key "${OWNER_PRIVATE_KEY}"
fi

echo "GCP staging setup complete."
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Bucket: gs://${BUCKET}"
echo "Cloud SQL instance: ${SQL_INSTANCE}"
echo "Cloud SQL runtime user: ${SQL_APP_USER}"
echo "Cloud SQL migrator user: ${SQL_MIGRATOR_USER}"
echo "Redis instance: ${REDIS_INSTANCE}"
echo "Service account: ${SERVICE_ACCOUNT_EMAIL}"
