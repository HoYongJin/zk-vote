#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-zkvote-prod-hhyyj}"
SERVICE="${CLOUD_RUN_SERVICE:-zkvote-prod-api}"
REGION="${GCP_REGION:-asia-northeast3}"
if [[ -z "${STAGING_BASE_URL:-}" && -z "${PRODUCTION_BASE_URL:-}" && -z "${PROD_BASE_URL:-}" ]]; then
  STAGING_BASE_URL="$(gcloud run services describe "${SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"
else
  STAGING_BASE_URL="${STAGING_BASE_URL:-${PRODUCTION_BASE_URL:-${PROD_BASE_URL:-}}}"
fi
export STAGING_BASE_URL
export ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-zkvote-prod-artifacts-${PROJECT_ID}}"
export GCIP_ID_TOKEN="${GCIP_ID_TOKEN:-}"
export SUPABASE_ID_TOKEN="${SUPABASE_ID_TOKEN:-}"

bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/verify-staging.sh"
