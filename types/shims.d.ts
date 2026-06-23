// Ambient module shims for ZK/crypto libraries that ship no TypeScript types.
// Minimal any-typed shapes — these libraries are used only by the repo-level
// migration/test tooling; the goal is type-checking the call sites, not the libs.

declare module "circomlibjs" {
  export function buildPoseidon(): Promise<any>;
  const _default: any;
  export default _default;
}

declare module "snarkjs" {
  export const groth16: any;
  const _default: any;
  export default _default;
}

declare module "circomlib" {
  const _default: any;
  export default _default;
}

declare module "fixed-merkle-tree" {
  export class MerkleTree {
    constructor(levels: number, leaves?: any[], options?: any);
    readonly root: any;
    path(index: number): any;
  }
  const _default: any;
  export default _default;
}

declare module "poseidon-lite" {
  export function poseidon1(inputs: any[]): bigint;
  export function poseidon2(inputs: any[]): bigint;
  const _default: any;
  export default _default;
}

// NOTE: test/poseidonCompat.test.ts deliberately imports the frontend's pinned
// copy by RELATIVE path (../frontend/node_modules/poseidon-lite) to assert it is
// bit-identical to circomlibjs (security invariant #7). That copy ships a
// non-module ambient .d.ts, and TypeScript does not match *relative* specifiers
// against `declare module` shims — so the import is annotated with a single
// @ts-ignore at the call site rather than typed here. The runtime target is
// unchanged; only static types for that one untyped import are loosened.
