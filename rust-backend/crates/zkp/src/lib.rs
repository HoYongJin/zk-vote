pub mod merkle;
pub mod poseidon;

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

#[cfg(test)]
mod cross_language_vectors {
    //! AR-H7 gate: the committed circomlibjs vectors must reproduce
    //! byte-for-byte through the Rust Poseidon/Merkle implementation.
    use crate::merkle::FixedMerkleTree;
    use crate::poseidon::{hash1, hash2};
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vectors {
        depth: usize,
        #[serde(rename = "electionId")]
        election_id: String,
        secrets: Vec<String>,
        leaves: Vec<String>,
        nullifiers: Vec<String>,
        root: String,
        #[serde(rename = "pathIndex")]
        path_index: usize,
        #[serde(rename = "pathElements")]
        path_elements: Vec<String>,
        #[serde(rename = "pathIndices")]
        path_indices: Vec<u8>,
        #[serde(rename = "pairHash_1_2")]
        pair_hash_1_2: String,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../testdata/poseidon_vectors.json")).unwrap()
    }

    #[test]
    fn leaf_commitments_match_circomlibjs() {
        let v = vectors();
        for (secret, expected) in v.secrets.iter().zip(&v.leaves) {
            assert_eq!(
                &hash1(secret).unwrap(),
                expected,
                "H(secret) diverged for {secret}"
            );
        }
    }

    #[test]
    fn nullifiers_match_circomlibjs() {
        let v = vectors();
        for (secret, expected) in v.secrets.iter().zip(&v.nullifiers) {
            assert_eq!(
                &hash2(secret, &v.election_id).unwrap(),
                expected,
                "Poseidon(secret, election_id) diverged for {secret}"
            );
        }
    }

    #[test]
    fn pair_hash_matches_circomlibjs() {
        let v = vectors();
        assert_eq!(hash2("1", "2").unwrap(), v.pair_hash_1_2);
    }

    #[test]
    fn merkle_root_and_path_match_fixed_merkle_tree() {
        let v = vectors();
        let tree = FixedMerkleTree::build(v.depth, &v.leaves).unwrap();
        assert_eq!(tree.root(), v.root, "root diverged");
        let path = tree.path(v.path_index).unwrap();
        assert_eq!(path.path_elements, v.path_elements, "pathElements diverged");
        assert_eq!(path.path_indices, v.path_indices, "pathIndices diverged");
    }

    #[test]
    fn over_capacity_is_a_typed_error() {
        let leaves: Vec<String> = (0..5).map(|i| i.to_string()).collect();
        assert!(FixedMerkleTree::build(2, &leaves).is_err());
    }
}
