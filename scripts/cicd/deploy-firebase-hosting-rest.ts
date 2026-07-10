#!/usr/bin/env tsx
/**
 * Firebase Hosting deploy via REST.
 *
 * firebase-tools could not authenticate with user ADC in this environment, and
 * passing a live access token on the command line is not acceptable. This script
 * keeps the impersonated token in-process and uses the Hosting REST contract:
 * create version -> populate gzip hashes -> upload required gzip bytes ->
 * finalize version -> release to live.
 */
import { execFile as execFileCallback } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const HOSTING_ORIGIN = "https://firebasehosting.googleapis.com";

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    siteId: string;
    publicDir: string;
    serviceAccount: string;
    checks: Record<string, unknown>;
    failure?: string;
}

type FirebaseJsonHeader = {
    glob?: string;
    source?: string;
    regex?: string;
    headers?: Array<{ key: string; value: string }>;
};

type FirebaseJsonRewrite = {
    glob?: string;
    source?: string;
    regex?: string;
    destination?: string;
};

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

function writeEvidence(filePath: string, evidence: Evidence): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function impersonatedAccessToken(serviceAccount: string): Promise<string> {
    const { stdout } = await execFile(
        "gcloud",
        ["auth", "print-access-token", `--impersonate-service-account=${serviceAccount}`],
        { maxBuffer: 1024 * 1024 }
    );
    const token = stdout.trim();
    if (!token) throw new Error("gcloud returned an empty access token");
    return token;
}

async function api<T>(
    token: string,
    method: string,
    apiPath: string,
    body?: unknown,
    headers: Record<string, string> = {}
): Promise<T> {
    const response = await fetch(`${HOSTING_ORIGIN}/v1beta1/${apiPath.replace(/^\//, "")}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`${method} ${apiPath} returned ${response.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
}

function pattern(rule: { glob?: string; source?: string; regex?: string }): { glob: string } | { regex: string } {
    if (rule.regex) return { regex: rule.regex };
    const glob = rule.glob ?? rule.source;
    if (!glob) throw new Error("Hosting rule is missing glob/source/regex");
    return { glob };
}

function hostingConfig(firebaseJsonPath: string): Record<string, unknown> {
    const firebaseJson = JSON.parse(fs.readFileSync(firebaseJsonPath, "utf8"));
    const hosting = firebaseJson.hosting;
    if (!hosting || typeof hosting !== "object") {
        throw new Error(`${firebaseJsonPath} has no hosting config`);
    }

    const config: Record<string, unknown> = {};
    const headers = hosting.headers as FirebaseJsonHeader[] | undefined;
    if (headers?.length) {
        config.headers = headers.map((entry) => ({
            ...pattern(entry),
            headers: Object.fromEntries((entry.headers ?? []).map(({ key, value }) => [key, value])),
        }));
    }

    const rewrites = hosting.rewrites as FirebaseJsonRewrite[] | undefined;
    if (rewrites?.length) {
        config.rewrites = rewrites.map((entry) => {
            if (!entry.destination) {
                throw new Error("REST deploy only supports static destination rewrites");
            }
            return {
                ...pattern(entry),
                path: entry.destination,
            };
        });
    }

    return config;
}

function walkFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            const rel = path.relative(root, abs).replaceAll(path.sep, "/");
            if (entry.name.startsWith(".")) continue;
            if (entry.isDirectory()) {
                walk(abs);
                continue;
            }
            if (!entry.isFile()) continue;
            if (rel.endsWith(".map")) continue;
            out.push(rel);
        }
    };
    walk(root);
    out.sort();
    return out;
}

function gzippedFile(publicDir: string, rel: string): Buffer {
    return zlib.gzipSync(fs.readFileSync(path.join(publicDir, rel)), { level: 9 });
}

