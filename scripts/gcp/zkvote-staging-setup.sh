#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

# PROJECT_PLAN §18: this is a DEDICATED staging project, NOT the shared POC project.
# The Cloud Run project, the GCIP/Identity-Platform project, the JWT audience
# (deploy-staging-api.sh sets SUPABASE_JWT_AUDIENCE=<PROJECT_ID>), and the frontend
# Firebase project (VITE_FIREBASE_PROJECT_ID / .firebaserc) MUST ALL be this
# same id. If they diverge, the backend's audience check rejects 100% of the
# frontend's GCIP tokens. Override GCP_PROJECT_ID for your real (globally-unique)
# project id; the default is intentionally not the shared POC project.
PROJECT_ID="${GCP_PROJECT_ID:-zkvote-staging-26c4d8}"
REGION="${GCP_REGION:-asia-northeast3}"
BUCKET="${ARTIFACT_BUCKET:-zkvote-staging-artifacts-${PROJECT_ID}}"
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

# --- Minimal / free-tier-leaning specs (defaults are the cheapest floor for a
#     staging/demo on the free trial; override these for production — see
#     docs/PRODUCTION_READINESS.md). Memorystore basic 1GB + the VPC connector
#     are the irreducible managed cost floor; see RUNBOOK_PHASE18_STANDUP.md
#     "Cost minimization" for the Redis-off-Memorystore routes to ~$0. ---
SQL_TIER="${SQL_TIER:-db-f1-micro}"               # cheapest shared-core
SQL_STORAGE_TYPE="${SQL_STORAGE_TYPE:-HDD}"       # HDD < SSD for a demo
SQL_STORAGE_SIZE="${SQL_STORAGE_SIZE:-10}"        # 10GB is the floor
SQL_ENABLE_BACKUPS="${SQL_ENABLE_BACKUPS:-false}" # off for minimal staging
# REDIS_BACKEND=memorystore (managed, ~$36/mo + connector) | external (operator
# supplies REDIS_URL, e.g. a free Upstash rediss:// endpoint or a self-hosted VM;
# Memorystore AND the VPC connector are then SKIPPED entirely → ~$8/mo). The Rust
# API only needs a reachable Redis for submission tickets + finalize/deploy locks.
REDIS_BACKEND="${REDIS_BACKEND:-memorystore}"
REDIS_TIER="${REDIS_TIER:-basic}"                 # no HA (smallest tier)
REDIS_SIZE="${REDIS_SIZE:-1}"                     # 1GB is the floor
VPC_MIN_INSTANCES="${VPC_MIN_INSTANCES:-2}"       # 2 is the connector floor
VPC_MAX_INSTANCES="${VPC_MAX_INSTANCES:-3}"       # max MUST be > min; 2/3 is the floor (idle cost == min, so no penalty)

# DRY_RUN=yes/1/true previews the RESOLVED plan with NO GCP call, NO cost, NO auth.
DRY_RUN="${DRY_RUN:-}"
is_dry_run() { [[ -n "${DRY_RUN}" && "${DRY_RUN}" != "false" && "${DRY_RUN}" != "0" && "${DRY_RUN}" != "no" ]]; }

if ! is_dry_run && [[ "${CONFIRM_COSTS:-}" != "yes" ]]; then
  echo "Refusing to run: set CONFIRM_COSTS=yes after explicit user approval (this creates billable GCP resources). Or set DRY_RUN=yes to preview the plan (no cost, no auth)." >&2
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
  # PROJECT_PLAN Phase 7: GCP Identity Platform (GCIP) — the IdP that replaces
  # Supabase Auth. Enabling the API is free; provisioning the tenant/providers
  # and importing users is the cost/approval-gated step done separately.
  identitytoolkit.googleapis.com
)

if is_dry_run; then
  if [[ "${REDIS_BACKEND}" == "memorystore" ]]; then
    redis_plan="Memorystore ${REDIS_TIER}/${REDIS_SIZE}GB + VPC connector ${VPC_MIN_INSTANCES}-${VPC_MAX_INSTANCES} x e2-micro"
    redis_step="Memorystore + VPC connector"
  else
    redis_plan="external (REDIS_URL=${REDIS_URL:-<supply REDIS_URL>}); Memorystore + connector SKIPPED"
    redis_step="(external Redis: nothing created; REDIS_URL written to the secret)"
  fi
  if [[ "${SQL_ENABLE_BACKUPS}" == "true" ]]; then backups_plan="--backup-start-time 19:00"; else backups_plan="--no-backup"; fi
  cat <<PLAN
