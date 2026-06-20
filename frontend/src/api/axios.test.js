import api from './axios';
import { auth } from '../firebase';

jest.mock('../firebase', () => ({
  auth: {
    currentUser: null,
  },
}));

function requestInterceptor() {
  return api.interceptors.request.handlers[0].fulfilled;
}

describe('API axios auth interceptor', () => {
  beforeEach(() => {
    auth.currentUser = null;
  });

  test('attaches the Firebase ID token by default', async () => {
    auth.currentUser = { getIdToken: jest.fn().mockResolvedValue('jwt-token') };

    const config = await requestInterceptor()({ headers: {} });

    expect(auth.currentUser.getIdToken).toHaveBeenCalled();
    expect(config.headers.Authorization).toBe('Bearer jwt-token');
  });

  test('skips the Firebase token lookup for anonymous submit requests', async () => {
    auth.currentUser = { getIdToken: jest.fn() };

    const config = await requestInterceptor()({
      headers: { Authorization: 'Bearer stale-token', authorization: 'Bearer stale-lower-token' },
      skipAuth: true,
    });

    expect(auth.currentUser.getIdToken).not.toHaveBeenCalled();
    expect(config.headers.Authorization).toBeUndefined();
    expect(config.headers.authorization).toBeUndefined();
    expect(config.skipAuth).toBeUndefined();
  });

  test('sends no Authorization header when no user is signed in', async () => {
    auth.currentUser = null;

    const config = await requestInterceptor()({ headers: {} });

    expect(config.headers.Authorization).toBeUndefined();
  });
});
