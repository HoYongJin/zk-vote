/**
 * @file frontend/src/types/domain.ts
 * @desc Shared API/domain shapes returned by the backend. Fields are optional
 * where an endpoint returns only a subset (the election lists each project a
 * different view of the same row).
 */

export interface Election {
  id: string;
  name: string;
  candidates: string[];
  merkle_tree_depth: number;
  num_candidates: number;
  registration_end_time?: string;
  voting_end_time?: string;
  contract_address?: string | null;
  /** registerable list: whether the current user has completed registration. */
  isRegistered?: boolean;
  /** votable list: registration progress counters. */
  registered_voters?: number;
  total_voters?: number;
}

/** Response of POST /api/elections/:id/proof (authenticated). */
export interface ProofResponse {
  root: string;
  pathElements: string[];
  pathIndices: Array<number | string>;
  submissionTicket: string;
}

/** Response of GET /api/elections/:id/artifact-info (AR-M6 manifest hashes). */
export interface ArtifactInfo {
  wasmPath: string;
  wasmSha256: string;
  zkeyPath: string;
  zkeySha256: string;
}

/** Groth16 proof reshaped for the Solidity verifier (snarkjs order preserved). */
export interface FormattedProof {
  a: string[];
  b: string[][];
  c: string[];
}
