// frontend/src/store/store.js
import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer, // 'auth' 라는 이름으로 authSlice를 등록
  },
});