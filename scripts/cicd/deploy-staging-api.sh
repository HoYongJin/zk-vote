#!/usr/bin/env bash
# Phase 16: builds and deploys zkvote-api to Cloud Run staging.
#
# >>> COSTS MONEY — DO NOT RUN WITHOUT EXPLICIT APPROVAL <<<
# (Artifact Registry storage, Cloud Build minutes, Cloud Run instances.)
# Requires scripts/iac/zkvote-staging-setup.sh to have provisioned Cloud
# SQL / Memorystore / VPC connector / secrets (M9/M10-hardened) first.
set -euo pipefail

# PROJECT_PLAN §18: dedicated staging project (NOT the shared POC project). This
# id is also the JWT audience (JWT_AUDIENCE=<PROJECT_ID>) and the issuer host
# segment, so it MUST equal the GCIP project AND the frontend
# Firebase project (VITE_FIREBASE_PROJECT_ID / .firebaserc). If they diverge,
# every GCIP token the frontend mints is rejected (wrong audience). Verify equality
# at the Phase-18 gate (docs/RUNBOOK_PHASE18_STANDUP.md §8).
PROJECT_ID="${PROJECT_ID:-${GCP_PROJECT_ID:-zkvote-staging-hhyyj}}"
REGION="${REGION:-${GCP_REGION:-asia-northeast3}}"
SERVICE="${SERVICE:-zkvote-staging-api}"
REPO="${REPO:-zkvote-staging}"
SQL_INSTANCE="${SQL_INSTANCE:-zkvote-staging-pg}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-zkvote-staging-api}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_EMAIL:-${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com}"
CLOUD_BUILD_SERVICE_ACCOUNT="${CLOUD_BUILD_SERVICE_ACCOUNT:-zkvote-staging-cloud-build}"
CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL="${CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL:-${CLOUD_BUILD_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com}"
VPC_CONNECTOR="${VPC_CONNECTOR:-zkvote-staging-vpc}"
# Must match the setup run: memorystore attaches the VPC connector; external
# (Upstash/VM) omits it and reaches Redis over the public rediss:// REDIS_URL.
REDIS_BACKEND="${REDIS_BACKEND:-memorystore}"
CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-}"
RELAYER_PRIVATE_KEY_SECRET="${RELAYER_PRIVATE_KEY_SECRET:-zkvote-staging-relayer-private-key}"
OWNER_PRIVATE_KEY_SECRET="${OWNER_PRIVATE_KEY_SECRET:-}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-1}"

if [[ "${CONFIRM_COSTS:-}" != "yes" ]]; then
  echo "Refusing to run: set CONFIRM_COSTS=yes after explicit user approval (this creates billable resources)." >&2
  exit 1
fi
if [[ -z "${CORS_ALLOWED_ORIGINS}" ]]; then
  echo "Refusing to deploy: set CORS_ALLOWED_ORIGINS to the staging frontend origin(s), comma-separated." >&2
  exit 1
fi
if [[ -z "${OWNER_PRIVATE_KEY_SECRET}" ]]; then
  echo "Refusing to deploy: set OWNER_PRIVATE_KEY_SECRET=zkvote-staging-owner-private-key so the hot relayer key does not own VotingTally." >&2
  exit 1
fi
if [[ "${MAX_INSTANCES}" != "1" ]]; then
  echo "Refusing to deploy: prod-ready v1 requires MAX_INSTANCES=1 until a durable worker/nonce/fencing architecture replaces the current Redis TTL leases." >&2
  exit 1
fi

command -v forge >/dev/null || {
  echo "Refusing to deploy: forge is required to produce Foundry contract artifacts under out/." >&2
  exit 1
}
forge build

for artifact in \
  out/VotingTally.sol/VotingTally.json \
  out/Groth16Verifier_4_10.sol/Groth16Verifier_4_10.json \
  out/Groth16Verifier_6_10.sol/Groth16Verifier_6_10.json \
  out/Groth16Verifier_8_10.sol/Groth16Verifier_8_10.json \
  out/Groth16Verifier_10_10.sol/Groth16Verifier_10_10.json; do
  if [[ ! -s "${artifact}" ]]; then
    echo "Refusing to deploy: missing ${artifact}; run forge build successfully first." >&2
    exit 1
  fi
done

CONNECTION_NAME="$(gcloud sql instances describe "${SQL_INSTANCE}" --project "${PROJECT_ID}" --format='value(connectionName)')"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/zkvote-api:$(git rev-parse --short HEAD)"

# AR-M4: owner key mounting is explicit and mandatory for staging deploys.
# Check this before any Artifact Registry or Cloud Build side effect.
gcloud secrets describe "${RELAYER_PRIVATE_KEY_SECRET}" --project "${PROJECT_ID}" >/dev/null
gcloud secrets describe "${OWNER_PRIVATE_KEY_SECRET}" --project "${PROJECT_ID}" >/dev/null
RELAYER_PRIVATE_KEY_VALUE="$(gcloud secrets versions access latest \
  --secret "${RELAYER_PRIVATE_KEY_SECRET}" \
  --project "${PROJECT_ID}")"
OWNER_PRIVATE_KEY_VALUE="$(gcloud secrets versions access latest \
  --secret "${OWNER_PRIVATE_KEY_SECRET}" \
  --project "${PROJECT_ID}")"
if [[ "${OWNER_PRIVATE_KEY_VALUE}" == "${RELAYER_PRIVATE_KEY_VALUE}" ]]; then
  echo "Refusing to deploy: OWNER_PRIVATE_KEY_SECRET and RELAYER_PRIVATE_KEY_SECRET contain the same key." >&2
  exit 1
