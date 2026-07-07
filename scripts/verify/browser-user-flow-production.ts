#!/usr/bin/env tsx
/**
 * Production browser user-flow QA.
 *
 * This is intentionally broader than browser-smoke-production.ts: it drives the
 * deployed Firebase Hosting UI like a user and leaves a synthetic production
 * election, contract, vote transaction, screenshots, and JSON evidence.
 */
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type ConsoleMessage, type Page, type Response as PlaywrightResponse } from "@playwright/test";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");

const DEFAULT_PROJECT_ID = "zkvote-prod-hhyyj";
const DEFAULT_REGION = "asia-northeast3";
const DEFAULT_HOSTING_URL = "https://zkvote-prod-hhyyj.web.app";
const DEFAULT_API_URL = "https://zkvote-prod-api-afq4ond6ha-du.a.run.app";
const DEFAULT_SERVICE = "zkvote-prod-api";

const DEFAULT_SECRET_NAMES = {
    superadminEmail: "zkvote-prod-e2e-superadmin-email",
    superadminPassword: "zkvote-prod-e2e-superadmin-password",
    voterEmail: "zkvote-prod-e2e-voter-email",
    voterPassword: "zkvote-prod-e2e-voter-password",
} as const;

type Json = Record<string, unknown>;

interface ApiObservation {
    method?: string;
    status: number;
    url: string;
    json?: unknown;
}

interface DialogObservation {
    type: string;
    message: string;
    defaultValue?: string;
    acceptedWith?: string;
}

interface SubmitRequestObservation {
    url: string;
    method: string;
    authorizationHeaderPresent: boolean;
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
    hostingUrl: string;
    apiBaseUrl: string;
    electionName: string;
    checks: Record<string, unknown>;
    apiResponses: Record<string, ApiObservation>;
    submitRequests: SubmitRequestObservation[];
    dialogs: DialogObservation[];
    screenshots: Record<string, string>;
    consoleErrors: string[];
    pageErrors: string[];
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

function writeEvidence(filePath: string, evidence: Evidence): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

function invocation(): string {
    return ["node", "--import", "tsx", path.relative(PROJECT_ROOT, fileURLToPath(import.meta.url))]
        .join(" ");
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

function consoleLine(message: ConsoleMessage): string {
    return `[${message.type()}] ${message.text()}`;
}

function toDateTimeLocal(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        "-",
        pad(date.getMonth() + 1),
        "-",
        pad(date.getDate()),
        "T",
        pad(date.getHours()),
        ":",
        pad(date.getMinutes()),
    ].join("");
}

async function responseJson(response: PlaywrightResponse): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function observeResponse(
    page: Page,
    label: string,
    evidence: Evidence,
    pathFragment: string,
    action: () => Promise<void>,
    timeoutMs = 120_000
): Promise<PlaywrightResponse> {
    const responsePromise = page.waitForResponse(
        (candidate) => candidate.url().includes(pathFragment),
        { timeout: timeoutMs }
    );
    await action();
    const response = await responsePromise;
    const observed: ApiObservation = {
        status: response.status(),
        url: response.url(),
        json: await responseJson(response),
    };
    const request = response.request();
    observed.method = request.method();
    evidence.apiResponses[label] = observed;
    assert(response.ok(), `${label} returned ${response.status()}`);
    return response;
}

async function screenshot(
    page: Page,
    evidence: Evidence,
    screenshotDir: string,
    label: string
): Promise<void> {
    const filePath = path.join(screenshotDir, `${label}.png`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, fullPage: true });
    evidence.screenshots[label] = path.relative(PROJECT_ROOT, filePath);
}

