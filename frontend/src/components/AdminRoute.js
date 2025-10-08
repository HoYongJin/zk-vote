// frontend/src/components/AdminRoute.js
import React from 'react';
import { useSelector } from 'react-redux';
import { Navigate } from 'react-router-dom';

// children은 이 컴포넌트가 감싸게 될 자식 컴포넌트(AdminPage)를 의미합니다.
const AdminRoute = ({ children }) => {
  const { isLoggedIn, isAdmin, loading } = useSelector((state) => state.auth);

  // 아직 로그인 상태나 관리자 여부를 확인 중이라면 잠시 대기
  if (loading) {
    return <div>로딩 중...</div>;
  }

  // 로그인 상태이고 관리자라면 페이지를 보여주고,
  // 그렇지 않다면 메인 페이지('/')로 보내버립니다.
  return isLoggedIn && isAdmin ? children : <Navigate to="/" />;
};

export default AdminRoute;