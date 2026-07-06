#!/usr/bin/env tsx
export {};

const projectId = process.env.GCP_PROJECT_ID ?? "zkvote-prod-hhyyj";
process.env.GCP_PROJECT_ID ??= projectId;
process.env.STAGING_BASE_URL ??= process.env.PRODUCTION_BASE_URL ?? process.env.PROD_BASE_URL;
process.env.FIREBASE_WEB_API_KEY_SECRET ??= "zkvote-prod-firebase-web-api-key";
process.env.E2E_VOTER_EMAIL_SECRET ??= "zkvote-prod-e2e-voter-email";
process.env.E2E_VOTER_PASSWORD_SECRET ??= "zkvote-prod-e2e-voter-password";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
process.env.LOAD_EVIDENCE_PATH ??= `docs/evidence/production-load-readonly-${runId}.json`;
await import("./load-staging-readonly");
