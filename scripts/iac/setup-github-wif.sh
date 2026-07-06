#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-zkvote-staging-hhyyj}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-HoYongJin/zk-vote}"
GITHUB_ENVIRONMENT="${GITHUB_ENVIRONMENT:-gcp-staging}"
POOL_ID="${WIF_POOL_ID:-zkvote-github}"
PROVIDER_ID="${WIF_PROVIDER_ID:-github}"
SERVICE_ACCOUNT="${FIREBASE_DEPLOY_SERVICE_ACCOUNT:-zkvote-staging-firebase-admin@${PROJECT_ID}.iam.gserviceaccount.com}"
LOCATION="global"

echo "Using project=${PROJECT_ID}, repository=${GITHUB_REPOSITORY}, environment=${GITHUB_ENVIRONMENT}"

gcloud services enable \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project "${PROJECT_ID}" \
  --quiet

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")"
PROVIDER_RESOURCE="projects/${PROJECT_NUMBER}/locations/${LOCATION}/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/${LOCATION}/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPOSITORY}"
ATTRIBUTE_MAPPING="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment"
ATTRIBUTE_CONDITION="assertion.repository == '${GITHUB_REPOSITORY}' && assertion.environment == '${GITHUB_ENVIRONMENT}'"

if ! gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --project "${PROJECT_ID}" \
  --location "${LOCATION}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --project "${PROJECT_ID}" \
    --location "${LOCATION}" \
    --display-name "zk-vote GitHub Actions" \
    --description "GitHub Actions OIDC identities for zk-vote staging deploys" \
    --quiet
fi

if gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project "${PROJECT_ID}" \
  --location "${LOCATION}" \
  --workload-identity-pool "${POOL_ID}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "${PROVIDER_ID}" \
    --project "${PROJECT_ID}" \
    --location "${LOCATION}" \
    --workload-identity-pool "${POOL_ID}" \
    --attribute-mapping "${ATTRIBUTE_MAPPING}" \
    --attribute-condition "${ATTRIBUTE_CONDITION}" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --quiet
else
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --project "${PROJECT_ID}" \
    --location "${LOCATION}" \
    --workload-identity-pool "${POOL_ID}" \
    --display-name "GitHub" \
    --description "GitHub Actions OIDC provider for ${GITHUB_REPOSITORY}" \
    --attribute-mapping "${ATTRIBUTE_MAPPING}" \
    --attribute-condition "${ATTRIBUTE_CONDITION}" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --quiet
fi

gcloud iam service-accounts describe "${SERVICE_ACCOUNT}" \
  --project "${PROJECT_ID}" >/dev/null

gcloud iam service-accounts add-iam-policy-binding "${SERVICE_ACCOUNT}" \
  --project "${PROJECT_ID}" \
  --member "${MEMBER}" \
  --role roles/iam.workloadIdentityUser \
  --quiet >/dev/null

cat <<EOF
GitHub WIF ready.
workload_identity_provider=${PROVIDER_RESOURCE}
service_account=${SERVICE_ACCOUNT}
repository=${GITHUB_REPOSITORY}
required_environment=${GITHUB_ENVIRONMENT}
EOF
