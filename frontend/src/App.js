// frontend/src/App.js
import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { setUser, clearUser } from './store/authSlice';
import { supabase } from './supabase';

import MainPage from './pages/MainPage';
import LoginPage from './pages/LoginPage';
import AdminPage from './pages/AdminPage';
import VotePage from './pages/VotePage';

function App() {
  const dispatch = useDispatch();

  // 앱이 처음 시작될 때 단 한 번만 실행됩니다.
  useEffect(() => {
    // Supabase의 로그인 상태 변경을 감지하는 리스너 설정
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          // 사용자가 로그인했을 때 Redux 스토어에 정보 저장
          dispatch(setUser({ user: session.user, session }));
        } else if (event === 'SIGNED_OUT') {
          // 사용자가 로그아웃했을 때 Redux 스토어 정보 삭제
          dispatch(clearUser());
        }
      }
    );

    // 컴포넌트가 사라질 때 리스너를 정리(clean-up)합니다.
    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [dispatch]);

  return (
    <BrowserRouter>
      {/* ... 기존 라우팅 코드 ... */}
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/vote/:id" element={<VotePage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;