fi
unset OWNER_PRIVATE_KEY_VALUE RELAYER_PRIVATE_KEY_VALUE
gcloud secrets add-iam-policy-binding "${OWNER_PRIVATE_KEY_SECRET}" \
  --project "${PROJECT_ID}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/secretmanager.secretAccessor \
  --quiet >/dev/null
gcloud secrets add-iam-policy-binding "${RELAYER_PRIVATE_KEY_SECRET}" \
  --project "${PROJECT_ID}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/secretmanager.secretAccessor \
  --quiet >/dev/null

gcloud artifacts repositories describe "${REPO}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "${REPO}" --repository-format=docker --location "${REGION}" --project "${PROJECT_ID}"

gcloud iam service-accounts describe "${CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --project "${PROJECT_ID}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${CLOUD_BUILD_SERVICE_ACCOUNT}" \
      --project "${PROJECT_ID}" \
      --display-name "zk-vote staging Cloud Build" \
      --quiet

for cloud_build_role in roles/cloudbuild.builds.builder roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL}" \
    --role "${cloud_build_role}" \
    --quiet >/dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://${PROJECT_ID}_cloudbuild" \
  --member "serviceAccount:${CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --role roles/storage.objectViewer \
  --quiet >/dev/null

gcloud builds submit . \
  --config scripts/cicd/cloudbuild-staging-api.yaml \
  --substitutions "_IMAGE=${IMAGE}" \
  --service-account "projects/${PROJECT_ID}/serviceAccounts/${CLOUD_BUILD_SERVICE_ACCOUNT_EMAIL}" \
  --project "${PROJECT_ID}"

deploy_args=(
  "${SERVICE}"
  --project "${PROJECT_ID}"
  --region "${REGION}"
  --image "${IMAGE}"
  --service-account "${SERVICE_ACCOUNT_EMAIL}"
  --add-cloudsql-instances "${CONNECTION_NAME}"
  --allow-unauthenticated
  --concurrency 1
  # Minimal/free-tier: scale to zero when idle (no Cloud Run charge), cap at 1.
  # MAX_INSTANCES=1 is load-bearing for v1 nonce/lease safety.
  --min-instances "${MIN_INSTANCES}"
  --max-instances "${MAX_INSTANCES}"
  # INFRA-2: APP_ENV and REQUIRE_BEACON were inert here — the Rust binary reads
  # neither (REQUIRE_BEACON is a Node-only flag). Setting REQUIRE_BEACON=true
  # implied a trusted-setup beacon enforcement the deployed service does not
  # perform; dropped to avoid a false sense of assurance. The beacon ceremony
  # gate lives in the artifact pipeline, not the API runtime.
  # GCIP (PROJECT_PLAN §0 / Phase 18): set the JWT issuer + audience EXPLICITLY so
  # the backend validates Google `securetoken` JWTs. The audience is the BARE
  # GCIP/Firebase project id. SUPABASE_* aliases are temporarily set to the same
  # values for rollback compatibility with older API images.
  --set-env-vars "^|^ARTIFACT_STORE=gcs|CHAIN_ID=11155111|CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}|JWT_ISSUER=https://securetoken.google.com/${PROJECT_ID}|JWT_AUDIENCE=${PROJECT_ID}|SUPABASE_JWT_ISSUER=https://securetoken.google.com/${PROJECT_ID}|SUPABASE_JWT_AUDIENCE=${PROJECT_ID}"
)

# Attach the VPC connector ONLY for Memorystore (private IP). For external Redis
# (REDIS_BACKEND=external — Upstash/VM over public rediss://) there is no connector;
# Cloud SQL is still reached via --add-cloudsql-instances above.
if [[ "${REDIS_BACKEND}" == "memorystore" ]]; then
  deploy_args+=(--vpc-connector "${VPC_CONNECTOR}")
fi

secret_bindings=(
  "DATABASE_URL=zkvote-staging-database-url:latest"
  "REDIS_URL=zkvote-staging-redis-url:latest"
  # SUPABASE_URL is intentionally NOT bound: it is unused for auth once the issuer
  # is explicit (above) and was only the legacy Node data plane. The JWKS secret
  # VALUE must be the GCIP JWK endpoint
  # (https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com),
  # NOT the /robot/v1/metadata/x509/ PEM endpoint and NOT a Supabase JWKS URL.
  "AUTH_JWKS_URL=zkvote-staging-auth-jwks-url:latest"
  # Deprecated alias kept only for rollback compatibility.
  "SUPABASE_JWKS_URL=zkvote-staging-auth-jwks-url:latest"
  "SEPOLIA_RPC_URL=zkvote-staging-sepolia-rpc-url:latest"
  "RELAYER_PRIVATE_KEY=${RELAYER_PRIVATE_KEY_SECRET}:latest"
  "ARTIFACT_BUCKET=zkvote-staging-artifact-bucket:latest"
)

secret_bindings+=("OWNER_PRIVATE_KEY=${OWNER_PRIVATE_KEY_SECRET}:latest")

secret_bindings_arg="$(IFS='|'; echo "${secret_bindings[*]}")"
deploy_args+=(--set-secrets "^|^${secret_bindings_arg}")

gcloud run deploy "${deploy_args[@]}"

echo "Deployed ${IMAGE} to ${SERVICE}. Verify: gcloud run services describe ${SERVICE} --region ${REGION}"
