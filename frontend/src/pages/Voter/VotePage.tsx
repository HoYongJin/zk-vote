/**
 * @file frontend/src/pages/Voter/VotePage.tsx
 * @desc Individual voting page. Runs the full client-side ZK flow:
 *  1. Fetch proof data + single-use submission ticket from /proof (authenticated).
 *  2. Generate the ZK proof in a Web Worker (snarkjs).
 *  3. Submit proof + ticket to the anonymous /submit relayer endpoint.
 *  4. On success, mark this election as voted in localStorage (UX-only).
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import axios from '../../api/axios';
import { getVoterSecret, clearVoterSecret } from '../../utils/voterSecret';
import { fetchVerifiedArtifact } from '../../utils/artifactIntegrity';
import { resolveArtifactApiPath } from '../../utils/apiBaseUrl';
import { calculateSubmissionJitterMs, delay } from '../../utils/submissionJitter';
import { errorData, errorMessage as apiErrorMessage } from '../../utils/errors';
import type { ArtifactInfo, Election, FormattedProof, ProofResponse } from '../../types/domain';
import type { ProofInputs, WorkerRequest, WorkerResponse } from '../../workers/proof.types';

const pageStyle: CSSProperties = { fontFamily: 'sans-serif', padding: '20px', maxWidth: '600px', margin: 'auto' };
const headerStyle: CSSProperties = { borderBottom: '1px solid #eee', paddingBottom: '10px', marginBottom: '20px' };
const candidateListStyle: CSSProperties = { listStyleType: 'none', padding: '0' };
const candidateItemStyle: CSSProperties = { border: '1px solid #ccc', borderRadius: '8px', padding: '15px', margin: '10px 0', cursor: 'pointer', transition: 'all 0.2s' };
const selectedCandidateStyle: CSSProperties = { ...candidateItemStyle, borderColor: '#007bff', backgroundColor: '#f0f8ff', fontWeight: 'bold' };
const buttonStyle: CSSProperties = { width: '100%', padding: '15px', border: 'none', borderRadius: '8px', backgroundColor: '#007bff', color: 'white', cursor: 'pointer', fontSize: '18px', marginTop: '20px' };
const loadingOverlayStyle: CSSProperties = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', color: 'white', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', zIndex: 1000, fontSize: '1.5em', textAlign: 'center' };

function VotePage() {
  const { id: electionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const election = (location.state as { vote?: Election } | null)?.vote;

  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState<number | null>(null);
  const [loadingMessage, setLoadingMessage] = useState<ReactNode>('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleVote = async () => {
    if (selectedCandidateIndex === null) {
      alert('먼저 후보를 선택해주세요.');
      return;
    }
    if (!election || !electionId) {
      return;
    }

    // Declared in the outer scope so the worker.onmessage closure can read it.
    let submissionTicket: string | null = null;

    try {
      setErrorMessage('');
      setLoadingMessage('투표 증명에 필요한 정보를 요청하는 중...');

      // --- 1. Fetch proof data + submission ticket (authenticated) ---
      const serverResponse = await axios.post<ProofResponse>(`/elections/${electionId}/proof`);
      const submissionTicketIssuedAtMs = Date.now();
      const { root, pathElements, pathIndices, submissionTicket: receivedTicket } = serverResponse.data;

      const userSecret = getVoterSecret(electionId);
      if (!userSecret) {
        throw new Error('이 브라우저에 저장된 투표 secret이 없습니다. 등록했던 브라우저에서 다시 시도해주세요.');
      }

      submissionTicket = receivedTicket;
      if (!submissionTicket) {
        throw new Error('Failed to retrieve submission ticket. Cannot proceed.');
      }

      // --- 2. Prepare ZK inputs (1-hot vote vector) ---
      const voteArray: number[] = new Array(election.candidates.length).fill(0);
      voteArray[selectedCandidateIndex] = 1;

      const inputs: ProofInputs = {
        root_in: root,
        user_secret: userSecret,
        vote: voteArray,
        pathElements,
        pathIndices,
        // election_id must be a hex string for the circuit.
        election_id: '0x' + electionId.replace(/-/g, ''),
      };

      // --- 3. Fetch + verify the proving artifacts (AR-M6 / G5: fail closed) ---
      // A missing/unrecorded manifest is FATAL: we never fall back to fetching
      // unverified proving artifacts, so a tampered or wrong circuit can never be
      // fed to the prover. Every deployed election has a sha256 manifest (the
      // setZkDeploy artifact requires one), so this path is always available.
      let artifactInfo: ArtifactInfo;
      try {
        const infoResponse = await axios.get<ArtifactInfo>(`/elections/${electionId}/artifact-info`);
        artifactInfo = infoResponse.data;
      } catch (infoError) {
        throw new Error(`아티팩트 정보를 가져오지 못했습니다: ${apiErrorMessage(infoError)}`);
      }

      setLoadingMessage('증명 아티팩트 무결성을 검증하는 중...');
      const [wasmData, zkeyData] = await Promise.all([
        fetchVerifiedArtifact(resolveArtifactApiPath(artifactInfo.wasmPath), artifactInfo.wasmSha256, '증명 회로(wasm)'),
        fetchVerifiedArtifact(resolveArtifactApiPath(artifactInfo.zkeyPath), artifactInfo.zkeySha256, '증명 키(zkey)'),
      ]);
      const workerPayload: WorkerRequest = { inputs, wasmData, zkeyData };

      setLoadingMessage(
        <>
          영지식 증명을 생성하는 중...
          <br />
          (UI는 멈추지 않아요!)
        </>,
      );

      // --- 4. Run the proof worker ---
      const worker = new Worker(new URL('../../workers/proof.worker.ts', import.meta.url), { type: 'module' });
      worker.postMessage(workerPayload);

      // --- 5. Handle worker result ---
      worker.onmessage = async (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;

        if (message.status === 'success') {
          const { proof, publicSignals } = message;

          // The v2 circuit exposes exactly 4 public signals:
          // [root_out, vote_index, nullifier_hash, election_id].
          if (!Array.isArray(publicSignals) || publicSignals.length !== 4) {
            setLoadingMessage('');
            setErrorMessage('증명 형식이 올바르지 않습니다. 페이지를 새로고침한 뒤 다시 시도해주세요. (예상 공개 신호 4개)');
            worker.terminate();
            return;
          }

          setLoadingMessage('생성된 증명을 안전하게 제출하는 중...');

          // Reshape for the Solidity verifier; keep snarkjs order verbatim.
          // The B coordinates need each pair reversed (non-mutating copy).
          const formattedProof: FormattedProof = {
            a: proof.pi_a.slice(0, 2),
            b: proof.pi_b.slice(0, 2).map((row) => [...row].reverse()),
            c: proof.pi_c.slice(0, 2),
          };

          try {
            const jitterMs = calculateSubmissionJitterMs({ ticketIssuedAtMs: submissionTicketIssuedAtMs });
            await delay(jitterMs);

            // --- 6. Submit proof (anonymous; carries the single-use ticket) ---
            await axios.post(
              `/elections/${electionId}/submit`,
              { formattedProof, publicSignals, submissionTicket },
              { skipAuth: true },
            );

            // FE-3: the secret has served its purpose once the vote is on-chain.
            try {
              clearVoterSecret(electionId);
            } catch (e) {
              console.error('Failed to clear voter secret after vote:', e);
            }

            setLoadingMessage('');
            alert('투표가 성공적으로 제출되었습니다!');

            // UX-only: mark voted on this browser so the list hides the button.
            try {
              localStorage.setItem(`voted_${electionId}`, 'true');
            } catch (e) {
              console.error('Failed to save vote status to localStorage:', e);
            }

            navigate('/');
          } catch (submitError) {
            setLoadingMessage('');
            console.error('Failed to submit proof:', errorData(submitError));
            setErrorMessage(`투표 제출 실패: ${apiErrorMessage(submitError)}`);
            worker.terminate();
            return;
          }
        } else {
          setLoadingMessage('');
          setErrorMessage(`증명 생성 실패: ${message.message}`);
        }
        worker.terminate();
      };

      worker.onerror = (event: ErrorEvent) => {
        setLoadingMessage('');
        setErrorMessage(`Web worker initialization error: ${event.message}`);
        worker.terminate();
      };
    } catch (error) {
      setLoadingMessage('');
      console.error('Failed to fetch proof data or ticket:', errorData(error));
      setErrorMessage(`투표 실패: ${apiErrorMessage(error)}`);
    }
  };

  // --- Render ---
  if (loadingMessage) {
    return <div style={loadingOverlayStyle}>{loadingMessage}</div>;
  }

  if (errorMessage) {
    return (
      <div style={pageStyle}>
        <h2>오류</h2>
        <p style={{ color: 'red' }}>{errorMessage}</p>
        <button style={buttonStyle} onClick={() => navigate('/')}>메인으로 돌아가기</button>
      </div>
    );
  }

  if (!election) {
    return (
      <div style={pageStyle}>
        <h2>잘못된 접근입니다.</h2>
        <p>투표 정보를 찾을 수 없습니다. 메인 페이지에서 다시 시도해주세요.</p>
        <button style={buttonStyle} onClick={() => navigate('/')}>메인으로 돌아가기</button>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1>{election.name}</h1>
        <p>투표 마감일: {election.voting_end_time ? new Date(election.voting_end_time).toLocaleString() : '정보 없음'}</p>
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
