# zk-vote 보안 감사 보고서 (audit.md)

- **대상**: `zk-vote` (Node/Express 백엔드, Circom/snarkjs ZK, Solidity `VotingTally`, Supabase/Postgres, Rust 백엔드 스캐폴드, GCP 인프라, React 프론트엔드)
- **기준 커밋/브랜치**: `main` (더티 워크트리 상태 그대로 검토)
- **감사일**: 2026-06-11
- **방법**: 실제 소스 정독 + 10개 영역 병렬 리뷰 → 발견별 적대적 검증(verdict) → 완전성 비평. 총 51개 고유 발견 검증.
- **요약**: Critical 1, High 5, Medium 13, Low/개선 다수. 거짓 양성 1건은 강등 처리(아래 명시).

> **승격 완료 (2026-06-12)**: 정식 산출물 `docs/SECURITY_REVIEW.md`가 생성되었다 — 클로저 상태·신뢰 경계·위협 모델은 그쪽이 권위이며, 이 파일은 발견 본문·증거의 원본으로 유지된다.
>
> **개정 이력**:
> - rev2 (2026-06-11) — 코드 리뷰 피드백을 실제 코드로 재검증해 C1 fix 범위, H1 전제조건, M1 fix 원자성, 검증표(cargo test), M2/검증표(snarkjs), 문서 불일치 #8·#11을 정정.
> - rev3 (2026-06-11) — 요약표 M2 줄을 본문과 일치(`circom/snarkjs` → `circom`)시키고, C1 evidence의 `component main`을 source(`Main(3,3)`) vs 빌드 산출물(`build_4_5`=`Main(4,5)`, `build_5_4`=`Main(5,4)`)로 구분해 정정.
> - rev4 (2026-06-11) — 요약표 M11 줄을 본문과 일치(백엔드 EC2 단독 → 백엔드 EC2 + 프런트 S3/CloudFront)시킴.
> - rev5 (2026-06-12) — **Phase 1 클로저 기록**: C1·H1~H5 전체 및 M1~M5/M9~M13 수정 완료(코드+테스트 증거, 아래 클로저 매트릭스). 같은 날 Phase 3 완료로 **M6~M8도 닫힘**(`rust-backend/migrations/0003` + `docs/DATA_MODEL.md` + `scripts/local/db-verify.sh` 게이트). 본문 발견 서술은 감사 시점 기준 원문 그대로 유지한다 — 현재 상태는 매트릭스가 우선.

---

## 심각도 요약

| ID | 심각도 | 위치 | 한 줄 요약 |
|----|--------|------|-----------|
| C1 | **Critical** | `VotingTally.sol` + `VoteCheck.circom` | `election_id`가 회로 private 입력이라 nullifier가 온체인에서 election에 바인딩되지 않음 → 무제한 다중 투표 |
| H1 | **High** | `VoteCheck.circom` MerkleProof | `pathIndices` 부울 제약 누락 → 멤버십/자격 위조, 표 부풀리기 |
| H2 | **High** | `register.js` + `proof.js` + `VotePage.js` | 서버가 user_secret을 결정적 생성·평문 보관 → 운영자에 대한 투표 비밀 붕괴 |
| H3 | **High** | `setupAndDeploy.js` | `/setZkDeploy` 동시성 락 부재 → 중복 배포·verifier 불일치 → 선거 영구 정지 |
| H4 | **High** | `finalizeVote.js` | finalize 크래시/타임아웃 비안전 → 등록 레이스 → 전체 투표 DoS/검열 |
| H5 | **High** | `addAdmins.js` | 관리자 초대가 소비되지 않아 미가입 초대자에게 권한 영구 미부여 |
| M1 | Medium | `submitZk.js` | 단일사용 티켓이 의미 검증·릴레이 이전에 소비됨 → 일시 오류 시 표 손실 |
| M2 | Medium | `setUpZk.sh` / `setupAndDeploy.js` | `.ptau` 부재 + circom 미설치 → 새 (depth,candidates) 배포 불가 (snarkjs는 로컬 bin으로 가용) |
| M3 | Medium | `finalizationState.js` | 온체인 구성 마커가 fail-open + TTL 없음 → 부분 실패 시 등록 재개/검열 |
| M4 | Medium | `setVote.js` | 후보 수 상한·중복 검사 없음 → 회로 생성/배포 마비 가능 |
| M5 | Medium | `setUpZk.sh` | 아티팩트가 (depth,candidates)로만 키잉 + 재생성 시 새 난수 → 기배포 선거 proof 영구 무효화 |
| M6 | Medium | `0002_node_api_compatibility.sql` | "Node API 호환" 마이그레이션이 실제로는 호환 불가 (PascalCase vs snake_case) |
| M7 | Medium | `0001_initial.sql:31` | `elections.circuit_id`가 NOT NULL + DEFAULT 없음 → Node식 insert 불가 |
| M8 | Medium | `0001_initial.sql` | `numeric(78,0)` vs BigInt 문자열 직렬화 불일치 |
| M9 | Medium | `zkvote-staging-setup.sh:73-78` | `secretmanager.secretAccessor`를 프로젝트 레벨 부여 → 최소권한 위반 (자기 규칙 위반) |
| M10 | Medium | `zkvote-staging-setup.sh:106-163` | DB 비밀번호 lifecycle 버그 → `set -e` 중단 시 secret 미기록 |
| M11 | Medium | `.github/workflows/deploy-backend.yml` + `deploy-frontend.yml` | main push마다 라이브 AWS 자동 배포 (백엔드 EC2 + 프런트 S3/CloudFront), `appleboy/ssh-action@master` 가변 ref |
| M12 | Medium | `VotePage.js:111-157` | submit 에러 미처리 → 영구 로딩 + 티켓 소비됨 |
| M13 | Medium | `redisLock.js` + `merkle.js` | 등록 락 10초 TTL + fencing 부재 → H4 레이스 강화 |

---

## Phase 1 클로저 매트릭스 (rev5, 2026-06-12)

> 기준 브랜치 `codex/phase1-c1-h1-circuit-contract-v2`. 증거 테스트는 `npx hardhat test` **64 passing** 기준. 본문 발견 서술은 감사 시점(rev4) 원문이며, 현재 상태는 이 표를 따른다.

