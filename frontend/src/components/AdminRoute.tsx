/**
 * @file frontend/src/components/AdminRoute.tsx
 * @desc Route guard: allows only authenticated admins. Non-admins are sent to
 * the voter main page ('/'); anonymous users to '/login'. The real gate is the
 * backend AdminUser extractor on each request — this is UX-level routing only.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAppSelector } from '../store/hooks';

const spinnerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  height: '100vh',
  fontSize: '1.2em',
  color: '#555',
};

const CenteredLoadingSpinner = () => <div style={spinnerStyle}>관리자 권한을 확인 중입니다...</div>;

interface AdminRouteProps {
  children: ReactNode;
}

const AdminRoute = ({ children }: AdminRouteProps): ReactNode => {
  const { isLoggedIn, isAdmin, loading } = useAppSelector((state) => state.auth);
  const location = useLocation();

  if (loading) {
    return <CenteredLoadingSpinner />;
  }

  if (isLoggedIn && isAdmin) {
    return children;
  }

  if (isLoggedIn && !isAdmin) {
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  return <Navigate to="/login" state={{ from: location }} replace />;
};

export default AdminRoute;
