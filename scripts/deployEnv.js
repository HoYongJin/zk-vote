const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

const SUPABASE_ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY"];

function parseEnvFile(envPath) {
    try {
        return dotenv.parse(fs.readFileSync(envPath));
    } catch (err) {
        if (err && err.code === "ENOENT") {
            return {};
        }
        throw err;
    }
}

function loadRootEnv(rootEnvPath = path.join(__dirname, "..", ".env")) {
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
function loadServerSupabaseEnv(serverEnvPath = path.join(__dirname, "migration", ".env")) {
    const parsed = parseEnvFile(serverEnvPath);
    const applied = {};

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
} = {}) {
    loadRootEnv(rootEnvPath);
    return loadServerSupabaseEnv(serverEnvPath);
}

module.exports = {
    SUPABASE_ENV_KEYS,
    loadDeployEnv,
    loadRootEnv,
    loadServerSupabaseEnv,
    parseEnvFile,
};
