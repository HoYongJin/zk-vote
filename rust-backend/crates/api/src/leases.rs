//! Single-writer Redis leases. Acquired with `SET NX EX` (a TTL safety net so
//! a crashed holder cannot wedge the resource forever) and released with a
//! token-checked Lua CAS so only the holder can clear its own lease.

use crate::error::ApiError;
use uuid::Uuid;

/// The single cross-instance lease that serializes EVERY transaction signed by
/// the one hot relayer key — both the admin deploy path and the anonymous vote
/// relay. The relayer EOA has a single nonce sequence, so all of its sends must
/// be single-writer across instances (AR-M5); the in-process `relay_lock` mutex
/// only covers one process. Both paths must acquire THIS key.
pub const RELAYER_LEASE_KEY: &str = "chain-relayer:tx";
/// TTL safety net for the relayer lease: long enough to cover one send +
/// receipt wait, short enough that a crashed holder frees the relayer.
pub const RELAYER_LEASE_SECONDS: u64 = 900;

pub struct RedisLease {
    key: String,
    token: String,
}

/// Acquires `key` for `ttl_seconds`, or returns a `409` carrying
/// `conflict_code`/`conflict_details` when another holder owns it.
pub async fn acquire(
    client: &redis::Client,
    key: String,
    ttl_seconds: u64,
    conflict_code: &'static str,
    conflict_details: &'static str,
) -> Result<RedisLease, ApiError> {
    let token = Uuid::new_v4().to_string();
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(ApiError::from)?;
    let reply: Option<String> = redis::cmd("SET")
        .arg(&key)
        .arg(&token)
        .arg("NX")
        .arg("EX")
        .arg(ttl_seconds)
        .query_async(&mut conn)
        .await
        .map_err(ApiError::from)?;

    if reply.as_deref() == Some("OK") {
        Ok(RedisLease { key, token })
    } else {
        Err(ApiError::Coded {
            status: 409,
            code: conflict_code,
            details: conflict_details.to_string(),
        })
    }
}

/// Releases the lease only if this holder still owns it (token match), so an
/// expired-then-reacquired lease is never cleared by the previous holder.
pub async fn release(client: &redis::Client, lease: &RedisLease) -> Result<(), ApiError> {
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(ApiError::from)?;
    let _: i32 = redis::Script::new(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then \
             return redis.call('DEL', KEYS[1]) \
         else \
             return 0 \
         end",
    )
    .key(&lease.key)
    .arg(&lease.token)
    .invoke_async(&mut conn)
    .await
    .map_err(ApiError::from)?;
    Ok(())
}
