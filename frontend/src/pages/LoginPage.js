// frontend/src/pages/LoginPage.js
import { supabase } from '../supabase'; // Supabase 클라이언트 import

function LoginPage() {

  // 카카오 로그인 버튼을 클릭했을 때 실행될 함수
  const handleKakaoLogin = async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'kakao',
    });

    if (error) {
      console.error('카카오 로그인 중 오류가 발생했습니다:', error.message);
    } else {
      // 성공적으로 카카오 로그인 페이지로 이동합니다.
      // 로그인 완료 후 Supabase가 자동으로 우리 앱으로 리디렉션해줍니다.
      console.log('카카오 로그인 성공!', data);
    }
  };

  return (
    <div>
      <h2>로그인</h2>
      <p>zk-vote에 오신 것을 환영합니다!</p>
      <button onClick={handleKakaoLogin}>
        카카오로 로그인하기
      </button>
    </div>
  );
}

export default LoginPage;