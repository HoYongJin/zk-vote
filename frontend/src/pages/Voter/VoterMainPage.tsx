/**
 * @file frontend/src/pages/Voter/VoterMainPage.tsx
 * @desc Voter dashboard: lists elections by status (votable, registerable,
 * completed) and handles voter registration (client-side secret + commitment).
 */
import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth as firebaseAuth } from '../../firebase';
import axios from '../../api/axios';
import { useAppSelector } from '../../store/hooks';
import type { Election } from '../../types/domain';
import {
  calculateSecretCommitment,
  clearVoterSecret,
  getOrCreateVoterSecret,
  getVoterSecret,
} from '../../utils/voterSecret';
import { errorData, errorMessage } from '../../utils/errors';

const pageStyle: CSSProperties = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '800px', margin: 'auto' };
const headerStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' };
const sectionStyle: CSSProperties = { border: '1px solid #ccc', borderRadius: '8px', padding: '20px', marginBottom: '30px' };
const buttonStyle: CSSProperties = { padding: '8px 12px', border: 'none', borderRadius: '4px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer' };
const listStyle: CSSProperties = { listStyleType: 'none', padding: '0' };
const listItemStyle: CSSProperties = { borderBottom: '1px solid #eee', padding: '15px 10px' };
const itemHeaderStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const itemTitleStyle: CSSProperties = { fontWeight: 'bold', fontSize: '1.1em' };
const itemDetailsStyle: CSSProperties = { marginTop: '10px', color: '#555', fontSize: '0.9em' };

