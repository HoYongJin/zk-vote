/**
 * @file frontend/src/pages/LoginPage.tsx
 * @desc Login page. Auth is via GCP Identity Platform (Firebase Auth Web SDK):
 * Email + Password (Sign In / Sign Up with e-mail verification + password
 * reset) and OAuth via Google.
 */
import { useState, type CSSProperties, type FormEvent } from 'react';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithPopup,
  GoogleAuthProvider,
} from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { auth } from '../firebase';

const pageStyle: CSSProperties = { width: '320px', margin: '60px auto', padding: '20px', border: '1px solid #ccc', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.05)' };
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column' };
const inputGroupStyle: CSSProperties = { marginBottom: '10px' };
const labelStyle: CSSProperties = { display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '0.9em' };
const inputStyle: CSSProperties = { width: '95%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '1em' };
const buttonContainerStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '15px' };
const buttonStyle: CSSProperties = { flex: 1, padding: '10px', border: 'none', borderRadius: '4px', cursor: 'pointer', transition: 'background-color 0.2s ease' };
const primaryButtonStyle: CSSProperties = { ...buttonStyle, backgroundColor: '#007bff', color: 'white' };
const secondaryButtonStyle: CSSProperties = { ...buttonStyle, backgroundColor: '#6c757d', color: 'white' };
const disabledButtonStyle: CSSProperties = { ...buttonStyle, backgroundColor: '#aaa', cursor: 'not-allowed', color: 'white' };
const googleButtonStyle: CSSProperties = { ...buttonStyle, backgroundColor: '#ffffff', color: '#3c4043', border: '1px solid #dadce0', marginTop: '10px', width: '100%' };
const linkButtonStyle: CSSProperties = { background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', fontSize: '0.85em', padding: 0, marginTop: '4px', textAlign: 'left' };
const errorStyle: CSSProperties = { color: 'red', marginTop: '10px', fontSize: '0.9em' };
const infoStyle: CSSProperties = { color: '#1a7f37', marginTop: '10px', fontSize: '0.9em' };
const dividerStyle: CSSProperties = { margin: '20px 0', border: 0, borderTop: '1px solid #eee' };

/** Maps stable Firebase Auth error codes to friendly Korean messages. */
const parseAuthError = (code: string): string => {
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

const authErrorCode = (error: unknown): string => (error instanceof FirebaseError ? error.code : '');

interface EmailAuthFormProps {
  onLoadingChange: (loading: boolean) => void;
}

const EmailAuthForm = ({ onLoadingChange }: EmailAuthFormProps) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const setCombinedLoading = (isLoading: boolean) => {
    setLoading(isLoading);
    onLoadingChange(isLoading);
  };

  const handleEmailLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCombinedLoading(true);
    setError(null);
    setInfo(null);

    try {
      const { user } = await signInWithEmailAndPassword(auth, email, password);
      // Invariant #8: an unverified e-mail is not treated as admin/voter by the backend.
      if (user && !user.emailVerified) {
        setInfo('이메일 인증이 완료되지 않았습니다. 받은 편지함의 인증 링크를 확인해주세요.');
        try {
          await sendEmailVerification(user);
        } catch {
          // resend is best-effort; ignore rate-limit errors here
        }
      }
    } catch (signInError) {
      setError(parseAuthError(authErrorCode(signInError)));
    } finally {
      setCombinedLoading(false);
    }
  };

  const handleSignUp = async () => {
    setCombinedLoading(true);
    setError(null);
    setInfo(null);

    try {
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(user);
      alert('회원가입이 완료되었습니다!\n이메일을 확인하여 인증을 완료해주세요.');
    } catch (signUpError) {
      setError(parseAuthError(authErrorCode(signUpError)));
    } finally {
      setCombinedLoading(false);
    }
  };

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
      setError(parseAuthError(authErrorCode(resetError)));
    } finally {
      setCombinedLoading(false);
    }
  };

  return (
    <form onSubmit={handleEmailLogin} style={formStyle}>
      <div style={inputGroupStyle}>
        <label style={labelStyle} htmlFor="email-input">이메일</label>
        <input id="email-input" style={inputStyle} type="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>

      <div style={inputGroupStyle}>
        <label style={labelStyle} htmlFor="password-input">비밀번호</label>
        <input id="password-input" style={inputStyle} type="password" placeholder="비밀번호 (6자리 이상)" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>

      <div style={buttonContainerStyle}>
        <button type="submit" style={loading ? disabledButtonStyle : primaryButtonStyle} disabled={loading} aria-live="polite">
          {loading ? '처리중...' : '로그인'}
        </button>
        <button type="button" onClick={handleSignUp} style={loading ? disabledButtonStyle : secondaryButtonStyle} disabled={loading} aria-live="polite">
          {loading ? '처리중...' : '회원가입'}
        </button>
      </div>

      <button type="button" onClick={handlePasswordReset} style={linkButtonStyle} disabled={loading}>
        비밀번호를 잊으셨나요?
      </button>

      {error && <p style={errorStyle} role="alert">{error}</p>}
      {info && <p style={infoStyle} role="status">{info}</p>}
    </form>
  );
};

interface GoogleAuthButtonProps {
  onLoadingChange: (loading: boolean) => void;
  disabled: boolean;
}

const GoogleAuthButton = ({ onLoadingChange, disabled }: GoogleAuthButtonProps) => {
  const handleGoogleLogin = async () => {
    onLoadingChange(true);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      // Google-asserted e-mails arrive verified, satisfying invariant #8.
    } catch (error) {
      console.error('Google 로그인 중 오류가 발생했습니다:', authErrorCode(error));
      alert(`Google 로그인 실패: ${parseAuthError(authErrorCode(error))}`);
      onLoadingChange(false);
    }
  };

  return (
    <button onClick={handleGoogleLogin} style={disabled ? disabledButtonStyle : googleButtonStyle} disabled={disabled} aria-live="polite">
      {disabled ? '처리중...' : 'Google로 로그인하기'}
    </button>
  );
};

function LoginPage() {
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  return (
    <main style={pageStyle}>
      <h2 style={{ textAlign: 'center' }}>ZK-VOTE 로그인</h2>

      <EmailAuthForm onLoadingChange={setIsAuthLoading} />

      <hr style={dividerStyle} />

      <GoogleAuthButton onLoadingChange={setIsAuthLoading} disabled={isAuthLoading} />
    </main>
  );
}

export default LoginPage;
