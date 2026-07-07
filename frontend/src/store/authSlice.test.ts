/**
 * @file frontend/src/store/authSlice.test.ts
 * @desc GOV-1: the superadmin tier must round-trip through the auth slice so the
 * UI can hide/disable the high-blast-radius controls (add-admin, ZK setup/deploy)
 * for ordinary admins. Locks the `isSuperAdmin` contract on setAdmin/clearUser.
 */
import { describe, it, expect } from 'vitest';
import reducer, { setAdmin, clearUser } from './authSlice';

const adminPayload = {
  isAdmin: true,
  isSuperAdmin: true,
  appUserId: '00000000-0000-0000-0000-000000000001',
  backendEmail: 'admin@example.com',
};

describe('authSlice — GOV-1 superadmin tier', () => {
  it('starts not-admin / not-superadmin and still loading', () => {
    const state = reducer(undefined, { type: '@@INIT' });
    expect(state.isAdmin).toBe(false);
    expect(state.isSuperAdmin).toBe(false);
    expect(state.loading).toBe(true);
  });

  it('setAdmin sets BOTH isAdmin and isSuperAdmin and clears loading', () => {
    const state = reducer(undefined, setAdmin(adminPayload));
    expect(state.isAdmin).toBe(true);
    expect(state.isSuperAdmin).toBe(true);
    expect(state.appUserId).toBe(adminPayload.appUserId);
    expect(state.backendEmail).toBe(adminPayload.backendEmail);
    expect(state.loading).toBe(false);
  });

  it('an ordinary admin is not a superadmin', () => {
    const state = reducer(undefined, setAdmin({ ...adminPayload, isSuperAdmin: false }));
    expect(state.isAdmin).toBe(true);
    expect(state.isSuperAdmin).toBe(false);
  });

  it('clearUser resets the superadmin flag', () => {
    const loggedIn = reducer(undefined, setAdmin(adminPayload));
    const cleared = reducer(loggedIn, clearUser());
    expect(cleared.isAdmin).toBe(false);
    expect(cleared.isSuperAdmin).toBe(false);
    expect(cleared.appUserId).toBeNull();
    expect(cleared.backendEmail).toBeNull();
    expect(cleared.isLoggedIn).toBe(false);
  });
});
