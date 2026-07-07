import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CreateVotePage from './CreateVotePage';
import { apiClient } from '../../api/client';

vi.mock('../../api/client', () => ({
  apiClient: {
    createElection: vi.fn(),
  },
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CreateVotePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CreateVotePage — backend election contract', () => {
  it('only exposes deployable depth buckets and allows up to 10 candidates', () => {
    renderPage();

    for (const depth of [4, 6, 8, 10]) {
      expect(screen.getByRole('radio', { name: `Depth ${depth}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole('radio', { name: 'Depth 5' })).not.toBeInTheDocument();

    const addButton = screen.getByRole('button', { name: '후보자 추가' });
    for (let i = 0; i < 8; i += 1) {
      fireEvent.click(addButton);
    }

    expect(screen.getAllByRole('textbox', { name: /후보 \d+$/ })).toHaveLength(10);
    expect(addButton).toBeDisabled();
  });

  it('submits the selected depth bucket and normalized candidate list', async () => {
    (apiClient.createElection as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      message: 'created',
      election: {},
    });
    renderPage();

    fireEvent.change(screen.getByLabelText('투표 이름'), { target: { value: 'Contract Aligned Vote' } });
    fireEvent.change(screen.getByLabelText('유권자 등록 마감 시간'), { target: { value: '2027-01-01T09:00' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Depth 8' }));
    fireEvent.change(screen.getByLabelText('후보 1'), { target: { value: ' Alice ' } });
    fireEvent.change(screen.getByLabelText('후보 2'), { target: { value: 'Bob' } });

    fireEvent.click(screen.getByRole('button', { name: '투표 생성하기' }));

    await waitFor(() => expect(apiClient.createElection).toHaveBeenCalledTimes(1));
    expect(apiClient.createElection).toHaveBeenCalledWith({
      name: 'Contract Aligned Vote',
      merkleTreeDepth: 8,
      candidates: ['Alice', 'Bob'],
      regEndTime: new Date('2027-01-01T09:00').toISOString(),
    });
  });
});
