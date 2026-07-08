import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CloudSqlProxyBinary {
    path: string;
    cleanup?: () => void;
}

function optionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

function rejectUnsafeExplicitProxyBin(proxyBin: string): void {
    if (
        proxyBin === "/tmp" ||
        proxyBin.startsWith("/tmp/") ||
        proxyBin === "/private/tmp" ||
        proxyBin.startsWith("/private/tmp/")
    ) {
        throw new Error(`Refusing E2E_CLOUD_SQL_PROXY_BIN under a shared temporary directory: ${proxyBin}`);
    }
}

function platformSuffix(): string {
    const platform = os.platform() === "darwin" ? "darwin" : "linux";
    const arch = os.arch() === "arm64" ? "arm64" : "amd64";
    return `${platform}.${arch}`;
}

export function prepareCloudSqlProxyBinary(envName = "E2E_CLOUD_SQL_PROXY_BIN"): CloudSqlProxyBinary {
    const explicit = optionalEnv(envName);
    if (explicit) {
        rejectUnsafeExplicitProxyBin(explicit);
        fs.accessSync(explicit, fs.constants.X_OK);
        return { path: explicit };
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-cloud-sql-proxy-"));
    fs.chmodSync(tempDir, 0o700);
    const proxyPath = path.join(tempDir, "cloud-sql-proxy");
    const url = `https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.${platformSuffix()}`;
    const result = spawnSync("curl", ["-fsSL", "-o", proxyPath, url], { stdio: "inherit" });
    if (result.status !== 0) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw new Error(`Failed to download cloud-sql-proxy from ${url}`);
    }
    fs.chmodSync(proxyPath, 0o700);
    return {
        path: proxyPath,
        cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
}
