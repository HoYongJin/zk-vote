#!/usr/bin/env tsx
/**
 * Read-only DB-vs-on-chain reconciliation for production.
 *
 * The DB intentionally does not store a per-vote candidate choice, so this gate
 * reconciles totals: confirmed DB submissions per election must equal the sum
 * of on-chain voteCounts(0..num_candidates-1). It also samples stored
 * nullifiers and checks usedNullifiers(nullifier) on-chain.
 */
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { prepareCloudSqlProxyBinary } from "./cloudSqlProxy";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_PROJECT_ID = "zkvote-prod-hhyyj";
const DEFAULT_SECRET_NAMES = {
    rpcUrl: "zkvote-prod-sepolia-rpc-url",
    databaseUrl: "zkvote-prod-readonly-database-url",
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

interface PreparedDatabaseUrl {
    url: string;
    connection: Json;
    cleanup?: () => Promise<void>;
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

function cloudSqlInstanceFromDatabaseUrl(databaseUrl: string): string | undefined {
    let parsed: URL;
    try {
        parsed = new URL(databaseUrl);
    } catch {
        return undefined;
    }
    const host = parsed.searchParams.get("host");
    if (!host?.startsWith("/cloudsql/")) return undefined;
    return host.slice("/cloudsql/".length);
}

function tcpDatabaseUrl(databaseUrl: string, port: number): string {
    const parsed = new URL(databaseUrl);
    parsed.hostname = "127.0.0.1";
    parsed.port = String(port);
    parsed.searchParams.delete("host");
    return parsed.toString();
}

async function waitForTcp(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await new Promise<void>((resolve, reject) => {
                const socket = net.createConnection({ host: "127.0.0.1", port });
                socket.once("connect", () => {
                    socket.destroy();
                    resolve();
                });
                socket.once("error", reject);
                socket.setTimeout(1_000, () => {
                    socket.destroy();
                    reject(new Error("tcp timeout"));
                });
            });
            return;
        } catch (error) {
            if (Date.now() >= deadline) {
                throw new Error(`Cloud SQL proxy did not become reachable on 127.0.0.1:${port}: ${String(error)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}

async function prepareDatabaseUrl(databaseUrl: string): Promise<PreparedDatabaseUrl> {
    const instance = cloudSqlInstanceFromDatabaseUrl(databaseUrl);
    if (!instance) return { url: databaseUrl, connection: { mode: "direct" } };
    if (fs.existsSync(`/cloudsql/${instance}`)) {
        return { url: databaseUrl, connection: { mode: "cloud-sql-socket", instance } };
    }

    const proxyBinary = prepareCloudSqlProxyBinary();
    const proxyBin = proxyBinary.path;
    const proxyPort = Number(optionalEnv("RECONCILE_CLOUD_SQL_PROXY_PORT") ?? "5435");
    assert(Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort < 65536, "invalid proxy port");

    let proxyOutput = "";
    const proxy = spawn(proxyBin, ["--address", "127.0.0.1", "--port", String(proxyPort), instance], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    proxy.stdout.on("data", (chunk) => {
        proxyOutput += String(chunk);
    });
    proxy.stderr.on("data", (chunk) => {
        proxyOutput += String(chunk);
    });
    const exitBeforeReady = new Promise<never>((_resolve, reject) => {
        proxy.once("exit", (code, signal) => {
            reject(new Error(`Cloud SQL proxy exited before ready (code=${code}, signal=${signal}): ${proxyOutput.trim()}`));
        });
    });
    await Promise.race([waitForTcp(proxyPort, 15_000), exitBeforeReady]);
    return {
        url: tcpDatabaseUrl(databaseUrl, proxyPort),
        connection: { mode: "cloud-sql-proxy", instance, proxyPort },
        cleanup: async () => {
            await new Promise<void>((resolve) => {
                let settled = false;
                let timer: NodeJS.Timeout;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    proxy.stdout.destroy();
                    proxy.stderr.destroy();
                    resolve();
                };
                timer = setTimeout(() => {
                    proxy.kill("SIGKILL");
                    finish();
                }, 2_000);
                proxy.once("exit", finish);
                if (proxy.exitCode !== null || proxy.signalCode !== null) {
                    finish();
                    return;
                }
                proxy.kill("SIGTERM");
            });
            proxyBinary.cleanup?.();
        },
    };
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

async function readElections(databaseUrl: string): Promise<ElectionRow[]> {
    const client = new Client({
        connectionString: databaseUrl,
        ssl: process.env.E2E_DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    try {
        const result = await client.query<ElectionRow>(
            `SELECT
                e.id::text,
                e.name,
                e.num_candidates,
                e.contract_address,
                e.completed,
                COUNT(vs.*) FILTER (WHERE vs.status = 'confirmed')::text AS confirmed_votes,
                COALESCE(
                    ARRAY_REMOVE(
                        ARRAY_AGG(vs.nullifier_hash ORDER BY vs.created_at)
                            FILTER (WHERE vs.status = 'confirmed'),
                        NULL
                    ),
                    ARRAY[]::text[]
                ) AS nullifiers
             FROM elections e
             LEFT JOIN vote_submissions vs ON vs.election_id = e.id
             WHERE e.contract_address IS NOT NULL
               AND e.superseded_at IS NULL
             GROUP BY e.id, e.name, e.num_candidates, e.contract_address, e.completed
             ORDER BY e.created_at DESC`
        );
        return result.rows;
    } finally {
        await client.end();
    }
}

function readElectionsFromEnv(): ElectionRow[] | undefined {
    const raw = optionalEnv("RECONCILE_ROWS_JSON");
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as ElectionRow[];
    assert(Array.isArray(parsed), "RECONCILE_ROWS_JSON must be a JSON array");
    return parsed;
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
    let cleanup: (() => Promise<void>) | undefined;

    try {
        const rpcUrl = await envOrSecret(projectId, "SEPOLIA_RPC_URL", DEFAULT_SECRET_NAMES.rpcUrl);
        const chainIdHex = await rpc<string>(rpcUrl, "eth_chainId", []);
        const chainId = BigInt(chainIdHex).toString();
        assert(chainId === EXPECTED_CHAIN_ID_DECIMAL, `RPC chain id ${chainId} != ${EXPECTED_CHAIN_ID_DECIMAL}`);

        let dbConnection: Json;
        const envRows = readElectionsFromEnv();
        let elections: ElectionRow[];
        if (envRows) {
            elections = envRows;
            dbConnection = { mode: "env-rows" };
        } else {
            const rawDatabaseUrl = await envOrSecret(
                projectId,
                "E2E_DATABASE_URL",
                DEFAULT_SECRET_NAMES.databaseUrl
            );
            const preparedDb = await prepareDatabaseUrl(rawDatabaseUrl);
            cleanup = preparedDb.cleanup;
            elections = await readElections(preparedDb.url);
            dbConnection = preparedDb.connection;
        }
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
    } finally {
        await cleanup?.();
    }
}

void main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