== DRY-RUN plan — no GCP calls, no cost, no auth. Resolved configuration:
   project         : ${PROJECT_ID}    region: ${REGION}
   redis backend   : ${REDIS_BACKEND} -> ${redis_plan}
   cloud sql       : ${SQL_INSTANCE} (${SQL_TIER}, ${SQL_STORAGE_TYPE}, ${SQL_STORAGE_SIZE}GB, ZONAL, ${backups_plan})
   artifact bucket : gs://${BUCKET}  (seeded byte-exact from zk/build_{4,6,8,10}_10, sha256-verified)
   runtime SA      : ${SERVICE_ACCOUNT_EMAIL}  (storage.objectViewer + cloudsql.client + log/metric writer)

Would idempotently ensure, in order:
   1. enable APIs              : ${required_apis[*]}
   2. GCS bucket + versioning + lifecycle, then seed-artifacts.sh
   3. runtime service account + least-privilege IAM
   4. Cloud SQL + database '${SQL_DATABASE}' + app/migrator users (URL-safe passwords)
   5. ${redis_step}
   6. secrets w/ per-secret IAM: database-url, redis-url, supabase-jwks-url (fixed GCIP endpoint),
      sepolia-rpc-url, relayer/owner private keys, artifact-bucket

Re-run withOUT DRY_RUN — with CONFIRM_COSTS=yes and an authenticated CORRECT account — to apply.
PLAN
  exit 0
fi

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

# Seed the proving artifacts into the freshly-created bucket. Without this the
# bucket is empty and, at runtime (ARTIFACT_STORE=gcs), every voter's wasm/zkey
# GET 404s — proving is impossible (audit Phase-18 must-fix). seed-artifacts.sh
# uploads the byte-exact zk/build_*/ files to the object keys artifacts.rs serves
# and sha256-verifies each upload (invariant #7). Idempotent: re-running is safe.
# Runs under the OPERATOR's gcloud credentials (not the runtime SA, which is
# read-only). Must precede `deploy-staging-api.sh` so the first /proof flow works.
PROJECT_ID="${PROJECT_ID}" BUCKET="${BUCKET}" CONFIRM_COSTS="${CONFIRM_COSTS}" \
  bash "${SCRIPT_DIR}/seed-artifacts.sh"

# A newly-created service account propagates across GCP IAM asynchronously, so an
# immediate add-iam-policy-binding can fail with "does not exist". retry() wraps
# the eventually-consistent IAM calls with bounded backoff.
retry() {
  local n=0 max=10 delay=6
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

if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SERVICE_ACCOUNT}" \
    --project "${PROJECT_ID}" \
    --display-name "zk-vote staging API" \
    --quiet
fi

# Wait for the SA to be resolvable before binding roles to it (create->bind race).
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

# Least-privilege (audit Phase-18 review): the runtime API only performs
# authenticated GETs against GCS (artifacts.rs read_gcs_artifact) — it never
# writes/deletes objects. objectViewer (read-only) is sufficient; objectAdmin
# would let a compromised --allow-unauthenticated instance overwrite/delete
# proving artifacts (invariant #7 risk). Artifact SEEDING runs under the
# operator's own credentials (seed-artifacts.sh below), not this runtime SA.
retry gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/storage.objectViewer \
  --quiet >/dev/null

if ! gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  sql_create_args=(
    "${SQL_INSTANCE}"
    --project "${PROJECT_ID}"
    --database-version POSTGRES_16
    --edition ENTERPRISE
    --region "${REGION}"
    --tier "${SQL_TIER}"
    --availability-type ZONAL
    --storage-type "${SQL_STORAGE_TYPE}"
    --storage-size "${SQL_STORAGE_SIZE}"
  )
  if [[ "${SQL_ENABLE_BACKUPS}" == "true" ]]; then
    sql_create_args+=(--backup-start-time 19:00)
  else
    # Minimal/demo: skip automated backups (no backup-storage cost). Prod must
    # set SQL_ENABLE_BACKUPS=true (PITR/backup is a Phase-22 gate).
    sql_create_args+=(--no-backup)
  fi
  gcloud sql instances create "${sql_create_args[@]}" --quiet
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

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"

