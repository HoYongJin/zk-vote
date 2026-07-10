#!/usr/bin/env tsx
/**
 * Firebase Hosting browser smoke for production.
 *
 * This is intentionally narrower than the API E2E: it proves the deployed SPA
 * boots, Firebase email/password login works, and the browser reaches the API
 * through the configured VITE_API_BASE_URL.
 */
import fs from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type ConsoleMessage, type Page } from "@playwright/test";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const execFile = promisify(execFileCallback);
const DEFAULT_PROJECT_ID = "zkvote-prod-hhyyj";
const DEFAULT_SECRET_NAMES = {
    voterEmail: "zkvote-prod-e2e-voter-email",
    voterPassword: "zkvote-prod-e2e-voter-password",
} as const;

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    command: string;
    startedAt: string;
    finishedAt?: string;
    hostingUrl: string;
    checks: Record<string, unknown>;
    consoleErrors: string[];
    pageErrors: string[];
    screenshot?: string;
    failure?: string;
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

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function writeEvidence(filePath: string, evidence: Evidence): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

function consoleLine(message: ConsoleMessage): string {
    return `[${message.type()}] ${message.text()}`;
}

function invocation(): string {
    return ["node", "--import", "tsx", path.relative(PROJECT_ROOT, fileURLToPath(import.meta.url))]
        .join(" ");
}

async function waitForApiResponse(
    page: Page,
    pathFragment: string
): Promise<{ status: number; url: string }> {
    const response = await page.waitForResponse(
        (candidate) => candidate.url().includes(pathFragment),
        { timeout: Number(optionalEnv("BROWSER_SMOKE_API_TIMEOUT_MS") ?? "30000") }
    );
    return { status: response.status(), url: response.url() };
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", DEFAULT_PROJECT_ID);
    const hostingUrl = env("FIREBASE_HOSTING_URL", `https://${projectId}.web.app`).replace(/\/$/, "");
    const email = await envOrSecret(projectId, "E2E_VOTER_EMAIL", DEFAULT_SECRET_NAMES.voterEmail);
    const password = await envOrSecret(
        projectId,
        "E2E_VOTER_PASSWORD",
        DEFAULT_SECRET_NAMES.voterPassword
    );
    const evidencePath =
        optionalEnv("BROWSER_SMOKE_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `production-browser-smoke-${runId}.json`);
    const screenshotPath =
        optionalEnv("BROWSER_SMOKE_SCREENSHOT_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `production-browser-smoke-${runId}.png`);
    const evidence: Evidence = {
        status: "running",
        runId,
        command: invocation(),
        startedAt: new Date().toISOString(),
        hostingUrl,
        checks: {},
        consoleErrors: [],
        pageErrors: [],
    };

    const browser = await chromium.launch({
        channel: optionalEnv("PLAYWRIGHT_CHANNEL") ?? "chrome",
        headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    });

    try {
        const page = await browser.newPage();
        page.on("console", (message) => {
            if (message.type() === "error") {
                evidence.consoleErrors.push(consoleLine(message));
            }
        });
        page.on("pageerror", (error) => {
            evidence.pageErrors.push(error.message);
        });

        await page.goto(`${hostingUrl}/login`, { waitUntil: "domcontentloaded" });
        await page.getByLabel("이메일").fill(email);
        await page.getByLabel("비밀번호").fill(password);

        const meResponse = waitForApiResponse(page, "/api/me");
        const registerableResponse = waitForApiResponse(page, "/api/elections/registerable");
        await page.getByRole("button", { name: "로그인", exact: true }).click();
        const [meApi, registerableApi] = await Promise.all([meResponse, registerableResponse]);

        assert(meApi.status === 200, `/api/me returned ${meApi.status}`);
        assert(
            registerableApi.status === 200,
            `/api/elections/registerable returned ${registerableApi.status}`
        );
        await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30000 });
        await page.getByRole("heading", { name: "ZK-VOTE" }).waitFor({ timeout: 30000 });

        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, fullPage: true });
        evidence.screenshot = screenshotPath;
        evidence.checks = {
            appBooted: true,
            loginRedirected: true,
            apiMe: meApi,
            registerable: registerableApi,
        };
        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`browser smoke PASSED; evidence=${evidencePath}; screenshot=${screenshotPath}`);
    } catch (error) {
        evidence.status = "failed";
        evidence.finishedAt = new Date().toISOString();
        evidence.failure = error instanceof Error ? error.message : String(error);
        writeEvidence(evidencePath, evidence);
        throw error;
    } finally {
        await browser.close();
    }
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
