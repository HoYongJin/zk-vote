//! Repositories over the database schema. Handlers stay thin: they combine
//! these data accessors with the pure rules in `zkvote_domain::services`.

use crate::DbError;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;
use zkvote_domain::ElectionState;

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
    pub superseded_at: Option<OffsetDateTime>,
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
     merkle_root, contract_address, verifier_address, completed, circuit_id, superseded_at";

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
             WHERE registration_start_time < $1 AND registration_end_time > $1 \
               AND merkle_root IS NULL \
               AND superseded_at IS NULL \
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
               AND superseded_at IS NULL \
               AND voting_start_time IS NOT NULL AND voting_start_time < $1 \
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
               AND superseded_at IS NULL \
             ORDER BY voting_end_time DESC NULLS LAST"
        );
        Ok(sqlx::query_as::<_, Election>(&query)
            .fetch_all(pool)
            .await?)
    }

    /// Guarded: only one deployment may ever win (audit H3 DB side).
    /// Superseded rows are abandoned in place and must not be reactivated.
    pub async fn set_contract_address(
        pool: &PgPool,
        id: Uuid,
        contract_address: &str,
        verifier_address: &str,
    ) -> Result<bool, DbError> {
        let updated = sqlx::query(
            "UPDATE elections SET contract_address = $2, verifier_address = $3, state = $4 \
             WHERE id = $1 AND contract_address IS NULL AND superseded_at IS NULL",
        )
        .bind(id)
        .bind(contract_address)
        .bind(verifier_address)
        .bind(ElectionState::ContractDeployed.to_string())
        .execute(pool)
        .await?;
        Ok(updated.rows_affected() == 1)
    }

    /// Guarded: the finalize DB sync may only run once (audit H4 DB side).
    /// Superseded rows fail closed after on-chain side effects and require
    /// manual reconciliation instead of silently becoming active again.
    pub async fn finalize_sync(
        pool: &PgPool,
        id: Uuid,
        merkle_root: &str,
        registration_closed_at: OffsetDateTime,
        voting_start: OffsetDateTime,
        voting_end: OffsetDateTime,
    ) -> Result<bool, DbError> {
        let next_state = if voting_end <= OffsetDateTime::now_utc() {
            ElectionState::VotingEnded
        } else {
            ElectionState::VotingActive
        };
        let updated = sqlx::query(
            "UPDATE elections SET merkle_root = $2, registration_end_time = $3, \
                 voting_start_time = $4, voting_end_time = $5, state = $6 \
             WHERE id = $1 AND merkle_root IS NULL AND superseded_at IS NULL",
        )
        .bind(id)
        .bind(merkle_root)
        .bind(registration_closed_at)
        .bind(voting_start)
        .bind(voting_end)
        .bind(next_state.to_string())
        .execute(pool)
        .await?;
        Ok(updated.rows_affected() == 1)
    }

    /// Guarded: idempotent completion (only flips `completed` from false)
    /// and fail-closed if the election was superseded between read and write.
    pub async fn mark_completed(pool: &PgPool, id: Uuid) -> Result<bool, DbError> {
        let updated = sqlx::query(
            "UPDATE elections SET completed = true, state = $2 \
             WHERE id = $1 AND completed = false AND superseded_at IS NULL",
        )
        .bind(id)
        .bind(ElectionState::Completed.to_string())
        .execute(pool)
        .await?;
        Ok(updated.rows_affected() == 1)
    }

    /// G4: marks an election superseded (AR-M7 — the on-chain contract is
    /// deliberately abandoned in place; this writes only the DB row). Idempotent
    /// and fail-closed: a no-op (Ok(false)) if already superseded or completed.
    /// Caller MUST hold the per-election finalize lease + the relayer lease so a
    /// supersede cannot interleave with an in-flight finalize/relay.
    pub async fn supersede(pool: &PgPool, id: Uuid) -> Result<bool, DbError> {
        let updated = sqlx::query(
            "UPDATE elections SET superseded_at = now(), state = 'failed' \
             WHERE id = $1 AND superseded_at IS NULL AND completed = false",
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

    /// Race-guarded registration bind (only binds when `user_id` is null);
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
// Read-model rows for the election list surfaces
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
             WHERE e.registration_start_time < $1 AND e.registration_end_time > $1 \
               AND e.merkle_root IS NULL \
               AND e.superseded_at IS NULL \
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
               AND e.superseded_at IS NULL \
               AND e.voting_start_time IS NOT NULL AND e.voting_start_time < $1 \
               AND e.voting_end_time IS NOT NULL AND e.voting_end_time > $1 \
             ORDER BY e.voting_end_time"
        );
        Ok(sqlx::query_as::<_, ElectionWithCounts>(&query)
            .bind(now)
            .fetch_all(pool)
            .await?)
    }

    /// Non-admin view: active voting elections where this voter completed
    /// registration, with voter counts. Keyed by the verified e-mail (the
    /// system's stable identity — the same key the registerable list uses) and
    /// gated on `user_id IS NOT NULL` (= registered), so a voter still finds
    /// their active election after a GCIP `user_id` remap during the auth
    /// provider cutover (review G2). e-mail is UNIQUE per election, so this
    /// matches exactly the one voter row.
    pub async fn list_voting_for_voter(
        pool: &PgPool,
        now: OffsetDateTime,
        email: &str,
    ) -> Result<Vec<ElectionWithCounts>, DbError> {
        let query = format!(
            "SELECT e.*, {COUNT_SUBSELECTS} FROM elections e \
             JOIN voters v ON v.election_id = e.id AND v.email = $2 AND v.user_id IS NOT NULL \
             WHERE e.merkle_root IS NOT NULL AND e.completed = false \
               AND e.superseded_at IS NULL \
               AND e.voting_start_time IS NOT NULL AND e.voting_start_time < $1 \
               AND e.voting_end_time IS NOT NULL AND e.voting_end_time > $1 \
             ORDER BY e.voting_end_time"
        );
        Ok(sqlx::query_as::<_, ElectionWithCounts>(&query)
            .bind(now)
            .bind(email)
            .fetch_all(pool)
            .await?)
    }

    /// Non-admin view: completed elections where this voter was registered.
    /// Keyed by e-mail + `user_id IS NOT NULL` for the same reason as
    /// `list_voting_for_voter` (review G2).
    pub async fn list_completed_for_voter(
        pool: &PgPool,
        email: &str,
    ) -> Result<Vec<Election>, DbError> {
        Ok(sqlx::query_as::<_, Election>(
            "SELECT e.* FROM elections e \
             JOIN voters v ON v.election_id = e.id AND v.email = $1 AND v.user_id IS NOT NULL \
             WHERE e.completed = true \
               AND e.superseded_at IS NULL \
             ORDER BY e.voting_end_time DESC NULLS LAST",
        )
        .bind(email)
        .fetch_all(pool)
        .await?)
    }
}