if [[ "${REDIS_BACKEND}" == "memorystore" ]]; then
  if ! gcloud redis instances describe "${REDIS_INSTANCE}" --region "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud redis instances create "${REDIS_INSTANCE}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --tier "${REDIS_TIER}" \
      --size "${REDIS_SIZE}" \
      --redis-version redis_7_0 \
      --quiet
  fi
  # The VPC connector exists solely to give Cloud Run private-IP access to
  # Memorystore (Cloud SQL uses --add-cloudsql-instances, no connector needed).
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
  REDIS_URL="redis://${REDIS_HOST}:6379"
else
  # external Redis (e.g. a free Upstash rediss:// endpoint or a self-hosted VM):
  # no Memorystore, no VPC connector. The operator supplies REDIS_URL (written to
  # the secret below); the deploy must then OMIT --vpc-connector (REDIS_BACKEND=external).
  echo "REDIS_BACKEND=external — skipping Memorystore + VPC connector (deploy omits --vpc-connector)."
  REDIS_URL="${REDIS_URL:-}"
fi

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
  retry gcloud secrets add-iam-policy-binding "${secret_name}" \
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
# memorystore: REDIS_URL is computed above (always non-empty). external: the
# operator must supply REDIS_URL (or have a prior enabled secret version).
if [[ -n "${REDIS_URL}" ]]; then
  add_secret_version zkvote-staging-redis-url "${REDIS_URL}"
elif ! secret_has_enabled_version zkvote-staging-redis-url; then
  echo "Refusing to continue: REDIS_BACKEND=external but no REDIS_URL provided and zkvote-staging-redis-url has no enabled version. Export REDIS_URL (e.g. an Upstash rediss:// endpoint)." >&2
  exit 1
fi
add_secret_version zkvote-staging-artifact-bucket "${BUCKET}"

[[ -n "${SUPABASE_URL:-}" ]] && add_secret_version zkvote-staging-supabase-url "${SUPABASE_URL}"

# The GCIP JWKS endpoint is a FIXED public constant (PROJECT_PLAN §18 + §8), not a
# per-deploy secret value. Write it UNCONDITIONALLY so deploy's `--set-secrets
# SUPABASE_JWKS_URL=zkvote-staging-supabase-jwks-url:latest` always resolves to an
# enabled version. An exported SUPABASE_JWKS_URL still overrides it. config.rs:117
# does NOT empty-filter this value, so refuse an empty override (would mount Some("")
# and break token verification) rather than fail opaquely at deploy time.
GCIP_JWKS_DEFAULT="https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
SUPABASE_JWKS_URL="${SUPABASE_JWKS_URL:-$GCIP_JWKS_DEFAULT}"
if [[ -z "${SUPABASE_JWKS_URL// /}" ]]; then
  echo "Refusing: SUPABASE_JWKS_URL is empty (would mount an empty JWKS and break token verification)." >&2
  exit 1
fi
add_secret_version zkvote-staging-supabase-jwks-url "${SUPABASE_JWKS_URL}"

# SEPOLIA_RPC_URL is a genuine operator-supplied endpoint (cannot be defaulted).
# Add its version if exported, then fail FAST if the secret still has no enabled
# version — otherwise `gcloud run deploy ...sepolia-rpc-url:latest` fails opaquely later.
[[ -n "${SEPOLIA_RPC_URL:-}" ]] && add_secret_version zkvote-staging-sepolia-rpc-url "${SEPOLIA_RPC_URL}"
if ! secret_has_enabled_version zkvote-staging-sepolia-rpc-url; then
  echo "Refusing to continue: zkvote-staging-sepolia-rpc-url has no enabled version. Export SEPOLIA_RPC_URL so setup writes it (the deploy binds it at :latest)." >&2
  exit 1
fi
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
