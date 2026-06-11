//! Repositories over the Phase 3 schema. Handlers stay thin: they combine
//! these data accessors with the pure rules in `zkvote_domain::services`.

use crate::DbError;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Elections
// ---------------------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
pub struct Election {
    pub id: Uuid,
    pub name: String,
    pub state: String,
    pub merkle_tree_depth: i32,
    pub num_candidates: i32,
    pub candidates: serde_json::Value,
    pub registration_start_time: OffsetDateTime,
    pub registration_end_time: OffsetDateTime,
    pub voting_start_time: Option<OffsetDateTime>,
    pub voting_end_time: Option<OffsetDateTime>,
    pub merkle_root: Option<String>,
    pub contract_address: Option<String>,
    pub verifier_address: Option<String>,
    pub completed: bool,
    pub circuit_id: Option<String>,
}

#[derive(Debug)]
pub struct NewElection {
    pub name: String,
    pub merkle_tree_depth: i32,
    pub candidates: Vec<String>,
    pub registration_end_time: OffsetDateTime,
}

const ELECTION_COLUMNS: &str = "id, name, state, merkle_tree_depth, num_candidates, candidates, \
     registration_start_time, registration_end_time, voting_start_time, voting_end_time, \
     merkle_root, contract_address, verifier_address, completed, circuit_id";

pub struct ElectionRepo;

impl ElectionRepo {
    pub async fn create(pool: &PgPool, new: &NewElection) -> Result<Election, DbError> {
        let query = format!(
            "INSERT INTO elections \
                 (name, merkle_tree_depth, num_candidates, candidates, \
                  registration_start_time, registration_end_time) \
             VALUES ($1, $2, $3, $4, now(), $5) \
             RETURNING {ELECTION_COLUMNS}"
        );
        Ok(sqlx::query_as::<_, Election>(&query)
            .bind(&new.name)
            .bind(new.merkle_tree_depth)
            .bind(new.candidates.len() as i32)
            .bind(serde_json::json!(new.candidates))
            .bind(new.registration_end_time)
            .fetch_one(pool)
            .await?)
    }

    pub async fn find(pool: &PgPool, id: Uuid) -> Result<Option<Election>, DbError> {
        let query = format!("SELECT {ELECTION_COLUMNS} FROM elections WHERE id = $1");
        Ok(sqlx::query_as::<_, Election>(&query)
            .bind(id)
            .fetch_optional(pool)
            .await?)
    }

    /// Registration window open and not yet finalized.
    pub async fn list_registerable(
        pool: &PgPool,
        now: OffsetDateTime,
    ) -> Result<Vec<Election>, DbError> {
        let query = format!(
            "SELECT {ELECTION_COLUMNS} FROM elections \
             WHERE registration_end_time > $1 AND merkle_root IS NULL \
             ORDER BY registration_end_time"
        );
        Ok(sqlx::query_as::<_, Election>(&query)
            .bind(now)
            .fetch_all(pool)
            .await?)
    }

    /// Finalized, voting still open, not completed.
    pub async fn list_voting(pool: &PgPool, now: OffsetDateTime) -> Result<Vec<Election>, DbError> {
        let query = format!(
            "SELECT {ELECTION_COLUMNS} FROM elections \
             WHERE merkle_root IS NOT NULL AND completed = false \
               AND voting_end_time IS NOT NULL AND voting_end_time > $1 \
             ORDER BY voting_end_time"
        );
        Ok(sqlx::query_as::<_, Election>(&query)
            .bind(now)
            .fetch_all(pool)
            .await?)
    }

    pub async fn list_completed(pool: &PgPool) -> Result<Vec<Election>, DbError> {
        let query = format!(
            "SELECT {ELECTION_COLUMNS} FROM elections WHERE completed = true \
             ORDER BY voting_end_time DESC NULLS LAST"
        );
        Ok(sqlx::query_as::<_, Election>(&query)
            .fetch_all(pool)
            .await?)
    }

