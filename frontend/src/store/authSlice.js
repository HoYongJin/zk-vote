// frontend/src/store/authSlice.js
import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  user: null, // 사용자 정보를 담을 곳
  session: null, // 세션 정보를 담을 곳
  isLoggedIn: false, // 로그인 여부
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    // 로그인 성공 시 사용자 정보를 저장하는 액션
    setUser: (state, action) => {
      state.user = action.payload.user;
      state.session = action.payload.session;
      state.isLoggedIn = true;
    },
    // 로그아웃 시 사용자 정보를 초기화하는 액션
    clearUser: (state) => {
      state.user = null;
      state.session = null;
      state.isLoggedIn = false;
    },
  },
});

export const { setUser, clearUser } = authSlice.actions;
export default authSlice.reducer;