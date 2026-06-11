//! Circom-compatible Poseidon (architecture review AR-H7).
//!
//! Every Merkle leaf, node, root, and nullifier in this system is a
//! circomlibjs Poseidon hash; one bit of divergence invalidates every proof.
//! Decision record: `light-poseidon` with its `new_circom` parameterization
//! (same round constants/MDS as circomlib). Bit-exactness is locked by
//! committed cross-language vectors generated from circomlibjs
//! (`testdata/poseidon_vectors.json`).

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use light_poseidon::{Poseidon, PoseidonError, PoseidonHasher};
use num_bigint::BigUint;

#[derive(Debug, thiserror::Error)]
pub enum HashError {
    #[error("value is not a valid decimal field element: {0}")]
    Parse(String),
    #[error("poseidon error: {0}")]
    Poseidon(#[from] PoseidonError),
}

fn field_from_dec(value: &str) -> Result<Fr, HashError> {
    let parsed = value
        .parse::<BigUint>()
        .map_err(|_| HashError::Parse(value.to_string()))?;
    Ok(Fr::from(parsed))
}

fn field_to_dec(value: Fr) -> String {
    BigUint::from_bytes_be(&value.into_bigint().to_bytes_be()).to_string()
}

/// Poseidon([x]) — the H2 leaf commitment H(secret).
pub fn hash1(input: &str) -> Result<String, HashError> {
    let mut hasher = Poseidon::<Fr>::new_circom(1)?;
    Ok(field_to_dec(hasher.hash(&[field_from_dec(input)?])?))
}

/// Poseidon([a, b]) — Merkle node hash and nullifier
/// (Poseidon(secret, election_id)).
pub fn hash2(left: &str, right: &str) -> Result<String, HashError> {
    let mut hasher = Poseidon::<Fr>::new_circom(2)?;
    Ok(field_to_dec(
        hasher.hash(&[field_from_dec(left)?, field_from_dec(right)?])?,
    ))
}