    /// Guarded: only one deployment may ever win (audit H3 DB side).
    pub async fn set_contract_address(
        pool: &PgPool,
        id: Uuid,
        contract_address: &str,
        verifier_address: &str,
    ) -> Result<bool, DbError> {
        let updated = sqlx::query(
            "UPDATE elections SET contract_address = $2, verifier_address = $3 \
             WHERE id = $1 AND contract_address IS NULL",
        )
        .bind(id)
        .bind(contract_address)
        .bind(verifier_address)
        .execute(pool)
        .await?;
        Ok(updated.rows_affected() == 1)
    }

    /// Guarded: the finalize DB sync may only run once (audit H4 DB side).
    pub async fn finalize_sync(
        pool: &PgPool,
        id: Uuid,
        merkle_root: &str,
        registration_closed_at: OffsetDateTime,
        voting_start: OffsetDateTime,
        voting_end: OffsetDateTime,
    ) -> Result<bool, DbError> {
        let updated = sqlx::query(
            "UPDATE elections SET merkle_root = $2, registration_end_time = $3, \
                 voting_start_time = $4, voting_end_time = $5 \
             WHERE id = $1 AND merkle_root IS NULL",
        )
        .bind(id)
        .bind(merkle_root)
        .bind(registration_closed_at)
        .bind(voting_start)
        .bind(voting_end)
        .execute(pool)
        .await?;
        Ok(updated.rows_affected() == 1)
    }

    /// Guarded: idempotent completion (Node parity: `.eq("completed", false)`).
    pub async fn mark_completed(pool: &PgPool, id: Uuid) -> Result<bool, DbError> {
        let updated = sqlx::query(
            "UPDATE elections SET completed = true WHERE id = $1 AND completed = false",
        )
        .bind(id)
        .execute(pool)
        .await?;
        Ok(updated.rows_affected() == 1)
    }
}

// ---------------------------------------------------------------------------
// Voters
// ---------------------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
pub struct Voter {
    pub id: Uuid,
    pub election_id: Uuid,
    pub email: String,
    pub user_id: Option<Uuid>,
    pub name: Option<String>,
    pub user_secret_commitment: Option<String>,
}

const VOTER_COLUMNS: &str =
    "id, election_id, email::text AS email, user_id, name, user_secret_commitment";

pub struct VoterRepo;

impl VoterRepo {
    /// Plain insert: duplicate (election_id, email) surfaces as a unique
    /// violation so allowlist races cannot silently double-add.
    pub async fn insert_allowlisted<'e, E>(
        executor: E,
        election_id: Uuid,
        email: &str,
    ) -> Result<Uuid, DbError>
    where
        E: sqlx::PgExecutor<'e>,
    {
        Ok(sqlx::query_scalar(
            "INSERT INTO voters (election_id, email) VALUES ($1, $2) RETURNING id",
        )
        .bind(election_id)
        .bind(email)
        .fetch_one(executor)
        .await?)
    }

    pub async fn find_allowlisted(
        pool: &PgPool,
        election_id: Uuid,
        email: &str,
    ) -> Result<Option<Voter>, DbError> {
        let query =
            format!("SELECT {VOTER_COLUMNS} FROM voters WHERE election_id = $1 AND email = $2");
        Ok(sqlx::query_as::<_, Voter>(&query)
            .bind(election_id)
            .bind(email)
            .fetch_optional(pool)
            .await?)
    }

    pub async fn count_for_election(pool: &PgPool, election_id: Uuid) -> Result<u64, DbError> {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM voters WHERE election_id = $1")
            .bind(election_id)
            .fetch_one(pool)
            .await?;
        Ok(count as u64)
    }

    pub async fn registered_count(pool: &PgPool, election_id: Uuid) -> Result<u64, DbError> {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM voters WHERE election_id = $1 AND user_id IS NOT NULL",
        )
        .bind(election_id)
        .fetch_one(pool)
        .await?;
        Ok(count as u64)
    }

    /// Race-guarded registration bind (Node parity: `.is('user_id', null)`);
    /// stores only the commitment H(secret) — never a plaintext secret (H2).
    pub async fn bind_registration(
        pool: &PgPool,
        election_id: Uuid,
        email: &str,
        user_id: Uuid,
        name: &str,
        secret_commitment: &str,
    ) -> Result<bool, DbError> {
        let updated = sqlx::query(
            "UPDATE voters SET user_id = $3, name = $4, user_secret_commitment = $5, \
                 registered_at = now() \
             WHERE election_id = $1 AND email = $2 AND user_id IS NULL",
        )
        .bind(election_id)
        .bind(email)
        .bind(user_id)
        .bind(name)
        .bind(secret_commitment)
        .execute(pool)
        .await?;
        Ok(updated.rows_affected() == 1)
    }
}

