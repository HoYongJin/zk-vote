import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AdminMainPage from './AdminMainPage';
import type { AdminListEntry } from '../../api/contracts';
import type { Election } from '../../types/domain';

vi.mock('../../api/axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../firebase', () => ({ auth: {} }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn() }));
vi.mock('../../store/hooks', () => ({ useAppSelector: vi.fn() }));

import axios from '../../api/axios';
import { useAppSelector } from '../../store/hooks';

const election = {
  id: '00000000-0000-0000-0000-000000000123',
  name: 'Gate Test Election',
  candidates: ['A', 'B'],
  contract_address: null,
  registration_end_time: '2027-01-01T00:00:00.000Z',
} as unknown as Election;

const superAdminId = '00000000-0000-0000-0000-000000000001';
const ordinaryAdminId = '00000000-0000-0000-0000-000000000002';
const revokedAdminId = '00000000-0000-0000-0000-000000000003';

function mockDashboardData(admins: AdminListEntry[] = []) {
  const get = axios.get as ReturnType<typeof vi.fn>;
  get.mockImplementation((url: string) => {
    if (url === '/elections/registerable') return Promise.resolve({ data: [election] });
    if (url === '/elections/finalized') return Promise.resolve({ data: [] });
    if (url === '/elections/completed') return Promise.resolve({ data: [] });
    if (url === '/management/admins') return Promise.resolve({ data: admins });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderPage(isSuperAdmin: boolean, admins: AdminListEntry[] = []) {
  (useAppSelector as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
    selector({ auth: { isSuperAdmin, appUserId: superAdminId, backendEmail: 'root@example.com' } }),
  );
  mockDashboardData(admins);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AdminMainPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (axios.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { success: true, message: 'ok' } });
});

describe('AdminMainPage — GOV-1 superadmin UI gate', () => {
  it('hides add-admin and disables ZK setup/deploy for ordinary admins', async () => {
    renderPage(false);

    await waitFor(() => expect(screen.getByText(/Gate Test Election/)).toBeInTheDocument());
    expect(screen.queryByText('관리자 추가')).not.toBeInTheDocument();
    expect(screen.getByText('ZK 설정 & 배포').closest('button')).toBeDisabled();
    expect(screen.getByText('등록 마감').closest('button')).toBeDisabled();
  });

  it('shows add-admin and active ZK setup/deploy controls for superadmins', async () => {
    renderPage(true);

    await waitFor(() => expect(screen.getByText(/Gate Test Election/)).toBeInTheDocument());
    expect(screen.getAllByText('관리자 추가').length).toBeGreaterThan(0);
    expect(screen.getByText('ZK 설정 & 배포').closest('button')).toBeEnabled();
  });

  it('lists active/revoked admins and revokes an ordinary admin through the superadmin UI', async () => {
    renderPage(true, [
      { id: superAdminId, email: 'root@example.com', is_superadmin: true, revoked_at: null, invited_by: null },
      { id: ordinaryAdminId, email: 'admin@example.com', is_superadmin: false, revoked_at: null, invited_by: superAdminId },
      { id: revokedAdminId, email: 'old@example.com', is_superadmin: false, revoked_at: '2026-01-01T00:00:00Z', invited_by: superAdminId },
    ]);

    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeInTheDocument());
    expect(screen.getByText('old@example.com')).toBeInTheDocument();

    const revokeButtons = screen.getAllByRole('button', { name: '권한 해제' });
    const enabledRevoke = revokeButtons.find((button) => !button.hasAttribute('disabled'));
    expect(enabledRevoke).toBeDefined();
    fireEvent.click(enabledRevoke as HTMLButtonElement);
    fireEvent.click(screen.getByRole('button', { name: '확인' }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(`/management/admins/${ordinaryAdminId}/revoke`));
  });
});
