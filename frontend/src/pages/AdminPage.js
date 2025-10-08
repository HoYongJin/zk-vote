// frontend/src/pages/AdminPage.js
import React, { useState } from 'react';
import axios from '../api/axios'; // 우리가 설정한 axios 인스턴스를 가져옵니다.

function AdminPage() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [candidates, setCandidates] = useState(['']); // 후보자 목록, 기본 1개

  // 후보자 입력 필드가 변경될 때
  const handleCandidateChange = (index, event) => {
    const newCandidates = [...candidates];
    newCandidates[index] = event.target.value;
    setCandidates(newCandidates);
  };

  // 후보자 추가 버튼 클릭 시
  const addCandidate = () => {
    setCandidates([...candidates, '']);
  };

  // 후보자 삭제 버튼 클릭 시
  const removeCandidate = (index) => {
    const newCandidates = candidates.filter((_, i) => i !== index);
    setCandidates(newCandidates);
  };

  // 폼 제출 시
  const handleSubmit = async (event) => {
    event.preventDefault();
    // 비어있는 후보자 항목은 제외하고 전송
    const finalCandidates = candidates.filter(c => c.trim() !== '');

    if (finalCandidates.length < 1) {
      alert('후보자를 1명 이상 입력해주세요.');
      return;
    }

    try {
      const response = await axios.post('/setVote', {
        title,
        description,
        candidates: finalCandidates,
      });
      alert('투표가 성공적으로 생성되었습니다!');
      console.log(response.data);
      // 성공 후 입력 필드 초기화
      setTitle('');
      setDescription('');
      setCandidates(['']);
    } catch (error) {
      console.error('투표 생성 중 오류 발생:', error);
      alert(`투표 생성에 실패했습니다: ${error.response?.data?.message || error.message}`);
    }
  };

  return (
    <div>
      <h2>관리자 페이지: 새 투표 생성</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>투표 제목:</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>
        <div>
          <label>투표 설명:</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
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

export default AdminPage;