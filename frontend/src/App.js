// frontend/src/App.js
import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { setUser, setAdmin, clearUser } from './store/authSlice';
import { supabase } from './supabase';
import AdminRoute from './components/AdminRoute';

import MainPage from './pages/MainPage';
import LoginPage from './pages/LoginPage';
import AdminPage from './pages/AdminPage';
import VotePage from './pages/VotePage';

function App() {
  const dispatch = useDispatch();

  // 앱이 처음 시작될 때 단 한 번만 실행됩니다.
  useEffect(() => {
    // --- 관리자 상태 확인 함수 ---
    const checkAdminStatus = async (user) => {
      if (!user) {
        // 유저 정보가 없으면 일반 사용자로 확정하고 로딩 종료
        dispatch(setAdmin(false));
        return;
      }

      try {
        const { data: adminData, error } = await supabase
          .from('Admins')
          .select('role, id')
          .eq('id', user.id)
          .single();

        console.log(user)
        console.log(adminData);

        if (adminData && adminData.role === 'admin' && !error) {
          dispatch(setAdmin(true));
          console.log("true");
        } else {
          dispatch(setAdmin(false));
        }
      } catch (error) {
        // DB 조회 중 에러 발생 시에도 일단 일반 사용자로 처리하고 로딩 종료
        console.error("Admin check error:", error);
        dispatch(setAdmin(false));
      }
    };

    // --- 인증 상태 변경 리스너 ---
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (session) { // SIGNED_IN, TOKEN_REFRESHED 등 모든 세션 유효 상태
          dispatch(setUser({ user: session.user, session }));
          checkAdminStatus(session.user);
        } else { // SIGNED_OUT, USER_DELETED 등
          dispatch(clearUser());
        }
      }
    );
    
    // --- 새로고침 시 현재 유저 확인 ---
    const checkCurrentUser = async () => {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            dispatch(setUser({ user: session.user, session }));
            await checkAdminStatus(session.user);
        } else {
            // 세션이 없으면 로딩을 끝내야 함
            dispatch(clearUser());
        }
    }
    checkCurrentUser();


    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [dispatch]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MainPage />} />
        <Route path="/login" element={<LoginPage />} />
        
        {/* '/admin' 경로를 AdminRoute로 감싸줍니다. */}
        <Route
          path="/admin"
          element={
            <AdminRoute>
              <AdminPage />
            </AdminRoute>
          }
        />

        <Route path="/vote/:id" element={<VotePage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;