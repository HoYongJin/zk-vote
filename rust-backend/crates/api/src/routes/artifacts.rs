use crate::auth::CurrentUser;
use crate::error::ApiError;
use crate::state::AppState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path as FsPath, PathBuf};
use uuid::Uuid;

fn coded(status: u16, code: &'static str, details: impl Into<String>) -> ApiError {
    ApiError::Coded {
        status,
        code,
        details: details.into(),
    }
}

#[derive(sqlx::FromRow)]
struct ArtifactInfoRow {
    merkle_tree_depth: i32,
    num_candidates: i32,
    wasm_uri: Option<String>,
    zkey_uri: Option<String>,
    manifest: Option<Value>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ArtifactInfoResponse {
    pub success: bool,
    #[serde(rename = "wasmPath")]
    pub wasm_path: String,
    #[serde(rename = "zkeyPath")]
    pub zkey_path: String,
    #[serde(rename = "wasmSha256")]
    pub wasm_sha256: String,
    #[serde(rename = "zkeySha256")]
    pub zkey_sha256: String,
    #[serde(rename = "verificationKeySha256")]
    pub verification_key_sha256: String,
    #[serde(rename = "publicSignalCount")]
    pub public_signal_count: u64,
}

fn object_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object_field(value, key)?.as_str())
        .map(ToOwned::to_owned)
}

fn nested_string_field(value: &Value, object_key: &str, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object_field(object_field(value, object_key)?, key)?.as_str())
        .map(ToOwned::to_owned)
}

fn hash_field(manifest: &Value, direct: &[&str], nested: &[&str]) -> Result<String, ApiError> {
    string_field(manifest, direct)
        .or_else(|| nested_string_field(manifest, "sha256", nested))
        .or_else(|| nested_string_field(manifest, "hashes", direct))
        .ok_or_else(|| {
            coded(
                409,
                "ARTIFACT_MANIFEST_INCOMPLETE",
                "The artifact manifest is missing a required sha256 field.",
            )
        })
}

fn public_signal_count(manifest: &Value) -> u64 {
    object_field(manifest, "publicSignalCount")
        .or_else(|| object_field(manifest, "public_signal_count"))
        .and_then(Value::as_u64)
        .unwrap_or(4)
}

fn normalize_browser_artifact_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("gs://")
    {
        return None;
    }

    let artifact_path = trimmed
        .strip_prefix("/api/zkp-files/")
        .or_else(|| trimmed.strip_prefix("api/zkp-files/"))
        .unwrap_or(trimmed);
    if !allowed_zkp_artifact_path(artifact_path) {
        return None;
    }

    Some(format!(
        "/api/zkp-files/{}",
        artifact_path.trim_start_matches('/')
    ))
}

fn artifact_path_from_manifest(value: &str) -> Result<String, ApiError> {
    normalize_browser_artifact_path(value).ok_or_else(|| {
        coded(
            409,
            "ARTIFACT_PATH_UNSAFE",
            "The artifact manifest contains an unsafe browser artifact path.",
        )
    })
}

fn artifact_path_from_uri(
    uri: &str,
    configured_bucket: Option<&str>,
) -> Result<Option<String>, ApiError> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Err(coded(
            409,
            "ARTIFACT_PATH_UNSAFE",
            "External artifact URLs are not served to the browser.",
        ));
    }
    if trimmed.starts_with("gs://") {
        return match configured_bucket {
            Some(bucket) => api_path_from_gs_uri(trimmed, Some(bucket))
                .map(Some)
                .ok_or_else(|| {
                    coded(
                        409,
                        "ARTIFACT_PATH_UNSAFE",
                        "The GCS artifact URI is outside the configured artifact bucket or path allowlist.",
                    )
                }),
            None => Ok(None),
        };
    }

    normalize_browser_artifact_path(trimmed)
        .map(Some)
        .ok_or_else(|| {
            coded(
                409,
                "ARTIFACT_PATH_UNSAFE",
                "The artifact URI is outside the served artifact path allowlist.",
            )
        })
}

