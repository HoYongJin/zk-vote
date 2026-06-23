//! Fixed-depth Merkle tree built on `fixed-merkle-tree` semantics
//! (circomlibjs Poseidon + the tornado ZERO_ELEMENT): leaves are left-packed,
//! absent leaves are the per-level zero, and zero[i+1] = H(zero[i], zero[i]).

use crate::poseidon::{hash2, HashError};

/// keccak256("tornado") % FIELD_SIZE — must equal `ZERO_ELEMENT` in
/// `server/utils/merkle.js`.
pub const ZERO_ELEMENT: &str =
    "21663839004416932945382355908790599225266501822907911457504978515578255421292";

#[derive(Debug, thiserror::Error)]
pub enum MerkleError {
    #[error("tree is full: {leaves} leaves exceed capacity {capacity}")]
    TreeFull { leaves: usize, capacity: usize },
    #[error("leaf index {index} out of range ({leaves} leaves)")]
    IndexOutOfRange { index: usize, leaves: usize },
    #[error(transparent)]
    Hash(#[from] HashError),
}

pub struct MerkleProofPath {
    pub path_elements: Vec<String>,
    pub path_indices: Vec<u8>,
}

pub struct FixedMerkleTree {
    depth: usize,
    /// levels[0] = padded? No — levels[0] holds only the real leaves; the
    /// per-level zero stands in for absent siblings, like fixed-merkle-tree.
    levels: Vec<Vec<String>>,
    zeros: Vec<String>,
}

impl FixedMerkleTree {
    pub fn build(depth: usize, leaves: &[String]) -> Result<Self, MerkleError> {
        let capacity = 1usize << depth;
        if leaves.len() > capacity {
            return Err(MerkleError::TreeFull {
                leaves: leaves.len(),
                capacity,
            });
        }

        let mut zeros = Vec::with_capacity(depth + 1);
        zeros.push(ZERO_ELEMENT.to_string());
        for level in 0..depth {
            let zero = &zeros[level];
            zeros.push(hash2(zero, zero)?);
        }

        let mut levels: Vec<Vec<String>> = vec![leaves.to_vec()];
        for level in 0..depth {
            let current = &levels[level];
            let mut next = Vec::with_capacity(current.len().div_ceil(2));
            for pair in current.chunks(2) {
                let left = &pair[0];
                let right = pair.get(1).unwrap_or(&zeros[level]);
                next.push(hash2(left, right)?);
            }
            levels.push(next);
        }

        Ok(Self {
            depth,
            levels,
            zeros,
        })
    }

    pub fn root(&self) -> String {
        self.levels[self.depth]
            .first()
            .cloned()
            .unwrap_or_else(|| self.zeros[self.depth].clone())
    }

    pub fn path(&self, index: usize) -> Result<MerkleProofPath, MerkleError> {
        let leaves = self.levels[0].len();
        if index >= leaves {
            return Err(MerkleError::IndexOutOfRange { index, leaves });
        }

        let mut path_elements = Vec::with_capacity(self.depth);
        let mut path_indices = Vec::with_capacity(self.depth);
        let mut position = index;
        for level in 0..self.depth {
            let sibling_index = position ^ 1;
            let sibling = self.levels[level]
                .get(sibling_index)
                .cloned()
                .unwrap_or_else(|| self.zeros[level].clone());
            path_elements.push(sibling);
            path_indices.push((position & 1) as u8);
            position >>= 1;
        }

        Ok(MerkleProofPath {
            path_elements,
            path_indices,
        })
    }
}
