// /**
//  * @file frontend/src/pages/Admin/ManageVotesPage.js
//  * @desc The main dashboard for administrators to manage all elections.
//  * (This file replaces the older AdminMainPage.js and ManageVotesPage.js logic)
//  *
//  * This component fetches and displays all elections sorted into three categories:
//  * 1. Registerable: Elections in the registration phase.
//  * 2. Votable: Elections currently active for voting.
//  * 3. Completed: Elections that have finished.
//  *
//  * It provides all admin controls:
//  * - Register Voters (Bulk)
//  * - Finalize Registration (Set Merkle Root & Start Vote)
//  * - ZK Setup & Deploy (Run scripts)
//  * - Complete Vote (Mark as finished)
//  * - Add Admin
//  * - Logout
//  */

// import React, { useState, useEffect, useCallback } from 'react';
// import { useNavigate, Link } from 'react-router-dom'; // Added Link
// import axios from '../../api/axios';
// import Modal from '../../components/Modal';
// import { supabase } from '../../supabase';

// // --- [PERFORMANCE] Style Definitions ---
// // Defined outside the component to prevent re-creation on every render.
// const pageStyle = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '1000px', margin: 'auto' };
// const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap' };
// const headerTitleStyle = { fontSize: '2em', fontWeight: 'bold' };
// const headerActionsStyle = { display: 'flex', gap: '10px' };
// const sectionStyle = { border: '1px solid #ccc', borderRadius: '8px', padding: '20px', marginBottom: '30px', backgroundColor: '#f9f9f9' };
// const sectionTitleStyle = { fontSize: '1.5em', borderBottom: '2px solid #eee', paddingBottom: '10px' };
// const buttonStyle = { 
//     padding: '8px 12px', 
//     border: 'none', 
//     borderRadius: '4px', 
//     backgroundColor: '#007bff', 
//     color: 'white', 
//     cursor: 'pointer', 
//     marginRight: '10px',
//     transition: 'background-color 0.2s ease',
//     textDecoration: 'none', // For links styled as buttons
// };
// const disabledButtonStyle = { ...buttonStyle, backgroundColor: '#aaa', cursor: 'not-allowed' };
// const listStyle = { listStyleType: 'none', padding: '0' };
// const listItemStyle = { borderBottom: '1px solid #eee', padding: '15px 10px' };
// const itemHeaderStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' };
// const itemTitleStyle = { fontWeight: 'bold', fontSize: '1.1em' };
// const itemActionsStyle = { display: 'flex', gap: '10px', flexWrap: 'wrap' };
// const itemDetailsStyle = { marginTop: '10px', color: '#555', fontSize: '0.9em', lineHeight: '1.6' };
// const codeStyle = { backgroundColor: '#f4f4f4', padding: '2px 6px', borderRadius: '4px', fontFamily: 'monospace' };
// const loadingContainerStyle = { ...pageStyle, textAlign: 'center', fontSize: '1.2em', color: '#555' };


// /**
//  * Renders the main "Manage Votes" dashboard for administrators.
//  */
// function ManageVotesPage() {
//     // --- State Definitions ---

//     // [UX] Page-level loading state for initial data fetch
//     const [isLoadingPage, setIsLoadingPage] = useState(true);

//     // State for election lists
//     const [registerableVotes, setRegisterableVotes] = useState([]);
//     const [votableVotes, setVotableVotes] = useState([]);
//     const [completedVotes, setCompletedVotes] = useState([]);
    
//     // [UX] Centralized loading state for all individual async actions
//     const [actionLoading, setActionLoading] = useState({
//         isLoadingScript: null, // Stores voteId of script being run
//         isFinalizing: null,    // Stores voteId of vote being finalized
//         isCompleting: null,    // Stores voteId of vote being completed
//         isRegistering: false,  // True if voter registration modal is submitting
//         isAddingAdmin: false,  // True if add admin is submitting
//     });

