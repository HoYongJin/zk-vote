/**
 * @file frontend/src/store/store.ts
 * @desc Configures the Redux Toolkit store. Only the auth slice is registered.
 */
import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
