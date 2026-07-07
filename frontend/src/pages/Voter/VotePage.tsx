/**
 * @file frontend/src/pages/Voter/VotePage.tsx
 * @desc Individual voting page. Runs the full client-side ZK flow:
 *  1. Fetch proof data + single-use submission ticket from /proof (authenticated).
 *  2. Generate the ZK proof in a Web Worker.
 *  3. Submit proof + ticket to the anonymous /submit relayer endpoint.
 *  4. On success, mark this election as voted in localStorage (UX-only).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, CheckCircle2, Send } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../../api/client';
import type { FinalizedElectionView, FormattedProof } from '../../api/contracts';
import { useFinalizedElectionsQuery, useSubmitVoteMutation } from '../../api/queries';
import { Button, PageShell, ProgressOverlay, ToastViewport } from '../../components/ui';
import { useToasts } from '../../components/useToasts';
import { fetchVerifiedArtifact } from '../../utils/artifactIntegrity';
import { resolveArtifactApiPath } from '../../utils/apiBaseUrl';
import { calculateSubmissionJitterMs, delay } from '../../utils/submissionJitter';
import { clearVoterSecret, getVoterSecret } from '../../utils/voterSecret';
import { errorData, errorMessage as apiErrorMessage } from '../../utils/errors';
import type { ProofInputs, WorkerRequest, WorkerResponse } from '../../workers/proof.types';

interface ProgressState {
  title: ReactNode;
  detail?: ReactNode;
}

function terminateWorker(worker: Worker | null) {
  if (worker) {
    worker.terminate();
  }
}

function VotePage() {
  const { id: electionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const stateElection = (location.state as { vote?: FinalizedElectionView } | null)?.vote;
  const finalizedQuery = useFinalizedElectionsQuery(Boolean(electionId && !stateElection));
  const submitVote = useSubmitVoteMutation();
  const { toasts, pushToast, dismissToast } = useToasts();

  const election = useMemo(
    () => stateElection ?? finalizedQuery.data?.find((item) => item.id === electionId) ?? null,
    [electionId, finalizedQuery.data, stateElection],
  );

  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const workerRef = useRef<Worker | null>(null);
  useEffect(() => () => terminateWorker(workerRef.current), []);

  const handleVote = async () => {
    if (selectedCandidateIndex === null) {
      pushToast({ type: 'error', title: '후보자 선택 필요', description: '먼저 후보를 선택해주세요.' });
      return;
    }
    if (!election || !electionId) {
      return;
    }

    let submissionTicket: string | null = null;

    try {
      setErrorMessage('');
      setProgress({ title: '투표 증명 정보 요청 중', detail: '/proof는 인증된 요청이며 nullifier를 서버에 보내지 않습니다.' });

      const serverResponse = await apiClient.proof(electionId);
      const submissionTicketIssuedAtMs = Date.now();
      const { root, pathElements, pathIndices, submissionTicket: receivedTicket } = serverResponse;

      const userSecret = getVoterSecret(electionId);
      if (!userSecret) {
        throw new Error('이 브라우저에 저장된 투표 secret이 없습니다. 등록했던 브라우저에서 다시 시도해주세요.');
      }

      submissionTicket = receivedTicket;
      if (!submissionTicket) {
        throw new Error('Failed to retrieve submission ticket. Cannot proceed.');
      }

      setProgress({ title: '증명 아티팩트 확인 중', detail: 'manifest 해시와 다운로드한 wasm/zkey를 대조합니다.' });
      const artifactInfo = await apiClient.artifactInfo(electionId);

      const voteArray: number[] = new Array(artifactInfo.numOptions).fill(0);
      voteArray[selectedCandidateIndex] = 1;

      const inputs: ProofInputs = {
        root_in: root,
        user_secret: userSecret,
        vote: voteArray,
        pathElements,
        pathIndices,
        election_id: `0x${electionId.replace(/-/g, '')}`,
      };

      const [wasmData, zkeyData] = await Promise.all([
        fetchVerifiedArtifact(resolveArtifactApiPath(artifactInfo.wasmPath), artifactInfo.wasmSha256, '증명 회로(wasm)'),
        fetchVerifiedArtifact(resolveArtifactApiPath(artifactInfo.zkeyPath), artifactInfo.zkeySha256, '증명 키(zkey)'),
      ]);

      setProgress({ title: '영지식 증명 생성 중', detail: '브라우저 worker에서 proof를 생성합니다.' });
      const workerPayload: WorkerRequest = { inputs, wasmData, zkeyData };
      const worker = new Worker(new URL('../../workers/proof.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.postMessage(workerPayload);

      worker.onmessage = async (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;

        if (message.status !== 'success') {
          setProgress(null);
          setErrorMessage(`증명 생성 실패: ${message.message}`);
          terminateWorker(worker);
          workerRef.current = null;
          return;
        }

        const { proof, publicSignals } = message;
        if (!Array.isArray(publicSignals) || publicSignals.length !== 4) {
          setProgress(null);
          setErrorMessage('증명 형식이 올바르지 않습니다. 페이지를 새로고침한 뒤 다시 시도해주세요. (예상 공개 신호 4개)');
          terminateWorker(worker);
          workerRef.current = null;
          return;
        }

        setProgress({ title: '증명 제출 중', detail: '/submit은 single-use ticket만 사용하며 JWT를 첨부하지 않습니다.' });

        const formattedProof: FormattedProof = {
          a: proof.pi_a.slice(0, 2),
          b: proof.pi_b.slice(0, 2).map((row) => [...row].reverse()),
          c: proof.pi_c.slice(0, 2),
        };

        try {
          const jitterMs = calculateSubmissionJitterMs({ ticketIssuedAtMs: submissionTicketIssuedAtMs });
          await delay(jitterMs);

          await submitVote.mutateAsync({
            electionId,
            input: { formattedProof, publicSignals, submissionTicket: submissionTicket as string },
          });

          try {
            clearVoterSecret(electionId);
          } catch (e) {
            console.error('Failed to clear voter secret after vote:', e);
          }

          try {
            localStorage.setItem(`voted_${electionId}`, 'true');
          } catch (e) {
            console.error('Failed to save vote status to localStorage:', e);
          }

          setProgress(null);
          terminateWorker(worker);
          workerRef.current = null;
          navigate('/', { state: { toast: '투표가 성공적으로 제출되었습니다.' } });
        } catch (submitError) {
          setProgress(null);
          console.error('Failed to submit proof:', errorData(submitError));
          setErrorMessage(`투표 제출 실패: ${apiErrorMessage(submitError)}`);
          terminateWorker(worker);
          workerRef.current = null;
        }
      };

      worker.onerror = (event: ErrorEvent) => {
        setProgress(null);
        setErrorMessage(`Web worker initialization error: ${event.message}`);
        terminateWorker(worker);
        workerRef.current = null;
      };
    } catch (error) {
      setProgress(null);
      console.error('Failed to fetch proof data or ticket:', errorData(error));
      setErrorMessage(`투표 실패: ${apiErrorMessage(error)}`);
    }
  };

  if (finalizedQuery.isLoading && !election) {
    return (
      <PageShell title="투표 불러오는 중" width="narrow">
        <div className="panel">진행 중인 투표 목록에서 URL을 확인하고 있습니다.</div>
      </PageShell>
    );
  }

  if (errorMessage) {
    return (
      <>
        <PageShell
          title="투표 오류"
          width="narrow"
          actions={
            <Button type="button" variant="secondary" icon={ArrowLeft} onClick={() => navigate('/')}>
              메인으로 돌아가기
            </Button>
          }
        >
          <div className="error-banner" role="alert">{errorMessage}</div>
        </PageShell>
        <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  if (!election) {
    return (
      <PageShell
        title="투표를 찾을 수 없습니다"
        width="narrow"
        actions={
          <Button type="button" variant="secondary" icon={ArrowLeft} onClick={() => navigate('/')}>
            메인으로 돌아가기
          </Button>
        }
      >
        <div className="panel">
          직접 URL로 접근했거나 투표가 더 이상 진행 중 상태가 아닙니다. 메인 화면에서 현재 참여 가능한 투표를 다시 확인하세요.
        </div>
      </PageShell>
    );
  }

  return (
    <>
      <PageShell
        title={election.name}
        eyebrow={`투표 마감일: ${election.voting_end_time ? new Date(election.voting_end_time).toLocaleString() : '정보 없음'}`}
        width="narrow"
        actions={
          <Button type="button" variant="secondary" icon={ArrowLeft} onClick={() => navigate('/')}>
            메인으로
          </Button>
        }
      >
        <section className="panel">
          <div className="panel__header">
            <div>
              <h2>후보 선택</h2>
              <p>후보를 하나 선택한 뒤 브라우저에서 proof를 생성합니다.</p>
            </div>
          </div>

          <div className="vote-choice-list" role="listbox" aria-label="후보자 목록">
            {election.candidates.map((candidate, index) => (
              <button
                key={candidate}
                type="button"
                className="vote-choice"
                aria-pressed={selectedCandidateIndex === index}
                onClick={() => setSelectedCandidateIndex(index)}
              >
                <span>{candidate}</span>
                {selectedCandidateIndex === index && <CheckCircle2 className="ui-icon" aria-hidden="true" />}
              </button>
            ))}
          </div>

          <Button type="button" icon={Send} onClick={handleVote} disabled={Boolean(progress)} fullWidth>
            투표 제출하기
          </Button>
        </section>
      </PageShell>

      {progress && <ProgressOverlay title={progress.title} detail={progress.detail} />}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

export default VotePage;
