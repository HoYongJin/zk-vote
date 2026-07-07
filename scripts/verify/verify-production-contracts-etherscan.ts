#!/usr/bin/env tsx
export {};

const projectId = process.env.GCP_PROJECT_ID ?? "zkvote-prod-hhyyj";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
process.env.GCP_PROJECT_ID ??= projectId;
process.env.CHAIN_ID ??= "11155111";
process.env.ETHERSCAN_CHAIN ??= "sepolia";
process.env.E2E_DATABASE_URL_SECRET ??= "zkvote-prod-migrator-database-url";
process.env.OWNER_PRIVATE_KEY_SECRET ??= "zkvote-prod-owner-private-key";
process.env.SEPOLIA_RPC_URL_SECRET ??= "zkvote-prod-sepolia-rpc-url";
process.env.ETHERSCAN_API_KEY_SECRET ??= "zkvote-prod-etherscan-api-key";
process.env.ETHERSCAN_VERIFY_EVIDENCE_PATH ??= `docs/evidence/production-etherscan-verify-${runId}.json`;

await import("./verify-contracts-etherscan");
