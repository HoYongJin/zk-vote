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
  const [isFinalizeModalOpen, setIsFinalizeModalOpen] = useState(false);
  const [finalizingVote, setFinalizingVote] = useState(null); // 마감할 투표 정보를 임시 저장
  const [voteEndTime, setVoteEndTime] = useState(''); // 투표 종료 시간 입력값
  const [isLoadingScript, setIsLoadingScript] = useState(null);

  // This function will be used to refresh the lists
  const fetchAllVotes = async () => {
    try {
      const [regResponse, votableResponse] = await Promise.all([
        axios.get('/elections/registerable'),
        axios.get('/elections/finalized')
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

  const openFinalizeModal = (vote) => {
    setFinalizingVote(vote); // 어떤 투표를 마감할지 저장
    setVoteEndTime(''); // 입력 필드 초기화
    setIsFinalizeModalOpen(true); // 모달 열기
  };

  const handleRegisterVoters = async () => {
    if (!selectedVote) return alert('투표를 선택해주세요.');
    const voterList = voters.split(/[\n, ]+/).filter(v => v.trim() !== '');
    if (voterList.length === 0) return alert('등록할 유권자 이메일을 입력해주세요.');
    try {
        // 👇 경로 변경: 동적으로 election_id를 주입
        await axios.post(`/elections/${selectedVote.id}/voters`, { emails: voterList });
        alert(`'${selectedVote.name}'에 ${voterList.length}명의 유권자가 성공적으로 등록되었습니다.`);
        setIsModalOpen(false);
      } catch (error) {
        alert(`유권자 등록 실패: ${error.response?.data?.message || error.message}`);
      }
    };

    const handleFinalizeVote = async () => {
        if (!finalizingVote) return;
        if (!voteEndTime) {
          alert('투표 종료 시간을 선택해주세요.');
          return;
        }
    
        try {
          // API 요청 body에 voteEndTime을 포함하여 전송
          await axios.post(`/elections/${finalizingVote.id}/finalize`, { voteEndTime });
          
          alert(`'${finalizingVote.name}' 투표의 등록이 마감되었습니다.`);
          setIsFinalizeModalOpen(false); // 모달 닫기
          fetchAllVotes(); // 목록 새로고침
        } catch (error) {
          alert(`등록 마감 실패: ${error.response?.data?.message || error.message}`);
        }
      };

      const handleAddAdmin = async () => {
        const adminEmail = prompt("추가할 관리자의 이메일을 입력하세요:");
        if (adminEmail) {
          try {
            // 👇 경로 변경
            await axios.post('/management/addAdmins', { email: adminEmail });
            alert(`${adminEmail} 관리자가 추가되었습니다.`);
          } catch (error) {
            alert(`관리자 추가 실패: ${error.response?.data?.message || error.message}`);
          }
        }
      };

      const handleSetupAndDeploy = async (voteId, voteName) => {
        if (!window.confirm(`'${voteName}' 투표의 ZKP 설정 및 컨트랙트 배포를 시작하시겠습니까?\n\n⚠️ 경고: 이 작업은 서버 CPU를 많이 사용하며 몇 분 이상 소요될 수 있습니다. 완료될 때까지 다른 작업을 수행하지 마세요.`)) {
          return;
        }
        setIsLoadingScript(voteId); // 로딩 시작 (어떤 투표가 로딩중인지 ID로 구분)
        try {
          // 백엔드에 만들어둔 스크립트 실행 API를 호출합니다.
          const response = await axios.post(`/elections/${voteId}/setZkDeploy`);
          alert(`'${voteName}' 투표 설정 및 배포 완료: ${response.data.message}`);
        } catch (error) {
          alert(`스크립트 실행 실패: ${error.response?.data?.message || '서버에 문제가 발생했습니다. 서버 로그를 확인하세요.'}`);
        } finally {
          setIsLoadingScript(null); // 로딩 종료
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
                <button style={{...buttonStyle, backgroundColor: '#28a745'}} onClick={() => openFinalizeModal(vote)}>등록 마감</button>
                <button 
                      style={{...buttonStyle, backgroundColor: '#ffc107', color: 'black'}}
                      onClick={() => handleSetupAndDeploy(vote.id, vote.name)}
                      disabled={isLoadingScript === vote.id} // 로딩 중일 때 비활성화
                    >
                      {isLoadingScript === vote.id ? '처리 중...' : 'ZK 설정 & 배포'}
                    </button>
                </div>
              </div>
              <div style={itemDetailsStyle}>
                <strong>후보자:</strong> {vote.candidates ? vote.candidates.join(', ') : '정보 없음'}<br />
                <strong>등록 마감일:</strong> {vote.registration_end_time ? new Date(vote.registration_end_time).toLocaleString() : '정보 없음'}
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

      <Modal isOpen={isFinalizeModalOpen} onClose={() => setIsFinalizeModalOpen(false)}>
        {finalizingVote && (
          <div>
            <h3>'{finalizingVote.name}' 등록 마감</h3>
            <p>투표 종료 시간을 설정해주세요. 이 시간 이후에는 더 이상 투표할 수 없습니다.</p>
            
            {/* 시간 입력을 위한 최고의 방법: datetime-local input */}
            <input
              type="datetime-local"
              value={voteEndTime}
              onChange={(e) => setVoteEndTime(e.target.value)}
              style={{ width: '95%', padding: '8px', fontSize: '1em' }}
            />

            <div style={{ marginTop: '20px', textAlign: 'right' }}>
              <button style={{...buttonStyle, backgroundColor: '#6c757d'}} onClick={() => setIsFinalizeModalOpen(false)}>취소</button>
              <button style={{...buttonStyle, backgroundColor: '#28a745'}} onClick={handleFinalizeVote}>마감 및 투표 시작</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default AdminMainPage;