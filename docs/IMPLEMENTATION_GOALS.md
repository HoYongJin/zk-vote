# zk-vote 구현 Goal 명세 (Phase 1 + E2E 진행 규칙)

> 목적: `goal` 명령의 조건이 4000자로 제한되므로, 상세 명세를 이 파일로 분리한다.
> 각 goal 프롬프트는 이 파일의 해당 섹션을 **반드시 먼저 읽고 그대로 따르라**고 지시한다.
> 1차 출처: `audit.md`(rev4), `docs/PROJECT_PLAN.md`(20-phase 플랜), `docs/ARCHITECTURE_REVIEW.md`(AR-* 항목).

---

## E2E 진행 규칙 (모든 phase/goal 공통 — 반드시 준수)

### 진행 순서
Phase 1 잔여(Goal 2 검증·완성 → Goal 3 → Goal 4 → Phase 1 게이트/DoD 실측 확인) → Phase 2 → Phase 3 → Phase 4 … 순서대로. 각 phase는 `docs/PROJECT_PLAN.md`의 해당 섹션이 명세이고, **verification gate가 수용 기준**이다.

### Phase별 공통 루프
1. PROJECT_PLAN의 해당 Phase 섹션 + ARCHITECTURE_REVIEW의 관련 AR-* 항목을 읽는다.
2. 현재 코드/워크트리 상태를 인벤토리해 이미 된 것과 남은 태스크를 구분한다(추측 금지, 실제 파일 확인).
3. 구현 → 테스트 → verification gate 항목을 **실측**(테스트 출력/명령 결과)으로 확인.
4. 논리 단위로 커밋(메시지에 phase/audit/AR ID 명시) → 변경 요약·커밋 해시·게이트 증거 보고 → 다음 단계.

### Git / 계정 규칙 (중요)
- **main에 커밋/푸시 절대 금지** — main push는 라이브 AWS EC2/S3/CloudFront 자동배포를 트리거한다(audit M11). M11 게이팅이 완료되기 전까지 main은 건드리지 않는다.
- 모든 작업은 phase/goal 단위 feature 브랜치: `codex/phase<N>-<slug>`.
- 원격은 `origin = git@github-hoyongjin:HoYongJin/zk-vote.git`(SSH alias). 푸시는 **`git push origin <branch>`만** 사용.
- **gh CLI/GitHub MCP 사용 금지(이 repo 한정)** — gh는 다른 계정(`liam191`)으로 로그인되어 있어 PR/푸시가 잘못된 계정으로 나간다. PR이 필요하면 푸시 후 사용자에게 URL을 보고.
- 비밀값(.env, PRIVATE_KEY, ptau 제외 대용량 바이너리) 커밋 금지. `*.ptau`는 gitignore됨.

### 환경 사실 (재검증 없이 사용 가능)
- circom 2.2.3: `/Users/jhy/.local/circom/bin/circom` (setUpZk 실행 시 `PATH` 또는 `CIRCOM_BIN` 지정). snarkjs는 로컬 `node_modules/.bin`. `server/zkp/powersOfTau28_hez_final_12.ptau`(blake2b 검증본, depth≤5) 존재. depth 6~10 빌드 필요 시 `_16.ptau`를 `storage.googleapis.com/zkevm/ptau/`에서 받아 snarkjs README 해시로 검증.
- gcloud 인증: `sujini000522@gmail.com`. **GCP 리소스 생성/변경(비용 발생)은 실행 전 보고하고 승인받는다.**
- Node 서버는 `server/.env`만 로드(루트 .env 아님). hardhat은 루트 `.env`(SEPOLIA_RPC_URL, PRIVATE_KEY).
- 표준 검증 명령: `npx hardhat test` / `node --check <파일>` / `cd rust-backend && cargo fmt --check && cargo test --workspace && cargo clippy --workspace -- -D warnings` / `cd frontend && npm run build`.

### 불변 원칙
- Node public API 경로·응답 형태 유지(API_COMPATIBILITY.md v2가 기준), 익명 submit 모델 유지(JWT submit 금지).
- 서버는 평문 voter secret·nullifier를 제출 전에 알면 안 된다(H2/AR-H5 모델).
- 막히면 조사·검증을 직접 수행한다. **멈추는 경우는 오직**: 사용자 자격증명 필요 / 비용 발생 승인 필요 / 파괴적·되돌리기 어려운 결정 필요.

### 후속 goal 템플릿 (Phase 4 이후 재사용)
> zk-vote Phase N(<이름>)을 docs/PROJECT_PLAN.md 해당 섹션대로 완료하라. 시작 전 docs/IMPLEMENTATION_GOALS.md의 "E2E 진행 규칙"과 PROJECT_PLAN Phase N 전체, ARCHITECTURE_REVIEW의 관련 AR 항목을 읽어라. 수용 기준: Phase N verification gate 전 항목 실측 통과 + DoD 충족 + 변경 요약/커밋 해시/게이트 증거 보고.

