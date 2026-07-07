/**
 * @file frontend/src/pages/Admin/CreateVotePage.tsx
 * @desc Admin form to create a new election; submits to POST /api/elections/set.
 */
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { ArrowLeft, Plus, Save, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCreateElectionMutation } from '../../api/queries';
import { Button, Field, IconButton, PageShell, TextInput, ToastViewport } from '../../components/ui';
import { useToasts } from '../../components/useToasts';
import { errorData, errorMessage } from '../../utils/errors';

const SUPPORTED_DEPTHS = [4, 6, 8, 10] as const;
const MAX_SUPPORTED_CANDIDATES = 10;

function normalizeCandidates(candidates: string[]): string[] {
  return candidates.map((candidate) => candidate.trim()).filter(Boolean);
}

function CreateVotePage() {
  const [name, setName] = useState('');
  const [merkleTreeDepth, setMerkleTreeDepth] = useState<(typeof SUPPORTED_DEPTHS)[number]>(4);
  const [candidates, setCandidates] = useState<string[]>(['', '']);
  const [regEndTime, setRegEndTime] = useState('');

  const navigate = useNavigate();
  const createElection = useCreateElectionMutation();
  const { toasts, pushToast, dismissToast } = useToasts();

  const handleCandidateChange = (index: number, event: ChangeEvent<HTMLInputElement>) => {
    const newCandidates = [...candidates];
    newCandidates[index] = event.target.value;
    setCandidates(newCandidates);
  };

  const addCandidate = () => {
    setCandidates((current) => (current.length >= MAX_SUPPORTED_CANDIDATES ? current : [...current, '']));
  };

  const removeCandidate = (index: number) => {
    setCandidates((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== index)));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const finalCandidates = normalizeCandidates(candidates);
    if (!name.trim() || !regEndTime) {
      pushToast({ type: 'error', title: '필수 항목 누락', description: '투표 이름과 등록 마감 시간을 입력해야 합니다.' });
      return;
    }
    if (finalCandidates.length < 1) {
      pushToast({ type: 'error', title: '후보자 누락', description: '후보자를 최소 1명 이상 입력해야 합니다.' });
      return;
    }
    if (finalCandidates.length > MAX_SUPPORTED_CANDIDATES) {
      pushToast({
        type: 'error',
        title: '후보자 수 초과',
        description: `현재 회로 폭은 후보자 ${MAX_SUPPORTED_CANDIDATES}명까지 지원합니다.`,
      });
      return;
    }
    const candidateKeys = finalCandidates.map((candidate) => candidate.toLocaleLowerCase());
    if (new Set(candidateKeys).size !== candidateKeys.length) {
      pushToast({ type: 'error', title: '중복 후보자', description: '중복된 후보자 이름은 사용할 수 없습니다.' });
      return;
    }
    if (new Date(regEndTime) <= new Date()) {
      pushToast({ type: 'error', title: '마감 시간 오류', description: '등록 마감 시간은 현재 시간보다 미래여야 합니다.' });
      return;
    }

    try {
      await createElection.mutateAsync({
        name: name.trim(),
        merkleTreeDepth,
        candidates: finalCandidates,
        regEndTime: new Date(regEndTime).toISOString(),
      });
      pushToast({
        type: 'success',
        title: '투표 생성 완료',
        description: '관리 대시보드에서 ZK 설정 및 배포를 진행할 수 있습니다.',
      });
      navigate('/admin', { state: { toast: '투표가 생성되었습니다. ZK 설정 & 배포를 진행하세요.' } });
    } catch (error) {
      console.error('투표 생성 실패:', errorData(error));
      pushToast({ type: 'error', title: '투표 생성 실패', description: errorMessage(error) });
    }
  };

  return (
    <>
      <PageShell
        title="새로운 투표 생성"
        eyebrow="Admin"
        width="narrow"
        actions={
          <Button type="button" variant="secondary" icon={ArrowLeft} onClick={() => navigate('/admin')}>
            관리 대시보드
          </Button>
        }
      >
        <form className="form-grid" onSubmit={handleSubmit}>
          <Field label="투표 이름" htmlFor="voteName">
            <TextInput id="voteName" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>

          <Field label="유권자 등록 마감 시간" htmlFor="regEndTime">
            <TextInput
              id="regEndTime"
              type="datetime-local"
              value={regEndTime}
              onChange={(e) => setRegEndTime(e.target.value)}
              required
            />
          </Field>

          <Field label="머클 트리 깊이" hint="백엔드에 커밋된 Groth16Verifier_<depth>_10 아티팩트가 있는 bucket만 선택할 수 있습니다.">
            <div className="segmented-control" role="radiogroup" aria-label="머클 트리 깊이">
              {SUPPORTED_DEPTHS.map((depth) => (
                <label className="segmented-control__option" key={depth}>
                  <input
                    type="radio"
                    name="merkleTreeDepth"
                    value={depth}
                    checked={merkleTreeDepth === depth}
                    onChange={() => setMerkleTreeDepth(depth)}
                    aria-label={`Depth ${depth}`}
                  />
                  <span>
                    <strong>{depth}</strong>
                    <small>최대 {2 ** depth}명</small>
                  </span>
                </label>
              ))}
            </div>
          </Field>

          <Field
            label="후보자 목록"
            hint={`현재 배포 회로는 후보자 폭 ${MAX_SUPPORTED_CANDIDATES} 기준입니다. 실제 후보자는 ${MAX_SUPPORTED_CANDIDATES}명 이하로 제한됩니다.`}
          >
            <div className="candidate-list">
              {candidates.map((candidate, index) => (
                <div className="candidate-row" key={index}>
                  <TextInput
                    type="text"
                    value={candidate}
                    onChange={(e) => handleCandidateChange(index, e)}
                    placeholder={`후보 ${index + 1}`}
                    aria-label={`후보 ${index + 1}`}
                    required={index === 0}
                  />
                  <IconButton
                    type="button"
                    icon={Trash2}
                    label={`후보 ${index + 1} 제거`}
                    variant="danger"
                    onClick={() => removeCandidate(index)}
                    disabled={candidates.length <= 1}
                  />
                </div>
              ))}
            </div>
          </Field>

          <div className="page-shell__actions">
            <Button type="button" variant="secondary" icon={Plus} onClick={addCandidate} disabled={candidates.length >= MAX_SUPPORTED_CANDIDATES}>
              후보자 추가
            </Button>
            <Button type="submit" icon={Save} isLoading={createElection.isPending}>
              투표 생성하기
            </Button>
          </div>
        </form>
      </PageShell>
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

export default CreateVotePage;
