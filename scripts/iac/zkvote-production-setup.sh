#!/usr/bin/env bash
# Idempotent production GCP infrastructure bootstrap.
#
# >>> COSTS MONEY — DO NOT RUN WITHOUT EXPLICIT APPROVAL <<<
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

PRIMARY_PROJECT_ID="${GCP_PROJECT_ID:-zkvote-prod-hhyyj}"
FALLBACK_PROJECT_ID="${GCP_PROJECT_ID_FALLBACK:-zkvote-prod-hhyyj-20260706}"
PROJECT_ID="${PRIMARY_PROJECT_ID}"
ORG_ID="${GCP_ORGANIZATION_ID:-110300218090}"
BILLING_ACCOUNT_ID="${GCP_BILLING_ACCOUNT_ID:-019A0E-3A8EC6-467FC9}"
REGION="${GCP_REGION:-asia-northeast3}"

BUCKET="${ARTIFACT_BUCKET:-zkvote-prod-artifacts-${PROJECT_ID}}"
SQL_INSTANCE="${SQL_INSTANCE:-zkvote-prod-pg}"
SQL_DATABASE="${SQL_DATABASE:-zkvote}"
SQL_TIER="${SQL_TIER:-db-custom-2-7680}"
SQL_STORAGE_SIZE="${SQL_STORAGE_SIZE:-20}"
SQL_BACKUP_START_TIME="${SQL_BACKUP_START_TIME:-19:00}"
SQL_APP_USER="${SQL_APP_USER:-zkvote_app}"
SQL_MIGRATOR_USER="${SQL_MIGRATOR_USER:-zkvote_migrator}"
SQL_READONLY_USER="${SQL_READONLY_USER:-zkvote_readonly}"
REDIS_INSTANCE="${REDIS_INSTANCE:-zkvote-prod-redis}"
REDIS_SIZE="${REDIS_SIZE:-1}"
VPC_CONNECTOR="${VPC_CONNECTOR:-zkvote-prod-vpc}"
NETWORK="${NETWORK:-default}"
VPC_RANGE="${VPC_RANGE:-10.9.0.0/28}"
PRIVATE_SERVICE_RANGE="${PRIVATE_SERVICE_RANGE:-google-managed-services-default}"
PRIVATE_SERVICE_PREFIX_LENGTH="${PRIVATE_SERVICE_PREFIX_LENGTH:-16}"
VPC_MIN_INSTANCES="${VPC_MIN_INSTANCES:-2}"
VPC_MAX_INSTANCES="${VPC_MAX_INSTANCES:-3}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-zkvote-prod-api}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
CLOUD_BUILD_SERVICE_ACCOUNT="${CLOUD_BUILD_SERVICE_ACCOUNT:-zkvote-prod-cloud-build}"
CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL="${CLOUD_BUILD_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
CI_DEPLOY_SERVICE_ACCOUNT_NAME="${CI_DEPLOY_SERVICE_ACCOUNT_NAME:-zkvote-prod-ci-deployer}"
CI_DEPLOY_SERVICE_ACCOUNT_OVERRIDE="${GCP_CI_DEPLOY_SERVICE_ACCOUNT:-}"
CI_DEPLOY_SERVICE_ACCOUNT="${CI_DEPLOY_SERVICE_ACCOUNT_OVERRIDE:-${CI_DEPLOY_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"

is_dry_run() {
  [[ -n "${DRY_RUN:-}" && "${DRY_RUN}" != "false" && "${DRY_RUN}" != "0" && "${DRY_RUN}" != "no" ]]
}

if ! is_dry_run && [[ "${CONFIRM_COSTS:-}" != "yes" ]]; then
  echo "Refusing to run: set CONFIRM_COSTS=yes after explicit approval (this creates billable production resources)." >&2
  exit 1
fi