//     // State for modals
//     const [isVoterModalOpen, setIsVoterModalOpen] = useState(false);
//     const [isFinalizeModalOpen, setIsFinalizeModalOpen] = useState(false);
    
//     // State for modal inputs
//     const [selectedVote, setSelectedVote] = useState(null);     // For voter modal
//     const [finalizingVote, setFinalizingVote] = useState(null); // For finalize modal
//     const [voters, setVoters] = useState('');                   // Voter email list
//     const [voteEndTime, setVoteEndTime] = useState('');         // Voting end time
    
//     const navigate = useNavigate();

//     // --- Data Fetching ---

//     /**
//      * Fetches all three categories of elections from the backend API.
//      * Wrapped in useCallback to stabilize the function reference for useEffect.
//      */
//     const fetchAllVotes = useCallback(async () => {
//         setIsLoadingPage(true); // Start page loading
//         try {
//             // Fetch all three endpoints concurrently
//             const [regResponse, votableResponse, completedResponse] = await Promise.all([
//                 axios.get('/api/elections/registerable'), // API for registerable votes
//                 axios.get('/api/elections/finalized'),   // API for votable votes
//                 axios.get('/api/elections/completed')  // API for completed votes
//             ]);
            
//             // Ensure data is always an array, even if API returns null/undefined
//             setRegisterableVotes(Array.isArray(regResponse.data) ? regResponse.data : []);
//             setVotableVotes(Array.isArray(votableResponse.data) ? votableResponse.data : []);
//             setCompletedVotes(Array.isArray(completedResponse.data) ? completedResponse.data : []);

//         } catch (error) {
//             console.error('투표 목록 조회 오류:', error.response?.data || error.message);
//             alert('전체 투표 목록을 불러오는 데 실패했습니다.');
//         } finally {
//             setIsLoadingPage(false); // Stop page loading
//         }
//     }, []); // Empty dependency array means this function is created once

//     // Initial data fetch on component mount
//     useEffect(() => {
//         fetchAllVotes();
//     }, [fetchAllVotes]); // Dependency is the stable useCallback function

//     // --- Modal Control Handlers ---

//     /**
//      * Opens the modal for bulk-registering voters for a selected election.
//      * @param {object} vote - The election object to register voters for.
//      */
//     const openVoterRegistrationModal = (vote) => {
//         setSelectedVote(vote);
//         setVoters('');
//         setIsVoterModalOpen(true);
//     };

//     /**
//      * Opens the modal for finalizing registration and setting a vote end time.
//      * @param {object} vote - The election object to finalize.
//      */
//     const openFinalizeModal = (vote) => {
//         setFinalizingVote(vote);
//         setVoteEndTime('');
//         setIsFinalizeModalOpen(true);
//     };

//     // --- Action Handlers (API Calls) ---

//     /**
//      * Handles user logout via Supabase.
//      */
//     const handleLogout = async () => {
//         const { error } = await supabase.auth.signOut();
//         if (error) {
//             console.error('로그아웃 중 오류 발생:', error);
//             alert('로그아웃에 실패했습니다.');
//         }
//         // AuthHandler in App.js will redirect to /login
//     };

//     /**
//      * Handles submission of the "Add Admin" action.
//      */
//     const handleAddAdmin = async () => {
//         const adminEmail = prompt("추가할 관리자의 이메일을 입력하세요:");
//         if (!adminEmail || adminEmail.trim() === '') return; // User cancelled or entered empty

//         setActionLoading(prev => ({ ...prev, isAddingAdmin: true }));
//         try {
//             await axios.post('/api/management/addAdmins', { emails: [adminEmail.trim()] });
//             alert(`${adminEmail} 관리자가 추가되었습니다.`);
//         } catch (error) {
//             console.error('관리자 추가 실패:', error.response?.data);
//             alert(`관리자 추가 실패: ${error.response?.data?.details || error.message}`);
//         } finally {
//             setActionLoading(prev => ({ ...prev, isAddingAdmin: false }));
//         }
//     };

