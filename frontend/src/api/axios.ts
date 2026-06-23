// frontend/src/api/axios.ts
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { auth } from '../firebase';
import { getApiBaseUrl } from '../utils/apiBaseUrl';

// Augment axios config with our custom `skipAuth` flag (used by the anonymous
// /submit call, which must NOT carry a JWT — privacy invariant).
declare module 'axios' {
  interface AxiosRequestConfig {
    skipAuth?: boolean;
  }
}

const instance = axios.create({
  // baseURL points at the backend API (defaults to "/api"; see utils/apiBaseUrl).
  baseURL: getApiBaseUrl(),
  headers: {
    'Content-Type': 'application/json',
  },
});

// axios headers may be an AxiosHeaders instance (set/delete methods) or, in
// unit tests, a plain object. These helpers handle both.
type HeaderBag = {
  set?: (name: string, value: string) => void;
  delete?: (name: string) => void;
  [key: string]: unknown;
};

function removeHeader(headers: HeaderBag | undefined, name: string): void {
  if (!headers) return;
  if (typeof headers.delete === 'function') {
    headers.delete(name);
  }
  delete headers[name];
  delete headers[name.toLowerCase()];
}

function setHeader(headers: HeaderBag, name: string, value: string): void {
  if (typeof headers.set === 'function') {
    headers.set(name, value);
    return;
  }
  headers[name] = value;
}

// Attaches the Firebase (GCIP) ID token to every request, unless `skipAuth` is set.
instance.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    const headers = config.headers as unknown as HeaderBag;

    if (config.skipAuth) {
      delete config.skipAuth;
      removeHeader(headers, 'Authorization');
      return config;
    }

    // getIdToken() is async (unlike Supabase's sync access_token). Firebase
    // auto-refreshes an expired token.
    const user = auth.currentUser;
    if (user) {
      const token = await user.getIdToken();
      setHeader(headers, 'Authorization', `Bearer ${token}`);
    }
    return config;
  },
  (error: unknown) => Promise.reject(error),
);

export default instance;
