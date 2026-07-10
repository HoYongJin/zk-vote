import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_JOB = "zkvote-prod-db-readback";
const RESULT_PREFIX = "ZKVOTE_DB_READBACK=";

export type ReadbackMode = "e2e" | "reconcile" | "deployment" | "latest-deployment";
export type Json = Record<string, unknown>;

interface LogEntry {
    textPayload?: unknown;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function optionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

function assertUuid(value: string): void {
    assert(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
        "Cloud Run DB readback requires a UUID election id"
    );
}

async function gcloud(args: string[], timeout = 6 * 60_000): Promise<string> {
    const { stdout } = await execFile("gcloud", args, {
        maxBuffer: 8 * 1024 * 1024,
        timeout,
    });
    return stdout.trim();
}

async function latestExecution(projectId: string, region: string, job: string): Promise<string> {
    const execution = await gcloud([
        "run",
        "jobs",
        "executions",
        "list",
        "--job",
        job,
        "--project",
        projectId,
        "--region",
        region,
        "--sort-by",
        "~metadata.creationTimestamp",
        "--limit",
        "1",
        "--format=value(metadata.name)",
    ]);
    assert(execution, `Cloud Run DB readback job ${job} returned no execution`);
    return execution;
}

async function readResult(projectId: string, job: string, execution: string): Promise<unknown> {
    const filter = [
        'resource.type="cloud_run_job"',
        `resource.labels.job_name="${job}"`,
        `labels."run.googleapis.com/execution_name"="${execution}"`,
    ].join(" AND ");

    const deadline = Date.now() + 45_000;
    let lastOutput = "";
    while (Date.now() < deadline) {
        const raw = await gcloud([
            "logging",
            "read",
            filter,
            "--project",
            projectId,
            "--order",
            "asc",
            "--limit",
            "100",
            "--format=json",
        ]);
        const entries = raw ? (JSON.parse(raw) as LogEntry[]) : [];
        for (const entry of entries) {
            const text = typeof entry.textPayload === "string" ? entry.textPayload.trim() : "";
            if (!text) continue;
            lastOutput = text;
            const marker = text.indexOf(RESULT_PREFIX);
            if (marker < 0) continue;
            const json = text.slice(marker + RESULT_PREFIX.length).trim();
            return JSON.parse(json) as unknown;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(
        `Cloud Run DB readback execution ${execution} did not emit ${RESULT_PREFIX}; last log=${lastOutput}`
    );
}

export async function runProductionDbReadbackJob(options: {
    projectId: string;
    region: string;
    mode: ReadbackMode;
    electionId?: string;
}): Promise<{ job: string; execution: string; result: unknown }> {
    const job = optionalEnv("PRODUCTION_DB_READBACK_JOB") ?? DEFAULT_JOB;
    if (options.mode === "e2e" || options.mode === "deployment") {
        assert(options.electionId, `${options.mode} DB readback requires election id`);
        assertUuid(options.electionId);
    }

    const updates = [`READBACK_MODE=${options.mode}`];
    if (options.mode === "e2e" || options.mode === "deployment") {
        updates.push(`READBACK_ELECTION_ID=${options.electionId}`);
    }

    try {
        await gcloud([
            "run",
            "jobs",
            "execute",
            job,
            "--project",
            options.projectId,
            "--region",
            options.region,
            "--update-env-vars",
            updates.join(","),
            "--wait",
            "--quiet",
        ]);
    } catch (error) {
        throw new Error(
            `Cloud Run DB readback job ${job} failed. Deploy it with scripts/iac/deploy-production-db-readback-job.sh: ${String(error)}`
        );
    }

    const execution = await latestExecution(options.projectId, options.region, job);
    const result = await readResult(options.projectId, job, execution);
    return { job, execution, result };
}
