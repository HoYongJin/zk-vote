#!/usr/bin/env tsx
/**
 * Read-only DB-vs-on-chain reconciliation for production.
 *
 * The DB intentionally does not store a per-vote candidate choice, so this gate
 * reconciles totals: confirmed DB submissions per election must equal the sum
 * of on-chain voteCounts(0..num_candidates-1). It also samples stored
 * nullifiers and checks usedNullifiers(nullifier) on-chain.
 */
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runProductionDbReadbackJob } from "./productionDbReadbackJob";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_PROJECT_ID = "zkvote-prod-hhyyj";
const DEFAULT_REGION = "asia-northeast3";
const DEFAULT_SECRET_NAMES = {
    rpcUrl: "zkvote-prod-sepolia-rpc-url",
} as const;
const EXPECTED_CHAIN_ID_DECIMAL = "11155111";
const VOTE_COUNTS_SELECTOR = "0x3c3a220d";
const USED_NULLIFIERS_SELECTOR = "0xaad24061";

type Json = Record<string, unknown>;

interface ElectionRow {
    id: string;
    name: string;
    num_candidates: number;
    contract_address: string;
    completed: boolean;
    confirmed_votes: string;
    nullifiers: string[] | null;
}

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    command: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    checks: Record<string, unknown>;
    caveats: string[];
    failure?: string;
}

function optionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

function env(name: string, fallback?: string): string {
    const value = optionalEnv(name);
    if (value) return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`Set ${name}`);
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function invocation(): string {
    return ["node", "--import", "tsx", path.relative(PROJECT_ROOT, fileURLToPath(import.meta.url))]
        .join(" ");
}

function writeEvidence(filePath: string, evidence: Evidence): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function secretValue(projectId: string, secretName: string): Promise<string> {
    const { stdout } = await execFile(
        "gcloud",
        [
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            secretName,
            "--project",
            projectId,
        ],
        { maxBuffer: 1024 * 1024 }
    );
    return stdout.trim();
}

async function envOrSecret(
    projectId: string,
    envName: string,
    defaultSecretName: string
): Promise<string> {
    const direct = optionalEnv(envName);
    if (direct) return direct;
    const secretName = optionalEnv(`${envName}_SECRET`) ?? defaultSecretName;
    const value = await secretValue(projectId, secretName);
    assert(value, `${envName} secret ${secretName} is empty`);
    return value;
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
    const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (!response.ok || body.error) {
        throw new Error(`${method} failed: ${body.error?.message ?? response.statusText}`);
    }
    return body.result as T;
}

function uint256Call(selector: string, value: bigint): string {
    assert(value >= 0n, "uint256 value must be non-negative");
    return `${selector}${value.toString(16).padStart(64, "0")}`;
}

async function ethCallUint(rpcUrl: string, to: string, data: string): Promise<bigint> {
    const result = await rpc<string>(rpcUrl, "eth_call", [{ to, data }, "latest"]);
    return BigInt(result);
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", DEFAULT_PROJECT_ID);
    const nullifierSampleLimit = Number(optionalEnv("RECONCILE_NULLIFIER_SAMPLE_LIMIT") ?? "20");
    assert(Number.isInteger(nullifierSampleLimit) && nullifierSampleLimit >= 0, "invalid RECONCILE_NULLIFIER_SAMPLE_LIMIT");
    const evidencePath =
        optionalEnv("RECONCILE_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `production-reconcile-${runId}.json`);
    const checkLabel = env("RECONCILE_CHECK_LABEL", "production tally reconciliation");
    const evidence: Evidence = {
        status: "running",
        runId,
        command: invocation(),
        startedAt: new Date().toISOString(),
        projectId,
        checks: {},
        caveats: [],
    };
    writeEvidence(evidencePath, evidence);

    try {
        const rpcUrl = await envOrSecret(projectId, "SEPOLIA_RPC_URL", DEFAULT_SECRET_NAMES.rpcUrl);
        const chainIdHex = await rpc<string>(rpcUrl, "eth_chainId", []);
        const chainId = BigInt(chainIdHex).toString();
        assert(chainId === EXPECTED_CHAIN_ID_DECIMAL, `RPC chain id ${chainId} != ${EXPECTED_CHAIN_ID_DECIMAL}`);

        const dbReadback = await runProductionDbReadbackJob({
            projectId,
            region: env("GCP_REGION", DEFAULT_REGION),
            mode: "reconcile",
        });
        assert(Array.isArray(dbReadback.result), "DB reconcile readback returned malformed JSON");
        const elections = dbReadback.result as ElectionRow[];
        const dbConnection: Json = {
            mode: "cloud-run-job",
            job: dbReadback.job,
            execution: dbReadback.execution,
        };
        if (elections.length === 0) {
            evidence.caveats.push("No deployed, non-superseded elections found to reconcile.");
        }

        const reconciled = [];
        for (const election of elections) {
            assert(/^0x[0-9a-fA-F]{40}$/.test(election.contract_address), `invalid contract address for ${election.id}`);
            const counts: string[] = [];
            let onchainTotal = 0n;
            for (let candidate = 0; candidate < election.num_candidates; candidate += 1) {
                const count = await ethCallUint(
                    rpcUrl,
                    election.contract_address,
                    uint256Call(VOTE_COUNTS_SELECTOR, BigInt(candidate))
                );
                counts.push(count.toString());
                onchainTotal += count;
            }
            const dbConfirmed = BigInt(election.confirmed_votes);
            assert(
                onchainTotal === dbConfirmed,
                `election ${election.id} total mismatch: chain=${onchainTotal} db=${dbConfirmed}`
            );

            const sampledNullifiers = (election.nullifiers ?? []).slice(0, nullifierSampleLimit);
            for (const nullifier of sampledNullifiers) {
                const used = await ethCallUint(
                    rpcUrl,
                    election.contract_address,
                    uint256Call(USED_NULLIFIERS_SELECTOR, BigInt(nullifier))
                );
                assert(used === 1n, `election ${election.id} nullifier ${nullifier} is not marked used on-chain`);
            }

            reconciled.push({
                electionId: election.id,
                name: election.name,
                completed: election.completed,
                contractAddress: election.contract_address,
                numCandidates: election.num_candidates,
                dbConfirmedVotes: dbConfirmed.toString(),
                onchainVoteCounts: counts,
                onchainTotal: onchainTotal.toString(),
                sampledNullifiers: sampledNullifiers.length,
            });
        }

        evidence.checks = {
            chainId,
            dbConnection,
            electionsChecked: reconciled.length,
            elections: reconciled,
        };
        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`${checkLabel} PASSED; evidence=${evidencePath}`);
    } catch (error) {
        evidence.status = "failed";
        evidence.finishedAt = new Date().toISOString();
        evidence.failure = error instanceof Error ? error.message : String(error);
        writeEvidence(evidencePath, evidence);
        throw error;
    }
}

void main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
