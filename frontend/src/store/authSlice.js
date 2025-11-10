/**
 * @file frontend/src/store/authSlice.js
 * @desc Redux Toolkit Slice for managing global authentication state.
 * This slice tracks the user session, admin status, and global loading state
 * crucial for route protection (AdminRoute, ProtectedRoute).
 */

import { createSlice } from '@reduxjs/toolkit';

/**
 * The initial state for the authentication slice.
 */
const initialState = {
  user: null,         // Supabase user object
  session: null,      // Supabase session object (contains JWT)
  isLoggedIn: false,  // True if user session is active
  isAdmin: false,     // True if the logged-in user is also in the 'Admins' table
  
  /**
   * [UX] Global loading state for authentication.
   * Starts `true` on app load.
   * Becomes `false` *only after* both session status AND admin status
   * have been checked. This prevents UI flicker in protected routes.
   */
  loading: true,
  
  /**
   * Flag to prevent re-redirecting after the initial login.
   * `AuthHandler` sets this to true after the first successful redirect
   * (to / or /admin) to stop redirects on token refreshes.
   */
  postLoginRedirectComplete: false,
};

const authSlice = createSlice({
  name: 'auth',       // Name of the slice
  initialState,     // Initial state defined above
  reducers: {
    
    /**
     * Sets the user and session.
     * Called by AuthHandler when a session is found (on load or login).
     * [IMPORTANT] This intentionally *does not* set loading: false.
     * The `setAdmin` reducer is responsible for that, ensuring we
     * wait for the admin check *after* the user is set.
     */
    setUser: (state, action) => {
      state.user = action.payload.user;
      state.session = action.payload.session;
      state.isLoggedIn = true;
      // state.loading = false; // This is intentionally left to setAdmin
    },

    /**
     * Sets the user's admin status.
     * Called by AuthHandler *after* setUser and after checking the 'Admins' table.
     * This action is the one that sets `loading: false`, unblocking the UI.
     */
    setAdmin: (state, action) => {
      state.isAdmin = action.payload;
      state.loading = false; // Auth check (user + admin) is now complete
    },

    /**
     * Sets the flag indicating the initial post-login redirect has occurred.
     */
    setRedirectComplete: (state, action) => {
        state.postLoginRedirectComplete = action.payload;
    },

    /**
     * Clears all auth state.
     * Called by AuthHandler on logout or if no session is found on app load.
     * This also sets `loading: false`, unblocking the UI.
     */
    clearUser: (state) => {
      state.user = null;
      state.session = null;
      state.isLoggedIn = false;
      state.isAdmin = false; // Reset admin status on logout
      state.loading = false; // Auth check is complete (no user)
      state.postLoginRedirectComplete = false; // Reset redirect flag
    },
  },
});

// Export the action creators
export const { setUser, setAdmin, clearUser, setRedirectComplete } = authSlice.actions;

// Export the reducer as the default export
export default authSlice.reducer;