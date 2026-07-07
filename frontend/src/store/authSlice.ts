/**
 * @file frontend/src/store/authSlice.ts
 * @desc Redux Toolkit slice for global authentication state. Tracks the user,
 * admin status, and a global loading flag used by AdminRoute / ProtectedRoute.
 *
 * Only a serializable projection of the Firebase user ({ uid, email }) is kept
 * in the store — the live Firebase User object is non-serializable and is
 * frozen by Immer, so it must not be stored. The ID token is fetched per
 * request from `auth.currentUser` in the axios interceptor, not from here.
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface AuthUser {
  /** Firebase/GCIP provider UID, not the zk-vote internal app user id. */
  uid: string;
  email: string | null;
}

interface AuthState {
  user: AuthUser | null;
  /** Unused with Firebase (kept for shape compat); always null. */
  session: null;
  isLoggedIn: boolean;
  isAdmin: boolean;
  /** Internal `app_users.id` from /api/me. This is not Firebase uid/localId. */
  appUserId: string | null;
  /** Normalized backend e-mail from /api/me; may be null for unusable claims. */
  backendEmail: string | null;
  /**
   * GOV-1 second tier. True only for a non-revoked superadmin; gates the
   * high-blast-radius admin controls (add-admin, ZK setup/deploy) in the UI so
   * an ordinary admin is not shown buttons the backend would 403.
   */
  isSuperAdmin: boolean;
  /**
   * Starts true; becomes false only after BOTH session and admin status are
   * resolved. Prevents protected-route flicker.
   */
  loading: boolean;
  /** Set true after the first post-login redirect, to stop re-redirecting on token refresh. */
  postLoginRedirectComplete: boolean;
}

const initialState: AuthState = {
  user: null,
  session: null,
  isLoggedIn: false,
  isAdmin: false,
  appUserId: null,
  backendEmail: null,
  isSuperAdmin: false,
  loading: true,
  postLoginRedirectComplete: false,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    // Sets the user. Intentionally does NOT clear `loading` — setAdmin owns that,
    // so the UI waits for the admin check after the user is set.
    setUser: (state, action: PayloadAction<{ user: AuthUser; session: null }>) => {
      state.user = action.payload.user;
      state.session = action.payload.session;
      state.isLoggedIn = true;
    },

    // Sets admin + superadmin status AND clears `loading` (auth check complete).
    setAdmin: (
      state,
      action: PayloadAction<{
        isAdmin: boolean;
        isSuperAdmin: boolean;
        appUserId: string | null;
        backendEmail: string | null;
      }>,
    ) => {
      state.isAdmin = action.payload.isAdmin;
      state.isSuperAdmin = action.payload.isSuperAdmin;
      state.appUserId = action.payload.appUserId;
      state.backendEmail = action.payload.backendEmail;
      state.loading = false;
    },

    setRedirectComplete: (state, action: PayloadAction<boolean>) => {
      state.postLoginRedirectComplete = action.payload;
    },

    // Clears all auth state. Also clears `loading` (auth check complete: no user).
    clearUser: (state) => {
      state.user = null;
      state.session = null;
      state.isLoggedIn = false;
      state.isAdmin = false;
      state.appUserId = null;
      state.backendEmail = null;
      state.isSuperAdmin = false;
      state.loading = false;
      state.postLoginRedirectComplete = false;
    },
  },
});

export const { setUser, setAdmin, clearUser, setRedirectComplete } = authSlice.actions;
export default authSlice.reducer;
