/**
 * @file frontend/src/pages/Admin/AdminMainPage.tsx
 * @desc Admin dashboard. Lists elections in three categories (registerable,
 * votable, completed) and exposes admin controls (register voters, finalize
 * registration, ZK setup & deploy, complete vote, add admin).
 */
import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import axios from '../../api/axios';
import Modal from '../../components/Modal';
import { auth } from '../../firebase';
import type { Election } from '../../types/domain';
import { errorCode, errorData, errorMessage } from '../../utils/errors';

const pageStyle: CSSProperties = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '1000px', margin: 'auto' };
const headerStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap' };
const headerTitleStyle: CSSProperties = { fontSize: '2em', fontWeight: 'bold' };
const headerActionsStyle: CSSProperties = { display: 'flex', gap: '10px' };
const sectionStyle: CSSProperties = { border: '1px solid #ccc', borderRadius: '8px', padding: '20px', marginBottom: '30px', backgroundColor: '#f9f9f9' };
const sectionTitleStyle: CSSProperties = { fontSize: '1.5em', borderBottom: '2px solid #eee', paddingBottom: '10px' };
const buttonStyle: CSSProperties = { padding: '8px 12px', border: 'none', borderRadius: '4px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', marginRight: '10px', transition: 'background-color 0.2s ease' };
const disabledButtonStyle: CSSProperties = { ...buttonStyle, backgroundColor: '#aaa', cursor: 'not-allowed' };
const listStyle: CSSProperties = { listStyleType: 'none', padding: '0' };
const listItemStyle: CSSProperties = { borderBottom: '1px solid #eee', padding: '15px 10px' };
const itemHeaderStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' };
const itemTitleStyle: CSSProperties = { fontWeight: 'bold', fontSize: '1.1em' };
const itemActionsStyle: CSSProperties = { display: 'flex', gap: '10px', flexWrap: 'wrap' };
const itemDetailsStyle: CSSProperties = { marginTop: '10px', color: '#555', fontSize: '0.9em', lineHeight: '1.6' };
const codeStyle: CSSProperties = { backgroundColor: '#f4f4f4', padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace' };

interface ActionLoading {
  isLoadingScript: string | null;
  isFinalizing: string | null;
  isCompleting: string | null;
  isRegistering: boolean;
  isAddingAdmin: boolean;
}

type RenderActions = (vote: Election, isLoading: boolean) => ReactNode;
type RenderDetails = (vote: Election) => ReactNode;

function AdminMainPage() {
  const [isLoadingPage, setIsLoadingPage] = useState(true);

  const [registerableVotes, setRegisterableVotes] = useState<Election[]>([]);
  const [votableVotes, setVotableVotes] = useState<Election[]>([]);
  const [completedVotes, setCompletedVotes] = useState<Election[]>([]);

  const [actionLoading, setActionLoading] = useState<ActionLoading>({
    isLoadingScript: null,
    isFinalizing: null,
    isCompleting: null,
    isRegistering: false,
    isAddingAdmin: false,
  });

  const [isVoterModalOpen, setIsVoterModalOpen] = useState(false);
  const [isFinalizeModalOpen, setIsFinalizeModalOpen] = useState(false);

  const [selectedVote, setSelectedVote] = useState<Election | null>(null);
  const [finalizingVote, setFinalizingVote] = useState<Election | null>(null);
  const [voters, setVoters] = useState('');
  const [voteEndTime, setVoteEndTime] = useState('');

  const navigate = useNavigate();

  const fetchAllVotes = useCallback(async () => {
    setIsLoadingPage(true);
    try {
      const [regResponse, votableResponse, completedResponse] = await Promise.all([
        axios.get<Election[]>('/elections/registerable'),
        axios.get<Election[]>('/elections/finalized'),
        axios.get<Election[]>('/elections/completed'),
      ]);
      setRegisterableVotes(Array.isArray(regResponse.data) ? regResponse.data : []);
      setVotableVotes(Array.isArray(votableResponse.data) ? votableResponse.data : []);
      setCompletedVotes(Array.isArray(completedResponse.data) ? completedResponse.data : []);
    } catch (error) {
      console.error('투표 목록 조회 오류:', errorData(error));
      alert('투표 목록을 불러오는 데 실패했습니다.');
    } finally {
      setIsLoadingPage(false);
    }
  }, []);

  useEffect(() => {
    fetchAllVotes();
  }, [fetchAllVotes]);

  const openVoterRegistrationModal = (vote: Election) => {
    setSelectedVote(vote);
    setVoters('');
    setIsVoterModalOpen(true);
  };

  const openFinalizeModal = (vote: Election) => {
    setFinalizingVote(vote);
    setVoteEndTime('');
    setIsFinalizeModalOpen(true);
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('로그아웃 중 오류 발생:', errorData(error));
      alert('로그아웃에 실패했습니다.');
    }
  };

  const handleAddAdmin = async () => {
    const adminEmail = prompt('추가할 관리자의 이메일을 입력하세요:');
    if (!adminEmail || adminEmail.trim() === '') {
      return;
    }
    const trimmedEmail = adminEmail.trim();

    setActionLoading((prev) => ({ ...prev, isAddingAdmin: true }));
    try {
      await axios.post('/management/addAdmins', { email: trimmedEmail });
      alert(`${trimmedEmail} 관리자가 추가되었습니다.`);
    } catch (error) {
      console.error('관리자 추가 실패:', errorData(error));
      alert(`관리자 추가 실패: ${errorMessage(error)}`);
    } finally {
      setActionLoading((prev) => ({ ...prev, isAddingAdmin: false }));
    }
  };

  const handleRegisterVoters = async () => {
    if (!selectedVote) return;
    const voterList = voters.split(/[\n, ]+/).filter((v) => v.trim() !== '');
    if (voterList.length === 0) {
      alert('등록할 유권자 이메일을 입력해주세요.');
      return;
    }

    setActionLoading((prev) => ({ ...prev, isRegistering: true }));
    try {
      await axios.post(`/elections/${selectedVote.id}/voters`, { emails: voterList });
      alert(`'${selectedVote.name}'에 유권자 ${voterList.length}명이 등록되었습니다.`);
      setIsVoterModalOpen(false);
    } catch (error) {
      console.error('유권자 등록 실패:', errorData(error));
      alert(`유권자 등록 실패: ${errorMessage(error)}`);
    } finally {
      setActionLoading((prev) => ({ ...prev, isRegistering: false }));
    }
  };

  const handleConfirmFinalize = async () => {
    if (!finalizingVote) return;
    if (!voteEndTime) {
      alert('투표 종료 시간을 선택해주세요.');
      return;
    }

    const onSuccess = () => {
      alert('등록이 마감되었으며 투표가 시작되었습니다.');
      setIsFinalizeModalOpen(false);
      fetchAllVotes();
    };
    const submitFinalize = (confirmExtendedDuration: boolean) =>
      axios.post(`/elections/${finalizingVote.id}/finalize`, {
        voteEndTime: new Date(voteEndTime).toISOString(),
        ...(confirmExtendedDuration ? { confirmExtendedDuration: true } : {}),
      });

    setActionLoading((prev) => ({ ...prev, isFinalizing: finalizingVote.id }));
    try {
      await submitFinalize(false);
      onSuccess();
    } catch (error) {
      // L-fe-confirm (AR-M7): the backend caps the voting window because it is
      // immutable on-chain, and asks for explicit confirmation to exceed it.
      // Surface that as a prompt + retry instead of a dead-end error.
      if (
        errorCode(error) === 'VOTING_DURATION_EXCEEDS_MAXIMUM' &&
        window.confirm(
          '선택한 투표 기간이 최대 허용 기간을 초과합니다. 투표 기간은 온체인에 고정되어 변경할 수 없습니다. 그래도 진행하시겠습니까?',
        )
      ) {
        try {
          await submitFinalize(true);
          onSuccess();
        } catch (retryError) {
          console.error('등록 마감 실패:', errorData(retryError));
          alert(`등록 마감 실패: ${errorMessage(retryError)}`);
        }
      } else {
        console.error('등록 마감 실패:', errorData(error));
        alert(`등록 마감 실패: ${errorMessage(error)}`);
      }
    } finally {
      setActionLoading((prev) => ({ ...prev, isFinalizing: null }));
    }
  };

  const handleSetupAndDeploy = async (voteId: string, voteName: string) => {
    if (!window.confirm(`'${voteName}' 투표의 ZKP 설정 및 배포를 시작하시겠습니까?\n이 작업은 몇 분 정도 소요될 수 있습니다.`)) return;

    setActionLoading((prev) => ({ ...prev, isLoadingScript: voteId }));
    try {
      const response = await axios.post<{ message?: string }>(`/elections/${voteId}/setZkDeploy`);
      alert(`'${voteName}' 투표 설정 및 배포 완료: ${response.data.message ?? ''}`);
      fetchAllVotes();
    } catch (error) {
      console.error('스크립트 실행 실패:', errorData(error));
      alert(`스크립트 실행 실패: ${errorMessage(error) || '서버 로그를 확인하세요.'}`);
    } finally {
      setActionLoading((prev) => ({ ...prev, isLoadingScript: null }));
    }
  };

  const handleCompleteVote = async (voteId: string, voteName: string) => {
    if (!window.confirm(`'${voteName}' 투표를 최종적으로 종료하시겠습니까?\n이 작업 후에는 더 이상 해당 투표를 관리할 수 없습니다.`)) return;

    setActionLoading((prev) => ({ ...prev, isCompleting: voteId }));
    try {
      await axios.post(`/elections/${voteId}/complete`);
      alert('투표가 성공적으로 종료되었습니다.');
      fetchAllVotes();
    } catch (error) {
      console.error('투표 종료 실패:', errorData(error));
      alert(`투표 종료 실패: ${errorMessage(error)}`);
    } finally {
      setActionLoading((prev) => ({ ...prev, isCompleting: null }));
    }
  };

  const renderVoteSection = (
    title: string,
    votes: Election[],
    renderActions: RenderActions,
    renderDetails: RenderDetails | null = null,
  ) => {
    const hasData = votes && votes.length > 0;

    return (
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>{title}</h2>
        <ul style={listStyle}>
          {!hasData && <p>해당하는 투표가 없습니다.</p>}
          {hasData &&
            votes.map((vote) => {
              const isLoading =
                actionLoading.isLoadingScript === vote.id ||
                actionLoading.isFinalizing === vote.id ||
                actionLoading.isCompleting === vote.id;

              return (
                <li key={vote.id} style={listItemStyle}>
                  <div style={itemHeaderStyle}>
                    <span style={itemTitleStyle}>{vote.name} (ID: {vote.id})</span>
                    <div style={itemActionsStyle}>{renderActions(vote, isLoading)}</div>
                  </div>
                  <div style={itemDetailsStyle}>
                    <strong>후보자:</strong> {vote.candidates ? vote.candidates.join(', ') : '정보 없음'}
                    <br />
                    {renderDetails && renderDetails(vote)}
                  </div>
                </li>
              );
            })}
        </ul>
      </section>
    );
  };

  if (isLoadingPage) {
    return (
      <div style={pageStyle}>
        <header style={headerStyle}>
          <h1 style={headerTitleStyle}>관리자 대시보드</h1>
        </header>
        <p>데이터를 불러오는 중...</p>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1 style={headerTitleStyle}>관리자 대시보드</h1>
        <div style={headerActionsStyle}>
          <button style={actionLoading.isAddingAdmin ? disabledButtonStyle : buttonStyle} onClick={handleAddAdmin} disabled={actionLoading.isAddingAdmin}>
            {actionLoading.isAddingAdmin ? '추가 중...' : '관리자 추가'}
          </button>
          <button style={buttonStyle} onClick={() => navigate('/admin/create')}>투표 생성</button>
          <button style={{ ...buttonStyle, backgroundColor: '#6c757d' }} onClick={handleLogout}>로그아웃</button>
        </div>
      </header>

      {/* Section 1: Registerable */}
      {renderVoteSection(
        '유권자 등록 중인 투표',
        registerableVotes,
        (vote, isLoading) => (
          <>
            <button style={isLoading ? disabledButtonStyle : buttonStyle} onClick={() => openVoterRegistrationModal(vote)} disabled={isLoading}>
              유권자 등록
            </button>
            <button style={isLoading ? disabledButtonStyle : { ...buttonStyle, backgroundColor: '#28a745' }} onClick={() => openFinalizeModal(vote)} disabled={isLoading}>
              {actionLoading.isFinalizing === vote.id ? '마감 처리 중...' : '등록 마감'}
            </button>
            {vote.contract_address ? (
              <button style={disabledButtonStyle} disabled>ZK 설정 완료</button>
            ) : (
              <button
                style={isLoading ? disabledButtonStyle : { ...buttonStyle, backgroundColor: '#ffc107', color: 'black' }}
                onClick={() => handleSetupAndDeploy(vote.id, vote.name)}
                disabled={isLoading}
              >
                {actionLoading.isLoadingScript === vote.id ? '설정/배포 중...' : 'ZK 설정 & 배포'}
              </button>
            )}
          </>
        ),
        (vote) => (
          <>
            <strong>등록 마감일:</strong> {vote.registration_end_time ? new Date(vote.registration_end_time).toLocaleString() : '정보 없음'}
          </>
        ),
      )}

      {/* Section 2: Votable */}
      {renderVoteSection(
        '투표 진행 중',
        votableVotes,
        (vote, isLoading) => (
          <>
            <span style={{ color: '#007bff', fontWeight: 'bold' }}>
              등록률: {vote.registered_voters || 0} / {vote.total_voters || 0}
            </span>
            <button style={isLoading ? disabledButtonStyle : { ...buttonStyle, backgroundColor: '#dc3545' }} onClick={() => handleCompleteVote(vote.id, vote.name)} disabled={isLoading}>
              {actionLoading.isCompleting === vote.id ? '종료 중...' : '투표 종료'}
            </button>
          </>
        ),
        (vote) => (
          <>
            <strong>투표 마감일:</strong> {vote.voting_end_time ? new Date(vote.voting_end_time).toLocaleString() : '정보 없음'}
            <br />
            <strong>컨트랙트 주소:</strong> <code style={codeStyle}>{vote.contract_address || '배포 전'}</code>
          </>
        ),
      )}

      {/* Section 3: Completed */}
      {renderVoteSection(
        '종료된 투표',
        completedVotes,
        (vote) => (
          <>
            {vote.contract_address && (
              <a href={`https://sepolia.etherscan.io/address/${vote.contract_address}`} target="_blank" rel="noopener noreferrer">
                <button style={{ ...buttonStyle, backgroundColor: '#6c757d' }}>컨트랙트 보기</button>
              </a>
            )}
            <span style={{ color: '#6c757d', marginLeft: '15px' }}>종료됨</span>
          </>
        ),
        (vote) => (
          <>
            <strong>최종 마감일:</strong> {vote.voting_end_time ? new Date(vote.voting_end_time).toLocaleString() : '정보 없음'}
          </>
        ),
      )}

      {/* Modals */}
      <Modal isOpen={isVoterModalOpen} onClose={() => setIsVoterModalOpen(false)}>
        {selectedVote && (
          <div>
            <h3>'{selectedVote.name}' 유권자 등록</h3>
            <p>등록할 유권자 이메일을 쉼표(,), 공백, 또는 줄바꿈으로 구분하여 입력하세요.</p>
            <textarea style={{ width: '98%', height: '150px' }} value={voters} onChange={(e) => setVoters(e.target.value)} placeholder="test1@example.com, test2@example.com" />
            <div style={{ marginTop: '20px', textAlign: 'right' }}>
              <button style={actionLoading.isRegistering ? disabledButtonStyle : { ...buttonStyle, backgroundColor: '#6c757d' }} onClick={() => setIsVoterModalOpen(false)} disabled={actionLoading.isRegistering}>
                취소
              </button>
              <button style={actionLoading.isRegistering ? disabledButtonStyle : buttonStyle} onClick={handleRegisterVoters} disabled={actionLoading.isRegistering}>
                {actionLoading.isRegistering ? '등록 중...' : '등록 실행'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={isFinalizeModalOpen} onClose={() => setIsFinalizeModalOpen(false)}>
        {finalizingVote && (
          <div>
            <h3>'{finalizingVote.name}' 등록 마감</h3>
            <p>투표 종료 시간을 설정해주세요. (이 작업은 되돌릴 수 없습니다.)</p>
            <input type="datetime-local" value={voteEndTime} onChange={(e) => setVoteEndTime(e.target.value)} style={{ width: '95%' }} />
            <div style={{ marginTop: '20px', textAlign: 'right' }}>
              <button style={{ ...buttonStyle, backgroundColor: '#6c757d' }} onClick={() => setIsFinalizeModalOpen(false)}>취소</button>
              <button style={{ ...buttonStyle, backgroundColor: '#28a745' }} onClick={handleConfirmFinalize}>마감 및 투표 시작</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default AdminMainPage;
