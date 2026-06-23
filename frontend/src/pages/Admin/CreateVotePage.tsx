/**
 * @file frontend/src/pages/Admin/CreateVotePage.tsx
 * @desc Admin form to create a new election; submits to POST /api/elections/set.
 */
import { useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from '../../api/axios';
import { errorData, errorMessage } from '../../utils/errors';

const pageStyle: CSSProperties = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '600px', margin: 'auto' };
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '20px' };
const inputGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column' };
const labelStyle: CSSProperties = { marginBottom: '5px', fontWeight: 'bold', color: '#333' };
const inputStyle: CSSProperties = { padding: '10px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '1em' };
const buttonStyle: CSSProperties = { padding: '12px', border: 'none', borderRadius: '4px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', fontSize: '16px', transition: 'background-color 0.2s ease' };
const disabledButtonStyle: CSSProperties = { ...buttonStyle, backgroundColor: '#aaa', cursor: 'not-allowed' };
const candidateInputGroupStyle: CSSProperties = { display: 'flex', gap: '10px', marginBottom: '5px' };
const candidateInputStyle: CSSProperties = { ...inputStyle, flex: 1 };
const secondaryButtonStyle: CSSProperties = { padding: '8px 12px', border: '1px solid #007bff', borderRadius: '4px', backgroundColor: '#fff', color: '#007bff', cursor: 'pointer' };
const removeButtonStyle: CSSProperties = { ...secondaryButtonStyle, borderColor: '#dc3545', color: '#dc3545' };
const MAX_SUPPORTED_CANDIDATES = 5;

function CreateVotePage() {
  const [name, setName] = useState('');
  const [merkleTreeDepth, setMerkleTreeDepth] = useState('');
  const [candidates, setCandidates] = useState<string[]>(['']);
  const [regEndTime, setRegEndTime] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const navigate = useNavigate();

  const handleCandidateChange = (index: number, event: ChangeEvent<HTMLInputElement>) => {
    const newCandidates = [...candidates];
    newCandidates[index] = event.target.value;
    setCandidates(newCandidates);
  };

  const addCandidate = () => setCandidates([...candidates, '']);

  const removeCandidate = (index: number) => {
    if (candidates.length > 1) {
      setCandidates(candidates.filter((_, i) => i !== index));
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const finalCandidates = candidates.filter((c) => c.trim() !== '');

    if (finalCandidates.length < 1) {
      alert('후보자를 최소 1명 이상 입력해야 합니다.');
      return;
    }
    if (finalCandidates.length > MAX_SUPPORTED_CANDIDATES) {
      alert(`후보자는 최대 ${MAX_SUPPORTED_CANDIDATES}명까지 지원됩니다.`);
      return;
    }
    const candidateKeys = finalCandidates.map((c) => c.trim().toLocaleLowerCase());
    if (new Set(candidateKeys).size !== candidateKeys.length) {
      alert('중복된 후보자 이름은 사용할 수 없습니다.');
      return;
    }
    if (!name || !merkleTreeDepth || !regEndTime) {
      alert('모든 필수 항목을 입력해주세요.');
      return;
    }
    if (new Date(regEndTime) <= new Date()) {
      alert('등록 마감 시간은 현재 시간보다 미래로 설정해야 합니다.');
      return;
    }

    setIsLoading(true);

    try {
      await axios.post('/elections/set', {
        name: name.trim(),
        merkleTreeDepth: parseInt(merkleTreeDepth, 10),
        candidates: finalCandidates,
        regEndTime: new Date(regEndTime).toISOString(),
      });

      alert('투표가 성공적으로 생성되었습니다.\n관리 대시보드로 이동하여 "ZK 설정 & 배포"를 진행하세요.');
      navigate('/admin');
    } catch (error) {
      console.error('투표 생성 실패:', errorData(error));
      alert(`투표 생성 실패: ${errorMessage(error)}`);
    } finally {
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
        <div style={inputGroupStyle}>
          <label style={labelStyle} htmlFor="voteName">투표 이름</label>
          <input id="voteName" style={inputStyle} type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>

        <div style={inputGroupStyle}>
          <label style={labelStyle} htmlFor="regEndTime">유권자 등록 마감 시간</label>
          <input id="regEndTime" style={inputStyle} type="datetime-local" value={regEndTime} onChange={(e) => setRegEndTime(e.target.value)} required />
        </div>

        <div style={inputGroupStyle}>
          <label style={labelStyle} htmlFor="merkleDepth">머클 트리 깊이</label>
          <input
            id="merkleDepth"
            style={inputStyle}
            type="number"
            min="2"
            max="5"
            value={merkleTreeDepth}
            onChange={(e) => setMerkleTreeDepth(e.target.value)}
            placeholder="예: 5 (2^5 = 32명 지원)"
            required
          />
        </div>

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
              {candidates.length > 1 && (
                <button type="button" style={removeButtonStyle} onClick={() => removeCandidate(index)} aria-label={`Remove candidate ${index + 1}`}>
                  제거
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            style={{ ...secondaryButtonStyle, marginTop: '10px' }}
            onClick={addCandidate}
            disabled={candidates.length >= MAX_SUPPORTED_CANDIDATES}
          >
            후보자 추가
          </button>
        </div>

        <button type="submit" style={isLoading ? disabledButtonStyle : buttonStyle} disabled={isLoading}>
          {isLoading ? '생성 중...' : '투표 생성하기'}
        </button>
      </form>
    </main>
  );
}

export default CreateVotePage;