//     /**
//      * Handles submission of the "Register Voters" modal.
//      * Calls the correct API: POST /api/elections/:id/voters
//      */
//     const handleRegisterVoters = async () => {
//         if (!selectedVote) return;
//         const voterList = voters.split(/[\n, ]+/).filter(v => v.trim() !== '');
//         if (voterList.length === 0) {
//             alert('등록할 유권자 이메일을 입력해주세요.');
//             return;
//         }

//         setActionLoading(prev => ({ ...prev, isRegistering: true }));
//         try {
//             // [FIXED] Use the correct API endpoint
//             await axios.post(`/api/elections/${selectedVote.id}/voters`, { emails: voterList });
//             alert(`'${selectedVote.name}'에 유권자 ${voterList.length}명이 등록되었습니다.`);
//             setIsVoterModalOpen(false); // Close modal on success
//         } catch (error) {
//             console.error('유권자 등록 실패:', error.response?.data);
//             alert(`유권자 등록 실패: ${error.response?.data?.details || error.message}`);
//         } finally {
//             setActionLoading(prev => ({ ...prev, isRegistering: false }));
//         }
//     };

//     /**
//      * Handles submission of the "Finalize Registration" modal.
//      * Calls the correct API: POST /api/elections/:id/finalize
//      */
//     const handleConfirmFinalize = async () => {
//         if (!finalizingVote) return;
//         // [FIXED] Get the required voteEndTime
//         if (!voteEndTime) {
//             alert('투표 종료 시간을 선택해주세요.');
//             return;
//         }
        
//         setActionLoading(prev => ({ ...prev, isFinalizing: finalizingVote.id }));
//         try {
//             // [FIXED] Use the correct API endpoint and send voteEndTime
//             await axios.post(`/api/elections/${finalizingVote.id}/finalize`, { voteEndTime });
//             alert('등록이 마감되었으며 투표가 시작되었습니다.');
//             setIsFinalizeModalOpen(false); // Close modal on success
//             fetchAllVotes(); // Refresh lists (vote moves from Registerable to Votable)
//         } catch (error) {
//             console.error('등록 마감 실패:', error.response?.data);
//             // Handle common blockchain "already processed" errors
//             if (error.response?.data?.error?.includes("already known") || error.response?.data?.details?.includes("already been cast")) {
//                 alert("트랜잭션이 이미 전송되었거나 처리되었습니다. 잠시 후 새로고침 됩니다.");
//                 setTimeout(fetchAllVotes, 5000); // Wait 5s and refresh
//             } else {
//                 alert(`등록 마감 실패: ${error.response?.data?.details || error.message}`);
//             }
//         } finally {
//             setActionLoading(prev => ({ ...prev, isFinalizing: null }));
//         }
//     };

//     /**
//      * Handles the "ZK Setup & Deploy" button click for a specific election.
//      * Calls API: POST /api/elections/:id/setZkDeploy
//      */
//     const handleSetupAndDeploy = async (voteId, voteName) => {
//         if (!window.confirm(`'${voteName}' 투표의 ZKP 설정 및 배포를 시작하시겠습니까?\n이 작업은 몇 분 정도 소요될 수 있습니다.`)) return;
        
//         setActionLoading(prev => ({ ...prev, isLoadingScript: voteId }));
//         try {
//             const response = await axios.post(`/api/elections/${voteId}/setZkDeploy`);
//             alert(`'${voteName}' 투표 설정 및 배포 완료: ${response.data.message}`);
//             fetchAllVotes(); // Refresh to show updated state (e.g., contract_address)
//         } catch (error) {
//             console.error('스크립트 실행 실패:', error.response?.data);
//             alert(`스크립트 실행 실패: ${error.response?.data?.details || '서버 로그를 확인하세요.'}`);
//         } finally {
//             setActionLoading(prev => ({ ...prev, isLoadingScript: null }));
//         }
//     };