---

## Goal 1 — C1+H1: 회로/컨트랙트 v2

zk-vote Phase 1 audit-blocker 중 C1+H1 회로/컨트랙트 v2를 구현하라.

### 먼저 반드시 직접 읽어라

- `audit.md` rev4의 C1, H1 항목
- `docs/PROJECT_PLAN.md`의 "Phase 1. Audit Blocker Rebaseline"
- `server/zkp/circuits/VoteCheck.circom`
- `contracts/VotingTally.sol`
- `server/routes/submitZk.js`
- `server/utils/submitValidation.js`
- `frontend/src/pages/Voter/VotePage.js`
- `test/VotingTally.js`, `test/submitValidation.js`, `test/submitZkRoute.js`

### 작업 전 규칙

- 현재 브랜치를 확인하고, main이면 feature 브랜치를 먼저 만들어라. 예: `codex/phase1-c1-h1-circuit-contract-v2`.
- 기존 dirty worktree 변경을 되돌리지 마라.
- 코드 변경 전 현재 상태를 파악하고, 불확실하면 조사/검증을 직접 수행하라.
- Node 백엔드 기존 public API path는 유지한다.
- `/submit`은 계속 익명 제출 모델을 유지한다. JWT submit으로 바꾸지 마라.
- 이번 goal은 C1+H1이다. H2 secret model, H3/H4 lifecycle, M1 ticket consume refactor는 별도 goal로 남긴다. 단, C1+H1 때문에 필요한 submit validation 변경은 수행한다.

### 중요한 호환성 결정

- `VotingTally.submitTally`가 `uint256[3]`에서 `uint256[4]` public input으로 바뀌므로 기존 v1 배포 컨트랙트와 ABI 호환은 깨진다.
- 이 작업에서는 v1 선거를 production/staging 후보로 보지 않는다. 새 v2 artifact/contract 기준으로 proof-submit 경로를 맞춘다.
- 기존 v1 deployed election을 자동 마이그레이션하지 말고, 필요한 경우 재배포/차단이 필요하다는 점을 변경 요약에 명시하라.

### 선결 조건 M2

- `circom` 설치 여부를 확인하라.
- `snarkjs`는 전역 설치하지 말고 repo/local `node_modules/.bin/snarkjs` 또는 `npx snarkjs`를 사용하라.
- `server/zkp/`에 필요한 `.ptau`가 없으면 공식 출처에서 다운로드하고 체크섬 검증을 수행하라.
  - depth <= 5: `powersOfTau28_hez_final_12.ptau`
  - depth <= 10: `powersOfTau28_hez_final_16.ptau`
  - depth <= 20: `powersOfTau28_hez_final_20.ptau`
- 체크섬을 검증할 수 없으면 임의로 진행하지 말고 중단하고 보고하라.

### 구현 범위

#### 1. 회로 수정 — `server/zkp/circuits/VoteCheck.circom`

- `MerkleProof` 루프 내부에 모든 레벨에 대해 다음 boolean constraint를 추가하라:
  `pathIndices[i] * (1 - pathIndices[i]) === 0;`
- `election_id`를 공개 신호로 노출하라.
  권장 방식: `component main {public [election_id]} = Main(...);`
- 기존 outputs는 유지한다: `[root_out, vote_index, nullifier_hash]`
- 재생성 후 snarkjs public signal 순서를 실제로 확인하라. 예상 순서는
  `[root_out, vote_index, nullifier_hash, election_id]`
  단, 추정으로 구현하지 말고 `verification_key.json`/실제 proof output으로 확정하라.

#### 2. artifact 재생성 범위 확정 및 실행

- 먼저 현재 artifact inventory를 만들라:
  - `server/zkp/build_*`
  - `contracts/Groth16Verifier*.sol`
  - `server/zkp/build_*/verification_key.json`
- active artifact set은 `server/zkp/build_*` 중 `verification_key.json`과 `circuit_final.zkey`가 있는 조합으로 본다.
- active 조합은 모두 `server/zkp/setUpZk.sh`로 재생성하라.
- contract만 있고 build directory가 없는 orphan verifier는 임의 삭제하지 말고, 실제 deploy/setup 경로에서 참조되는지 확인한 뒤 필요 시 재생성하거나 변경 요약에 orphan으로 명시하라.
- 재생성 후 각 active `verification_key.json`의 `nPublic`이 `4`인지 확인하라.
- 생성된 Solidity verifier의 public input 배열 크기도 `uint[4]`인지 확인하라.

