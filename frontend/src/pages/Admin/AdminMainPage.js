// frontend/src/pages/admin/AdminMainPage.js
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../../api/axios';
import Modal from '../../components/Modal';

// --- Style Definitions ---
const pageStyle = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '1000px', margin: 'auto' };
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' };
const sectionStyle = { border: '1px solid #ccc', borderRadius: '8px', padding: '20px', marginBottom: '30px' };
const buttonStyle = { padding: '8px 12px', border: 'none', borderRadius: '4px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', marginRight: '10px' };
const listStyle = { listStyleType: 'none', padding: '0' };
const listItemStyle = { borderBottom: '1px solid #eee', padding: '15px 10px' };
const itemHeaderStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center' };
const itemTitleStyle = { fontWeight: 'bold', fontSize: '1.1em' };
const itemDetailsStyle = { marginTop: '10px', color: '#555', fontSize: '0.9em', lineHeight: '1.6' };
// 👇 This was the missing line that caused the error 👇
const codeStyle = { backgroundColor: '#f4f4f4', padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace' };

function AdminMainPage() {
  const [registerableVotes, setRegisterableVotes] = useState([]);
  const [votableVotes, setVotableVotes] = useState([]);
  const [selectedVote, setSelectedVote] = useState(null);
  const [voters, setVoters] = useState('');
  const navigate = useNavigate();
  const [isModalOpen, setIsModalOpen] = useState(false);

  // This function will be used to refresh the lists
  const fetchAllVotes = async () => {
    try {
      const [regResponse, votableResponse] = await Promise.all([
        axios.get('/registerableVote'),
        axios.get('/finalizedVote')
      ]);
      setRegisterableVotes(regResponse.data);
      setVotableVotes(votableResponse.data);
    } catch (error) {
      console.error('투표 목록 조회 오류:', error);
      alert('투표 목록을 불러오는 데 실패했습니다.');
    }
  };

  useEffect(() => {
    fetchAllVotes();
  }, []);

  const openVoterRegistrationModal = (vote) => {
    setSelectedVote(vote);
    setIsModalOpen(true);
  };

  const handleRegisterVoters = async () => {
    if (!selectedVote) return alert('투표를 선택해주세요.');
    const voterList = voters.split(/[\n, ]+/).filter(v => v.trim() !== '');
    if (voterList.length === 0) return alert('등록할 유권자 이메일을 입력해주세요.');
    try {
        // ✅ API 요청 주소 문제 해결: axios 인스턴스는 상대 경로('/registerByAdmin')를 사용해야 합니다.
        await axios.post('/registerByAdmin', { voteId: selectedVote.id, voters: voterList });
        alert(`'${selectedVote.name}'에 ${voterList.length}명의 유권자가 성공적으로 등록되었습니다.`);
        setVoters('');
        setIsModalOpen(false); // 모달 닫기
        setSelectedVote(null);
      } catch (error) {
        alert(`유권자 등록 실패: ${error.response?.data?.message || error.message}`);
      }
    };

    const handleFinalizeVote = async (voteId, voteName) => {
        if (!window.confirm(`'${voteName}' 투표의 유권자 등록을 마감하시겠습니까?`)) return;
        try {
          // ✅ API 요청 주소 문제 해결: axios 인스턴스는 상대 경로('/finalizeVote')를 사용해야 합니다.
          await axios.post('/finalizeVote', { voteId });
          alert('등록이 마감되었습니다.');
          fetchAllVotes();
        } catch (error) {
          alert(`등록 마감 실패: ${error.response?.data?.message || error.message}`);
        }
      };

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
          <button style={buttonStyle} onClick={handleAddAdmin}>관리자 추가</button>
          <button style={buttonStyle} onClick={() => navigate('/admin/create')}>투표 생성</button>
        </div>
      </header>
      
      <section style={sectionStyle}>
        <h2>유권자 등록 중인 투표</h2>
        <ul style={listStyle}>
          {registerableVotes.map(vote => (
            <li key={vote.id} style={listItemStyle}>
              <div style={itemHeaderStyle}>
                <span style={itemTitleStyle}>{vote.name} (ID: {vote.id})</span>
                <div>
                <button style={buttonStyle} onClick={() => openVoterRegistrationModal(vote)}>유권자 등록</button>
                <button style={{...buttonStyle, backgroundColor: '#28a745'}} onClick={() => handleFinalizeVote(vote.id, vote.name)}>등록 마감</button>
                </div>
              </div>
              <div style={itemDetailsStyle}>
                <strong>후보자:</strong> {vote.candidates ? vote.candidates.join(', ') : '정보 없음'}<br />
                <strong>등록 마감일:</strong> {vote.registration_end_time ? new Date(vote.registration_end_time).toLocaleString() : '정보 없음'}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section style={sectionStyle}>
        <h2>투표 진행 중</h2>
        <ul style={listStyle}>
          {votableVotes.map(vote => (
            <li key={vote.id} style={listItemStyle}>
              <div style={itemHeaderStyle}>
                <span style={itemTitleStyle}>{vote.name} (ID: {vote.id})</span>
                <span style={{ color: '#6c757d' }}>투표 진행중</span>
              </div>
              <div style={itemDetailsStyle}>
                <strong>후보자:</strong> {vote.candidates ? vote.candidates.join(', ') : '정보 없음'}<br />
                <strong>투표 마감일:</strong> {vote.voting_end_time ? new Date(vote.voting_end_time).toLocaleString() : '정보 없음'}<br />
                <strong>컨트랙트 주소:</strong> <code style={codeStyle}>{vote.contract_address || '배포 전'}</code>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)}>
      {selectedVote && (
        <section style={sectionStyle}>
          <h3>'{selectedVote.name}' 유권자 등록</h3>
          <p>등록할 유권자 이메일을 쉼표(,), 공백, 또는 줄바꿈으로 구분하여 입력하세요.</p>
          <textarea
            style={{ width: '98%', height: '100px', padding: '8px', fontSize: '1em' }}
            value={voters}
            onChange={(e) => setVoters(e.target.value)}
            placeholder='test1@example.com, test2@example.com'
          />
          <button style={buttonStyle} onClick={handleRegisterVoters}>등록 실행</button>
          <button style={{...buttonStyle, backgroundColor: '#6c757d'}} onClick={() => setIsModalOpen(false)}>취소</button>
        </section>
      )}
      </Modal>
    </div>
  );
}

export default AdminMainPage;