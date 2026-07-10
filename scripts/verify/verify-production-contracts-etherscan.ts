#!/usr/bin/env tsx
/**
 * Post-deploy Etherscan source verification for Rust/alloy deployments.
 *
 * The production API deploys contracts directly from bytecode, not through a
 * Foundry script, so Foundry's `--verify` flag cannot be attached to the send.
 * This operator gate reconstructs the deployed contract identifiers and
 * constructor args from DB state, then submits source verification with
 * `forge verify-contract`.
 */
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { keccak256 } from "@ethersproject/keccak256";
import { SigningKey } from "@ethersproject/signing-key";
import { runProductionDbReadbackJob } from "./productionDbReadbackJob";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), override: false, quiet: true });
const DEFAULT_SECRET_NAMES = {
    etherscanApiKey: "zkvote-prod-etherscan-api-key",
    ownerPrivateKey: "zkvote-prod-owner-private-key",
} as const;

type Json = Record<string, unknown>;

interface DeploymentRow {
    id: string;
    name: string;
    merkle_tree_depth: number;
    num_candidates: number;
    contract_address: string;
    verifier_address: string;
    deploy_tx_hash: string | null;
    chain_id: string | null;
    zk_artifact_id: string | null;
    verifier_num_candidates: number | null;
}

interface VerifyResult {
    label: string;
    address: string;
    contract: string;
    status: "passed" | "already_verified";
    stdout: string;
    stderr: string;
}

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    command: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    chain: string;
    checks: Record<string, unknown>;
    results: VerifyResult[];
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

function redact(text: string, secrets: string[]): string {
    let output = text;
    for (const secret of secrets) {
        if (secret) output = output.split(secret).join("[redacted]");
    }
    return output;
}

