#!/usr/bin/env tsx
/**
 * Render a Firebase Hosting config with environment-specific CSP origins.
 *
 * firebase.json stays a checked-in baseline. Deploy jobs render this file so
 * staging and production can keep exact connect-src origins without committing
 * a different firebase.json for each environment.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../..");

type HeaderRule = {
    source?: string;
    glob?: string;
    regex?: string;
    headers?: Array<{ key: string; value: string }>;
};

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

function originFromUrl(value: string): string {
    return new URL(value).origin;
}

function cspValue(): string {
    const apiOrigin = originFromUrl(env("VITE_API_BASE_URL"));
    const firebaseAuthDomain = env("VITE_FIREBASE_AUTH_DOMAIN");
    const firebaseAuthOrigin = firebaseAuthDomain.startsWith("http")
        ? originFromUrl(firebaseAuthDomain)
        : `https://${firebaseAuthDomain}`;
    const extra = optionalEnv("FIREBASE_CSP_CONNECT_SRC")
        ?.split(/\s+/)
        .map((v) => v.trim())
        .filter(Boolean) ?? [];
    const connectSrc = [
        "'self'",
        apiOrigin,
        "https://identitytoolkit.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://www.googleapis.com",
        "https://firebaseinstallations.googleapis.com",
        firebaseAuthOrigin,
        ...extra,
    ];
    const uniqueConnectSrc = [...new Set(connectSrc)];
    return [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src ${uniqueConnectSrc.join(" ")}`,
        "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com https://*.google.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
    ].join("; ");
}

function main(): void {
    const input = path.resolve(PROJECT_ROOT, optionalEnv("FIREBASE_CONFIG_INPUT") ?? "firebase.json");
    const output = path.resolve(PROJECT_ROOT, optionalEnv("FIREBASE_CONFIG_OUTPUT") ?? "firebase.generated.json");
    const config = JSON.parse(fs.readFileSync(input, "utf8")) as {
        hosting?: { headers?: HeaderRule[] };
    };
    const headers = config.hosting?.headers;
    if (!headers) throw new Error(`${input} has no hosting.headers`);
    const csp = cspValue();
    let updated = false;
    for (const rule of headers) {
        for (const header of rule.headers ?? []) {
            if (header.key.toLowerCase() === "content-security-policy") {
                header.value = csp;
                updated = true;
            }
        }
    }
    if (!updated) throw new Error(`${input} has no Content-Security-Policy header`);
    fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Rendered Firebase Hosting config: ${path.relative(PROJECT_ROOT, output)}`);
}

main();
