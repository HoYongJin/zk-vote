// frontend/src/pages/admin/AdminMainPage.js
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../../api/axios';
import Modal from '../../components/Modal';
import { supabase } from '../../supabase';

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
const codeStyle = { backgroundColor: '#f4f4f4', padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace' };

function AdminMainPage() {
    const [registerableVotes, setRegisterableVotes] = useState([]);
    const [votableVotes, setVotableVotes] = useState([]);
    const [selectedVote, setSelectedVote] = useState(null);
    const [voters, setVoters] = useState('');
    const navigate = useNavigate();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isFinalizeModalOpen, setIsFinalizeModalOpen] = useState(false);
    const [finalizingVote, setFinalizingVote] = useState(null);
    const [voteEndTime, setVoteEndTime] = useState('');
    const [isLoadingScript, setIsLoadingScript] = useState(null);
    const [isFinalizing, setIsFinalizing] = useState(null);

    const handleLogout = async () => {
        const { error } = await supabase.auth.signOut();
        if (error) {
            console.error('로그아웃 중 오류 발생:', error);
            alert('로그아웃에 실패했습니다.');
        }
        // 로그아웃 성공 시 App.js의 AuthHandler가 자동으로 /login으로 리디렉션합니다.
    };

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
        }
    };

    useEffect(() => {
        fetchAllVotes();
    }, []);

    const openVoterRegistrationModal = (vote) => {
        setSelectedVote(vote);
        setVoters('');
        setIsModalOpen(true);
    };

    const openFinalizeModal = (vote) => {
        setFinalizingVote(vote);
        setVoteEndTime('');
        setIsFinalizeModalOpen(true);
    };

    const handleRegisterVoters = async () => {
        if (!selectedVote) return;
        const voterList = voters.split(/[\n, ]+/).filter(v => v.trim() !== '');
        if (voterList.length === 0) return alert('등록할 유권자 이메일을 입력해주세요.');
        try {
            await axios.post(`/elections/${selectedVote.id}/voters`, { emails: voterList });
            alert(`'${selectedVote.name}'에 유권자가 등록되었습니다.`);
            setIsModalOpen(false);
        } catch (error) {
            alert(`유권자 등록 실패: ${error.response?.data?.message || error.message}`);
        }
    };

    // '등록 마감' 모달의 확인 버튼과 연결되는 함수
    const handleConfirmFinalize = async () => {
        if (!finalizingVote) return;
        if (!voteEndTime) return alert('투표 종료 시간을 선택해주세요.');
        
        setIsFinalizing(finalizingVote.id);
        try {
            await axios.post(`/elections/${finalizingVote.id}/finalize`, { voteEndTime });
            alert('등록이 마감되었습니다.');
            setIsFinalizeModalOpen(false);
            fetchAllVotes();
        } catch (error) {
            if (error.response?.data?.error?.includes("already known")) {
                alert("트랜잭션이 이미 전송되었습니다.");
            } else {
                alert(`등록 마감 실패: ${error.response?.data?.message || error.message}`);
            }
        } finally {
            setIsFinalizing(null);
        }
    };

    const handleAddAdmin = async () => {
        const adminEmail = prompt("추가할 관리자의 이메일을 입력하세요:");
        if (adminEmail) {
            try {
                await axios.post('/management/addAdmins', { emails: [adminEmail] });
                alert(`${adminEmail} 관리자가 추가되었습니다.`);
            } catch (error) {
                alert(`관리자 추가 실패: ${error.response?.data?.message || error.message}`);
            }
        }
    };

    const handleSetupAndDeploy = async (voteId, voteName) => {
        if (!window.confirm(`'${voteName}' 투표의 ZKP 설정 및 배포를 시작하시겠습니까?`)) return;
        setIsLoadingScript(voteId);
        try {
            const response = await axios.post(`/elections/${voteId}/setZkDeploy`);
            alert(`'${voteName}' 투표 설정 및 배포 완료: ${response.data.message}`);
        } catch (error) {
            alert(`스크립트 실행 실패: ${error.response?.data?.message || '서버 로그를 확인하세요.'}`);
        } finally {
            setIsLoadingScript(null);
        }
    };

    return (
        <div style={pageStyle}>
            <header style={headerStyle}>
                <h1>관리자 대시보드</h1>
                <div>
                    <button style={buttonStyle} onClick={handleAddAdmin}>관리자 추가</button>
                    <button style={buttonStyle} onClick={() => navigate('/admin/create')}>투표 생성</button>
                    <button style={{...buttonStyle, backgroundColor: '#6c757d'}} onClick={handleLogout}>로그아웃</button>
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
                                    {/* <button style={{...buttonStyle, backgroundColor: '#ffc107', color: 'black'}} onClick={() => handleSetupAndDeploy(vote.id, vote.name)} disabled={isLoadingScript === vote.id}>
                                        {isLoadingScript === vote.id ? '처리 중...' : 'ZK 설정 & 배포'}
                                    </button> */}
                                    {vote.contract_address ? (
                                    // contract_address가 있으면 '완료' 버튼을 보여줍니다.
                                    <button 
                                        style={{...buttonStyle, backgroundColor: '#6c757d', cursor: 'not-allowed'}} 
                                        disabled
                                    >
                                        ZK 설정 & 배포 완료
                                    </button>
                                    ) : (
                                    // contract_address가 없으면 기존 '실행' 버튼을 보여줍니다.
                                    <button 
                                        style={{...buttonStyle, backgroundColor: '#ffc107', color: 'black'}}
                                        onClick={() => handleSetupAndDeploy(vote.id, vote.name)}
                                        disabled={isLoadingScript === vote.id}
                                    >
                                        {isLoadingScript === vote.id ? '처리 중...' : 'ZK 설정 & 배포'}
                                    </button>
                                    )}
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
                    <div>
                        <h3>'{selectedVote.name}' 유권자 등록</h3>
                        <p>등록할 유권자 이메일을 쉼표(,), 공백, 또는 줄바꿈으로 구분하여 입력하세요.</p>
                        <textarea style={{ width: '98%', height: '150px' }} value={voters} onChange={(e) => setVoters(e.target.value)} placeholder='test1@example.com, test2@example.com' />
                        <div style={{ marginTop: '20px', textAlign: 'right' }}>
                            <button style={{...buttonStyle, backgroundColor: '#6c757d'}} onClick={() => setIsModalOpen(false)}>취소</button>
                            <button style={buttonStyle} onClick={handleRegisterVoters}>등록 실행</button>
                        </div>
                    </div>
                )}
            </Modal>

            <Modal isOpen={isFinalizeModalOpen} onClose={() => setIsFinalizeModalOpen(false)}>
                {finalizingVote && (
                    <div>
                        <h3>'{finalizingVote.name}' 등록 마감</h3>
                        <p>투표 종료 시간을 설정해주세요.</p>
                        <input type="datetime-local" value={voteEndTime} onChange={(e) => setVoteEndTime(e.target.value)} style={{ width: '95%' }} />
                        <div style={{ marginTop: '20px', textAlign: 'right' }}>
                            <button style={{...buttonStyle, backgroundColor: '#6c757d'}} onClick={() => setIsFinalizeModalOpen(false)}>취소</button>
                            <button style={{...buttonStyle, backgroundColor: '#28a745'}} onClick={handleConfirmFinalize} disabled={isFinalizing === finalizingVote.id}>
                                {isFinalizing === finalizingVote.id ? '처리 중...' : '마감 및 투표 시작'}
                            </button>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
}

export default AdminMainPage;