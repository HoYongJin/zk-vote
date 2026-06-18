import api from './axios';
import { supabase } from '../supabase';

jest.mock('../supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
  },
}));

function requestInterceptor() {
  return api.interceptors.request.handlers[0].fulfilled;
}

describe('API axios auth interceptor', () => {
  beforeEach(() => {
    supabase.auth.getSession.mockReset();
  });

  test('attaches the Supabase JWT by default', async () => {
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt-token' } },
    });

    const config = await requestInterceptor()({ headers: {} });

    expect(config.headers.Authorization).toBe('Bearer jwt-token');
  });

  test('skips Supabase JWT lookup for anonymous submit requests', async () => {
    const config = await requestInterceptor()({
      headers: { Authorization: 'Bearer stale-token', authorization: 'Bearer stale-lower-token' },
      skipAuth: true,
    });

    expect(supabase.auth.getSession).not.toHaveBeenCalled();
    expect(config.headers.Authorization).toBeUndefined();
    expect(config.headers.authorization).toBeUndefined();
    expect(config.skipAuth).toBeUndefined();
  });
});
