//! Phase 6 repository gates against the docker-compose Postgres
//! (scripts/local/smoke.sh + migrate.sh first). Run explicitly:
//! `cargo test -p zkvote-db -- --ignored`

use time::{Duration, OffsetDateTime};
use zkvote_db::repos::{ElectionRepo, NewElection, SubmissionRepo, VoterRepo};
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
