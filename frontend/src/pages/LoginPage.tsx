/**
 * @file frontend/src/pages/LoginPage.tsx
 * @desc Login page. Auth is via GCP Identity Platform (Firebase Auth Web SDK).
 */
import { useState, type FormEvent } from 'react';
import { KeyRound, LogIn, RotateCcw, UserPlus } from 'lucide-react';
import { FirebaseError } from 'firebase/app';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
} from 'firebase/auth';
import { Button, Field, TextInput } from '../components/ui';
import { auth } from '../firebase';

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
  onError: (message: string | null) => void;
  onInfo: (message: string | null) => void;
}

const EmailAuthForm = ({ onLoadingChange, onError, onInfo }: EmailAuthFormProps) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const setCombinedLoading = (isLoading: boolean) => {
    setLoading(isLoading);
    onLoadingChange(isLoading);
  };

  const resetMessages = () => {
    onError(null);
    onInfo(null);
  };

  const handleEmailLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCombinedLoading(true);
    resetMessages();

    try {
      const { user } = await signInWithEmailAndPassword(auth, email, password);
      if (user && !user.emailVerified) {
        onInfo('이메일 인증이 완료되지 않았습니다. 받은 편지함의 인증 링크를 확인해주세요.');
        try {
          await sendEmailVerification(user);
        } catch {
          // resend is best-effort; ignore rate-limit errors here
        }
      }
    } catch (signInError) {
      onError(parseAuthError(authErrorCode(signInError)));
    } finally {
      setCombinedLoading(false);
    }
  };

  const handleSignUp = async () => {
    setCombinedLoading(true);
    resetMessages();

    try {
      const { user } = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(user);
      onInfo('회원가입이 완료되었습니다. 이메일 인증 링크를 확인해주세요.');
    } catch (signUpError) {
      onError(parseAuthError(authErrorCode(signUpError)));
    } finally {
      setCombinedLoading(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!email) {
      onError('비밀번호를 재설정할 이메일을 먼저 입력해주세요.');
      return;
    }
    setCombinedLoading(true);
    resetMessages();
    try {
      await sendPasswordResetEmail(auth, email);
      onInfo('비밀번호 재설정 메일을 보냈습니다. 받은 편지함을 확인해주세요.');
    } catch (resetError) {
      onError(parseAuthError(authErrorCode(resetError)));
    } finally {
      setCombinedLoading(false);
    }
  };

  return (
    <form className="form-grid" onSubmit={handleEmailLogin}>
      <Field label="이메일" htmlFor="email-input">
        <TextInput
          id="email-input"
          type="email"
          placeholder="email@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </Field>

      <Field label="비밀번호" htmlFor="password-input">
        <TextInput
          id="password-input"
          type="password"
          placeholder="비밀번호 (6자리 이상)"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </Field>

      <div className="page-shell__actions">
        <Button type="submit" icon={LogIn} isLoading={loading}>
          로그인
        </Button>
        <Button type="button" variant="secondary" icon={UserPlus} onClick={handleSignUp} isLoading={loading}>
          회원가입
        </Button>
      </div>

      <Button type="button" variant="ghost" icon={RotateCcw} onClick={handlePasswordReset} disabled={loading}>
        비밀번호를 잊으셨나요?
      </Button>
    </form>
  );
};

interface GoogleAuthButtonProps {
  onLoadingChange: (loading: boolean) => void;
  onError: (message: string | null) => void;
  onInfo: (message: string | null) => void;
  disabled: boolean;
}

const GoogleAuthButton = ({ onLoadingChange, onError, onInfo, disabled }: GoogleAuthButtonProps) => {
  const handleGoogleLogin = async () => {
    onLoadingChange(true);
    onError(null);
    onInfo(null);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      console.error('Google 로그인 중 오류가 발생했습니다:', authErrorCode(error));
      onError(`Google 로그인 실패: ${parseAuthError(authErrorCode(error))}`);
      onLoadingChange(false);
    }
  };

  return (
    <Button type="button" variant="secondary" icon={KeyRound} onClick={handleGoogleLogin} disabled={disabled} fullWidth>
      {disabled ? '처리중...' : 'Google로 로그인하기'}
    </Button>
  );
};

function LoginPage() {
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  return (
    <main className="login-shell">
      <section className="login-panel">
        <h1>ZK-VOTE 로그인</h1>

        <EmailAuthForm onLoadingChange={setIsAuthLoading} onError={setError} onInfo={setInfo} />

        <div className="divider">또는</div>

        <GoogleAuthButton onLoadingChange={setIsAuthLoading} onError={setError} onInfo={setInfo} disabled={isAuthLoading} />

        {error && <div className="error-banner" role="alert">{error}</div>}
        {info && <div className="info-banner" role="status">{info}</div>}
      </section>
    </main>
  );
}

export default LoginPage;
