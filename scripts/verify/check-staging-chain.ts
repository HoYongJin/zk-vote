#!/usr/bin/env tsx
/**
 * Read-only staging chain/key gate.
 *
 * Reads staging secrets in-process, derives public addresses without placing
 * private keys on child-process argv, and verifies Sepolia chain id plus owner /
 * relayer balances. Evidence intentionally contains only public data.
 */
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { keccak256 } from "@ethersproject/keccak256";
import { SigningKey } from "@ethersproject/signing-key";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_PROJECT_ID = "zkvote-staging-hhyyj";
const EXPECTED_CHAIN_ID_DECIMAL = "11155111";
const DEFAULT_SECRET_NAMES = {
    rpcUrl: "zkvote-staging-sepolia-rpc-url",
    relayerPrivateKey: "zkvote-staging-relayer-private-key",
    ownerPrivateKey: "zkvote-staging-owner-private-key",
} as const;

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

function normalizePrivateKey(key: string): string {
    const trimmed = key.trim();
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    assert(/^[0-9a-fA-F]{64}$/.test(hex), "private key must be 32-byte hex");
    return `0x${hex}`;
}

function addressForPrivateKey(privateKey: string): string {
    const publicKey = new SigningKey(normalizePrivateKey(privateKey)).publicKey;
    const digest = keccak256(`0x${publicKey.slice(4)}`);
    return `0x${digest.slice(-40)}`.toLowerCase();
}

function parseEtherDecimal(value: string): bigint {
    const trimmed = value.trim();
    assert(/^\d+(\.\d{1,18})?$/.test(trimmed), `invalid ETH decimal: ${value}`);
    const [whole, fraction = ""] = trimmed.split(".");
    return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}

function formatEther(wei: bigint): string {
    const whole = wei / 10n ** 18n;
    const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
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

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", DEFAULT_PROJECT_ID);
    const evidencePath =
        optionalEnv("CHAIN_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `staging-chain-${runId}.json`);
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
        const [rpcUrl, relayerPrivateKey, ownerPrivateKey] = await Promise.all([
            envOrSecret(projectId, "SEPOLIA_RPC_URL", DEFAULT_SECRET_NAMES.rpcUrl),
            envOrSecret(projectId, "RELAYER_PRIVATE_KEY", DEFAULT_SECRET_NAMES.relayerPrivateKey),
            envOrSecret(projectId, "OWNER_PRIVATE_KEY", DEFAULT_SECRET_NAMES.ownerPrivateKey),
        ]);
        const relayerAddress = addressForPrivateKey(relayerPrivateKey);
        const ownerAddress = addressForPrivateKey(ownerPrivateKey);
        assert(ownerAddress !== relayerAddress, "OWNER_PRIVATE_KEY and RELAYER_PRIVATE_KEY derive to the same address");

        const chainIdHex = await rpc<string>(rpcUrl, "eth_chainId", []);
        const chainId = BigInt(chainIdHex).toString();
        assert(chainId === EXPECTED_CHAIN_ID_DECIMAL, `RPC chain id ${chainId} != ${EXPECTED_CHAIN_ID_DECIMAL}`);

        const [relayerBalanceHex, ownerBalanceHex] = await Promise.all([
            rpc<string>(rpcUrl, "eth_getBalance", [relayerAddress, "latest"]),
            rpc<string>(rpcUrl, "eth_getBalance", [ownerAddress, "latest"]),
        ]);
        const relayerBalanceWei = BigInt(relayerBalanceHex);
        const ownerBalanceWei = BigInt(ownerBalanceHex);
        const relayerMinWei = parseEtherDecimal(optionalEnv("RELAYER_MIN_ETH") ?? "0.05");
        const ownerMinWei = parseEtherDecimal(optionalEnv("OWNER_MIN_ETH") ?? "0.01");
        assert(
            relayerBalanceWei >= relayerMinWei,
            `relayer balance ${formatEther(relayerBalanceWei)} ETH < ${formatEther(relayerMinWei)} ETH`
        );
        assert(
            ownerBalanceWei >= ownerMinWei,
            `owner balance ${formatEther(ownerBalanceWei)} ETH < ${formatEther(ownerMinWei)} ETH`
        );

        evidence.checks = {
            chainId,
            relayer: {
                address: relayerAddress,
                balanceEth: formatEther(relayerBalanceWei),
                minEth: formatEther(relayerMinWei),
            },
            owner: {
                address: ownerAddress,
                balanceEth: formatEther(ownerBalanceWei),
                minEth: formatEther(ownerMinWei),
            },
            keySeparation: true,
        };
        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`staging chain check PASSED; evidence=${evidencePath}`);
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
