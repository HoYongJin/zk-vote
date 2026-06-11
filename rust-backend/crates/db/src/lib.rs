use sqlx::{postgres::PgPoolOptions, PgPool};
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

// sqlx defaults to a 30s acquire timeout, which turns a down database into
// 30s request hangs (and a 30s /readyz). 5s fails fast while still riding out
// brief connection churn.
fn pool_options() -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(5))
}

pub async fn connect(database_url: &str) -> Result<PgPool, DbError> {
    Ok(pool_options().connect(database_url).await?)
}

/// Builds the pool without an eager connection attempt: the API process can
/// bind its listener (and serve /healthz) while Postgres is still coming up;
/// /readyz keeps reporting the real dependency state.
pub fn connect_lazy(database_url: &str) -> Result<PgPool, DbError> {
    Ok(pool_options().connect_lazy(database_url)?)
}

pub async fn ping(pool: &PgPool) -> Result<(), DbError> {
    sqlx::query_scalar::<_, i64>("SELECT 1::bigint")
        .fetch_one(pool)
        .await?;
    Ok(())
}
