// frontend/src/App.js
import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { setUser, setAdmin, clearUser } from './store/authSlice';
import { supabase } from './supabase';

// Page and Component Imports
import MainPage from './pages/MainPage';
import LoginPage from './pages/LoginPage';
import VotePage from './pages/VotePage';
import AdminDashboardPage from './pages/Admin/AdminDashboardPage';
import CreateVotePage from './pages/Admin/CreateVotePage';
import ManageVotesPage from './pages/Admin/ManageVotesPage';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';

// --- LoginRedirector (기존과 동일) ---
function LoginRedirector() {
  const navigate = useNavigate();
  const { isLoggedIn, loading } = useSelector(state => state.auth);
  useEffect(() => {
    // 로딩이 끝나고 로그인된 상태라면 메인으로 보냄
    if (!loading && isLoggedIn) {
      navigate('/');
    }
  }, [isLoggedIn, loading, navigate]);
  return <LoginPage />;
}

// --- 메인 App 컴포넌트 ---
function App() {
  const dispatch = useDispatch();

  useEffect(() => {
    // 관리자 상태를 확인하고, 최종적으로 로딩 상태를 false로 변경하는 함수
    const checkAdminAndFinalize = async (user) => {
      if (!user) {
        // 유저가 없으면 일반 사용자로 확정하고 로딩 종료
        dispatch(setAdmin(false));
        return;
      }
      try {
        const { data, error } = await supabase
          .from('Admins')
          .select('role')
          .eq('id', user.id);
        
        if (data && data.length > 0 && data[0].role === 'admin' && !error) {
          dispatch(setAdmin(true));
        } else {
          dispatch(setAdmin(false));
        }
      } catch (error) {
        console.error("Admin check error:", error);
        dispatch(setAdmin(false)); // 에러 발생 시에도 로딩은 끝내야 함
      }
    };

    // Supabase의 인증 상태 변경을 감지하는 단일 리스너
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (session) {
          // 세션이 있으면, 유저 정보를 먼저 설정
          dispatch(setUser({ user: session.user, session }));
          // 그 다음 관리자인지 확인 (이 함수 안에서 loading=false 처리)
          checkAdminAndFinalize(session.user);
        } else {
          // 세션이 없으면, 유저 정보를 초기화 (clearUser 안에서 loading=false 처리)
          dispatch(clearUser());
        }
      }
    );

    // 컴포넌트가 사라질 때 리스너를 정리합니다.
    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [dispatch]);


  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginRedirector />} />
        <Route path="/" element={<ProtectedRoute><MainPage /></ProtectedRoute>} />
        <Route path="/vote/:id" element={<ProtectedRoute><VotePage /></ProtectedRoute>} />
        <Route path="/admin" element={<AdminRoute><AdminDashboardPage /></AdminRoute>} />
        <Route path="/admin/create" element={<AdminRoute><CreateVotePage /></AdminRoute>} />
        <Route path="/admin/manage" element={<AdminRoute><ManageVotesPage /></AdminRoute>} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;