| ID | 상태 | 수정 요지 / 위치 | 테스트 증거 |
|----|------|------------------|-------------|
| C1 | **CLOSED** | 회로 `{public [election_id]}` + `VotingTally.submitTally`가 `publicInputs[3]==electionId` 검증 (`VoteCheck.circom`, `VotingTally.sol`), 백엔드 `ELECTION_ID_MISMATCH` 선검증 | `voteCircuit.js` "rejects a real proof generated for a different election_id"(실증명 온체인 거부), `VotingTally.js` wrong-election, `submitValidation.js` C1 케이스 |
| H1 | **CLOSED** | MerkleProof 전 레벨 `pathIndices[i]*(1-pathIndices[i])===0` + 아티팩트 재생성(nPublic=4) | `voteCircuit.js` "rejects a witness whose pathIndices is non-boolean" (witness 생성 실패 실측) |
| H2 | **CLOSED** | secret은 클라이언트 생성·localStorage 보관(`frontend/src/utils/voterSecret.js`), 서버는 `H(secret)` 커밋먼트만 저장(`register.js`/`merkle.js`), `/proof` 평문 무반환·nullifier 미계산(`proof.js`), 티켓은 election+root만 바인딩(AR-H5) | `registerRoute.js`, `proofRoute.js`(no `user_secret`), `submissionTickets.js`, `poseidonCompat.js`(프론트 poseidon-lite ↔ 백엔드 circomlibjs 비트동일) |
| H3 | **CLOSED** | `/setZkDeploy` 전체를 `zkdeploy:artifact:<depth>:<cand>` Redis 락으로 직렬화 + 락 내 `ALREADY_DEPLOYED` 재확인 + 아티팩트 스키마 게이트(nPublic=4, uint[4]) (`setupAndDeploy.js`) | `setupAndDeployRoute.js` (pre-lock 거부 + in-lock TOCTOU 재확인) |
| H4 | **CLOSED** | 온체인 부수효과 **이전** Postgres `registration_end_time` 내구 마감, 락 fencing 재확인, tx 후 스냅샷 재검증(불일치 시 중단), 컨트랙트 기구성 시 멱등 복구 (`finalizeVote.js`) | `finalizeVoteRoute.js` 4케이스(ordering / idempotent recovery / root mismatch 거부 / snapshot-changed 중단) |
| H5 | **CLOSED** | `AdminInvitations`를 인증 시점에 소비·승격 — `auth`+`authAdmin` 양쪽(프론트가 admin UI를 숨겨도 첫 인증 요청에서 발동), 기존 사용자 승격 실패는 `ADMIN_PROMOTION_FAILED`로 가시화 (`adminInvitations.js`, `middleware/auth*.js`, `addAdmins.js`) | `authMiddleware.js`, `adminInvitations.js`, `addAdminsRoute.js` |
| M1 | **CLOSED** | 티켓별 락 안에서 read(peek)→검증→통과 시에만 GETDEL 소비; preflight/의미 검증 실패는 티켓 보존 (`submitZk.js`) | `submitZkRoute.js` (semantic-fail 미소비 / replay 403 / preflight-fail 미소비 / 온체인 중복 미소비) |
| M2 | **CLOSED**(local) | circom 2.2.3 소스 빌드, `_12.ptau` blake2b-512 검증본 프로비저닝, `/setZkDeploy` 사전점검(circom 바이너리 + depth별 ptau) (`setupAndDeploy.js`) | 사전점검 코드 경로 + 실증명 테스트가 로컬 툴체인으로 통과. 스테이징 프로비저닝은 Phase 2/16 추적 |
| M3 | **CLOSED**(설계 변경) | Redis 마커 대신 **Postgres `registration_end_time` 내구 마감이 fail-closed 게이트**(tx 브로드캐스트 전 설정). Redis 마커는 보조로 유지 | `registerRoute.js`/`registerByAdminRoute.js` durable-close 거부, `finalizeVoteRoute.js` ordering |
| M4 | **CLOSED** | 후보 수 상한(5)·트림 후 대소문자 무시 중복 거부·depth 상한 (`setVote.js`), 배포측 상한 재검증 (`setupAndDeploy.js`) | `setVote` 검증 로직 + 배포측 캡 (코드 경로) |
| M5 | **CLOSED**(Phase 1 범위) | 배포 시 zkey/vkey/wasm sha256을 선거별 manifest에 기록(`deployAll.js`→`zkArtifacts.js`), `/proof`가 드리프트 시 `ARTIFACT_MISMATCH` 409 | `zkArtifacts.js` 5케이스, `proofRoute.js` ARTIFACT_MISMATCH. 완전한 manifest 저장은 Phase 10 |
| M6 | **CLOSED**(Phase 3, 2026-06-12) | 결정: Cloud SQL은 snake_case 전용(PascalCase 테이블/뷰 불채택 — PostgREST 소멸+백엔드 경유 전제), Node↔Rust 매핑 표 + ETL 계획 문서화(`docs/DATA_MODEL.md`), `0003`이 레거시 `title`/`*_at` 스키마를 정식 형태로 수렴 | `scripts/local/db-verify.sh` 전 게이트 통과(레거시 볼륨 + 신규 DB 양쪽) |
| M7 | **CLOSED**(Phase 3) | `elections.circuit_id` nullable로 변경(`0003`), 아티팩트 선택 시 백필 | `db-verify.sh`: Node식 insert(circuit_id 없음) 성공 게이트 |
| M8 | **CLOSED**(Phase 3) | field element를 `text` + `CHECK('^[0-9]+$')`로 전환(`0003`), 평문 `voters.user_secret` 컬럼 제거 | `db-verify.sh`: 77자리 round-trip 정확 일치 + `0x…` 거부 게이트 |
| M9 | **CLOSED** | `secretAccessor`를 `zkvote-staging-*` 비밀별 부여로 전환 (`zkvote-staging-setup.sh`) | 스크립트 검토: 프로젝트 레벨 잔여 부여는 cloudsql.client/logging/monitoring뿐 |
| M10 | **CLOSED** | `gcloud sql users create` 직후 database-url secret 버전 기록 | 스크립트 검토 (`SQL_USER_CREATED`/`DATABASE_URL_SECRET_WRITTEN` 가드) |
| M11 | **CLOSED** | 두 워크플로우 `workflow_dispatch` 전용 + `legacy-aws-production` environment + `ssh-action@v1.2.0` 핀 | `.github/workflows/*` diff — main push 트리거 제거 |
| M12 | **CLOSED** | submit await try/catch, 실패 시 로딩 해제 + `details` 표시 (`VotePage.js`) | 코드 경로 + `cd frontend && npm run build` 통과 |
| M13 | **CLOSED** | 등록 임계구역 60s 락 + `Voters` UPDATE 전·후 `isRedisLockHeld` fencing 재확인 (`merkle.js`) | `redisLock.js` 단위 테스트(토큰 스코프) + `merkle.js` 코드 경로 |

추가로 아키텍처 리뷰의 Phase 1 즉시 항목 반영: **AR-H2**(2^depth 용량 가드, `OVER_CAPACITY` — `registerByAdminRoute.js` 테스트), **AR-H5**(티켓 nullifier 바인딩 제거), **AR-L10**(M13 위 참조).

---

## Critical

### C1 — nullifier가 election에 온체인 바인딩되지 않아 무제한 다중 투표 가능