// ---------------------------------------------------------------------------
// Admin invitations (consumption lives in the auth layer)
// ---------------------------------------------------------------------------

pub struct AdminRepo;

/// Outcome of a soft-delete revocation (GOV-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeOutcome {
    Revoked,
    NotFound,
    AlreadyRevoked,
    /// Refused: revoking would leave zero active superadmins.
    LastSuperadmin,
}

/// One row of the admin management list (GOV-1).
#[derive(Debug, sqlx::FromRow)]
pub struct AdminListRow {
    pub id: Uuid,
    pub email: Option<String>,
    pub is_superadmin: bool,
    pub revoked_at: Option<OffsetDateTime>,
    pub invited_by: Option<Uuid>,
}

impl AdminRepo {
    /// Idempotent invitation upsert recording the inviting admin (GOV-1
    /// accountability). Re-inviting an existing e-mail makes the invitation
    /// claimable again (accepted_by/accepted_at reset) — this is how a revoked
    /// admin is reinstated on their next sign-in. Promotion itself happens at
    /// auth time (AR-L4), not here.
    pub async fn upsert_invitation(
        pool: &PgPool,
        email: &str,
        invited_by: Option<Uuid>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "INSERT INTO admin_invitations (email, invited_by) VALUES ($1, $2) \
             ON CONFLICT (email) DO UPDATE SET \
                 accepted_by = NULL, accepted_at = NULL, \
                 invited_by = EXCLUDED.invited_by, updated_at = now()",
        )
        .bind(email)
        .bind(invited_by)
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

