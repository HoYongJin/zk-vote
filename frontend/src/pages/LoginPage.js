/**
 * @file frontend/src/pages/LoginPage.js
 * @desc Renders the login page for the application.
 * This component is refactored into smaller sub-components (EmailAuthForm, KakaoAuthButton)
 * to better manage state and improve maintainability.
 * It provides methods for Email + Password (Sign In / Sign Up) and OAuth via Kakao.
 */

import React, { useState } from 'react';
import { supabase } from '../supabase';

// --- [PERFORMANCE] Style Definitions ---
// Moved outside the component function to prevent re-creation on every render.
const pageStyle = { 
  width: '320px', 
  margin: '60px auto', 
  padding: '20px', 
  border: '1px solid #ccc', 
  borderRadius: '8px', 
  boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
};
const formStyle = { display: 'flex', flexDirection: 'column' };
const inputGroupStyle = { marginBottom: '10px' };
const labelStyle = { display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '0.9em' };
const inputStyle = { width: '95%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '1em' };
const buttonContainerStyle = { display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '15px' };
const buttonStyle = { flex: 1, padding: '10px', border: 'none', borderRadius: '4px', cursor: 'pointer', transition: 'background-color 0.2s ease' };
const primaryButtonStyle = { ...buttonStyle, backgroundColor: '#007bff', color: 'white' };
const secondaryButtonStyle = { ...buttonStyle, backgroundColor: '#6c757d', color: 'white' };
const disabledButtonStyle = { ...buttonStyle, backgroundColor: '#aaa', cursor: 'not-allowed', color: 'white' };
const kakaoButtonStyle = { ...buttonStyle, backgroundColor: '#FEE500', color: '#000000', marginTop: '10px', width: '100%' };
const errorStyle = { color: 'red', marginTop: '10px', fontSize: '0.9em' };
const dividerStyle = { margin: '20px 0', border: 0, borderTop: '1px solid #eee' };

/**
 * [UX] Helper function to parse common Supabase auth errors into user-friendly messages.
 * @param {string} errorMessage - The raw error message from Supabase.
 * @returns {string} A user-friendly error message in Korean.
 */
const parseAuthError = (errorMessage) => {
  if (!errorMessage) return "알 수 없는 오류가 발생했습니다.";
  
  // Use switch for clarity and easy expansion
  switch (errorMessage) {
    case "Invalid login credentials":
      return "이메일 또는 비밀번호가 잘못되었습니다.";
    case "User already registered":
      return "이미 가입된 이메일입니다.";
    case "Password should be at least 6 characters":
      return "비밀번호는 6자리 이상이어야 합니다.";
    case "Unable to validate email address: invalid format":
      return "유효하지 않은 이메일 형식입니다.";
    default:
      return errorMessage; // Return the raw message if not recognized
  }
};

/**
 * @component EmailAuthForm
 * @desc A self-contained form for handling Email/Password sign-in and sign-up.
 * Manages its own state for inputs, loading, and errors.
 * @param {object} props
 * @param {function} props.onLoadingChange - Callback to notify the parent of loading state.
 */
const EmailAuthForm = ({ onLoadingChange }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  /**
   * Sets the loading state both locally and in the parent component.
   * @param {boolean} isLoading - The new loading state.
   */
  const setCombinedLoading = (isLoading) => {
    setLoading(isLoading);
    onLoadingChange(isLoading); // Notify parent (LoginPage)
  };

  /**
   * Handles the email/password sign-in attempt.
   */
  const handleEmailLogin = async (e) => {
    e.preventDefault();
    setCombinedLoading(true);
    setError(null);
    
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });
    
    if (signInError) {
      setError(parseAuthError(signInError.message));
    }
    // On success, the App.js AuthHandler will automatically redirect.
    setCombinedLoading(false);
  };

  /**
   * Handles the email/password sign-up attempt.
   */
  const handleSignUp = async () => {
    setCombinedLoading(true);
    setError(null);
    
    const { error: signUpError } = await supabase.auth.signUp({
      email: email,
      password: password,
    });
    
    if (signUpError) {
      setError(parseAuthError(signUpError.message));
    } else {
      // [UX FIX] Changed alert message to inform user about email verification.
      alert('회원가입이 완료되었습니다!\n이메일을 확인하여 인증을 완료해주세요.');
    }
    setCombinedLoading(false);
  };

  return (
    <form onSubmit={handleEmailLogin} style={formStyle}>
      {/* Email Input */}
      <div style={inputGroupStyle}>
        {/* [Accessibility] Added label and id/htmlFor */}
        <label style={labelStyle} htmlFor="email-input">이메일</label>
        <input
          id="email-input"
          style={inputStyle}
          type="email"
          placeholder="email@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      
      {/* Password Input */}
      <div style={inputGroupStyle}>
        <label style={labelStyle} htmlFor="password-input">비밀번호</label>
        <input
          id="password-input"
          style={inputStyle}
          type="password"
          placeholder="비밀번호 (6자리 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      
      {/* Action Buttons */}
      <div style={buttonContainerStyle}>
        <button 
          type="submit" 
          style={loading ? disabledButtonStyle : primaryButtonStyle} 
          disabled={loading}
          aria-live="polite" // Announce loading state change
        >
          {loading ? '처리중...' : '로그인'}
        </button>
        <button 
          type="button" 
          onClick={handleSignUp} 
          style={loading ? disabledButtonStyle : secondaryButtonStyle} 
          disabled={loading}
          aria-live="polite"
        >
          {loading ? '처리중...' : '회원가입'}
        </button>
      </div>
      
      {/* Error Message Display */}
      {error && <p style={errorStyle} role="alert">{error}</p>}
    </form>
  );
};

