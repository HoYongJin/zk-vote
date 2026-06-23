/**
 * @file scripts/migration/import-users-to-gcip.ts
 * @desc One-time, idempotent migration of Supabase Auth users into GCP Identity
 * Platform (GCIP / Firebase Auth) — PROJECT_PLAN Phase 7.
 *
 * Why this shape (load-bearing — see PROJECT_PLAN §0.3):
 *   - The Rust extractor parses the JWT `sub` via `Uuid::parse_str`
 *     (crates/api/src/auth/mod.rs) and `admins.id` / `voters.user_id` are
 *     UUID-typed. GCIP's native uid is a 28-char string, so we MUST set each
 *     migrated user's GCIP `uid` = their existing Supabase UUID. Then `sub`
 *     stays a UUID, every FK resolves, and NO voter re-registers.
 *   - Passwords migrate verbatim: Supabase/GoTrue stores bcrypt in
 *     `auth.users.encrypted_password`; GCIP `importUsers` accepts the raw bcrypt
 *     hash with `{ hash: { algorithm: 'BCRYPT' } }`.
 *   - Invariant #8: `emailVerified` is set from the user's ACTUAL Supabase
 *     status (`email_confirmed_at IS NOT NULL`), NEVER unconditionally true. A
 *     Supabase-unverified user imports as unverified and is dropped as a join
 *     key by the backend (RUST-AUTH-2).
 *
 * Partitioning (PROJECT_PLAN Phase 7):
 *   - "password users" have a usable bcrypt `encrypted_password` -> bulk import.
 *   - "OAuth-only users" (legacy Kakao) have no bcrypt hash -> they CANNOT be
 *     password-imported. They are written to a documented-exclusion report and
 *     re-onboard via Google sign-in (same email -> same admin/voter row, Phase
 *     16) or a password-reset enrollment. Recording them keeps the Phase-20
 *     id-set cross-check a partition match, not a false 1:1.
 *
 * Idempotency: `importUsers` upserts by uid, so re-runs converge. The script
 * never relaxes `emailVerified` because it always recomputes it from source.
 *
 * Inputs (env):
 *   SOURCE_DATABASE_URL  Supabase Postgres DSN with read access to the `auth`
 *                        schema (auth.users, auth.identities). REQUIRED — the
 *                        REST/JS admin API does NOT expose password hashes.
 *   GCIP_PROJECT_ID      Target GCIP/Firebase project id (e.g. zkvote-staging).
 *   GOOGLE_APPLICATION_CREDENTIALS  Path to the Firebase Admin service-account
 *                        JSON (gitignored — never commit it).
 *   CONFIRM_COSTS=yes    Required for a real import (creates GCIP identities /
 *                        MAU). Omit for --dry-run.
 *
 * Usage:
 *   # safe preview — reads + partitions + validates, writes nothing to GCIP:
 *   SOURCE_DATABASE_URL=postgres://...supabase... \
 *     node scripts/migration/import-users-to-gcip.js --dry-run
 *
 *   # real import (after explicit approval):
 *   CONFIRM_COSTS=yes GCIP_PROJECT_ID=zkvote-staging \
 *   GOOGLE_APPLICATION_CREDENTIALS=/secure/zkvote-staging-admin.json \
 *   SOURCE_DATABASE_URL=postgres://...supabase... \
 *     node scripts/migration/import-users-to-gcip.js
 */

import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

interface SourceUser {
    id: string;
    email: string | null;
    encrypted_password: string | null;
    email_verified: boolean;
    providers: string[];
}

interface ExcludedUser {
    id: string;
    email?: string | null;
    providers: string[];
}

interface FirebaseRecord {
    uid: string;
    email: string | null;
    emailVerified: boolean;
    passwordHash: Buffer;
}

interface ImportResult {
    success: number;
    failure: number;
    errors: Array<{ uid: string | undefined; reason: string | undefined }>;
}