- **Severity**: Critical
- **File/Line**: `contracts/VotingTally.sol:135-169`, `server/zkp/circuits/VoteCheck.circom:132-135,154,185`, `server/zkp/build_*/VoteCheck_temp.circom:154`
- **Flow**: 익명 투표 제출 / 온체인 집계 무결성
- **Problem**:
  회로의 `election_id`는 **private 입력**이고, `component main = Main(...)`에 `{public [...]}` 선언이 없어 공개 신호는 출력 3개 `[root_out, vote_index, nullifier_hash]`뿐이다(직접 확인: `verification_key.json`의 `nPublic = 3`, `Groth16Verifier_*.sol`의 `uint[3]`). nullifier는 `Poseidon(user_secret, election_id)`인데, `submitTally`는 컨트랙트의 불변 `electionId`를 증명과 한 번도 대조하지 않는다. 따라서 등록된 유권자 1명이 `election_id` 값을 0, 1, 2, … 로 바꿔가며 **같은 user_secret·같은 merkleRoot로 서로 다른 nullifier를 무제한 생성**할 수 있고, 각 증명은 root 일치·후보 범위·미사용 nullifier·verifyProof를 모두 통과한다. `submitTally`는 권한 없는 `external` 함수이며 wasm/zkey가 `/api/zkp-files`로 공개 제공(`server/index.js:42`)되므로, 공격자는 릴레이어와 단일사용 티켓을 **완전히 우회**해 컨트랙트를 직접 호출한다. 결과는 표 부풀리기/무제한 이중투표로 집계 무결성 자체가 붕괴된다. 온체인 `usedNullifiers` 매핑은 동일 nullifier만 중복 제거할 뿐, 동일 인물을 막지 못한다.
- **Evidence**:
  - `VoteCheck.circom:134`: `nullifierHasher.inputs[1] <== election_id;`
  - `server/zkp/circuits/VoteCheck.circom:154`: `signal input election_id;` (private). `component main`에 `{public [...]}` 선언 없음 — source(`circuits/VoteCheck.circom:185`)는 `Main(3, 3)`, 빌드 산출물(`build_4_5/VoteCheck_temp.circom:185`)은 `Main(4, 5)`, `build_5_4`는 `Main(5, 4)`로 **셋 다 public 선언 없음**(따라서 어느 버전이 배포돼도 공개 신호는 출력 3개뿐)
  - `VotingTally.sol:152-164`: `require(!usedNullifiers[nullifierHash])` 후 `usedNullifiers[nullifierHash] = true;` 만 수행. `electionId`(생성자 `:67-72`)는 `submitTally`에서 참조되지 않음
  - 백엔드는 `merkle.js:86-92`에서 `Poseidon(user_secret, electionIdToBigInt(election_id))`로 nullifier를 계산하지만 온체인에서 동일 election_id 사용을 강제하는 장치 없음
  - 3명의 ZK/Solidity 리뷰어가 독립적으로 동일 결론, 모든 verdict `isReal=true`
- **Fix**:
  `election_id`(또는 `electionIdToBigInt` 값)를 회로의 **공개 신호로 노출**(`component main {public [election_id]} = Main(...)` 또는 출력 추가) → 모든 `Groth16Verifier_*.sol` / zkey / wasm 재생성. `IVerifier`의 입력을 `uint256[4]`로 확장하고 `submitTally`에서 verifyProof 이전에 `require(publicInputs[<idx>] == electionId, "bad election")` 추가(snarkjs 공개 신호 순서에 맞춤). 이렇게 하면 (유권자, 선거)당 nullifier가 결정적이 되어 대체 nullifier 발행이 불가능해진다.
  - **수정 범위가 회로/컨트랙트에 그치지 않음**: 공개 신호가 3→4개로 바뀌면 백엔드·프론트 경계도 함께 고쳐야 한다. 구체적으로 `server/routes/submitZk.js:85`와 `server/utils/submitValidation.js:46`의 `publicSignals.length !== 3` 가드, `submitValidation.js:56-58`/`submitZk.js:185`의 `publicSignals[0..2]` 인덱스, 그리고 `frontend/src/pages/Voter/VotePage.js`의 submit 페이로드(snarkjs `publicSignals` 전달)를 새 길이/순서에 맞게 갱신해야 한다. 이 4곳을 함께 바꾸지 않으면 정상 투표가 모두 `INVALID_PAYLOAD`로 거부된다.

---

## High

### H1 — Merkle 회로의 `pathIndices` 부울 제약 누락 → 자격/멤버십 위조 (두 번째 독립 soundness 결함)

- **Severity**: High *(원 리뷰어 Low → 적대적 검증에서 High로 상향, high confidence)*
- **File/Line**: `server/zkp/circuits/VoteCheck.circom:45-58` (및 `VoteCheck_3.circom:40-46`, 빌드된 회로 동일)
- **Flow**: 투표 제출 / 유권자 자격 증명
- **Problem**:
  `MerkleProof` 템플릿에서 `pathIndices[i]`가 `left = (1-idx)*cur + idx*elem` 형태의 선택자로 쓰이지만 **부울 제약(`pathIndices[i] * (1 - pathIndices[i]) === 0`)이 없다**(투표값 `vote[i]`에는 `:113`에 부울 제약이 존재하는 것과 대조). `idx`와 `pathElements[i]`가 모두 prover 통제이므로, 임의의 목표 `(left, right)`에 대해 `elem = left + right - cur`, `s = (left - cur) / (left + right - 2cur)`로 대수적으로 풀 수 있다. 즉 각 레벨의 Poseidon 두 입력을 **완전히 통제**할 수 있어, `cur[depth] === root`를 만족시키는 데 루트의 두 자식(A, B)에 대한 단 한 번의 관계만 필요하다. **전제조건**: 공격자는 유효한 Merkle path를 하나 보유해야 한다 — 즉 정상 등록을 1회 완료한 유권자(또는 그런 유권자와 공모한 자). 그런 유권자는 `/proof`가 반환하는 `pathElements`(최상단 형제 = 루트의 한 자식)와 자신이 계산한 depth-1 노드(다른 자식)로 루트의 두 자식 (A, B)를 확보한다. 이를 가진 공격자는 **임의로 조작한 user_secret(존재하지 않는 leaf 포함)에 대해 멤버십 증명을 위조**해 각기 다른 nullifier를 만들 수 있어 한 명이 무제한 투표를 던지거나 비유권자 표를 주입할 수 있다. (path를 전혀 갖지 못한 순수 외부인이 단독으로 공격 가능하다는 의미는 아니다.) C1과 마찬가지로 `submitTally`가 권한 없는 함수라 릴레이어 티켓 검증을 우회한다.
- **Evidence**:
  - `VoteCheck.circom:46-52`는 부울 제약 없이 `pathIndices`로 left/right 계산. 파일 내 `x*(1-x)===0`은 `:113`의 `vote[i]`에만 존재
  - 적대적 검증기(high confidence)가 Low→High 상향하며 익스플로잇을 구체화: 원 리뷰어의 "최종 root preimage가 막는다"는 비탈출 논리를 반박(두 자유도가 있어 preimage 장벽이 사라짐)
- **Fix**:
  `MerkleProof` 루프 안에 모든 레벨에 대해 `pathIndices[i] * (1 - pathIndices[i]) === 0;`을 추가하고 아티팩트(zkey/wasm/verifier) 재생성.

