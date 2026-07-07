import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { apiClient } from './client';
import type { CreateElectionInput, FinalizeElectionInput, RegisterVoterInput, SubmitVoteInput } from './contracts';

export const queryKeys = {
  me: ['me'] as const,
  elections: {
    all: ['elections'] as const,
    registerable: ['elections', 'registerable'] as const,
    finalized: ['elections', 'finalized'] as const,
    completed: ['elections', 'completed'] as const,
  },
  management: {
    admins: ['management', 'admins'] as const,
  },
};

export function invalidateElectionLists(queryClient: QueryClient): Promise<unknown> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.elections.all });
}

export function useMeQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: apiClient.me,
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useRegisterableElectionsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.elections.registerable,
    queryFn: apiClient.registerableElections,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useFinalizedElectionsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.elections.finalized,
    queryFn: apiClient.finalizedElections,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCompletedElectionsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.elections.completed,
    queryFn: apiClient.completedElections,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useAdminListQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.management.admins,
    queryFn: apiClient.admins,
    enabled,
    staleTime: 15_000,
  });
}

export function useCreateElectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateElectionInput) => apiClient.createElection(input),
    onSuccess: () => invalidateElectionLists(queryClient),
  });
}

export function useAddAdminMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => apiClient.addAdmin(email),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.management.admins }),
  });
}

export function useRevokeAdminMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.revokeAdmin(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.management.admins });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useAllowlistVotersMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ electionId, emails }: { electionId: string; emails: string[] }) =>
      apiClient.allowlistVoters(electionId, emails),
    onSuccess: () => invalidateElectionLists(queryClient),
  });
}

export function useRegisterVoterMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ electionId, input }: { electionId: string; input: RegisterVoterInput }) =>
      apiClient.registerVoter(electionId, input),
    onSuccess: () => invalidateElectionLists(queryClient),
  });
}

export function useSetZkDeployMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (electionId: string) => apiClient.setZkDeploy(electionId),
    onSuccess: () => invalidateElectionLists(queryClient),
  });
}

export function useFinalizeElectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ electionId, input }: { electionId: string; input: FinalizeElectionInput }) =>
      apiClient.finalizeElection(electionId, input),
    onSuccess: () => invalidateElectionLists(queryClient),
  });
}

export function useCompleteElectionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (electionId: string) => apiClient.completeElection(electionId),
    onSuccess: () => invalidateElectionLists(queryClient),
  });
}

export function useSubmitVoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ electionId, input }: { electionId: string; input: SubmitVoteInput }) =>
      apiClient.submitVote(electionId, input),
    onSuccess: () => invalidateElectionLists(queryClient),
  });
}