    /// All admins (active and revoked) for the GOV-1 management view.
    pub async fn list(pool: &PgPool) -> Result<Vec<AdminListRow>, DbError> {
        let rows = sqlx::query_as::<_, AdminListRow>(
            "SELECT id, email::text AS email, is_superadmin, revoked_at, invited_by \
             FROM admins ORDER BY created_at",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }

    /// Soft-delete (revoke) an admin (GOV-1). Race-safe: a transaction-scoped
    /// advisory lock serializes concurrent revokes so the last-superadmin guard
    /// cannot be bypassed by two simultaneous revokes of different superadmins.
    /// Revocation is an UPDATE (revoked_at), never a DELETE — `admins` stays
    /// append-only and no DELETE grant is needed.
    pub async fn revoke(pool: &PgPool, id: Uuid) -> Result<RevokeOutcome, DbError> {
        let mut tx = pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('admin_revoke'))")
            .execute(&mut *tx)
            .await?;

        let row: Option<(bool, bool)> = sqlx::query_as(
            "SELECT is_superadmin, (revoked_at IS NOT NULL) FROM admins WHERE id = $1 FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some((is_superadmin, is_revoked)) = row else {
            tx.rollback().await?;
            return Ok(RevokeOutcome::NotFound);
        };
        if is_revoked {
            tx.rollback().await?;
            return Ok(RevokeOutcome::AlreadyRevoked);
        }
        if is_superadmin {
            let other_superadmins: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM admins \
                 WHERE is_superadmin AND revoked_at IS NULL AND id <> $1",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if other_superadmins == 0 {
                tx.rollback().await?;
                return Ok(RevokeOutcome::LastSuperadmin);
            }
        }

        sqlx::query("UPDATE admins SET revoked_at = now() WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(RevokeOutcome::Revoked)
    }
}

// ---------------------------------------------------------------------------
// ZK artifacts
// ---------------------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
pub struct ZkArtifact {
    pub id: Uuid,
    pub circuit_id: String,
    pub version: String,
    pub backend: String,
    pub merkle_tree_depth: i32,
    pub num_candidates: i32,
    pub wasm_uri: Option<String>,
    pub zkey_uri: Option<String>,
    pub verification_key_uri: Option<String>,
    pub solidity_verifier_uri: Option<String>,
    pub sha256: String,
    pub manifest: serde_json::Value,
}

/// A new artifact set to register (G5). The `manifest` MUST carry the per-file
/// sha256 fields the `/artifact-info` reader requires, or the verified browser
/// fetch fails closed — the registration handler validates this before insert.
pub struct NewZkArtifact {
    pub circuit_id: String,
    pub version: String,
    pub backend: String,
    pub merkle_tree_depth: i32,
    pub num_candidates: i32,
    pub wasm_uri: Option<String>,
    pub zkey_uri: Option<String>,
    pub verification_key_uri: Option<String>,
    pub solidity_verifier_uri: Option<String>,
    pub sha256: String,
    pub manifest: serde_json::Value,
}

pub struct ZkArtifactRepo;

impl ZkArtifactRepo {
    /// Finds the newest usable circom artifact set for a circuit shape.
    pub async fn find_by_shape(
        pool: &PgPool,
        merkle_tree_depth: i32,
        num_candidates: i32,
    ) -> Result<Option<ZkArtifact>, DbError> {
        Ok(sqlx::query_as::<_, ZkArtifact>(
            "SELECT id, circuit_id, version, backend, merkle_tree_depth, num_candidates, \
                    wasm_uri, zkey_uri, verification_key_uri, solidity_verifier_uri, \
                    sha256, manifest \
             FROM zk_artifacts \
             WHERE backend = 'circom' AND merkle_tree_depth = $1 AND num_candidates = $2 \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(merkle_tree_depth)
        .bind(num_candidates)
        .fetch_optional(pool)
        .await?)
    }

    /// G5: registers an artifact set (the sha256-bearing manifest the verified
    /// browser fetch needs). The `(circuit_id, version)` pair is unique, so a
    /// duplicate registration surfaces as a unique violation.
    pub async fn register(pool: &PgPool, new: &NewZkArtifact) -> Result<Uuid, DbError> {
        Ok(sqlx::query_scalar(
            "INSERT INTO zk_artifacts \
                 (circuit_id, version, backend, merkle_tree_depth, num_candidates, \
                  wasm_uri, zkey_uri, verification_key_uri, solidity_verifier_uri, sha256, manifest) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id",
        )
        .bind(&new.circuit_id)
        .bind(&new.version)
        .bind(&new.backend)
        .bind(new.merkle_tree_depth)
        .bind(new.num_candidates)
        .bind(&new.wasm_uri)
        .bind(&new.zkey_uri)
        .bind(&new.verification_key_uri)
        .bind(&new.solidity_verifier_uri)
        .bind(&new.sha256)
        .bind(&new.manifest)
        .fetch_one(pool)
        .await?)
    }
}

// ---------------------------------------------------------------------------
// Contract deployments (deployment metadata)
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