async function run(
    command: string,
    args: string[],
    options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; secrets?: string[] } = {}
): Promise<{ stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execFile(command, args, {
            cwd: PROJECT_ROOT,
            env: { ...process.env, ...options.env },
            timeout: options.timeoutMs ?? 60_000,
            maxBuffer: 8 * 1024 * 1024,
        });
        return {
            stdout: redact(stdout.trim(), options.secrets ?? []),
            stderr: redact(stderr.trim(), options.secrets ?? []),
        };
    } catch (error) {
        const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        const stdout = redact(String(err.stdout ?? "").trim(), options.secrets ?? []);
        const stderr = redact(String(err.stderr ?? err.message ?? "").trim(), options.secrets ?? []);
        throw new Error(`${command} failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
}

async function secretValue(projectId: string, secretName: string): Promise<string | undefined> {
    try {
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
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

async function envOrSecret(
    projectId: string,
    envName: string,
    defaultSecretName?: string
): Promise<string> {
    const direct = optionalEnv(envName);
    if (direct) return direct;
    const secretName = optionalEnv(`${envName}_SECRET`) ?? defaultSecretName;
    if (secretName) {
        const value = await secretValue(projectId, secretName);
        if (value) return value;
    }
    throw new Error(`Set ${envName}${secretName ? ` or create Secret Manager secret ${secretName}` : ""}`);
}

async function readDeployment(projectId: string, region: string): Promise<{ row: DeploymentRow; connection: Json }> {
    const electionId = optionalEnv("VERIFY_ELECTION_ID") ?? optionalEnv("ELECTION_ID");
    const electionName = optionalEnv("VERIFY_ELECTION_NAME");
    assert(!electionName || electionId, "VERIFY_ELECTION_NAME requires VERIFY_ELECTION_ID for production DB readback");
    const readback = await runProductionDbReadbackJob({
        projectId,
        region,
        mode: electionId ? "deployment" : "latest-deployment",
        electionId,
    });
    assert(readback.result && typeof readback.result === "object", "deployment DB readback returned malformed JSON");
    const row = readback.result as DeploymentRow;
    assert(row.id, `No deployed election found for ${electionId ? `id=${electionId}` : "latest deployment"}`);
    if (electionName) assert(row.name === electionName, `deployment name ${row.name} != ${electionName}`);
    return {
        row,
        connection: { mode: "cloud-run-job", job: readback.job, execution: readback.execution },
    };
}

function electionIdField(electionId: string): string {
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(electionId), `invalid election UUID: ${electionId}`);
    return BigInt(`0x${electionId.replace(/-/g, "")}`).toString();
}

function deploymentFromEnv(): DeploymentRow | undefined {
    const id = optionalEnv("VERIFY_ELECTION_ID") ?? optionalEnv("ELECTION_ID");
    const contractAddress = optionalEnv("VERIFY_CONTRACT_ADDRESS");
    const verifierAddress = optionalEnv("VERIFY_VERIFIER_ADDRESS");
    const merkleTreeDepth = optionalEnv("VERIFY_MERKLE_TREE_DEPTH");
    const numCandidates = optionalEnv("VERIFY_NUM_CANDIDATES");
    if (!id || !contractAddress || !verifierAddress || !merkleTreeDepth || !numCandidates) {
        return undefined;
    }
    return {
        id,
        name: optionalEnv("VERIFY_ELECTION_NAME") ?? id,
        merkle_tree_depth: Number(merkleTreeDepth),
        num_candidates: Number(numCandidates),
        contract_address: contractAddress,
        verifier_address: verifierAddress,
        deploy_tx_hash: optionalEnv("VERIFY_DEPLOY_TX_HASH") ?? null,
        chain_id: optionalEnv("VERIFY_DEPLOY_CHAIN_ID") ?? null,
        zk_artifact_id: optionalEnv("VERIFY_ZK_ARTIFACT_ID") ?? null,
        verifier_num_candidates: optionalEnv("VERIFY_VERIFIER_WIDTH")
            ? Number(optionalEnv("VERIFY_VERIFIER_WIDTH"))
            : null,
    };
}

function addressForPrivateKey(privateKey: string): string {
    const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    assert(/^0x[0-9a-fA-F]{64}$/.test(normalized), "OWNER_PRIVATE_KEY must be a 32-byte hex private key");
    const publicKey = new SigningKey(normalized).publicKey;
    const publicKeyWithoutPrefix = `0x${publicKey.slice(4)}`;
    return `0x${keccak256(publicKeyWithoutPrefix).slice(-40)}`.toLowerCase();
}

async function contractIsVerified(address: string, apiKey: string, chainId: string): Promise<boolean> {
    const url = new URL("https://api.etherscan.io/v2/api");
    url.searchParams.set("chainid", chainId);
    url.searchParams.set("module", "contract");
    url.searchParams.set("action", "getsourcecode");
    url.searchParams.set("address", address);
    url.searchParams.set("apikey", apiKey);
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        Number(env("ETHERSCAN_STATUS_TIMEOUT_MS", "30000"))
    );
    try {
        const response = await fetch(url, { signal: controller.signal });
        const body = (await response.json()) as { result?: Array<{ SourceCode?: string; ABI?: string }> };
        if (!response.ok) return false;
        const first = body.result?.[0];
        return Boolean(first?.SourceCode || (first?.ABI && first.ABI !== "Contract source code not verified"));
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

function alreadyVerifiedOutput(text: string): boolean {
    return /already verified|source code already verified|already has verified source/i.test(text);
}

async function forgeVerify(
    label: string,
    address: string,
    contract: string,
    apiKey: string,
    chain: string,
    chainId: string,
    args: string[],
    secrets: string[]
): Promise<VerifyResult> {
    if (await contractIsVerified(address, apiKey, chainId)) {
        return {
            label,
            address,
            contract,
            status: "already_verified",
            stdout: "Etherscan getsourcecode reports verified source.",
            stderr: "",
        };
    }

    const verifyArgs = [
        "verify-contract",
        "--chain",
        chain,
        "--verifier",
        "etherscan",
        "--root",
        PROJECT_ROOT,
        "--watch",
        "--retries",
        env("ETHERSCAN_VERIFY_RETRIES", "12"),
        "--delay",
        env("ETHERSCAN_VERIFY_DELAY_SECONDS", "15"),
        address,
        contract,
        ...args,
    ];
    const rpcUrl = optionalEnv("SEPOLIA_RPC_URL") ?? optionalEnv("ETH_RPC_URL");
    if (rpcUrl) {
        secrets.push(rpcUrl);
        verifyArgs.splice(10, 0, "--rpc-url", rpcUrl);
    }

    try {
        const output = await run("forge", verifyArgs, {
            timeoutMs: Number(env("ETHERSCAN_VERIFY_TIMEOUT_MS", "600000")),
            env: { ETHERSCAN_API_KEY: apiKey },
            secrets,
        });
        return {
            label,
            address,
            contract,
            status: alreadyVerifiedOutput(`${output.stdout}\n${output.stderr}`) ? "already_verified" : "passed",
            stdout: output.stdout,
            stderr: output.stderr,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (alreadyVerifiedOutput(message) || await contractIsVerified(address, apiKey, chainId)) {
            return {
                label,
                address,
                contract,
                status: "already_verified",
                stdout: redact(message, secrets),
                stderr: "",
            };
        }
        throw error;
    }
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", "zkvote-prod-hhyyj");
    const region = env("GCP_REGION", "asia-northeast3");
    const chain = env("ETHERSCAN_CHAIN", "sepolia");
    const expectedChainId = env("CHAIN_ID", "11155111");
    const evidencePath =
        optionalEnv("ETHERSCAN_VERIFY_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `etherscan-verify-${runId}.json`);
    const evidence: Evidence = {
        status: "running",
        runId,
        command: invocation(),
        startedAt: new Date().toISOString(),
        projectId,
        chain,
        checks: {},
        results: [],
        caveats: [
            "This verifies source code after Rust/alloy deployment; it does not authorize deployment or change deployed bytecode.",
        ],
    };
    writeEvidence(evidencePath, evidence);

    try {
        const [apiKey, ownerPrivateKey] = await Promise.all([
            envOrSecret(projectId, "ETHERSCAN_API_KEY", optionalEnv("ETHERSCAN_API_KEY_SECRET") ?? DEFAULT_SECRET_NAMES.etherscanApiKey),
            envOrSecret(projectId, "OWNER_PRIVATE_KEY", optionalEnv("OWNER_PRIVATE_KEY_SECRET") ?? DEFAULT_SECRET_NAMES.ownerPrivateKey),
        ]);
        const secrets = [apiKey, ownerPrivateKey];
        const envDeployment = deploymentFromEnv();
        let deployment: DeploymentRow;
        let dbConnection: Json | undefined;
        if (envDeployment) {
            deployment = envDeployment;
            dbConnection = { mode: "env-override" };
        } else {
            const readback = await readDeployment(projectId, region);
            deployment = readback.row;
            dbConnection = readback.connection;
        }
        assert(deployment.chain_id === null || deployment.chain_id === expectedChainId, `deployment chain_id ${deployment.chain_id} != expected ${expectedChainId}`);
        assert(/^0x[0-9a-fA-F]{40}$/.test(deployment.contract_address), `invalid contract_address: ${deployment.contract_address}`);
        assert(/^0x[0-9a-fA-F]{40}$/.test(deployment.verifier_address), `invalid verifier_address: ${deployment.verifier_address}`);
        assert(Number.isInteger(deployment.merkle_tree_depth) && deployment.merkle_tree_depth > 0, "invalid merkle_tree_depth");
        assert(Number.isInteger(deployment.num_candidates) && deployment.num_candidates > 0, "invalid num_candidates");
        const verifierWidth = deployment.verifier_num_candidates ?? 10;
        const verifierName = `Groth16Verifier_${deployment.merkle_tree_depth}_${verifierWidth}`;
        const verifierFile = path.join(PROJECT_ROOT, "contracts", `${verifierName}.sol`);
        const tallyFile = path.join(PROJECT_ROOT, "contracts", "VotingTally.sol");
        assert(fs.existsSync(verifierFile), `missing verifier source ${path.relative(PROJECT_ROOT, verifierFile)}`);
        assert(fs.existsSync(tallyFile), "missing contracts/VotingTally.sol");

        if (optionalEnv("ETHERSCAN_SKIP_FORGE_BUILD") !== "yes") {
            const build = await run("forge", ["build"], { timeoutMs: 120_000, secrets });
            evidence.checks.forgeBuild = { stdout: build.stdout, stderr: build.stderr };
        }

        const ownerAddress = addressForPrivateKey(ownerPrivateKey);
        const electionField = electionIdField(deployment.id);
        const constructorArgs = (await run(
            "cast",
            [
                "abi-encode",
                "constructor(address,uint256,uint256,address)",
                deployment.verifier_address,
                electionField,
                String(deployment.num_candidates),
                ownerAddress,
            ],
            { timeoutMs: 30_000, secrets }
        )).stdout.trim();
        assert(/^0x[0-9a-fA-F]+$/.test(constructorArgs), "cast returned invalid constructor args");

        evidence.checks.deployment = {
            dbConnection,
            electionId: deployment.id,
            electionName: deployment.name,
            merkleTreeDepth: deployment.merkle_tree_depth,
            numCandidates: deployment.num_candidates,
            verifierWidth,
            contractAddress: deployment.contract_address,
            verifierAddress: deployment.verifier_address,
            deployTxHash: deployment.deploy_tx_hash,
            chainId: deployment.chain_id,
            zkArtifactId: deployment.zk_artifact_id,
            ownerAddress,
            electionIdField: electionField,
        };
        writeEvidence(evidencePath, evidence);

        const verifierContract = `contracts/${verifierName}.sol:${verifierName}`;
        const tallyContract = "contracts/VotingTally.sol:VotingTally";
        evidence.results.push(await forgeVerify(
            "verifier",
            deployment.verifier_address,
            verifierContract,
            apiKey,
            chain,
            expectedChainId,
            [],
            secrets
        ));
        writeEvidence(evidencePath, evidence);

        const tallyArgs = ["--constructor-args", constructorArgs];
        if (deployment.deploy_tx_hash && /^0x[0-9a-fA-F]{64}$/.test(deployment.deploy_tx_hash)) {
            tallyArgs.push("--creation-transaction-hash", deployment.deploy_tx_hash);
        }
        evidence.results.push(await forgeVerify(
            "voting_tally",
            deployment.contract_address,
            tallyContract,
            apiKey,
            chain,
            expectedChainId,
            tallyArgs,
            secrets
        ));

        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`etherscan contract verification PASSED; evidence=${evidencePath}`);
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
