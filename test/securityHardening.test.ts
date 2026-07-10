import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isAllowedExternalRedisUrl } from "../scripts/verify/redisSecurity";

const PROJECT_ROOT = process.cwd();

function read(relPath: string): string {
    return fs.readFileSync(path.join(PROJECT_ROOT, relPath), "utf8");
}

describe("security hardening regressions", function () {
    it("pins GitHub WIF to repository, production environment, main branch, and deploy workflow", function () {
        const wif = read("scripts/iac/setup-production-github-wif.sh");

        expect(wif).toContain("attribute.workflow_ref=assertion.job_workflow_ref");
        expect(wif).toContain("assertion.repository == '${GITHUB_REPOSITORY}'");
        expect(wif).toContain("assertion.environment == '${GITHUB_ENVIRONMENT}'");
        expect(wif).toContain("assertion.ref == '${GITHUB_REF}'");
        expect(wif).toContain("assertion.job_workflow_ref == '${GITHUB_WORKFLOW_REF}'");
        expect(wif).toContain(".github/workflows/deploy-production.yml@${GITHUB_REF}");
    });

    it("uses the dedicated production GCIP JWKS secret", function () {
        const deployment = read("scripts/cicd/deploy-production-api.sh");

        expect(deployment).toContain('AUTH_JWKS_URL=zkvote-prod-auth-jwks-url:latest');
        expect(deployment).toContain('SUPABASE_JWKS_URL=zkvote-prod-auth-jwks-url:latest');
    });

    it("preserves explicit cost approval when loading the local env file", function () {
        const productionSetup = read("scripts/iac/zkvote-production-setup.sh");
        const dbReadbackJob = read("scripts/iac/deploy-production-db-readback-job.sh");

        expect(productionSetup).toContain('EXTERNAL_CONFIRM_COSTS="${CONFIRM_COSTS:-}"');
        expect(productionSetup).toContain('CONFIRM_COSTS="${EXTERNAL_CONFIRM_COSTS}"');
        expect(dbReadbackJob).toContain('EXTERNAL_CONFIRM_COSTS="${CONFIRM_COSTS:-}"');
        expect(dbReadbackJob).toContain('CONFIRM_COSTS="${EXTERNAL_CONFIRM_COSTS}"');
    });

    it("keeps the production E2E nullifier out of persisted evidence and uses a production-side DB readback", function () {
        const e2e = read("scripts/verify/e2e-production.ts");
        const readbackJob = read("scripts/iac/deploy-production-db-readback-job.sh");

        expect(e2e).toContain("runProductionDbReadbackJob");
        expect(e2e).not.toContain("E2E_DATABASE_URL");
        expect(e2e).not.toContain("response: submit.json,\n            nullifier,");
        expect(readbackJob).toContain("postgres:16.14-alpine3.24@sha256:");
        expect(readbackJob).toContain("zkvote-prod-readonly-database-url:latest");
        expect(read("infra/gcp/production-db-readback-entrypoint.sh")).toContain("invalid READBACK_ELECTION_ID");
    });

    it("routes production DB readback through the fixed readonly Cloud Run Job", function () {
        const productionReadbackScripts = [
            "scripts/verify/e2e-production.ts",
            "scripts/verify/reconcile-production-tally.ts",
            "scripts/verify/verify-production-contracts-etherscan.ts",
        ];

        for (const script of productionReadbackScripts) {
            const source = read(script);
            expect(source).toContain("runProductionDbReadbackJob");
            expect(source).not.toContain('"zkvote-prod-migrator-database-url"');
        }
        expect(read("scripts/iac/deploy-production-db-readback-job.sh")).toContain(
            "zkvote-prod-readonly-database-url:latest"
        );
        const productionSetup = read("scripts/iac/zkvote-production-setup.sh");
        const runtimeGrantStart = productionSetup.indexOf("for secret_name in \\\n  zkvote-prod-database-url");
        const runtimeGrantBlock = productionSetup.slice(
            runtimeGrantStart,
            productionSetup.indexOf("\n\n# The API identity", runtimeGrantStart)
        );
        expect(runtimeGrantBlock).not.toContain("zkvote-prod-postgres-password");
        expect(runtimeGrantBlock).not.toContain("zkvote-prod-migrator-database-url");
        expect(productionSetup).toContain("The API identity needs its application URL");
        expect(productionSetup).toContain("gcloud secrets remove-iam-policy-binding");
    });

    it("requires TLS for external Redis URLs", function () {
        expect(isAllowedExternalRedisUrl("rediss://default:pw@example.upstash.io:6379")).toBe(true);
        expect(isAllowedExternalRedisUrl("redis://127.0.0.1:6379")).toBe(false);
        expect(isAllowedExternalRedisUrl("http://redis.example")).toBe(false);

        const productionSetup = read("scripts/iac/zkvote-production-setup.sh");
        expect(productionSetup).toContain("STANDARD_HA");
    });

    it("runs every production database operation inside Cloud Run jobs", function () {
        const productionDatabaseScripts = [
            "scripts/iac/bootstrap-production-superadmin.sh",
            "scripts/migration/migrate-production-cloudsql.sh",
            "scripts/verify/e2e-production.ts",
            "scripts/verify/reconcile-production-tally.ts",
            "scripts/verify/verify-production-contracts-etherscan.ts",
        ];

        for (const script of productionDatabaseScripts) {
            const source = read(script);
            expect(source).not.toContain("cloud-sql-proxy");
        }
        const migration = read("scripts/migration/migrate-production-cloudsql.sh");
        expect(migration).toContain("gcloud run jobs deploy");
        expect(migration).toContain("gcloud run jobs delete");
        expect(migration).toContain("--set-cloudsql-instances");
        expect(migration).toContain("dirty working tree");
        expect(read("infra/gcp/production-migrate.Dockerfile")).toContain("@sha256:");
    });

    it("keeps role passwords off psql argv and keeps recovery jobs from parsing database URLs", function () {
        const rolesSql = read("rust-backend/db/roles.sql");
        const localRoles = read("scripts/local/db-roles.sh");
        const migrationEntrypoint = read("infra/gcp/production-migrate-entrypoint.sh");
        const productionGrantRepair = read("scripts/iac/apply-production-readonly-grants.sh");

        expect(rolesSql).toContain("zkvote_readonly");
        expect(rolesSql).toContain("GRANT SELECT ON");
        expect(localRoles).toContain("set_config('zkvote.readonly_password'");
        expect(migrationEntrypoint).toContain("missing expected Cloud SQL roles");
        expect(migrationEntrypoint).not.toContain("database_password_from_url");
        expect(migrationEntrypoint).not.toContain("MIGRATOR_PASSWORD");
        expect(localRoles).not.toMatch(/-v\s+\w*password=/);
        expect(migrationEntrypoint).not.toMatch(/-v\s+\w*password=/);
        expect(productionGrantRepair).toContain("zkvote-prod-postgres-password:latest");
        expect(productionGrantRepair).toContain("gcloud run jobs delete");
        expect(productionGrantRepair).toContain("gcloud secrets remove-iam-policy-binding");
        expect(productionGrantRepair).toContain("gcloud projects remove-iam-policy-binding");
        expect(productionGrantRepair).toContain("gcloud iam service-accounts delete");
        expect(productionGrantRepair).not.toContain("zkvote-prod-api@");
    });

    it("verifies Firebase ID token claims before bootstrapping the production superadmin", function () {
        const bootstrap = read("scripts/iac/bootstrap-production-superadmin.sh");
        const entrypoint = read("infra/gcp/production-superadmin-bootstrap-entrypoint.sh");

        expect(bootstrap).toContain("claims.email_verified !== true");
        expect(bootstrap).toContain("claims.sub");
        expect(bootstrap).toContain("claims.email");
        expect(bootstrap).toContain("claims.iss");
        expect(bootstrap).toContain("claims.aud");
        expect(bootstrap).toContain("--data-binary @-");
        expect(bootstrap).toContain("gcloud run jobs delete");
        expect(entrypoint).toContain("email_verified, last_seen_at");
    });
});
