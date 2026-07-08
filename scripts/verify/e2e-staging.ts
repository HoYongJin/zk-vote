#!/usr/bin/env tsx
/**
 * Full staging E2E gate for an already-deployed zk-vote Cloud Run API.
 *
 * This script intentionally drives the public API for the election/vote flow.
 * Direct DB access is used only for readback evidence. The first superadmin
 * bootstrap is handled by bootstrap-staging-superadmin.sh.
 */
import { execFile as execFileCallback, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import {
    formatProofForSolidity,
    fullProve,
    poseidonHash,
    verifyProof,
} from "../../test/helpers/zkProof";
import { prepareCloudSqlProxyBinary } from "./cloudSqlProxy";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_PROJECT_ID = "zkvote-staging-hhyyj";
const DEFAULT_REGION = "asia-northeast3";
const DEFAULT_SERVICE = "zkvote-staging-api";
const DEFAULT_SECRET_NAMES = {
    firebaseApiKey: "zkvote-staging-firebase-web-api-key",
    superadminEmail: "zkvote-staging-e2e-superadmin-email",
    superadminPassword: "zkvote-staging-e2e-superadmin-password",
    voterEmail: "zkvote-staging-e2e-voter-email",
    voterPassword: "zkvote-staging-e2e-voter-password",
    sepoliaRpcUrl: "zkvote-staging-sepolia-rpc-url",
    databaseUrl: "zkvote-staging-readonly-database-url",
} as const;
const CHAIN_ID = "11155111";
const CIRCUIT_DEPTH = 4;
const CIRCUIT_WIDTH = 10;
const CANDIDATE_INDEX = 0;

type Json = Record<string, unknown>;

interface ApiResult<T> {
    status: number;
    json: T;
    text: string;
}

interface FirebaseSession {
    idToken: string;
    uid: string;
    email: string;
    emailVerified: boolean | "absent";
    userMetadataEmailVerified: boolean | "absent";
}

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    command: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    region: string;
    service: string;
    baseUrl: string;
    checks: Record<string, unknown>;
    caveats: string[];
    failure?: string;
}

interface PreparedDatabaseUrl {
    url: string;
    connection: Json;
    cleanup?: () => Promise<void>;
}

function env(name: string, fallback?: string): string {
    const value = process.env[name]?.trim();
    if (value) return value;
    if (fallback !== undefined) return fallback;
    throw new Error(`Set ${name}`);
}

function optionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value
    );
}

function sha256File(filePath: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

function randomFieldSecret(): string {
    for (;;) {
        const value = BigInt(`0x${crypto.randomBytes(31).toString("hex")}`);
        if (value > 0n) return value.toString();
    }
}

function decodeJwtPayload(token: string): Json {
    const payload = token.split(".")[1];
    assert(payload, "JWT payload segment is missing");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Json;
}

function electionIdField(electionId: string): string {
    return BigInt(`0x${electionId.replace(/-/g, "")}`).toString();
}

async function firebaseSignIn(apiKey: string, email: string, password: string): Promise<FirebaseSession> {
    const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
        }
    );
    const body = (await response.json()) as Json;
    if (!response.ok) {
        throw new Error(`Firebase sign-in failed for ${email}: ${JSON.stringify(body)}`);
    }

    const idToken = String(body.idToken ?? "");
    const uid = String(body.localId ?? "");
    const normalizedEmail = String(body.email ?? email).trim().toLowerCase();
    assert(idToken, `Firebase sign-in for ${email} returned no idToken`);
    assert(uid, `Firebase sign-in for ${email} returned no localId`);

    const claims = decodeJwtPayload(idToken);
    const emailVerified =
        typeof claims.email_verified === "boolean" ? claims.email_verified : "absent";
    const metadata = claims.user_metadata;
    const userMetadataEmailVerified =
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        typeof (metadata as Json).email_verified === "boolean"
            ? ((metadata as Json).email_verified as boolean)
            : "absent";

    return {
        idToken,
        uid,
        email: normalizedEmail,
        emailVerified,
        userMetadataEmailVerified,
    };
}