required_apis=(
  cloudresourcemanager.googleapis.com
  serviceusage.googleapis.com
  cloudbilling.googleapis.com
  sqladmin.googleapis.com
  redis.googleapis.com
  secretmanager.googleapis.com
  vpcaccess.googleapis.com
  servicenetworking.googleapis.com
  compute.googleapis.com
  cloudkms.googleapis.com
  run.googleapis.com
  cloudbuild.googleapis.com
  artifactregistry.googleapis.com
  firebase.googleapis.com
  firebasehosting.googleapis.com
  identitytoolkit.googleapis.com
  apikeys.googleapis.com
  iam.googleapis.com
  iamcredentials.googleapis.com
  sts.googleapis.com
)

if is_dry_run; then
  cat <<PLAN
== DRY-RUN production plan — no GCP calls, no cost, no auth.
project candidates : ${PRIMARY_PROJECT_ID} -> ${FALLBACK_PROJECT_ID}
organization       : ${ORG_ID}
billing account    : ${BILLING_ACCOUNT_ID}
region             : ${REGION}
Cloud SQL          : ${SQL_INSTANCE} POSTGRES_16 ENTERPRISE REGIONAL ${SQL_TIER} SSD ${SQL_STORAGE_SIZE}GB backup=${SQL_BACKUP_START_TIME} PITR deletion-protection
Redis              : ${REDIS_INSTANCE} STANDARD_HA Redis 7 ${REDIS_SIZE}GB
Cloud Run API      : zkvote-prod-api min=1 max=1
artifact bucket    : gs://${BUCKET}
private services   : ${PRIVATE_SERVICE_RANGE} /${PRIVATE_SERVICE_PREFIX_LENGTH} on ${NETWORK}
runtime SA         : ${SERVICE_ACCOUNT_EMAIL}
Cloud Build SA     : ${CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL}
CI deploy SA       : ${CI_DEPLOY_SERVICE_ACCOUNT}
secrets            : zkvote-prod-* only; readback uses readonly DB

Would create/link/enable project, seed GCS artifacts, create Cloud SQL/Redis/VPC,
write production secrets, and prepare Firebase/GCIP via setup-production-firebase.ts.
PLAN
  exit 0
fi

retry() {
  local n=0 max=12 delay=8
  until "$@"; do
    n=$((n + 1))
    if [[ "${n}" -ge "${max}" ]]; then
      echo "retry: still failing after ${max} attempts: $*" >&2
      return 1
    fi
    echo "retry ${n}/${max} (waiting ${delay}s): $*" >&2
    sleep "${delay}"
  done
}

ensure_project() {
  local candidate="$1"
  if gcloud projects describe "${candidate}" --format='value(projectId)' >/dev/null 2>&1; then
    PROJECT_ID="${candidate}"
    return 0
  fi
  if gcloud projects create "${candidate}" \
    --organization "${ORG_ID}" \
    --name "zkvote production" \
    --labels app=zkvote,env=production \
    --quiet; then
    PROJECT_ID="${candidate}"
    return 0
  fi
  return 1
}

if ! ensure_project "${PRIMARY_PROJECT_ID}"; then
  echo "Primary project id ${PRIMARY_PROJECT_ID} was not usable; trying fallback ${FALLBACK_PROJECT_ID}." >&2
  ensure_project "${FALLBACK_PROJECT_ID}"
fi

BUCKET="${ARTIFACT_BUCKET:-zkvote-prod-artifacts-${PROJECT_ID}}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
CI_DEPLOY_SERVICE_ACCOUNT="${CI_DEPLOY_SERVICE_ACCOUNT_OVERRIDE:-${CI_DEPLOY_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"

echo "Using production project=${PROJECT_ID}, region=${REGION}"

gcloud billing projects link "${PROJECT_ID}" \
  --billing-account "${BILLING_ACCOUNT_ID}" \
  --quiet

for api in "${required_apis[@]}"; do
  gcloud services enable "${api}" --project "${PROJECT_ID}" --quiet
done

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

secret_value() {
  local secret_name="$1"
  gcloud secrets versions access latest --secret "${secret_name}" --project "${PROJECT_ID}"
}