const DRY_RUN = process.argv.includes("--dry-run");
const IMPORT_BATCH_SIZE = 1000; // Firebase importUsers hard cap is 1000/call.
const BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"];

function isUsableBcrypt(hash: unknown): boolean {
    return typeof hash === "string" && BCRYPT_PREFIXES.some((p) => hash.startsWith(p));
}

/**
 * Read every Supabase auth user with its providers. We read auth.users for the
 * UUID / email / bcrypt hash / verified timestamp and aggregate auth.identities
 * for the provider partition (a user may have several identities).
 */
async function loadSourceUsers(sourceUrl: string): Promise<SourceUser[]> {
    const client = new Client({ connectionString: sourceUrl });
    await client.connect();
    try {
        const { rows } = await client.query(
            `SELECT u.id::text                              AS id,
                    u.email                                 AS email,
                    u.encrypted_password                    AS encrypted_password,
                    (u.email_confirmed_at IS NOT NULL)      AS email_verified,
                    COALESCE(
                        array_agg(i.provider) FILTER (WHERE i.provider IS NOT NULL),
                        '{}'
                    )                                       AS providers
               FROM auth.users u
          LEFT JOIN auth.identities i ON i.user_id = u.id
              WHERE u.deleted_at IS NULL
           GROUP BY u.id, u.email, u.encrypted_password, u.email_confirmed_at
           ORDER BY u.id`
        );
        return rows;
    } finally {
        await client.end();
    }
}

/**
 * Split source rows into password users (importable) and OAuth-only users
 * (excluded). A row is password-importable iff it has a usable bcrypt hash AND
 * a non-empty email (the GCIP import + the email-keyed authority both need it).
 */
function partition(rows: SourceUser[]): {
    passwordUsers: SourceUser[];
    oauthOnly: ExcludedUser[];
    skippedNoEmail: ExcludedUser[];
} {
    const passwordUsers: SourceUser[] = [];
    const oauthOnly: ExcludedUser[] = [];
    const skippedNoEmail: ExcludedUser[] = [];
    for (const row of rows) {
        if (!row.email) {
            skippedNoEmail.push({ id: row.id, providers: row.providers });
            continue;
        }
        if (isUsableBcrypt(row.encrypted_password)) {
            passwordUsers.push(row);
        } else {
            oauthOnly.push({ id: row.id, email: row.email, providers: row.providers });
        }
    }
    return { passwordUsers, oauthOnly, skippedNoEmail };
}

function toFirebaseRecord(row: SourceUser): FirebaseRecord {
    return {
        uid: row.id, // == Supabase UUID -> keeps JWT `sub` a UUID (PROJECT_PLAN §0.3)
        email: row.email,
        emailVerified: row.email_verified === true, // actual status only (invariant #8)
        passwordHash: Buffer.from(row.encrypted_password as string, "utf8"), // raw bcrypt bytes
    };
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function importBatches(passwordUsers: SourceUser[]): Promise<ImportResult> {
    // Lazily import firebase-admin so --dry-run (and `node --check`) need neither
    // the dependency installed nor credentials present. Typed `any` to preserve
    // the original script's exact namespace API surface (admin.apps /
    // admin.credential / admin.auth()) byte-for-byte — a mechanical migration
    // must not alter which runtime members are accessed.
    const admin: any = (await import("firebase-admin")).default;
    const projectId = process.env.GCIP_PROJECT_ID;
    if (!projectId) {
        throw new Error("GCIP_PROJECT_ID is required for a real import.");
    }
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        throw new Error(
            "GOOGLE_APPLICATION_CREDENTIALS (path to the gitignored Firebase Admin service-account JSON) is required."
        );
    }
    if (!admin.apps.length) {
        admin.initializeApp({ projectId, credential: admin.credential.applicationDefault() });
    }
    const auth = admin.auth();

    let success = 0;
    let failure = 0;
    const errors: Array<{ uid: string | undefined; reason: string | undefined }> = [];
    for (const [batchIndex, batch] of chunk(passwordUsers, IMPORT_BATCH_SIZE).entries()) {
        const records = batch.map(toFirebaseRecord);
        // BCRYPT: GCIP verifies the raw bcrypt hash directly; no rounds/key needed.
        const result = await auth.importUsers(records as any, { hash: { algorithm: "BCRYPT" } });
        success += result.successCount;
        failure += result.failureCount;
        for (const err of result.errors || []) {
            const offending = records[err.index];
            errors.push({ uid: offending && offending.uid, reason: err.error && err.error.message });
        }
        console.log(
            `  batch ${batchIndex + 1}: +${result.successCount} ok, ${result.failureCount} failed`
        );
    }
    return { success, failure, errors };
}

