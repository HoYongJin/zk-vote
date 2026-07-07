/**
 * @file frontend/src/types/domain.ts
 * @desc Backward-compatible exports for older tests/imports. New code should
 * import endpoint-specific shapes from `../api/contracts`.
 */
export type {
  ArtifactInfo,
  ElectionView as Election,
  FinalizedElectionView,
  FormattedProof,
  ProofResponse,
  RegisterableElectionView,
} from '../api/contracts';