function hashGzip(bytes: Buffer): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function uploadGzip(token: string, uploadUrl: string, hash: string, bytes: Buffer): Promise<void> {
    const response = await fetch(`${uploadUrl.replace(/\/$/, "")}/${hash}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/octet-stream",
        },
        body: bytes,
    });
    if (response.status !== 200) {
        throw new Error(`upload ${hash} returned ${response.status}: ${await response.text()}`);
    }
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", "zkvote-prod-hhyyj");
    const siteId = env("FIREBASE_SITE_ID", projectId);
    const serviceAccount = env(
        "GCP_CI_DEPLOY_SERVICE_ACCOUNT",
        `zkvote-prod-ci-deployer@${projectId}.iam.gserviceaccount.com`
    );
    const publicDir = path.resolve(PROJECT_ROOT, optionalEnv("FIREBASE_PUBLIC_DIR") ?? "frontend/build");
    const firebaseJsonPath = path.resolve(PROJECT_ROOT, optionalEnv("FIREBASE_CONFIG_PATH") ?? "firebase.json");
    const evidencePath =
        optionalEnv("FIREBASE_DEPLOY_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `firebase-hosting-deploy-${runId}.json`);

    const evidence: Evidence = {
        status: "running",
        runId,
        startedAt: new Date().toISOString(),
        projectId,
        siteId,
        publicDir,
        serviceAccount,
        checks: {},
    };
    writeEvidence(evidencePath, evidence);

    try {
        const files = walkFiles(publicDir);
        if (files.length === 0) throw new Error(`No deployable files found in ${publicDir}`);
        const gzips = new Map<string, Buffer>();
        const fileHashes: Record<string, string> = {};
        for (const rel of files) {
            const bytes = gzippedFile(publicDir, rel);
            const hash = hashGzip(bytes);
            gzips.set(hash, bytes);
            fileHashes[`/${rel}`] = hash;
        }

        const token = await impersonatedAccessToken(serviceAccount);
        const created = await api<{ name: string }>(
            token,
            "POST",
            `projects/-/sites/${siteId}/versions`,
            {
                status: "CREATED",
                labels: {
                    deployment_tool: "codex-rest",
                },
            }
        );
        if (!created.name) throw new Error("create version returned no name");
        evidence.checks.versionName = created.name;

        const populated = await api<{ uploadRequiredHashes?: string[]; uploadUrl?: string }>(
            token,
            "POST",
            `${created.name}:populateFiles`,
            { files: fileHashes }
        );
        const uploadRequired = populated.uploadRequiredHashes ?? [];
        if (uploadRequired.length > 0 && !populated.uploadUrl) {
            throw new Error("populateFiles required uploads but returned no uploadUrl");
        }
        for (const hash of uploadRequired) {
            const bytes = gzips.get(hash);
            if (!bytes) throw new Error(`populateFiles requested unknown hash ${hash}`);
            await uploadGzip(token, populated.uploadUrl!, hash, bytes);
        }
        evidence.checks.files = {
            total: files.length,
            uploaded: uploadRequired.length,
            paths: files,
        };

        const finalized = await api<{ name: string; status: string }>(
            token,
            "PATCH",
            `${created.name}?updateMask=status,config`,
            {
                status: "FINALIZED",
                config: hostingConfig(firebaseJsonPath),
            }
        );
        if (finalized.status !== "FINALIZED") {
            throw new Error(`version finalized with unexpected status ${finalized.status}`);
        }
        evidence.checks.finalized = finalized;

        const released = await api<{ name: string; type?: string }>(
            token,
            "POST",
            `projects/-/sites/${siteId}/channels/live/releases?versionName=${encodeURIComponent(created.name)}`,
            {}
        );
        evidence.checks.release = released;
        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`firebase hosting REST deploy PASSED; evidence=${evidencePath}`);
        console.log(`hosting URL: https://${siteId}.web.app`);
    } catch (error) {
        evidence.status = "failed";
        evidence.finishedAt = new Date().toISOString();
        evidence.failure = error instanceof Error ? error.message : String(error);
        writeEvidence(evidencePath, evidence);
        throw error;
    }
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