// ---------------------------------------------------------------------------
// Vote submissions
// ---------------------------------------------------------------------------

pub struct SubmissionRepo;

impl SubmissionRepo {
    /// Durable double-vote guard: UNIQUE (election_id, nullifier_hash)
    /// surfaces duplicates as a unique violation.
    pub async fn record(
        pool: &PgPool,
        election_id: Uuid,
        nullifier_hash: &str,
        status: &str,
        tx_hash: Option<&str>,
    ) -> Result<Uuid, DbError> {
        Ok(sqlx::query_scalar(
            "INSERT INTO vote_submissions (election_id, nullifier_hash, status, tx_hash) \
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(election_id)
        .bind(nullifier_hash)
        .bind(status)
        .bind(tx_hash)
        .fetch_one(pool)
        .await?)
    }
}

// ---------------------------------------------------------------------------
// Read-model rows for the Phase 7 list surfaces
// ---------------------------------------------------------------------------

/// Registerable election as seen by a non-admin voter (allowlist join).
#[derive(Debug, sqlx::FromRow)]
pub struct RegisterableElection {
    #[sqlx(flatten)]
    pub election: Election,
    pub is_registered: bool,
}

/// Election with allowlist/registration counts (admin lists).
#[derive(Debug, sqlx::FromRow)]
pub struct ElectionWithCounts {
    #[sqlx(flatten)]
    pub election: Election,
    pub total_voters: i64,
    pub registered_voters: i64,
}

const COUNT_SUBSELECTS: &str = "\
     (SELECT count(*) FROM voters v2 WHERE v2.election_id = e.id) AS total_voters, \
     (SELECT count(*) FROM voters v2 WHERE v2.election_id = e.id AND v2.user_id IS NOT NULL) AS registered_voters";

impl ElectionRepo {
    /// Non-admin view: only elections where the voter's normalized e-mail is
    /// allowlisted, with their registration status.
    pub async fn list_registerable_for_email(
        pool: &PgPool,
        now: OffsetDateTime,
        email: &str,
    ) -> Result<Vec<RegisterableElection>, DbError> {
        Ok(sqlx::query_as::<_, RegisterableElection>(
            "SELECT e.*, (v.user_id IS NOT NULL) AS is_registered \
             FROM elections e \
             JOIN voters v ON v.election_id = e.id AND v.email = $2 \
             WHERE e.registration_end_time > $1 AND e.merkle_root IS NULL \
             ORDER BY e.registration_end_time",
        )
        .bind(now)
        .bind(email)
        .fetch_all(pool)
        .await?)
    }

    /// Admin view of active voting elections, with voter counts.
    pub async fn list_voting_with_counts(
        pool: &PgPool,
        now: OffsetDateTime,
    ) -> Result<Vec<ElectionWithCounts>, DbError> {
        let query = format!(
            "SELECT e.*, {COUNT_SUBSELECTS} FROM elections e \
             WHERE e.merkle_root IS NOT NULL AND e.completed = false \
               AND e.voting_end_time IS NOT NULL AND e.voting_end_time > $1 \
             ORDER BY e.voting_end_time"
        );
        Ok(sqlx::query_as::<_, ElectionWithCounts>(&query)
            .bind(now)
            .fetch_all(pool)
            .await?)
    }

