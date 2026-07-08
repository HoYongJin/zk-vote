//! Single-use submission tickets (Redis).
//!
//! Privacy invariant (AR-H5): a ticket binds the ELECTION and MERKLE ROOT
//! only — never a nullifier. The server must not be able to link the
//! authenticated `/proof` caller to the anonymous `/submit` nullifier.

use crate::error::ApiError;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const TICKET_EXPIRY_SECONDS: u64 = 300;
pub const MAX_PREFLIGHT_FAILURES_PER_TICKET: u64 = 3;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TicketPayload {
    #[serde(rename = "electionId")]
    pub election_id: Uuid,
    #[serde(rename = "merkleRoot")]
    pub merkle_root: String,
    #[serde(rename = "issuedAt", skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<String>,
}

fn key(token: &str) -> String {
    format!("submission-ticket:{token}")
}

fn preflight_failure_key(token: &str) -> String {
    format!("submission-ticket-preflight-failures:{token}")
}

async fn connection(client: &redis::Client) -> Result<redis::aio::MultiplexedConnection, ApiError> {
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(ApiError::from)
}

pub async fn issue(client: &redis::Client, payload: &TicketPayload) -> Result<String, ApiError> {
    let token = Uuid::new_v4().to_string();
    let mut conn = connection(client).await?;
    let serialized = serde_json::to_string(payload)
        .map_err(|err| ApiError::Internal(format!("ticket serialization failed: {err}")))?;
    let _: () = redis::cmd("SET")
        .arg(key(&token))
        .arg(serialized)
        .arg("EX")
        .arg(TICKET_EXPIRY_SECONDS)
        .arg("NX")
        .query_async(&mut conn)
        .await
        .map_err(ApiError::from)?;
    Ok(token)
}

/// L-ticket-burn: re-stores an already-consumed ticket under the SAME token so a
/// voter can retry `/submit` without re-proving, after a genuine never-landed
/// transport error (nullifier confirmed still unused on-chain). Preserves the
/// original payload — including `issued_at`, so submission-jitter stays anchored
/// to first issue. `NX` so it never clobbers a concurrently re-issued ticket.
pub async fn restore(
    client: &redis::Client,
    token: &str,
    payload: &TicketPayload,
) -> Result<(), ApiError> {
    let mut conn = connection(client).await?;
    let serialized = serde_json::to_string(payload)
        .map_err(|err| ApiError::Internal(format!("ticket serialization failed: {err}")))?;
    let _: () = redis::cmd("SET")
        .arg(key(token))
        .arg(serialized)
        .arg("EX")
        .arg(TICKET_EXPIRY_SECONDS)
        .arg("NX")
        .query_async(&mut conn)
        .await
        .map_err(ApiError::from)?;
    Ok(())
}

/// Destructive consume (GETDEL). `/submit` claims the bearer token before
/// chain/RPC preflight, then restores the same payload only for allowed retry
/// paths.
pub async fn consume(
    client: &redis::Client,
    token: &str,
) -> Result<Option<TicketPayload>, ApiError> {
    let mut conn = connection(client).await?;
    let raw: Option<String> = redis::cmd("GETDEL")
        .arg(key(token))
        .query_async(&mut conn)
        .await
        .map_err(ApiError::from)?;
    parse(raw)
}

/// Records a verifier/contract preflight rejection against the ticket without
/// storing identity or nullifier. This prevents one valid ticket from driving
/// unbounded expensive `eth_call` verifier work until TTL expiry.
pub async fn record_preflight_failure(
    client: &redis::Client,
    token: &str,
) -> Result<u64, ApiError> {
    let mut conn = connection(client).await?;
    let count: u64 = redis::cmd("INCR")
        .arg(preflight_failure_key(token))
        .query_async(&mut conn)
        .await
        .map_err(ApiError::from)?;
    let _: () = redis::cmd("EXPIRE")
        .arg(preflight_failure_key(token))
        .arg(TICKET_EXPIRY_SECONDS)
        .query_async(&mut conn)
        .await
        .map_err(ApiError::from)?;
    Ok(count)
}

fn parse(raw: Option<String>) -> Result<Option<TicketPayload>, ApiError> {
    match raw {
        None => Ok(None),
        Some(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|err| ApiError::Internal(format!("ticket payload malformed: {err}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_payload_rejects_legacy_nullifier_binding() {
        let err = serde_json::from_str::<TicketPayload>(
            r#"{
                "electionId": "00000000-0000-0000-0000-00000000007b",
                "merkleRoot": "123",
                "nullifierHash": "456"
            }"#,
        )
        .expect_err("legacy nullifier-bound tickets must fail closed");

        assert!(err.to_string().contains("unknown field"));
    }

    #[test]
    fn ticket_payload_accepts_election_and_root_only() {
        let payload = serde_json::from_str::<TicketPayload>(
            r#"{
                "electionId": "00000000-0000-0000-0000-00000000007b",
                "merkleRoot": "123",
                "issuedAt": "2026-06-12T00:00:00.000Z"
            }"#,
        )
        .unwrap();

        assert_eq!(
            payload.election_id,
            "00000000-0000-0000-0000-00000000007b"
                .parse::<Uuid>()
                .unwrap()
        );
        assert_eq!(payload.merkle_root, "123");
        assert_eq!(
            payload.issued_at.as_deref(),
            Some("2026-06-12T00:00:00.000Z")
        );
    }
}
