// frontend/src/pages/admin/AdminMainPage.js
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../../api/axios';

// --- 스타일 정의 ---
const pageStyle = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '900px', margin: 'auto' };
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' };
const sectionStyle = { border: '1px solid #ccc', borderRadius: '8px', padding: '20px', marginBottom: '20px' };
const buttonStyle = { padding: '8px 12px', border: 'none', borderRadius: '4px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', marginRight: '10px' };
const dangerButtonStyle = { ...buttonStyle, backgroundColor: '#dc3545' };
const listStyle = { listStyleType: 'none', padding: '0' };
const listItemStyle = { borderBottom: '1px solid #eee', padding: '15px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' };

function AdminMainPage() {
  const [votes, setVotes] = useState([]);
  const [selectedVote, setSelectedVote] = useState(null);
  const [voters, setVoters] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    fetchVotes();
  }, []);

  const fetchVotes = async () => {
    try {
      // 관리자 계정으로 요청하므로 모든 등록 가능 투표를 가져옵니다.
      const response = await axios.get('/registerableVote');
      setVotes(response.data);
    } catch (error) {
      console.error('투표 목록 조회 오류:', error);
      alert('투표 목록을 불러오는 데 실패했습니다.');
    }
  };

  // --- API 호출 핸들러 ---
  const handleRegisterVoters = async () => { /* ... 이전과 동일 ... */ };
  const handleFinalizeVote = async (voteId) => { /* ... 이전과 동일 ... */ };
  const handleAddAdmin = async () => {
    const adminEmail = prompt("추가할 관리자의 이메일을 입력하세요:");
    if (adminEmail) {
      try {
        await axios.post('/addAdmins', { emails: [adminEmail] });
        alert(`${adminEmail} 관리자가 추가되었습니다.`);
      } catch (error) {
        alert(`관리자 추가 실패: ${error.response?.data?.message || error.message}`);
      }
    }
  };


  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1>관리자 대시보드</h1>
        <div>
          {/* 5. 관리자 추가 및 투표 생성 버튼 */}
          <button style={buttonStyle} onClick={handleAddAdmin}>관리자 추가</button>
          <button style={buttonStyle} onClick={() => navigate('/admin/create')}>투표 생성</button>
        </div>
      </header>

      {/* 3. 등록 가능한 투표 목록 */}
      <section style={sectionStyle}>
        <h2>진행중인 투표 관리</h2>
        <ul style={listStyle}>
          {votes.map(vote => (
            <li key={vote.id} style={listItemStyle}>
              <span>{vote.title || `투표 ID: ${vote.id}`}</span>
              {/* 4. 투표별 액션 버튼 */}
              <div>
                <button style={buttonStyle} onClick={() => setSelectedVote(vote)}>유권자 등록</button>
                <button style={dangerButtonStyle} onClick={() => handleFinalizeVote(vote.id)}>등록 마감</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* 유권자 등록 모달 (기존과 유사) */}
      {selectedVote && (
        <section style={sectionStyle}>
          <h3>'{selectedVote.title}' 유권자 등록</h3>
          <textarea style={{ width: '98%', height: '100px' }} value={voters} onChange={(e) => setVoters(e.target.value)} placeholder='이메일 입력...'/>
          <button style={buttonStyle} onClick={handleRegisterVoters}>등록 실행</button>
          <button style={{...buttonStyle, backgroundColor: '#6c757d'}} onClick={() => setSelectedVote(null)}>취소</button>
        </section>
      )}
    </div>
  );
}

// 핸들러 함수들의 전체 코드를 포함합니다.
AdminMainPage.prototype.handleRegisterVoters = async function() {
    if (!this.state.selectedVote) return alert('투표를 선택해주세요.');
    const voterList = this.state.voters.split(/[\n, ]+/).filter(v => v.trim() !== '');
    if (voterList.length === 0) return alert('등록할 유권자 이메일을 입력해주세요.');
    try {
      await axios.post('/registerByAdmin', { voteId: this.state.selectedVote.id, voters: voterList });
      alert(`${this.state.selectedVote.title}에 ${voterList.length}명의 유권자가 등록되었습니다.`);
      this.setState({ voters: '', selectedVote: null });
    } catch (error) {
      alert(`유권자 등록 실패: ${error.response?.data?.message || error.message}`);
    }
};
AdminMainPage.prototype.handleFinalizeVote = async function(voteId) {
    if (!window.confirm('정말로 이 투표를 마감하시겠습니까?')) return;
    try {
      await axios.post('/finalizeVote', { voteId });
      alert('투표가 성공적으로 마감되었습니다.');
      this.fetchVotes();
    } catch (error) {
      alert(`투표 마감 실패: ${error.response?.data?.message || error.message}`);
    }
};

export default AdminMainPage;