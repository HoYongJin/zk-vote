/**
 * @file frontend/src/App.tsx
 * @desc Main router and global Firebase (GCIP) auth state handler.
 */
import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { setUser, setAdmin, clearUser, setRedirectComplete } from './store/authSlice';
import { useAppDispatch } from './store/hooks';
import { auth } from './firebase';
import { store } from './store/store';
import axios from './api/axios';
import { errorData } from './utils/errors';

// Page and Component Imports
import LoginPage from './pages/LoginPage';
import VoterMainPage from './pages/Voter/VoterMainPage';
import VotePage from './pages/Voter/VotePage';
import AdminMainPage from './pages/Admin/AdminMainPage';
import CreateVotePage from './pages/Admin/CreateVotePage';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';

// --- Auth + redirect handler ---
function AuthHandler({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();

  useEffect(() => {
    // 역할 조회는 백엔드의 /api/me가 단일 출처다 (AR-H4: 클라이언트는 역할
    // 테이블을 직접 읽지 않으므로 게이팅이 백엔드에 집중되고, H5 초대 승격이
    // 첫 인증 요청에서 즉시 반영된다).
    const fetchRole = async (): Promise<{ isAdmin: boolean; isSuperAdmin: boolean }> => {
      try {
        const { data } = await axios.get<{ is_admin?: boolean; is_superadmin?: boolean }>('/me');
        return { isAdmin: Boolean(data.is_admin), isSuperAdmin: Boolean(data.is_superadmin) };
      } catch (error) {
        console.error('Failed to resolve role from /api/me:', errorData(error));
        return { isAdmin: false, isSuperAdmin: false }; // fail-closed
      }
    };

    // 관리자인지 확인하고, 로그인 직후라면 적절한 페이지로 리디렉션한다.
    const checkAdminAndRedirect = async (): Promise<void> => {
      const { isAdmin, isSuperAdmin } = await fetchRole();
      dispatch(setAdmin({ isAdmin, isSuperAdmin }));

      const { postLoginRedirectComplete } = store.getState().auth;
      if (!postLoginRedirectComplete) {
        navigate(isAdmin ? '/admin' : '/');
        dispatch(setRedirectComplete(true));
      }
    };

    // Firebase(GCIP) 인증 상태 리스너. onAuthStateChanged는 최초 로드 시 현재
    // 사용자(또는 null)로 한 번 발화하고 이후 로그인/로그아웃마다 발화한다.
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        // 직렬화 가능한 투영만 저장한다 (ID 토큰은 요청 시점에 axios
        // 인터셉터가 auth.currentUser.getIdToken()으로 즉석에서 가져온다).
        dispatch(setUser({ user: { uid: user.uid, email: user.email }, session: null }));
        void checkAdminAndRedirect();
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

// --- Main App ---
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
