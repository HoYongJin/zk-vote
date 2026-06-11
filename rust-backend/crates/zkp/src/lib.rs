use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ArtifactManifest {
    pub circuit_id: String,
    pub version: String,
    pub backend: String,
    pub merkle_tree_depth: i32,
    pub num_candidates: i32,
    pub wasm_uri: String,
    pub zkey_uri: String,
    pub verification_key_uri: String,
    pub solidity_verifier_uri: String,
    pub sha256: String,
}
