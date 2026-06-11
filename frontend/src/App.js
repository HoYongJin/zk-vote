/**
 * @file frontend/src/App.js
 * @desc Main router and global Supabase auth state handler.
 */
import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { setUser, setAdmin, clearUser, setRedirectComplete } from './store/authSlice';
import { supabase } from './supabase';
import { store } from './store/store';

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
    // 관리자인지 확인하고, 로그인 직후라면 적절한 페이지로 리디렉션하는 함수
    const checkAdminAndRedirect = async (user) => {
      const { data } = await supabase
        .from('Admins')
        .select('id')
        .eq('id', user.id);

      const isAdminUser = data && data.length > 0;
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

    // Supabase 인증 상태 변경 리스너
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'SIGNED_IN') {
          if (session) {
            dispatch(setUser({ user: session.user, session }));
            checkAdminAndRedirect(session.user);
          }
        } else if (event === 'SIGNED_OUT') {
          dispatch(clearUser());
          navigate('/login');
        }
      }
    );

    // 페이지 첫 로드 시 현재 세션 확인 (새로고침 시 로그인 유지)
    const checkInitialSession = async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            dispatch(setUser({ user: session.user, session }));
            
            const { data } = await supabase.from('Admins').select('id').eq('id', session.user.id);
            dispatch(setAdmin(data && data.length > 0));

        } else {
            dispatch(clearUser());
        }
    };
    checkInitialSession();

    return () => {
      authListener.subscription.unsubscribe();
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
