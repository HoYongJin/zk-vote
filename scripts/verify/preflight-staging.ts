#!/usr/bin/env tsx
/**
 * No-cost staging preflight.
 *
 * This does not create or mutate GCP resources. It checks whether the local
 * operator environment has enough tools, auth, config, and secrets *references*
 * to run the Phase 18 staging sequence, while redacting secret values.
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

const DEFAULT_PROJECT_ID = "zkvote-staging-hhyyj";
const DEFAULT_REGION = "asia-northeast3";
const EXPECTED_CHAIN_ID = "11155111";
const SECRET_FALLBACKS: Record<string, string> = {
    SEPOLIA_RPC_URL: "zkvote-staging-sepolia-rpc-url",
    RELAYER_PRIVATE_KEY: "zkvote-staging-relayer-private-key",
    OWNER_PRIVATE_KEY: "zkvote-staging-owner-private-key",
    FIREBASE_WEB_API_KEY: "zkvote-staging-firebase-web-api-key",
    E2E_SUPERADMIN_EMAIL: "zkvote-staging-e2e-superadmin-email",
    E2E_SUPERADMIN_PASSWORD: "zkvote-staging-e2e-superadmin-password",
    E2E_VOTER_EMAIL: "zkvote-staging-e2e-voter-email",
    E2E_VOTER_PASSWORD: "zkvote-staging-e2e-voter-password",
    E2E_DATABASE_URL: "zkvote-staging-migrator-database-url",
};
const POST_INFRA_SECRET_SUBSTITUTES: Record<string, string> = {
    ADMIN_PASSWORD: "zkvote-staging-postgres-password",
    MIGRATOR_PASSWORD: "zkvote-staging-migrator-database-url",
    APP_PASSWORD: "zkvote-staging-database-url",
};

type Status = "ok" | "warn" | "fail";

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    command: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    region: string;
    scope: "pre-infra" | "full";
    checks: Record<string, unknown>;
    hardFailures: string[];
    caveats: string[];
}

function optionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

function envStatus(name: string): "set" | "missing" {
    return optionalEnv(name) ? "set" : "missing";
}

function sha256File(filePath: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

async function run(
    command: string,
    args: string[],
    options: { timeoutMs?: number } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execFile(command, args, {
            timeout: options.timeoutMs ?? 15_000,
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

async function which(command: string): Promise<string | undefined> {
    const result = await run("which", [command], { timeoutMs: 5_000 });
    return result.ok ? result.stdout.split("\n")[0] : undefined;
}

async function secretHasEnabledVersion(projectId: string, secretName: string): Promise<boolean> {
    const result = await run(
        "gcloud",
        [
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
            "--format",
            "value(name)",
        ],
        { timeoutMs: 20_000 }
    );
    return result.ok && result.stdout.length > 0;
}

async function secretValue(projectId: string, secretName: string): Promise<string | undefined> {
    const result = await run(
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
        { timeoutMs: 20_000 }
    );
    return result.ok && result.stdout ? result.stdout : undefined;
}

async function envOrSecretValue(
    projectId: string,
    envName: string,
    defaultSecretName: string
): Promise<string | undefined> {
    const direct = optionalEnv(envName);
    if (direct) return direct;
    const secretName = optionalEnv(`${envName}_SECRET`) ?? defaultSecretName;
    return secretValue(projectId, secretName);
}

function addFinding(
    evidence: Evidence,
    status: Status,
    message: string,
    options: { hard?: boolean } = {}
): void {
    if (status === "fail" || options.hard) {
        evidence.hardFailures.push(message);
    } else if (status === "warn") {
        evidence.caveats.push(message);
    }
}

function evidencePath(runId: string): string {
    return (
        optionalEnv("PREFLIGHT_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `staging-preflight-${runId}.json`)
    );
}

function writeEvidence(filePath: string, evidence: Evidence): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function checkTools(evidence: Evidence): Promise<void> {
    const required = ["gcloud", "cast", "docker", "node", "npm", "npx", "curl"];
    const optional = ["firebase"];
    const checks: Record<string, unknown> = {};
    for (const tool of required) {
        const resolved = await which(tool);
        checks[tool] = resolved ? { status: "ok", path: resolved } : { status: "missing" };
        if (!resolved) addFinding(evidence, "fail", `required tool missing: ${tool}`);
    }
    for (const tool of optional) {
        const resolved = await which(tool);
        checks[tool] = resolved
            ? { status: "ok", path: resolved }
            : { status: "missing", caveat: "not required when using npx/firebase workflow" };
        if (!resolved) addFinding(evidence, "warn", `optional tool missing: ${tool}`);
    }
    evidence.checks.tools = checks;
}

async function checkGcloud(evidence: Evidence): Promise<void> {
    const project = await run("gcloud", ["config", "get-value", "project"], { timeoutMs: 10_000 });
    const account = await run(
        "gcloud",
        ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
        { timeoutMs: 10_000 }
    );
    const activeAccount = account.ok ? account.stdout.split("\n").filter(Boolean)[0] : "";
    evidence.checks.gcloud = {
        configuredProject: project.ok ? project.stdout : "(unavailable)",
        expectedProject: evidence.projectId,
        activeAccount: activeAccount ? "present" : "missing",
    };
    if (!activeAccount) {
        addFinding(evidence, "fail", "gcloud has no active authenticated account");
    }
    if (!project.ok || project.stdout !== evidence.projectId) {
        addFinding(
            evidence,
            "fail",
            `gcloud project must be ${evidence.projectId}, got ${project.ok ? project.stdout : "(unavailable)"}`
        );
    }

    const projectDescribe = await run(
        "gcloud",
        ["projects", "describe", evidence.projectId, "--format=value(projectNumber)"],
        { timeoutMs: 20_000 }
    );
    const servicesList = await run(
        "gcloud",
        ["services", "list", "--enabled", "--project", evidence.projectId, "--limit=1", "--format=value(config.name)"],
        { timeoutMs: 20_000 }
    );
    const billingDescribe = await run(
        "gcloud",
        ["billing", "projects", "describe", evidence.projectId, "--format=value(billingEnabled)"],
        { timeoutMs: 20_000 }
    );
    (evidence.checks.gcloud as Record<string, unknown>).projectAccess = projectDescribe.ok
        ? { status: "ok", projectNumber: projectDescribe.stdout }
        : { status: "denied", error: projectDescribe.stderr };
    (evidence.checks.gcloud as Record<string, unknown>).serviceUsageAccess = servicesList.ok
        ? { status: "ok" }
        : { status: "denied", error: servicesList.stderr };
    (evidence.checks.gcloud as Record<string, unknown>).billingAccess = billingDescribe.ok
        ? { status: "ok", billingEnabled: billingDescribe.stdout }
        : { status: "denied", error: billingDescribe.stderr };
    if (!projectDescribe.ok) {
        addFinding(evidence, "fail", `active account cannot describe project ${evidence.projectId}`);
    }
    if (!servicesList.ok) {
        addFinding(evidence, "fail", `active account cannot list enabled services for ${evidence.projectId}`);
    }
    if (!billingDescribe.ok) {
        addFinding(evidence, "fail", `active account cannot inspect billing for ${evidence.projectId}`);
    } else if (billingDescribe.stdout !== "True" && billingDescribe.stdout !== "true") {
        addFinding(evidence, "fail", `billing is not enabled for ${evidence.projectId}`);
    }
}

async function checkEnv(evidence: Evidence): Promise<void> {
    const preInfraRequired = ["SEPOLIA_RPC_URL", "RELAYER_PRIVATE_KEY", "OWNER_PRIVATE_KEY"];
    const fullOnlyRequired = [
        "FIREBASE_WEB_API_KEY",
        "E2E_SUPERADMIN_EMAIL",
        "E2E_SUPERADMIN_PASSWORD",
        "E2E_VOTER_EMAIL",
        "E2E_VOTER_PASSWORD",
        "SQL_CONNECTION_NAME",
        "ADMIN_PASSWORD",
        "MIGRATOR_PASSWORD",
        "APP_PASSWORD",
        "CORS_ALLOWED_ORIGINS",
        "OWNER_PRIVATE_KEY_SECRET",
        "STAGING_BASE_URL",
        "E2E_DATABASE_URL",
        "FIREBASE_HOSTING_URL",
    ];
    const requiredForScope =
        evidence.scope === "pre-infra"
            ? preInfraRequired
            : [...preInfraRequired, ...fullOnlyRequired];
    const optionalButImportant = ["GCIP_ID_TOKEN", "SUPABASE_ID_TOKEN"];
    const envChecks: Record<string, unknown> = {};
    for (const name of [...preInfraRequired, ...fullOnlyRequired]) {
        const direct = optionalEnv(name);
        if (direct) {
            envChecks[name] = { status: "set", source: "env" };
            continue;
        }

        const secretName =
            SECRET_FALLBACKS[name] ??
            (evidence.scope === "full" ? POST_INFRA_SECRET_SUBSTITUTES[name] : undefined);
        if (secretName) {
            const hasSecret = await secretHasEnabledVersion(evidence.projectId, secretName);
            envChecks[name] = hasSecret
                ? { status: "set", source: "secret-manager", secret: secretName }
                : { status: "missing", source: "secret-manager", secret: secretName };
            if (requiredForScope.includes(name) && !hasSecret) {
                addFinding(
                    evidence,
                    "fail",
                    `required env/secret missing for ${evidence.scope} staging preflight: ${name} (${secretName})`
                );
            }
            continue;
        }

        envChecks[name] = { status: "missing", source: "env" };
        if (requiredForScope.includes(name)) {
            addFinding(evidence, "fail", `required env missing for ${evidence.scope} staging preflight: ${name}`);
        }
    }
    if (optionalEnv("REDIS_BACKEND") === "external") {
        const redisUrl = optionalEnv("REDIS_URL");
        const redisSecret = redisUrl ? true : await secretHasEnabledVersion(evidence.projectId, "zkvote-staging-redis-url");
        envChecks.REDIS_URL = redisUrl
            ? { status: "set", source: "env" }
            : redisSecret
              ? { status: "set", source: "secret-manager", secret: "zkvote-staging-redis-url" }
              : { status: "missing", source: "env-or-secret" };
        if (!redisUrl && !redisSecret) {
            addFinding(evidence, "fail", "REDIS_BACKEND=external requires REDIS_URL");
        }
    }
    for (const name of optionalButImportant) {
        envChecks[name] = { status: envStatus(name), source: "env" };
        if (envStatus(name) === "missing") {
            addFinding(evidence, "warn", `${name} missing; auth migration cannot be fully proven`);
        }
    }

    const maxInstances = optionalEnv("MAX_INSTANCES") ?? "1(default)";
    envChecks.MAX_INSTANCES = { status: "set", value: maxInstances };
    if (optionalEnv("MAX_INSTANCES") && optionalEnv("MAX_INSTANCES") !== "1") {
        addFinding(evidence, "fail", `MAX_INSTANCES must be 1 for v1, got ${optionalEnv("MAX_INSTANCES")}`);
    }

    evidence.checks.env = envChecks;
}

async function checkChain(evidence: Evidence): Promise<void> {
    const rpcUrl = await envOrSecretValue(evidence.projectId, "SEPOLIA_RPC_URL", SECRET_FALLBACKS.SEPOLIA_RPC_URL);
    if (!rpcUrl) {
        evidence.checks.chain = { status: "skipped", reason: "SEPOLIA_RPC_URL missing" };
        return;
    }
    const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = (await response.json()) as { result?: string; error?: { message?: string } };
    const actualChainId = body.result ? BigInt(body.result).toString() : "(unavailable)";
    evidence.checks.chain = {
        expectedChainId: EXPECTED_CHAIN_ID,
        actualChainId,
    };
    if (!response.ok || body.error || actualChainId !== EXPECTED_CHAIN_ID) {
        addFinding(
            evidence,
            "fail",
            `SEPOLIA_RPC_URL must report chain id ${EXPECTED_CHAIN_ID}, got ${actualChainId}`
        );
    }
}

async function checkLocalArtifacts(evidence: Evidence): Promise<void> {
    const files = {
        wasm: "zk/build_4_10/VoteCheck_temp_js/VoteCheck_temp.wasm",
        zkey: "zk/build_4_10/circuit_final.zkey",
        verificationKey: "zk/build_4_10/verification_key.json",
        verifierContract: "contracts/Groth16Verifier_4_10.sol",
        tallyContract: "contracts/VotingTally.sol",
    };
    const artifacts: Record<string, unknown> = {};
    for (const [key, rel] of Object.entries(files)) {
        const abs = path.join(PROJECT_ROOT, rel);
        if (!fs.existsSync(abs)) {
            artifacts[key] = { path: rel, status: "missing" };
            addFinding(evidence, "fail", `local artifact missing: ${rel}`);
            continue;
        }
        artifacts[key] = { path: rel, status: "ok", sha256: sha256File(abs) };
    }
    evidence.checks.localArtifacts = artifacts;
}

async function checkNodeDeps(evidence: Evidence): Promise<void> {
    const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
    const required = [
        "tsx",
        "pg",
        "@types/pg",
        "@playwright/test",
        "snarkjs",
        "@ethersproject/keccak256",
        "@ethersproject/signing-key",
    ];
    const check: Record<string, unknown> = {};
    for (const dep of required) {
        check[dep] = deps[dep] ? { status: "declared", version: deps[dep] } : { status: "missing" };
        if (!deps[dep]) addFinding(evidence, "fail", `root package dependency missing: ${dep}`);
    }
    evidence.checks.nodeDependencies = check;
}

async function checkScripts(evidence: Evidence): Promise<void> {
    const scripts = [
        "scripts/iac/zkvote-staging-setup.sh",
        "scripts/migration/migrate-cloudsql.sh",
        "scripts/iac/bootstrap-staging-superadmin.sh",
        "scripts/cicd/deploy-staging-api.sh",
        "scripts/verify/verify-staging.sh",
        "scripts/verify/check-staging-chain.ts",
        "scripts/verify/e2e-staging.ts",
        "scripts/verify/browser-smoke-staging.ts",
        "scripts/verify/reconcile-staging-tally.ts",
        "scripts/verify/load-staging-readonly.ts",
    ];
    const check: Record<string, unknown> = {};
    for (const rel of scripts) {
        const abs = path.join(PROJECT_ROOT, rel);
        const exists = fs.existsSync(abs);
        const executable = exists
            ? (() => {
                  try {
                      fs.accessSync(abs, fs.constants.X_OK);
                      return true;
                  } catch {
                      return false;
                  }
              })()
            : false;
        check[rel] = { exists, executable };
        if (!exists) addFinding(evidence, "fail", `required staging script missing: ${rel}`);
        if (exists && !executable) addFinding(evidence, "warn", `staging script is not executable: ${rel}`);
    }
    evidence.checks.scripts = check;
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = optionalEnv("GCP_PROJECT_ID") ?? DEFAULT_PROJECT_ID;
    const region = optionalEnv("GCP_REGION") ?? DEFAULT_REGION;
    const scope = optionalEnv("PREFLIGHT_SCOPE") === "pre-infra" ? "pre-infra" : "full";
    const evidence: Evidence = {
        status: "running",
        runId,
        command: "node --import tsx scripts/verify/preflight-staging.ts",
        startedAt: new Date().toISOString(),
        projectId,
        region,
        scope,
        checks: {},
        hardFailures: [],
        caveats: [],
    };
    const out = evidencePath(runId);

    try {
        await checkTools(evidence);
        await checkGcloud(evidence);
        await checkEnv(evidence);
        await checkChain(evidence);
        await checkLocalArtifacts(evidence);
        await checkNodeDeps(evidence);
        await checkScripts(evidence);

        evidence.status = evidence.hardFailures.length === 0 ? "passed" : "failed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(out, evidence);
        console.log(`staging preflight ${evidence.status.toUpperCase()}; evidence=${out}`);
        if (evidence.hardFailures.length > 0) {
            for (const failure of evidence.hardFailures) {
                console.error(`FAIL: ${failure}`);
            }
            process.exit(1);
        }
    } catch (error) {
        evidence.status = "failed";
        evidence.finishedAt = new Date().toISOString();
        evidence.hardFailures.push(error instanceof Error ? error.message : String(error));
        writeEvidence(out, evidence);
        throw error;
    }
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
