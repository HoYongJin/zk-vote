/**
 * @file frontend/src/pages/Voter/VotePage.js
 * @desc React component for the individual voting page.
 * This page handles the entire client-side ZK proof generation and submission process.
 * 1. Fetches proof data + submission ticket from the authenticated /proof endpoint.
 * 2. Generates the ZK proof client-side in a Web Worker.
 * 3. Submits the proof + ticket to the anonymous /submit gas relayer endpoint.
 * 4. On success, sets a localStorage flag for UX purposes.
 */

import React, { useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import axios from '../../api/axios'; // Our configured axios instance (baseURL: /api)

// --- (Style definitions are omitted for brevity) ---
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
    // Get election data (name, candidates, etc.) passed from VoterMainPage navigation
    const { vote: election } = location.state || {};

    const [selectedCandidateIndex, setSelectedCandidateIndex] = useState(null);
    const [loadingMessage, setLoadingMessage] = useState('');
    const [errorMessage, setErrorMessage] = useState('');

    /**
     * Handles the entire voting process when the user clicks "Submit Vote".
     */
    const handleVote = async () => {
        if (selectedCandidateIndex === null) {
            alert('먼저 후보를 선택해주세요.');
            return;
        }

        // [MODIFICATION] This variable must be declared in the outer scope
        // so it's accessible inside the worker.onmessage callback (due to closure).
        let submissionTicket = null; 

        try {
            setErrorMessage('');
            setLoadingMessage('투표 증명에 필요한 정보를 요청하는 중...');

            // --- 1. Fetch Proof Data & Submission Ticket (Authenticated) ---
            // This API call is authenticated (sends JWT) and proves eligibility.
            const serverResponse = await axios.post(`/elections/${electionId}/proof`);
            
            // Destructure all required data from the response
            const { 
                user_secret, 
                root, 
                pathElements, 
                pathIndices,
                submissionTicket: receivedTicket // Get the single-use ticket
            } = serverResponse.data;

            // [MODIFICATION] Store the ticket for the anonymous submit call later.
            submissionTicket = receivedTicket;

            // Check if the ticket was received
            if (!submissionTicket) {
                console.error("Failed to retrieve submission ticket from /proof endpoint.");
                throw new Error("Failed to retrieve submission ticket. Cannot proceed.");
            }

            // --- 2. Prepare ZK Proof Inputs ---
            // Create a 1-hot array for the vote (e.g., [0, 0, 1, 0])
            const voteArray = Array(election.candidates.length).fill(0);
            voteArray[selectedCandidateIndex] = 1;
            
            const inputs = {
                // Public inputs for the circuit
                root_in: root,

                // Private inputs for the circuit
                user_secret: user_secret,
                vote: voteArray,
                pathElements: pathElements,
                pathIndices: pathIndices,
                // Ensure election_id is formatted as a hex string for the circuit
                election_id:  "0x" + electionId.replace(/-/g, "") 
            };

            // --- 3. Get ZKP File Paths ---
            // The baseURL is '/api' (set in GitHub Actions env var)
            const baseURL = process.env.REACT_APP_API_BASE_URL; 
            const { merkle_tree_depth, num_candidates } = election;
            // Construct the path to the ZKP files on the EC2 server (served via /api/zkp-files)
            const buildDir = `build_${merkle_tree_depth}_${num_candidates}`;
            const wasmPath = `${baseURL}/zkp-files/${buildDir}/VoteCheck_temp_js/VoteCheck_temp.wasm`;
            const zkeyPath = `${baseURL}/zkp-files/${buildDir}/circuit_final.zkey`;
            
            setLoadingMessage(<>영지식 증명을 생성하는 중...<br/>(UI는 멈추지 않아요!)</>);
            
            // --- 4. Start Web Worker for Proof Generation ---
            // Use `new URL()` to ensure Webpack handles the worker file correctly.
            const worker = new Worker(new URL('../../workers/proof.worker.js', import.meta.url));
            
            // Send all necessary data to the worker
            worker.postMessage({ inputs, wasmPath, zkeyPath });

            // --- 5. Handle Worker Response (Proof Completion) ---
            worker.onmessage = async (event) => {
                const { status, proof, publicSignals, message } = event.data;

                if (status === 'success') {
                    setLoadingMessage('생성된 증명을 안전하게 제출하는 중...');
                    
                    // Format the proof object for the Solidity verifier contract
                    const formattedProof = {
                        a: proof.pi_a.slice(0, 2),
                        b: proof.pi_b.slice(0, 2).map(row => row.reverse()), // Adjust B coordinates
                        c: proof.pi_c.slice(0, 2)
                    };

                    // --- 6. [MODIFIED] Submit Proof (Anonymous) ---
                    // This call is anonymous (no JWT) but sends the single-use ticket
                    // to the gas relayer endpoint for authorization.
                    await axios.post(`/elections/${electionId}/submit`, { 
                        formattedProof, 
                        publicSignals,
                        submissionTicket: submissionTicket // Pass the ticket
                    });
                    
                    setLoadingMessage('');
                    alert('투표가 성공적으로 제출되었습니다!');

                    // --- 7. [NEW] Set localStorage Flag for UX ---
                    // This is the UX improvement discussed. It marks this election
                    // as 'voted' *on this browser* so VoterMainPage can hide the button.
                    try {
                        const storageKey = `voted_${electionId}`;
                        localStorage.setItem(storageKey, 'true');
                        console.log(`[VotePage] Set ${storageKey} in localStorage.`);
                    } catch (e) {
                        // This is not critical, just log the error.
                        console.error("Failed to save vote status to localStorage:", e);
                    }
                    
                    // Navigate back to the main page
                    navigate('/');

                } else {
                    // Handle errors *from the worker* (proof generation failed)
                    setLoadingMessage('');
                    setErrorMessage(`증명 생성 실패: ${message}`);
                }
                worker.terminate(); // Clean up the worker
            };

            // Handle worker initialization errors
            worker.onerror = (error) => {
                setLoadingMessage('');
                setErrorMessage(`Web worker initialization error: ${error.message}`);
                worker.terminate();
            };

        } catch (error) {
            // Handle errors from the *authenticated* /proof API call
            setLoadingMessage('');
            console.error("Failed to fetch proof data or ticket:", error.response?.data);
            setErrorMessage(`투표 실패: ${error.response?.data?.details || error.message}`);
        }
    };
    
    // --- Render Logic ---
    // Show loading overlay
    if (loadingMessage) {
        return <div style={loadingOverlayStyle}>{loadingMessage}</div>;
    }

    // Show error screen
    if (errorMessage) {
        return (
            <div style={pageStyle}>
                <h2>오류</h2>
                <p style={{color: 'red'}}>{errorMessage}</p>
                <button style={buttonStyle} onClick={() => navigate('/')}>메인으로 돌아가기</button>
            </div>
        );
    }

    // Handle case where user navigates directly to this page without election data
    if (!election) {
        return (
            <div style={pageStyle}>
                <h2>잘못된 접근입니다.</h2>
                <p>투표 정보를 찾을 수 없습니다. 메인 페이지에서 다시 시도해주세요.</p>
                <button style={buttonStyle} onClick={() => navigate('/')}>메인으로 돌아가기</button>
            </div>
        );
    }

    // Main voting UI
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
                {loadingMessage ? '처리 중...' : '투표 제출하기'}
            </button>
        </div>
    );
}

export default VotePage;