### H2 — 서버가 user_secret을 결정적으로 생성·평문 보관 → 운영자에 대한 투표 비밀 완전 붕괴

- **Severity**: High
- **File/Line**: `server/routes/register.js:26-37`, `server/utils/merkle.js:86-92`, `server/routes/proof.js:127-142`, `frontend/src/pages/Voter/VotePage.js:54-63,127-131`
- **Flow**: 유권자 등록 / 증명 발급 / 투표 비밀(anonymity)
- **Problem**:
  `user_secret = BigInt('0x' + SHA256(user_id + SECRET_SALT))`로 **결정적 생성**되어 `Voters.user_secret`에 평문 저장된다. nullifier는 `Poseidon(user_secret, electionId)`로 결정적이고, 공개 신호는 후보 인덱스(`publicSignals[1]`)와 nullifier(`publicSignals[2]`)를 드러내며 `VoteCast(electionId, candidateIndex)` 이벤트도 후보를 공개한다. 따라서 서버 운영자(또는 DB/`SECRET_SALT` 접근자)는 모든 유권자의 nullifier를 재계산해 `/proof` 시점의 JWT 신원 ↔ nullifier ↔ 공개 후보 선택을 연결, **누가 누구에게 투표했는지 전수 비식별화**할 수 있다. 시스템이 표방하는 익명성이 운영자 신뢰모델에서 성립하지 않는다. 또한 `SECRET_SALT` 유출 시 UUID만 알면 누구의 secret이든 도출해 투표 위조가 가능하다.
- **Evidence**:
  - `register.js:32-36`: `const seed = userId + process.env.SECRET_SALT; ... BigInt("0x" + sha256).toString();`
  - `merkle.js:86-92`: `calculateNullifierHash` = `Poseidon([BigInt(user_secret), electionIdToBigInt(election_id)])`
  - `proof.js:142`: `user_secret: voterRecord.user_secret` 반환
  - `VotingTally.sol:45`: `event VoteCast(uint256 indexed electionId, uint256 indexed candidateIndex);` — 후보 공개
  - register, frontend 두 리뷰어가 독립 확인
- **Fix**:
  secret을 `crypto.randomBytes` 기반 고엔트로피로 **클라이언트에서 생성·보관**하고, 서버에는 leaf 커밋먼트 `H(secret)`만 등록. 인증 경로에서 secret을 반환하거나 nullifier를 계산/저장하지 않도록 분리. 서버가 secret을 보유하지 않으면 nullifier↔유권자 연결이 불가능해진다.

### H3 — `/setZkDeploy` 동시성 제어 부재 → 중복 배포·verifier 불일치 → 선거 영구 정지

- **Severity**: High
- **File/Line**: `server/routes/setupAndDeploy.js:99-104,121-165,174-189` (및 `server/zkp/setUpZk.sh:72-77,107-109`, `scripts/deployAll.js:119`)
- **Flow**: 선거 ZK 셋업 + 컨트랙트 배포
- **Problem**:
  `contract_address` 사전 체크(`:99`)와 실제 작업 사이가 수 분(circom 컴파일, Sepolia 2회 배포, `deployAll.js:119`의 30초 고정 Etherscan 대기)이라 전형적 TOCTOU다. 프록시/관리자 타임아웃 재시도로 동시 요청이 둘 다 체크를 통과하면, 같은 공유 빌드 디렉토리(`build_<depth>_<candidates>`)에서 `setUpZk.sh`가 동시에 `sed/snarkjs/mv`를 수행해 **contracts/로 옮겨진 verifier .sol이 빌드 디렉토리에 남은 `circuit_final.zkey`와 다른 회로에서 나올 수 있다.** verifier가 어긋나면 어떤 유권자 증명도 검증되지 않고, 재배포는 `ALREADY_DEPLOYED`(`:100`)로 영구 차단되어 선거가 복구 불가 상태에 빠진다. `deployAll.js`의 가드된 DB 업데이트(`.is('contract_address', null)`)는 **DB 덮어쓰기만** 막을 뿐 중복 온체인 배포(가스 낭비)와 동시 아티팩트 생성은 막지 못한다. finalize/register는 Redis 선거 락을 쓰지만 이 라우트는 락이 전혀 없다.
- **Evidence**:
  - `setupAndDeploy.js:134`/`:178`의 `execFilePromise` 장기 실행
  - `setUpZk.sh:107-109`: `sed ...; mv "${BUILD_DIR}/${VERIFIER_FILE}" "${PROJECT_ROOT}/contracts/"` — 공유 전역 상태 변경
- **Fix**:
  핸들러 전체를 `election_id` + 아티팩트 조합 키(`zkdeploy:${depth}_${num_candidates}`)의 Redis 락(`server/utils/redisLock.js` 재사용)으로 감싸거나, 스크립트 실행 전 조건부 DB 업데이트(`SET state='deploying' WHERE contract_address IS NULL AND state<>'deploying'`)로 마커 설정. 이상적으로는 백그라운드 잡으로 이전하고 202 반환.

### H4 — finalize가 크래시/타임아웃에 안전하지 않아 등록 레이스 → 전체 투표 DoS/검열

- **Severity**: High
- **File/Line**: `server/routes/finalizeVote.js:19-22,134-179,184-211`, `server/utils/redisLock.js:58-65`, `server/utils/merkle.js:208-227`, `server/routes/proof.js:120`
- **Flow**: finalize(스냅샷 + 온체인 구성) vs 유권자 자가 등록 레이스
- **Problem**:
  Merkle 스냅샷 → 온체인 `configureElection` → Redis 마커 → DB 업데이트가 **갱신되지 않는 TTL 1800초 Redis 락** 하나로만 보호되고 `txConfigure.wait()`는 무한 대기다. 트랜잭션 브로드캐스트 후 `markOnchainConfigured` 전에 서버가 재시작되거나 tx가 1800초를 넘겨 락이 만료되면, DB `merkle_root`는 여전히 null·`registration_end_time`은 미래라 **유권자가 등록을 계속할 수 있다**(`addUserSecret`의 세 가드 모두 통과). 이후:
  - **(A) 크래시로 DB 미기록 시**: 재시도가 영구히 `ON_CHAIN_STATE_MISMATCH` 반환(루트에 늦은 leaf 포함되어 불일치) → 수동 DB 보정 없이는 finalize 불가.
  - **(B) 락 만료 후 원 요청이 DB를 늦게 기록 시**: DB `merkle_root`=구 스냅샷이지만 `generateMerkleProof`는 캐시 무효화된 더 큰 유권자 집합으로 트리를 재구성 → `proof.js:120`에서 **모든 유권자 증명이 거부**되는 선거 전체 투표 DoS.

  두 경우 모두 늦은 등록자는 온체인 루트에서 조용히 배제(검열)된다. UI가 등록 진행 중에도 finalize를 노출하므로 윈도우가 현실적이다.
