/**
 * @file frontend/src/components/ProtectedRoute.tsx
 * @desc Route guard: allows any authenticated user; redirects anonymous users
 * to /login. Shows a loader while auth state is still resolving.
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

const CenteredLoadingSpinner = () => <div style={spinnerStyle}>세션 정보를 확인 중입니다...</div>;

interface ProtectedRouteProps {
  children: ReactNode;
}

const ProtectedRoute = ({ children }: ProtectedRouteProps): ReactNode => {
  const { isLoggedIn, loading } = useAppSelector((state) => state.auth);
  const location = useLocation();

  // Show a loader until the initial session check completes (prevents a
  // flicker where the user is briefly redirected before the session resolves).
  if (loading) {
    return <CenteredLoadingSpinner />;
  }

  if (isLoggedIn) {
    return children;
  }

  return <Navigate to="/login" state={{ from: location }} replace />;
};

export default ProtectedRoute;