#### 3. 컨트랙트 수정 — `contracts/VotingTally.sol`

- `IVerifier.verifyProof` input을 `uint256[4] memory input`으로 바꿔라.
- `submitTally`의 `publicInputs`도 `uint256[4] memory`로 바꿔라.
- public input index 상수를 쓰거나 명확한 local variable로 분리하라:
  - root index: 0
  - candidate index: 1
  - nullifier hash index: 2
  - election id index: 3 — 단, 1단계에서 확정한 실제 순서를 따를 것
- `verifier.verifyProof` 호출 전에 다음 검증을 추가하라:
  `require(publicInputs[ELECTION_ID_INDEX] == electionId, "VotingTally: Invalid election id");`
- 기존 root, nullifier, candidate guard는 유지하라.

#### 4. 백엔드 submit validation 수정

대상:

- `server/utils/submitValidation.js`
- `server/routes/submitZk.js`
- 필요 시 `server/utils/merkle.js`의 `electionIdToBigInt` export 또는 shared helper 분리

요구사항:

- `publicSignals.length !== 3` 가드를 `4`로 바꿔라.
- magic index를 상수화하라:
  - `PUBLIC_SIGNAL_ROOT_INDEX`
  - `PUBLIC_SIGNAL_CANDIDATE_INDEX`
  - `PUBLIC_SIGNAL_NULLIFIER_INDEX`
  - `PUBLIC_SIGNAL_ELECTION_ID_INDEX`
- route `election_id`를 `electionIdToBigInt` 방식과 동일하게 BigInt로 변환하고, public signal의 election id와 비교하라.
- mismatch 시 400 계열 에러를 반환하라. 예: `ELECTION_ID_MISMATCH`.
- 기존 ticket election/root/nullifier 검증은 유지하라.
- submit route에서 nullifier lock key도 새 index 상수를 사용하도록 바꿔라.
- anonymous submit 모델은 유지하라.

#### 5. 프론트 수정 — `frontend/src/pages/Voter/VotePage.js`

- snarkjs가 반환한 `publicSignals`를 수동 reorder하지 말고 그대로 submit하라.
- 회로 input의 `election_id`는 backend와 같은 값이 되도록 UUID dash 제거 hex 형식을 유지하거나 helper화하라.
- 가능하면 proof 생성 성공 후 `publicSignals.length === 4` sanity check를 추가하고, 아니면 사용자에게 명확한 에러를 표시하라.
- submit 실패 시 loading state가 해제되는 기존 동작을 유지하라.

#### 6. Solidity 테스트 보강

- MockVerifier는 JS 테스트 내부가 아니라 Solidity contract로 추가하라.
  예: `contracts/test/MockVerifier.sol` 또는 `contracts/MockVerifier.sol`
- MockVerifier signature는 반드시 새 interface와 같아야 한다:
  `verifyProof(..., uint256[4] memory input) external view returns (bool)`
- 설정형 bool 반환이 가능하게 하라.
- `test/VotingTally.js`에 다음을 검증하라:
  - 정상 투표 성공 + `voteCounts` 증가
  - 동일 nullifier 재제출 거부
  - 잘못된 election_id public signal 거부
  - 잘못된 root 거부
  - 범위 밖 candidate 거부
  - verifier false면 invalid proof로 거부

#### 7. 실제 회로 테스트로 H1 검증

MockVerifier만으로 H1은 검증할 수 없다. 실제 circuit artifact를 사용하는 테스트를 추가하라. 권장:

- active build 중 하나(예: `build_4_5`)로 valid input을 생성한다.
- `snarkjs.groth16.fullProve` + `snarkjs.groth16.verify`로 정상 proof가 통과하는지 확인한다.
- 같은 input에서 `pathIndices[0] = 2` 같은 non-boolean 값을 넣었을 때 witness/proof generation 또는 verification이 실패하는지 확인한다.
- 이 테스트가 너무 느리면 별도 describe/test로 분리하되, 수용 기준에는 반드시 포함하라.

#### 8. 백엔드 테스트 갱신

- `test/submitValidation.js`를 4-public-signal 형태로 갱신하라.
- 다음 케이스를 추가/갱신하라:
  - valid `[root, candidateIndex, nullifierHash, electionId]`
  - wrong election public signal
  - malformed publicSignals length 3 거부
  - root mismatch
  - nullifier mismatch
  - candidate overflow
- `test/submitZkRoute.js`의 malformed test도 4-signal 기준으로 갱신하라.

### 검증 명령

- `bash -n server/zkp/setUpZk.sh`
- 변경한 JS 파일들에 대해 `node --check`
  - `server/routes/submitZk.js`
  - `server/utils/submitValidation.js`
  - `frontend/src/pages/Voter/VotePage.js`
