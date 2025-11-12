/**
 * @file frontend/src/pages/Admin/CreateVotePage.js
 * @desc A form page for administrators to create a new election.
 * It collects election details (name, times, depth, candidates) and
 * submits them to the /api/elections/set endpoint.
 */

import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from '../../api/axios';

// --- [PERFORMANCE] Style Definitions ---
// Moved outside the component function to prevent re-creation on every render.
const pageStyle = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '600px', margin: 'auto' };
const formStyle = { display: 'flex', flexDirection: 'column', gap: '20px' }; // Increased gap
const inputGroupStyle = { display: 'flex', flexDirection: 'column' };
const labelStyle = { marginBottom: '5px', fontWeight: 'bold', color: '#333' };
const inputStyle = { padding: '10px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '1em' };
const buttonStyle = { padding: '12px', border: 'none', borderRadius: '4px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', fontSize: '16px', transition: 'background-color 0.2s ease' };
const disabledButtonStyle = { ...buttonStyle, backgroundColor: '#aaa', cursor: 'not-allowed' };
const candidateInputGroupStyle = { display: 'flex', gap: '10px', marginBottom: '5px' };
const candidateInputStyle = { ...inputStyle, flex: 1 };
// [UX] Styled buttons for add/remove
const secondaryButtonStyle = { padding: '8px 12px', border: '1px solid #007bff', borderRadius: '4px', backgroundColor: '#fff', color: '#007bff', cursor: 'pointer' };
const removeButtonStyle = { ...secondaryButtonStyle, borderColor: '#dc3545', color: '#dc3545' };


/**
 * Renders the "Create New Vote" form page for admins.
 * Allows setting up the basic parameters of a new election.
 *
 * @returns {React.ReactElement} The rendered CreateVotePage component.
 */
function CreateVotePage() {
    // --- State Definitions ---
    const [name, setName] = useState('');
    const [merkleTreeDepth, setMerkleTreeDepth] = useState('');
    const [candidates, setCandidates] = useState(['']); // Start with one candidate field
    const [regEndTime, setRegEndTime] = useState('');
  
    // [UX] Loading state to prevent duplicate submissions
    const [isLoading, setIsLoading] = useState(false); 
    
    const navigate = useNavigate();

    // --- Candidate List Handlers ---

    /**
     * Updates the candidate name at a specific index in the state array.
     * @param {number} index - The index of the candidate to update.
     * @param {React.ChangeEvent<HTMLInputElement>} event - The input change event.
     */
    const handleCandidateChange = (index, event) => {
        const newCandidates = [...candidates];
        newCandidates[index] = event.target.value;
        setCandidates(newCandidates);
    };

    /**
     * Adds a new, empty string to the candidates array, triggering a re-render
     * with a new input field.
     */
    const addCandidate = () => setCandidates([...candidates, '']);

    /**
     * Removes a candidate from the array at a specific index.
     * @param {number} index - The index of the candidate to remove.
     */
    const removeCandidate = (index) => {
        // [UX] Only allow removal if there is more than one candidate
        if (candidates.length > 1) {
            setCandidates(candidates.filter((_, i) => i !== index));
        }
    };

    // --- Form Submission Handler ---

    /**
     * Handles the form submission.
     * Validates input, sends data to the /api/elections/set endpoint,
     * handles success (alert, navigate) and error (alert) states.
     * @param {React.FormEvent<HTMLFormElement>} event - The form submit event.
     */
    const handleSubmit = async (event) => {
        event.preventDefault();
    
        // Filter out empty strings (e.g., if user added a field but left it blank)
        const finalCandidates = candidates.filter(c => c.trim() !== '');

        // --- Validation ---
        if (finalCandidates.length < 1) {
            alert('후보자를 최소 1명 이상 입력해야 합니다.');
            return;
        }
        // Check for other fields (already covered by 'required' attribute, but good for safety)
        if (!name || !merkleTreeDepth || !regEndTime) {
            alert('모든 필수 항목을 입력해주세요.');
            return;
        }
        if (new Date(regEndTime) <= new Date()) {
            alert('등록 마감 시간은 현재 시간보다 미래로 설정해야 합니다.');
            return;
        }

        // [UX] Set loading state to prevent double-click
        setIsLoading(true);

        try {
            // 1. Send the API request with the correct data structure
            await axios.post('/elections/set', {
                name: name.trim(),
                merkleTreeDepth: parseInt(merkleTreeDepth, 10), // Ensure it's a number
                candidates: finalCandidates,
                regEndTime: regEndTime, // Already in ISO format from datetime-local input
            });
        
            // [UX] Simplified success message
            alert(`투표가 성공적으로 생성되었습니다.\n관리 대시보드로 이동하여 "ZK 설정 & 배포"를 진행하세요.`);
            
            navigate('/admin'); // Navigate to the manage page (where the new vote will be)

        } catch (error) {
            console.error('투표 생성 실패:', error.response?.data);
            // [UX] Show the more specific 'details' field from our server's error response
            alert(`투표 생성 실패: ${error.response?.data?.details || error.message}`);
        } finally {
            // [UX] Always turn off loading state
            setIsLoading(false);
        }
    };

    return (
        <main style={pageStyle}>
        <Link to="/admin" style={{ textDecoration: 'none', color: '#007bff' }}>
            &larr; 관리 대시보드로 돌아가기
        </Link>
        <h2 style={{ marginTop: '20px' }}>새로운 투표 생성</h2>
        
        <form onSubmit={handleSubmit} style={formStyle}>
            
            {/* Vote Name */}
            <div style={inputGroupStyle}>
            <label style={labelStyle} htmlFor="voteName">투표 이름</label>
            <input 
                id="voteName"
                style={inputStyle} 
                type="text" 
                value={name} 
                onChange={(e) => setName(e.target.value)} 
                required 
            />
            </div>

            {/* Registration End Time */}
            <div style={inputGroupStyle}>
            <label style={labelStyle} htmlFor="regEndTime">유권자 등록 마감 시간</label>
            <input 
                id="regEndTime"
                style={inputStyle} 
                type="datetime-local" 
                value={regEndTime} 
                onChange={(e) => setRegEndTime(e.target.value)} 
                required 
            />
            </div>

            {/* Merkle Tree Depth */}
            <div style={inputGroupStyle}>
            <label style={labelStyle} htmlFor="merkleDepth">머클 트리 깊이</label>
            <input 
                id="merkleDepth"
                style={inputStyle} 
                type="number" 
                min="2" // A depth of 1 is not very useful
                max="32" // Max depth for practical purposes
                value={merkleTreeDepth} 
                onChange={(e) => setMerkleTreeDepth(e.target.value)} 
                placeholder="예: 10 (2^10 = 1024명 지원)" 
                required 
            />
            </div>
            
            {/* Dynamic Candidate List */}
            <div style={inputGroupStyle}>
            <label style={labelStyle}>후보자 목록</label>
            {candidates.map((candidate, index) => (
                <div key={index} style={candidateInputGroupStyle}>
                <input 
                    style={candidateInputStyle} 
                    type="text" 
                    value={candidate} 
                    onChange={(e) => handleCandidateChange(index, e)} 
                    placeholder={`후보 ${index + 1}`} 
                    required
                />
                {/* [UX] Only show Remove button if there is more than 1 candidate */}
                {candidates.length > 1 && (
                    <button 
                    type="button" 
                    style={removeButtonStyle}
                    onClick={() => removeCandidate(index)}
                    aria-label={`Remove candidate ${index + 1}`}
                    >
                    제거
                    </button>
                )}
                </div>
            ))}
            <button 
                type="button" 
                style={{...secondaryButtonStyle, marginTop: '10px'}}
                onClick={addCandidate}
            >
                후보자 추가
            </button>
            </div>
            
            {/* Submit Button */}
            <button 
            type="submit" 
            style={isLoading ? disabledButtonStyle : buttonStyle} 
            disabled={isLoading}
            >
            {isLoading ? '생성 중...' : '투표 생성하기'}
            </button>
        </form>
        </main>
    );
}

export default CreateVotePage;