assert_database_url_safe_password() {
  local password="$1"
  local source_name="$2"
  if [[ ! "${password}" =~ ^[A-Za-z0-9._~-]+$ ]]; then
    echo "Refusing to write ${source_name}: use URL-safe password characters [A-Za-z0-9._~-]." >&2
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

random_password() {
  openssl rand -hex 24
}

random_private_key() {
  node -e 'process.stdout.write("0x" + require("crypto").randomBytes(32).toString("hex"))'
}

sql_user_exists() {
  local user_name="$1"
  local users
  users="$(gcloud sql users list \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --format="value(name)" 2>/dev/null || true)"
  grep -Fxq "${user_name}" <<< "${users}"
}

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

PROJECT_ID="${PROJECT_ID}" BUCKET="${BUCKET}" CONFIRM_COSTS="${CONFIRM_COSTS}" \
  bash "${PROJECT_ROOT}/scripts/cicd/seed-artifacts.sh"

for account in "${SERVICE_ACCOUNT}" "${CLOUD_BUILD_SERVICE_ACCOUNT}" "${CI_DEPLOY_SERVICE_ACCOUNT_NAME}"; do
  email="${account}@${PROJECT_ID}.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "${email}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${account}" \
      --project "${PROJECT_ID}" \
      --display-name "${account}" \
      --quiet
  fi
done

for _ in $(seq 1 15); do
  gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1 && break
  sleep 4
done

for role in roles/cloudsql.client roles/logging.logWriter roles/monitoring.metricWriter; do
  retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role "${role}" \
    --quiet >/dev/null
done
for cloud_build_role in roles/cloudbuild.builds.builder roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter; do
  retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL}" \
    --role "${cloud_build_role}" \
    --quiet >/dev/null
done
retry gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/storage.objectViewer \
  --quiet >/dev/null

for role in \
  roles/firebasehosting.admin \
  roles/firebase.viewer \
  roles/serviceusage.serviceUsageConsumer \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/cloudsql.viewer \
  roles/redis.viewer; do
  retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${CI_DEPLOY_SERVICE_ACCOUNT}" \
    --role "${role}" \
    --quiet >/dev/null
done
retry gcloud artifacts repositories add-iam-policy-binding "zkvote-prod" \
  --location "${REGION}" \
  --project "${PROJECT_ID}" \
  --member "serviceAccount:${CI_DEPLOY_SERVICE_ACCOUNT}" \
  --role roles/artifactregistry.writer \
  --quiet >/dev/null
retry gcloud storage buckets add-iam-policy-binding "gs://${PROJECT_ID}_cloudbuild" \
  --member "serviceAccount:${CI_DEPLOY_SERVICE_ACCOUNT}" \
  --role roles/storage.objectAdmin \
  --quiet >/dev/null
retry gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${CI_DEPLOY_SERVICE_ACCOUNT}" \
  --role roles/storage.objectViewer \
  --quiet >/dev/null
for service_account in "${SERVICE_ACCOUNT_EMAIL}" "${CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL}"; do
  retry gcloud iam service-accounts add-iam-policy-binding "${service_account}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${CI_DEPLOY_SERVICE_ACCOUNT}" \
    --role roles/iam.serviceAccountUser \
    --quiet >/dev/null
done

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)"
if [[ -n "${ACTIVE_ACCOUNT}" ]]; then
  retry gcloud iam service-accounts add-iam-policy-binding "${CI_DEPLOY_SERVICE_ACCOUNT}" \
    --project "${PROJECT_ID}" \
    --member "user:${ACTIVE_ACCOUNT}" \
    --role roles/iam.serviceAccountTokenCreator \
    --quiet >/dev/null
fi

ensure_secret zkvote-prod-postgres-password
ensure_secret zkvote-prod-database-url
ensure_secret zkvote-prod-migrator-database-url
ensure_secret zkvote-prod-readonly-database-url
ensure_secret zkvote-prod-redis-url
ensure_secret zkvote-prod-auth-jwks-url
ensure_secret zkvote-prod-sepolia-rpc-url
ensure_secret zkvote-prod-owner-private-key
ensure_secret zkvote-prod-relayer-private-key
ensure_secret zkvote-prod-artifact-bucket