//     /**
//      * Handles the "Complete Vote" button click for a specific election.
//      * Calls API: POST /api/elections/:id/complete
//      */
//     const handleCompleteVote = async (voteId, voteName) => {
//         if (!window.confirm(`'${voteName}' 투표를 최종적으로 종료하시겠습니까?\n이 작업 후에는 더 이상 해당 투표를 관리할 수 없습니다.`)) return;
        
//         setActionLoading(prev => ({ ...prev, isCompleting: voteId }));
//         try {
//             await axios.post(`/api/elections/${voteId}/complete`);
//             alert('투표가 성공적으로 종료되었습니다.');
//             fetchAllVotes(); // Refresh lists (vote moves from Votable to Completed)
//         } catch (error) {
//             console.error('투표 종료 실패:', error.response?.data);
//             alert(`투표 종료 실패: ${error.response?.data?.details || error.message}`);
//         } finally {
//             setActionLoading(prev => ({ ...prev, isCompleting: null }));
//         }
//     };

//     // --- Render Logic ---

//     /**
//      * Reusable component to render a list of elections for a specific category.
//      * @param {string} title - The title of the section (e.g., "투표 진행 중").
//      * @param {Array} votes - The array of vote objects to render.
//      * @param {function} renderActions - A function that takes a `vote` object
//      * and returns the React elements for its actions (buttons).
//      * @param {function} renderDetails - (Optional) A function to render extra details.
//      */
//     const renderVoteSection = (title, votes, renderActions, renderDetails = null) => {
//         const hasData = votes && votes.length > 0;

//         return (
//             <section style={sectionStyle}>
//                 <h2 style={sectionTitleStyle}>{title}</h2>
//                 <ul style={listStyle}>
//                     {!hasData && <p>해당하는 투표가 없습니다.</p>}
//                     {hasData && votes.map(vote => {
//                         // Check if any action is loading *for this specific vote*
//                         const isLoading = 
//                             actionLoading.isLoadingScript === vote.id ||
//                             actionLoading.isFinalizing === vote.id ||
//                             actionLoading.isCompleting === vote.id;
                        
//                         return (
//                             <li key={vote.id} style={listItemStyle}>
//                                 <div style={itemHeaderStyle}>
//                                     {/* [FIXED] Use vote.name, not vote.title */}
//                                     <span style={itemTitleStyle}>{vote.name} (ID: {vote.id})</span>
//                                     <div style={itemActionsStyle}>
//                                         {/* Render the specific actions for this section */}
//                                         {renderActions(vote, isLoading)}
//                                     </div>
//                                 </div>
//                                 <div style={itemDetailsStyle}>
//                                     <strong>후보자:</strong> {vote.candidates ? vote.candidates.join(', ') : '정보 없음'}<br />
//                                     {/* Render extra details if provided */}
//                                     {renderDetails && renderDetails(vote)}
//                                 </div>
//                             </li>
//                         );
//                     })}
//                 </ul>
//             </section>
//         );
//     };

//     // [UX] Show a global loader while fetching initial data
//     if (isLoadingPage) {
//         return (
//             <div style={loadingContainerStyle}>
//                 <Link to="/admin" style={{ textDecoration: 'none', color: '#007bff', display: 'block', marginBottom: '20px' }}>
//                     &larr; 관리자 대시보드
//                 </Link>
//                 <h1>투표 관리</h1>
//                 <p>투표 목록을 불러오는 중...</p>
//             </div>
//         );
//     }

//     // Main dashboard content
//     return (
//         <div style={pageStyle}>
//             <header style={headerStyle}>
//                 <h1 style={headerTitleStyle}>투표 관리</h1>
//                 <div style={headerActionsStyle}>
//                     <button 
//                         style={actionLoading.isAddingAdmin ? disabledButtonStyle : buttonStyle}
//                         onClick={handleAddAdmin}
//                         disabled={actionLoading.isAddingAdmin}
//                     >
//                         {actionLoading.isAddingAdmin ? '추가 중...' : '관리자 추가'}
//                     </button>
//                     {/* Link to create page */}
//                     <Link 
//                         to="/admin/create" 
//                         style={buttonStyle}
//                     >
//                         새 투표 생성
//                     </Link>
//                     <button 
//                         style={{...buttonStyle, backgroundColor: '#6c757d'}} 
//                         onClick={handleLogout}
//                     >
//                         로그아웃
//                     </button>
//                 </div>
//             </header>
            
