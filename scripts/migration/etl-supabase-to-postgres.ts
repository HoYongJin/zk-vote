/**
 * @file scripts/migration/etl-supabase-to-postgres.ts
 * @desc One-time cutover ETL (PROJECT_PLAN Phase 20, architecture review
 * AR-H3): copies the hosted-Supabase PascalCase tables into the snake_case
 * Cloud SQL schema (docs/DATA_MODEL.md §1 mapping), then verifies row
 * counts AND content checksums on both sides before reporting success.
 *
 * Privacy invariant: `Voters.user_secret` must contain post-H2 commitments
 * (decimal BN254 field elements). The ETL ABORTS if any value is malformed or
 * outside the scalar field — that would indicate a pre-H2 plaintext-era row or
 * corrupted commitment that must never be copied.
 *
 * Usage (reads hosted Supabase via scripts/migration/.env; target via TARGET_DATABASE_URL):
 *   TARGET_DATABASE_URL=postgres://zkvote:...@localhost:5432/zkvote \
 *     node scripts/migration/etl-supabase-to-postgres.js [--dry-run]
 *
 * --dry-run: extract + transform + verify source counts/checksums, write
 * nothing. Idempotency: rows are upserted by primary key; re-runs converge.
 */

import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isFieldElementString } from "./fieldElement";

const { Client } = pg;

type Row = Record<string, any>;

const DRY_RUN = process.argv.includes("--dry-run");
let supabaseClient: any;
const ELECTION_BASE_COLUMNS = [
    "id",
    "name",
    "merkle_tree_depth",
    "num_candidates",
    "candidates",
    "registration_start_time",
    "registration_end_time",
    "voting_start_time",
    "voting_end_time",
    "merkle_root",
    "contract_address",
    "completed",
];
const ELECTION_OPTIONAL_COLUMNS = ["verifier_address", "superseded_at"];
const ELECTION_CHECKSUM_KEYS = [
    "id",
    "state",
    "name",
    "merkle_tree_depth",
    "num_candidates",
    "candidates",
    "registration_start_time",
    "registration_end_time",
    "voting_start_time",
    "voting_end_time",
    "merkle_root",
    "contract_address",
    "verifier_address",
    "superseded_at",
    "completed",
];
const VOTER_CHECKSUM_KEYS = ["id", "election_id", "email", "user_id", "name", "user_secret"];
const SOURCE_TABLE_ORDER: Record<string, string> = {
    Elections: "id",
    Voters: "id",
    Admins: "id",
    AdminInvitations: "email",
};

function canonicalTimestamp(value: unknown): string {
    if (value == null || value === "") return "";
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value as string | number);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function canonicalJson(value: unknown): string {
    if (value == null || value === "") return "";
    if (typeof value === "string") {
        try {
            return JSON.stringify(JSON.parse(value));
        } catch (_) {
            return value;
        }
    }
    return JSON.stringify(value);
}

