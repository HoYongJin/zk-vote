// frontend/src/pages/admin/ManageVotesPage.js
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from '../../api/axios';

// --- 간단한 스타일 정의 ---
const pageStyle = { fontFamily: 'sans-serif', padding: '20px' };
const sectionStyle = { border: '1px solid #ccc', borderRadius: '8px', padding: '20px', marginBottom: '20px' };
const inputStyle = { width: '95%', padding: '8px', marginBottom: '10px', border: '1px solid #ccc', borderRadius: '4px' };
const buttonStyle = { padding: '10px 15px', border: 'none', borderRadius: '4px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', marginRight: '10px' };
const dangerButtonStyle = { ...buttonStyle, backgroundColor: '#dc3545' };
const listStyle = { listStyleType: 'none', padding: '0' };
const listItemStyle = { borderBottom: '1px solid #eee', padding: '10px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' };

function ManageVotesPage() {
  const [votes, setVotes] = useState([]);
  const [selectedVote, setSelectedVote] = useState(null);
  const [voters, setVoters] = useState('');

  useEffect(() => {
    fetchVotes();
  }, []);

  const fetchVotes = async () => {
    try {
      const response = await axios.get('/registerableVote');
      setVotes(response.data);
    } catch (error) {
      console.error('투표 목록 조회 오류:', error);
    }
  };

  const handleRegisterVoters = async () => {
    if (!selectedVote) return alert('투표를 선택해주세요.');
    const voterList = voters.split(/[\n, ]+/).filter(v => v.trim() !== '');
    if (voterList.length === 0) return alert('등록할 유권자 이메일을 입력해주세요.');
    try {
      await axios.post('/registerByAdmin', { voteId: selectedVote.id, voters: voterList });
      alert(`${selectedVote.title}에 ${voterList.length}명의 유권자가 등록되었습니다.`);
      setVoters('');
      setSelectedVote(null); // 작업 완료 후 선택 해제
    } catch (error) {
      alert(`유권자 등록 실패: ${error.response?.data?.message || error.message}`);
    }
  };

  const handleFinalizeVote = async (voteId) => {
    if (!window.confirm('정말로 이 투표를 마감하시겠습니까?')) return;
    try {
      await axios.post('/finalizeVote', { voteId });
      alert('투표가 성공적으로 마감되었습니다.');
      fetchVotes(); // 목록 새로고침
      setSelectedVote(null);
    } catch (error) {
      alert(`투표 마감 실패: ${error.response?.data?.message || error.message}`);
    }
  };

  return (
    <div style={pageStyle}>
      <Link to="/admin">← 관리자 대시보드로 돌아가기</Link>
      <h2>기존 투표 관리</h2>

      <section style={sectionStyle}>
        <h3>투표 목록</h3>
        <ul style={listStyle}>
          {votes.map(vote => (
            <li key={vote.id} style={listItemStyle}>
              <span>{vote.title} ({vote.isFinalized ? '마감됨' : '진행중'})</span>
              <div>
                {!vote.isFinalized && (
                  <>
                    <button style={buttonStyle} onClick={() => setSelectedVote(vote)}>유권자 등록</button>
                    <button style={dangerButtonStyle} onClick={() => handleFinalizeVote(vote.id)}>투표 마감</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {selectedVote && (
        <section style={sectionStyle}>
          <h3>'{selectedVote.title}' 유권자 등록</h3>
          <p>등록할 유권자 이메일을 쉼표(,), 공백, 또는 줄바꿈으로 구분하여 입력하세요.</p>
          <textarea
            style={{ ...inputStyle, height: '100px', width: '98%'}}
            value={voters}
            onChange={(e) => setVoters(e.target.value)}
            placeholder='test1@example.com, test2@example.com'
          />
          <button style={buttonStyle} onClick={handleRegisterVoters}>등록 실행</button>
          <button style={{...buttonStyle, backgroundColor: '#6c757d'}} onClick={() => setSelectedVote(null)}>취소</button>
        </section>
      )}
    </div>
  );
}

export default ManageVotesPage;