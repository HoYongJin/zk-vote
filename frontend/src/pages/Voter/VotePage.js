// frontend/src/pages/Voter/VotePage.js
import React, { useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import axios from '../../api/axios';

// --- 스타일 정의 ---
const pageStyle = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '600px', margin: 'auto' };
const headerStyle = { borderBottom: '1px solid #eee', paddingBottom: '10px', marginBottom: '20px' };
const candidateListStyle = { listStyleType: 'none', padding: '0' };
const candidateItemStyle = { border: '1px solid #ccc', borderRadius: '8px', padding: '15px', margin: '10px 0', cursor: 'pointer', transition: 'all 0.2s' };
const selectedCandidateStyle = { ...candidateItemStyle, borderColor: '#007bff', backgroundColor: '#f0f8ff', fontWeight: 'bold' };
const buttonStyle = { width: '100%', padding: '15px', border: 'none', borderRadius: '8px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', fontSize: '18px', marginTop: '20px' };
const loadingOverlayStyle = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', color: 'white', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', zIndex: 1000, fontSize: '1.5em', textAlign: 'center' };

function VotePage() {
    const { id: electionId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const { vote: election } = location.state || {};

    console.log("VotePage에서 받은 election 객체:", election);

    const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(null);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');

    const handleVote = async () => {
        if (selectedCandidateIndex === null) {
            alert('먼저 후보를 선택해주세요.');
            return;
        }

        try {
            setErrorMessage('');
            setLoadingMessage('투표 증명에 필요한 정보를 요청하는 중...');

            const serverResponse = await axios.post(`/elections/${electionId}/proof`);
            const proofData = serverResponse.data;
            
            console.log("proofData: ", proofData);

            const voteArray = Array(election.candidates.length).fill(0);
            voteArray[selectedCandidateIndex] = 1;
            const inputs = {
                // Main 템플릿의 public input
                root_in: proofData.root,

                // Main 템플릿의 private inputs
                user_secret: proofData.user_secret,
                vote: voteArray, // 방금 만든 1-hot 배열
                pathElements: proofData.pathElements,
                pathIndices: proofData.pathIndices,
                election_id: proofData.election_id
            };
            console.log("root_in: ", inputs.root_in);
            console.log("user_secret: ", inputs.user_secret);
            console.log("pathElements: ", inputs.pathElements);
            console.log("pathIndices: ", inputs.pathIndices);
            console.log("election_id: ", inputs.election_id);

            const baseURL = process.env.REACT_APP_API_BASE_URL.replace('/api', '');

            const { merkle_tree_depth, num_candidates } = election;
            const wasmPath = `${baseURL}/zkp-files/build_${merkle_tree_depth}_${num_candidates}/VoteCheck_temp_js/VoteCheck_temp.wasm`;
            const zkeyPath = `${baseURL}/zkp-files/build_${merkle_tree_depth}_${num_candidates}/circuit_final.zkey`;
            
            setLoadingMessage(<>영지식 증명을 생성하는 중...<br/>(UI는 멈추지 않아요!)</>);
            
            // new URL(...) 구문은 React(Webpack)가 워커 파일을 올바르게 인식하도록 돕습니다.
            // 경로가 ../../workers/ 로 시작하는지 확인하세요.
            const worker = new Worker(new URL('../../workers/proof.worker.js', import.meta.url));
            
            worker.postMessage({ inputs, wasmPath, zkeyPath });

            worker.onmessage = async (event) => {
                const { status, proof, publicSignals, message } = event.data;

                if (status === 'success') {
                    setLoadingMessage('생성된 증명을 안전하게 제출하는 중...');
                    await axios.post(`/elections/${electionId}/submit`, { proof, publicSignals });
                    setLoadingMessage('');
                    alert('투표가 성공적으로 제출되었습니다!');
                    navigate('/');
                } else {
                    setLoadingMessage('');
                    setErrorMessage(`증명 생성 실패: ${message}`);
                }
                worker.terminate();
            };

        } catch (error) {
            setLoadingMessage('');
            setErrorMessage(`투표 실패: ${error.response?.data?.message || error.message}`);
        }
    };
    
    // 👇 로딩 및 에러 화면을 렌더링하는 부분이 추가/수정되었습니다.
    if (loadingMessage) {
        return <div style={loadingOverlayStyle}>{loadingMessage}</div>;
    }

    if (errorMessage) {
        return <div style={pageStyle}><h2>오류</h2><p style={{color: 'red'}}>{errorMessage}</p><button onClick={() => navigate('/')}>메인으로 돌아가기</button></div>;
    }

    if (!election) {
        return <div style={pageStyle}><h2>잘못된 접근입니다.</h2><p>투표 정보를 찾을 수 없습니다. 메인 페이지에서 다시 시도해주세요.</p><button onClick={() => navigate('/')}>메인으로 돌아가기</button></div>;
    }

    return (
        <div style={pageStyle}>
            <header style={headerStyle}>
                <h1>{election.name}</h1>
                <p>투표 마감일: {new Date(election.voting_end_time).toLocaleString()}</p>
            </header>

            <p>투표할 후보를 선택해주세요.</p>
            <ul style={candidateListStyle}>
                {election.candidates.map((candidate, index) => (
                    <li
                        key={index}
                        style={selectedCandidateIndex === index ? selectedCandidateStyle : candidateItemStyle}
                        onClick={() => setSelectedCandidateIndex(index)}
                    >
                        {candidate}
                    </li>
                ))}
            </ul>

            <button style={buttonStyle} onClick={handleVote} disabled={!!loadingMessage}>
                투표 제출하기
            </button>
        </div>
    );
}

export default VotePage;