fn browser_artifact_path(
    uri: Option<&str>,
    manifest: &Value,
    manifest_keys: &[&str],
    default_path: String,
    configured_bucket: Option<&str>,
) -> Result<String, ApiError> {
    if let Some(path) = string_field(manifest, manifest_keys) {
        return artifact_path_from_manifest(&path);
    }

    if let Some(uri) = uri {
        if let Some(path) = artifact_path_from_uri(uri, configured_bucket)? {
            return Ok(path);
        }
    }

    Ok(default_path)
}

fn artifact_info_response(
    row: ArtifactInfoRow,
    configured_bucket: Option<&str>,
) -> Result<ArtifactInfoResponse, ApiError> {
    let manifest = row.manifest.ok_or_else(|| {
        coded(
            404,
            "ARTIFACTS_NOT_RECORDED",
            "No deploy-time artifact hashes are recorded for this election.",
        )
    })?;
    let build_dir = format!("build_{}_{}", row.merkle_tree_depth, row.num_candidates);

    Ok(ArtifactInfoResponse {
        success: true,
        wasm_path: browser_artifact_path(
            row.wasm_uri.as_deref(),
            &manifest,
            &["wasmPath", "wasm_path"],
            format!("/api/zkp-files/{build_dir}/VoteCheck_temp_js/VoteCheck_temp.wasm"),
            configured_bucket,
        )?,
        zkey_path: browser_artifact_path(
            row.zkey_uri.as_deref(),
            &manifest,
            &["zkeyPath", "zkey_path"],
            format!("/api/zkp-files/{build_dir}/circuit_final.zkey"),
            configured_bucket,
        )?,
        wasm_sha256: hash_field(&manifest, &["wasmSha256", "wasm_sha256"], &["wasm"])?,
        zkey_sha256: hash_field(&manifest, &["zkeySha256", "zkey_sha256"], &["zkey"])?,
        verification_key_sha256: hash_field(
            &manifest,
            &["verificationKeySha256", "verification_key_sha256"],
            &["verification_key", "verificationKey"],
        )?,
        public_signal_count: public_signal_count(&manifest),
    })
}

/// Node-compatible artifact manifest endpoint used by the frontend before it
/// fetches wasm/zkey bytes. Authenticated for parity with the Node route; it
/// intentionally does not use AdminUser.
pub async fn artifact_info(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(election_id): Path<Uuid>,
) -> Result<Json<ArtifactInfoResponse>, ApiError> {
    let row = sqlx::query_as::<_, ArtifactInfoRow>(
        "SELECT \
             COALESCE(za.merkle_tree_depth, e.merkle_tree_depth) AS merkle_tree_depth, \
             COALESCE(za.num_candidates, e.num_candidates) AS num_candidates, \
             za.wasm_uri, za.zkey_uri, za.manifest \
         FROM elections e \
         LEFT JOIN contract_deployments cd ON cd.election_id = e.id \
         LEFT JOIN zk_artifacts za ON za.id = cd.zk_artifact_id \
         WHERE e.id = $1",
    )
    .bind(election_id)
    .fetch_optional(&state.pg)
    .await
    .map_err(zkvote_db::DbError::from)?
    .ok_or_else(|| {
        coded(
            404,
            "ELECTION_NOT_FOUND",
            format!("Election with ID {election_id} not found."),
        )
    })?;

    Ok(Json(artifact_info_response(
        row,
        state.config.artifact_bucket.as_deref(),
    )?))
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && value != "."
        && value != ".."
}

fn valid_build_dir(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("build_") else {
        return false;
    };
    let mut pieces = rest.split('_');
    let Some(depth) = pieces.next() else {
        return false;
    };
    let Some(candidates) = pieces.next() else {
        return false;
    };
    pieces.next().is_none()
        && depth.parse::<u8>().is_ok_and(|n| (1..=20).contains(&n))
        && candidates.parse::<u16>().is_ok_and(|n| n > 0)
}

