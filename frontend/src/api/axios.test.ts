import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';
import api from './axios';
import { auth } from '../firebase';

vi.mock('../firebase', () => ({
  auth: { currentUser: null },
}));

type MockAuth = { currentUser: { getIdToken: ReturnType<typeof vi.fn> } | null };
const mockAuth = auth as unknown as MockAuth;

type Interceptor = (config: InternalAxiosRequestConfig) => Promise<InternalAxiosRequestConfig>;

function requestInterceptor(): Interceptor {
  const { handlers } = api.interceptors.request as unknown as {
    handlers: Array<{ fulfilled: Interceptor }>;
  };
  return handlers[0].fulfilled;
}

function asConfig(value: object): InternalAxiosRequestConfig {
  return value as unknown as InternalAxiosRequestConfig;
}

describe('API axios auth interceptor', () => {
  beforeEach(() => {
    mockAuth.currentUser = null;
  });

  test('attaches the Firebase ID token by default', async () => {
    const user = { getIdToken: vi.fn().mockResolvedValue('jwt-token') };
    mockAuth.currentUser = user;

    const config = await requestInterceptor()(asConfig({ headers: {} }));

    expect(user.getIdToken).toHaveBeenCalled();
    expect((config.headers as Record<string, unknown>).Authorization).toBe('Bearer jwt-token');
  });

  test('skips the Firebase token lookup for anonymous submit requests', async () => {
    const user = { getIdToken: vi.fn() };
    mockAuth.currentUser = user;

    const config = await requestInterceptor()(
      asConfig({
        headers: { Authorization: 'Bearer stale-token', authorization: 'Bearer stale-lower-token' },
        skipAuth: true,
      }),
    );

    expect(user.getIdToken).not.toHaveBeenCalled();
    const headers = config.headers as Record<string, unknown>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect((config as { skipAuth?: boolean }).skipAuth).toBeUndefined();
  });

  test('sends no Authorization header when no user is signed in', async () => {
    mockAuth.currentUser = null;

    const config = await requestInterceptor()(asConfig({ headers: {} }));

    expect((config.headers as Record<string, unknown>).Authorization).toBeUndefined();
  });
});
