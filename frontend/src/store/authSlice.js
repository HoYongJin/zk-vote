// frontend/src/store/authSlice.js
import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  user: null,
  session: null,
  isLoggedIn: false,
  isAdmin: false, // 👈 관리자 여부 상태 추가
  loading: true, // 👈 로딩 상태 추가
  postLoginRedirectComplete: false,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setUser: (state, action) => {
      state.user = action.payload.user;
      state.session = action.payload.session;
      state.isLoggedIn = true;
      //state.loading = false; // 👈 유저 정보 로딩 완료
    },
    // 👇 관리자 상태를 설정하는 액션 추가
    setAdmin: (state, action) => {
      state.isAdmin = action.payload;
      state.loading = false;
    },
    setRedirectComplete: (state, action) => {
        state.postLoginRedirectComplete = action.payload;
      },
    clearUser: (state) => {
      state.user = null;
      state.session = null;
      state.isLoggedIn = false;
      state.isAdmin = false; // 👈 로그아웃 시 초기화
      state.loading = false; // 👈 로딩 완료
      state.postLoginRedirectComplete = false;
    },
  },
});

export const { setUser, setAdmin, clearUser, setRedirectComplete } = authSlice.actions; // 👈 setAdmin 추가
export default authSlice.reducer;