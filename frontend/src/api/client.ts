import axios from './axios';
import type {
  AddAdminResponse,
  AdminListEntry,
  AllowlistResponse,
  ArtifactInfo,
  CompleteElectionResponse,
  CompletedElection,
  CompletedElectionView,
  CreateElectionInput,
  CreateElectionResponse,
  FinalizeElectionInput,
  FinalizeElectionResponse,
  FinalizedElection,
  FinalizedElectionView,
  MeResponse,
  ProofResponse,
  RegisterVoterInput,
  RegisterVoterResponse,
  RegisterableElection,
  RegisterableElectionView,
  RevokeAdminResponse,
  SetZkDeployResponse,
  SubmitVoteInput,
  SubmitVoteResponse,
} from './contracts';
import {
  normalizeCompletedElection,
  normalizeFinalizedElection,
  normalizeRegisterableElection,
} from './contracts';

export const apiClient = {
  async me(): Promise<MeResponse> {
    const { data } = await axios.get<MeResponse>('/me');
    return data;
  },

  async registerableElections(): Promise<RegisterableElectionView[]> {
    const { data } = await axios.get<RegisterableElection[]>('/elections/registerable');
    return Array.isArray(data) ? data.map(normalizeRegisterableElection) : [];
  },

  async finalizedElections(): Promise<FinalizedElectionView[]> {
    const { data } = await axios.get<FinalizedElection[]>('/elections/finalized');
    return Array.isArray(data) ? data.map(normalizeFinalizedElection) : [];
  },

  async completedElections(): Promise<CompletedElectionView[]> {
    const { data } = await axios.get<CompletedElection[]>('/elections/completed');
    return Array.isArray(data) ? data.map(normalizeCompletedElection) : [];
  },

  async createElection(input: CreateElectionInput): Promise<CreateElectionResponse> {
    const { data } = await axios.post<CreateElectionResponse>('/elections/set', input);
    return data;
  },

  async addAdmin(email: string): Promise<AddAdminResponse> {
    const { data } = await axios.post<AddAdminResponse>('/management/addAdmins', { email });
    return data;
  },

  async admins(): Promise<AdminListEntry[]> {
    const { data } = await axios.get<AdminListEntry[]>('/management/admins');
    return Array.isArray(data) ? data : [];
  },

  async revokeAdmin(id: string): Promise<RevokeAdminResponse> {
    const { data } = await axios.post<RevokeAdminResponse>(`/management/admins/${id}/revoke`);
    return data;
  },

  async allowlistVoters(electionId: string, emails: string[]): Promise<AllowlistResponse> {
    const { data } = await axios.post<AllowlistResponse>(`/elections/${electionId}/voters`, { emails });
    return data;
  },

  async registerVoter(electionId: string, input: RegisterVoterInput): Promise<RegisterVoterResponse> {
    const { data } = await axios.post<RegisterVoterResponse>(`/elections/${electionId}/register`, input);
    return data;
  },

  async setZkDeploy(electionId: string): Promise<SetZkDeployResponse> {
    const { data } = await axios.post<SetZkDeployResponse>(`/elections/${electionId}/setZkDeploy`);
    return data;
  },

  async finalizeElection(electionId: string, input: FinalizeElectionInput): Promise<FinalizeElectionResponse> {
    const { data } = await axios.post<FinalizeElectionResponse>(`/elections/${electionId}/finalize`, input);
    return data;
  },

  async completeElection(electionId: string): Promise<CompleteElectionResponse> {
    const { data } = await axios.post<CompleteElectionResponse>(`/elections/${electionId}/complete`);
    return data;
  },

  async proof(electionId: string): Promise<ProofResponse> {
    const { data } = await axios.post<ProofResponse>(`/elections/${electionId}/proof`);
    return data;
  },

  async artifactInfo(electionId: string): Promise<ArtifactInfo> {
    const { data } = await axios.get<ArtifactInfo>(`/elections/${electionId}/artifact-info`);
    return data;
  },

  async submitVote(electionId: string, input: SubmitVoteInput): Promise<SubmitVoteResponse> {
    const { data } = await axios.post<SubmitVoteResponse>(`/elections/${electionId}/submit`, input, {
      skipAuth: true,
    });
    return data;
  },
};
