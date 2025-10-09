// frontend/src/pages/admin/CreateVotePage.js
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from '../../api/axios'; // 경로가 한 단계 깊어졌으므로 '../' -> '../../'

function CreateVotePage() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [candidates, setCandidates] = useState(['']);

  const handleCandidateChange = (index, event) => {
    const newCandidates = [...candidates];
    newCandidates[index] = event.target.value;
    setCandidates(newCandidates);
  };

  const addCandidate = () => {
    setCandidates([...candidates, '']);
  };

  const removeCandidate = (index) => {
    const newCandidates = candidates.filter((_, i) => i !== index);
    setCandidates(newCandidates);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const finalCandidates = candidates.filter(c => c.trim() !== '');

    if (finalCandidates.length < 1) {
      alert('후보자를 1명 이상 입력해주세요.');
      return;
    }

    try {
      await axios.post('/setVote', {
        title,
        description,
        candidates: finalCandidates,
      });
      alert('투표가 성공적으로 생성되었습니다!');
      setTitle('');
      setDescription('');
      setCandidates(['']);
    } catch (error) {
      console.error('투표 생성 중 오류 발생:', error);
      alert(`투표 생성에 실패했습니다: ${error.response?.data?.message || error.message}`);
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <Link to="/admin">← 관리자 대시보드로 돌아가기</Link>
      <h2>새로운 투표 생성</h2>
      <form onSubmit={handleSubmit}>
        {/* 기존 폼 UI는 그대로 사용합니다. */}
        <div>
          <label>투표 제목:</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <div>
          <label>투표 설명:</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label>후보자 목록:</label>
          {candidates.map((candidate, index) => (
            <div key={index}>
              <input
                type="text"
                value={candidate}
                onChange={(e) => handleCandidateChange(index, e)}
                placeholder={`후보자 ${index + 1}`}
              />
              <button type="button" onClick={() => removeCandidate(index)}>삭제</button>
            </div>
          ))}
          <button type="button" onClick={addCandidate}>후보자 추가</button>
        </div>
        <hr />
        <button type="submit">투표 생성하기</button>
      </form>
    </div>
  );
}

export default CreateVotePage;