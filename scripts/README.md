# scripts layout

`scripts/` is split by operational role. Runtime code must not depend on these
paths; they are operator, CI/CD, migration, and verification tools.

## iac

Scripted infrastructure-as-code until the GCP resources move to Terraform or an
equivalent declarative IaC tool.

- `iac/zkvote-staging-setup.sh`: creates/updates staging GCP resources and seeds
  the artifact bucket through the CI/CD artifact seeder.
- `iac/setup-github-wif.sh`: configures GitHub Actions OIDC/WIF for staging.
- `iac/setup-staging-monitoring.ts`: creates staging Monitoring/Logging resources.
- `iac/bootstrap-staging-superadmin.sh`: one-time staging data bootstrap for E2E.

## cicd

Repeatable deployment and CI/CD support.

- `cicd/deploy-staging-api.sh`: builds and deploys the Rust API to Cloud Run.
- `cicd/seed-artifacts.sh`: verifies and uploads proving artifacts to GCS.
- `cicd/sync-github-frontend-env.ts`: syncs Firebase/Cloud Run build settings into
  GitHub environment secrets.
- `cicd/deploy-firebase-hosting-rest.ts`: Firebase Hosting REST fallback when
  Firebase CLI auth is not usable locally.
- `cicd/cloudbuild-staging-api.yaml`: Cloud Build config for the API image.

## verify

Read-only or mostly read-only gates that prove a deploy is healthy. These should
survive production hardening.

- `verify/check-artifact-schema.sh`
- `verify/preflight-staging.ts`
- `verify/verify-staging.sh`
- `verify/e2e-staging.ts`
- `verify/browser-smoke-staging.ts`
- `verify/check-ceremony-beacon.sh`
- `verify/json-evidence-update.mjs`

## migration

Cutover-only tools. Keep these until production cutover and rollback windows are
closed.

- `migration/migrate-cloudsql.sh`
- `migration/etl-supabase-to-postgres.ts`
- `migration/import-users-to-gcip.ts`
- `migration/fieldElement.ts`
- `migration/supabaseClient.ts`

## local

Local developer bootstrap and DB verification only.

## compatibility wrappers

Legacy `scripts/gcp/*` and `scripts/ci/check-artifact-schema.sh` paths remain as
thin wrappers so existing terminals/runbooks do not break immediately. New docs
and workflows should use the role-based paths above.
