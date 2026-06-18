//! Phase 6 repository gates against the docker-compose Postgres
//! (scripts/local/smoke.sh + migrate.sh first). Run explicitly:
//! `cargo test -p zkvote-db -- --ignored`

use time::{Duration, OffsetDateTime};
use zkvote_db::repos::{DeploymentRepo, ElectionRepo, NewElection, SubmissionRepo, VoterRepo};
use zkvote_db::{with_transaction, DbError};

const DATABASE_URL: &str = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";

async fn pool() -> sqlx::PgPool {
    zkvote_db::connect(DATABASE_URL).await.unwrap()
}

async fn create_election(pool: &sqlx::PgPool) -> zkvote_db::repos::Election {
    ElectionRepo::create(
        pool,
        &NewElection {
            name: format!("repo gate election {}", uuid::Uuid::new_v4()),
            merkle_tree_depth: 4,
            candidates: vec!["A".to_string(), "B".to_string()],
            registration_end_time: OffsetDateTime::now_utc() + Duration::hours(1),
        },
    )
    .await
    .unwrap()
}

async fn drop_election(pool: &sqlx::PgPool, id: uuid::Uuid) {
    sqlx::query("DELETE FROM elections WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

async fn election_state(pool: &sqlx::PgPool, id: uuid::Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM elections WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires the docker-compose Postgres"]
async fn election_repo_persists_lifecycle_state_changes() {
    let pool = pool().await;
    let active = create_election(&pool).await;
    let ended = create_election(&pool).await;
    let now = OffsetDateTime::now_utc();

    assert_eq!(election_state(&pool, active.id).await, "draft");

    let deployed = ElectionRepo::set_contract_address(&pool, active.id, "0xabc", "0xdef")
        .await
        .unwrap();
    assert!(deployed);
    assert_eq!(election_state(&pool, active.id).await, "contract_deployed");

    let finalized =
        ElectionRepo::finalize_sync(&pool, active.id, "42", now, now, now + Duration::hours(1))
            .await
            .unwrap();
    assert!(finalized);
    assert_eq!(election_state(&pool, active.id).await, "voting_active");

    let completed = ElectionRepo::mark_completed(&pool, active.id)
        .await
        .unwrap();
    assert!(completed);
    assert_eq!(election_state(&pool, active.id).await, "completed");

    let ended_finalized = ElectionRepo::finalize_sync(
        &pool,
        ended.id,
        "43",
        now,
        now - Duration::hours(2),
        now - Duration::hours(1),
    )
    .await
    .unwrap();
    assert!(ended_finalized);
    assert_eq!(election_state(&pool, ended.id).await, "voting_ended");

    drop_election(&pool, active.id).await;
    drop_election(&pool, ended.id).await;
}

#[tokio::test]
#[ignore = "requires the docker-compose Postgres"]
async fn superseded_election_lifecycle_writes_fail_closed() {
    let pool = pool().await;
    let election = create_election(&pool).await;
    let now = OffsetDateTime::now_utc();

    sqlx::query("UPDATE elections SET superseded_at = $2, state = 'failed' WHERE id = $1")
        .bind(election.id)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();

    assert!(
        !ElectionRepo::set_contract_address(&pool, election.id, "0xabc", "0xdef")
            .await
            .unwrap(),
        "deployment binding must not reactivate a superseded row"
    );
    assert!(
        !DeploymentRepo::record_and_bind(&pool, election.id, None, "0xdef", "0xabc", 31337, "0x1")
            .await
            .unwrap(),
        "deployment metadata insert must not win for a superseded row"
    );
    assert!(
        !ElectionRepo::finalize_sync(&pool, election.id, "42", now, now, now + Duration::hours(1))
            .await
            .unwrap(),
        "finalization sync must not reactivate a superseded row"
    );
    assert!(
        !ElectionRepo::mark_completed(&pool, election.id)
            .await
            .unwrap(),
        "completion must not reactivate a superseded row"
    );

    let row: (String, Option<String>, Option<String>, Option<String>, bool) = sqlx::query_as(
        "SELECT state, contract_address, verifier_address, merkle_root, completed \
         FROM elections WHERE id = $1",
    )
    .bind(election.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, ("failed".to_string(), None, None, None, false));

    let deployment_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM contract_deployments WHERE election_id = $1")
            .bind(election.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(deployment_count, 0);

    drop_election(&pool, election.id).await;
}

#[tokio::test]
#[ignore = "requires the docker-compose Postgres"]
async fn duplicate_voter_email_is_a_unique_violation() {
    let pool = pool().await;
    let election = create_election(&pool).await;

    VoterRepo::insert_allowlisted(&pool, election.id, "dup@example.com")
        .await
        .unwrap();
    let err = VoterRepo::insert_allowlisted(&pool, election.id, "dup@example.com")
        .await
        .unwrap_err();
    assert!(err.is_unique_violation(), "expected 23505, got {err:?}");

    drop_election(&pool, election.id).await;
}

#[tokio::test]
#[ignore = "requires the docker-compose Postgres"]
async fn duplicate_nullifier_is_a_unique_violation() {
    let pool = pool().await;
    let election = create_election(&pool).await;

    SubmissionRepo::record(&pool, election.id, "42", "pending", None)
        .await
        .unwrap();
    let err = SubmissionRepo::record(&pool, election.id, "42", "pending", None)
        .await
        .unwrap_err();
    assert!(err.is_unique_violation(), "expected 23505, got {err:?}");

    drop_election(&pool, election.id).await;
}

#[tokio::test]
#[ignore = "requires the docker-compose Postgres"]
async fn failed_transaction_rolls_back_partial_writes() {
    let pool = pool().await;
    let election = create_election(&pool).await;
    let election_id = election.id;

    let result: Result<(), DbError> = with_transaction(&pool, move |tx| {
        Box::pin(async move {
            VoterRepo::insert_allowlisted(&mut **tx, election_id, "tx@example.com").await?;
            // Second insert violates the unique constraint -> whole tx must
            // roll back, including the first insert.
            VoterRepo::insert_allowlisted(&mut **tx, election_id, "tx@example.com").await?;
            Ok(())
        })
    })
    .await;

    assert!(result.unwrap_err().is_unique_violation());
    assert_eq!(
        VoterRepo::count_for_election(&pool, election_id)
            .await
            .unwrap(),
        0,
        "rolled-back insert must not persist"
    );

    drop_election(&pool, election_id).await;
}

#[tokio::test]
#[ignore = "requires the docker-compose Postgres"]
async fn registration_bind_is_race_guarded() {
    let pool = pool().await;
    let election = create_election(&pool).await;

    VoterRepo::insert_allowlisted(&pool, election.id, "voter@example.com")
        .await
        .unwrap();

    let first = VoterRepo::bind_registration(
        &pool,
        election.id,
        "voter@example.com",
        uuid::Uuid::new_v4(),
        "Alice",
        "123",
    )
    .await
    .unwrap();
    assert!(first, "first bind must win");

    let second = VoterRepo::bind_registration(
        &pool,
        election.id,
        "voter@example.com",
        uuid::Uuid::new_v4(),
        "Mallory",
        "456",
    )
    .await
    .unwrap();
    assert!(!second, "user_id IS NULL guard must reject the second bind");

    let voter = VoterRepo::find_allowlisted(&pool, election.id, "voter@example.com")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(voter.user_secret_commitment.as_deref(), Some("123"));

    drop_election(&pool, election.id).await;
}