//             {/* --- Section 1: Registerable Votes --- */}
//             {renderVoteSection(
//                 "유권자 등록 중인 투표",
//                 registerableVotes,
//                 (vote, isLoading) => ( // renderActions function
//                     <>
//                         <button 
//                             style={isLoading ? disabledButtonStyle : buttonStyle} 
//                             onClick={() => openVoterRegistrationModal(vote)}
//                             disabled={isLoading}
//                         >
//                             유권자 등록
//                         </button>
//                         <button 
//                             style={isLoading ? disabledButtonStyle : {...buttonStyle, backgroundColor: '#28a745'}} 
//                             onClick={() => openFinalizeModal(vote)}
//                             disabled={isLoading}
//                         >
//                             {/* [UX] Show specific loading state */}
//                             {actionLoading.isFinalizing === vote.id ? '마감 처리 중...' : '등록 마감'}
//                         </button>
                        
//                         {/* ZK Setup & Deploy Button (Conditional) */}
//                         {vote.contract_address ? (
//                             // Contract address exists, setup is complete
//                             <button style={disabledButtonStyle} disabled title="ZK 설정 및 배포가 이미 완료되었습니다.">
//                                 ZK 설정 완료
//                             </button>
//                         ) : (
//                             // No contract address, setup needed
//                             <button 
//                                 style={isLoading ? disabledButtonStyle : {...buttonStyle, backgroundColor: '#ffc107', color: 'black'}}
//                                 onClick={() => handleSetupAndDeploy(vote.id, vote.name)}
//                                 disabled={isLoading}
//                             >
//                                 {/* [UX] Show specific loading state */}
//                                 {actionLoading.isLoadingScript === vote.id ? '설정/배포 중...' : 'ZK 설정 & 배포'}
//                             </button>
//                         )}
//                     </>
//                 ),
//                 (vote) => ( // renderDetails function
//                     <>
//                         {/* [FIXED] Use vote.registration_end_time */}
//                         <strong>등록 마감일:</strong> {vote.registration_end_time ? new Date(vote.registration_end_time).toLocaleString() : '정보 없음'}
//                     </>
//                 )
//             )}

//             {/* --- Section 2: Votable Elections --- */}
//             {renderVoteSection(
//                 "투표 진행 중",
//                 votableVotes,
//                 (vote, isLoading) => ( // renderActions function
//                     <>
//                         {/* [FIXED] Add default values in case counts are null/undefined */}
//                         <span style={{ color: '#007bff', fontWeight: 'bold' }}>
//                             등록률: {vote.registered_voters || 0} / {vote.total_voters || 0}
//                         </span>
//                         <button 
//                             style={isLoading ? disabledButtonStyle : {...buttonStyle, backgroundColor: '#dc3545'}} 
//                             onClick={() => handleCompleteVote(vote.id, vote.name)}
//                             disabled={isLoading}
//                         >
//                             {/* [UX] Show specific loading state */}
//                             {actionLoading.isCompleting === vote.id ? '종료 중...' : '투표 종료'}
//                         </button>
//                     </>
//                 ),
//                 (vote) => ( // renderDetails function
//                     <>
//                         <strong>투표 마감일:</strong> {vote.voting_end_time ? new Date(vote.voting_end_time).toLocaleString() : '정보 없음'}<br />
//                         <strong>컨트랙트 주소:</strong> <code style={codeStyle}>{vote.contract_address || '배포 전'}</code>
//                     </>
//                 )
//             )}

