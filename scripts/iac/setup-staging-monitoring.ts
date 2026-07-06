#!/usr/bin/env tsx
/**
 * Idempotent Cloud Monitoring / Logging setup for the staging project.
 *
 * The script does not read application secrets. It obtains a short-lived gcloud
 * access token in-process so live tokens are not placed on a curl command line.
 */
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");
const MONITORING_ORIGIN = "https://monitoring.googleapis.com";
const LOGGING_ORIGIN = "https://logging.googleapis.com";

type JsonObject = Record<string, unknown>;

interface Evidence {
    status: "running" | "passed" | "failed";
    runId: string;
    command: string;
    startedAt: string;
    finishedAt?: string;
    projectId: string;
    region: string;
    service: string;
    alertEmail?: string;
    apiUrl?: string;
    checks: Record<string, unknown>;
    caveats: string[];
    failure?: string;
}

interface MetricDescriptor {
    type: string;
    unit?: string;
    labels?: Array<{ key: string }>;
}

interface NotificationChannel {
    name: string;
    type: string;
    displayName?: string;
    labels?: Record<string, string>;
    verificationStatus?: string;
    enabled?: boolean;
}

interface AlertPolicy {
    name: string;
    displayName: string;
}

interface LogMetric {
    name: string;
}

interface UptimeCheckConfig {
    name: string;
    displayName: string;
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

async function runGcloud(args: string[]): Promise<string> {
    const { stdout } = await execFile("gcloud", args, {
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
    });
    return stdout.trim();
}

async function accessToken(): Promise<string> {
    const token = await runGcloud(["auth", "print-access-token"]);
    if (!token) throw new Error("gcloud returned an empty access token");
    return token;
}

async function api<T>(
    origin: string,
    token: string,
    method: string,
    apiPath: string,
    body?: unknown
): Promise<T> {
    const response = await fetch(`${origin}/${apiPath.replace(/^\//, "")}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`${method} ${apiPath} returned ${response.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
}

async function listAll<T>(
    origin: string,
    token: string,
    apiPath: string,
    key: string
): Promise<T[]> {
    const output: T[] = [];
    let pageToken: string | undefined;
    do {
        const separator = apiPath.includes("?") ? "&" : "?";
        const pathWithPage = pageToken
            ? `${apiPath}${separator}pageToken=${encodeURIComponent(pageToken)}`
            : apiPath;
        const page = await api<Record<string, unknown>>(origin, token, "GET", pathWithPage);
        const items = page[key];
        if (Array.isArray(items)) output.push(...(items as T[]));
        pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    } while (pageToken);
    return output;
}

function metricFilter(type: string, rest: string[] = []): string {
    return [`metric.type="${type}"`, ...rest].join(" AND ");
}

function resourceFilter(type: string, labels: Record<string, string>): string[] {
    return [
        `resource.type="${type}"`,
        ...Object.entries(labels).map(([key, value]) => `resource.labels.${key}="${value}"`),
    ];
}

function hasMetricLabel(descriptor: MetricDescriptor | undefined, label: string): boolean {
    return Boolean(descriptor?.labels?.some((candidate) => candidate.key === label));
}

async function metricDescriptor(
    token: string,
    projectId: string,
    metricType: string
): Promise<MetricDescriptor | undefined> {
    const params = new URLSearchParams({
        filter: `metric.type = "${metricType}"`,
        pageSize: "1",
    });
    const result = await api<{ metricDescriptors?: MetricDescriptor[] }>(
        MONITORING_ORIGIN,
        token,
        "GET",
        `v3/projects/${projectId}/metricDescriptors?${params.toString()}`
    );
    return result.metricDescriptors?.[0];
}

function thresholdCondition(
    displayName: string,
    filter: string,
    thresholdValue: number,
    options: {
        comparison?: "COMPARISON_GT" | "COMPARISON_LT";
        duration?: string;
        perSeriesAligner?: string;
        crossSeriesReducer?: string;
        alignmentPeriod?: string;
        groupByFields?: string[];
    } = {}
): JsonObject {
    const aggregation: JsonObject = {
        alignmentPeriod: options.alignmentPeriod ?? "60s",
        perSeriesAligner: options.perSeriesAligner ?? "ALIGN_MEAN",
    };
    if (options.crossSeriesReducer) aggregation.crossSeriesReducer = options.crossSeriesReducer;
    if (options.groupByFields) aggregation.groupByFields = options.groupByFields;
    return {
        displayName,
        conditionThreshold: {
            filter,
            comparison: options.comparison ?? "COMPARISON_GT",
            thresholdValue,
            duration: options.duration ?? "300s",
            trigger: { count: 1 },
            aggregations: [aggregation],
        },
    };
}

function absenceCondition(
    displayName: string,
    filter: string,
    options: { duration?: string; perSeriesAligner?: string; alignmentPeriod?: string } = {}
): JsonObject {
    return {
        displayName,
        conditionAbsent: {
            filter,
            duration: options.duration ?? "600s",
            aggregations: [
                {
                    alignmentPeriod: options.alignmentPeriod ?? "60s",
                    perSeriesAligner: options.perSeriesAligner ?? "ALIGN_MEAN",
                },
            ],
        },
    };
}

async function ensureNotificationChannel(
    token: string,
    projectId: string,
    email: string | undefined,
    evidence: Evidence
): Promise<string[]> {
    if (!email) {
        evidence.caveats.push("ALERT_EMAIL is missing and no active gcloud account was found; policies were created without notification channels.");
        return [];
    }
    const displayName = "[staging] zk-vote primary email";
    const channels = await listAll<NotificationChannel>(
        MONITORING_ORIGIN,
        token,
        `v3/projects/${projectId}/notificationChannels?pageSize=200`,
        "notificationChannels"
    );
    const existing = channels.find(
        (channel) =>
            channel.type === "email" &&
            channel.labels?.email_address?.toLowerCase() === email.toLowerCase()
    );
    if (existing) {
        evidence.checks.notificationChannel = {
            status: "exists",
            name: existing.name,
            verificationStatus: existing.verificationStatus ?? "unknown",
            enabled: existing.enabled ?? "unknown",
        };
        if (existing.verificationStatus !== "VERIFIED") {
            evidence.caveats.push(
                `Notification channel ${email} verification is ${existing.verificationStatus ?? "unknown"}; confirm it in Google Cloud Monitoring before relying on email delivery.`
            );
        }
        return [existing.name];
    }

    const created = await api<NotificationChannel>(
        MONITORING_ORIGIN,
        token,
        "POST",
        `v3/projects/${projectId}/notificationChannels`,
        {
            type: "email",
            displayName,
            description: "Primary staging alert contact for zk-vote.",
            labels: { email_address: email },
            enabled: true,
            userLabels: { app: "zkvote", env: "staging", managed_by: "codex" },
        }
    );
    evidence.checks.notificationChannel = {
        status: "created",
        name: created.name,
        verificationStatus: created.verificationStatus ?? "unknown",
    };
    evidence.caveats.push(`Google may require verifying the new email notification channel: ${email}.`);
    return [created.name];
}

async function ensureLogMetric(
    token: string,
    projectId: string,
    metric: {
        name: string;
        displayName: string;
        description: string;
        filter: string;
    }
): Promise<"created" | "exists"> {
    const metrics = await listAll<LogMetric>(
        LOGGING_ORIGIN,
        token,
        `v2/projects/${projectId}/metrics?pageSize=200`,
        "metrics"
    );
    if (metrics.some((candidate) => candidate.name === metric.name)) return "exists";
    await api<LogMetric>(LOGGING_ORIGIN, token, "POST", `v2/projects/${projectId}/metrics`, {
        name: metric.name,
        description: metric.description,
        filter: metric.filter,
        metricDescriptor: {
            metricKind: "DELTA",
            valueType: "INT64",
            unit: "1",
            displayName: metric.displayName,
        },
    });
    return "created";
}

async function ensureUptimeCheck(
    token: string,
    projectId: string,
    apiUrl: string,
    evidence: Evidence
): Promise<UptimeCheckConfig> {
    const displayName = "[staging] zk-vote API /readyz";
    const existing = (
        await listAll<UptimeCheckConfig>(
            MONITORING_ORIGIN,
            token,
            `v3/projects/${projectId}/uptimeCheckConfigs?pageSize=200`,
            "uptimeCheckConfigs"
        )
    ).find((candidate) => candidate.displayName === displayName);
    if (existing) {
        evidence.checks.uptimeCheck = { status: "exists", name: existing.name };
        return existing;
    }

    const url = new URL(apiUrl);
    const created = await api<UptimeCheckConfig>(
        MONITORING_ORIGIN,
        token,
        "POST",
        `v3/projects/${projectId}/uptimeCheckConfigs`,
        {
            displayName,
            monitoredResource: {
                type: "uptime_url",
                labels: {
                    project_id: projectId,
                    host: url.host,
                },
            },
            httpCheck: {
                path: "/readyz",
                port: 443,
                useSsl: true,
                validateSsl: true,
                requestMethod: "GET",
            },
            period: "60s",
            timeout: "10s",
            selectedRegions: ["ASIA_PACIFIC", "EUROPE", "USA"],
            userLabels: { app: "zkvote", env: "staging", managed_by: "codex" },
        }
    );
    evidence.checks.uptimeCheck = { status: "created", name: created.name };
    return created;
}

async function ensureAlertPolicy(
    token: string,
    projectId: string,
    policy: JsonObject,
    evidence: Evidence
): Promise<void> {
    const displayName = String(policy.displayName);
    const policies = await listAll<AlertPolicy>(
        MONITORING_ORIGIN,
        token,
        `v3/projects/${projectId}/alertPolicies?pageSize=200`,
        "alertPolicies"
    );
    const existing = policies.find((candidate) => candidate.displayName === displayName);
    const policyChecks = (evidence.checks.alertPolicies as Record<string, unknown> | undefined) ?? {};
    if (existing) {
        policyChecks[displayName] = { status: "exists", name: existing.name };
        evidence.checks.alertPolicies = policyChecks;
        return;
    }
    const created = await api<AlertPolicy>(
        MONITORING_ORIGIN,
        token,
        "POST",
        `v3/projects/${projectId}/alertPolicies`,
        policy
    );
    policyChecks[displayName] = { status: "created", name: created.name };
    evidence.checks.alertPolicies = policyChecks;
}

function alertPolicy(
    displayName: string,
    condition: JsonObject,
    notificationChannels: string[],
    content: string
): JsonObject {
    return {
        displayName,
        combiner: "OR",
        conditions: [condition],
        notificationChannels,
        documentation: {
            content,
            mimeType: "text/markdown",
        },
        enabled: true,
        userLabels: { app: "zkvote", env: "staging", managed_by: "codex" },
    };
}

async function maybePolicy(
    token: string,
    projectId: string,
    metricType: string,
    build: (descriptor: MetricDescriptor) => JsonObject | undefined,
    evidence: Evidence
): Promise<void> {
    const descriptor = await metricDescriptor(token, projectId, metricType);
    const metricChecks = (evidence.checks.metricDescriptors as Record<string, unknown> | undefined) ?? {};
    metricChecks[metricType] = descriptor
        ? { status: "exists", unit: descriptor.unit ?? "", labels: (descriptor.labels ?? []).map((label) => label.key) }
        : { status: "missing" };
    evidence.checks.metricDescriptors = metricChecks;
    if (!descriptor) {
        evidence.caveats.push(`Skipped alert policy because metric descriptor is missing: ${metricType}`);
        return;
    }
    const policy = build(descriptor);
    if (!policy) return;
    await ensureAlertPolicy(token, projectId, policy, evidence);
}

async function main(): Promise<void> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const projectId = env("GCP_PROJECT_ID", "zkvote-staging-hhyyj");
    const region = env("GCP_REGION", "asia-northeast3");
    const service = env("CLOUD_RUN_SERVICE", "zkvote-staging-api");
    const activeAccount = await runGcloud([
        "auth",
        "list",
        "--filter=status:ACTIVE",
        "--format=value(account)",
    ]).catch(() => "");
    const alertEmail = optionalEnv("ALERT_EMAIL") ?? activeAccount.split("\n").find(Boolean);
    const serviceUrl =
        optionalEnv("STAGING_BASE_URL") ??
        (await runGcloud([
            "run",
            "services",
            "describe",
            service,
            "--project",
            projectId,
            "--region",
            region,
            "--format=value(status.url)",
        ]));
    const apiUrl = serviceUrl.replace(/\/$/, "");
    const evidencePath =
        optionalEnv("MONITORING_EVIDENCE_PATH") ??
        path.join(PROJECT_ROOT, "docs", "evidence", `staging-monitoring-${runId}.json`);
    const evidence: Evidence = {
        status: "running",
        runId,
        command: invocation(),
        startedAt: new Date().toISOString(),
        projectId,
        region,
        service,
        alertEmail,
        apiUrl,
        checks: {},
        caveats: [],
    };
    writeEvidence(evidencePath, evidence);

    try {
        const token = await accessToken();
        const notificationChannels = await ensureNotificationChannel(token, projectId, alertEmail, evidence);
        const uptime = await ensureUptimeCheck(token, projectId, apiUrl, evidence);
        const uptimeCheckId = uptime.name.split("/").at(-1);
        if (!uptimeCheckId) throw new Error(`Could not parse uptime check id from ${uptime.name}`);

        const runResource = resourceFilter("cloud_run_revision", { service_name: service, location: region });
        const sqlResource = resourceFilter("cloudsql_database", {
            database_id: `${projectId}:zkvote-staging-pg`,
        });
        const redisResource = resourceFilter("redis_instance", {
            project_id: projectId,
            region,
            instance_id: "zkvote-staging-redis",
        });

        const logMetrics = [
            {
                name: "zkvote_chain_unavailable_count",
                displayName: "zk-vote CHAIN_UNAVAILABLE count",
                description: "Counts staged API log entries that contain CHAIN_UNAVAILABLE.",
                filter: `resource.type="cloud_run_revision" resource.labels.service_name="${service}" textPayload:"CHAIN_UNAVAILABLE"`,
            },
            {
                name: "zkvote_finalization_failure_count",
                displayName: "zk-vote finalization failure count",
                description: "Counts staged API log entries for finalization sync/on-chain failures.",
                filter:
                    `resource.type="cloud_run_revision" resource.labels.service_name="${service}" ` +
                    `(textPayload:"FINALIZATION_DB_SYNC_FAILED" OR textPayload:"FINALIZATION_SNAPSHOT_CHANGED" OR textPayload:"ON_CHAIN_ERROR")`,
            },
        ];
        const logMetricChecks: Record<string, string> = {};
        for (const metric of logMetrics) {
            logMetricChecks[metric.name] = await ensureLogMetric(token, projectId, metric);
        }
        evidence.checks.logMetrics = logMetricChecks;

        await maybePolicy(
            token,
            projectId,
            "run.googleapis.com/request_count",
            (descriptor) => {
                if (!hasMetricLabel(descriptor, "response_code_class")) {
                    evidence.caveats.push("Cloud Run request_count lacks response_code_class label; 5xx and auth-spike policies skipped.");
                    return undefined;
                }
                const filter = metricFilter("run.googleapis.com/request_count", [
                    ...runResource,
                    'metric.labels.response_code_class="5xx"',
                ]);
                return alertPolicy(
                    "[staging] zk-vote Cloud Run 5xx",
                    thresholdCondition("[staging] 5xx request rate > 0", filter, 0, {
                        perSeriesAligner: "ALIGN_RATE",
                        crossSeriesReducer: "REDUCE_SUM",
                        groupByFields: ["resource.label.service_name"],
                    }),
                    notificationChannels,
                    "Cloud Run is returning 5xx responses for the staged zk-vote API."
                );
            },
            evidence
        );

        await maybePolicy(
            token,
            projectId,
            "run.googleapis.com/request_count",
            (descriptor) => {
                const responseLabel = hasMetricLabel(descriptor, "response_code") ? "response_code" : "response_code_class";
                const responseValue = responseLabel === "response_code" ? "401" : "4xx";
                if (responseLabel === "response_code_class") {
                    evidence.caveats.push("GCIP auth-failure policy uses 4xx class because Cloud Run request_count has no response_code label.");
                }
                const filter = metricFilter("run.googleapis.com/request_count", [
                    ...runResource,
                    `metric.labels.${responseLabel}="${responseValue}"`,
                ]);
                return alertPolicy(
                    "[staging] zk-vote auth/4xx spike",
                    thresholdCondition("[staging] auth-related request rate > 0.1/s", filter, 0.1, {
                        duration: "300s",
                        perSeriesAligner: "ALIGN_RATE",
                        crossSeriesReducer: "REDUCE_SUM",
                        groupByFields: ["resource.label.service_name"],
                    }),
                    notificationChannels,
                    "Staging API is seeing sustained 401s or 4xx responses. Treat this as a GCIP/audience/CORS regression signal, then confirm from logs."
                );
            },
            evidence
        );

        await maybePolicy(
            token,
            projectId,
            "run.googleapis.com/request_latencies",
            (descriptor) => {
                const threshold = descriptor.unit === "s" ? 2.5 : 2500;
                return alertPolicy(
                    "[staging] zk-vote Cloud Run p95 latency",
                    thresholdCondition(
                        `[staging] p95 latency > ${descriptor.unit === "s" ? "2.5s" : "2500ms"}`,
                        metricFilter("run.googleapis.com/request_latencies", runResource),
                        threshold,
                        {
                            duration: "300s",
                            perSeriesAligner: "ALIGN_PERCENTILE_95",
                            crossSeriesReducer: "REDUCE_PERCENTILE_95",
                            groupByFields: ["resource.label.service_name"],
                        }
                    ),
                    notificationChannels,
                    "Cloud Run p95 latency is above the staging threshold. Check DB, Redis, RPC, and proof artifact serving."
                );
            },
            evidence
        );

        await maybePolicy(
            token,
            projectId,
            "monitoring.googleapis.com/uptime_check/check_passed",
            () =>
                alertPolicy(
                    "[staging] zk-vote /readyz uptime",
                    thresholdCondition(
                        "[staging] uptime check failing",
                        metricFilter("monitoring.googleapis.com/uptime_check/check_passed", [
                            'resource.type="uptime_url"',
                            `metric.labels.check_id="${uptimeCheckId}"`,
                        ]),
                        1,
                        {
                            comparison: "COMPARISON_LT",
                            duration: "300s",
                            alignmentPeriod: "300s",
                            perSeriesAligner: "ALIGN_MEAN",
                            crossSeriesReducer: "REDUCE_MEAN",
                        }
                    ),
                    notificationChannels,
                    "The public `/readyz` uptime check is failing for the staged API."
                ),
            evidence
        );

        await maybePolicy(
            token,
            projectId,
            "cloudsql.googleapis.com/database/up",
            () =>
                alertPolicy(
                    "[staging] zk-vote Cloud SQL unavailable",
                    thresholdCondition(
                        "[staging] Cloud SQL up < 1",
                        metricFilter("cloudsql.googleapis.com/database/up", sqlResource),
                        1,
                        {
                            comparison: "COMPARISON_LT",
                            duration: "300s",
                            alignmentPeriod: "300s",
                            perSeriesAligner: "ALIGN_MEAN",
                        }
                    ),
                    notificationChannels,
                    "Cloud SQL is not reporting healthy for the staging database instance."
                ),
            evidence
        );

        await maybePolicy(
            token,
            projectId,
            "cloudsql.googleapis.com/database/cpu/utilization",
            () =>
                alertPolicy(
                    "[staging] zk-vote Cloud SQL CPU high",
                    thresholdCondition(
                        "[staging] Cloud SQL CPU > 80%",
                        metricFilter("cloudsql.googleapis.com/database/cpu/utilization", sqlResource),
                        0.8
                    ),
                    notificationChannels,
                    "Cloud SQL CPU utilization is sustained above 80%."
                ),
            evidence
        );

        await maybePolicy(
            token,
            projectId,
            "cloudsql.googleapis.com/database/disk/utilization",
            () =>
                alertPolicy(
                    "[staging] zk-vote Cloud SQL disk high",
                    thresholdCondition(
                        "[staging] Cloud SQL disk > 80%",
                        metricFilter("cloudsql.googleapis.com/database/disk/utilization", sqlResource),
                        0.8
                    ),
                    notificationChannels,
                    "Cloud SQL disk utilization is sustained above 80%."
                ),
            evidence
        );

        await maybePolicy(
            token,
            projectId,
            "redis.googleapis.com/stats/memory/usage_ratio",
            () =>
                alertPolicy(
                    "[staging] zk-vote Redis memory high",
                    thresholdCondition(
                        "[staging] Redis memory > 80%",
                        metricFilter("redis.googleapis.com/stats/memory/usage_ratio", redisResource),
                        0.8
                    ),
                    notificationChannels,
                    "Memorystore Redis memory usage is sustained above 80%."
                ),
            evidence
        );

        await maybePolicy(
            token,
            projectId,
            "redis.googleapis.com/server/uptime",
            () =>
                alertPolicy(
                    "[staging] zk-vote Redis metric absent",
                    absenceCondition(
                        "[staging] Redis uptime metric absent",
                        metricFilter("redis.googleapis.com/server/uptime", redisResource)
                    ),
                    notificationChannels,
                    "Memorystore Redis uptime metric disappeared; check instance state and VPC connectivity."
                ),
            evidence
        );

        for (const metric of logMetrics) {
            await ensureAlertPolicy(
                token,
                projectId,
                alertPolicy(
                    `[staging] ${metric.displayName}`,
                    thresholdCondition(
                        `[staging] ${metric.displayName} > 0`,
                        metricFilter(`logging.googleapis.com/user/${metric.name}`, [
                            'resource.type="cloud_run_revision"',
                            `resource.labels.service_name="${service}"`,
                        ]),
                        0,
                        {
                            perSeriesAligner: "ALIGN_RATE",
                            crossSeriesReducer: "REDUCE_SUM",
                            groupByFields: ["resource.label.service_name"],
                        }
                    ),
                    notificationChannels,
                    metric.description
                ),
                evidence
            );
        }

        evidence.status = "passed";
        evidence.finishedAt = new Date().toISOString();
        writeEvidence(evidencePath, evidence);
        console.log(`staging monitoring setup PASSED; evidence=${evidencePath}`);
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
