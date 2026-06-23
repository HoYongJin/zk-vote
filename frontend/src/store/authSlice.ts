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
  uid: string;
  email: string | null;
}

interface AuthState {
  user: AuthUser | null;
  /** Unused with Firebase (kept for shape compat); always null. */
  session: null;
  isLoggedIn: boolean;
  isAdmin: boolean;
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

    // Sets admin status AND clears `loading` (the auth check is now complete).
    setAdmin: (state, action: PayloadAction<boolean>) => {
      state.isAdmin = action.payload;
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
      state.loading = false;
      state.postLoginRedirectComplete = false;
    },
  },
});

export const { setUser, setAdmin, clearUser, setRedirectComplete } = authSlice.actions;
export default authSlice.reducer;
