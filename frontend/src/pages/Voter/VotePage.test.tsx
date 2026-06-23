import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import VotePage from './VotePage';
import type { Election } from '../../types/domain';

// --- module mocks -----------------------------------------------------------
vi.mock('../../api/axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../../utils/voterSecret', () => ({
  getVoterSecret: () => 'secret-123',
  clearVoterSecret: vi.fn(),
}));
vi.mock('../../utils/artifactIntegrity', () => ({
  fetchVerifiedArtifact: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

import axios from '../../api/axios';

const ELECTION_ID = '00000000-0000-0000-0000-0000000000ab';
const election = {
  id: ELECTION_ID,
  name: 'Render Test Election',
  candidates: ['A', 'B'],
  voting_end_time: null,
  merkle_tree_depth: 4,
  num_candidates: 2,
} as unknown as Election;

// A Worker stub: jsdom has none, and we want to observe construction + terminate.
class MockWorker {
  static instances: MockWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  constructor() {
    MockWorker.instances.push(this);
  }
}

function renderVotePage() {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/vote/${ELECTION_ID}`, state: { vote: election } }]}>
      <Routes>
        <Route path="/vote/:id" element={<VotePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const proofOk = () =>
  (axios.post as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: { root: '1', pathElements: [], pathIndices: [], submissionTicket: 'tok' },
  });

beforeEach(() => {
  MockWorker.instances = [];
  vi.stubGlobal('Worker', MockWorker as unknown as typeof Worker);
  vi.stubGlobal('alert', vi.fn());
  (axios.post as ReturnType<typeof vi.fn>).mockReset();
  (axios.get as ReturnType<typeof vi.fn>).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('VotePage', () => {
  test('G5: aborts the vote when the artifact manifest is missing (no unverified fetch)', async () => {
    proofOk();
    // artifact-info 404 -> the verified path must fail closed, never spawn a worker.
    (axios.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      isAxiosError: true,
      message: 'not found',
      response: { status: 404, data: { error: 'ARTIFACTS_NOT_RECORDED' } },
    });

    renderVotePage();
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('투표 제출하기'));

    await waitFor(() => expect(screen.getByText('오류')).toBeInTheDocument());
    expect(screen.getByText(/투표 실패/)).toBeInTheDocument();
    // The defining G5 property: NO proof worker was ever constructed.
    expect(MockWorker.instances).toHaveLength(0);
  });

  test('L-fe-worker: terminates the proof worker if the page unmounts mid-proof', async () => {
    proofOk();
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        wasmPath: '/api/zkp-files/build_4_10/x.wasm',
        zkeyPath: '/api/zkp-files/build_4_10/x.zkey',
        wasmSha256: 'a'.repeat(64),
        zkeySha256: 'b'.repeat(64),
        verificationKeySha256: 'c'.repeat(64),
        publicSignalCount: 4,
        numOptions: 10,
      },
    });

    const { unmount } = renderVotePage();
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('투표 제출하기'));

    // The worker is created once the verified artifacts resolve; it never posts
    // back (proof still "in flight"), so its terminate is only reachable via the
    // unmount cleanup.
    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const worker = MockWorker.instances[0];
    expect(worker.terminate).not.toHaveBeenCalled();

    unmount();
    expect(worker.terminate).toHaveBeenCalled();
  });

  test('B4: pads the 1-hot vote vector to artifactInfo.numOptions (circuit width)', async () => {
    proofOk();
    // Election has 2 display candidates, but the padded circuit width is 10.
    (axios.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        wasmPath: '/api/zkp-files/build_4_10/x.wasm',
        zkeyPath: '/api/zkp-files/build_4_10/x.zkey',
        wasmSha256: 'a'.repeat(64),
        zkeySha256: 'b'.repeat(64),
        verificationKeySha256: 'c'.repeat(64),
        publicSignalCount: 4,
        numOptions: 10,
      },
    });

    renderVotePage();
    fireEvent.click(screen.getByText('A')); // index 0 of ['A','B']
    fireEvent.click(screen.getByText('투표 제출하기'));

    await waitFor(() => expect(MockWorker.instances).toHaveLength(1));
    const payload = MockWorker.instances[0].postMessage.mock.calls[0][0] as {
      inputs: { vote: number[] };
    };
    // The vote vector is padded to the circuit width (10), NOT the 2 candidates,
    // with exactly one 1 at the selected index.
    expect(payload.inputs.vote).toHaveLength(10);
    expect(payload.inputs.vote.filter((v) => v === 1)).toHaveLength(1);
    expect(payload.inputs.vote[0]).toBe(1);
  });
});
