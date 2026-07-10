#!/usr/bin/env tsx
/**
 * Production Firebase/GCIP bootstrap.
 *
 * Uses REST APIs because local gcloud does not expose Firebase project/auth
 * setup commands. Secret values are written through gcloud stdin, not argv.
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
const HOSTING_ORIGIN = "https://firebasehosting.googleapis.com";
const IDENTITY_ORIGIN = "https://identitytoolkit.googleapis.com";

type Json = Record<string, unknown>;

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    serviceAccount: string;
    checks: Record<string, unknown>;
    caveats: string[];
    failure?: string;
}

interface Operation {
    name?: string;
    done?: boolean;
    error?: { code?: number; message?: string };
    response?: Json;
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

interface IdentityConfig {
    signIn?: {
        email?: {
            enabled?: boolean;
            passwordRequired?: boolean;
        };
    };
}

interface DefaultSupportedIdpConfig {
    name?: string;
    enabled?: boolean;
    clientId?: string;
    clientSecret?: string;
}

interface HostingSite {
    name?: string;
    defaultUrl?: string;
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

function writeEvidence(filePath: string, evidence: Evidence): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
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

async function request(
    origin: string,
    token: string,
    method: string,
    apiPath: string,
    body?: unknown
): Promise<{ status: number; text: string; json?: Json }> {
    const response = await fetch(`${origin}/${apiPath.replace(/^\//, "")}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(optionalEnv("GOOGLE_CLOUD_QUOTA_PROJECT") ?? optionalEnv("GCP_PROJECT_ID")
                ? { "x-goog-user-project": (optionalEnv("GOOGLE_CLOUD_QUOTA_PROJECT") ?? optionalEnv("GCP_PROJECT_ID")) as string }
                : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Json | undefined;
    if (text) {
        try {
            parsed = JSON.parse(text) as Json;
        } catch {
            parsed = undefined;
        }
    }
    return { status: response.status, text, json: parsed };
}

async function api<T>(
    origin: string,
    token: string,
    method: string,
    apiPath: string,
    body?: unknown,
    ok: number[] = [200]
): Promise<T> {
    const response = await request(origin, token, method, apiPath, body);
    if (!ok.includes(response.status)) {
        throw new Error(`${method} ${apiPath} returned ${response.status}: ${response.text}`);
    }
    return (response.json ?? {}) as T;
}

async function pollFirebaseOperation(token: string, operation: Operation): Promise<Operation> {
    if (!operation.name) throw new Error("Firebase operation returned no name");
    for (let i = 0; i < 60; i += 1) {
        const current = await api<Operation>(FIREBASE_ORIGIN, token, "GET", `v1beta1/${operation.name}`);
        if (current.done) {
            if (current.error) {
                throw new Error(`Firebase operation ${operation.name} failed: ${JSON.stringify(current.error)}`);
            }
            return current;
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`Firebase operation ${operation.name} did not complete in time`);
}

async function ensureSecret(projectId: string, secretName: string): Promise<void> {
    const described = await execFile("gcloud", ["secrets", "describe", secretName, "--project", projectId], {
        cwd: PROJECT_ROOT,
        maxBuffer: 1024 * 1024,
    }).catch(() => undefined);
    if (described) return;
    await gcloud(["secrets", "create", secretName, "--project", projectId, "--replication-policy", "automatic", "--quiet"]);
}

async function addSecretVersion(projectId: string, secretName: string, value: string): Promise<void> {
    await ensureSecret(projectId, secretName);
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            "gcloud",
            ["secrets", "versions", "add", secretName, "--project", projectId, "--data-file=-", "--quiet"],
            { cwd: PROJECT_ROOT, stdio: ["pipe", "pipe", "pipe"] }
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`gcloud secrets versions add ${secretName} exited ${code}: ${stderr.trim()}`));
        });
        child.stdin.end(value);
    });
}

async function secretValue(projectId: string, secretName: string): Promise<string | undefined> {
    try {
        return await gcloud([
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret",
            secretName,
            "--project",
            projectId,
        ]);
    } catch {
        return undefined;
    }
}

async function requiredEnvOrSecret(projectId: string, envName: string, secretName: string): Promise<string> {
    const direct = optionalEnv(envName);
    if (direct) return direct;
    const value = await secretValue(projectId, secretName);
    if (!value) throw new Error(`Set ${envName} or Secret Manager ${secretName}`);
    return value;
}

function isGoogleOAuthWebClientId(clientId: string): boolean {
    return clientId.endsWith(".apps.googleusercontent.com");
}

async function ensureFirebaseProject(token: string, projectId: string): Promise<string> {
    const existing = await request(FIREBASE_ORIGIN, token, "GET", `v1beta1/projects/${projectId}`);
    if (existing.status === 200) return "existing";
    if (existing.status !== 404) {
        throw new Error(`GET Firebase project returned ${existing.status}: ${existing.text}`);
    }
    const op = await api<Operation>(
        FIREBASE_ORIGIN,
        token,
        "POST",
        `v1beta1/projects/${projectId}:addFirebase`,
        { locationId: optionalEnv("FIREBASE_LOCATION_ID") ?? "asia-northeast3" }
    );
    await pollFirebaseOperation(token, op);
    return "created";
}

async function ensureIdentityPlatform(token: string, projectId: string): Promise<string> {
    const response = await request(
        IDENTITY_ORIGIN,
        token,
        "POST",
        `v2/projects/${projectId}/identityPlatform:initializeAuth`,
        {}
    );
    if ([200, 204].includes(response.status)) return "initialized";
    if ([400, 409].includes(response.status) && /already|exist|enabled/i.test(response.text)) {
        return "existing";
    }
    throw new Error(`initializeAuth returned ${response.status}: ${response.text}`);
}

async function ensureEmailPasswordSignIn(token: string, projectId: string): Promise<string> {
    const configPath = `v2/projects/${projectId}/config`;
    const existing = await api<IdentityConfig>(IDENTITY_ORIGIN, token, "GET", configPath);
    if (existing.signIn?.email?.enabled === true && existing.signIn.email.passwordRequired === true) {
        return "existing";
    }

    const updated = await api<IdentityConfig>(
        IDENTITY_ORIGIN,
        token,
        "PATCH",
        `${configPath}?updateMask=signIn.email.enabled,signIn.email.passwordRequired`,
        { signIn: { email: { enabled: true, passwordRequired: true } } }
    );
    if (updated.signIn?.email?.enabled !== true || updated.signIn.email.passwordRequired !== true) {
        throw new Error("Identity Platform email/password provider was not enabled after updateConfig");
    }
    return "enabled";
}

async function ensureGoogleSignIn(token: string, projectId: string): Promise<string> {
    const idpPath = `admin/v2/projects/${projectId}/defaultSupportedIdpConfigs/google.com`;
    const existing = await request(IDENTITY_ORIGIN, token, "GET", idpPath);
    if (existing.status === 200) {
        const config = (existing.json ?? {}) as DefaultSupportedIdpConfig;
        if (config.enabled === true && config.clientId && isGoogleOAuthWebClientId(config.clientId)) {
            return "existing";
        }
    }

    const [clientId, clientSecret] = await Promise.all([
        requiredEnvOrSecret(projectId, "GOOGLE_OAUTH_CLIENT_ID", "zkvote-prod-google-oauth-client-id"),
        requiredEnvOrSecret(projectId, "GOOGLE_OAUTH_CLIENT_SECRET", "zkvote-prod-google-oauth-client-secret"),
    ]);
    if (!isGoogleOAuthWebClientId(clientId)) {
        throw new Error(
            "GOOGLE_OAUTH_CLIENT_ID must be a Google Auth Platform Web client id ending in .apps.googleusercontent.com"
        );
    }
    const body: DefaultSupportedIdpConfig = { enabled: true, clientId, clientSecret };

    if (existing.status === 200) {
        const updated = await api<DefaultSupportedIdpConfig>(
            IDENTITY_ORIGIN,
            token,
            "PATCH",
            `${idpPath}?updateMask=enabled,clientId,clientSecret`,
            body
        );
        if (updated.enabled !== true || !updated.clientId) {
            throw new Error("Identity Platform Google provider was not enabled after patch");
        }
        return "enabled";
    }
    if (existing.status !== 404) {
        throw new Error(`GET Google provider config returned ${existing.status}: ${existing.text}`);
    }

    const created = await api<DefaultSupportedIdpConfig>(
        IDENTITY_ORIGIN,
        token,
        "POST",
        `admin/v2/projects/${projectId}/defaultSupportedIdpConfigs?idpId=google.com`,
        body,
        [200, 201]
    );
    if (created.enabled !== true || !created.clientId) {
        throw new Error("Identity Platform Google provider was not enabled after create");
    }
    return "created";
}

async function ensureWebApp(token: string, projectId: string): Promise<FirebaseWebAppConfig> {
    const list = await api<{ apps?: FirebaseWebApp[] }>(
        FIREBASE_ORIGIN,
        token,
        "GET",
        `v1beta1/projects/${projectId}/webApps?pageSize=100`
    );
    let apps = list.apps ?? [];
    let app = apps.find((candidate) => candidate.displayName === "zk-vote production web") ?? apps[0];
    if (!app) {
        const op = await api<Operation>(
            FIREBASE_ORIGIN,
            token,
            "POST",
            `v1beta1/projects/${projectId}/webApps`,
            { displayName: "zk-vote production web" }
        );
        await pollFirebaseOperation(token, op);
        const refreshed = await api<{ apps?: FirebaseWebApp[] }>(
            FIREBASE_ORIGIN,
            token,
            "GET",
            `v1beta1/projects/${projectId}/webApps?pageSize=100`
        );
        apps = refreshed.apps ?? [];
        app = apps.find((candidate) => candidate.displayName === "zk-vote production web") ?? apps[0];
    }
    if (!app) throw new Error(`Firebase project ${projectId} has no Web app after create`);
    return api<FirebaseWebAppConfig>(FIREBASE_ORIGIN, token, "GET", `v1beta1/${app.name}/config`);
}

async function ensureHostingSite(token: string, projectId: string, siteId: string): Promise<HostingSite> {
    const list = await api<{ sites?: HostingSite[] }>(
        HOSTING_ORIGIN,
        token,
        "GET",
        `v1beta1/projects/${projectId}/sites?pageSize=100`
    );
    const existing = (list.sites ?? []).find((site) => site.name === `projects/${projectId}/sites/${siteId}`);
    if (existing) return existing;
    const created = await request(
        HOSTING_ORIGIN,
        token,
        "POST",
        `v1beta1/projects/${projectId}/sites?siteId=${encodeURIComponent(siteId)}`,
        {}
    );
    if (![200, 201, 409].includes(created.status)) {
        throw new Error(`create hosting site returned ${created.status}: ${created.text}`);
    }
    if (created.status === 409) {
        const refreshed = await api<{ sites?: HostingSite[] }>(
            HOSTING_ORIGIN,
            token,
            "GET",
            `v1beta1/projects/${projectId}/sites?pageSize=100`
        );
        const site = (refreshed.sites ?? []).find((candidate) => candidate.name === `projects/${projectId}/sites/${siteId}`);
        if (site) return site;
        throw new Error(`Hosting site ${siteId} conflicted but is not listed in project ${projectId}`);
    }
    return (created.json ?? { name: `projects/${projectId}/sites/${siteId}` }) as HostingSite;
}

function password(): string {
    return `ZkVoteProd!${crypto.randomBytes(12).toString("hex")}`;
}

async function createIdentityUser(
    token: string,
    projectId: string,
    apiKey: string,
    role: "superadmin" | "voter"
): Promise<Json> {
    const emailSecret = `zkvote-prod-e2e-${role}-email`;
    const passwordSecret = `zkvote-prod-e2e-${role}-password`;
    const uidSecret = `zkvote-prod-e2e-${role}-uid`;
    const existingEmail = await secretValue(projectId, emailSecret);
    const existingPassword = await secretValue(projectId, passwordSecret);
    const existingUid = await secretValue(projectId, uidSecret);
    if (existingEmail && existingPassword && existingUid) {
        return { status: "existing-secret", email: existingEmail, uid: existingUid };
    }

    const email = `zkvote-prod-e2e-${role}-${Date.now()}@example.com`;
    const pw = password();
    const created = await request(
        IDENTITY_ORIGIN,
        token,
        "POST",
        "v1/accounts:signUp",
        {
            targetProjectId: projectId,
            email,
            password: pw,
            emailVerified: true,
            disabled: false,
        }
    );
    if (![200, 201].includes(created.status)) {
        throw new Error(`create ${role} GCIP user returned ${created.status}: ${created.text}`);
    }
    const uid = String(created.json?.localId ?? "");
    if (!uid) {
        throw new Error(`create ${role} GCIP user returned no localId: ${created.text}`);
    }

    const signIn = await fetch(
        `${IDENTITY_ORIGIN}/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password: pw, returnSecureToken: true }),
        }
    );
    const signInBody = (await signIn.json()) as Json;
    if (!signIn.ok || signInBody.localId !== uid) {
        throw new Error(`signInWithPassword failed for ${role}: ${JSON.stringify(signInBody)}`);
    }

    await addSecretVersion(projectId, emailSecret, email);
    await addSecretVersion(projectId, passwordSecret, pw);
    await addSecretVersion(projectId, uidSecret, uid);
    return { status: "created", email, uid };
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", "zkvote-prod-hhyyj");
    const serviceAccount = env(
        "GCP_CI_DEPLOY_SERVICE_ACCOUNT",
        `zkvote-prod-ci-deployer@${projectId}.iam.gserviceaccount.com`
    );
    const siteId = env("FIREBASE_SITE_ID", projectId);
    const evidencePath =
        optionalEnv("FIREBASE_SETUP_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `production-firebase-setup-${runId}.json`);
    const evidence: Evidence = {
        status: "running",
        runId,
        startedAt: new Date().toISOString(),
        projectId,
        serviceAccount,
        checks: {},
        caveats: [],
    };
    writeEvidence(evidencePath, evidence);

    try {
        if (process.env.CONFIRM_COSTS !== "yes") {
            throw new Error("Refusing to run: set CONFIRM_COSTS=yes after explicit approval.");
        }
        const token = await accessToken();
        const firebaseProject = await ensureFirebaseProject(token, projectId);
        const identityPlatform = await ensureIdentityPlatform(token, projectId);
        const emailPasswordSignIn = await ensureEmailPasswordSignIn(token, projectId);
        const googleSignIn = await ensureGoogleSignIn(token, projectId);
        const webConfig = await ensureWebApp(token, projectId);
        if (webConfig.projectId !== projectId) {
            throw new Error(`Firebase web config projectId ${webConfig.projectId} != ${projectId}`);
        }
        const hostingSite = await ensureHostingSite(token, projectId, siteId);
        await addSecretVersion(projectId, "zkvote-prod-firebase-web-api-key", webConfig.apiKey);
        const [superadmin, voter] = await Promise.all([
            createIdentityUser(token, projectId, webConfig.apiKey, "superadmin"),
            createIdentityUser(token, projectId, webConfig.apiKey, "voter"),
        ]);

        evidence.checks = {
            firebaseProject,
            identityPlatform,
            emailPasswordSignIn,
            googleSignIn,
            webConfig: {
                projectId: webConfig.projectId,
                appId: webConfig.appId,
                authDomain: webConfig.authDomain ?? `${projectId}.firebaseapp.com`,
                apiKey: { set: true, length: webConfig.apiKey.length },
            },
            hostingSite,
            e2eUsers: { superadmin, voter },
        };
        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`production Firebase setup PASSED; evidence=${evidencePath}`);
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