- `npx hardhat test`
- artifact 확인:
  - active `server/zkp/build_*/verification_key.json`의 `nPublic == 4`
  - regenerated verifier Solidity가 `uint[4]` public input을 사용

### 수용 기준

- registered voter가 `election_id`를 바꿔 다른 nullifier로 2표를 통과시킬 수 없다.
- non-boolean Merkle `pathIndices`를 가진 증명은 실제 circuit/verifier 경로에서 거부된다.
- 새 public signal shape `[root, vote_index, nullifier_hash, election_id]`로 proof→submit 정상 경로가 동작한다.
- MockVerifier 테스트가 success/duplicate nullifier/wrong election/wrong root/out-of-range candidate를 모두 검증한다.
- backend submit validation 테스트가 4-signal 형태를 강제한다.
- 완료 시 변경 요약, regenerated artifact 조합, 확정한 public signal order, 통과한 테스트 출력을 보고하라.

---

## Goal 2 — H2: client-held voter secret

zk-vote Phase 1 H2를 구현한다(`audit.md` H2 + `docs/PROJECT_PLAN.md` 해당 phase 참조). 목표: 서버가 voter secret을 생성·저장·반환하지 않게 한다.

- (a) 클라이언트가 고엔트로피 secret을 생성·보관한다(`crypto.getRandomValues`/`crypto.randomBytes`).
- (b) `server/routes/register.js`는 결정적 `SHA256(user_id + SECRET_SALT)` 생성을 제거하고, leaf 커밋먼트 `H(secret)`만 DB에 저장한다.
- (c) `server/routes/proof.js`는 plaintext `user_secret`을 반환하지 않고, nullifier를 서버에서 계산/저장하지 않는다.
- (d) `server/utils/merkle.js`의 leaf/proof 로직과 프론트 등록·proof 플로우를 commitment 기반으로 조정한다.

수용 기준: `/proof` 응답에 plaintext secret이 없고, 서버가 nullifier↔유권자를 연결할 수 없다. 회귀 테스트 추가.

---

## Goal 3 — H3/H4(+M3/M13): 배포·finalize·등록 락 내구 안전성

zk-vote Phase 1 H3/H4와 M3/M13을 구현한다(`audit.md` H3/H4/M3/M13 + `docs/PROJECT_PLAN.md` 해당 phase 참조).

- (a) `/setZkDeploy`(`server/routes/setupAndDeploy.js`)에 election_id+아티팩트 조합 키 Redis 락 또는 조건부 DB `deploying` 마커를 추가해 중복 온체인 배포·동시 아티팩트 생성을 차단한다.
- (b) finalize(`server/routes/finalizeVote.js`)는 온체인 tx 전 Postgres에 내구적 `finalizing` 상태를 기록하고(`addUserSecret`/`registerByAdmin`이 fail-closed로 등록 거부), 락 fencing/갱신을 적용하며, tx 확정 후 DB sync 전 voter 스냅샷을 재검증한다.
- (c) M3: on-chain-configured 마커를 Redis 대신 Postgres 컬럼으로 내구화한다.
- (d) M13: `addUserSecret` 등록 락의 TTL을 최악 케이스 트리 작업 시간 이상으로 상향하고, `Voters` UPDATE 직전에 락 소유(fencing 토큰)를 재확인한다 (architecture review AR-L10).

수용 기준: 동시 setup이 mismatched 아티팩트를 만들 수 없고, finalize 진행 중 등록이 막히며, 온체인 성공/DB 실패 상황이 복구 가능하고, 등록 락이 TTL 만료 후 늦게 도착한 쓰기로 트리를 오염시킬 수 없다.

---

## Goal 4 — H5 + staging Medium (M1/M12, M2/M4/M5, M9/M10/M11)

zk-vote Phase 1의 나머지를 구현한다(`audit.md` H5·M1·M2·M4·M5·M9·M10·M11·M12 + `docs/PROJECT_PLAN.md` Phase 1/8 참조).

- H5: `AdminInvitations` 수락/인증 시 `Admins` 승격 경로를 구현한다.
- M1/M12: 티켓을 검증 후에만 소비(ticket-scoped 락 또는 Lua read-validate-consume), 프론트 submit 실패 처리·로딩 해제.
- M2/M4/M5: `.ptau` 프로비저닝·circom 설치 문서화, 후보 수 상한·중복 거부, 아티팩트를 (depth,candidates)가 아닌 회로 버전/해시에 바인딩.
- M9/M10/M11: GCP secretAccessor를 `zkvote-staging-*` 비밀별로 한정, Cloud SQL DB URL secret을 SQL 사용자 생성 직후 기록, AWS EC2/S3/CloudFront main-push 자동배포 게이팅.

각 항목에 테스트/검증을 추가한다.
