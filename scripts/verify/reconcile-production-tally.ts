#!/usr/bin/env tsx
export {};

const projectId = process.env.GCP_PROJECT_ID ?? "zkvote-prod-hhyyj";
process.env.GCP_PROJECT_ID ??= projectId;
process.env.SEPOLIA_RPC_URL_SECRET ??= "zkvote-prod-sepolia-rpc-url";
process.env.E2E_DATABASE_URL_SECRET ??= "zkvote-prod-readonly-database-url";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
process.env.RECONCILE_CHECK_LABEL ??= "production tally reconciliation";
process.env.RECONCILE_EVIDENCE_PATH ??= `docs/evidence/production-reconcile-${runId}.json`;
await import("./reconcile-staging-tally");