async function main(): Promise<void> {
    const sourceUrl = process.env.SOURCE_DATABASE_URL;
    if (!sourceUrl) {
        throw new Error(
            "SOURCE_DATABASE_URL is required (Supabase Postgres DSN with auth-schema read access)."
        );
    }
    if (!DRY_RUN && process.env.CONFIRM_COSTS !== "yes") {
        throw new Error(
            "Refusing to import: set CONFIRM_COSTS=yes after explicit user approval (creates GCIP identities), or pass --dry-run."
        );
    }

    console.log(`[import-users-to-gcip] reading source users${DRY_RUN ? " (DRY RUN)" : ""}...`);
    const rows = await loadSourceUsers(sourceUrl);
    const { passwordUsers, oauthOnly, skippedNoEmail } = partition(rows);

    console.log(`Source users:        ${rows.length}`);
    console.log(`Password-importable: ${passwordUsers.length}`);
    console.log(`OAuth-only (excluded from password import): ${oauthOnly.length}`);
    if (oauthOnly.length) {
        console.log("  -> re-onboard via Google (same email) or password-reset enrollment (Phase 16).");
        for (const u of oauthOnly) {
            console.log(`     EXCLUDED ${u.id} <${u.email}> providers=[${u.providers.join(",")}]`);
        }
    }
    if (skippedNoEmail.length) {
        console.log(`Skipped (no email — cannot key authority): ${skippedNoEmail.length}`);
        for (const u of skippedNoEmail) {
            console.log(`     SKIPPED ${u.id} providers=[${u.providers.join(",")}]`);
        }
    }

    if (DRY_RUN) {
        console.log("\nDRY RUN — nothing written to GCIP.");
        const verifiedCount = passwordUsers.filter((u) => u.email_verified).length;
        console.log(
            `Would import ${passwordUsers.length} users (uid=Supabase UUID, BCRYPT); ` +
                `${verifiedCount} emailVerified, ${passwordUsers.length - verifiedCount} unverified.`
        );
        return;
    }

    console.log(`\nImporting ${passwordUsers.length} users to GCIP (uid=UUID, BCRYPT)...`);
    const { success, failure, errors } = await importBatches(passwordUsers);
    console.log(`\nDone. imported=${success} failed=${failure}`);
    if (errors.length) {
        console.log("Failures:");
        for (const e of errors) console.log(`  ${e.uid}: ${e.reason}`);
    }

    // Cross-check input: the set the Phase-20 ETL must reconcile against is
    // exactly { imported password uids } ∪ { documented OAuth-only uids }.
    console.log(
        `\nPhase-20 cross-check sets: imported=${success}, oauth-only-excluded=${oauthOnly.length}, ` +
            `total-accounted=${success + oauthOnly.length}/${rows.length - skippedNoEmail.length}`
    );
    if (failure > 0) {
        process.exitCode = 1; // surface partial failure to the operator / CI
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(err.stack || String(err));
        process.exit(1);
    });
}

export { partition, isUsableBcrypt, toFirebaseRecord, chunk };
