pub mod repos;

use sqlx::{postgres::PgPoolOptions, PgPool};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

impl DbError {
    /// True when the underlying error is a Postgres unique-constraint
    /// violation (SQLSTATE 23505) — duplicate voter e-mail, duplicate
    /// nullifier, etc.
    pub fn is_unique_violation(&self) -> bool {
        if let Self::Sqlx(sqlx::Error::Database(db)) = self {
            db.code().as_deref() == Some("23505")
        } else {
            false
        }
    }
}

pub type Tx = sqlx::Transaction<'static, sqlx::Postgres>;
type BoxFut<'a, T> = Pin<Box<dyn Future<Output = Result<T, DbError>> + Send + 'a>>;

/// Runs a multi-statement state change atomically: commits on Ok, rolls back
/// on Err. Used for lifecycle steps that must not partially apply.
pub async fn with_transaction<T, F>(pool: &PgPool, operation: F) -> Result<T, DbError>
where
    F: for<'t> FnOnce(&'t mut Tx) -> BoxFut<'t, T>,
{
    let mut tx = pool.begin().await?;
    match operation(&mut tx).await {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            Err(err)
        }
    }
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
