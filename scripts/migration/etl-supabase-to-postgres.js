/**
 * @file scripts/migration/etl-supabase-to-postgres.js
 * @desc One-time cutover ETL (PROJECT_PLAN Phase 19, architecture review
 * AR-H3): copies the hosted-Supabase PascalCase tables into the snake_case
 * Cloud SQL schema (docs/DATA_MODEL.md §1 mapping), then verifies row
 * counts AND content checksums on both sides before reporting success.
 *
 * Privacy invariant: `Voters.user_secret` must contain post-H2 commitments
 * (decimal field elements). The ETL ABORTS if any value fails ^[0-9]+$ —
 * that would indicate a pre-H2 plaintext-era row that must never be copied.
 *
 * Usage (reads hosted Supabase via server/.env; target via TARGET_DATABASE_URL):
 *   TARGET_DATABASE_URL=postgres://zkvote:...@localhost:5432/zkvote \
 *     node scripts/migration/etl-supabase-to-postgres.js [--dry-run]
 *
 * --dry-run: extract + transform + verify source counts/checksums, write
 * nothing. Idempotency: rows are upserted by primary key; re-runs converge.
 */

const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", "server", ".env") });
const { Client } = require("pg");
const supabase = require("../../server/supabaseClient");

const FIELD_ELEMENT = /^[0-9]+$/;
const DRY_RUN = process.argv.includes("--dry-run");

function checksum(rows, keys) {
    // Order-independent content hash: hash each row's canonical projection,
    // sort the digests, hash the concatenation.
    const digests = rows
        .map((row) => {
            const projection = keys.map((key) => `${key}=${row[key] ?? ""}`).join("|");
            return crypto.createHash("sha256").update(projection).digest("hex");
        })
        .sort();
    return crypto.createHash("sha256").update(digests.join("\n")).digest("hex");
}

async function fetchAll(table, columns) {
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase
            .from(table)
            .select(columns)
            .range(from, from + pageSize - 1);
        if (error) throw new Error(`Supabase read failed for ${table}: ${error.message}`);
        rows.push(...data);
        if (data.length < pageSize) break;
    }
    return rows;
}

async function main() {
    const targetUrl = process.env.TARGET_DATABASE_URL;
    if (!targetUrl && !DRY_RUN) {
        throw new Error("TARGET_DATABASE_URL is required (or pass --dry-run).");
    }

    console.log(`== zk-vote cutover ETL ${DRY_RUN ? "(DRY RUN — no writes)" : ""}`);

    // ---- Extract ----------------------------------------------------------
    const elections = await fetchAll(
        "Elections",
        "id, name, merkle_tree_depth, num_candidates, candidates, registration_start_time, registration_end_time, voting_start_time, voting_end_time, merkle_root, contract_address, completed"
    );
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
        if (voter.user_secret != null && !FIELD_ELEMENT.test(String(voter.user_secret))) {
            throw new Error(
                `ABORT: Voters row ${voter.id} has a non-field-element user_secret — possible pre-H2 plaintext-era data. Refusing to migrate.`
            );
        }
    }
    for (const election of elections) {
        if (!election.merkle_tree_depth || !election.num_candidates) {
            throw new Error(`ABORT: Elections row ${election.id} is missing depth/candidates.`);
        }
    }

    const sourceChecksums = {
        elections: checksum(elections, ["id", "name", "merkle_root", "contract_address", "completed"]),
        voters: checksum(voters, ["id", "election_id", "email", "user_id", "user_secret"]),
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
    try {
        await target.query("BEGIN");
        for (const e of elections) {
            await target.query(
                `INSERT INTO elections (id, name, merkle_tree_depth, num_candidates, candidates,
                     registration_start_time, registration_end_time, voting_start_time,
                     voting_end_time, merkle_root, contract_address, completed)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                 ON CONFLICT (id) DO UPDATE SET
                     name = EXCLUDED.name,
                     merkle_root = EXCLUDED.merkle_root,
                     contract_address = EXCLUDED.contract_address,
                     voting_start_time = EXCLUDED.voting_start_time,
                     voting_end_time = EXCLUDED.voting_end_time,
                     completed = EXCLUDED.completed`,
                [
                    e.id, e.name, e.merkle_tree_depth, e.num_candidates,
                    JSON.stringify(e.candidates ?? []),
                    e.registration_start_time, e.registration_end_time,
                    e.voting_start_time, e.voting_end_time,
                    e.merkle_root, e.contract_address, Boolean(e.completed),
                ]
            );
        }
        for (const v of voters) {
            // DATA_MODEL §1: legacy user_secret column holds the H2 commitment.
            await target.query(
                `INSERT INTO voters (id, election_id, email, user_id, name, user_secret_commitment)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT (id) DO UPDATE SET
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
        await target.query("COMMIT");
    } catch (err) {
        await target.query("ROLLBACK");
        throw err;
    }

    // ---- Verify (gate: counts + checksums must match) ----------------------
    const verify = async (table, sql, keys, sourceRows, sourceSum) => {
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
            "SELECT id::text AS id, name, merkle_root, contract_address, completed FROM elections",
            ["id", "name", "merkle_root", "contract_address", "completed"],
            elections.map((e) => ({ ...e, completed: Boolean(e.completed) })),
            checksum(
                elections.map((e) => ({ ...e, completed: Boolean(e.completed) })),
                ["id", "name", "merkle_root", "contract_address", "completed"]
            )
        ),
        verify(
            "voters",
            "SELECT id::text AS id, election_id::text AS election_id, email::text AS email, user_id::text AS user_id, user_secret_commitment AS user_secret FROM voters",
            ["id", "election_id", "email", "user_id", "user_secret"],
            voters,
            sourceChecksums.voters
        ),
        verify("admins", "SELECT id::text AS id FROM admins", ["id"], admins, sourceChecksums.admins),
        verify(
            "admin_invitations",
            "SELECT email::text AS email FROM admin_invitations",
            ["email"],
            invitations,
            sourceChecksums.admin_invitations
        ),
    ]);
    await target.end();

    if (!results.every(Boolean)) {
        throw new Error("VERIFICATION FAILED: counts/checksums diverge — do NOT proceed with cutover.");
    }
    console.log("ETL complete: all row counts and checksums match (AR-H3 gate).");
}

main().then(
    () => process.exit(0),
    (err) => {
        console.error(err.message);
        process.exit(1);
    }
);
