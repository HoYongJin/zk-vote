#!/usr/bin/env tsx
export {};

const projectId = process.env.GCP_PROJECT_ID ?? "zkvote-prod-hhyyj";
process.env.GCP_PROJECT_ID ??= projectId;
process.env.FIREBASE_HOSTING_URL ??= process.env.PRODUCTION_FIREBASE_HOSTING_URL ?? `https://${projectId}.web.app`;
process.env.E2E_VOTER_EMAIL_SECRET ??= "zkvote-prod-e2e-voter-email";
process.env.E2E_VOTER_PASSWORD_SECRET ??= "zkvote-prod-e2e-voter-password";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
process.env.BROWSER_SMOKE_EVIDENCE_PATH ??= `docs/evidence/production-browser-smoke-${runId}.json`;
process.env.BROWSER_SMOKE_SCREENSHOT_PATH ??= `docs/evidence/production-browser-smoke-${runId}.png`;
await import("./browser-smoke-staging");
