import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { apiClient } from './client';
import {
  queryKeys,
  useAddAdminMutation,
  useAllowlistVotersMutation,
  useCompleteElectionMutation,
  useCreateElectionMutation,
  useFinalizeElectionMutation,
  useRegisterVoterMutation,
  useRevokeAdminMutation,
  useSetZkDeployMutation,
  useSubmitVoteMutation,
} from './queries';

vi.mock('./client', () => ({
  apiClient: {
    createElection: vi.fn(),
    addAdmin: vi.fn(),
    revokeAdmin: vi.fn(),
    allowlistVoters: vi.fn(),
    registerVoter: vi.fn(),
    setZkDeploy: vi.fn(),
    finalizeElection: vi.fn(),
    completeElection: vi.fn(),
    submitVote: vi.fn(),
  },
}));

function wrapperWith(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function queryClientWithInvalidateSpy() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.invalidateQueries = vi.fn().mockResolvedValue(undefined);
  return queryClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(apiClient)) {
    (fn as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, message: 'ok' });
  }
});

describe('React Query mutation invalidation', () => {
  it('invalidates election lists after election mutations', async () => {
    const cases = [
      {
        name: 'create',
        hook: useCreateElectionMutation,
        run: (mutation: ReturnType<typeof useCreateElectionMutation>) =>
          mutation.mutateAsync({
            name: 'Vote',
            merkleTreeDepth: 4,
            candidates: ['A'],
            regEndTime: '2027-01-01T00:00:00.000Z',
          }),
      },
      {
        name: 'allowlist',
        hook: useAllowlistVotersMutation,
        run: (mutation: ReturnType<typeof useAllowlistVotersMutation>) =>
          mutation.mutateAsync({ electionId: 'e1', emails: ['voter@example.com'] }),
      },
      {
        name: 'register',
        hook: useRegisterVoterMutation,
        run: (mutation: ReturnType<typeof useRegisterVoterMutation>) =>
          mutation.mutateAsync({ electionId: 'e1', input: { name: 'Voter', secretCommitment: '123' } }),
      },
      {
        name: 'deploy',
        hook: useSetZkDeployMutation,
        run: (mutation: ReturnType<typeof useSetZkDeployMutation>) => mutation.mutateAsync('e1'),
      },
      {
        name: 'finalize',
        hook: useFinalizeElectionMutation,
        run: (mutation: ReturnType<typeof useFinalizeElectionMutation>) =>
          mutation.mutateAsync({ electionId: 'e1', input: { voteEndTime: '2027-01-02T00:00:00.000Z' } }),
      },
      {
        name: 'complete',
        hook: useCompleteElectionMutation,
        run: (mutation: ReturnType<typeof useCompleteElectionMutation>) => mutation.mutateAsync('e1'),
      },
      {
        name: 'submit',
        hook: useSubmitVoteMutation,
        run: (mutation: ReturnType<typeof useSubmitVoteMutation>) =>
          mutation.mutateAsync({
            electionId: 'e1',
            input: { formattedProof: { a: [], b: [], c: [] }, publicSignals: [], submissionTicket: 'ticket' },
          }),
      },
    ];

    for (const testCase of cases) {
      const queryClient = queryClientWithInvalidateSpy();
      const { result, unmount } = renderHook(() => testCase.hook(), { wrapper: wrapperWith(queryClient) });
      await act(async () => {
        await testCase.run(result.current as never);
      });
      expect(queryClient.invalidateQueries, testCase.name).toHaveBeenCalledWith({ queryKey: queryKeys.elections.all });
      unmount();
    }
  });

  it('invalidates management queries after admin mutations', async () => {
    const queryClient = queryClientWithInvalidateSpy();
    const add = renderHook(() => useAddAdminMutation(), { wrapper: wrapperWith(queryClient) });
    await act(async () => {
      await add.result.current.mutateAsync('admin@example.com');
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.management.admins });
    add.unmount();

    vi.mocked(queryClient.invalidateQueries).mockClear();
    const revoke = renderHook(() => useRevokeAdminMutation(), { wrapper: wrapperWith(queryClient) });
    await act(async () => {
      await revoke.result.current.mutateAsync('admin-id');
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.management.admins });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.me });
    revoke.unmount();
  });
});
