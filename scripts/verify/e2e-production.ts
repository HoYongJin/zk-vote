#!/usr/bin/env tsx
export {};

const projectId = process.env.GCP_PROJECT_ID ?? "zkvote-prod-hhyyj";
process.env.GCP_PROJECT_ID ??= projectId;
process.env.CLOUD_RUN_SERVICE ??= "zkvote-prod-api";
process.env.ARTIFACT_BUCKET ??= `zkvote-prod-artifacts-${projectId}`;
process.env.VERIFY_BASE_URL ??= process.env.PRODUCTION_BASE_URL ?? process.env.PROD_BASE_URL;
process.env.FIREBASE_WEB_API_KEY_SECRET ??= "zkvote-prod-firebase-web-api-key";
process.env.E2E_SUPERADMIN_EMAIL_SECRET ??= "zkvote-prod-e2e-superadmin-email";
process.env.E2E_SUPERADMIN_PASSWORD_SECRET ??= "zkvote-prod-e2e-superadmin-password";
process.env.E2E_VOTER_EMAIL_SECRET ??= "zkvote-prod-e2e-voter-email";
process.env.E2E_VOTER_PASSWORD_SECRET ??= "zkvote-prod-e2e-voter-password";
process.env.SEPOLIA_RPC_URL_SECRET ??= "zkvote-prod-sepolia-rpc-url";
process.env.E2E_DATABASE_URL_SECRET ??= "zkvote-prod-readonly-database-url";
process.env.OWNER_PRIVATE_KEY_SECRET ??= "zkvote-prod-owner-private-key";
process.env.ETHERSCAN_API_KEY_SECRET ??= "zkvote-prod-etherscan-api-key";
process.env.ETHERSCAN_VERIFY_AFTER_DEPLOY ??= "true";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
process.env.E2E_EVIDENCE_PATH ??= `docs/evidence/production-e2e-${runId}.json`;
process.env.ETHERSCAN_VERIFY_EVIDENCE_PATH ??= `docs/evidence/production-etherscan-verify-${runId}.json`;
await import("./e2e-staging");
