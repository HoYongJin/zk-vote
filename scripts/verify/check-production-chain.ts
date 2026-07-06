#!/usr/bin/env tsx
export {};

const projectId = process.env.GCP_PROJECT_ID ?? "zkvote-prod-hhyyj";
process.env.GCP_PROJECT_ID ??= projectId;
process.env.SEPOLIA_RPC_URL_SECRET ??= "zkvote-prod-sepolia-rpc-url";
process.env.RELAYER_PRIVATE_KEY_SECRET ??= "zkvote-prod-relayer-private-key";
process.env.OWNER_PRIVATE_KEY_SECRET ??= "zkvote-prod-owner-private-key";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
process.env.CHAIN_EVIDENCE_PATH ??= `docs/evidence/production-chain-${runId}.json`;
await import("./check-staging-chain");
