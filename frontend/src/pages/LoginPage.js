/**
 * @file frontend/src/pages/LoginPage.js
 * @desc Renders the login page for the application.
 * Refactored into smaller sub-components (EmailAuthForm, GoogleAuthButton).
 * Auth is via GCP Identity Platform (Firebase Auth Web SDK): Email + Password
 * (Sign In / Sign Up with e-mail verification + password reset) and OAuth via
 * Google (PROJECT_PLAN Phase 16 — replaces the legacy Supabase + Kakao flow).
 */

import React, { useState } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithPopup,
  GoogleAuthProvider,
} from 'firebase/auth';
import { auth } from '../firebase';

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
const googleButtonStyle = { ...buttonStyle, backgroundColor: '#ffffff', color: '#3c4043', border: '1px solid #dadce0', marginTop: '10px', width: '100%' };
const linkButtonStyle = { background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', fontSize: '0.85em', padding: 0, marginTop: '4px', textAlign: 'left' };
const errorStyle = { color: 'red', marginTop: '10px', fontSize: '0.9em' };
const infoStyle = { color: '#1a7f37', marginTop: '10px', fontSize: '0.9em' };
const dividerStyle = { margin: '20px 0', border: 0, borderTop: '1px solid #eee' };

/**
 * [UX] Map common Firebase Auth (GCIP) error codes to friendly Korean messages.
 * Firebase surfaces a stable `error.code` (e.g. 'auth/invalid-credential'),
 * unlike Supabase's free-text `error.message`.
 * @param {string} code - The Firebase `error.code`.
 * @returns {string} A user-friendly error message in Korean.
 */
const parseAuthError = (code) => {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return '이메일 또는 비밀번호가 잘못되었습니다.';
    case 'auth/email-already-in-use':
      return '이미 가입된 이메일입니다.';
    case 'auth/weak-password':
      return '비밀번호는 6자리 이상이어야 합니다.';
    case 'auth/invalid-email':
      return '유효하지 않은 이메일 형식입니다.';
    case 'auth/too-many-requests':
      return '시도가 너무 많습니다. 잠시 후 다시 시도해주세요.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return '로그인 창이 닫혔습니다. 다시 시도해주세요.';
    default:
      return '인증 중 오류가 발생했습니다. 다시 시도해주세요.';
  }
};

/**
 * @component EmailAuthForm
 * @desc Email/Password sign-in + sign-up (with e-mail verification) + password
 * reset, against GCP Identity Platform.
 * @param {object} props
 * @param {function} props.onLoadingChange - Callback to notify the parent of loading state.
 */
const EmailAuthForm = ({ onLoadingChange }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);

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
    setInfo(null);

    try {
      const { user } = await signInWithEmailAndPassword(auth, email, password);
      // Invariant #8: an unverified e-mail is not treated as admin/voter by the
      // backend. Surface the prompt rather than silently showing empty lists.
      if (user && !user.emailVerified) {
        setInfo('이메일 인증이 완료되지 않았습니다. 받은 편지함의 인증 링크를 확인해주세요.');
        try {
          await sendEmailVerification(user);
        } catch (_) {
          // resend is best-effort; ignore rate-limit errors here
        }
      }
      // On success, the App.js AuthHandler redirects.
    } catch (signInError) {
      setError(parseAuthError(signInError.code));
    } finally {
      setCombinedLoading(false);
    }
  };

  /**
   * Handles the email/password sign-up attempt (sends a verification e-mail).
   */
  const handleSignUp = async () => {
    setCombinedLoading(true);
    setError(null);
    setInfo(null);

    try {
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(user);
      alert('회원가입이 완료되었습니다!\n이메일을 확인하여 인증을 완료해주세요.');
    } catch (signUpError) {
      setError(parseAuthError(signUpError.code));
    } finally {
      setCombinedLoading(false);
    }
  };

  /**
   * Sends a password-reset e-mail to the entered address.
   */
  const handlePasswordReset = async () => {
    if (!email) {
      setError('비밀번호를 재설정할 이메일을 먼저 입력해주세요.');
      return;
    }
    setCombinedLoading(true);
    setError(null);
    setInfo(null);
    try {
      await sendPasswordResetEmail(auth, email);
      setInfo('비밀번호 재설정 메일을 보냈습니다. 받은 편지함을 확인해주세요.');
    } catch (resetError) {
      setError(parseAuthError(resetError.code));
    } finally {
      setCombinedLoading(false);
    }
  };

  return (
    <form onSubmit={handleEmailLogin} style={formStyle}>
      {/* Email Input */}
      <div style={inputGroupStyle}>
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
          aria-live="polite"
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

      {/* Password reset */}
      <button type="button" onClick={handlePasswordReset} style={linkButtonStyle} disabled={loading}>
        비밀번호를 잊으셨나요?
      </button>

      {/* Error / Info Messages */}
      {error && <p style={errorStyle} role="alert">{error}</p>}
      {info && <p style={infoStyle} role="status">{info}</p>}
    </form>
  );
};

/**
 * @component GoogleAuthButton
 * @desc Google OAuth sign-in via GCP Identity Platform (replaces Kakao). Uses a
 * popup (no full-page redirect); App.js AuthHandler reacts to the auth state.
 * @param {object} props
 * @param {function} props.onLoadingChange - Callback to notify the parent of loading state.
 * @param {boolean} props.disabled - Whether the button should be disabled by the parent.
 */
const GoogleAuthButton = ({ onLoadingChange, disabled }) => {
  const handleGoogleLogin = async () => {
    onLoadingChange(true);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      // On success the user is signed in; AuthHandler redirects. Google-asserted
      // e-mails arrive verified, satisfying invariant #8.
    } catch (error) {
      console.error('Google 로그인 중 오류가 발생했습니다:', error.code);
      alert(`Google 로그인 실패: ${parseAuthError(error.code)}`);
      onLoadingChange(false);
    }
  };

  return (
    <button
      onClick={handleGoogleLogin}
      style={disabled ? disabledButtonStyle : googleButtonStyle}
      disabled={disabled}
      aria-live="polite"
    >
      {disabled ? '처리중...' : 'Google로 로그인하기'}
    </button>
  );
};

/**
 * @component LoginPage
 * @desc Coordinates the Email and Google auth components, sharing a single
 * loading state (`isAuthLoading`) to disable all buttons during any auth op.
 * @returns {React.ReactElement} The rendered LoginPage component.
 */
function LoginPage() {
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  return (
    <main style={pageStyle}>
      <h2 style={{ textAlign: 'center' }}>ZK-VOTE 로그인</h2>

      {/* --- Email Login/Sign-up Form --- */}
      <EmailAuthForm onLoadingChange={setIsAuthLoading} />

      <hr style={dividerStyle} />

      {/* --- Google OAuth Login Button --- */}
      <GoogleAuthButton
        onLoadingChange={setIsAuthLoading}
        disabled={isAuthLoading}
      />
    </main>
  );
}

export default LoginPage;
