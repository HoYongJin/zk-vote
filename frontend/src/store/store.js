/**
 * @file frontend/src/store/store.js
 * @desc Configures and creates the main Redux store for the application.
 * This file uses Redux Toolkit's `configureStore` to combine all reducers
 * (in this case, only the authReducer) into a single store instance.
 */

import { configureStore } from '@reduxjs/toolkit';
// Import the reducer logic from the authSlice file
import authReducer from './authSlice';

/**
 * The main Redux store instance for the entire application.
 * * `configureStore` is a wrapper around the Redux `createStore` function
 * that simplifies setup. It automatically:
 * 1. Combines the reducers provided in the `reducer` object.
 * 2. Adds the `redux-thunk` middleware (for async logic).
 * 3. Enables the Redux DevTools Extension for easier debugging.
 */
export const store = configureStore({
  /**
   * `reducer` is an object where each key defines a "slice" of the Redux state.
   * The key's name is what will be used to access this state via `useSelector`.
   */
  reducer: {
    // All state related to authentication (user, isLoggedIn, isAdmin, loading)
    // will be managed by `authReducer` and accessible via `state.auth`
    auth: authReducer, 
  },
  // No additional middleware or options are needed for this project's current scope.
});