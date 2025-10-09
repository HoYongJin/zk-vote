// frontend/src/pages/LoginPage.js
import React, { useState } from 'react';
import { supabase } from '../supabase';

const pageStyle = { width: '320px', margin: '60px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '8px' };
const inputStyle = { width: '95%', padding: '8px', marginBottom: '10px', border: '1px solid #ccc', borderRadius: '4px' };
const buttonContainerStyle = { display: 'flex', justifyContent: 'space-between', marginBottom: '15px' };
const buttonStyle = { flex: 1, padding: '10px', border: 'none', borderRadius: '4px', cursor: 'pointer' };
const kakaoButtonStyle = { ...buttonStyle, backgroundColor: '#FEE500', color: '#000000', marginTop: '10px', width: '100%' };
const errorStyle = { color: 'red', marginTop: '10px' };

function LoginPage() {
    // Login by Email(for test)
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);

    const handleEmailLogin = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        const { error } = await supabase.auth.signInWithPassword({
          email: email,
          password: password,
        });
        if (error) setError(error.message);
        setLoading(false);
    };

    const handleSignUp = async () => {
        setLoading(true);
        setError(null);
        const { error } = await supabase.auth.signUp({
          email: email,
          password: password,
        });
        if (error) {
          setError(error.message);
        } else {
          alert('회원가입이 완료되었습니다. 로그인해주세요!');
        }
        setLoading(false);
    };
    //

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

//   return (
//     <div>
//       <h2>로그인</h2>
//       <button onClick={handleKakaoLogin}>
//         카카오로 로그인하기
//       </button>
//     </div>
//   );
return (
    <div style={pageStyle}>
      <h2>ZK-VOTE 로그인</h2>
      
      {/* --- 이메일 로그인 폼 --- */}
      <form onSubmit={handleEmailLogin}>
        <input
          style={inputStyle}
          type="email"
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          style={inputStyle}
          type="password"
          placeholder="비밀번호 (6자리 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div style={buttonContainerStyle}>
          <button type="submit" style={{...buttonStyle, backgroundColor: '#007bff', color: 'white'}} disabled={loading}>
            {loading ? '처리중...' : '로그인'}
          </button>
          <button type="button" onClick={handleSignUp} style={{...buttonStyle, marginLeft: '10px', backgroundColor: '#6c757d', color: 'white'}} disabled={loading}>
            회원가입
          </button>
        </div>
      </form>

      {/* --- 에러 메시지 표시 --- */}
      {error && <p style={errorStyle}>{error}</p>}

      <hr style={{margin: '20px 0'}} />

      {/* --- 카카오 로그인 버튼 --- */}
      <button onClick={handleKakaoLogin} style={kakaoButtonStyle} disabled={loading}>
        카카오로 로그인하기
      </button>
    </div>
  );
}

export default LoginPage;