fn valid_canonical_gcs_path(parts: &[&str]) -> bool {
    match parts {
        ["circuits", circuit_id, version, "circuit_final.zkey"] => {
            safe_segment(circuit_id) && safe_segment(version)
        }
        ["circuits", circuit_id, version, "verification_key.json"] => {
            safe_segment(circuit_id) && safe_segment(version)
        }
        ["circuits", circuit_id, version, "VoteCheck_temp_js", "VoteCheck_temp.wasm"] => {
            safe_segment(circuit_id) && safe_segment(version)
        }
        _ => false,
    }
}

fn allowed_zkp_artifact_path(value: &str) -> bool {
    let clean = value.trim_start_matches('/');
    let parts: Vec<&str> = clean.split('/').collect();
    match parts.as_slice() {
        [build, "circuit_final.zkey"] => valid_build_dir(build),
        [build, "verification_key.json"] => valid_build_dir(build),
        [build, "VoteCheck_temp_js", "VoteCheck_temp.wasm"] => valid_build_dir(build),
        _ => valid_canonical_gcs_path(&parts),
    }
}

fn content_type(path: &str) -> &'static str {
    if path.ends_with(".wasm") {
        "application/wasm"
    } else if path.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

fn artifact_file_path(base_dir: &str, artifact_path: &str) -> PathBuf {
    FsPath::new(base_dir).join(artifact_path.trim_start_matches('/'))
}

fn parse_gs_uri(uri: &str) -> Option<(&str, &str)> {
    let rest = uri.strip_prefix("gs://")?;
    let (bucket, object) = rest.split_once('/')?;
    if bucket.is_empty() || object.is_empty() {
        return None;
    }
    Some((bucket, object))
}

fn api_path_from_gs_uri(uri: &str, configured_bucket: Option<&str>) -> Option<String> {
    let (bucket, object) = parse_gs_uri(uri)?;
    if configured_bucket != Some(bucket) || !allowed_zkp_artifact_path(object) {
        return None;
    }
    Some(format!("/api/zkp-files/{}", object.trim_start_matches('/')))
}

fn percent_encode_gcs_object(object: &str) -> String {
    let mut encoded = String::new();
    for byte in object.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn gcs_media_url(base_url: &str, bucket: &str, object: &str) -> String {
    format!(
        "{}/storage/v1/b/{}/o/{}?alt=media",
        base_url.trim_end_matches('/'),
        bucket,
        percent_encode_gcs_object(object)
    )
}

#[derive(Deserialize)]
struct MetadataTokenResponse {
    access_token: String,
}

async fn metadata_access_token(state: &AppState) -> Result<String, ApiError> {
    let response = reqwest::Client::new()
        .get(&state.config.gcs_metadata_token_url)
        .header("Metadata-Flavor", "Google")
        .send()
        .await
        .map_err(|err| coded(502, "ARTIFACT_STORE_UNAVAILABLE", err.to_string()))?;

    if !response.status().is_success() {
        return Err(coded(
            502,
            "ARTIFACT_STORE_UNAVAILABLE",
            "Failed to fetch a GCS access token from the metadata server.",
        ));
    }

    let token = response
        .json::<MetadataTokenResponse>()
        .await
        .map_err(|err| coded(502, "ARTIFACT_STORE_UNAVAILABLE", err.to_string()))?;
    if token.access_token.is_empty() {
        return Err(coded(
            502,
            "ARTIFACT_STORE_UNAVAILABLE",
            "Metadata server returned an empty GCS access token.",
        ));
    }
    Ok(token.access_token)
}

async fn read_gcs_artifact(state: &AppState, artifact_path: &str) -> Result<Vec<u8>, ApiError> {
    let bucket = state.config.artifact_bucket.as_deref().ok_or_else(|| {
        coded(
            503,
            "ARTIFACT_STORE_NOT_READY",
            "ARTIFACT_BUCKET must be configured when ARTIFACT_STORE=gcs.",
        )
    })?;
    let object = artifact_path.trim_start_matches('/');
    let token = metadata_access_token(state).await?;
    let url = gcs_media_url(&state.config.gcs_storage_base_url, bucket, object);
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|err| coded(502, "ARTIFACT_STORE_UNAVAILABLE", err.to_string()))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(coded(404, "NOT_FOUND", "Not a served proving artifact."));
    }
    if !response.status().is_success() {
        return Err(coded(
            502,
            "ARTIFACT_STORE_UNAVAILABLE",
            "Failed to fetch the proving artifact from GCS.",
        ));
    }

    Ok(response
        .bytes()
        .await
        .map_err(|err| coded(502, "ARTIFACT_STORE_UNAVAILABLE", err.to_string()))?
        .to_vec())
}