ADMIN_PASSWORD="${ADMIN_PASSWORD:-${POSTGRES_PASSWORD:-}}"
if [[ -z "${ADMIN_PASSWORD}" && "$(secret_has_enabled_version zkvote-prod-postgres-password; echo $?)" == "0" ]]; then
  ADMIN_PASSWORD="$(secret_value zkvote-prod-postgres-password)"
fi
ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(random_password)}"
add_secret_version zkvote-prod-postgres-password "${ADMIN_PASSWORD}"

if ! gcloud compute addresses describe "${PRIVATE_SERVICE_RANGE}" \
  --global \
  --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute addresses create "${PRIVATE_SERVICE_RANGE}" \
    --project "${PROJECT_ID}" \
    --global \
    --purpose=VPC_PEERING \
    --prefix-length="${PRIVATE_SERVICE_PREFIX_LENGTH}" \
    --network="${NETWORK}" \
    --quiet
fi

if ! gcloud services vpc-peerings list \
  --project "${PROJECT_ID}" \
  --network="${NETWORK}" \
  --format='value(service)' | grep -qx 'servicenetworking.googleapis.com'; then
  gcloud services vpc-peerings connect \
    --project "${PROJECT_ID}" \
    --service=servicenetworking.googleapis.com \
    --ranges="${PRIVATE_SERVICE_RANGE}" \
    --network="${NETWORK}" \
    --quiet
fi

if ! gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud sql instances create "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --database-version POSTGRES_16 \
    --edition ENTERPRISE \
    --region "${REGION}" \
    --tier "${SQL_TIER}" \
    --availability-type REGIONAL \
    --storage-type SSD \
    --storage-size "${SQL_STORAGE_SIZE}" \
    --storage-auto-increase \
    --network="${NETWORK}" \
    --no-assign-ip \
    --ssl-mode=ENCRYPTED_ONLY \
    --backup-start-time "${SQL_BACKUP_START_TIME}" \
    --enable-point-in-time-recovery \
    --retained-backups-count 7 \
    --retained-transaction-log-days 7 \
    --deletion-protection \
    --quiet
fi

gcloud sql users set-password postgres \
  --instance "${SQL_INSTANCE}" \
  --project "${PROJECT_ID}" \
  --password "${ADMIN_PASSWORD}" \
  --quiet

if ! gcloud sql databases describe "${SQL_DATABASE}" --instance "${SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud sql databases create "${SQL_DATABASE}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --quiet
fi

SQL_APP_PASSWORD="${SQL_APP_PASSWORD:-${APP_PASSWORD:-}}"
if [[ -z "${SQL_APP_PASSWORD}" && "$(secret_has_enabled_version zkvote-prod-database-url; echo $?)" == "0" ]]; then
  existing_url="$(secret_value zkvote-prod-database-url)"
  SQL_APP_PASSWORD="$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password));' "${existing_url}")"
fi
SQL_APP_PASSWORD="${SQL_APP_PASSWORD:-$(random_password)}"

SQL_MIGRATOR_PASSWORD="${SQL_MIGRATOR_PASSWORD:-${MIGRATOR_PASSWORD:-}}"
if [[ -z "${SQL_MIGRATOR_PASSWORD}" && "$(secret_has_enabled_version zkvote-prod-migrator-database-url; echo $?)" == "0" ]]; then
  existing_url="$(secret_value zkvote-prod-migrator-database-url)"
  SQL_MIGRATOR_PASSWORD="$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password));' "${existing_url}")"
fi
SQL_MIGRATOR_PASSWORD="${SQL_MIGRATOR_PASSWORD:-$(random_password)}"

SQL_READONLY_PASSWORD="${SQL_READONLY_PASSWORD:-${READONLY_PASSWORD:-}}"
if [[ -z "${SQL_READONLY_PASSWORD}" && "$(secret_has_enabled_version zkvote-prod-readonly-database-url; echo $?)" == "0" ]]; then
  existing_url="$(secret_value zkvote-prod-readonly-database-url)"
  SQL_READONLY_PASSWORD="$(node -e 'const u=new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password));' "${existing_url}")"
fi
SQL_READONLY_PASSWORD="${SQL_READONLY_PASSWORD:-$(random_password)}"

