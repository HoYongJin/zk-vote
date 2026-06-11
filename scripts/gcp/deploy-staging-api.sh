#!/usr/bin/env bash
# Phase 16: builds and deploys zkvote-api to Cloud Run staging.
#
# >>> COSTS MONEY — DO NOT RUN WITHOUT EXPLICIT APPROVAL <<<
# (Artifact Registry storage, Cloud Build minutes, Cloud Run instances.)
# Requires scripts/gcp/zkvote-staging-setup.sh to have provisioned Cloud
# SQL / Memorystore / VPC connector / secrets (M9/M10-hardened) first.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-scopeball-registry-poc-g}"
REGION="${REGION:-asia-northeast3}"
SERVICE="${SERVICE:-zkvote-staging-api}"
REPO="${REPO:-zkvote-staging}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_EMAIL:?set to the runtime service account}"
VPC_CONNECTOR="${VPC_CONNECTOR:-zkvote-staging-connector}"
CONNECTION_NAME="$(gcloud sql instances describe zkvote-staging-pg --project "${PROJECT_ID}" --format='value(connectionName)')"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/zkvote-api:$(git rev-parse --short HEAD)"

if [[ "${CONFIRM_COSTS:-}" != "yes" ]]; then
  echo "Refusing to run: set CONFIRM_COSTS=yes after explicit user approval (this creates billable resources)." >&2
  exit 1
fi

gcloud artifacts repositories describe "${REPO}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "${REPO}" --repository-format=docker --location "${REGION}" --project "${PROJECT_ID}"

gcloud builds submit rust-backend --tag "${IMAGE}" --project "${PROJECT_ID}"

gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --service-account "${SERVICE_ACCOUNT_EMAIL}" \
  --vpc-connector "${VPC_CONNECTOR}" \
  --add-cloudsql-instances "${CONNECTION_NAME}" \
  --no-allow-unauthenticated \
  --min-instances 0 --max-instances 2 \
  --set-secrets "DATABASE_URL=zkvote-staging-database-url:latest" \
  --set-secrets "REDIS_URL=zkvote-staging-redis-url:latest" \
  --set-secrets "SUPABASE_URL=zkvote-staging-supabase-url:latest" \
  --set-secrets "SUPABASE_JWKS_URL=zkvote-staging-supabase-jwks-url:latest" \
  --set-secrets "SEPOLIA_RPC_URL=zkvote-staging-sepolia-rpc-url:latest" \
  --set-secrets "RELAYER_PRIVATE_KEY=zkvote-staging-relayer-private-key:latest" \
  --set-env-vars "APP_ENV=staging,ARTIFACT_STORE=gcs,REQUIRE_BEACON=true"
# NOTE: OWNER_PRIVATE_KEY (AR-M4) is intentionally NOT mounted on the
# internet-facing service by default; finalize runs against a dedicated
# secret added only when an election is being finalized, or from an ops
# workstation. zkvote-staging-owner-private-key must be created at that time.

echo "Deployed ${IMAGE} to ${SERVICE}. Verify: gcloud run services describe ${SERVICE} --region ${REGION}"
