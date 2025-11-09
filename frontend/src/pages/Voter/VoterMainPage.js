/**
 * @file frontend/src/pages/VoterMainPage.js
 * @desc The main dashboard for authenticated voters. Displays lists of elections
 * based on their status (Registerable, Votable, Completed).
 */

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
  
    /**
     * Fetches all three categories of votes (registerable, votable, completed)
     * from the backend API for the currently logged-in user.
     */
    const fetchAllVotesForVoter = useCallback(async () => {
      if (auth.isLoggedIn) {
        setLoading(true);
        try {
          // Use Promise.all to fetch all data concurrently
          const [regResponse, votableResponse, completedResponse] = await Promise.all([
            axios.get('/elections/registerable'), // Fetches elections in registration phase
            axios.get('/elections/finalized'),   // Fetches elections in voting phase
            axios.get('/elections/completed')  // Fetches elections user participated in
          ]);
          
          // Ensure data is always an array
          setRegisterableVotes(Array.isArray(regResponse.data) ? regResponse.data : []);
          setVotableVotes(Array.isArray(votableResponse.data) ? votableResponse.data : []);
          setCompletedVotes(Array.isArray(completedResponse.data) ? completedResponse.data : []);
  
        } catch (error) {
          console.error('Error fetching vote lists:', error);
          // Optionally set an error state here to show to the user
        } finally {
          setLoading(false);
        }
      }
    }, [auth.isLoggedIn]); // Dependency: re-run if login status changes
  
    // Fetch votes when the component mounts or the user logs in
    useEffect(() => {
      fetchAllVotesForVoter();
    }, [fetchAllVotesForVoter]);
  
    /**
     * Handles user logout via Supabase.
     */
    const handleLogout = async () => {
      await supabase.auth.signOut();
      // The App.js AuthHandler will likely catch the auth state change
      // and redirect to /login automatically.
    };
  
    /**
     * Handles the "Register" button click for a specific election.
     * Prompts for a name and submits the registration.
     */
    const handleRegister = async (electionId, electionName) => {
      const name = window.prompt(`'${electionName}' 투표에 등록할 이름을 입력해주세요.`);
      if (!name || name.trim() === '') {
        alert("이름이 입력되지 않아 등록을 취소합니다.");
        return;
      }
  
      setRegisteringId(electionId); // Set loading state for this specific button
      try {
        // Call the register API
        await axios.post(`/elections/${electionId}/register`, { name: name.trim() });
        alert(`'${electionName}' 투표에 '${name}' 이름으로 성공적으로 등록되었습니다.`);
        
        // Refresh all lists to reflect the new state (e.g., isRegistered will be true)
        fetchAllVotesForVoter(); 
      } catch (error) {
        console.error("Registration failed:", error.response?.data);
        alert(`등록 실패: ${error.response?.data?.details || '오류가 발생했습니다.'}`);
      } finally {
        setRegisteringId(null); // Clear loading state for the button
      }
    };
  
  
    return (
      <div style={pageStyle}>
        <header style={headerStyle}>
          <h1>ZK-VOTE</h1>
          {auth.isLoggedIn && (
            <div>
              <span>{auth.user.email}</span>
              {/* Show link to admin page only if user is admin */}
              {auth.isAdmin && <Link to="/admin" style={{ marginLeft: '10px' }}><button>관리자 페이지</button></Link>}
              <button onClick={handleLogout} style={{ marginLeft: '10px' }}>로그아웃</button>
            </div>
          )}
        </header>
        <hr />
  
        {loading ? <p>투표 목록을 불러오는 중...</p> : (
          <>
            {/* --- Section 1: Votable Elections (In-Progress) --- */}
            <section style={sectionStyle}>
              <h2>투표 진행 중</h2>
              <ul style={listStyle}>
                {votableVotes.map((vote) => {
  
                  // --- [MODIFICATION START] ---
                  // Check browser's localStorage to see if this user has already
                  // voted on this *specific browser*.
                  // This is a UX enhancement, as the server (being anonymous)
                  // cannot tell us if the user has voted.
                  const hasVotedOnThisBrowser = localStorage.getItem(`voted_${vote.id}`) === 'true';
                  // --- [MODIFICATION END] ---
  
                  return (
                    <li key={vote.id} style={listItemStyle}>
                      <div style={itemHeaderStyle}>
                        <span style={itemTitleStyle}>{vote.name}</span>
                        
                        {/* --- [MODIFICATION START] --- */}
                        {/* Conditionally render the button based on localStorage flag */}
                        {hasVotedOnThisBrowser ? (
                          <button 
                            style={{...buttonStyle, backgroundColor: '#28a745', cursor: 'default'}} 
                            disabled
                          >
                            투표 완료 (이 브라우저)
                          </button>
                        ) : (
                          <button 
                            style={buttonStyle} 
                            onClick={() => navigate(`/vote/${vote.id}`, { state: { vote } })}
                          >
                            투표하기
                          </button>
                        )}
                        {/* --- [MODIFICATION END] --- */}
  
                      </div>
                      <div style={itemDetailsStyle}>
                        투표 마감일: {new Date(vote.voting_end_time).toLocaleString()}
                      </div>
                    </li>
                  );
                })}
                {votableVotes.length === 0 && <p>현재 진행중인 투표가 없습니다.</p>}
              </ul>
            </section>
  
            {/* --- Section 2: Registerable Elections (Registration Open) --- */}
            <section style={sectionStyle}>
              <h2>유권자 등록 가능한 투표</h2>
              <ul style={listStyle}>
                {registerableVotes.map((vote) => (
                    <li key={vote.id} style={listItemStyle}>
                      <div style={itemHeaderStyle}>
                        <span style={itemTitleStyle}>{vote.name}</span>
  
                        {/* This logic is correct: it relies on the `isRegistered` flag
                            sent from the '/api/elections/registerable' endpoint,
                            which checks the DB (user_id is not null). */}
                        {vote.isRegistered ? (
                          // API reported that user has completed registration (user_id is set)
                          <button style={{...buttonStyle, backgroundColor: '#28a745', cursor: 'default'}} disabled>
                            등록 완료
                          </button>
                        ) : (
                          // API reported user is not yet registered (user_id is null)
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
  
            {/* --- Section 3: Completed Elections (History) --- */}
            <section style={sectionStyle}>
              <h2>참여했던 투표</h2>
              <ul style={listStyle}>
                  {completedVotes.map((vote) => (
                      <li key={vote.id} style={listItemStyle}>
                          <div style={itemHeaderStyle}>
                              <span style={itemTitleStyle}>{vote.name}</span>
                              <div>
                                  {/* Link to Etherscan if contract address exists */}
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