if sql_user_exists "${SQL_APP_USER}"; then
  gcloud sql users set-password "${SQL_APP_USER}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --password "${SQL_APP_PASSWORD}" \
    --quiet
else
  gcloud sql users create "${SQL_APP_USER}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --password "${SQL_APP_PASSWORD}" \
    --quiet
fi

if sql_user_exists "${SQL_MIGRATOR_USER}"; then
  gcloud sql users set-password "${SQL_MIGRATOR_USER}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --password "${SQL_MIGRATOR_PASSWORD}" \
    --quiet
else
  gcloud sql users create "${SQL_MIGRATOR_USER}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --password "${SQL_MIGRATOR_PASSWORD}" \
    --quiet
fi

if sql_user_exists "${SQL_READONLY_USER}"; then
  gcloud sql users set-password "${SQL_READONLY_USER}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --password "${SQL_READONLY_PASSWORD}" \
    --quiet
else
  gcloud sql users create "${SQL_READONLY_USER}" \
    --instance "${SQL_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --password "${SQL_READONLY_PASSWORD}" \
    --quiet
fi

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
add_secret_version zkvote-prod-database-url "$(cloud_sql_database_url "${SQL_APP_USER}" "${SQL_APP_PASSWORD}" "${CONNECTION_NAME}")"
add_secret_version zkvote-prod-migrator-database-url "$(cloud_sql_database_url "${SQL_MIGRATOR_USER}" "${SQL_MIGRATOR_PASSWORD}" "${CONNECTION_NAME}")"
add_secret_version zkvote-prod-readonly-database-url "$(cloud_sql_database_url "${SQL_READONLY_USER}" "${SQL_READONLY_PASSWORD}" "${CONNECTION_NAME}")"

