// frontend/src/pages/LoginPage.js
import { supabase } from '../supabase';

function LoginPage() {
  const handleKakaoLogin = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'kakao',
      options: {
        // 이 부분을 추가하세요!
        redirectTo: window.location.origin,
      },
    });

    if (error) {
      console.error('카카오 로그인 중 오류가 발생했습니다:', error.message);
    }
  };

  return (
    <div>
      <h2>로그인</h2>
      <button onClick={handleKakaoLogin}>
        카카오로 로그인하기
      </button>
    </div>
  );
}

export default LoginPage;