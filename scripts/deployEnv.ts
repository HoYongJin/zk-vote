import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPABASE_ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY"];

function parseEnvFile(envPath: string): Record<string, string> {
    try {
        return dotenv.parse(fs.readFileSync(envPath));
    } catch (err) {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return {};
        }
        throw err;
    }
}

function loadRootEnv(rootEnvPath: string = path.join(__dirname, "..", ".env")): Record<string, string> {
    const parsed = parseEnvFile(rootEnvPath);

    for (const [key, value] of Object.entries(parsed)) {
        if (SUPABASE_ENV_KEYS.includes(key)) {
            continue;
        }
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }

    return parsed;
}

// The legacy Supabase service-role creds used to live in server/.env. After the
// Node→Rust deletion (Phase 6.5) the secondary Supabase env for the deploy/ETL
// tooling lives at scripts/migration/.env (gitignored) — the same file the
// vendored scripts/migration/supabaseClient.js loads.
function loadServerSupabaseEnv(
    serverEnvPath: string = path.join(__dirname, "migration", ".env")
): Record<string, string> {
    const parsed = parseEnvFile(serverEnvPath);
    const applied: Record<string, string> = {};

    for (const key of SUPABASE_ENV_KEYS) {
        if (parsed[key]) {
            process.env[key] = parsed[key];
            applied[key] = parsed[key];
        }
    }

    return applied;
}

function loadDeployEnv({
    rootEnvPath = path.join(__dirname, "..", ".env"),
    serverEnvPath = path.join(__dirname, "migration", ".env"),
}: { rootEnvPath?: string; serverEnvPath?: string } = {}): Record<string, string> {
    loadRootEnv(rootEnvPath);
    return loadServerSupabaseEnv(serverEnvPath);
}

export {
    SUPABASE_ENV_KEYS,
    loadDeployEnv,
    loadRootEnv,
    loadServerSupabaseEnv,
    parseEnvFile,
};
