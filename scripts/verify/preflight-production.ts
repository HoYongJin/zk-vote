#!/usr/bin/env tsx
/**
 * Read-only production preflight.
 */
import { execFile as execFileCallback } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const EXPECTED_CHAIN_ID = "11155111";

type Json = Record<string, unknown>;

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    region: string;
    checks: Record<string, unknown>;
    hardFailures: string[];
    caveats: string[];
}

function optionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

async function run(command: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execFile(command, args, {
            cwd: PROJECT_ROOT,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
        });
        return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
        const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        return {
            ok: false,
            stdout: String(err.stdout ?? "").trim(),
            stderr: String(err.stderr ?? err.message ?? "").trim(),
        };
    }
}

async function gcloudJson(args: string[]): Promise<Json | undefined> {
    const result = await run("gcloud", [...args, "--format=json"], 60_000);
    return result.ok ? (JSON.parse(result.stdout) as Json) : undefined;
}

async function secretValue(projectId: string, secretName: string): Promise<string | undefined> {
    const result = await run("gcloud", [
        "secrets",
        "versions",
        "access",
        "latest",
        "--secret",
        secretName,
        "--project",
        projectId,
    ]);
    return result.ok ? result.stdout : undefined;
}

async function secretHasVersion(projectId: string, secretName: string): Promise<boolean> {
    const result = await run("gcloud", [
        "secrets",
        "versions",
        "list",
        secretName,
        "--project",
        projectId,
        "--filter",
        "state:ENABLED",
        "--limit",
        "1",
        "--format=value(name)",
    ]);
    return result.ok && result.stdout.length > 0;
}

function addFail(evidence: Evidence, message: string): void {
    evidence.hardFailures.push(message);
}

function addCaveat(evidence: Evidence, message: string): void {
    evidence.caveats.push(message);
}