async fn read_local_artifact(state: &AppState, artifact_path: &str) -> Result<Vec<u8>, ApiError> {
    let file_path = artifact_file_path(&state.config.artifact_local_dir, artifact_path);
    tokio::fs::read(&file_path).await.map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            coded(404, "NOT_FOUND", "Not a served proving artifact.")
        } else {
            ApiError::Internal(format!("failed to read artifact file: {err}"))
        }
    })
}

/// Strict local replacement for Node's `/api/zkp-files` static mount. It only
/// serves the generated proving artifacts the browser needs and refuses every
/// other file under the artifact root.
pub async fn zkp_file(
    State(state): State<AppState>,
    Path(artifact_path): Path<String>,
) -> Result<Response, ApiError> {
    if !allowed_zkp_artifact_path(&artifact_path) {
        return Err(coded(404, "NOT_FOUND", "Not a served proving artifact."));
    }

    let bytes = match state.config.artifact_store.as_str() {
        "local" => read_local_artifact(&state, &artifact_path).await?,
        "gcs" => read_gcs_artifact(&state, &artifact_path).await?,
        other => {
            return Err(ApiError::Internal(format!(
                "unsupported artifact store: {other}"
            )))
        }
    };

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type(&artifact_path))],
        Body::from(bytes),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn artifact_info_matches_node_response_shape() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 4,
            num_candidates: 5,
            wasm_uri: None,
            zkey_uri: None,
            manifest: Some(json!({
                "wasmSha256": "a".repeat(64),
                "zkeySha256": "b".repeat(64),
                "verificationKeySha256": "c".repeat(64),
                "publicSignalCount": 4
            })),
        };

        let response = artifact_info_response(row, None).unwrap();

        assert_eq!(
            response.wasm_path,
            "/api/zkp-files/build_4_5/VoteCheck_temp_js/VoteCheck_temp.wasm"
        );
        assert_eq!(
            response.zkey_path,
            "/api/zkp-files/build_4_5/circuit_final.zkey"
        );
        assert_eq!(response.wasm_sha256, "a".repeat(64));
        assert_eq!(response.zkey_sha256, "b".repeat(64));
        assert_eq!(response.verification_key_sha256, "c".repeat(64));
        assert_eq!(response.public_signal_count, 4);
    }

    #[test]
    fn artifact_info_accepts_canonical_nested_hash_manifest() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 5,
            num_candidates: 4,
            wasm_uri: Some("gs://bucket/circuits/v1/proof.wasm".to_string()),
            zkey_uri: Some("gs://bucket/circuits/v1/proof.zkey".to_string()),
            manifest: Some(json!({
                "sha256": {
                    "wasm": "d".repeat(64),
                    "zkey": "e".repeat(64),
                    "verification_key": "f".repeat(64)
                },
                "public_signal_count": 4
            })),
        };

        let response = artifact_info_response(row, None).unwrap();

        assert_eq!(
            response.wasm_path,
            "/api/zkp-files/build_5_4/VoteCheck_temp_js/VoteCheck_temp.wasm"
        );
        assert_eq!(
            response.zkey_path,
            "/api/zkp-files/build_5_4/circuit_final.zkey"
        );
        assert_eq!(response.wasm_sha256, "d".repeat(64));
        assert_eq!(response.zkey_sha256, "e".repeat(64));
        assert_eq!(response.verification_key_sha256, "f".repeat(64));
    }

    #[test]
    fn artifact_info_rejects_missing_hashes() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 4,
            num_candidates: 5,
            wasm_uri: None,
            zkey_uri: None,
            manifest: Some(json!({ "wasmSha256": "a".repeat(64) })),
        };

        assert!(artifact_info_response(row, None).is_err());
    }

    #[test]
    fn artifact_info_accepts_manifest_api_artifact_paths() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 4,
            num_candidates: 5,
            wasm_uri: None,
            zkey_uri: None,
            manifest: Some(json!({
                "wasmPath": "/api/zkp-files/build_4_5/VoteCheck_temp_js/VoteCheck_temp.wasm",
                "zkeyPath": "build_4_5/circuit_final.zkey",
                "wasmSha256": "a".repeat(64),
                "zkeySha256": "b".repeat(64),
                "verificationKeySha256": "c".repeat(64)
            })),
        };

        let response = artifact_info_response(row, None).unwrap();

        assert_eq!(
            response.wasm_path,
            "/api/zkp-files/build_4_5/VoteCheck_temp_js/VoteCheck_temp.wasm"
        );
        assert_eq!(
            response.zkey_path,
            "/api/zkp-files/build_4_5/circuit_final.zkey"
        );
    }

    #[test]
    fn artifact_info_rejects_manifest_external_artifact_paths() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 4,
            num_candidates: 5,
            wasm_uri: None,
            zkey_uri: None,
            manifest: Some(json!({
                "wasmPath": "https://evil.example/VoteCheck_temp.wasm",
                "zkeyPath": "/api/zkp-files/build_4_5/circuit_final.zkey",
                "wasmSha256": "a".repeat(64),
                "zkeySha256": "b".repeat(64),
                "verificationKeySha256": "c".repeat(64)
            })),
        };

        let err = artifact_info_response(row, None).expect_err("external URL must fail closed");

        assert!(format!("{err:?}").contains("ARTIFACT_PATH_UNSAFE"));
    }

    #[test]
    fn artifact_info_rejects_manifest_path_traversal() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 4,
            num_candidates: 5,
            wasm_uri: None,
            zkey_uri: None,
            manifest: Some(json!({
                "wasmPath": "/api/zkp-files/../server/.env",
                "zkeyPath": "/api/zkp-files/build_4_5/circuit_final.zkey",
                "wasmSha256": "a".repeat(64),
                "zkeySha256": "b".repeat(64),
                "verificationKeySha256": "c".repeat(64)
            })),
        };

        let err = artifact_info_response(row, None).expect_err("traversal must fail closed");

        assert!(format!("{err:?}").contains("ARTIFACT_PATH_UNSAFE"));
    }

    #[test]
    fn artifact_info_rejects_external_artifact_uris() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 4,
            num_candidates: 5,
            wasm_uri: Some("https://evil.example/VoteCheck_temp.wasm".to_string()),
            zkey_uri: None,
            manifest: Some(json!({
                "wasmSha256": "a".repeat(64),
                "zkeySha256": "b".repeat(64),
                "verificationKeySha256": "c".repeat(64)
            })),
        };

        let err = artifact_info_response(row, None).expect_err("external URI must fail closed");

        assert!(format!("{err:?}").contains("ARTIFACT_PATH_UNSAFE"));
    }

    #[test]
    fn artifact_info_rejects_unrecognized_artifact_uris() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 4,
            num_candidates: 5,
            wasm_uri: Some("ftp://evil.example/VoteCheck_temp.wasm".to_string()),
            zkey_uri: None,
            manifest: Some(json!({
                "wasmSha256": "a".repeat(64),
                "zkeySha256": "b".repeat(64),
                "verificationKeySha256": "c".repeat(64)
            })),
        };

        let err =
            artifact_info_response(row, None).expect_err("unknown URI schemes must fail closed");

        assert!(format!("{err:?}").contains("ARTIFACT_PATH_UNSAFE"));
    }

    #[test]
    fn artifact_info_rejects_wrong_gcs_bucket_when_bucket_is_configured() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 5,
            num_candidates: 4,
            wasm_uri: Some(
                "gs://other-bucket/circuits/votecheck/v1/VoteCheck_temp_js/VoteCheck_temp.wasm"
                    .to_string(),
            ),
            zkey_uri: Some(
                "gs://zkvote-staging-artifacts/circuits/votecheck/v1/circuit_final.zkey"
                    .to_string(),
            ),
            manifest: Some(json!({
                "wasmSha256": "a".repeat(64),
                "zkeySha256": "b".repeat(64),
                "verificationKeySha256": "c".repeat(64)
            })),
        };

        let err = artifact_info_response(row, Some("zkvote-staging-artifacts"))
            .expect_err("wrong GCS bucket must fail closed");

        assert!(format!("{err:?}").contains("ARTIFACT_PATH_UNSAFE"));
    }

    #[test]
    fn zkp_file_path_filter_matches_node_static_surface() {
        assert!(allowed_zkp_artifact_path(
            "build_4_5/VoteCheck_temp_js/VoteCheck_temp.wasm"
        ));
        assert!(allowed_zkp_artifact_path("/build_4_5/circuit_final.zkey"));
        assert!(allowed_zkp_artifact_path(
            "/build_4_5/verification_key.json"
        ));
        assert!(allowed_zkp_artifact_path(
            "/circuits/votecheck/v1/VoteCheck_temp_js/VoteCheck_temp.wasm"
        ));
        assert!(allowed_zkp_artifact_path(
            "/circuits/votecheck/v1/circuit_final.zkey"
        ));
        assert!(!allowed_zkp_artifact_path("/build_4_5/VoteCheck.circom"));
        assert!(!allowed_zkp_artifact_path("/../server/.env"));
        assert!(!allowed_zkp_artifact_path("/build_21_5/circuit_final.zkey"));
        assert!(!allowed_zkp_artifact_path(
            "/circuits/votecheck/../circuit_final.zkey"
        ));
    }

    #[test]
    fn artifact_info_converts_matching_gs_uris_to_api_paths() {
        let row = ArtifactInfoRow {
            merkle_tree_depth: 5,
            num_candidates: 4,
            wasm_uri: Some(
                "gs://zkvote-staging-artifacts/circuits/votecheck/v1/VoteCheck_temp_js/VoteCheck_temp.wasm"
                    .to_string(),
            ),
            zkey_uri: Some(
                "gs://zkvote-staging-artifacts/circuits/votecheck/v1/circuit_final.zkey"
                    .to_string(),
            ),
            manifest: Some(json!({
                "wasmSha256": "a".repeat(64),
                "zkeySha256": "b".repeat(64),
                "verificationKeySha256": "c".repeat(64)
            })),
        };

        let response = artifact_info_response(row, Some("zkvote-staging-artifacts")).unwrap();

        assert_eq!(
            response.wasm_path,
            "/api/zkp-files/circuits/votecheck/v1/VoteCheck_temp_js/VoteCheck_temp.wasm"
        );
        assert_eq!(
            response.zkey_path,
            "/api/zkp-files/circuits/votecheck/v1/circuit_final.zkey"
        );
    }

    #[test]
    fn gcs_media_url_encodes_object_name_as_one_path_segment() {
        assert_eq!(
            gcs_media_url(
                "https://storage.googleapis.com/",
                "bucket",
                "circuits/votecheck/v1/circuit_final.zkey"
            ),
            "https://storage.googleapis.com/storage/v1/b/bucket/o/circuits%2Fvotecheck%2Fv1%2Fcircuit_final.zkey?alt=media"
        );
    }
}
