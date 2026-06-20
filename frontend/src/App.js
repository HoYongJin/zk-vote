/**
 * @file frontend/src/App.js
 * @desc Main router and global Firebase (GCIP) auth state handler.
 */
import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { setUser, setAdmin, clearUser, setRedirectComplete } from './store/authSlice';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import { store } from './store/store';
import axios from './api/axios';

// Page and Component Imports
import LoginPage from './pages/LoginPage';
import VoterMainPage from './pages/Voter/VoterMainPage';
import VotePage from './pages/Voter/VotePage';
import AdminMainPage from './pages/Admin/AdminMainPage';
import CreateVotePage from './pages/Admin/CreateVotePage';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';

// --- 인증 및 리디렉션 로직을 처리할 핸들러 컴포넌트 ---
function AuthHandler({ children }) {
  const dispatch = useDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    // 역할 조회는 백엔드의 /api/me가 단일 출처다 (AR-H4: Supabase 테이블
    // 직접 읽기를 제거해 Cloud SQL 마이그레이션 후에도 게이팅이 유지되고,
    // H5 초대 승격이 첫 인증 요청에서 즉시 반영된다).
    const fetchIsAdmin = async () => {
      try {
        const { data } = await axios.get('/me');
        return Boolean(data.is_admin);
      } catch (error) {
        console.error('Failed to resolve role from /api/me:', error.response?.data || error.message);
        return false; // fail-closed: 역할 확인 실패 시 관리자 아님으로 처리
      }
    };

    // 관리자인지 확인하고, 로그인 직후라면 적절한 페이지로 리디렉션하는 함수
    const checkAdminAndRedirect = async (user) => {
      const isAdminUser = await fetchIsAdmin();
      dispatch(setAdmin(isAdminUser));

      const { postLoginRedirectComplete } = store.getState().auth;
      if (!postLoginRedirectComplete) {
        if (isAdminUser) {
          navigate('/admin');
        } else {
          navigate('/');
        }
        dispatch(setRedirectComplete(true));
      }
    };

    // Firebase(GCIP) 인증 상태 리스너. onAuthStateChanged는 최초 로드 시 현재
    // 사용자(또는 null)로 한 번 발화하고 이후 로그인/로그아웃마다 발화하므로,
    // Supabase의 onAuthStateChange + getSession 두 경로를 하나로 대체한다
    // (새로고침 시 로그인 유지는 Firebase가 영속화한 세션을 첫 발화로 복원).
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        // Firebase에는 Supabase 같은 session 객체가 없다. ID 토큰은 요청 시점에
        // axios 인터셉터가 user.getIdToken()으로 즉석에서 가져온다.
        dispatch(setUser({ user, session: null }));
        checkAdminAndRedirect(user);
      } else {
        dispatch(clearUser());
        navigate('/login');
      }
    });

    return () => {
      unsubscribe();
    };
  }, [dispatch, navigate]);

  return children;
}

// --- 메인 App 컴포넌트 ---
function App() {
    return (
      <BrowserRouter>
        <AuthHandler>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
  
            {/* 유권자용 메인 페이지 */}
            <Route path="/" element={<ProtectedRoute><VoterMainPage /></ProtectedRoute>} /> 
  
            {/* 개별 투표 페이지 (공통) */}
            <Route path="/vote/:id" element={<ProtectedRoute><VotePage /></ProtectedRoute>} />
  
            {/* 관리자용 메인 페이지 (대시보드) */}
            <Route path="/admin" element={<AdminRoute><AdminMainPage /></AdminRoute>} />
  
            {/* 투표 생성 페이지 (별도) */}
            <Route path="/admin/create" element={<AdminRoute><CreateVotePage /></AdminRoute>} />
            
          </Routes>
        </AuthHandler>
      </BrowserRouter>
    );
  }

export default App;