- **Evidence**:
  - `finalizeVote.js:19-22` `FINALIZE_LOCK_OPTIONS = { lockTimeoutSeconds: 1800, pollingTimeoutMs: 30000 }`, `:166` 무한 `tx.wait()`
  - `redisLock.js:58-65` `withRedisLock`에 락 연장/fencing 메커니즘 없음
  - `merkle.js:222`는 종료시각만 재검사, `proof.js:120` `if (BigInt(proofData.root) !== BigInt(election.merkle_root))`가 blast radius
- **Fix**:
  tx 확정 후 DB 업데이트 전에 (1) 락 토큰 보유 여부 확인 + leaf 집합이 스냅샷과 동일한지 재검증(다르면 CRITICAL 알림 후 중단), (2) `tx.wait()`에 락 TTL보다 짧은 타임아웃 부여 또는 대기 중 락 TTL 주기적 갱신, (3) Postgres에 `finalizing` 상태를 내구적으로 기록하고 tx 브로드캐스트 전에 설정해 `addUserSecret`/`registerByAdmin`이 fail-closed로 등록 거부하도록 변경.

### H5 — 관리자 초대가 소비되지 않아 미가입 초대자에게 권한이 영구 미부여

- **Severity**: High
- **File/Line**: `server/routes/addAdmins.js:73-75,84-98,100-107`
- **Flow**: 관리자 초대 / 프로비저닝
- **Problem**:
  라우트는 이메일을 `AdminInvitations`에 upsert하고, **이미 Supabase auth에 존재하는** 사용자만 즉시 `Admins`로 승격한다(`:84-95`). 그러나 저장소 전체에서 `AdminInvitations`를 다시 읽는 코드가 **addAdmins.js 자신밖에 없다**(repo grep 확인). 프론트 회원가입(`LoginPage.js`)도, Rust 스캐폴드도 이를 소비하지 않는다. 따라서 아직 가입하지 않은 미래 관리자를 초대해도, 그가 나중에 가입할 때 관리자 권한이 영영 부여되지 않는다. 또한 기존 사용자 승격 실패(`:96-98`)는 에러가 삼켜지고 동일한 201을 반환해 호출자가 영구 실패를 구분할 수 없으며, 초대가 재처리되지 않으므로 그 사용자도 끝내 승격되지 않는다.
- **Evidence**:
  - `addAdmins.js:74-75` `.from("AdminInvitations").upsert({ email }, { onConflict: "email" })`
  - `:96-98` catch 후 `:101` 201 반환
  - `docs/API_COMPATIBILITY.md:76-77`도 "초대→관리자 수락 경로를 구현/문서화하라"고 인정
- **Fix**:
  수락 경로 구현 — 인증 미들웨어 또는 가입 후 엔드포인트에서 사용자의 정규화 이메일을 `AdminInvitations`에서 조회해 `Admins`에 upsert하고 초대를 소비 처리. 기존 사용자 승격 실패 시 201이 아닌 구분된 상태 반환.

---

## Medium

### M1 — 단일사용 티켓이 의미 검증·릴레이 이전에 소비됨
- **File/Line**: `server/routes/submitZk.js:113` (소비) vs `:156-180,197-206` (검증/릴레이)
- **Flow**: 익명 투표 제출 / 티켓 수명
- **Problem**: 티켓이 `:113`에서 GETDEL로 소비된 뒤에야 election 조회·`NOT_FINALIZED`·`validateSubmitPayload`·voting-period·`callStatic.submitTally`가 실행된다. 형식상 유효하나 페이로드 불일치/period/revert로 실패하면 티켓이 소실되어 유권자가 그 티켓으로 재시도 불가(다만 `/proof` 재호출로 동일 nullifier 티켓 재발급 가능하므로 복구 가능 — 가용성/UX 등급).
- **Fix**: `validateSubmitPayload`는 `ticketPayload`(election/root/nullifier 바인딩)를 인자로 받으므로(`submitValidation.js:39-45`) 티켓 값을 읽기 전에는 수행할 수 없다. 따라서 단순히 GETDEL을 뒤로 미루면 **동일 티켓 동시 재사용 레이스**(두 요청이 같은 값을 GET→둘 다 통과→이중 릴레이)가 생긴다. 올바른 방향은 (a) 티켓을 **GET(peek)** → 모든 검증 통과 시에만 **GETDEL** 로 소비하되 그 read-validate-consume 구간을 **티켓별 Redis 락 또는 Lua 스크립트로 원자화**하는 것. 티켓이 필요 없는 검사(election 조회·`NOT_FINALIZED`·voting-period)는 peek 이전으로 앞당겨도 무방하다.

### M2 — `.ptau` 부재 + circom 미설치로 새 (depth,candidates) 배포 불가
- **File/Line**: `server/zkp/setUpZk.sh:21-26,36-52,80-84`, `server/routes/setupAndDeploy.js:63-74`
- **Flow**: 관리자 setZkDeploy(동적 ZKP 셋업 + 배포)
- **Problem**: `setUpZk.sh`는 `powersOfTau28_hez_final_{12,16,20}.ptau`를 요구하나 repo에 없다(`*.ptau` gitignore, `server/zkp/`에 실제 부재 확인). 실제 blocker는 **circom 미설치**(전역/로컬 어디에도 없음)와 **`.ptau` 부재** 두 가지다. `snarkjs`는 전역엔 없지만 `node_modules/.bin/snarkjs`·`server/node_modules/.bin/snarkjs`(둘 다 `../snarkjs/build/cli.cjs` 심볼릭)로 존재하고 `setUpZk.sh:21-26`이 로컬 bin을 사용하므로 **snarkjs는 blocker가 아니다**(`AGENT.md:314`도 "npx로 사용 가능"이라 인정). 사전 점검은 `poseidon.circom` 존재만 확인. 미리 빌드된 `build_4_5`/`build_5_4` 외 조합은 `/setZkDeploy`가 실패한다.
- **Fix**: 필요한 `.ptau`를 서버에 프로비저닝(배포 단계/오브젝트 스토리지/체크섬 검증 다운로드). 사전 점검에 (a) circom 바이너리 해석 가능 여부, (b) 해당 depth의 ptau 존재를 추가.

### M3 — 온체인 구성 마커 fail-open + TTL 없음
- **File/Line**: `server/utils/finalizationState.js:7-25` (및 `finalizeVote.js:152-211`, `merkle.js:215-220`)
- **Flow**: finalize 부분 실패(온체인 성공, DB 실패) → 유권자 자가 등록
- **Problem**: DB 부분 실패 경로(`FINALIZATION_DB_SYNC_FAILED`, `finalizeVote.js:197-211`)에서 `merkle_root`가 null로 남을 때 등록을 막는 **유일한** 가드가 Redis 마커인데, (1) `markOnchainConfigured`가 에러를 삼키고, (2) `isOnchainConfigured`가 Redis 오류 시 false로 fail-open하며, (3) 마커에 TTL/내구성이 없다. GCP Memorystore `--tier basic`은 무영속이라 재시작 시 마커가 소실 → 등록 재개·검열.
- **Fix**: 마커를 Postgres에 내구 기록(예: `elections.onchain_configured_at`을 tx 확정 직후 같은 단계에서 설정)하고 `addUserSecret`에서 그 컬럼을 확인.

