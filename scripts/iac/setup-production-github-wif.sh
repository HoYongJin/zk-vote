#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-zkvote-prod-hhyyj}"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"

GCP_PROJECT_ID="${PROJECT_ID}" \
GITHUB_ENVIRONMENT="${GITHUB_ENVIRONMENT:-gcp-production}" \
FIREBASE_DEPLOY_SERVICE_ACCOUNT="${FIREBASE_DEPLOY_SERVICE_ACCOUNT:-zkvote-prod-firebase-admin@${PROJECT_ID}.iam.gserviceaccount.com}" \
  bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/setup-github-wif.sh"

cat <<EOF
For GitHub environment secrets:
GCP_WORKLOAD_IDENTITY_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/zkvote-github/providers/github
GCP_FIREBASE_DEPLOY_SERVICE_ACCOUNT=${FIREBASE_DEPLOY_SERVICE_ACCOUNT:-zkvote-prod-firebase-admin@${PROJECT_ID}.iam.gserviceaccount.com}
EOF