    /// Non-admin view: active voting elections where this user completed
    /// registration, with voter counts.
    pub async fn list_voting_for_user(
        pool: &PgPool,
        now: OffsetDateTime,
        user_id: Uuid,
    ) -> Result<Vec<ElectionWithCounts>, DbError> {
        let query = format!(
            "SELECT e.*, {COUNT_SUBSELECTS} FROM elections e \
             JOIN voters v ON v.election_id = e.id AND v.user_id = $2 \
             WHERE e.merkle_root IS NOT NULL AND e.completed = false \
               AND e.voting_end_time IS NOT NULL AND e.voting_end_time > $1 \
             ORDER BY e.voting_end_time"
        );
        Ok(sqlx::query_as::<_, ElectionWithCounts>(&query)
            .bind(now)
            .bind(user_id)
            .fetch_all(pool)
            .await?)
    }

    /// Non-admin view: completed elections where this user was registered.
    pub async fn list_completed_for_user(
        pool: &PgPool,
        user_id: Uuid,
    ) -> Result<Vec<Election>, DbError> {
        Ok(sqlx::query_as::<_, Election>(
            "SELECT e.* FROM elections e \
             JOIN voters v ON v.election_id = e.id AND v.user_id = $1 \
             WHERE e.completed = true \
             ORDER BY e.voting_end_time DESC NULLS LAST",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?)
    }
}

// ---------------------------------------------------------------------------
// Admin invitations (Phase 8 surface; consumption lives in the auth layer)
// ---------------------------------------------------------------------------

pub struct AdminRepo;

impl AdminRepo {
    /// Idempotent invitation upsert (Node parity: `upsert onConflict email`).
    /// Promotion happens at auth time (AR-L4 decision), not here.
    pub async fn upsert_invitation(pool: &PgPool, email: &str) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO admin_invitations (email) VALUES ($1) \
             ON CONFLICT (email) DO NOTHING",
        )
        .bind(email)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn pending_invitation_exists(pool: &PgPool, email: &str) -> Result<bool, DbError> {
        let found: Option<String> = sqlx::query_scalar(
            "SELECT email::text FROM admin_invitations WHERE email = $1 AND accepted_at IS NULL",
        )
        .bind(email)
        .fetch_optional(pool)
        .await?;
        Ok(found.is_some())
    }
}

// ---------------------------------------------------------------------------
// ZK artifacts (placeholder lookups until the Phase 10 pipeline lands)
// ---------------------------------------------------------------------------

pub struct ZkArtifactRepo;

impl ZkArtifactRepo {
    /// Finds a usable circom artifact set for a circuit shape. Until the
    /// Phase 10 artifact pipeline populates this table, deployments through
    /// the Rust API are blocked with a typed error (Phase 8 gate: missing
    /// artifacts block deployment setup).
    pub async fn find_by_shape(
        pool: &PgPool,
        merkle_tree_depth: i32,
        num_candidates: i32,
    ) -> Result<Option<Uuid>, DbError> {
        Ok(sqlx::query_scalar(
            "SELECT id FROM zk_artifacts \
             WHERE backend = 'circom' AND merkle_tree_depth = $1 AND num_candidates = $2 \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(merkle_tree_depth)
        .bind(num_candidates)
        .fetch_optional(pool)
        .await?)
    }
}

// ---------------------------------------------------------------------------
// Contract deployments (Phase 11 metadata)
// ---------------------------------------------------------------------------

pub struct DeploymentRepo;

impl DeploymentRepo {
    /// Records the deployed pair. UNIQUE(election_id) makes a double record
    /// surface as a unique violation rather than silently overwriting.
    pub async fn record(
        pool: &PgPool,
        election_id: Uuid,
        zk_artifact_id: Option<Uuid>,
        verifier_address: &str,
        voting_tally_address: &str,
        chain_id: i64,
        deploy_tx_hash: &str,
    ) -> Result<Uuid, DbError> {
        Ok(sqlx::query_scalar(
            "INSERT INTO contract_deployments \
                 (election_id, zk_artifact_id, verifier_address, voting_tally_address, \
                  chain_id, deploy_tx_hash) \
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        )
        .bind(election_id)
        .bind(zk_artifact_id)
        .bind(verifier_address)
        .bind(voting_tally_address)
        .bind(chain_id)
        .bind(deploy_tx_hash)
        .fetch_one(pool)
        .await?)
    }
}