### M4 — 후보 수 상한·중복 검사 없음
- **File/Line**: `server/routes/setVote.js:58-60,67-69`
- **Flow**: 선거 생성(`/elections/set`)
- **Problem**: `num_candidates`가 검증 없이 저장되어 회로 크기(`Main(depth, candidates)`)를 결정한다. 부주의/악의적 관리자가 수천 후보를 넣으면 회로 생성/배포가 마비된다. 중복 후보도 허용된다.
- **Fix**: `MAX_CANDIDATES` 상한(회로/ptau가 지원하는 값) 적용 후 초과 거부, 트림 후 중복 제거(`new Set`).

### M5 — 아티팩트가 (depth,candidates)로만 키잉 + 재생성 시 새 난수
- **File/Line**: `server/zkp/setUpZk.sh:95-98,107-109` (트리거: `setupAndDeploy.js:116-125`)
- **Flow**: 동일 (depth,candidates) 아티팩트를 공유하는 기배포 선거의 제출
- **Problem**: 4개 아티팩트 중 하나라도 없으면 `setUpZk.sh`가 **새 난수로 재생성**해 `circuit_final.zkey`와 contracts/ verifier가 교체된다. 동일 조합을 공유하던 **기배포 선거의 모든 proof가 영구 무효화**될 수 있다.
- **Fix**: 선거별 `circuit_final.zkey`/`verification_key.json` 해시를 배포 시점에 저장(컬럼 또는 `zk_artifacts` 테이블)하고 `/proof` 시 대조. 아티팩트를 배포와 바인딩.

### M6 — "Node API 호환" 마이그레이션이 실제로는 호환 불가
- **File/Line**: `rust-backend/migrations/0002_node_api_compatibility.sql`
- **Flow**: Node→Rust 스키마 패리티 / 데이터 마이그레이션
- **Problem**: Node의 모든 쿼리는 PascalCase PostgREST 테이블(`Elections`/`Voters`/`Admins`/`AdminInvitations`)을 대상으로 하나, 마이그레이션은 lowercase `elections`/`voters`/`admins`/`admin_invitations`를 생성한다. 두 스키마가 직접 호환되지 않는다(현재 Node는 호스티드 Supabase를 사용하므로 즉각적 버그는 아니나, Rust 전환 시 차단 요소).
- **Fix**: 목표를 결정 — 로컬 스키마가 현 Node/PostgREST API를 서빙해야 한다면 따옴표 PascalCase 테이블(또는 `"Elections" AS SELECT ...` 뷰)을 만들거나, Rust가 새 스키마를 쓰되 매핑 계층을 명시.

### M7 — `elections.circuit_id`가 NOT NULL + DEFAULT 없음
- **File/Line**: `rust-backend/migrations/0001_initial.sql:31`
- **Flow**: 선거 생성(`POST /api/elections/set`) 패리티
- **Problem**: Node식 election insert는 `circuit_id`를 제공하지 않으므로 이 스키마에선 not-null 위반이 발생한다. `0002`도 이를 보정하지 않는다.
- **Fix**: `circuit_id`를 nullable로 하거나 sentinel DEFAULT 부여 후 setZkDeploy/아티팩트 선택 단계에서 백필.

### M8 — `numeric(78,0)` vs BigInt 문자열 직렬화 불일치
- **File/Line**: `rust-backend/migrations/0001_initial.sql:27,62-63,74-75,86,98`
- **Flow**: proof 생성 / 투표 제출(merkle_root/user_secret/nullifier 처리)
- **Problem**: `merkle_root`/`user_secret`/`user_secret_commitment`/`nullifier_hash`/티켓 root가 `numeric(78,0)`인데 Node 코드(및 API 계약)는 십진 문자열로 다뤄 `BigInt()`에 투입한다. PostgREST의 numeric JSON 직렬화 방식과 불일치할 수 있다.
- **Fix**: 컬럼을 `text`(+ `CHECK (value ~ '^[0-9]+$')`)로 변경하거나 모든 API 계층에서 `::text` 캐스팅을 명시.

### M9 — GCP `secretAccessor`를 프로젝트 레벨 부여 (최소권한 위반)
- **File/Line**: `scripts/gcp/zkvote-staging-setup.sh:73-78`
- **Flow**: GCP 스테이징 프로비저닝 / 런타임 비밀 접근
- **Problem**: `roles/secretmanager.secretAccessor`가 공유 POC 프로젝트(`scopeball-registry-poc-g`)에 **프로젝트 레벨**로 부여되어 서비스 계정이 프로젝트의 모든 비밀을 읽는다. 최소권한 위반이며 `AGENT.md:321` 자기 규칙("리소스 범위 IAM") 위반.
- **Fix**: 프로젝트 레벨 루프에서 `secretAccessor`를 제거하고, 기존 secrets 루프 안에서 `zkvote-staging-*` 비밀별로만 `gcloud secrets add-iam-policy-binding`으로 부여.

### M10 — Cloud SQL 비밀번호 lifecycle 버그
- **File/Line**: `scripts/gcp/zkvote-staging-setup.sh:106-116,158-163`
- **Flow**: GCP 스테이징 Cloud SQL 자격증명 부트스트랩 / 재실행
- **Problem**: 첫 실행 시 생성된 랜덤 `DB_PASSWORD`(`:109`)가 메모리에만 있다가 `:160`에서야 secret에 기록된다. 그 사이 Redis(`:118-126`)/VPC(`:128-138`) 생성이 `set -e`로 실패하면 비밀번호가 영영 secret에 기록되지 않아 DB 연결 불가가 된다.
- **Fix**: `gcloud sql users create` 성공 직후 즉시 `zkvote-staging-database-url` secret 버전을 기록하도록 순서를 앞당김.

### M11 — main push마다 라이브 AWS 자동 배포 (백엔드 EC2 + 프론트 S3/CloudFront)
- **File/Line**: `.github/workflows/deploy-backend.yml:3-8,19-62`, `.github/workflows/deploy-frontend.yml:3-8,43-49`
- **Flow**: 레거시 AWS 배포 CI(main push 시)
- **Problem**: main에 push할 때마다 두 워크플로우가 자동 실행된다. (1) `deploy-backend.yml`은 라이브 AWS EC2로 배포(`git pull` + `pm2 reload`)하며 `appleboy/ssh-action@master`(가변 브랜치 ref, 공급망 위험)에 EC2 SSH 키를 전달한다. (2) `deploy-frontend.yml`은 `frontend/**` 변경 시 빌드 후 `aws s3 sync ... --delete`로 S3에 배포하고 CloudFront 무효화를 수행(리전 `ap-northeast-2`)한다. 진행 중인 Rust/GCP 마이그레이션 변경이 main에 들어가면 함께 라이브로 나갈 수 있다.
- **Fix**: `appleboy/ssh-action`을 커밋 SHA로 고정, 두 워크플로우를 `workflow_dispatch` 또는 필수 리뷰어 environment로 게이팅. 문서(README/AGENT)에 이 AWS 라이브 CD 경로를 명시.

