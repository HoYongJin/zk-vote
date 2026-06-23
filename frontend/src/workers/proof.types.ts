import type { Groth16Proof, PublicSignals } from 'snarkjs';

/** Circuit inputs assembled in VotePage and consumed by snarkjs.groth16.fullProve. */
export type ProofInputs = {
  root_in: string;
  user_secret: string;
  vote: number[];
  pathElements: string[];
  pathIndices: Array<number | string>;
  election_id: string;
};

/**
 * Message posted to the proof worker. Either the integrity-verified in-memory
 * artifacts (wasmData/zkeyData, AR-M6) or the legacy URL fallback for
 * pre-manifest elections must be present for each artifact.
 */
export interface WorkerRequest {
  inputs: ProofInputs;
  wasmPath?: string;
  zkeyPath?: string;
  wasmData?: Uint8Array;
  zkeyData?: Uint8Array;
}

/** Message posted back from the worker. */
export type WorkerResponse =
  | { status: 'success'; proof: Groth16Proof; publicSignals: PublicSignals }
  | { status: 'error'; message: string };
