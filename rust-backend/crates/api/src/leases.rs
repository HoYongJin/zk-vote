//! Single-writer Redis leases. Acquired with `SET NX EX` and released with a
//! token-checked Lua CAS so only the holder can clear its own lease.
//!
//! IMPORTANT (L-lease-double): the TTL is a **crash safety-net, not a bound on
//! the critical section**. `SET NX EX` gives mutual exclusion only until the TTL
//! expires, and there is no fencing token — so if a holder runs past the TTL
//! (e.g. a `get_receipt()` wait that outlasts it) a second caller can acquire
//! the lease and a brief two-holder window exists. Whole-section exclusivity
//! therefore rests on **AR-M5 single-instance + the in-process `relay_lock`
//! mutex**, with downstream on-chain idempotency as the backstop. That backstop
//! covers the VOTE path (on-chain nullifier uniqueness makes a redundant relay
//! revert harmlessly); the DEPLOY path is the residual gap — two sends + receipt
//! waits with no nullifier-style reconciliation, so a TTL-expiry nonce collision
//! there can orphan a contract. AR-M5 is NOT enforced in code (the staging
//! deploy script defaults to max-instances=1 but is overridable); if AR-M5 is
//! ever relaxed to multi-instance, real fencing tokens become load-bearing here.

use crate::error::ApiError;
use uuid::Uuid;

/// The single cross-instance lease that serializes EVERY transaction signed by
/// the one hot relayer key — both the admin deploy path and the anonymous vote
/// relay. The relayer EOA has a single nonce sequence, so all of its sends must
/// be single-writer across instances (AR-M5); the in-process `relay_lock` mutex
/// only covers one process. Both paths must acquire THIS key.
pub const RELAYER_LEASE_KEY: &str = "chain-relayer:tx";
/// TTL crash-backstop for the relayer lease (NOT a critical-section bound — see
/// the module doc). 900s comfortably covers a single send + receipt wait under
/// normal RPC; the G3 deploy path holds it across two sends + a DB write.
pub const RELAYER_LEASE_SECONDS: u64 = 900;

/// Serializes every transaction signed by the cold owner key. The finalize
/// lease is per-election; this lease protects the owner EOA nonce across
/// different elections running concurrently on the same Cloud Run instance.
pub const OWNER_LEASE_KEY: &str = "chain-owner:tx";
pub const OWNER_LEASE_SECONDS: u64 = 1800;

/// TTL crash-backstop for the per-election finalize lease. Raised from 600 to
/// 1800 (L-finalize-ttl) so the owner-key `configureElection` send + receipt
/// wait cannot outrun the lease under slow RPC. This lease serializes ONLY
/// same-election finalizes (its key is per-election, and the pg advisory lock is
/// per-election); the **cross-election** owner-nonce race is bounded by AR-M5
/// single-instance, NOT by this lease or the idempotent recovery path (finalize
/// signs with the OWNER key and never takes `RELAYER_LEASE_KEY`).
pub const FINALIZE_LEASE_SECONDS: u64 = 1800;

/// Per-election finalize lease key. Also taken by the supersede endpoint (G4) so
/// a supersede cannot interleave with an in-flight finalize.
pub fn finalize_lease_key(election_id: &Uuid) -> String {
    format!("election:{election_id}:finalize")
}

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
