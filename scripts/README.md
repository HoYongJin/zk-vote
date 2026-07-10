# scripts layout

`scripts/` contains production-only operator, CI/CD, migration, and verification
tools. Runtime code must not depend on these paths.

## iac

- `iac/zkvote-production-setup.sh`: creates or reconciles production GCP
  resources, production-only secrets, and the least-privilege CI deployer.
- `iac/setup-production-github-wif.sh`: configures the GitHub Actions OIDC
  identity for `main` production deployment.
- `iac/setup-production-firebase.ts`: configures Firebase, GCIP, Hosting, and
  synthetic E2E users.
- `iac/setup-production-monitoring.ts`: configures production Monitoring and
  Logging resources.
- `iac/bootstrap-production-superadmin.sh`: one-time synthetic superadmin
  bootstrap for E2E.

## cicd

- `cicd/deploy-production-api.sh`: deploys the API with `MIN_INSTANCES=1` and
  `MAX_INSTANCES=1`.
- `cicd/seed-artifacts.sh`: verifies and uploads proving artifacts to GCS.
- `cicd/sync-github-frontend-env.ts`: syncs production Firebase and Cloud Run
  build settings into the `gcp-production` GitHub environment.
- `cicd/deploy-firebase-hosting-rest.ts`: Firebase Hosting REST fallback for
  local operator use.
- `cicd/render-firebase-config.ts`: renders production CSP from the deployed
  API and Firebase Auth origins.
- `cicd/cloudbuild-api.yaml`: Cloud Build image recipe.

## verify

- `verify/preflight-production.ts`
- `verify/verify-production.sh`
- `verify/check-production-chain.ts`
- `verify/e2e-production.ts`
- `verify/browser-smoke-production.ts`
- `verify/browser-user-flow-production.ts`
- `verify/verify-production-contracts-etherscan.ts`
- `verify/reconcile-production-tally.ts`
- `verify/load-production-readonly.ts`
- `verify/check-artifact-schema.sh`
- `verify/check-ceremony-beacon.sh`

## migration and local

`migration/` is retained for Cloud SQL migration and GCIP import recovery.
`local/` contains local developer bootstrap and DB verification only.
