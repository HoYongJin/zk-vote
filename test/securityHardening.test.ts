import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prepareCloudSqlProxyBinary } from "../scripts/verify/cloudSqlProxy";
import { isAllowedExternalRedisUrl } from "../scripts/verify/redisSecurity";

const PROJECT_ROOT = process.cwd();

function read(relPath: string): string {
    return fs.readFileSync(path.join(PROJECT_ROOT, relPath), "utf8");
}

describe("security hardening regressions", function () {
    afterEach(function () {
        delete process.env.E2E_CLOUD_SQL_PROXY_BIN;
    });

    it("pins GitHub WIF to repository, environment, main branch, and Firebase deploy workflow", function () {
        const wif = read("scripts/iac/setup-github-wif.sh");

        expect(wif).toContain("attribute.workflow_ref=assertion.job_workflow_ref");
        expect(wif).toContain("assertion.repository == '${GITHUB_REPOSITORY}'");
        expect(wif).toContain("assertion.environment == '${GITHUB_ENVIRONMENT}'");
        expect(wif).toContain("assertion.ref == '${GITHUB_REF}'");
        expect(wif).toContain("assertion.job_workflow_ref == '${GITHUB_WORKFLOW_REF}'");
        expect(wif).toContain(".github/workflows/deploy-frontend-firebase.yml@${GITHUB_REF}");
    });

    it("uses fixed GCIP JWKS in staging setup instead of inherited Supabase/Auth overrides", function () {
        const stagingSetup = read("scripts/iac/zkvote-staging-setup.sh");

        expect(stagingSetup).toContain('AUTH_JWKS_URL="${GCIP_JWKS_DEFAULT}"');
        expect(stagingSetup).not.toContain(
            'AUTH_JWKS_URL="${AUTH_JWKS_URL:-${SUPABASE_JWKS_URL:-$GCIP_JWKS_DEFAULT}}"'
        );
    });

    it("defaults production DB readback to the readonly database secret", function () {
        const productionReadbackScripts = [
            "scripts/verify/e2e-production.ts",
            "scripts/verify/reconcile-production-tally.ts",
            "scripts/verify/verify-production-contracts-etherscan.ts",
        ];

        for (const script of productionReadbackScripts) {
            const source = read(script);
            expect(source).toContain('"zkvote-prod-readonly-database-url"');
            expect(source).not.toContain('"zkvote-prod-migrator-database-url"');
        }
    });

    it("requires TLS for external Redis URLs", function () {
        expect(isAllowedExternalRedisUrl("rediss://default:pw@example.upstash.io:6379")).toBe(true);
        expect(isAllowedExternalRedisUrl("redis://127.0.0.1:6379")).toBe(false);
        expect(isAllowedExternalRedisUrl("http://redis.example")).toBe(false);

        const stagingSetup = read("scripts/iac/zkvote-staging-setup.sh");
        const stagingPreflight = read("scripts/verify/preflight-staging.ts");
        expect(stagingSetup).toContain("assert_external_redis_url");
        expect(stagingPreflight).toContain("isAllowedExternalRedisUrl");
    });

    it("does not use shared /tmp proxy defaults or pass Cloud SQL proxy OAuth tokens in argv", function () {
        const hardenedProxyScripts = [
            "scripts/iac/bootstrap-staging-superadmin.sh",
            "scripts/migration/migrate-cloudsql.sh",
            "scripts/verify/e2e-staging.ts",
            "scripts/verify/reconcile-staging-tally.ts",
            "scripts/verify/verify-contracts-etherscan.ts",
        ];

        for (const script of hardenedProxyScripts) {
            const source = read(script);
            expect(source).not.toContain("/tmp/cloud-sql-proxy");
            expect(source).not.toContain("print-access-token");
            expect(source).not.toContain("--token");
        }

        const helper = read("scripts/lib/cloud-sql-proxy.sh");
        expect(helper).toContain("mktemp -d");
        expect(helper).toContain("Refusing PROXY_BIN under a shared temporary directory");
        expect(helper).not.toContain("print-access-token");
        expect(helper).not.toContain("--token");

        process.env.E2E_CLOUD_SQL_PROXY_BIN = "/tmp/cloud-sql-proxy";
        expect(() => prepareCloudSqlProxyBinary()).toThrow(/shared temporary directory/);
    });

    it("keeps role passwords off psql argv and adds a readonly DB role", function () {
        const rolesSql = read("rust-backend/db/roles.sql");
        const localRoles = read("scripts/local/db-roles.sh");
        const cloudSqlMigration = read("scripts/migration/migrate-cloudsql.sh");

        expect(rolesSql).toContain("zkvote_readonly");
        expect(rolesSql).toContain("GRANT SELECT ON");
        expect(localRoles).toContain("set_config('zkvote.readonly_password'");
        expect(cloudSqlMigration).toContain("set_config('zkvote.readonly_password'");
        expect(localRoles).not.toMatch(/-v\s+\w*password=/);
        expect(cloudSqlMigration).not.toMatch(/-v\s+\w*password=/);
    });

    it("verifies Firebase ID token claims before bootstrapping the staging superadmin", function () {
        const bootstrap = read("scripts/iac/bootstrap-staging-superadmin.sh");

        expect(bootstrap).toContain("claims.email_verified !== true");
        expect(bootstrap).toContain("claims.sub");
        expect(bootstrap).toContain("claims.email");
        expect(bootstrap).toContain("claims.iss");
        expect(bootstrap).toContain("claims.aud");
        expect(bootstrap).toContain("email_verified, last_seen_at");
    });
});
