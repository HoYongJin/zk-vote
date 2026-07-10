#!/usr/bin/env tsx
/**
 * Sync production frontend build settings into the GitHub Actions environment.
 *
 * Source of truth:
 * - Firebase Management API for the Web app config
 * - Cloud Run for the production API URL
 *
 * Secret values are passed to `gh secret set` via stdin, not command-line args.
 */
import { execFile as execFileCallback, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const FIREBASE_ORIGIN = "https://firebase.googleapis.com";

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    command: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    repo: string;
    environment: string;
    checks: Record<string, unknown>;
    caveats: string[];
    failure?: string;
}

interface FirebaseWebApp {
    name: string;
    appId: string;
    displayName?: string;
}

interface FirebaseWebAppConfig {
    projectId: string;
    appId: string;
    apiKey: string;
    authDomain?: string;
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

function invocation(): string {
    return ["node", "--import", "tsx", path.relative(PROJECT_ROOT, fileURLToPath(import.meta.url))]
        .join(" ");
}

function writeEvidence(filePath: string, evidence: Evidence): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function run(command: string, args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: PROJECT_ROOT,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
            }
        });
        child.stdin.end(input ?? "");
    });
}

async function gcloud(args: string[]): Promise<string> {
    const { stdout } = await execFile("gcloud", args, {
        cwd: PROJECT_ROOT,
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
    });
    return stdout.trim();
}

async function accessToken(): Promise<string> {
    const token = await gcloud(["auth", "print-access-token"]);
    if (!token) throw new Error("gcloud returned an empty access token");
    return token;
}

async function firebaseApi<T>(token: string, quotaProject: string, apiPath: string): Promise<T> {
    const response = await fetch(`${FIREBASE_ORIGIN}/${apiPath.replace(/^\//, "")}`, {
        headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            "x-goog-user-project": quotaProject,
        },
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Firebase API ${apiPath} returned ${response.status}: ${text}`);
    }
    return JSON.parse(text) as T;
}

async function firebaseWebConfig(token: string, projectId: string): Promise<FirebaseWebAppConfig> {
    const list = await firebaseApi<{ apps?: FirebaseWebApp[] }>(
        token,
        projectId,
        `v1beta1/projects/${projectId}/webApps?pageSize=100`
    );
    const apps = list.apps ?? [];
    if (apps.length === 0) {
        throw new Error(`Firebase project ${projectId} has no Web app`);
    }
    const configuredAppId = optionalEnv("FIREBASE_WEB_APP_ID");
    const app = configuredAppId
        ? apps.find((candidate) => candidate.appId === configuredAppId)
        : apps.length === 1
          ? apps[0]
          : apps.find((candidate) => candidate.displayName?.toLowerCase().includes("production"));
    if (!app) {
        throw new Error(
            `Firebase project ${projectId} has ${apps.length} Web apps; set FIREBASE_WEB_APP_ID`
        );
    }
    return firebaseApi<FirebaseWebAppConfig>(token, projectId, `v1beta1/${app.name}/config`);
}

async function ensureGithubEnvironment(repo: string, environment: string): Promise<void> {
    await run("gh", ["api", "-X", "PUT", `repos/${repo}/environments/${environment}`]);
}

async function setGithubSecret(repo: string, environment: string, name: string, value: string): Promise<void> {
    if (!value) throw new Error(`${name} is empty`);
    await run("gh", ["secret", "set", name, "--env", environment, "-R", repo], value);
}

function redacted(value: string): Record<string, unknown> {
    return {
        set: Boolean(value),
        length: value.length,
        sha256: crypto.createHash("sha256").update(value).digest("hex"),
    };
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", "zkvote-prod-hhyyj");
    const region = env("GCP_REGION", "asia-northeast3");
    const service = env("CLOUD_RUN_SERVICE", "zkvote-prod-api");
    const repo = env("GITHUB_REPOSITORY", "HoYongJin/zk-vote");
    const environment = env("GITHUB_ENVIRONMENT", "gcp-production");
    const evidencePath =
        optionalEnv("GITHUB_FRONTEND_ENV_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `github-frontend-env-${runId}.json`);
    const evidence: Evidence = {
        status: "running",
        runId,
        command: invocation(),
        startedAt: new Date().toISOString(),
        projectId,
        repo,
        environment,
        checks: {},
        caveats: [],
    };
    writeEvidence(evidencePath, evidence);

    try {
        const token = await accessToken();
        const firebase = await firebaseWebConfig(token, projectId);
        if (firebase.projectId !== projectId) {
            throw new Error(`Firebase config projectId ${firebase.projectId} != ${projectId}`);
        }
        const serviceUrl = await gcloud([
            "run",
            "services",
            "describe",
            service,
            "--project",
            projectId,
            "--region",
            region,
            "--format=value(status.url)",
        ]);
        if (!serviceUrl) throw new Error(`Cloud Run service URL not found for ${service}`);
        const apiBaseUrl = `${serviceUrl.replace(/\/$/, "")}/api`;
        const wifProvider = optionalEnv("GCP_WORKLOAD_IDENTITY_PROVIDER");
        const ciDeployServiceAccount = optionalEnv("GCP_CI_DEPLOY_SERVICE_ACCOUNT")
            ?? `zkvote-prod-ci-deployer@${projectId}.iam.gserviceaccount.com`;
        const siteId = optionalEnv("FIREBASE_SITE_ID") ?? projectId;
        const values = {
            VITE_API_BASE_URL: apiBaseUrl,
            VITE_FIREBASE_API_KEY: firebase.apiKey,
            VITE_FIREBASE_AUTH_DOMAIN: firebase.authDomain ?? `${projectId}.firebaseapp.com`,
            VITE_FIREBASE_PROJECT_ID: firebase.projectId,
            GCP_PROJECT_ID: projectId,
            FIREBASE_SITE_ID: siteId,
            ...(wifProvider ? { GCP_WORKLOAD_IDENTITY_PROVIDER: wifProvider } : {}),
            GCP_CI_DEPLOY_SERVICE_ACCOUNT: ciDeployServiceAccount,
        };
        await ensureGithubEnvironment(repo, environment);
        for (const [name, value] of Object.entries(values)) {
            await setGithubSecret(repo, environment, name, value);
        }
        evidence.checks = {
            githubEnvironment: { status: "ensured", name: environment },
            firebaseConfig: {
                projectId: firebase.projectId,
                appId: firebase.appId,
                authDomain: values.VITE_FIREBASE_AUTH_DOMAIN,
                apiKey: redacted(firebase.apiKey),
            },
            cloudRun: {
                service,
                apiBaseUrl,
            },
            deployIdentity: {
                wifProvider: wifProvider ? "set" : "not-set",
                ciDeployServiceAccount: "set",
                siteId,
            },
            githubSecrets: Object.fromEntries(
                Object.entries(values).map(([name, value]) => [name, redacted(value)])
            ),
        };
        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`github frontend env sync PASSED; evidence=${evidencePath}`);
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