//             {/* --- Section 3: Completed Elections --- */}
//             {renderVoteSection(
//                 "종료된 투표",
//                 completedVotes,
//                 (vote, isLoading) => ( // renderActions function
//                     <>
//                         {vote.contract_address && (
//                             <a 
//                                 href={`https://sepolia.etherscan.io/address/${vote.contract_address}`} 
//                                 target="_blank" 
//                                 rel="noopener noreferrer"
//                             >
//                                 <button style={{...buttonStyle, backgroundColor: '#6c757d'}}>컨트랙트 보기</button>
//                             </a>
//                         )}
//                         <span style={{ color: '#6c757d', marginLeft: '15px' }}>종료됨</span>
//                     </>
//                 ),
//                 (vote) => ( // renderDetails function
//                     <>
//                         <strong>최종 마감일:</strong> {vote.voting_end_time ? new Date(vote.voting_end_time).toLocaleString() : '정보 없음'}
//                     </>
//                 )
//             )}
            
//             {/* --- Modals --- */}
//             <Modal isOpen={isVoterModalOpen} onClose={() => setIsVoterModalOpen(false)}>
//                 {selectedVote && (
//                     <div>
//                         <h3>'{selectedVote.name}' 유권자 등록</h3>
//                         <p>등록할 유권자 이메일을 쉼표(,), 공백, 또는 줄바꿈으로 구분하여 입력하세요.</p>
//                         <textarea style={{ width: '98%', height: '150px' }} value={voters} onChange={(e) => setVoters(e.target.value)} placeholder='test1@example.com, test2@example.com' />
//                         <div style={{ marginTop: '20px', textAlign: 'right' }}>
//                             <button 
//                                 style={actionLoading.isRegistering ? disabledButtonStyle : {...buttonStyle, backgroundColor: '#6c757d'}} 
//                                 onClick={() => setIsVoterModalOpen(false)}
//                                 disabled={actionLoading.isRegistering}
//                             >
//                                 취소
//                             </button>
//                             <button 
//                                 style={actionLoading.isRegistering ? disabledButtonStyle : buttonStyle} 
//                                 onClick={handleRegisterVoters}
//                                 disabled={actionLoading.isRegistering}
//                             >
//                                 {actionLoading.isRegistering ? '등록 중...' : '등록 실행'}
//                             </button>
//                         </div>
//                     </div>
//                 )}
//             </Modal>

//             <Modal isOpen={isFinalizeModalOpen} onClose={() => setIsFinalizeModalOpen(false)}>
//                 {finalizingVote && (
//                     <div>
//                         <h3>'{finalizingVote.name}' 등록 마감</h3>
//                         <p>투표 종료 시간을 설정해주세요. (이 작업은 되돌릴 수 없습니다.)</p>
//                         <input type="datetime-local" value={voteEndTime} onChange={(e) => setVoteEndTime(e.target.value)} style={{ width: '95%' }} />
//                         <div style={{ marginTop: '20px', textAlign: 'right' }}>
//                             <button 
//                                 style={{...buttonStyle, backgroundColor: '#6c757d'}} 
//                                 onClick={() => setIsFinalizeModalOpen(false)}
//                                 // [UX] Allow closing modal even if finalize is processing
//                                 disabled={actionLoading.isFinalizing === finalizingVote.id}
//                             >
//                                 취소
//                             </button>
//                             <button 
//                                 style={actionLoading.isFinalizing === finalizingVote.id ? disabledButtonStyle : {...buttonStyle, backgroundColor: '#28a745'}} 
//                                 onClick={handleConfirmFinalize} 
//                                 disabled={actionLoading.isFinalizing === finalizingVote.id}
//                             >
//                                 {actionLoading.isFinalizing === finalizingVote.id ? '마감 처리 중...' : '마감 및 투표 시작'}
//                             </button>
//                         </div>
//                     </div>
//                 )}
//             </Modal>
//         </div>
//     );
// }

// // [FIXED] Changed default export name to match the file name
// export default ManageVotesPage;