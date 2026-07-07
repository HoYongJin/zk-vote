#!/usr/bin/env tsx
/**
 * Read-only staging load smoke.
 *
 * This is not a substitute for the future mutation/concurrency tests
 * (register/finalize/submit). It is a safe baseline that exercises public
 * readiness and, when Firebase test-user secrets exist, an authenticated read
 * route under bounded concurrency.
 */
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_PROJECT_ID = "zkvote-staging-hhyyj";
const DEFAULT_SECRET_NAMES = {
    firebaseApiKey: "zkvote-staging-firebase-web-api-key",
    voterEmail: "zkvote-staging-e2e-voter-email",
    voterPassword: "zkvote-staging-e2e-voter-password",
} as const;

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    command: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    baseUrl: string;
    checks: Record<string, unknown>;
    caveats: string[];
    failure?: string;
}

interface Sample {
    ok: boolean;
    status: number;
    latencyMs: number;
    error?: string;
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
        ["secrets", "versions", "access", "latest", "--secret", secretName, "--project", projectId],
        { maxBuffer: 1024 * 1024 }
    );
    return stdout.trim();
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

async function firebaseSignIn(projectId: string): Promise<string | undefined> {
    const [apiKey, email, password] = await Promise.all([
        optionalEnvOrSecret(projectId, "FIREBASE_WEB_API_KEY", DEFAULT_SECRET_NAMES.firebaseApiKey),
        optionalEnvOrSecret(projectId, "E2E_VOTER_EMAIL", DEFAULT_SECRET_NAMES.voterEmail),
        optionalEnvOrSecret(projectId, "E2E_VOTER_PASSWORD", DEFAULT_SECRET_NAMES.voterPassword),
    ]);
    if (!apiKey || !email || !password) return undefined;
    const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
        }
    );
    const body = (await response.json()) as { idToken?: string; error?: { message?: string } };
    if (!response.ok || !body.idToken) {
        throw new Error(`Firebase sign-in failed: ${body.error?.message ?? "missing idToken"}`);
    }
    return body.idToken;
}

async function sample(url: string, token?: string): Promise<Sample> {
    const started = performance.now();
    try {
        const response = await fetch(url, {
            headers: token ? { authorization: `Bearer ${token}` } : undefined,
        });
        return {
            ok: response.ok,
            status: response.status,
            latencyMs: Math.round(performance.now() - started),
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            latencyMs: Math.round(performance.now() - started),
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function runBounded<T>(items: T[], concurrency: number, work: (item: T) => Promise<Sample>): Promise<Sample[]> {
    const results: Sample[] = [];
    let cursor = 0;
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            for (;;) {
                const index = cursor;
                cursor += 1;
                if (index >= items.length) return;
                results[index] = await work(items[index]);
            }
        })
    );
    return results;
}

function summarize(samples: Sample[]): Record<string, unknown> {
    const latencies = samples.map((row) => row.latencyMs).sort((a, b) => a - b);
    const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * p))] ?? 0;
    const statusCounts: Record<string, number> = {};
    for (const sample of samples) {
        statusCounts[String(sample.status)] = (statusCounts[String(sample.status)] ?? 0) + 1;
    }
    return {
        requests: samples.length,
        ok: samples.filter((row) => row.ok).length,
        failed: samples.filter((row) => !row.ok).length,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        maxMs: latencies.at(-1) ?? 0,
        statusCounts,
        firstError: samples.find((row) => row.error)?.error,
    };
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", DEFAULT_PROJECT_ID);
    const baseUrl = env("STAGING_BASE_URL").replace(/\/$/, "");
    const requests = Number(optionalEnv("LOAD_REQUESTS") ?? "50");
    const concurrency = Number(optionalEnv("LOAD_CONCURRENCY") ?? "10");
    assert(Number.isInteger(requests) && requests > 0 && requests <= 1000, "LOAD_REQUESTS must be 1..1000");
    assert(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= requests, "LOAD_CONCURRENCY must be 1..LOAD_REQUESTS");
    const evidencePath =
        optionalEnv("LOAD_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `staging-load-readonly-${runId}.json`);
    const checkLabel = env("LOAD_CHECK_LABEL", "staging read-only load");
    const evidence: Evidence = {
        status: "running",
        runId,
        command: invocation(),
        startedAt: new Date().toISOString(),
        projectId,
        baseUrl,
        checks: {},
        caveats: [
            "Read-only load smoke only; mutation/concurrency tests for register/finalize/submit remain separate production gates.",
        ],
    };
    writeEvidence(evidencePath, evidence);

    try {
        const token = await firebaseSignIn(projectId);
        if (!token) evidence.caveats.push("Firebase test-user secrets absent; authenticated read load was skipped.");
        const items = Array.from({ length: requests }, (_, index) => index);
        const readyz = await runBounded(items, concurrency, () => sample(`${baseUrl}/readyz`));
        const authRead = token
            ? await runBounded(items, concurrency, () => sample(`${baseUrl}/api/elections/registerable`, token))
            : [];
        const readyzSummary = summarize(readyz);
        const authSummary = token ? summarize(authRead) : undefined;
        assert(readyzSummary.failed === 0, `/readyz load had ${readyzSummary.failed} failed requests`);
        if (authSummary) {
            assert(authSummary.failed === 0, `/api/elections/registerable load had ${authSummary.failed} failed requests`);
        }
        evidence.checks = {
            load: { requests, concurrency },
            readyz: readyzSummary,
            authenticatedRegisterable: authSummary,
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
