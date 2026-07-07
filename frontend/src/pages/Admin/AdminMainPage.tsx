/**
 * @file frontend/src/pages/Admin/AdminMainPage.tsx
 * @desc Admin dashboard. Lists elections in three categories and exposes only
 * the controls the backend authorizes for the current role.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Ban, Check, ExternalLink, LogOut, Play, Plus, Rocket, Shield, UserMinus, Users } from 'lucide-react';
import { signOut } from 'firebase/auth';
import type { AdminListEntry, FinalizedElectionView, RegisterableElectionView } from '../../api/contracts';
import {
  useAddAdminMutation,
  useAdminListQuery,
  useAllowlistVotersMutation,
  useCompleteElectionMutation,
  useCompletedElectionsQuery,
  useFinalizeElectionMutation,
  useFinalizedElectionsQuery,
  useRegisterableElectionsQuery,
  useRevokeAdminMutation,
  useSetZkDeployMutation,
} from '../../api/queries';
import {
  Button,
  Dialog,
  ElectionList,
  Field,
  PageShell,
  ProgressOverlay,
  StatusBadge,
  TextArea,
  TextInput,
  ToastViewport,
} from '../../components/ui';
import { useToasts } from '../../components/useToasts';
import { explorerAddressUrl } from '../../utils/explorer';
import { auth } from '../../firebase';
import { useAppSelector } from '../../store/hooks';
import { errorCode, errorData, errorMessage } from '../../utils/errors';

type ConfirmAction =
  | { kind: 'deploy'; election: RegisterableElectionView }
  | { kind: 'complete'; election: FinalizedElectionView }
  | { kind: 'revoke'; admin: AdminListEntry };

const formattedDate = (value?: string | null) => (value ? new Date(value).toLocaleString() : '정보 없음');

function parseEmailList(raw: string): string[] {
  return raw.split(/[\n, ]+/).map((email) => email.trim()).filter(Boolean);
}

function errorCopy(error: unknown): { title: string; description: string } {
  const code = errorCode(error);
  switch (code) {
    case 'NO_VOTERS_REGISTERED':
      return { title: '등록된 유권자가 없습니다', description: '먼저 allowlist 사용자가 등록을 완료해야 투표를 시작할 수 있습니다.' };
    case 'STATE_ERROR':
      return { title: '현재 상태에서 실행할 수 없습니다', description: errorMessage(error) };
    case 'VOTING_DURATION_EXCEEDS_MAXIMUM':
      return { title: '투표 기간 확인 필요', description: '선택한 기간이 운영 제한을 초과합니다. 온체인 설정 후에는 변경할 수 없습니다.' };
    case 'RELAYER_BUSY':
      return { title: '릴레이어가 처리 중입니다', description: '같은 nonce/lease 경계의 작업이 진행 중입니다. 잠시 후 다시 시도하세요.' };
    case 'CHAIN_UNAVAILABLE':
      return { title: '체인 연결 실패', description: 'RPC 또는 relayer 상태를 확인해야 합니다.' };
    case 'LAST_SUPERADMIN':
      return { title: '마지막 슈퍼관리자는 해제할 수 없습니다', description: '운영 잠금을 막기 위해 백엔드가 거부했습니다.' };
    case 'SUPERADMIN_PRIVILEGES_REQUIRED':
      return { title: '슈퍼관리자 권한 필요', description: '이 작업은 superadmin만 실행할 수 있습니다.' };
    default:
      return { title: '요청 실패', description: errorMessage(error) };
  }
}

function ElectionMeta({ children }: { children: ReactNode }) {
  return <div className="election-item__meta">{children}</div>;
}

function AdminMainPage() {
  const isSuperAdmin = useAppSelector((state) => state.auth.isSuperAdmin);
  const currentAppUserId = useAppSelector((state) => state.auth.appUserId);
  const backendEmail = useAppSelector((state) => state.auth.backendEmail);
  const navigate = useNavigate();
  const location = useLocation();
  const { toasts, pushToast, dismissToast } = useToasts();

  const registerableQuery = useRegisterableElectionsQuery();
  const finalizedQuery = useFinalizedElectionsQuery();
  const completedQuery = useCompletedElectionsQuery();
  const adminListQuery = useAdminListQuery(isSuperAdmin);

  const addAdmin = useAddAdminMutation();
  const revokeAdmin = useRevokeAdminMutation();
  const allowlistVoters = useAllowlistVotersMutation();
  const deployZk = useSetZkDeployMutation();
  const finalizeElection = useFinalizeElectionMutation();
  const completeElection = useCompleteElectionMutation();

  const [isAddAdminOpen, setIsAddAdminOpen] = useState(false);
  const [adminEmail, setAdminEmail] = useState('');
  const [allowlistElection, setAllowlistElection] = useState<RegisterableElectionView | null>(null);
  const [allowlistText, setAllowlistText] = useState('');
  const [finalizeTarget, setFinalizeTarget] = useState<RegisterableElectionView | null>(null);
  const [voteEndTime, setVoteEndTime] = useState('');
  const [confirmExtendedFinalize, setConfirmExtendedFinalize] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  useEffect(() => {
    const state = location.state as { toast?: string } | null;
    if (state?.toast) {
      pushToast({ type: 'success', title: state.toast });
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate, pushToast]);

  useEffect(() => {
    const firstError = registerableQuery.error ?? finalizedQuery.error ?? completedQuery.error ?? adminListQuery.error;
    if (firstError) {
      console.error('관리자 대시보드 조회 오류:', errorData(firstError));
      const copy = errorCopy(firstError);
      pushToast({ type: 'error', title: copy.title, description: copy.description });
    }
  }, [adminListQuery.error, completedQuery.error, finalizedQuery.error, pushToast, registerableQuery.error]);

  const isLoadingPage = registerableQuery.isLoading || finalizedQuery.isLoading || completedQuery.isLoading;

  const activeAdmins = useMemo(
    () => (adminListQuery.data ?? []).filter((admin) => !admin.revoked_at),
    [adminListQuery.data],
  );
  const revokedAdmins = useMemo(
    () => (adminListQuery.data ?? []).filter((admin) => admin.revoked_at),
    [adminListQuery.data],
  );

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('로그아웃 중 오류 발생:', errorData(error));
      pushToast({ type: 'error', title: '로그아웃 실패', description: errorMessage(error) });
    }
  };

  const submitAddAdmin = async () => {
    const email = adminEmail.trim();
    if (!email) {
      pushToast({ type: 'error', title: '이메일 누락', description: '초대할 관리자 이메일을 입력하세요.' });
      return;
    }
    try {
      await addAdmin.mutateAsync(email);
      pushToast({ type: 'success', title: '관리자 초대 등록', description: `${email} 계정은 다음 인증 요청에서 관리자 권한을 받습니다.` });
      setAdminEmail('');
      setIsAddAdminOpen(false);
    } catch (error) {
      console.error('관리자 추가 실패:', errorData(error));
      const copy = errorCopy(error);
      pushToast({ type: 'error', title: copy.title, description: copy.description });
    }
  };

  const submitAllowlist = async () => {
    if (!allowlistElection) return;
    const emails = parseEmailList(allowlistText);
    if (emails.length === 0) {
      pushToast({ type: 'error', title: '유권자 이메일 누락', description: '등록할 유권자 이메일을 하나 이상 입력하세요.' });
      return;
    }

    try {
      const response = await allowlistVoters.mutateAsync({ electionId: allowlistElection.id, emails });
      pushToast({
        type: 'success',
        title: '유권자 allowlist 반영',
        description: `${response.summary.newly_registered_count}명 추가, ${response.summary.duplicates_skipped_count}명 중복 제외, ${response.summary.invalid_format_skipped_count}명 형식 제외`,
      });
      setAllowlistElection(null);
      setAllowlistText('');
    } catch (error) {
      console.error('유권자 등록 실패:', errorData(error));
      const copy = errorCopy(error);
      pushToast({ type: 'error', title: copy.title, description: copy.description });
    }
  };

  const submitFinalize = async (confirmExtendedDuration = false) => {
    if (!finalizeTarget) return;
    if (!voteEndTime) {
      pushToast({ type: 'error', title: '투표 종료 시간 누락', description: '투표 종료 시간을 선택하세요.' });
      return;
    }

    try {
      await finalizeElection.mutateAsync({
        electionId: finalizeTarget.id,
        input: {
          voteEndTime: new Date(voteEndTime).toISOString(),
          ...(confirmExtendedDuration ? { confirmExtendedDuration: true } : {}),
        },
      });
      pushToast({ type: 'success', title: '등록 마감 완료', description: 'Merkle root가 확정되었고 투표가 시작되었습니다.' });
      setFinalizeTarget(null);
      setVoteEndTime('');
      setConfirmExtendedFinalize(false);
    } catch (error) {
      if (errorCode(error) === 'VOTING_DURATION_EXCEEDS_MAXIMUM' && !confirmExtendedDuration) {
        setConfirmExtendedFinalize(true);
        return;
      }
      console.error('등록 마감 실패:', errorData(error));
      const copy = errorCopy(error);
      pushToast({ type: 'error', title: copy.title, description: copy.description });
    }
  };

  const runConfirmAction = async () => {
    if (!confirmAction) return;
    try {
      if (confirmAction.kind === 'deploy') {
        await deployZk.mutateAsync(confirmAction.election.id);
        pushToast({ type: 'success', title: 'ZK 설정 및 배포 완료', description: confirmAction.election.name });
      }
      if (confirmAction.kind === 'complete') {
        await completeElection.mutateAsync(confirmAction.election.id);
        pushToast({ type: 'success', title: '투표 종료 완료', description: confirmAction.election.name });
      }
      if (confirmAction.kind === 'revoke') {
        await revokeAdmin.mutateAsync(confirmAction.admin.id);
        pushToast({ type: 'success', title: '관리자 권한 해제', description: confirmAction.admin.email ?? confirmAction.admin.id });
      }
      setConfirmAction(null);
    } catch (error) {
      console.error('관리 작업 실패:', errorData(error));
      const copy = errorCopy(error);
      pushToast({ type: 'error', title: copy.title, description: copy.description });
    }
  };

  const operationInFlight =
    deployZk.isPending || finalizeElection.isPending || completeElection.isPending || allowlistVoters.isPending || addAdmin.isPending || revokeAdmin.isPending;

  const renderAdminTable = (admins: AdminListEntry[], status: 'active' | 'revoked') => (
    <table className="admin-table">
      <thead>
        <tr>
          <th>이메일</th>
          <th>권한</th>
          <th>상태</th>
          <th>작업</th>
        </tr>
      </thead>
      <tbody>
        {admins.map((admin) => (
          <tr key={admin.id}>
            <td>
              <div>{admin.email ?? '이메일 없음'}</div>
              <div className="mono">{admin.id}</div>
            </td>
            <td>{admin.is_superadmin ? <StatusBadge tone="warning">Superadmin</StatusBadge> : <StatusBadge>Admin</StatusBadge>}</td>
            <td>
              {status === 'active' ? <StatusBadge tone="success">활성</StatusBadge> : <StatusBadge tone="danger">해제됨</StatusBadge>}
            </td>
            <td>
              {status === 'active' ? (
                <Button
                  type="button"
                  variant="danger"
                  icon={UserMinus}
                  onClick={() => setConfirmAction({ kind: 'revoke', admin })}
                  disabled={admin.id === currentAppUserId && admin.is_superadmin}
                >
                  권한 해제
                </Button>
              ) : (
                <span className="mono">{admin.revoked_at ? formattedDate(admin.revoked_at) : '-'}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <PageShell
        title="관리자 대시보드"
        eyebrow={backendEmail ?? 'Admin'}
        width="wide"
        actions={
          <>
            {isSuperAdmin && (
              <Button type="button" variant="secondary" icon={Shield} onClick={() => setIsAddAdminOpen(true)}>
                관리자 추가
              </Button>
            )}
            <Button type="button" icon={Plus} onClick={() => navigate('/admin/create')}>
              투표 생성
            </Button>
            <Button type="button" variant="ghost" icon={LogOut} onClick={handleLogout}>
              로그아웃
            </Button>
          </>
        }
      >
        {isLoadingPage ? (
          <div className="panel">데이터를 불러오는 중...</div>
        ) : (
          <div className="dashboard-grid">
            <ElectionList
              title="유권자 등록 중인 투표"
              description="allowlist, ZK 배포, 등록 마감이 이 단계에서 수행됩니다."
              items={registerableQuery.data ?? []}
              empty="등록 중인 투표가 없습니다."
              getKey={(vote) => vote.id}
              renderItem={(vote) => {
                const canFinalize = Boolean(vote.contract_address);
                const isBusy =
                  (deployZk.isPending && deployZk.variables === vote.id) ||
                  (finalizeElection.isPending && finalizeElection.variables?.electionId === vote.id) ||
                  (allowlistVoters.isPending && allowlistVoters.variables?.electionId === vote.id);
                return (
                  <article className="election-item">
                    <div className="election-item__header">
                      <div className="election-item__title">
                        <strong>{vote.name}</strong>
                        <ElectionMeta>
                          <span>ID: {vote.id}</span>
                          <span>후보자: {vote.candidates.join(', ')}</span>
                          <span>등록 마감일: {formattedDate(vote.registration_end_time)}</span>
                          <span>컨트랙트: {vote.contract_address ? <span className="mono">{vote.contract_address}</span> : '배포 전'}</span>
                        </ElectionMeta>
                      </div>
                      <div className="election-item__actions">
                        <Button type="button" variant="secondary" icon={Users} onClick={() => setAllowlistElection(vote)} disabled={isBusy}>
                          유권자 등록
                        </Button>
                        <Button
                          type="button"
                          variant="success"
                          icon={Play}
                          onClick={() => setFinalizeTarget(vote)}
                          disabled={isBusy || !canFinalize}
                          title={canFinalize ? undefined : 'ZK 설정 & 배포 후 등록 마감이 가능합니다.'}
                        >
                          등록 마감
                        </Button>
                        {vote.contract_address ? (
                          <StatusBadge tone="success">ZK 설정 완료</StatusBadge>
                        ) : isSuperAdmin ? (
                          <Button
                            type="button"
                            variant="warning"
                            icon={Rocket}
                            onClick={() => setConfirmAction({ kind: 'deploy', election: vote })}
                            disabled={isBusy}
                          >
                            ZK 설정 & 배포
                          </Button>
                        ) : (
                          <Button type="button" variant="secondary" icon={Rocket} disabled title="슈퍼관리자만 ZK 설정/배포를 수행할 수 있습니다.">
                            ZK 설정 & 배포
                          </Button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              }}
            />

            <ElectionList
              title="투표 진행 중"
              description="진행 중인 투표는 종료 처리만 가능합니다."
              items={finalizedQuery.data ?? []}
              empty="현재 진행 중인 투표가 없습니다."
              getKey={(vote) => vote.id}
              renderItem={(vote) => {
                const isBusy = completeElection.isPending && completeElection.variables === vote.id;
                return (
                  <article className="election-item">
                    <div className="election-item__header">
                      <div className="election-item__title">
                        <strong>{vote.name}</strong>
                        <ElectionMeta>
                          <span>투표 마감일: {formattedDate(vote.voting_end_time)}</span>
                          <span>등록률: {vote.registered_voters ?? 0} / {vote.total_voters ?? 0}</span>
                          <span>Depth {vote.merkle_tree_depth}</span>
                          <span>후보자 {vote.num_candidates}명</span>
                        </ElectionMeta>
                      </div>
                      <div className="election-item__actions">
                        {vote.contract_address && (
                          <a href={explorerAddressUrl(vote.contract_address)} target="_blank" rel="noopener noreferrer">
                            <Button type="button" variant="secondary" icon={ExternalLink}>
                              컨트랙트 보기
                            </Button>
                          </a>
                        )}
                        <Button
                          type="button"
                          variant="danger"
                          icon={Ban}
                          onClick={() => setConfirmAction({ kind: 'complete', election: vote })}
                          disabled={isBusy}
                        >
                          투표 종료
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              }}
            />

            <ElectionList
              title="종료된 투표"
              description="완료된 투표는 읽기 전용으로 표시합니다."
              items={completedQuery.data ?? []}
              empty="종료된 투표가 없습니다."
              getKey={(vote) => vote.id}
              renderItem={(vote) => (
                <article className="election-item">
                  <div className="election-item__header">
                    <div className="election-item__title">
                      <strong>{vote.name}</strong>
                      <ElectionMeta>
                        <span>최종 마감일: {formattedDate(vote.voting_end_time)}</span>
                        <span>후보자: {vote.candidates.join(', ')}</span>
                      </ElectionMeta>
                    </div>
                    <div className="election-item__actions">
                      {vote.contract_address && (
                        <a href={explorerAddressUrl(vote.contract_address)} target="_blank" rel="noopener noreferrer">
                          <Button type="button" variant="secondary" icon={ExternalLink}>
                            컨트랙트 보기
                          </Button>
                        </a>
                      )}
                      <StatusBadge tone="neutral">종료됨</StatusBadge>
                    </div>
                  </div>
                </article>
              )}
            />

            {isSuperAdmin && (
              <section className="panel">
                <div className="panel__header">
                  <div>
                    <h2>관리자 권한 관리</h2>
                    <p>초대, 활성 관리자 조회, 권한 해제만 UI에 노출합니다. supersede는 런북/API 전용입니다.</p>
                  </div>
                  <Button type="button" variant="secondary" icon={Shield} onClick={() => setIsAddAdminOpen(true)}>
                    관리자 추가
                  </Button>
                </div>
                {adminListQuery.isLoading ? (
                  <p>관리자 목록을 불러오는 중...</p>
                ) : (
                  <>
                    <h3>활성 관리자</h3>
                    {activeAdmins.length ? renderAdminTable(activeAdmins, 'active') : <p className="empty-state">활성 관리자가 없습니다.</p>}
                    <h3>해제된 관리자</h3>
                    {revokedAdmins.length ? renderAdminTable(revokedAdmins, 'revoked') : <p className="empty-state">해제된 관리자가 없습니다.</p>}
                  </>
                )}
              </section>
            )}
          </div>
        )}
      </PageShell>

      <Dialog
        isOpen={isAddAdminOpen}
        title="관리자 추가"
        description="이메일 invitation을 등록합니다. 해당 사용자는 다음 인증 요청에서 ordinary admin으로 승격됩니다."
        onClose={() => setIsAddAdminOpen(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setIsAddAdminOpen(false)} disabled={addAdmin.isPending}>
              취소
            </Button>
            <Button type="button" icon={Check} onClick={submitAddAdmin} isLoading={addAdmin.isPending}>
              추가
            </Button>
          </>
        }
      >
        <Field label="관리자 이메일" htmlFor="adminEmail">
          <TextInput id="adminEmail" type="email" value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        isOpen={Boolean(allowlistElection)}
        title={allowlistElection ? `'${allowlistElection.name}' 유권자 등록` : '유권자 등록'}
        description="쉼표, 공백, 줄바꿈으로 구분된 이메일 allowlist를 등록합니다."
        onClose={() => setAllowlistElection(null)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setAllowlistElection(null)} disabled={allowlistVoters.isPending}>
              취소
            </Button>
            <Button type="button" icon={Users} onClick={submitAllowlist} isLoading={allowlistVoters.isPending}>
              등록 실행
            </Button>
          </>
        }
      >
        <Field label="유권자 이메일 목록" htmlFor="voterEmails">
          <TextArea id="voterEmails" value={allowlistText} onChange={(event) => setAllowlistText(event.target.value)} placeholder="voter1@example.com, voter2@example.com" />
        </Field>
      </Dialog>

      <Dialog
        isOpen={Boolean(finalizeTarget)}
        title={finalizeTarget ? `'${finalizeTarget.name}' 등록 마감` : '등록 마감'}
        description="투표 종료 시각은 온체인에 고정되므로 신중하게 선택해야 합니다."
        onClose={() => setFinalizeTarget(null)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setFinalizeTarget(null)} disabled={finalizeElection.isPending}>
              취소
            </Button>
            <Button type="button" variant="success" icon={Play} onClick={() => void submitFinalize(false)} isLoading={finalizeElection.isPending}>
              마감 및 투표 시작
            </Button>
          </>
        }
      >
        <Field label="투표 종료 시간" htmlFor="voteEndTime">
          <TextInput id="voteEndTime" type="datetime-local" value={voteEndTime} onChange={(event) => setVoteEndTime(event.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        isOpen={confirmExtendedFinalize}
        title="최대 투표 기간 초과 확인"
        description="백엔드가 장기 투표 기간을 차단했습니다. 그래도 진행하면 온체인 설정 후 변경할 수 없습니다."
        tone="warning"
        onClose={() => setConfirmExtendedFinalize(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setConfirmExtendedFinalize(false)} disabled={finalizeElection.isPending}>
              취소
            </Button>
            <Button
              type="button"
              variant="warning"
              icon={Check}
              onClick={() => {
                setConfirmExtendedFinalize(false);
                void submitFinalize(true);
              }}
              isLoading={finalizeElection.isPending}
            >
              확인 후 진행
            </Button>
          </>
        }
      />

      <Dialog
        isOpen={Boolean(confirmAction)}
        title={
          confirmAction?.kind === 'deploy'
            ? 'ZK 설정 및 배포'
            : confirmAction?.kind === 'complete'
              ? '투표 종료'
              : '관리자 권한 해제'
        }
        description={
          confirmAction?.kind === 'deploy'
            ? '컨트랙트 배포와 아티팩트 등록이 진행됩니다. 작업 중에는 같은 election 작업을 다시 누르지 마세요.'
            : confirmAction?.kind === 'complete'
              ? '투표를 완료 상태로 전환합니다. 이후 일반 관리 UI에서 수정하지 않습니다.'
              : '해당 관리자의 권한을 soft revoke 합니다.'
        }
        tone={confirmAction?.kind === 'deploy' ? 'warning' : confirmAction?.kind === 'complete' || confirmAction?.kind === 'revoke' ? 'danger' : 'default'}
        onClose={() => setConfirmAction(null)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setConfirmAction(null)} disabled={operationInFlight}>
              취소
            </Button>
            <Button type="button" variant={confirmAction?.kind === 'deploy' ? 'warning' : 'danger'} icon={Check} onClick={runConfirmAction} isLoading={operationInFlight}>
              확인
            </Button>
          </>
        }
      />

      {operationInFlight && <ProgressOverlay title="관리 작업 처리 중" detail="체인/DB/아티팩트 경계가 포함된 작업은 수십 초 이상 걸릴 수 있습니다." />}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

export default AdminMainPage;