if ! gcloud redis instances describe "${REDIS_INSTANCE}" --region "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud redis instances create "${REDIS_INSTANCE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --tier standard \
    --size "${REDIS_SIZE}" \
    --redis-version redis_7_0 \
    --quiet
fi

if ! gcloud compute networks vpc-access connectors describe "${VPC_CONNECTOR}" --region "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud compute networks vpc-access connectors create "${VPC_CONNECTOR}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --network "${NETWORK}" \
    --range "${VPC_RANGE}" \
    --min-instances "${VPC_MIN_INSTANCES}" \
    --max-instances "${VPC_MAX_INSTANCES}" \
    --machine-type e2-micro \
    --quiet
fi

REDIS_HOST="$(gcloud redis instances describe "${REDIS_INSTANCE}" --region "${REGION}" --project "${PROJECT_ID}" --format='value(host)')"
add_secret_version zkvote-prod-redis-url "redis://${REDIS_HOST}:6379"
add_secret_version zkvote-prod-artifact-bucket "${BUCKET}"
add_secret_version zkvote-prod-auth-jwks-url "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"

if [[ -n "${SEPOLIA_RPC_URL:-}" ]]; then
  add_secret_version zkvote-prod-sepolia-rpc-url "${SEPOLIA_RPC_URL}"
elif ! secret_has_enabled_version zkvote-prod-sepolia-rpc-url; then
  echo "Refusing to continue: set SEPOLIA_RPC_URL or pre-create zkvote-prod-sepolia-rpc-url." >&2
  exit 1
fi

if [[ -n "${PROD_OWNER_PRIVATE_KEY:-}" ]]; then
  add_secret_version zkvote-prod-owner-private-key "${PROD_OWNER_PRIVATE_KEY}"
elif [[ -n "${OWNER_PRIVATE_KEY:-}" && "${ALLOW_NONFRESH_PROD_KEYS:-}" == "yes" ]]; then
  add_secret_version zkvote-prod-owner-private-key "${OWNER_PRIVATE_KEY}"
elif ! secret_has_enabled_version zkvote-prod-owner-private-key; then
  echo "Generating fresh production owner key into Secret Manager."
  add_secret_version zkvote-prod-owner-private-key "$(random_private_key)"
fi

if [[ -n "${PROD_RELAYER_PRIVATE_KEY:-}" ]]; then
  add_secret_version zkvote-prod-relayer-private-key "${PROD_RELAYER_PRIVATE_KEY}"
elif [[ -n "${RELAYER_PRIVATE_KEY:-}" && "${ALLOW_NONFRESH_PROD_KEYS:-}" == "yes" ]]; then
  add_secret_version zkvote-prod-relayer-private-key "${RELAYER_PRIVATE_KEY}"
elif ! secret_has_enabled_version zkvote-prod-relayer-private-key; then
  echo "Generating fresh production relayer key into Secret Manager."
  add_secret_version zkvote-prod-relayer-private-key "$(random_private_key)"
fi

owner_value="$(secret_value zkvote-prod-owner-private-key)"
relayer_value="$(secret_value zkvote-prod-relayer-private-key)"
if [[ "${owner_value}" == "${relayer_value}" ]]; then
  echo "Refusing to continue: production owner and relayer keys are identical." >&2
  exit 1
fi
unset owner_value relayer_value

for secret_name in \
  zkvote-prod-postgres-password \
  zkvote-prod-database-url \
  zkvote-prod-migrator-database-url \
  zkvote-prod-readonly-database-url \
  zkvote-prod-redis-url \
  zkvote-prod-auth-jwks-url \
  zkvote-prod-sepolia-rpc-url \
  zkvote-prod-owner-private-key \
  zkvote-prod-relayer-private-key \
  zkvote-prod-artifact-bucket; do
  retry gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
done

GCP_PROJECT_ID="${PROJECT_ID}" \
GCP_REGION="${REGION}" \
GCP_CI_DEPLOY_SERVICE_ACCOUNT="${CI_DEPLOY_SERVICE_ACCOUNT}" \
CONFIRM_COSTS="${CONFIRM_COSTS}" \
  node --import tsx "${PROJECT_ROOT}/scripts/iac/setup-production-firebase.ts"

# GitHub Actions receives secret metadata only for the exact preflight surface.
# It receives secret values only for chain validation, deploy key-separation, and
# browser smoke. Runtime secrets remain mounted only to the Cloud Run service account.
for secret_name in \
  zkvote-prod-database-url \
  zkvote-prod-migrator-database-url \
  zkvote-prod-readonly-database-url \
  zkvote-prod-redis-url \
  zkvote-prod-auth-jwks-url \
  zkvote-prod-sepolia-rpc-url \
  zkvote-prod-owner-private-key \
  zkvote-prod-relayer-private-key \
  zkvote-prod-artifact-bucket \
  zkvote-prod-firebase-web-api-key \
  zkvote-prod-e2e-superadmin-email \
  zkvote-prod-e2e-superadmin-password \
  zkvote-prod-e2e-voter-email \
  zkvote-prod-e2e-voter-password; do
  retry gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${CI_DEPLOY_SERVICE_ACCOUNT}" \
    --role roles/secretmanager.viewer \
    --quiet >/dev/null
done
for secret_name in \
  zkvote-prod-owner-private-key \
  zkvote-prod-relayer-private-key \
  zkvote-prod-sepolia-rpc-url \
  zkvote-prod-e2e-voter-email \
  zkvote-prod-e2e-voter-password; do
  retry gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${CI_DEPLOY_SERVICE_ACCOUNT}" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
done

cat <<DONE
Production infrastructure setup complete.
Project: ${PROJECT_ID}
Region: ${REGION}
Bucket: gs://${BUCKET}
Cloud SQL instance: ${SQL_INSTANCE}
Cloud SQL connection: ${CONNECTION_NAME}
Cloud SQL readonly user: ${SQL_READONLY_USER}
Redis instance: ${REDIS_INSTANCE}
Runtime service account: ${SERVICE_ACCOUNT_EMAIL}
CI deploy service account: ${CI_DEPLOY_SERVICE_ACCOUNT}

Next:
  GCP_PROJECT_ID=${PROJECT_ID} bash scripts/migration/migrate-production-cloudsql.sh
  GCP_PROJECT_ID=${PROJECT_ID} node --import tsx scripts/verify/check-production-chain.ts
DONE