function canonicalValue(key: string, value: unknown): string {
    if (key.endsWith("_time") || key.endsWith("_at")) return canonicalTimestamp(value);
    if (key === "candidates") return canonicalJson(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    return value === undefined || value === null ? "" : String(value);
}

function checksum(rows: Row[], keys: string[]): string {
    // Order-independent content hash: hash each row's canonical projection,
    // sort the digests, hash the concatenation.
    const digests = rows
        .map((row) => {
            const projection = JSON.stringify(
                keys.map((key) => [key, canonicalValue(key, row[key])])
            );
            return crypto.createHash("sha256").update(projection).digest("hex");
        })
        .sort();
    return crypto.createHash("sha256").update(digests.join("\n")).digest("hex");
}

function normalizeElectionForChecksum(election: Row): Row {
    return {
        ...election,
        state: election.state || deriveElectionState(election),
        completed: Boolean(election.completed),
        verifier_address: election.verifier_address ?? null,
        superseded_at: election.superseded_at ?? null,
    };
}

function isDecimalFieldElementString(value: unknown): boolean {
    const normalized = String(value);
    return /^[0-9]+$/.test(normalized) && isFieldElementString(normalized);
}

function deriveElectionState(election: Row, now: Date = new Date()): string {
    if (election.superseded_at) return "failed";
    if (Boolean(election.completed)) return "completed";

    const votingStart = election.voting_start_time ? new Date(election.voting_start_time) : null;
    const votingEnd = election.voting_end_time ? new Date(election.voting_end_time) : null;
    if (election.merkle_root && votingStart && votingEnd) {
        if (now >= votingEnd) return "voting_ended";
        if (now >= votingStart) return "voting_active";
        return "finalizing";
    }
    if (election.contract_address) return "contract_deployed";

    const registrationEnd = election.registration_end_time
        ? new Date(election.registration_end_time)
        : null;
    if (registrationEnd && now < registrationEnd) return "registration_open";
    return "draft";
}

async function getSupabase(): Promise<any> {
    if (!supabaseClient) {
        supabaseClient = (await import("./supabaseClient")).default;
    }
    return supabaseClient;
}

function sourceOrderForTable(table: string): string {
    const orderBy = SOURCE_TABLE_ORDER[table];
    if (!orderBy) {
        throw new Error(`No deterministic source order configured for ${table}`);
    }
    return orderBy;
}

async function fetchAll(table: string, columns: string): Promise<Row[]> {
    const pageSize = 1000;
    const rows: Row[] = [];
    const orderBy = sourceOrderForTable(table);
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await (await getSupabase())
            .from(table)
            .select(columns)
            .order(orderBy, { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw new Error(`Supabase read failed for ${table}: ${error.message}`);
        rows.push(...data);
        if (data.length < pageSize) break;
    }
    return rows;
}

function isMissingColumnError(err: any, column: string): boolean {
    const message = err?.message || "";
    return message.includes(column) || /column|schema cache|PGRST204/i.test(message);
}

async function fetchElections(): Promise<Row[]> {
    const missingOptional = new Set<string>();
    let optional = [...ELECTION_OPTIONAL_COLUMNS];

    while (true) {
        try {
            const rows = await fetchAll("Elections", [...ELECTION_BASE_COLUMNS, ...optional].join(", "));
            return rows.map((row) => {
                const withDefaults: Row = { ...row };
                for (const column of missingOptional) {
                    withDefaults[column] = null;
                }
                return withDefaults;
            });
        } catch (err) {
            const missing = optional.find((column) => isMissingColumnError(err, column));
            if (!missing) {
                throw err;
            }
            missingOptional.add(missing);
            optional = optional.filter((column) => column !== missing);
        }
    }
}

async function main(): Promise<void> {
    const targetUrl = process.env.TARGET_DATABASE_URL;
    if (!targetUrl && !DRY_RUN) {
        throw new Error("TARGET_DATABASE_URL is required (or pass --dry-run).");
    }

    console.log(`== zk-vote cutover ETL ${DRY_RUN ? "(DRY RUN — no writes)" : ""}`);

    // ---- Extract ----------------------------------------------------------
    const elections = (await fetchElections()).map((election): Row => ({
        ...election,
        state: deriveElectionState(election),
    }));
    const voters = await fetchAll(
        "Voters",
        "id, election_id, email, user_id, name, user_secret"
    );
    const admins = await fetchAll("Admins", "id");
    const invitations = await fetchAll("AdminInvitations", "email");

    console.log(
        `source rows: Elections=${elections.length} Voters=${voters.length} Admins=${admins.length} AdminInvitations=${invitations.length}`
    );

    // ---- Transform + privacy gate (H2) ------------------------------------
    for (const voter of voters) {
        // voters.email is NOT NULL in Cloud SQL (migrations/0001_initial.sql L59);
        // a null/empty source email would abort the whole transaction mid-load at
        // the constraint. Fail fast, before any write, with the offending row id.
        if (voter.email == null || String(voter.email).trim() === "") {
            throw new Error(
                `ABORT: Voters row ${voter.id} has a null/empty email — voters.email is NOT NULL in Cloud SQL. Investigate the source row before migrating.`
            );
        }
        if (voter.user_secret != null && !isDecimalFieldElementString(voter.user_secret)) {
            throw new Error(
                `ABORT: Voters row ${voter.id} has a non-decimal field-element user_secret — possible pre-H2 plaintext-era data, non-decimal encoding, or out-of-field commitment. Refusing to migrate.`
            );
        }
    }
    for (const election of elections) {
        if (!election.merkle_tree_depth || !election.num_candidates) {
            throw new Error(`ABORT: Elections row ${election.id} is missing depth/candidates.`);
        }
        if (election.merkle_root != null && !isDecimalFieldElementString(election.merkle_root)) {
            throw new Error(`ABORT: Elections row ${election.id} has a non-decimal field-element merkle_root.`);
        }
    }

    const sourceChecksums = {
        elections: checksum(elections.map(normalizeElectionForChecksum), ELECTION_CHECKSUM_KEYS),
        voters: checksum(voters, VOTER_CHECKSUM_KEYS),
        admins: checksum(admins, ["id"]),
        admin_invitations: checksum(invitations, ["email"]),
    };
    console.log("source checksums:", sourceChecksums);

    if (DRY_RUN) {
        console.log("DRY RUN complete: extraction + privacy gate + source checksums OK.");
        return;
    }

    // ---- Load (upsert; re-runs converge) -----------------------------------
    const target = new Client({ connectionString: targetUrl });
    await target.connect();
    let committed = false;
    try {
        await target.query("BEGIN");
        for (const e of elections) {
            await target.query(
                `INSERT INTO elections (id, state, name, merkle_tree_depth, num_candidates, candidates,
                     registration_start_time, registration_end_time, voting_start_time,
                     voting_end_time, merkle_root, contract_address, verifier_address,
                     superseded_at, completed)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                 ON CONFLICT (id) DO UPDATE SET
                     state = EXCLUDED.state,
                     name = EXCLUDED.name,
                     merkle_tree_depth = EXCLUDED.merkle_tree_depth,
                     num_candidates = EXCLUDED.num_candidates,
                     candidates = EXCLUDED.candidates,
                     registration_start_time = EXCLUDED.registration_start_time,
                     registration_end_time = EXCLUDED.registration_end_time,
                     voting_start_time = EXCLUDED.voting_start_time,
                     voting_end_time = EXCLUDED.voting_end_time,
                     merkle_root = EXCLUDED.merkle_root,
                     contract_address = EXCLUDED.contract_address,
                     verifier_address = EXCLUDED.verifier_address,
                     superseded_at = EXCLUDED.superseded_at,
                     completed = EXCLUDED.completed`,
                [
                    e.id, e.state, e.name, e.merkle_tree_depth, e.num_candidates,
                    JSON.stringify(e.candidates ?? []),
                    e.registration_start_time, e.registration_end_time,
                    e.voting_start_time, e.voting_end_time,
                    e.merkle_root, e.contract_address, e.verifier_address,
                    e.superseded_at, Boolean(e.completed),
                ]
            );
        }
        for (const v of voters) {
            // DATA_MODEL §1: legacy user_secret column holds the H2 commitment.
            await target.query(
                `INSERT INTO voters (id, election_id, email, user_id, name, user_secret_commitment)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (id) DO UPDATE SET
                     election_id = EXCLUDED.election_id,
                     email = EXCLUDED.email,
                     user_id = EXCLUDED.user_id,
                     name = EXCLUDED.name,
                     user_secret_commitment = EXCLUDED.user_secret_commitment`,
                [v.id, v.election_id, v.email, v.user_id, v.name, v.user_secret]
            );
        }
        for (const a of admins) {
            await target.query(
                "INSERT INTO admins (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
                [a.id]
            );
        }
        for (const i of invitations) {
            await target.query(
                "INSERT INTO admin_invitations (email) VALUES ($1) ON CONFLICT (email) DO NOTHING",
                [i.email]
            );
        }

        // ---- Verify before commit (gate: counts + checksums must match) -----
        const verify = async (
            table: string,
            sql: string,
            keys: string[],
            sourceRows: Row[],
            sourceSum: string
        ): Promise<boolean> => {
            const { rows } = await target.query(sql);
            const ok = rows.length === sourceRows.length && checksum(rows, keys) === sourceSum;
            console.log(
                `${ok ? "ok" : "FAIL"}: ${table} target=${rows.length} source=${sourceRows.length} checksum ${ok ? "match" : "MISMATCH"}`
            );
            return ok;
        };

        const results = await Promise.all([
            verify(
                "elections",
                "SELECT id::text AS id, state, name, merkle_tree_depth, num_candidates, candidates, registration_start_time, registration_end_time, voting_start_time, voting_end_time, merkle_root, contract_address, verifier_address, superseded_at, completed FROM elections",
                ELECTION_CHECKSUM_KEYS,
                elections.map(normalizeElectionForChecksum),
                sourceChecksums.elections
            ),
            verify(
                "voters",
                "SELECT id::text AS id, election_id::text AS election_id, email::text AS email, user_id::text AS user_id, name, user_secret_commitment AS user_secret FROM voters",
                VOTER_CHECKSUM_KEYS,
                voters,
                sourceChecksums.voters
            ),
            verify(
                "admins",
                "SELECT id::text AS id FROM admins",
                ["id"],
                admins,
                sourceChecksums.admins
            ),
            verify(
                "admin_invitations",
                "SELECT email::text AS email FROM admin_invitations",
                ["email"],
                invitations,
                sourceChecksums.admin_invitations
            ),
        ]);

        if (!results.every(Boolean)) {
            throw new Error("VERIFICATION FAILED: counts/checksums diverge — rolling back cutover ETL.");
        }

        const superadminResult = await target.query(
            "SELECT count(*)::int AS count FROM admins WHERE is_superadmin = true AND revoked_at IS NULL"
        );
        const activeSuperadmins = Number(superadminResult.rows[0]?.count ?? 0);
        if (activeSuperadmins < 1) {
            throw new Error(
                "VERIFICATION FAILED: cutover target has zero active superadmins. Bootstrap or mark at least one verified admin as superadmin before committing ETL."
            );
        }
        console.log(`ok: active superadmin gate (${activeSuperadmins})`);

        await target.query("COMMIT");
        committed = true;
    } catch (err) {
        if (!committed) {
            await target.query("ROLLBACK");
        }
        throw err;
    } finally {
        await target.end();
    }
    console.log("ETL complete: all row counts and checksums match (AR-H3 gate).");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().then(
        () => process.exit(0),
        (err) => {
            console.error(err.message);
            process.exit(1);
        }
    );
}

export {
    checksum,
    deriveElectionState,
    isDecimalFieldElementString,
    sourceOrderForTable,
    ELECTION_CHECKSUM_KEYS,
    VOTER_CHECKSUM_KEYS,
};
