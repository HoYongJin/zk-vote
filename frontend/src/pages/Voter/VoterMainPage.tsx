/**
 * @file frontend/src/pages/Voter/VoterMainPage.tsx
 * @desc Voter dashboard: lists elections by status and handles registration.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, LogOut, Shield, UserPlus, Vote } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import type { RegisterableElectionView } from '../../api/contracts';
import {
  useCompletedElectionsQuery,
  useFinalizedElectionsQuery,
  useRegisterVoterMutation,
  useRegisterableElectionsQuery,
} from '../../api/queries';
import {
  Button,
  Dialog,
  ElectionList,
  Field,
  PageShell,
  StatusBadge,
  TextInput,
  ToastViewport,
} from '../../components/ui';
import { useToasts } from '../../components/useToasts';
import { auth as firebaseAuth } from '../../firebase';
import { useAppSelector } from '../../store/hooks';
import { explorerAddressUrl } from '../../utils/explorer';
import {
  calculateSecretCommitment,
  clearVoterSecret,
  getOrCreateVoterSecret,
  getVoterSecret,
} from '../../utils/voterSecret';
import { errorData, errorMessage } from '../../utils/errors';

const formattedDate = (value?: string | null) => (value ? new Date(value).toLocaleString() : '정보 없음');

function VoterMainPage() {
  const auth = useAppSelector((state) => state.auth);
  const navigate = useNavigate();
  const location = useLocation();
  const { toasts, pushToast, dismissToast } = useToasts();

  const registerableQuery = useRegisterableElectionsQuery(auth.isLoggedIn);
  const finalizedQuery = useFinalizedElectionsQuery(auth.isLoggedIn);
  const completedQuery = useCompletedElectionsQuery(auth.isLoggedIn);
  const registerVoter = useRegisterVoterMutation();

  const [registrationTarget, setRegistrationTarget] = useState<RegisterableElectionView | null>(null);
  const [registrationName, setRegistrationName] = useState('');

  useEffect(() => {
    const state = location.state as { toast?: string } | null;
    if (state?.toast) {
      pushToast({ type: 'success', title: state.toast });
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate, pushToast]);

  useEffect(() => {
    const firstError = registerableQuery.error ?? finalizedQuery.error ?? completedQuery.error;
    if (firstError) {
      console.error('투표 목록 조회 오류:', errorData(firstError));
      pushToast({ type: 'error', title: '투표 목록 조회 실패', description: errorMessage(firstError) });
    }
  }, [completedQuery.error, finalizedQuery.error, pushToast, registerableQuery.error]);

  const handleLogout = async () => {
    try {
      await signOut(firebaseAuth);
    } catch (error) {
      console.error('로그아웃 실패:', errorData(error));
      pushToast({ type: 'error', title: '로그아웃 실패', description: errorMessage(error) });
    }
  };

  const openRegistration = (election: RegisterableElectionView) => {
    setRegistrationTarget(election);
    setRegistrationName('');
  };

  const submitRegistration = async () => {
    if (!registrationTarget) return;
    const name = registrationName.trim();
    if (!name) {
      pushToast({ type: 'error', title: '이름 누락', description: '등록에 사용할 이름을 입력하세요.' });
      return;
    }

    let generatedSecret: string | null = null;
    const hadStoredSecret = Boolean(getVoterSecret(registrationTarget.id));
    try {
      generatedSecret = getOrCreateVoterSecret(registrationTarget.id);
      const secretCommitment = await calculateSecretCommitment(generatedSecret);
      await registerVoter.mutateAsync({
        electionId: registrationTarget.id,
        input: { name, secretCommitment },
      });
      pushToast({
        type: 'success',
        title: '유권자 등록 완료',
        description: 'secret은 이 브라우저에만 저장됩니다. 투표도 같은 브라우저에서 진행해야 합니다.',
      });
      setRegistrationTarget(null);
      setRegistrationName('');
    } catch (error) {
      if (generatedSecret && !hadStoredSecret) {
        clearVoterSecret(registrationTarget.id);
      }
      console.error('Registration failed:', errorData(error));
      pushToast({ type: 'error', title: '등록 실패', description: errorMessage(error) });
    }
  };

  const loading = registerableQuery.isLoading || finalizedQuery.isLoading || completedQuery.isLoading;

  return (
    <>
      <PageShell
        title="ZK-VOTE"
        eyebrow={auth.user?.email ?? 'Voter'}
        actions={
          <>
            {auth.isAdmin && (
              <Button type="button" variant="secondary" icon={Shield} onClick={() => navigate('/admin')}>
                관리자 페이지
              </Button>
            )}
            <Button type="button" variant="ghost" icon={LogOut} onClick={handleLogout}>
              로그아웃
            </Button>
          </>
        }
      >
        {loading ? (
          <div className="panel">투표 목록을 불러오는 중...</div>
        ) : (
          <div className="dashboard-grid">
            <ElectionList
              title="투표 진행 중"
              items={finalizedQuery.data ?? []}
              empty="현재 진행중인 투표가 없습니다."
              getKey={(election) => election.id}
              renderItem={(election) => {
                const hasVotedOnThisBrowser = localStorage.getItem(`voted_${election.id}`) === 'true';
                return (
                  <article className="election-item">
                    <div className="election-item__header">
                      <div className="election-item__title">
                        <strong>{election.name}</strong>
                        <div className="election-item__meta">
                          <span>투표 마감일: {formattedDate(election.voting_end_time)}</span>
                          <span>후보자: {election.candidates.join(', ')}</span>
                        </div>
                      </div>
                      <div className="election-item__actions">
                        {hasVotedOnThisBrowser ? (
                          <StatusBadge tone="success">투표 완료 (이 브라우저)</StatusBadge>
                        ) : (
                          <Button type="button" icon={Vote} onClick={() => navigate(`/vote/${election.id}`, { state: { vote: election } })}>
                            투표하기
                          </Button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              }}
            />

            <ElectionList
              title="유권자 등록 가능한 투표"
              items={registerableQuery.data ?? []}
              empty="등록 가능한 투표가 없습니다."
              getKey={(election) => election.id}
              renderItem={(election) => (
                <article className="election-item">
                  <div className="election-item__header">
                    <div className="election-item__title">
                      <strong>{election.name}</strong>
                      <div className="election-item__meta">
                        <span>등록 마감일: {formattedDate(election.registration_end_time)}</span>
                        <span>후보자: {election.candidates.join(', ')}</span>
                      </div>
                    </div>
                    <div className="election-item__actions">
                      {election.isRegistered ? (
                        <StatusBadge tone="success">등록 완료</StatusBadge>
                      ) : (
                        <Button
                          type="button"
                          variant="secondary"
                          icon={UserPlus}
                          onClick={() => openRegistration(election)}
                          disabled={registerVoter.isPending && registerVoter.variables?.electionId === election.id}
                        >
                          등록하기
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              )}
            />

            <ElectionList
              title="참여했던 투표"
              items={completedQuery.data ?? []}
              empty="참여했던 투표가 없습니다."
              getKey={(election) => election.id}
              renderItem={(election) => (
                <article className="election-item">
                  <div className="election-item__header">
                    <div className="election-item__title">
                      <strong>{election.name}</strong>
                      <div className="election-item__meta">
                        <span>후보자: {election.candidates.join(', ')}</span>
                        <StatusBadge>종료됨</StatusBadge>
                      </div>
                    </div>
                    <div className="election-item__actions">
                      {election.contract_address && (
                        <a href={explorerAddressUrl(election.contract_address)} target="_blank" rel="noopener noreferrer">
                          <Button type="button" variant="secondary" icon={ExternalLink}>
                            컨트랙트 보기
                          </Button>
                        </a>
                      )}
                    </div>
                  </div>
                </article>
              )}
            />
          </div>
        )}
      </PageShell>

      <Dialog
        isOpen={Boolean(registrationTarget)}
        title={registrationTarget ? `'${registrationTarget.name}' 유권자 등록` : '유권자 등록'}
        description="등록 시 생성되는 secret은 서버로 전송되지 않고 이 브라우저 저장소에만 남습니다."
        onClose={() => setRegistrationTarget(null)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setRegistrationTarget(null)} disabled={registerVoter.isPending}>
              취소
            </Button>
            <Button type="button" icon={UserPlus} onClick={submitRegistration} isLoading={registerVoter.isPending}>
              등록하기
            </Button>
          </>
        }
      >
        <Field label="등록 이름" htmlFor="registrationName">
          <TextInput id="registrationName" value={registrationName} onChange={(event) => setRegistrationName(event.target.value)} />
        </Field>
      </Dialog>

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

export default VoterMainPage;