/**
 * @component KakaoAuthButton
 * @desc A component for handling Kakao OAuth login.
 * @param {object} props
 * @param {function} props.onLoadingChange - Callback to notify the parent of loading state.
 * @param {boolean} props.disabled - Whether the button should be disabled by the parent.
 */
const KakaoAuthButton = ({ onLoadingChange, disabled }) => {
  
  /**
   * Handles the Kakao OAuth sign-in attempt.
   */
  const handleKakaoLogin = async () => {
    // [UX FIX] Set loading state immediately on click to disable all buttons.
    onLoadingChange(true);
    
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'kakao',
      options: {
        // [IMPORTANT] This ensures the user is redirected back to the
        // correct URL (e.g., localhost OR the deployed CloudFront domain).
        redirectTo: window.location.origin,
      },
    });

    // This error handling is only for *pre-redirect* errors (e.g., config wrong).
    if (error) {
      console.error('카카오 로그인 중 오류가 발생했습니다:', error.message);
      alert(`카카오 로그인 실패: ${error.message}`);
      onLoadingChange(false); // Turn off loading only if an error occurs *before* redirect
    }
    // On success, the user is redirected *away* from this page to Kakao.
  };

  return (
    <button 
      onClick={handleKakaoLogin} 
      style={disabled ? disabledButtonStyle : kakaoButtonStyle} 
      disabled={disabled}
      aria-live="polite"
    >
      {disabled ? '처리중...' : '카카오로 로그인하기'}
    </button>
  );
};


/**
 * @component LoginPage
 * @desc Renders the main LoginPage component.
 * It coordinates the Email and Kakao auth components, sharing a single
 * loading state (`isAuthLoading`) to disable all buttons during any auth operation.
 *
 * @returns {React.ReactElement} The rendered LoginPage component.
 */
function LoginPage() {
  // [UX] This single loading state is shared by both child components
  // to prevent simultaneous auth attempts (e.g., clicking Kakao and Email login at once).
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  return (
    // Use <main> for semantic HTML and accessibility
    <main style={pageStyle}>
      <h2 style={{ textAlign: 'center' }}>ZK-VOTE 로그인</h2>
      
      {/* --- Email Login/Sign-up Form --- */}
      {/* Pass the loading state handler down */}
      <EmailAuthForm onLoadingChange={setIsAuthLoading} />
      
      <hr style={dividerStyle} />

      {/* --- Kakao OAuth Login Button --- */}
      {/* Pass the loading state handler and the shared disabled state down */}
      <KakaoAuthButton 
        onLoadingChange={setIsAuthLoading} 
        disabled={isAuthLoading} 
      />
    </main>
  );
}

export default LoginPage;