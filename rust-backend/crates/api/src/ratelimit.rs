//! Per-identity Redis rate limiting (L-proof-rl).
//!
//! Uses an ATOMIC `INCR` + conditional `EXPIRE` Lua script (one round-trip, one
//! atomic execution) rather than a non-atomic INCR-then-EXPIRE: a dropped call
//! between the two commands would otherwise leave a counter with no TTL that
//! climbs to the cap and permanently locks the caller out.

use crate::error::ApiError;

/// Atomically increments the counter at `key`, sets a `window_secs` TTL on the
/// first hit, and returns `Err(429)` once the count exceeds `limit`. Fails
/// CLOSED with a 503 on a Redis failure (the caller needs Redis anyway, so a
/// blip must not silently disable the limit).
pub async fn check_rate(
    client: &redis::Client,
    key: &str,
    limit: u64,
    window_secs: u64,
) -> Result<(), ApiError> {
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(rate_unavailable)?;
    let count: i64 = redis::Script::new(
        "local n = redis.call('INCR', KEYS[1]) \
         if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end \
         return n",
    )
    .key(key)
    .arg(window_secs)
    .invoke_async(&mut conn)
    .await
    .map_err(rate_unavailable)?;

    if count > limit as i64 {
        return Err(ApiError::Coded {
            status: 429,
            code: "RATE_LIMITED",
            details: "Too many ticket requests; slow down and retry shortly.".to_string(),
        });
    }
    Ok(())
}

fn rate_unavailable(_err: redis::RedisError) -> ApiError {
    ApiError::Coded {
        status: 503,
        code: "RATE_LIMITER_UNAVAILABLE",
        details: "The rate limiter backend is temporarily unavailable; please retry.".to_string(),
    }
}
