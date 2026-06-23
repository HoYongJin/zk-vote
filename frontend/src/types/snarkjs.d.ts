/**
 * Minimal type shim for snarkjs 0.7.x (ships no types). Only the surface the
 * ZK proving worker uses is declared. `groth16.fullProve` accepts either a
 * URL/path string or an in-memory `{ type: 'mem', data }` artifact (used by the
 * AR-M6 integrity-verified path).
 */
declare module 'snarkjs' {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }

  export type PublicSignals = string[];

  export type ArtifactInput = string | { type: 'mem'; data: Uint8Array };

  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: ArtifactInput,
      zkey: ArtifactInput,
    ): Promise<{ proof: Groth16Proof; publicSignals: PublicSignals }>;
  };
}
