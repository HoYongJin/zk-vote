// frontend/src/pages/VoterMainPage.js
import React, { useState, useEffect, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../../supabase';
import axios from '../../api/axios';

// --- 스타일 정의 ---
const pageStyle = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '800px', margin: 'auto' };
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' };
const sectionStyle = { border: '1px solid #ccc', borderRadius: '8px', padding: '20px', marginBottom: '30px' };
const buttonStyle = { padding: '8px 12px', border: 'none', borderRadius: '4px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer' };
const listStyle = { listStyleType: 'none', padding: '0' };
const listItemStyle = { borderBottom: '1px solid #eee', padding: '15px 10px' };
const itemHeaderStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const itemTitleStyle = { fontWeight: 'bold', fontSize: '1.1em' };
const itemDetailsStyle = { marginTop: '10px', color: '#555', fontSize: '0.9em' };

function VoterMainPage() {
  const auth = useSelector((state) => state.auth);
  const navigate = useNavigate();

  const [registerableVotes, setRegisterableVotes] = useState([]);
  const [votableVotes, setVotableVotes] = useState([]);
  const [completedVotes, setCompletedVotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [registeringId, setRegisteringId] = useState(null);

  const fetchAllVotesForVoter = useCallback(async () => {
    if (auth.isLoggedIn) {
      setLoading(true);
      try {
        const [regResponse, votableResponse, completedResponse] = await Promise.all([
          axios.get('/elections/registerable'),
          axios.get('/elections/finalized'),
          axios.get('/elections/completed')
        ]);
        setRegisterableVotes(Array.isArray(regResponse.data) ? regResponse.data : []);
        setVotableVotes(Array.isArray(votableResponse.data) ? votableResponse.data : []);
        setCompletedVotes(Array.isArray(completedResponse.data) ? completedResponse.data : []);
      } catch (error) {
        console.error('투표 목록 조회 오류:', error);
      } finally {
        setLoading(false);
      }
    }
  }, [auth.isLoggedIn]);

  useEffect(() => {
    fetchAllVotesForVoter();
  }, [fetchAllVotesForVoter]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const handleRegister = async (electionId, electionName) => {
    const name = window.prompt(`'${electionName}' 투표에 등록할 이름을 입력해주세요.`);
    if (!name || name.trim() === '') {
      alert("이름이 입력되지 않아 등록을 취소합니다.");
      return;
    }

    setRegisteringId(electionId);
    try {
      await axios.post(`/elections/${electionId}/register`, { name: name.trim() });
      alert(`'${electionName}' 투표에 '${name}' 이름으로 성공적으로 등록되었습니다.`);
      fetchAllVotesForVoter();
    } catch (error) {
      alert(`등록 실패: ${error.response?.data?.details || '오류가 발생했습니다.'}`);
    } finally {
      setRegisteringId(null);
    }
  };

  // 'votableVotes' 목록에 있는 ID들을 Set으로 만들어 빠른 조회를 가능하게 합니다.
  //const votableVoteIds = new Set(votableVotes.map(v => v.id));

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1>ZK-VOTE</h1>
        {auth.isLoggedIn && (
          <div>
            <span>{auth.user.email}</span>
            {auth.isAdmin && <Link to="/admin" style={{ marginLeft: '10px' }}><button>관리자 페이지</button></Link>}
            <button onClick={handleLogout} style={{ marginLeft: '10px' }}>로그아웃</button>
          </div>
        )}
      </header>
      <hr />

      {loading ? <p>투표 목록을 불러오는 중...</p> : (
        <>
          <section style={sectionStyle}>
            <h2>투표 진행 중</h2>
            <ul style={listStyle}>
              {votableVotes.map((vote) => (
                <li key={vote.id} style={listItemStyle}>
                  <div style={itemHeaderStyle}>
                    <span style={itemTitleStyle}>{vote.name}</span>
                    <button style={buttonStyle} onClick={() => navigate(`/vote/${vote.id}`, { state: { vote } })}>
                      투표하기
                    </button>
                  </div>
                  <div style={itemDetailsStyle}>
                    투표 마감일: {new Date(vote.voting_end_time).toLocaleString()}
                  </div>
                </li>
              ))}
              {votableVotes.length === 0 && <p>현재 진행중인 투표가 없습니다.</p>}
            </ul>
          </section>

          {/* <section style={sectionStyle}>
            <h2>유권자 등록 가능한 투표</h2>
            <ul style={listStyle}>
              {registerableVotes.map((vote) => {
                // 이 투표가 이미 '투표 가능' 목록에 있는지 확인합니다.
                const isRegistered = votableVoteIds.has(vote.id);

                return (
                  <li key={vote.id} style={listItemStyle}>
                    <div style={itemHeaderStyle}>
                      <span style={itemTitleStyle}>{vote.name}</span>
                      {isRegistered ? (
                        <button style={{...buttonStyle, backgroundColor: '#28a745', cursor: 'default'}} disabled>
                          등록 완료
                        </button>
                      ) : (
                        <button
                          style={{...buttonStyle, backgroundColor: '#17a2b8'}}
                          onClick={() => handleRegister(vote.id, vote.name)}
                          disabled={registeringId === vote.id}
                        >
                          {registeringId === vote.id ? '등록 중...' : '등록하기'}
                        </button>
                      )}
                    </div>
                    <div style={itemDetailsStyle}>
                      등록 마감일: {new Date(vote.registration_end_time).toLocaleString()}
                    </div>
                  </li>
                );
              })}
              {registerableVotes.length === 0 && <p>등록 가능한 투표가 없습니다.</p>}
            </ul>
          </section> */}
          <section style={sectionStyle}>
            <h2>유권자 등록 가능한 투표</h2>
            <ul style={listStyle}>
              {registerableVotes.map((vote) => (
                  <li key={vote.id} style={listItemStyle}>
                    <div style={itemHeaderStyle}>
                      <span style={itemTitleStyle}>{vote.name}</span>

                      {/* 👇 여기가 수정된 핵심 로직입니다! 👇 */}
                      {vote.isRegistered ? (
                        // API가 isRegistered: true를 보내준 경우
                        <button style={{...buttonStyle, backgroundColor: '#28a745', cursor: 'default'}} disabled>
                          등록 완료
                        </button>
                      ) : (
                        // API가 isRegistered: false를 보내준 경우
                        <button
                          style={{...buttonStyle, backgroundColor: '#17a2b8'}}
                          onClick={() => handleRegister(vote.id, vote.name)}
                          disabled={registeringId === vote.id}
                        >
                          {registeringId === vote.id ? '등록 중...' : '등록하기'}
                        </button>
                      )}
                    </div>
                    <div style={itemDetailsStyle}>
                      등록 마감일: {new Date(vote.registration_end_time).toLocaleString()}
                    </div>
                  </li>
              ))}
              {registerableVotes.length === 0 && <p>등록 가능한 투표가 없습니다.</p>}
            </ul>
          </section>
          <section style={sectionStyle}>
                        <h2>참여했던 투표</h2>
                        <ul style={listStyle}>
                            {completedVotes.map((vote) => (
                                <li key={vote.id} style={listItemStyle}>
                                    <div style={itemHeaderStyle}>
                                        <span style={itemTitleStyle}>{vote.name}</span>
                                        <div>
                                            {/* 👇 '컨트랙트' 버튼 추가 👇 */}
                                            {vote.contract_address && (
                                                <a 
                                                    href={`https://sepolia.etherscan.io/address/${vote.contract_address}`} 
                                                    target="_blank" 
                                                    rel="noopener noreferrer"
                                                >
                                                    <button style={{...buttonStyle, backgroundColor: '#6c757d'}}>컨트랙트 보기</button>
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