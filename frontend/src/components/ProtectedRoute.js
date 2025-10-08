// frontend/src/components/ProtectedRoute.js
import React from 'react';
import { useSelector } from 'react-redux';
import { Navigate } from 'react-router-dom';

const ProtectedRoute = ({ children }) => {
  const { isLoggedIn, loading } = useSelector((state) => state.auth);

  // 인증 상태를 확인하는 동안 로딩 화면을 보여줍니다.
  if (loading) {
    return <div>로딩 중...</div>;
  }

  // 로딩이 끝났지만 로그인이 안 되어있다면 로그인 페이지로 보냅니다.
  // children은 보호하려는 페이지(MainPage 등)를 의미합니다.
  return isLoggedIn ? children : <Navigate to="/login" />;
};

export default ProtectedRoute;