function VoterMainPage() {
  const auth = useAppSelector((state) => state.auth);
  const navigate = useNavigate();

  const [registerableVotes, setRegisterableVotes] = useState<Election[]>([]);
  const [votableVotes, setVotableVotes] = useState<Election[]>([]);
  const [completedVotes, setCompletedVotes] = useState<Election[]>([]);
  const [loading, setLoading] = useState(true);
  const [registeringId, setRegisteringId] = useState<string | null>(null);

  const fetchAllVotesForVoter = useCallback(async () => {
    if (auth.isLoggedIn) {
      setLoading(true);
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
        console.error('Error fetching vote lists:', errorData(error));
      } finally {
        setLoading(false);
      }
    }
  }, [auth.isLoggedIn]);

  useEffect(() => {
    fetchAllVotesForVoter();
  }, [fetchAllVotesForVoter]);

  const handleLogout = async () => {
    await signOut(firebaseAuth);
    // App.tsx AuthHandler (onAuthStateChanged) redirects to /login.
  };

  const handleRegister = async (electionId: string, electionName: string) => {
    const name = window.prompt(`'${electionName}' 투표에 등록할 이름을 입력해주세요.`);
    if (!name || name.trim() === '') {
      alert('이름이 입력되지 않아 등록을 취소합니다.');
      return;
    }

    setRegisteringId(electionId);
    let generatedSecret: string | null = null;
    const hadStoredSecret = !!getVoterSecret(electionId);
    try {
      generatedSecret = getOrCreateVoterSecret(electionId);
      const secretCommitment = await calculateSecretCommitment(generatedSecret);

      await axios.post(`/elections/${electionId}/register`, {
        name: name.trim(),
        secretCommitment,
      });
      alert(`'${electionName}' 투표에 '${name}' 이름으로 성공적으로 등록되었습니다.`);

      fetchAllVotesForVoter();
    } catch (error) {
      if (generatedSecret && !hadStoredSecret) {
        clearVoterSecret(electionId);
      }
      console.error('Registration failed:', errorData(error));
      alert(`등록 실패: ${errorMessage(error)}`);
    } finally {
      setRegisteringId(null);
    }
  };

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1>ZK-VOTE</h1>
        {auth.isLoggedIn && (
          <div>
            <span>{auth.user?.email}</span>
            {auth.isAdmin && (
              <Link to="/admin" style={{ marginLeft: '10px' }}>
                <button>관리자 페이지</button>
              </Link>
            )}
            <button onClick={handleLogout} style={{ marginLeft: '10px' }}>로그아웃</button>
          </div>
        )}
      </header>
      <hr />

      {loading ? (
        <p>투표 목록을 불러오는 중...</p>
      ) : (
        <>
          {/* Votable (in-progress) */}
          <section style={sectionStyle}>
            <h2>투표 진행 중</h2>
            <ul style={listStyle}>
              {votableVotes.map((vote) => {
                // localStorage-only "already voted" hint (the server is anonymous
                // and cannot tell us). UX-only.
                const hasVotedOnThisBrowser = localStorage.getItem(`voted_${vote.id}`) === 'true';

                return (
                  <li key={vote.id} style={listItemStyle}>
                    <div style={itemHeaderStyle}>
                      <span style={itemTitleStyle}>{vote.name}</span>
                      {hasVotedOnThisBrowser ? (
                        <button style={{ ...buttonStyle, backgroundColor: '#28a745', cursor: 'default' }} disabled>
                          투표 완료 (이 브라우저)
                        </button>
                      ) : (
                        <button style={buttonStyle} onClick={() => navigate(`/vote/${vote.id}`, { state: { vote } })}>
                          투표하기
                        </button>
                      )}
                    </div>
                    <div style={itemDetailsStyle}>
                      투표 마감일: {vote.voting_end_time ? new Date(vote.voting_end_time).toLocaleString() : '정보 없음'}
                    </div>
                  </li>
                );
              })}
              {votableVotes.length === 0 && <p>현재 진행중인 투표가 없습니다.</p>}
            </ul>
          </section>

          {/* Registerable (registration open) */}
          <section style={sectionStyle}>
            <h2>유권자 등록 가능한 투표</h2>
            <ul style={listStyle}>
              {registerableVotes.map((vote) => (
                <li key={vote.id} style={listItemStyle}>
                  <div style={itemHeaderStyle}>
                    <span style={itemTitleStyle}>{vote.name}</span>
                    {vote.isRegistered ? (
                      <button style={{ ...buttonStyle, backgroundColor: '#28a745', cursor: 'default' }} disabled>
                        등록 완료
                      </button>
                    ) : (
                      <button
                        style={{ ...buttonStyle, backgroundColor: '#17a2b8' }}
                        onClick={() => handleRegister(vote.id, vote.name)}
                        disabled={registeringId === vote.id}
                      >
                        {registeringId === vote.id ? '등록 중...' : '등록하기'}
                      </button>
                    )}
                  </div>
                  <div style={itemDetailsStyle}>
                    등록 마감일: {vote.registration_end_time ? new Date(vote.registration_end_time).toLocaleString() : '정보 없음'}
                  </div>
                </li>
              ))}
              {registerableVotes.length === 0 && <p>등록 가능한 투표가 없습니다.</p>}
            </ul>
          </section>

          {/* Completed (history) */}
          <section style={sectionStyle}>
            <h2>참여했던 투표</h2>
            <ul style={listStyle}>
              {completedVotes.map((vote) => (
                <li key={vote.id} style={listItemStyle}>
                  <div style={itemHeaderStyle}>
                    <span style={itemTitleStyle}>{vote.name}</span>
                    <div>
                      {vote.contract_address && (
                        <a href={`https://sepolia.etherscan.io/address/${vote.contract_address}`} target="_blank" rel="noopener noreferrer">
                          <button style={{ ...buttonStyle, backgroundColor: '#6c757d' }}>컨트랙트 보기</button>
                        </a>
                      )}
                      <span style={{ color: '#6c757d', marginLeft: '15px' }}>종료됨</span>
                    </div>
                  </div>
                </li>
              ))}
              {completedVotes.length === 0 && <p>참여했던 투표가 없습니다.</p>}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

export default VoterMainPage;