async function login(
    page: Page,
    evidence: Evidence,
    email: string,
    password: string,
    expectedHeading: string
): Promise<void> {
    await page.goto(`${evidence.hostingUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("이메일").fill(email);
    await page.getByLabel("비밀번호").fill(password);
    await observeResponse(page, `login:${expectedHeading}:me`, evidence, "/api/me", async () => {
        await page.getByRole("button", { name: "로그인", exact: true }).click();
    }, 60_000);
    await page.getByRole("heading", { name: expectedHeading }).waitFor({ timeout: 60_000 });
}

async function logout(page: Page): Promise<void> {
    await page.getByRole("button", { name: "로그아웃" }).click();
    await page.getByRole("heading", { name: "ZK-VOTE 로그인" }).waitFor({ timeout: 60_000 });
}

async function rowForElection(page: Page, electionName: string) {
    const row = page.locator("li").filter({ hasText: electionName }).first();
    await row.waitFor({ state: "visible", timeout: 60_000 });
    return row;
}

function extractElectionIdFromText(text: string): string | undefined {
    return text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
}

function extractJsonString(json: unknown, pathParts: string[]): string | undefined {
    let current: unknown = json;
    for (const part of pathParts) {
        if (!current || typeof current !== "object") return undefined;
        current = (current as Json)[part];
    }
    return typeof current === "string" ? current : undefined;
}

function relativeToProject(filePath: string): string {
    return path.relative(PROJECT_ROOT, filePath);
}

function lastNonEmptyLine(output: string): string {
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

async function verifyContractsOnEtherscan(
    evidence: Evidence,
    electionId: string,
    electionName: string
): Promise<void> {
    if (optionalEnv("ETHERSCAN_VERIFY_AFTER_DEPLOY") === "false") {
        evidence.caveats.push("Etherscan source verification skipped by ETHERSCAN_VERIFY_AFTER_DEPLOY=false.");
        return;
    }
    const verificationEvidencePath =
        optionalEnv("ETHERSCAN_VERIFY_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `production-etherscan-verify-${evidence.runId}.json`);
    const { stdout, stderr } = await execFile(
        "node",
        ["--import", "tsx", "scripts/verify/verify-production-contracts-etherscan.ts"],
        {
            cwd: PROJECT_ROOT,
            timeout: Number(optionalEnv("ETHERSCAN_VERIFY_AFTER_DEPLOY_TIMEOUT_MS") ?? "900000"),
            maxBuffer: 8 * 1024 * 1024,
            env: {
                ...process.env,
                VERIFY_ELECTION_ID: electionId,
                VERIFY_ELECTION_NAME: electionName,
                ETHERSCAN_VERIFY_EVIDENCE_PATH: verificationEvidencePath,
            },
        }
    );
    evidence.checks.etherscanVerification = {
        status: "passed",
        evidence: relativeToProject(verificationEvidencePath),
        stdout: lastNonEmptyLine(stdout),
        stderr: lastNonEmptyLine(stderr),
    };
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", DEFAULT_PROJECT_ID);
    const region = env("GCP_REGION", DEFAULT_REGION);
    const service = env("CLOUD_RUN_SERVICE", DEFAULT_SERVICE);
    const hostingUrl = env("FIREBASE_HOSTING_URL", DEFAULT_HOSTING_URL).replace(/\/$/, "");
    const apiBaseUrl = env("PROD_BASE_URL", env("PRODUCTION_BASE_URL", DEFAULT_API_URL)).replace(/\/$/, "");
    const electionName = env("UI_QA_ELECTION_NAME", `ui-qa-${runId}`);
    const voterDisplayName = env("UI_QA_VOTER_NAME", `UI QA Voter ${runId}`);
    const voteWindowSeconds = Number(optionalEnv("UI_QA_VOTE_WINDOW_SECONDS") ?? "180");
    assert(Number.isInteger(voteWindowSeconds) && voteWindowSeconds >= 90, "UI_QA_VOTE_WINDOW_SECONDS must be an integer >= 90");

    const [superadminEmail, superadminPassword, voterEmail, voterPassword] = await Promise.all([
        envOrSecret(projectId, "E2E_SUPERADMIN_EMAIL", DEFAULT_SECRET_NAMES.superadminEmail),
        envOrSecret(projectId, "E2E_SUPERADMIN_PASSWORD", DEFAULT_SECRET_NAMES.superadminPassword),
        envOrSecret(projectId, "E2E_VOTER_EMAIL", DEFAULT_SECRET_NAMES.voterEmail),
        envOrSecret(projectId, "E2E_VOTER_PASSWORD", DEFAULT_SECRET_NAMES.voterPassword),
    ]);

    const evidencePath =
        optionalEnv("BROWSER_USER_FLOW_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `production-browser-user-flow-${runId}.json`);
    const screenshotDir =
        optionalEnv("BROWSER_USER_FLOW_SCREENSHOT_DIR") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `production-browser-user-flow-${runId}`);
    const evidence: Evidence = {
        status: "running",
        runId,
        command: invocation(),
        startedAt: new Date().toISOString(),
        projectId,
        region,
        service,
        hostingUrl,
        apiBaseUrl,
        electionName,
        checks: {},
        apiResponses: {},
        submitRequests: [],
        dialogs: [],
        screenshots: {},
        consoleErrors: [],
        pageErrors: [],
        caveats: [
            "Production synthetic UI QA: leaves DB rows, Firebase/Auth usage, GCS artifact references, and Sepolia transactions.",
        ],
    };
    writeEvidence(evidencePath, evidence);

    const browser = await chromium.launch({
        channel: optionalEnv("PLAYWRIGHT_CHANNEL") ?? "chrome",
        headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    });

    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(Number(optionalEnv("UI_QA_DEFAULT_TIMEOUT_MS") ?? "60000"));
        page.on("console", (message) => {
            if (message.type() === "error") evidence.consoleErrors.push(consoleLine(message));
        });
        page.on("pageerror", (error) => {
            evidence.pageErrors.push(error.message);
        });
        page.on("request", (request) => {
            if (request.method() === "POST" && request.url().includes("/api/elections/") && request.url().endsWith("/submit")) {
                const headers = request.headers();
                evidence.submitRequests.push({
                    url: request.url(),
                    method: request.method(),
                    authorizationHeaderPresent: Object.keys(headers).some((key) => key.toLowerCase() === "authorization"),
                });
            }
        });
        page.on("dialog", async (dialog) => {
            const observation: DialogObservation = {
                type: dialog.type(),
                message: dialog.message(),
                defaultValue: dialog.defaultValue(),
            };
            if (dialog.type() === "prompt") {
                observation.acceptedWith = voterDisplayName;
                evidence.dialogs.push(observation);
                await dialog.accept(voterDisplayName);
                return;
            }
            evidence.dialogs.push(observation);
            await dialog.accept();
        });

        await login(page, evidence, superadminEmail, superadminPassword, "관리자 대시보드");
        await screenshot(page, evidence, screenshotDir, "01-admin-dashboard");

        await page.getByRole("button", { name: "투표 생성" }).click();
        await page.getByRole("heading", { name: "새로운 투표 생성" }).waitFor();
        await page.getByLabel("투표 이름").fill(electionName);
        await page.getByLabel("유권자 등록 마감 시간").fill(toDateTimeLocal(new Date(Date.now() + 15 * 60_000)));
        await page.getByRole("radio", { name: "Depth 4" }).check();
        await page.getByRole("textbox", { name: "후보 1" }).fill("UI-QA-A");
        await page.getByRole("textbox", { name: "후보 2" }).fill("UI-QA-B");
        await screenshot(page, evidence, screenshotDir, "02-admin-create-election");
        await observeResponse(page, "createElection", evidence, "/api/elections/set", async () => {
            await page.getByRole("button", { name: "투표 생성하기" }).click();
        });
        await page.getByRole("heading", { name: "관리자 대시보드" }).waitFor();
        const createdRow = await rowForElection(page, electionName);
        const createdText = await createdRow.innerText();
        const electionId = extractElectionIdFromText(createdText);
        assert(electionId, `could not extract election id from row: ${createdText}`);
        evidence.checks.election = { electionId };
        await screenshot(page, evidence, screenshotDir, "03-admin-election-created");

        await createdRow.getByRole("button", { name: "유권자 등록" }).click();
        await page.getByRole("heading", { name: `'${electionName}' 유권자 등록` }).waitFor();
        await page.locator("textarea").fill(voterEmail);
        await observeResponse(page, "allowlistVoter", evidence, `/api/elections/${electionId}/voters`, async () => {
            await page.getByRole("button", { name: "등록 실행" }).click();
        });

        const deployRow = await rowForElection(page, electionName);
        await observeResponse(page, "setZkDeploy", evidence, `/api/elections/${electionId}/setZkDeploy`, async () => {
            await deployRow.getByRole("button", { name: "ZK 설정 & 배포" }).click();
            await page.getByRole("dialog").getByRole("button", { name: "확인" }).click();
        }, Number(optionalEnv("UI_QA_DEPLOY_TIMEOUT_MS") ?? "300000"));
        const deploymentJson = evidence.apiResponses.setZkDeploy?.json;
        const contractAddress = extractJsonString(deploymentJson, ["contractAddress"]);
        const verifierAddress = extractJsonString(deploymentJson, ["verifierAddress"]);
        const deployTxHash = extractJsonString(deploymentJson, ["deployTxHash"]);
        evidence.checks.deployment = { contractAddress, verifierAddress, deployTxHash };
        await verifyContractsOnEtherscan(evidence, electionId, electionName);
        await screenshot(page, evidence, screenshotDir, "04-admin-deployed");

        await logout(page);

        await login(page, evidence, voterEmail, voterPassword, "ZK-VOTE");
        const registerableRow = await rowForElection(page, electionName);
        await screenshot(page, evidence, screenshotDir, "05-voter-registerable");
        await observeResponse(page, "voterRegister", evidence, `/api/elections/${electionId}/register`, async () => {
            await registerableRow.getByRole("button", { name: "등록하기" }).click();
            await page.getByLabel("등록 이름").fill(voterDisplayName);
            await page.getByRole("dialog").getByRole("button", { name: "등록하기" }).click();
        });
        await screenshot(page, evidence, screenshotDir, "06-voter-registered");
        await logout(page);

        await login(page, evidence, superadminEmail, superadminPassword, "관리자 대시보드");
        const finalizeRow = await rowForElection(page, electionName);
        await finalizeRow.getByRole("button", { name: "등록 마감" }).click();
        await page.getByRole("heading", { name: `'${electionName}' 등록 마감` }).waitFor();
        const voteEnd = new Date(Date.now() + voteWindowSeconds * 1000);
        await page.locator('input[type="datetime-local"]').fill(toDateTimeLocal(voteEnd));
        await observeResponse(page, "finalize", evidence, `/api/elections/${electionId}/finalize`, async () => {
            await page.getByRole("button", { name: "마감 및 투표 시작" }).click();
        }, Number(optionalEnv("UI_QA_FINALIZE_TIMEOUT_MS") ?? "300000"));
        evidence.checks.finalize = { voteEnd: voteEnd.toISOString() };
        await screenshot(page, evidence, screenshotDir, "07-admin-finalized");
        await logout(page);

        await login(page, evidence, voterEmail, voterPassword, "ZK-VOTE");
        const votableRow = await rowForElection(page, electionName);
        await screenshot(page, evidence, screenshotDir, "08-voter-votable");
        await votableRow.getByRole("button", { name: "투표하기" }).click();
        await page.getByRole("heading", { name: electionName }).waitFor();
        await page.getByText("UI-QA-A", { exact: true }).click();
        await screenshot(page, evidence, screenshotDir, "09-vote-page-selected");

        await observeResponse(page, "proof", evidence, `/api/elections/${electionId}/proof`, async () => {
            await page.getByRole("button", { name: "투표 제출하기" }).click();
        }, Number(optionalEnv("UI_QA_PROOF_TIMEOUT_MS") ?? "120000"));
        await observeResponse(page, "submit", evidence, `/api/elections/${electionId}/submit`, async () => {
            await page.getByText("증명 제출 중").waitFor({
                timeout: Number(optionalEnv("UI_QA_SUBMIT_STAGE_TIMEOUT_MS") ?? "240000"),
            });
        }, Number(optionalEnv("UI_QA_SUBMIT_TIMEOUT_MS") ?? "300000"));

        assert(evidence.submitRequests.length > 0, "no anonymous submit request was observed");
        assert(
            evidence.submitRequests.every((request) => request.authorizationHeaderPresent === false),
            "anonymous submit request carried an Authorization header"
        );
        const submitJson = evidence.apiResponses.submit?.json;
        evidence.checks.submit = {
            transactionHash: extractJsonString(submitJson, ["transactionHash"]),
            anonymousAuthorizationHeader: "omitted",
        };
        await page.getByRole("heading", { name: "ZK-VOTE" }).waitFor({ timeout: 60_000 });
        const completedHint = page.getByText(electionName).locator("..").getByText("투표 완료");
        await completedHint.waitFor({ timeout: 60_000 }).catch(() => undefined);
        await screenshot(page, evidence, screenshotDir, "10-voter-after-submit");

        evidence.checks.accounts = {
            superadminEmail,
            voterEmail,
        };
        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`production browser user flow PASSED; evidence=${evidencePath}`);
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