### M12 — submit 에러 미처리 → 영구 로딩 + 티켓 소비
- **File/Line**: `frontend/src/pages/Voter/VotePage.js:111-157`
- **Flow**: 투표 제출(증명 생성 + 제출)
- **Problem**: `worker.onmessage`의 submit `await`에 try/catch가 없어 403/409/400/429/500 모든 실패가 unhandled rejection이 된다. `loadingMessage`가 지워지지 않아 **영구 로딩 오버레이**가 발생하고, 동시에 티켓은 이미 소비된 상태다(M1과 결합).
- **Fix**: `worker.onmessage` 본문(및 submit await)을 try/catch/finally로 감싸 `setLoadingMessage('')`/`setErrorMessage(error.response?.data?.details)` 처리.

### M13 — 등록 락 10초 TTL + fencing 부재
- **File/Line**: `server/utils/redisLock.js:3`, `server/utils/merkle.js:193-194`, `server/routes/finalizeVote.js:19-22`
- **Flow**: 유권자 자가 등록 vs finalize 레이스
- **Problem**: `addUserSecret`의 임계구역이 기본 **10초 TTL** 락 + 쓰기 전 fencing 토큰 검사 없이 실행된다. finalize는 같은 락을 최대 30초 폴링하므로 만료 즉시 락을 획득할 수 있다. DB 업데이트가 10초를 넘기면 락 만료 후 finalize가 동시 진입 → H4 레이스를 강화한다.
- **Fix**: `addUserSecret`에 더 긴 `lockTimeoutSeconds`(예: 60s) 전달, `Voters` UPDATE 후 락 토큰 보유 재확인(fencing).

---

## Low / 개선 제안 (비차단)

> 아래는 차단 요소는 아니나 정리/수정 권장 항목이다.

- **거짓 양성(강등)**: "등록 시작시각(registration_start_time) 미검증"(`register.js:76-97`) 발견은 적대적 검증에서 **Info(실제 아님)**으로 강등됐다. `setVote.js:79`가 `registration_start_time`을 항상 `now`로 하드코딩하고 이후 갱신 코드가 없어 "시작 전 등록" 상태가 도달 불가하기 때문이다. 방어적 코드로만 참고.
- `scripts/deploy_votingtally.js:7-9` / `deploy_verifier.js:4-5`: 현 `VotingTally` 3-인자 생성자와 맞지 않는 stale 단일 인자 호출 → 제거 또는 `deployAll.js`로 일원화.
- `server/zkp/prove.sh:5-6,22-36`: `./build/VoteCheck` 레이아웃을 참조하는 stale 스크립트(실제는 `build_<d>_<c>/VoteCheck_temp*`) → 삭제 또는 수정. `AGENT.md:106-109`의 "현행 ZK 파일" 기술과 불일치.
- `server/supabaseClient.js:5-8`: service-role 키 누락 시 `SUPABASE_KEY`(보통 anon 키)로 조용히 폴백 + env 미설정 검증 없음 → 필수 env 검증/명시적 키 분리.
- `server/middleware/authAdmin.js:49-63`: DB 오류와 "관리자 아님"을 모두 403으로 혼동(`if (adminError || !admin)`) → 일시적 장애는 500으로 구분.
- `server/routes/setVote.js:61`: `regEndTime`이 truthy non-string이면 `validator.isISO8601`가 TypeError → 타입 검사 선행. 타임존 미지정 ISO 문자열은 서버 로컬 타임존으로 해석되므로 명시적 offset/Z 요구 권장(현 프론트는 `.toISOString()` 전송이라 현재는 안전).
- `server/routes/setupAndDeploy.js:79-95`: `election_id`를 UUID 형식으로 검증하지 않음.
- `server/routes/setupAndDeploy.js:162,210`: raw `scriptError.stderr`를 클라이언트에 반환해 절대경로/툴체인 노출 → 상관 ID + 서버 로그.
- `server/routes/completeVote.js:72-84`: 동시 complete 레이스는 `.eq("completed", false)` 가드로 사실상 무해(둘 중 하나만 성공) — 정보성.
- `contracts/VotingTally.sol:67-72`: 생성자 입력 검증 없음 → `require(_verifierAddress != address(0))`, `require(_numCandidates > 0)` 추가; `numCandidates`를 `immutable`로.
- `test/VotingTally.js:5-19,99-121`: verifier를 EOA로 배포해 **verifier 호출 전 revert(루트/후보 범위)만** 검증. 성공 경로·이중투표 거부·verifier 상호작용 미검증 → C1/H1이 테스트로 잡히지 않은 이유. MockVerifier(설정형 bool 반환) 기반 테스트 추가 권장.
- `server/package.json`: `express-rate-limit`이 선언됐으나 어디서도 import되지 않음 → `/addAdmins`·`/register`·`/proof`에 적용하거나 의존성 제거.
- `server/index.js:56`: `app.listen(process.env.PORT)`에 검증/폴백 없음 → `Number(PORT) || 기본값` + fail-fast.
- `server/index.js:42`: `/api/zkp-files` static 라우트가 `server/zkp` 전체(setUpZk.sh, prove.sh, .circom 소스, 기여 전 `circuit_0000.zkey`, gitignore된 레거시 `tmp/`·`input/`)를 노출 → `build_*/`로 범위 축소. 레거시 서버측 proving 재활성화 시 per-session `input.json`의 secret 노출 위험.
- `server/routes/secret.js`: 전체 주석 처리된 죽은 코드 → 삭제(재마운트 사고 방지).
- Rust 스캐폴드(`crates/api/src/main.rs`): `db::connect`가 eager(리스너 바인드 전 라이브 연결 필요), Cloud Run의 `PORT` 무시(`APP_BIND_ADDR`만 사용), `readyz`가 매 요청 새 Redis 연결 — 프로덕션 전 보완(현 스캐폴드 단계에선 수용 가능, `/healthz`·`/readyz`는 실제 PG/Redis 체크로 정직함).

---

## 검증 결과

| 명령 | 결과 |
|------|------|
| `find server scripts test -name '*.js' ... \| xargs -0 -n1 node --check` | ✅ PASS (전체) |
| `find scripts server/zkp -name '*.sh' \| xargs -0 -n1 bash -n` | ✅ PASS (전체) |
| `npx hardhat test --no-compile` | ✅ PASS (24 passing; Node v25 비지원 경고만) |
| `cargo fmt --check` | ✅ PASS |
| `cargo clippy --workspace -- -D warnings` | ✅ PASS (경고 없음) |
| `cargo test --workspace` | ✅ PASS — **2 passing** (`zkvote-domain`의 상태전이 테스트 `accepts_expected_state_transition`, `rejects_skipped_state_transition`; 나머지 크레이트는 테스트 0개). `cargo test --workspace -- --list`로 2건 확인 |
| `cd frontend && npm run build` | ✅ PASS (compiled; browserslist 경고만) |
| `scripts/local/smoke.sh` | ✅ PASS (postgres/redis healthy, PONG) |
| `scripts/local/migrate.sh` | ✅ PASS (멱등; 기존 컬럼 skip) |
| ZK 툴체인 | ⚠️ `circom` 미설치(전역/로컬 모두) + `.ptau` 부재 → **ZK 아티팩트 재생성/회로 재컴파일 실행 불가**. `snarkjs`는 로컬 `node_modules/.bin/snarkjs`로 가용(전역만 없음), `nargo`(Noir POC용)는 미설치. 대신 정적 검증으로 `nPublic=3`, verifier `uint[3]`, 회로 public 신호 순서를 확인. |

