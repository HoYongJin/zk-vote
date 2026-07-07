export interface ApiErrorBody {
  error: string;
  details: string;
}

export interface MeResponse {
  id: string;
  email: string | null;
  is_admin: boolean;
  is_superadmin: boolean;
}

interface RawElectionRow {
  id: string;
  name: string;
  candidates: unknown;
  contract_address?: string | null;
}

export interface RegisterableElection extends RawElectionRow {
  registration_end_time: string;
  isRegistered?: boolean;
}

export interface FinalizedElection extends RawElectionRow {
  voting_end_time: string | null;
  merkle_tree_depth: number;
  num_candidates: number;
  total_voters?: number;
  registered_voters?: number;
}

export interface CompletedElection extends RawElectionRow {
  voting_end_time: string | null;
}

export interface ElectionBase {
  id: string;
  name: string;
  candidates: string[];
  contract_address: string | null;
}

export interface RegisterableElectionView extends ElectionBase {
  phase: 'registerable';
  registration_end_time: string;
  isRegistered?: boolean;
}

export interface FinalizedElectionView extends ElectionBase {
  phase: 'finalized';
  voting_end_time: string | null;
  merkle_tree_depth: number;
  num_candidates: number;
  total_voters?: number;
  registered_voters?: number;
}

export interface CompletedElectionView extends ElectionBase {
  phase: 'completed';
  voting_end_time: string | null;
}

export type ElectionView = RegisterableElectionView | FinalizedElectionView | CompletedElectionView;

export interface CreateElectionInput {
  name: string;
  merkleTreeDepth: number;
  candidates: string[];
  regEndTime: string;
}

export interface CreateElectionResponse {
  success: boolean;
  message: string;
  election: {
    id: string;
    name: string;
    state: string;
    merkle_tree_depth: number;
    num_candidates: number;
    candidates: unknown;
    registration_start_time: string;
    registration_end_time: string;
    contract_address: string | null;
    completed: boolean;
  };
}

export interface AddAdminResponse {
  success: boolean;
  message: string;
  promotedExistingUser: boolean;
}

export interface AdminListEntry {
  id: string;
  email: string | null;
  is_superadmin: boolean;
  revoked_at: string | null;
  invited_by: string | null;
}

export interface RevokeAdminResponse {
  success: boolean;
  message: string;
}

export interface AllowlistResponse {
  success: boolean;
  message: string;
  summary: {
    newly_registered_count: number;
    duplicates_skipped_count: number;
    invalid_format_skipped_count: number;
  };
}

export interface RegisterVoterInput {
  name: string;
  secretCommitment: string;
}

export interface RegisterVoterResponse {
  success: boolean;
  message: string;
}

export interface FinalizeElectionInput {
  voteEndTime: string;
  confirmExtendedDuration?: boolean;
}

export interface FinalizeElectionResponse {
  success: boolean;
  message: string;
  merkleRoot: string;
}

export interface SetZkDeployResponse {
  success: boolean;
  message: string;
  contractAddress: string;
  verifierAddress: string;
  deployTxHash: string;
  artifactId: string;
}

export interface CompleteElectionResponse {
  success: boolean;
  message: string;
}

export interface ProofResponse {
  success: boolean;
  message: string;
  root: string;
  pathElements: string[];
  pathIndices: Array<number | string>;
  submissionTicket: string;
}

export interface ArtifactInfo {
  success: boolean;
  wasmPath: string;
  wasmSha256: string;
  zkeyPath: string;
  zkeySha256: string;
  verificationKeySha256: string;
  publicSignalCount: number;
  numOptions: number;
}

export interface FormattedProof {
  a: string[];
  b: string[][];
  c: string[];
}

export interface SubmitVoteInput {
  formattedProof: FormattedProof;
  publicSignals: string[];
  submissionTicket: string;
}

export interface SubmitVoteResponse {
  success: boolean;
  message: string;
  transactionHash?: string;
}

function normalizeCandidates(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((candidate) => typeof candidate !== 'string')) {
    throw new Error(`${context}: backend returned malformed candidates`);
  }
  return value;
}

function normalizeBase<T extends RawElectionRow>(row: T, context: string): ElectionBase {
  if (!row.id || !row.name) {
    throw new Error(`${context}: backend returned malformed election identity`);
  }
  return {
    id: row.id,
    name: row.name,
    candidates: normalizeCandidates(row.candidates, context),
    contract_address: row.contract_address ?? null,
  };
}

export function normalizeRegisterableElection(row: RegisterableElection): RegisterableElectionView {
  if (!row.registration_end_time) {
    throw new Error('registerable election: missing registration_end_time');
  }
  return {
    ...normalizeBase(row, 'registerable election'),
    phase: 'registerable',
    registration_end_time: row.registration_end_time,
    isRegistered: row.isRegistered,
  };
}

export function normalizeFinalizedElection(row: FinalizedElection): FinalizedElectionView {
  if (!Number.isFinite(row.merkle_tree_depth) || !Number.isFinite(row.num_candidates)) {
    throw new Error('finalized election: missing circuit metadata');
  }
  return {
    ...normalizeBase(row, 'finalized election'),
    phase: 'finalized',
    voting_end_time: row.voting_end_time ?? null,
    merkle_tree_depth: row.merkle_tree_depth,
    num_candidates: row.num_candidates,
    total_voters: row.total_voters,
    registered_voters: row.registered_voters,
  };
}

export function normalizeCompletedElection(row: CompletedElection): CompletedElectionView {
  return {
    ...normalizeBase(row, 'completed election'),
    phase: 'completed',
    voting_end_time: row.voting_end_time ?? null,
  };
}
