import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminMainPage from './AdminMainPage';
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

function mockDashboardData() {
  const get = axios.get as ReturnType<typeof vi.fn>;
  get.mockImplementation((url: string) => {
    if (url === '/elections/registerable') return Promise.resolve({ data: [election] });
    if (url === '/elections/finalized') return Promise.resolve({ data: [] });
    if (url === '/elections/completed') return Promise.resolve({ data: [] });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderPage(isSuperAdmin: boolean) {
  (useAppSelector as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector) =>
    selector({ auth: { isSuperAdmin } }),
  );
  mockDashboardData();
  return render(
    <MemoryRouter>
      <AdminMainPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('alert', vi.fn());
});

describe('AdminMainPage — GOV-1 superadmin UI gate', () => {
  it('hides add-admin and disables ZK setup/deploy for ordinary admins', async () => {
    renderPage(false);

    await waitFor(() => expect(screen.getByText(/Gate Test Election/)).toBeInTheDocument());
    expect(screen.queryByText('관리자 추가')).not.toBeInTheDocument();
    expect(screen.getByText('ZK 설정 & 배포 (슈퍼관리자 전용)')).toBeDisabled();
  });

  it('shows add-admin and active ZK setup/deploy controls for superadmins', async () => {
    renderPage(true);

    await waitFor(() => expect(screen.getByText(/Gate Test Election/)).toBeInTheDocument());
    expect(screen.getByText('관리자 추가')).toBeInTheDocument();
    expect(screen.getByText('ZK 설정 & 배포')).toBeEnabled();
  });
});