---

## 문서/구현 불일치 (실제 불일치만)

1. **회로 주석 vs 컴파일된 가시성**: `VoteCheck.circom`이 `root_in`(`:147`)/`election_id`(`:82,154`)를 "Public ... 온체인 verifier가 사용"이라 주석하나, `{public [...]}` 선언이 없어 둘 다 **private로 컴파일**된다(공개 신호는 출력 3개뿐). 주석이 C1을 가린다.
2. **익명성 주장 vs 구현**: `README.md:79` / `AGENT.md` / `API_COMPATIBILITY.md:293`("Anonymous by design")가 투표 비밀을 표방하나 서버가 secret을 보유해 운영자 비식별화 가능(H2).
3. **"election당 중복 nullifier 거부" 과장**: `PROJECT_PLAN.md` Phase 3 게이트 "Duplicate nullifier per election is rejected"가 유권자당 1표를 함의하나, 온체인은 바이트 동일 nullifier만 거부하고 prover가 `election_id`로 nullifier를 무한 생성 가능(C1). *(리팩토링된 PROJECT_PLAN은 이 한계를 Risk Register의 C1 항목으로 반영함.)*
4. **`vote_submissions` 테이블 미사용**: `AGENT.md:99,192`가 `unique(election_id, nullifier_hash)`를 제출 흐름 일부로 기술하나 `submitZk.js`는 이 테이블을 읽거나 쓰지 않음(중복 방지는 전적으로 온체인 `usedNullifiers` 의존).
5. **addAdmins 동작 불일치**: `API_COMPATIBILITY.md:71`은 "관리자 권한을 직접 부여하지 않는다"지만 코드는 기존 사용자를 즉시 `Admins`로 승격(`:84-94`, `promotedExistingUser: true` 반환).
6. **Merkle depth 범위**: `AGENT.md:193` / `API_COMPATIBILITY.md:106`은 1..20 지원이라 하나, 빌드 아티팩트는 4/5만 존재하고 `.ptau`가 없어 실제 즉시 지원 불가.
7. **stale prove.sh**: `AGENT.md:106-109`가 현행 ZK 파일로 `prove.sh`를 나열하나 실제 레이아웃과 달라 깨져 있음.
8. **마이그레이션 다이어그램만 축약** (사소): `AGENT.md`의 권위 있는 "Initial migration" 목록(`:169-170`)은 `0001`·`0002`를 **모두 정확히 나열**한다. 다만 그 위 Rust 스캐폴드 디렉토리 다이어그램(`:121`)이 `0001`만 표기 → 실질 불일치는 아니며 다이어그램만 갱신 권장. *(초안의 "AGENT.md가 0001만 표시" 표현은 과장이었음 — 정정.)*
9. **finalize 시점**: `PROJECT_PLAN.md` Admin Flow 9단계("Admin finalizes registration after the deadline ...")와 달리 `finalizeVote.js`는 `registration_end_time` 경과 검사가 없음. *(리팩토링된 PROJECT_PLAN은 "or after an explicit fail-closed state transition"을 추가하고 Phase 12에서 내구적 `finalizing` 상태로 이를 닫도록 계획함.)*
10. **IAM 최소권한 자기규칙 위반**: `AGENT.md:321` / `PROJECT_PLAN.md` Phase 16 "Grant Secret Manager access only on required `zkvote-staging-*` secrets"의 리소스 범위 IAM 원칙과 달리 `secretAccessor`를 프로젝트 레벨로 부여(M9).
11. **미문서화 CD 파이프라인**: 문서는 GCP staging만 배포 환경으로 기술하나, `.github/workflows/deploy-backend.yml`(라이브 EC2)과 `.github/workflows/deploy-frontend.yml`(라이브 S3/CloudFront) **둘 다** main push 시 자동 CD를 수행(M11).

---

## 결론

> **rev5 갱신 (2026-06-12)**: 아래 결론은 감사 시점(rev4) 기준이다. Phase 1 재기준선 이후 **Critical/High 전체와 M1~M5/M9~M13이 닫혔다**(클로저 매트릭스 참조). 그러나 스테이징 진입에는 여전히 (a) M6~M8 스키마 패리티(Phase 3), (b) trusted setup 단독 기여 문제 AR-H1의 beacon/MPC(Phase 10), (c) Phase 16 게이트 충족이 선행되어야 한다 — **여전히 로컬 데모/개발 전용**이며, 그 이유가 "투표 무결성 결함"에서 "스테이징 준비 미완"으로 바뀌었을 뿐이다.

**현 상태: 로컬 데모/개발 지속에는 적합하나, 스테이징·프로덕션에는 부적합(not ready).**

근거:
- **C1(election_id 미바인딩)** 과 **H1(pathIndices 부울 제약 누락)** 은 각각 독립적으로 **등록 유권자 1명이 무제한 투표/자격 위조**를 가능케 하는 온체인 soundness 결함이다. 권한 없는 `submitTally`로 오프체인 티켓 방어가 무력화되므로, 이 둘이 고쳐지기 전에는 어떤 실선거에도 사용할 수 없다.
- **H2(투표 비밀 붕괴)** 는 서버 신뢰모델에서 익명성 표방이 성립하지 않게 한다.
- **H3/H4** 는 배포·finalize 단계의 비복구성(영구 정지·전체 투표 DoS)으로 운영 안정성을 직접 위협한다.

**최소 선결 수정 (스테이징 진입 전 필수)**:
1. 회로에 `election_id`를 공개 신호로 노출 + `submitTally`에서 `electionId` 대조, 그리고 `pathIndices` 부울 제약 추가 → verifier/zkey/wasm 재생성, 컨트랙트 `uint[4]` 갱신. (C1, H1)
2. user_secret을 클라이언트 생성·서버 비보관(커밋먼트만 저장)으로 전환. (H2)
3. `/setZkDeploy`에 분산 락/배포 마커, finalize에 내구적 `finalizing` 상태 + leaf 집합 재검증/락 fencing. (H3, H4)
4. MockVerifier 기반 성공경로·이중투표 거부 테스트 추가로 C1/H1 회귀 방지.

그다음 Medium 항목(티켓 소비 순서, ptau 프로비저닝, GCP 최소권한·CD 게이팅, Node↔Rust 스키마 패리티)을 정리하면 스테이징 준비 상태로 진입할 수 있다.