function apiBase(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, "")}/api`;
}

async function apiRequest<T extends Json | Json[]>(
    baseUrl: string,
    method: string,
    apiPath: string,
    options: {
        token?: string;
        body?: unknown;
        expected?: number[];
        anonymous?: boolean;
    } = {}
): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) {
        headers["content-type"] = "application/json";
    }
    if (options.token) {
        if (options.anonymous) {
            throw new Error("anonymous API request cannot carry a bearer token");
        }
        headers.authorization = `Bearer ${options.token}`;
    }
    if (options.anonymous && "authorization" in headers) {
        throw new Error("anonymous API request accidentally includes authorization");
    }

    const response = await fetch(`${apiBase(baseUrl)}${apiPath}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as T) : ({} as T);
    const expected = options.expected ?? [200];
    if (!expected.includes(response.status)) {
        throw new Error(`${method} ${apiPath} returned ${response.status}: ${text}`);
    }
    return { status: response.status, json: parsed, text };
}

async function cast(args: string[]): Promise<string> {
    const { stdout } = await execFile("cast", args, { maxBuffer: 1024 * 1024 });
    return stdout.trim();
}

async function gcloudJson(args: string[]): Promise<Json> {
    const { stdout } = await execFile("gcloud", [...args, "--format=json"], {
        maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout) as Json;
}

async function gcloudText(args: string[]): Promise<string> {
    const { stdout } = await execFile("gcloud", args, { maxBuffer: 1024 * 1024 });
    return stdout.trim();
}

async function secretValue(projectId: string, secretName: string): Promise<string> {
    return gcloudText([
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret",
        secretName,
        "--project",
        projectId,
    ]);
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

async function optionalEnvOrSecret(
    projectId: string,
    envName: string,
    defaultSecretName: string
): Promise<string | undefined> {
    const direct = optionalEnv(envName);
    if (direct) return direct;
    const secretName = optionalEnv(`${envName}_SECRET`) ?? defaultSecretName;
    try {
        const value = await secretValue(projectId, secretName);
        return value || undefined;
    } catch (error) {
        if (optionalEnv(`${envName}_SECRET`)) throw error;
        return undefined;
    }
}

function serviceMaxScale(service: Json): string | undefined {
    const spec = service.spec as Json | undefined;
    const template = spec?.template as Json | undefined;
    const metadata = template?.metadata as Json | undefined;
    const annotations = metadata?.annotations as Json | undefined;
    const v1 = annotations?.["autoscaling.knative.dev/maxScale"];
    if (typeof v1 === "string") return v1;

    const v2Template = service.template as Json | undefined;
    const scaling = v2Template?.scaling as Json | undefined;
    const maxInstanceCount = scaling?.maxInstanceCount;
    if (typeof maxInstanceCount === "number" || typeof maxInstanceCount === "string") {
        return String(maxInstanceCount);
    }
    return undefined;
}

async function verifyCloudRunScale(projectId: string, region: string, service: string): Promise<string> {
    const described = await gcloudJson([
        "run",
        "services",
        "describe",
        service,
        "--project",
        projectId,
        "--region",
        region,
    ]);
    const maxScale = serviceMaxScale(described);
    assert(maxScale === "1", `Cloud Run maxScale must be 1, got ${maxScale ?? "(missing)"}`);
    return maxScale;
}

async function readDbEvidence(databaseUrl: string, electionId: string, nullifier: string): Promise<Json> {
    const client = new Client({
        connectionString: databaseUrl,
        ssl: process.env.E2E_DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    try {
        const election = await client.query(
            "SELECT id::text, state, completed, contract_address, verifier_address, merkle_root::text, voting_end_time FROM elections WHERE id = $1",
            [electionId]
        );
        const submissions = await client.query(
            "SELECT status, tx_hash FROM vote_submissions WHERE election_id = $1 AND nullifier_hash = $2",
            [electionId, nullifier]
        );
        assert(election.rowCount === 1, "DB readback did not find the test election");
        assert(submissions.rowCount === 1, "DB readback did not find exactly one vote submission");
        return {
            election: election.rows[0] as Json,
            voteSubmission: submissions.rows[0] as Json,
        };
    } finally {
        await client.end();
    }
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
                throw new Error(
                    `Cloud SQL proxy did not become reachable on 127.0.0.1:${port}: ${String(error)}`
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}

async function prepareDatabaseUrl(databaseUrl: string): Promise<PreparedDatabaseUrl> {
    const instance = cloudSqlInstanceFromDatabaseUrl(databaseUrl);
    if (!instance) {
        return { url: databaseUrl, connection: { mode: "direct" } };
    }

    const socketDir = `/cloudsql/${instance}`;
    if (fs.existsSync(socketDir)) {
        return { url: databaseUrl, connection: { mode: "cloud-sql-socket", instance } };
    }

    const proxyBinary = prepareCloudSqlProxyBinary();
    const proxyBin = proxyBinary.path;
    const proxyPort = Number(optionalEnv("E2E_CLOUD_SQL_PROXY_PORT") ?? "5434");
    assert(
        Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort < 65536,
        "E2E_CLOUD_SQL_PROXY_PORT must be a valid TCP port"
    );

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
            reject(
                new Error(
                    `Cloud SQL proxy exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"}): ${proxyOutput.trim()}`
                )
            );
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

async function completeAfterWindow(
    baseUrl: string,
    adminToken: string,
    electionId: string,
    voteEnd: Date,
    deadlineMs: number
): Promise<ApiResult<Json>> {
    for (;;) {
        const now = Date.now();
        if (now < voteEnd.getTime() + 5_000) {
            await new Promise((resolve) =>
                setTimeout(resolve, Math.min(5_000, voteEnd.getTime() + 5_000 - now))
            );
        }
        try {
            return await apiRequest<Json>(baseUrl, "POST", `/elections/${electionId}/complete`, {
                token: adminToken,
                expected: [200],
            });
        } catch (error) {
            if (Date.now() > deadlineMs || !String(error).includes("VOTING_PERIOD_ACTIVE")) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
    }
}

function writeEvidence(filePath: string, evidence: Evidence): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

function invocation(): string {
    return ["node", "--import", "tsx", path.relative(PROJECT_ROOT, fileURLToPath(import.meta.url))]
        .join(" ");
}

function lastNonEmptyLine(output: string): string {
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

async function maybeVerifyContractsOnEtherscan(
    evidence: Evidence,
    electionId: string,
    electionName: string
): Promise<void> {
    if (optionalEnv("ETHERSCAN_VERIFY_AFTER_DEPLOY") !== "true") return;
    const script = optionalEnv("ETHERSCAN_VERIFY_SCRIPT") ?? "scripts/verify/verify-contracts-etherscan.ts";
    const evidencePath =
        optionalEnv("ETHERSCAN_VERIFY_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `etherscan-verify-${evidence.runId}.json`);
    const { stdout, stderr } = await execFile(
        "node",
        ["--import", "tsx", script],
        {
            cwd: PROJECT_ROOT,
            timeout: Number(optionalEnv("ETHERSCAN_VERIFY_AFTER_DEPLOY_TIMEOUT_MS") ?? "900000"),
            maxBuffer: 8 * 1024 * 1024,
            env: {
                ...process.env,
                VERIFY_ELECTION_ID: electionId,
                VERIFY_ELECTION_NAME: electionName,
                ETHERSCAN_VERIFY_EVIDENCE_PATH: evidencePath,
            },
        }
    );
    evidence.checks.etherscanVerification = {
        status: "passed",
        evidence: path.relative(PROJECT_ROOT, evidencePath),
        stdout: lastNonEmptyLine(stdout),
        stderr: lastNonEmptyLine(stderr),
    };
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", DEFAULT_PROJECT_ID);
    const region = env("GCP_REGION", DEFAULT_REGION);
    const service = env("CLOUD_RUN_SERVICE", DEFAULT_SERVICE);
    const baseUrl = (optionalEnv("VERIFY_BASE_URL") ?? env("STAGING_BASE_URL")).replace(/\/$/, "");
    const artifactBucket = env("ARTIFACT_BUCKET", `zkvote-staging-artifacts-${projectId}`);
    const firebaseApiKey = await envOrSecret(
        projectId,
        "FIREBASE_WEB_API_KEY",
        DEFAULT_SECRET_NAMES.firebaseApiKey
    );
    const superadminEmail = await envOrSecret(
        projectId,
        "E2E_SUPERADMIN_EMAIL",
        DEFAULT_SECRET_NAMES.superadminEmail
    );
    const superadminPassword = await envOrSecret(
        projectId,
        "E2E_SUPERADMIN_PASSWORD",
        DEFAULT_SECRET_NAMES.superadminPassword
    );
    const voterEmail = await envOrSecret(projectId, "E2E_VOTER_EMAIL", DEFAULT_SECRET_NAMES.voterEmail);
    const voterPassword = await envOrSecret(
        projectId,
        "E2E_VOTER_PASSWORD",
        DEFAULT_SECRET_NAMES.voterPassword
    );
    const rpcUrl = await optionalEnvOrSecret(
        projectId,
        "SEPOLIA_RPC_URL",
        DEFAULT_SECRET_NAMES.sepoliaRpcUrl
    );
    const databaseUrl = await optionalEnvOrSecret(
        projectId,
        "E2E_DATABASE_URL",
        DEFAULT_SECRET_NAMES.databaseUrl
    );
    const evidencePath =
        optionalEnv("E2E_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `staging-e2e-${runId}.json`);
    const voteWindowSeconds = Number(optionalEnv("E2E_VOTE_WINDOW_SECONDS") ?? "300");
    const timeoutMs = Number(optionalEnv("E2E_TIMEOUT_MS") ?? String(8 * 60_000));
    const evidence: Evidence = {
        status: "running",
        runId,
        command: invocation(),
        startedAt: new Date().toISOString(),
        projectId,
        region,
        service,
        baseUrl,
        checks: {},
        caveats: [],
    };
    let dbCleanup: (() => Promise<void>) | undefined;

    try {
        assert(
            Number.isFinite(voteWindowSeconds) && voteWindowSeconds >= 1,
            "E2E_VOTE_WINDOW_SECONDS must be a positive number"
        );
        assert(
            Number.isFinite(timeoutMs) && timeoutMs > voteWindowSeconds * 1000 + 30_000,
            "E2E_TIMEOUT_MS must exceed the vote window by at least 30 seconds"
        );

        evidence.checks.readyz = await fetch(`${baseUrl}/readyz`).then((r) => r.status);
        assert(evidence.checks.readyz === 200, `/readyz must return 200`);

        const maxScale = await verifyCloudRunScale(projectId, region, service);
        evidence.checks.cloudRun = { service, maxScale };

        if (!rpcUrl) {
            if (process.env.ALLOW_ONCHAIN_READBACK_SKIP === "yes") {
                evidence.caveats.push("SEPOLIA_RPC_URL absent; independent cast readback skipped.");
            } else {
                throw new Error("Set SEPOLIA_RPC_URL for independent on-chain readback.");
            }
        } else {
            const liveChainId = await cast(["chain-id", "--rpc-url", rpcUrl]);
            assert(liveChainId === CHAIN_ID, `SEPOLIA_RPC_URL chain id ${liveChainId} != ${CHAIN_ID}`);
            evidence.checks.chain = { chainId: liveChainId };
        }

        const [admin, voter] = await Promise.all([
            firebaseSignIn(firebaseApiKey, superadminEmail, superadminPassword),
            firebaseSignIn(firebaseApiKey, voterEmail, voterPassword),
        ]);
        evidence.checks.gcip = {
            adminProviderUid: admin.uid,
            voterProviderUid: voter.uid,
            adminEmailVerified: admin.emailVerified,
            voterEmailVerified: voter.emailVerified,
            adminUserMetadataEmailVerified: admin.userMetadataEmailVerified,
            voterUserMetadataEmailVerified: voter.userMetadataEmailVerified,
        };

        const adminMe = await apiRequest<Json>(baseUrl, "GET", "/me", {
            token: admin.idToken,
        });
        const voterMe = await apiRequest<Json>(baseUrl, "GET", "/me", {
            token: voter.idToken,
        });
        assert(adminMe.json.is_admin === true, "superadmin token is not admin according to /api/me");
        assert(
            adminMe.json.is_superadmin === true,
            "superadmin token is not superadmin according to /api/me"
        );
        assert(voterMe.json.is_admin === false, "voter test account unexpectedly has admin role");
        evidence.checks.roles = {
            admin: adminMe.json,
            voter: voterMe.json,
            adminProviderUid: admin.uid,
            voterProviderUid: voter.uid,
        };

        const rel = {
            wasm: "build_4_10/VoteCheck_temp_js/VoteCheck_temp.wasm",
            zkey: "build_4_10/circuit_final.zkey",
            vk: "build_4_10/verification_key.json",
        };
        const artifactHashes = {
            wasmSha256: sha256File(path.join(PROJECT_ROOT, "zk", rel.wasm)),
            zkeySha256: sha256File(path.join(PROJECT_ROOT, "zk", rel.zkey)),
            verificationKeySha256: sha256File(path.join(PROJECT_ROOT, "zk", rel.vk)),
        };
        const artifact = await apiRequest<Json>(baseUrl, "POST", "/admin/zk-artifacts", {
            token: admin.idToken,
            expected: [201],
            body: {
                circuitId: "votecheck",
                version: `staging-e2e-${runId}`,
                merkleTreeDepth: CIRCUIT_DEPTH,
                numCandidates: CIRCUIT_WIDTH,
                wasmUri: `gs://${artifactBucket}/${rel.wasm}`,
                zkeyUri: `gs://${artifactBucket}/${rel.zkey}`,
                verificationKeyUri: `gs://${artifactBucket}/${rel.vk}`,
                solidityVerifierUri: "contracts/Groth16Verifier_4_10.sol",
                manifest: {
                    ...artifactHashes,
                    wasmPath: `/api/zkp-files/${rel.wasm}`,
                    zkeyPath: `/api/zkp-files/${rel.zkey}`,
                    publicSignalCount: 4,
                    publicSignals: ["root", "candidateIndex", "nullifierHash", "election_id"],
                },
            },
        });
        evidence.checks.artifactRegistration = {
            artifactId: artifact.json.artifactId,
            ...artifactHashes,
        };

        const regEnd = new Date(Date.now() + 15 * 60_000);
        const electionName = `staging-e2e-${runId}`;
        const created = await apiRequest<Json>(baseUrl, "POST", "/elections/set", {
            token: admin.idToken,
            expected: [201],
            body: {
                name: electionName,
                merkleTreeDepth: CIRCUIT_DEPTH,
                candidates: ["E2E-A", "E2E-B"],
                regEndTime: regEnd.toISOString(),
            },
        });
        const election = created.json.election as Json | undefined;
        const electionId = String(election?.id ?? "");
        assert(isUuid(electionId), `create election returned invalid id: ${electionId}`);
        evidence.checks.election = { electionId };

        const secret = randomFieldSecret();
        const secretCommitment = await poseidonHash([secret]);
        const allowlist = await apiRequest<Json>(
            baseUrl,
            "POST",
            `/elections/${electionId}/voters`,
            {
                token: admin.idToken,
                body: { emails: [voter.email] },
            }
        );
        const registration = await apiRequest<Json>(
            baseUrl,
            "POST",
            `/elections/${electionId}/register`,
            {
                token: voter.idToken,
                body: { name: "Staging E2E Voter", secretCommitment },
            }
        );
        evidence.checks.registration = {
            allowlist: allowlist.json,
            voterRegistration: registration.json,
        };

        const deployment = await apiRequest<Json>(
            baseUrl,
            "POST",
            `/elections/${electionId}/setZkDeploy`,
            { token: admin.idToken }
        );
        const contractAddress = String(deployment.json.contractAddress ?? "");
        const deployTxHash = String(deployment.json.deployTxHash ?? "");
        assert(/^0x[0-9a-fA-F]{40}$/.test(contractAddress), "setZkDeploy returned invalid contract");
        assert(/^0x[0-9a-fA-F]{64}$/.test(deployTxHash), "setZkDeploy returned invalid deployTxHash");
        evidence.checks.deployment = deployment.json;
        await maybeVerifyContractsOnEtherscan(evidence, electionId, electionName);

        const voteEnd = new Date(Date.now() + voteWindowSeconds * 1000);
        const finalized = await apiRequest<Json>(
            baseUrl,
            "POST",
            `/elections/${electionId}/finalize`,
            {
                token: admin.idToken,
                body: { voteEndTime: voteEnd.toISOString() },
            }
        );
        evidence.checks.finalize = finalized.json;

        const proofData = await apiRequest<Json>(baseUrl, "POST", `/elections/${electionId}/proof`, {
            token: voter.idToken,
        });
        const pathElements = proofData.json.pathElements;
        const pathIndices = proofData.json.pathIndices;
        assert(Array.isArray(pathElements), "/proof pathElements is not an array");
        assert(Array.isArray(pathIndices), "/proof pathIndices is not an array");
        const vote = Array(CIRCUIT_WIDTH).fill(0);
        vote[CANDIDATE_INDEX] = 1;
        const proofInput = {
            root_in: String(proofData.json.root),
            user_secret: secret,
            vote,
            pathElements,
            pathIndices,
            election_id: electionIdField(electionId),
        };
        const { proof, publicSignals } = await fullProve(proofInput, CIRCUIT_DEPTH, CIRCUIT_WIDTH);
        assert(
            await verifyProof(publicSignals, proof, CIRCUIT_DEPTH, CIRCUIT_WIDTH),
            "fresh staging proof did not verify locally"
        );
        assert(Array.isArray(publicSignals) && publicSignals.length === 4, "proof emitted wrong public signal count");
        const nullifier = String(publicSignals[2]);
        const submitBody = {
            formattedProof: formatProofForSolidity(proof),
            publicSignals,
            submissionTicket: String(proofData.json.submissionTicket),
        };
        const submit = await apiRequest<Json>(
            baseUrl,
            "POST",
            `/elections/${electionId}/submit`,
            { body: submitBody, anonymous: true }
        );
        const submitTxHash = String(submit.json.transactionHash ?? "");
        assert(/^0x[0-9a-fA-F]{64}$/.test(submitTxHash), "submit returned invalid transactionHash");
        evidence.checks.submit = {
            anonymousAuthorizationHeader: "omitted",
            response: submit.json,
            nullifier,
        };

        const replay = await apiRequest<Json>(
            baseUrl,
            "POST",
            `/elections/${electionId}/submit`,
            {
                body: submitBody,
                anonymous: true,
                expected: [400, 403, 409],
            }
        );
        assert(replay.status !== 200, "replayed submission ticket unexpectedly succeeded");
        evidence.checks.ticketReplay = { status: replay.status, response: replay.json };

        if (rpcUrl) {
            const voteCount = await cast([
                "call",
                contractAddress,
                "voteCounts(uint256)(uint256)",
                String(CANDIDATE_INDEX),
                "--rpc-url",
                rpcUrl,
            ]);
            const nullifierUsed = await cast([
                "call",
                contractAddress,
                "usedNullifiers(uint256)(bool)",
                nullifier,
                "--rpc-url",
                rpcUrl,
            ]);
            assert(BigInt(voteCount) >= 1n, `on-chain voteCounts(${CANDIDATE_INDEX}) is ${voteCount}`);
            assert(nullifierUsed === "true", `on-chain nullifier was not marked used: ${nullifierUsed}`);
            evidence.checks.onchainReadback = { voteCount, nullifierUsed };
        }

        if (databaseUrl) {
            const preparedDb = await prepareDatabaseUrl(databaseUrl);
            dbCleanup = preparedDb.cleanup;
            evidence.checks.dbConnection = preparedDb.connection;
            evidence.checks.dbReadback = await readDbEvidence(preparedDb.url, electionId, nullifier);
        } else if (process.env.ALLOW_DB_READBACK_SKIP === "yes") {
            evidence.caveats.push("E2E_DATABASE_URL absent; DB readback skipped by ALLOW_DB_READBACK_SKIP=yes.");
        } else {
            throw new Error("Set E2E_DATABASE_URL for DB readback evidence.");
        }

        const completion = await completeAfterWindow(
            baseUrl,
            admin.idToken,
            electionId,
            voteEnd,
            Date.now() + timeoutMs
        );
        const completed = await apiRequest<Json[]>(baseUrl, "GET", "/elections/completed", {
            token: admin.idToken,
        });
        assert(
            completed.json.some((row) => String(row.id) === electionId),
            "completed list does not include the test election"
        );
        evidence.checks.completion = { response: completion.json, completedListContainsElection: true };

        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`staging E2E PASSED; evidence=${evidencePath}`);
    } catch (error) {
        evidence.status = "failed";
        evidence.finishedAt = new Date().toISOString();
        evidence.failure = error instanceof Error ? error.message : String(error);
        writeEvidence(evidencePath, evidence);
        throw error;
    } finally {
        await dbCleanup?.();
    }
}

void main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