    /// Atomically binds the deployed contract addresses to the election and
    /// stores the deployment record. If another writer already bound the
    /// election, or the election was superseded, returns Ok(false) without
    /// inserting metadata.
    pub async fn record_and_bind(
        pool: &PgPool,
        election_id: Uuid,
        zk_artifact_id: Option<Uuid>,
        verifier_address: &str,
        voting_tally_address: &str,
        chain_id: i64,
        deploy_tx_hash: &str,
    ) -> Result<bool, DbError> {
        let mut tx = pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE elections SET contract_address = $2, verifier_address = $3, state = $4 \
             WHERE id = $1 AND contract_address IS NULL AND superseded_at IS NULL",
        )
        .bind(election_id)
        .bind(voting_tally_address)
        .bind(verifier_address)
        .bind(ElectionState::ContractDeployed.to_string())
        .execute(&mut *tx)
        .await?;

        if updated.rows_affected() != 1 {
            tx.rollback().await?;
            return Ok(false);
        }

        sqlx::query(
            "INSERT INTO contract_deployments \
                 (election_id, zk_artifact_id, verifier_address, voting_tally_address, \
                  chain_id, deploy_tx_hash) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(election_id)
        .bind(zk_artifact_id)
        .bind(verifier_address)
        .bind(voting_tally_address)
        .bind(chain_id)
        .bind(deploy_tx_hash)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(true)
    }

    /// G3: records the verifier address on the election BEFORE the VotingTally
    /// is deployed, so a tally-stage failure leaves a reusable verifier instead
    /// of an orphan. Idempotent — returns Ok(false) (no-op) if a verifier is
    /// already checkpointed, the contract is already bound, or the election was
    /// superseded in between.
    pub async fn checkpoint_verifier(
        pool: &PgPool,
        election_id: Uuid,
        verifier_address: &str,
    ) -> Result<bool, DbError> {
        let updated = sqlx::query(
            "UPDATE elections SET verifier_address = $2 \
             WHERE id = $1 AND verifier_address IS NULL \
               AND contract_address IS NULL AND superseded_at IS NULL",
        )
        .bind(election_id)
        .bind(verifier_address)
        .execute(pool)
        .await?;
        Ok(updated.rows_affected() == 1)
    }
}

// ---------------------------------------------------------------------------
// Finalization jobs (retry-safe status trail)
// ---------------------------------------------------------------------------

pub struct JobRepo;

impl JobRepo {
    pub async fn create(
        pool: &PgPool,
        election_id: Uuid,
        desired_merkle_root: &str,
    ) -> Result<Uuid, DbError> {
        Ok(sqlx::query_scalar(
            "INSERT INTO finalization_jobs (election_id, desired_merkle_root, status) \
             VALUES ($1, $2, 'pending') RETURNING id",
        )
        .bind(election_id)
        .bind(desired_merkle_root)
        .fetch_one(pool)
        .await?)
    }

    pub async fn set_status(
        pool: &PgPool,
        job_id: Uuid,
        status: &str,
        tx_hash: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<(), DbError> {
        sqlx::query(
            "UPDATE finalization_jobs SET status = $2, tx_hash = COALESCE($3, tx_hash), \
                 error_message = $4 WHERE id = $1",
        )
        .bind(job_id)
        .bind(status)
        .bind(tx_hash)
        .bind(error_message)
        .execute(pool)
        .await?;
        Ok(())
    }
}
