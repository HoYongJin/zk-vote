import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDeployEnv } from "../scripts/deployEnv";

describe("deploy env loader", function () {
    const trackedKeys = [
        "PRIVATE_KEY",
        "SEPOLIA_RPC_URL",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_KEY",
    ];
    let previousEnv: Record<string, string | undefined>;
    let tempDir: string;

    beforeEach(function () {
        previousEnv = {};
        for (const key of trackedKeys) {
            previousEnv[key] = process.env[key];
            delete process.env[key];
        }
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-deploy-env-"));
    });

    afterEach(function () {
        for (const key of trackedKeys) {
            if (previousEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = previousEnv[key];
            }
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("keeps root chain vars but lets the migration env own Supabase vars", function () {
        const rootEnvPath = path.join(tempDir, ".env");
        const serverEnvPath = path.join(tempDir, "server.env");
        fs.writeFileSync(
            rootEnvPath,
            [
                "PRIVATE_KEY=0xroot",
                "SEPOLIA_RPC_URL=https://root-rpc.example",
                "SUPABASE_URL=replace-me",
                "SUPABASE_SERVICE_ROLE_KEY=replace-me-key",
            ].join("\n")
        );
        fs.writeFileSync(
            serverEnvPath,
            [
                "SUPABASE_URL=https://server.supabase.co",
                "SUPABASE_SERVICE_ROLE_KEY=server-service-role",
            ].join("\n")
        );

        const applied = loadDeployEnv({ rootEnvPath, serverEnvPath });

        expect(process.env.PRIVATE_KEY).toBe("0xroot");
        expect(process.env.SEPOLIA_RPC_URL).toBe("https://root-rpc.example");
        expect(process.env.SUPABASE_URL).toBe("https://server.supabase.co");
        expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe("server-service-role");
        expect(applied).toEqual({
            SUPABASE_URL: "https://server.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "server-service-role",
        });
    });

    it("does not leak root Supabase vars when the migration env omits them", function () {
        const rootEnvPath = path.join(tempDir, ".env");
        const serverEnvPath = path.join(tempDir, "server.env");
        fs.writeFileSync(
            rootEnvPath,
            [
                "PRIVATE_KEY=0xroot",
                "SUPABASE_URL=https://wrong-root.supabase.co",
                "SUPABASE_SERVICE_ROLE_KEY=wrong-root-service-role",
                "SUPABASE_KEY=wrong-root-anon",
            ].join("\n")
        );
        fs.writeFileSync(serverEnvPath, "SUPABASE_URL=https://server.supabase.co\n");

        const applied = loadDeployEnv({ rootEnvPath, serverEnvPath });

        expect(process.env.PRIVATE_KEY).toBe("0xroot");
        expect(process.env.SUPABASE_URL).toBe("https://server.supabase.co");
        expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe(undefined);
        expect(process.env.SUPABASE_KEY).toBe(undefined);
        expect(applied).toEqual({
            SUPABASE_URL: "https://server.supabase.co",
        });
    });

    it("ignores non-Supabase variables from the migration env", function () {
        const rootEnvPath = path.join(tempDir, ".env");
        const serverEnvPath = path.join(tempDir, "server.env");
        fs.writeFileSync(rootEnvPath, "PRIVATE_KEY=0xroot\nSEPOLIA_RPC_URL=https://root-rpc.example\n");
        fs.writeFileSync(
            serverEnvPath,
            [
                "PRIVATE_KEY=0xserver-should-not-apply",
                "SEPOLIA_RPC_URL=https://server-rpc-should-not-apply.example",
                "SUPABASE_SERVICE_ROLE_KEY=server-service-role",
            ].join("\n")
        );

        const applied = loadDeployEnv({ rootEnvPath, serverEnvPath });

        expect(process.env.PRIVATE_KEY).toBe("0xroot");
        expect(process.env.SEPOLIA_RPC_URL).toBe("https://root-rpc.example");
        expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe("server-service-role");
        expect(applied).toEqual({
            SUPABASE_SERVICE_ROLE_KEY: "server-service-role",
        });
    });
});
