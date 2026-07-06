#!/usr/bin/env bash
# Builds and deploys zkvote-api to Cloud Run production.
#
# >>> COSTS MONEY — DO NOT RUN WITHOUT EXPLICIT APPROVAL <<<
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_ROOT}/.env"
  set +a
fi

PROJECT_ID="${PROJECT_ID:-${GCP_PROJECT_ID:-zkvote-prod-hhyyj}}"
REGION="${REGION:-${GCP_REGION:-asia-northeast3}}"
SERVICE="${SERVICE:-zkvote-prod-api}"
REPO="${REPO:-zkvote-prod}"
SQL_INSTANCE="${SQL_INSTANCE:-zkvote-prod-pg}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-zkvote-prod-api}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_EMAIL:-${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com}"
VPC_CONNECTOR="${VPC_CONNECTOR:-zkvote-prod-vpc}"
CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-https://${PROJECT_ID}.web.app,https://${PROJECT_ID}.firebaseapp.com}"
RELAYER_PRIVATE_KEY_SECRET="${RELAYER_PRIVATE_KEY_SECRET:-zkvote-prod-relayer-private-key}"
OWNER_PRIVATE_KEY_SECRET="${OWNER_PRIVATE_KEY_SECRET:-zkvote-prod-owner-private-key}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
MAX_INSTANCES="${MAX_INSTANCES:-1}"

if [[ "${CONFIRM_COSTS:-}" != "yes" ]]; then
  echo "Refusing to run: set CONFIRM_COSTS=yes after explicit approval (Cloud Build/Artifact Registry/Cloud Run are billable)." >&2
  exit 1
fi
if [[ "${MAX_INSTANCES}" != "1" ]]; then
  echo "Refusing to deploy: production v1 requires MAX_INSTANCES=1 until durable nonce/fencing architecture exists." >&2
  exit 1
fi
if [[ -z "${CORS_ALLOWED_ORIGINS// /}" ]]; then
  echo "Refusing to deploy: CORS_ALLOWED_ORIGINS is empty." >&2
  exit 1
fi

cd "${PROJECT_ROOT}"
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
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"

gcloud secrets describe "${RELAYER_PRIVATE_KEY_SECRET}" --project "${PROJECT_ID}" >/dev/null
gcloud secrets describe "${OWNER_PRIVATE_KEY_SECRET}" --project "${PROJECT_ID}" >/dev/null
RELAYER_PRIVATE_KEY_VALUE="$(gcloud secrets versions access latest \
  --secret "${RELAYER_PRIVATE_KEY_SECRET}" \
  --project "${PROJECT_ID}")"
OWNER_PRIVATE_KEY_VALUE="$(gcloud secrets versions access latest \
  --secret "${OWNER_PRIVATE_KEY_SECRET}" \
  --project "${PROJECT_ID}")"
if [[ "${OWNER_PRIVATE_KEY_VALUE}" == "${RELAYER_PRIVATE_KEY_VALUE}" ]]; then
  echo "Refusing to deploy: owner and relayer secret values are identical." >&2
  exit 1
fi
unset OWNER_PRIVATE_KEY_VALUE RELAYER_PRIVATE_KEY_VALUE

for secret_name in "${OWNER_PRIVATE_KEY_SECRET}" "${RELAYER_PRIVATE_KEY_SECRET}"; do
  gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
done

gcloud artifacts repositories describe "${REPO}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "${REPO}" --repository-format=docker --location "${REGION}" --project "${PROJECT_ID}" --quiet

# New projects can run Cloud Build with the Compute default service account.
# It needs source-bucket read, image push, and log-write permissions.
for cloud_build_role in roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role "${cloud_build_role}" \
    --quiet >/dev/null
done

gcloud builds submit . \
  --config scripts/cicd/cloudbuild-staging-api.yaml \
  --substitutions "_IMAGE=${IMAGE}" \
  --project "${PROJECT_ID}"

deploy_args=(
  "${SERVICE}"
  --project "${PROJECT_ID}"
  --region "${REGION}"
  --image "${IMAGE}"
  --service-account "${SERVICE_ACCOUNT_EMAIL}"
  --add-cloudsql-instances "${CONNECTION_NAME}"
  --allow-unauthenticated
  --min-instances "${MIN_INSTANCES}"
  --max-instances "${MAX_INSTANCES}"
  --vpc-connector "${VPC_CONNECTOR}"
  --set-env-vars "^|^ARTIFACT_STORE=gcs|CHAIN_ID=11155111|CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS}|JWT_ISSUER=https://securetoken.google.com/${PROJECT_ID}|JWT_AUDIENCE=${PROJECT_ID}|SUPABASE_JWT_ISSUER=https://securetoken.google.com/${PROJECT_ID}|SUPABASE_JWT_AUDIENCE=${PROJECT_ID}"
)

secret_bindings=(
  "DATABASE_URL=zkvote-prod-database-url:latest"
  "REDIS_URL=zkvote-prod-redis-url:latest"
  "AUTH_JWKS_URL=zkvote-prod-auth-jwks-url:latest"
  "SUPABASE_JWKS_URL=zkvote-prod-auth-jwks-url:latest"
  "SEPOLIA_RPC_URL=zkvote-prod-sepolia-rpc-url:latest"
  "RELAYER_PRIVATE_KEY=${RELAYER_PRIVATE_KEY_SECRET}:latest"
  "OWNER_PRIVATE_KEY=${OWNER_PRIVATE_KEY_SECRET}:latest"
  "ARTIFACT_BUCKET=zkvote-prod-artifact-bucket:latest"
)
secret_bindings_arg="$(IFS='|'; echo "${secret_bindings[*]}")"
deploy_args+=(--set-secrets "^|^${secret_bindings_arg}")

gcloud run deploy "${deploy_args[@]}"

echo "Deployed ${IMAGE} to ${SERVICE}."
echo "URL: $(gcloud run services describe "${SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"
