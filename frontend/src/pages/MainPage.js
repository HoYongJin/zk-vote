// frontend/src/pages/MainPage.js
import { useSelector, useDispatch } from 'react-redux';
import { supabase } from '../supabase';
import { clearUser } from '../store/authSlice';

function MainPage() {
  // Redux 스토어에서 auth 상태를 가져옵니다.
  const auth = useSelector((state) => state.auth);
  const dispatch = useDispatch();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    dispatch(clearUser()); // 스토어에서도 유저 정보 제거
  };

  return (
    <div>
      <h1>메인 페이지</h1>
      {auth.isLoggedIn ? (
        <div>
          <p>{auth.user.email} 님, 환영합니다!</p>
          <button onClick={handleLogout}>로그아웃</button>
        </div>
      ) : (
        <p>로그인이 필요합니다.</p>
      )}
    </div>
  );
}

export default MainPage;