function sha256File(filePath: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

async function checkChain(evidence: Evidence): Promise<void> {
    const rpcUrl = await secretValue(evidence.projectId, "zkvote-prod-sepolia-rpc-url");
    if (!rpcUrl) {
        evidence.checks.chain = { status: "missing" };
        addFail(evidence, "zkvote-prod-sepolia-rpc-url is missing");
        return;
    }
    const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = (await response.json()) as { result?: string };
    const actual = body.result ? BigInt(body.result).toString() : "(unavailable)";
    evidence.checks.chain = { expected: EXPECTED_CHAIN_ID, actual };
    if (actual !== EXPECTED_CHAIN_ID) addFail(evidence, `Sepolia chain id must be ${EXPECTED_CHAIN_ID}, got ${actual}`);
}

function nested(value: unknown, pathParts: string[]): unknown {
    let current = value as Json | undefined;
    for (const part of pathParts) {
        if (!current || typeof current !== "object") return undefined;
        current = current[part] as Json | undefined;
    }
    return current;
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = optionalEnv("GCP_PROJECT_ID") ?? "zkvote-prod-hhyyj";
    const region = optionalEnv("GCP_REGION") ?? "asia-northeast3";
    const evidencePath = optionalEnv("PREFLIGHT_EVIDENCE_PATH")
        ?? path.join(PROJECT_ROOT, "docs", "evidence", `production-preflight-${runId}.json`);
    const evidence: Evidence = {
        status: "running",
        runId,
        startedAt: new Date().toISOString(),
        projectId,
        region,
        checks: {},
        hardFailures: [],
        caveats: [],
    };
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const requiredTools = ["gcloud", "node", "npm", "npx", "docker", "cast", "forge"];
    evidence.checks.tools = Object.fromEntries(
        await Promise.all(requiredTools.map(async (tool) => {
            const result = await run("which", [tool], 5_000);
            if (!result.ok) addFail(evidence, `required tool missing: ${tool}`);
            return [tool, result.ok ? result.stdout : "missing"];
        }))
    );

    const project = await run("gcloud", ["projects", "describe", projectId, "--format=value(projectNumber)"]);
    evidence.checks.project = project.ok ? { status: "ok", projectNumber: project.stdout } : { status: "missing", error: project.stderr };
    if (!project.ok) addFail(evidence, `cannot describe production project ${projectId}`);

    const billing = await run("gcloud", ["billing", "projects", "describe", projectId, "--format=value(billingEnabled)"]);
    evidence.checks.billing = billing.ok ? { enabled: billing.stdout } : { status: "missing", error: billing.stderr };
    if (!billing.ok || !["True", "true"].includes(billing.stdout)) addFail(evidence, "production billing is not enabled");

    const secretNames = [
        "zkvote-prod-database-url",
        "zkvote-prod-migrator-database-url",
        "zkvote-prod-redis-url",
        "zkvote-prod-auth-jwks-url",
        "zkvote-prod-sepolia-rpc-url",
        "zkvote-prod-owner-private-key",
        "zkvote-prod-relayer-private-key",
        "zkvote-prod-artifact-bucket",
        "zkvote-prod-firebase-web-api-key",
        "zkvote-prod-e2e-superadmin-email",
        "zkvote-prod-e2e-superadmin-password",
        "zkvote-prod-e2e-voter-email",
        "zkvote-prod-e2e-voter-password",
    ];
    const secretChecks: Record<string, unknown> = {};
    for (const secretName of secretNames) {
        const ok = await secretHasVersion(projectId, secretName);
        secretChecks[secretName] = ok ? "enabled-version" : "missing";
        if (!ok) addFail(evidence, `missing enabled secret: ${secretName}`);
    }
    evidence.checks.secrets = secretChecks;

    const sql = await gcloudJson(["sql", "instances", "describe", "zkvote-prod-pg", "--project", projectId]);
    evidence.checks.cloudSql = sql ?? { status: "missing" };
    if (!sql) {
        addFail(evidence, "Cloud SQL instance zkvote-prod-pg missing");
    } else {
        const availability = nested(sql, ["settings", "availabilityType"]);
        const backupEnabled = nested(sql, ["settings", "backupConfiguration", "enabled"]);
        const pitrEnabled = nested(sql, ["settings", "backupConfiguration", "pointInTimeRecoveryEnabled"]);
        const deletionProtection = nested(sql, ["settings", "deletionProtectionEnabled"]);
        if (availability !== "REGIONAL") addFail(evidence, `Cloud SQL availabilityType must be REGIONAL, got ${String(availability)}`);
        if (backupEnabled !== true) addFail(evidence, "Cloud SQL backup must be enabled");
        if (pitrEnabled !== true) addFail(evidence, "Cloud SQL PITR must be enabled");
        if (deletionProtection !== true) addFail(evidence, "Cloud SQL deletion protection must be enabled");
    }

    const redis = await gcloudJson(["redis", "instances", "describe", "zkvote-prod-redis", "--project", projectId, "--region", region]);
    evidence.checks.redis = redis ?? { status: "missing" };
    if (!redis) {
        addFail(evidence, "Redis instance zkvote-prod-redis missing");
    } else if (redis.tier !== "STANDARD_HA") {
        addFail(evidence, `Redis tier must be STANDARD_HA, got ${String(redis.tier)}`);
    }

    const service = await gcloudJson(["run", "services", "describe", "zkvote-prod-api", "--project", projectId, "--region", region]);
    evidence.checks.cloudRun = service ?? { status: "missing" };
    if (service) {
        const maxScale = nested(service, ["spec", "template", "metadata", "annotations", "autoscaling.knative.dev/maxScale"]);
        if (maxScale !== "1") addFail(evidence, `Cloud Run maxScale must be 1, got ${String(maxScale)}`);
    } else {
        addCaveat(evidence, "Cloud Run service not deployed yet; expected before post-deploy preflight");
    }

    const files = [
        "zk/build_4_10/VoteCheck_temp_js/VoteCheck_temp.wasm",
        "zk/build_4_10/circuit_final.zkey",
        "zk/build_4_10/verification_key.json",
    ];
    evidence.checks.localArtifacts = Object.fromEntries(files.map((rel) => {
        const abs = path.join(PROJECT_ROOT, rel);
        if (!fs.existsSync(abs)) {
            addFail(evidence, `missing local artifact: ${rel}`);
            return [rel, "missing"];
        }
        return [rel, { sha256: sha256File(abs) }];
    }));

    await checkChain(evidence);

    evidence.status = evidence.hardFailures.length === 0 ? "passed" : "failed";
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`production preflight ${evidence.status.toUpperCase()}; evidence=${evidencePath}`);
    if (evidence.hardFailures.length) {
        for (const failure of evidence.hardFailures) console.error(`FAIL: ${failure}`);
        process.exit(1);
    }
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
