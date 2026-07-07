#!/usr/bin/env tsx
export {};

const projectId = process.env.GCP_PROJECT_ID ?? "zkvote-prod-hhyyj";
const defaultBaseUrl = "https://zkvote-prod-api-afq4ond6ha-du.a.run.app";
process.env.GCP_PROJECT_ID ??= projectId;
process.env.VERIFY_BASE_URL ??= process.env.PRODUCTION_BASE_URL ?? process.env.PROD_BASE_URL ?? defaultBaseUrl;
process.env.FIREBASE_WEB_API_KEY_SECRET ??= "zkvote-prod-firebase-web-api-key";
process.env.E2E_VOTER_EMAIL_SECRET ??= "zkvote-prod-e2e-voter-email";
process.env.E2E_VOTER_PASSWORD_SECRET ??= "zkvote-prod-e2e-voter-password";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
process.env.LOAD_CHECK_LABEL ??= "production read-only load";
process.env.LOAD_EVIDENCE_PATH ??= `docs/evidence/production-load-readonly-${runId}.json`;
await import("./load-staging-readonly");
