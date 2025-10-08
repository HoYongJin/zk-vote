// frontend/src/pages/AdminDashboardPage.js
import React from 'react';
import { Link } from 'react-router-dom';

const linkStyle = { display: 'block', margin: '10px 0', fontSize: '18px' };

function AdminDashboardPage() {
  return (
    <div>
      <h1>관리자 대시보드</h1>
      <nav>
        <Link to="/admin/create" style={linkStyle}>새로운 투표 생성하기</Link>
        <Link to="/admin/manage" style={linkStyle}>기존 투표 관리하기 (유권자 등록/마감)</Link>
        <Link to="/" style={linkStyle}>메인 페이지로 돌아가기</Link>
      </nav>
    </div>
  );
}

export default AdminDashboardPage;