# zk-vote 아키텍처·플랜 검토 보고서 (Architecture Review)

> **작성일**: 2026-06-12
> **범위**: 전체 아키텍처(타깃: React → Rust → PG/Redis/아티팩트/릴레이어 → 컨트랙트)와 `docs/PROJECT_PLAN.md` 20-phase 플랜의 허점.
> **`audit.md`(rev4)와의 관계**: 상호보완. audit.md의 C1·H1~H5·M1~M13은 **이 문서의 범위에서 제외**했고, 여기의 파인딩은 모두 audit에 없는 신규 항목이다. ID는 `AR-*`로 구분한다.
> **방법론**: 7개 차원(플랜 내부 정합성 / 플랜-코드 일치 / 익명성 아키텍처 / ZK 파이프라인 / 데이터·인증 마이그레이션 / 인프라·CI / 온체인 설계) 병렬 조사로 raw 29건 수집 → 중복 병합 26건 → 파인딩별 **적대적 검증**(반박 기조, 실제 파일 인용 의무). 검증 결과 25건 실재, 1건 기각. 검증기 3건이 일시 장애로 누락되어 해당 3건(AR-M7, AR-L8, AR-L12)은 수동 코드 재검증으로 확정.
> **검토 시점의 워크트리 상태**: Phase 1 중 C1+H1 구현 완료, H2·M1 부분 구현 진행 중(클라이언트 보관 secret, commitment 기반 등록, ticket-scoped 락). 본 문서의 라인 번호는 이 워크트리 기준.

## 요약

| ID | 심각도 | 종류 | 제목 | 플랜 반영 (2026-06-12) |
| --- | --- | --- | --- | --- |
| AR-H1 | High | 아키텍처 | trusted setup이 운영자 단독 1회 기여 → 운영자가 증명 위조 가능 | Phase 10 ✅ |
| AR-H2 | High | 아키텍처 | Merkle 용량(2^depth) 검증 부재 → 초과 등록 시 선거 영구 brick | Phase 9 ✅ |
| AR-H3 | High | 플랜 공백 | 라이브 데이터 마이그레이션/dual-write/데이터 롤백 전무 | Phase 19 ✅ |
| AR-H4 | High | 아키텍처 | 인증 split-brain: 프론트가 Supabase `Admins`를 직접 읽음 | Phase 15 ✅ |
| AR-H5 | High | 플랜-코드 불일치 | Phase 13 티켓-nullifier 바인딩이 H2 모델과 자기모순 | Phase 13 ✅ |
| AR-H6 | High | 아키텍처 | 클라이언트 secret 분실/복구 라이프사이클 부재 = 영구 투표권 상실 | Phase 9 ✅ |
| AR-H7 | High | 플랜 공백 | Rust가 비트동일 circom Poseidon 필요한데 crate/테스트벡터 무계획 | Phase 12 ✅ |
| AR-H8 | High | 플랜 공백 | npm 암호 스택 공급망 통제 0 (caret + `npm install` CD) | Phase 17 ✅ |
| AR-M1 | Medium | 아키텍처 | 제출 티켓 = 연결 가능한 bearer 토큰 (운영자 deanonymization 조인 키) | Phase 13 부분 ✅ / Phase 18 결정 |
| AR-M2 | Medium | 플랜 공백 | 300초 TTL + 단일 릴레이 + 실시간 VoteCast = 타이밍 채널 | Phase 13 완화 + Phase 18 측정 ✅ (잔여 수용) |
| AR-M3 | Medium | 아키텍처 | Cloud SQL 권한 모델(ROLE/GRANT/RLS 대체) 부재 | Phase 3 ✅ (no-RLS·2-role 결정) |
| AR-M4 | Medium | 아키텍처 | 단일 hot EOA가 릴레이어+배포자+모든 컨트랙트 영구 owner | Phase 11 ✅ |
| AR-M5 | Medium | 아키텍처 | 릴레이어 nonce 직렬화 부재 (동시 제출 시 충돌) | Phase 13 ✅ |
| AR-M6 | Medium | 플랜 공백 | wasm/zkey 브라우저 서빙 표면 미소유 + 클라이언트 무결성 검증 부재 | Phase 10 ✅ |
| AR-M7 | Medium | 아키텍처 | 선거 라이프사이클 one-shot: 잘못된 voteEndTime → 복구 불가 | Phase 11/12 ✅ (불변성 유지 + 보상 통제) |
| AR-L1~L13 | Low | (하단 참조) | 문서 드리프트·플랜 게이트 결함 13건 | AR-L1·L3·L10 ✅, 나머지 기록 |
| AR-X1 | 기각 | — | "orphan uint[3] verifier 배포 가능" 주장 → self-heal로 반박됨 | — |

---

## High

### AR-H1 — Groth16 phase-2 trusted setup이 운영자 단독 1회 기여 → setup 운영자가 임의 증명 위조 가능

- **종류**: 아키텍처 결함 (audit M2/M5와 별개 — M2는 도구 부재, M5는 아티팩트 키잉)
- **Evidence**:
  - `server/zkp/setUpZk.sh:100-103` — `"$SNARKJS_BIN" zkey contribute ... -e="$(head -n 4096 /dev/urandom | openssl sha1)"` (기여 1회, 엔트로피를 **운영자 머신에서 생성**)
  - `server/zkp/setUpZk.sh:107-108` — 후속 `zkey beacon`/추가 기여 없이 단일 기여 zkey에서 vkey·Solidity verifier를 직접 export
- **문제**: phase-2 toxic waste를 아는 자(= `/setZkDeploy`를 실행하는 서버 운영자)는 배포된 `Groth16Verifier_*`가 수락하는 **임의 공개입력의 유효 증명을 위조**할 수 있다. C1/H1을 고쳐도 온체인 verifier라는 신뢰 앵커 자체가 운영자 신뢰로 환원되며, 집계 조작이 가능하다.
- **수정**: 선거별 zkey를 공개 랜덤 beacon(`snarkjs zkey beacon`, 예: 미래 블록해시)으로 finalize하거나 독립 기여자 1인 이상 포함 MPC 수행 + transcript 공개 + `snarkjs zkey verify` 게이트. → **Phase 10에 태스크·게이트 반영됨.**

### AR-H2 — 등록/허용 인원 ≤ 2^depth 강제 부재 → 초과 시 `Tree is full`로 finalize·/proof 영구 실패

- **종류**: 아키텍처 결함 (audit M13의 락 문제와 별개)
- **Evidence**:
  - `server/utils/merkle.js:111-115` — `buildTree`가 `leaves.length` 사전 검사 없이 `new MerkleTree(depth, leaves, ...)` 호출
  - `node_modules/fixed-merkle-tree/lib/FixedMerkleTree.js:12-13` — `if (elements.length > this.capacity) { throw new Error('Tree is full'); }`, capacity = `2 ** levels`
  - `server/routes/registerByAdmin.js` / `register.js` — 인원 대 2^depth 비교 코드 전무 (repo 전체 grep 0건)
- **문제**: depth 상한 5(용량 32, `setVote.js:12,53`)인데 관리자 일괄 허용/자가 등록 어디서도 용량을 검사하지 않는다. 초과 시 `buildFinalMerkleSnapshot`(finalize)과 `generateMerkleProof`(모든 /proof)가 throw → **선거를 finalize할 수도, 투표할 수도 없는 영구 고착**, 복구 API 없음.
- **수정**: 두 등록 경로에 `기존 + 신규 ≤ 2 ** merkle_tree_depth` 가드와 typed `OVER_CAPACITY` 에러. → **Phase 9에 반영됨 (Node 레퍼런스 백포트 포함).**

### AR-H3 — 스키마는 옮기는데 데이터는 안 옮김: 라이브 데이터 ETL·dual-write·데이터 롤백 전략 부재

- **종류**: 플랜 공백 (audit M6의 스키마 네이밍과 별개 — 스키마가 완벽해도 **데이터를 옮기는 주체가 없음**)
- **Evidence**:
  - `docs/PROJECT_PLAN.md:307` — "Decide how existing Supabase table data maps..." (결정 태스크일 뿐 마이그레이션 태스크 아님)
  - `docs/PROJECT_PLAN.md:319` — deliverable이 "Migration notes for existing data, **if any**" 뿐
  - Phase 16(:833-873)은 인프라 전용, Phase 19(:979-1019)에 데이터 sync/ETL/dual-write/데이터 롤백 태스크 0건. `:987` "Freeze Node API changes"는 코드 동결이지 데이터 동결이 아님
- **문제**: Node(호스티드 Supabase)와 Rust(Cloud SQL)는 **서로 다른 DB에 분리된 데이터**를 보므로, Phase 19의 side-by-side 비교·롤백 게이트는 작성된 대로는 실행 불가. Rust가 쓴 행을 Node로 롤백할 때의 데이터 처리도 미정의.
- **수정**: 1회성 ETL(행 수/체크섬 검증), write-freeze 또는 dual-write 전략, 데이터 롤백 경로. → **Phase 19에 반영됨.**

### AR-H4 — 인증 split-brain: 프론트가 anon-key로 Supabase `Admins`를 직접 읽어 권한 라우팅

- **종류**: 아키텍처 결함
- **Evidence**:
  - `frontend/src/App.js:29-32, 69` — `supabase.from('Admins').select('id').eq('id', user.id)` (관리자/유권자 라우팅의 **유일한** 입력; `AdminRoute.js:59`)
  - `frontend/src/supabase.js:11` — anon-key 클라이언트 → 호스티드 Supabase PostgREST 직행, 백엔드 미경유
- **문제**: 플랜은 auth.users를 Supabase에 남기고 `admins`/`voters.user_id`를 Cloud SQL로 옮기는데, 프론트의 직접 테이블 읽기를 API로 대체하는 phase가 없고 두 DB 사이 user_id 정합도 어느 phase 소유가 아니다. 마이그레이션 후 관리자 게이팅이 끊기거나 양쪽 권한이 어긋난다.
- **수정**: 활성 백엔드가 제공하는 역할 엔드포인트(`GET /api/me` → `is_admin`)로 대체 + 게이트. → **Phase 15에 반영됨.** (Cloud SQL 권한 모델은 AR-M3로 별도)

### AR-H5 — Phase 13 티켓 스펙("nullifier 바인딩")이 플랜 자신의 H2 모델과 모순; 코드는 이미 조용히 제거

- **종류**: 플랜-코드 불일치
- **Evidence**:
  - `docs/PROJECT_PLAN.md:722` — "Issue single-use ticket bound to election, Merkle root, **and nullifier hash**", `:731` "Validate nullifier against ticket", `:753` 게이트 "Nullifier mismatch is rejected"
  - H2 설계(`:182-186`) — "backend no longer derives nullifiers from server-held secrets" → 서버는 /proof 시점에 nullifier를 **알 수 없음** (알게 만들면 identity↔nullifier 연결이 부활해 H2가 무효)
  - 워크트리 현실: `server/routes/proof.js:129-132`와 `server/utils/submissionTickets.js`는 ticket을 (election, root)에만 바인딩하고 nullifier-bearing ticket payload를 거부
  - `docs/PROJECT_PLAN.md:1095-1097` — Milestone D 출구 기준이 한 문장에서 "anonymous under the post-audit privacy model"과 "nullifier-bound"를 동시 요구 (자기모순)
- **문제**: Phase 13을 스펙대로 구현하면 H2가 깨지고, H2대로 구현하면 Phase 13 게이트가 영원히 미충족. Rust 포팅 팀이 어느 쪽을 따라야 할지 결정 불가.
- **수정**: 티켓은 (election, root, 1회성)만 바인딩, nullifier 검증은 온체인 유일성으로 재해석. → **Phase 13 태스크·게이트·Milestone D 문구 정정됨.**

### AR-H6 — 클라이언트 보관 secret의 분실/복구 라이프사이클 부재: localStorage 삭제·기기 변경 = 영구 투표권 상실

- **종류**: 아키텍처 결함 (H2 수정의 가용성 귀결; audit에 없음)
- **Evidence**:
  - `frontend/src/utils/voterSecret.js:25,33` — secret이 election별 localStorage에만 존재
  - `frontend/src/pages/Voter/VotePage.js:66-67` — secret 부재 시 "등록했던 브라우저에서 다시 시도해주세요"로 하드 실패
  - 재등록은 409 `ALREADY_REGISTERED`(merkle.js), 플랜 20개 phase에 secret 분실·복구·기기 변경·commitment 재바인딩 언급 0건
- **문제**: finalize 이후 secret을 잃은 유권자는 **어떤 경로로도 투표 불가**. 실선거에서 무시 못 할 비율의 유권자가 조용히 권리를 상실한다.
- **수정**: registration_end_time까지 인증된 commitment 재바인딩("등록 재설정"), secret 내보내기/가져오기 또는 passphrase 유도, finalize 후 분실은 복구 불가임을 명시하는 UX. → **Phase 9에 반영됨.**

### AR-H7 — Rust 컷오버에 비트동일 circom Poseidon 재구현이 필수인데 crate 선정·교차 언어 테스트 벡터가 무계획

- **종류**: 플랜 공백
- **Evidence**:
  - `server/utils/merkle.js:7` / `frontend/src/utils/voterSecret.js:1` — 모든 leaf/node/root가 `circomlibjs` Poseidon (회로와 동일 파라미터)
  - `docs/PROJECT_PLAN.md:679` — Phase 12가 "Compute Merkle root from the snapshot"을 Rust로 포팅; 그러나 플랜·API_COMPATIBILITY에 "poseidon" 단어 0회 (grep 확인)
  - `rust-backend/*/Cargo.toml` — 암호 crate 0개 (poseidon/ark-/light-poseidon grep 0건); zkp crate는 config struct뿐
- **문제**: Poseidon은 라운드 상수·MDS 파라미터화에 민감하다. Rust 구현이 1비트만 달라도 root가 달라져 **모든 증명이 무효**가 되고, 이 위험을 어느 phase도 소유하지 않는다.
- **수정**: circom 호환 crate(예: light-poseidon) 명시적 선정 + 고정 fixture(secret→leaf→root→path) 교차 언어 테스트 벡터 게이트. → **Phase 12에 반영됨.**

### AR-H8 — 평문 voter secret을 만지는 npm 암호 스택에 공급망 통제 0

- **종류**: 플랜 공백 (audit M11은 배포 *시점* 문제; 이것은 배포되는 *내용물* 문제)
- **Evidence**:
  - `frontend/package.json:13,20` — `"circomlibjs": "^0.1.7"`, `"snarkjs": "^0.7.5"` (caret 범위; `proof.worker.js:12`, `voterSecret.js:1`에서 평문 secret 소비)
  - `.github/workflows/deploy-frontend.yml:24`, `deploy-backend.yml:39,48` — `npm ci`가 아닌 `npm install` (EC2 호스트에서 직접 실행 포함)
  - dependabot/renovate/cargo-deny/cargo-audit 설정 0건; `docs/PROJECT_PLAN.md` Phase 17(:882-894)에 의존성 감사·핀·lockfile 강제 태스크 없음
- **문제**: in-range 악성/취약 릴리스가 **자동으로** 라이브 S3/CloudFront 번들과 EC2 백엔드에 유입될 수 있고, 브라우저에서 secret 탈취·증명 오염, 백엔드에서 릴레이어 키 유출이 가능하다.
- **수정**: `npm ci` 전환, 암호 핵심 패키지 정확 버전 핀 + 업그레이드 리뷰 절차, npm/cargo 감사 잡을 required check로. → **Phase 17에 반영됨.**

---

## Medium

### AR-M1 — 제출 티켓이 연결 가능한 bearer 토큰: 운영자가 identity→ticket→nullifier→후보를 조인 가능

- **Evidence**: `proof.js:28,31`(JWT 인증 발급, identity 인지) → `submissionTickets.js:34`(랜덤 UUID) → `submitZk.js:90,93,161`(익명 제출에서 동일 UUID + nullifier + 후보 동시 관측)
- **문제**: H2를 완료해도 **티켓 UUID 자체가 양 엔드포인트의 조인 키**다. 운영자가 (identity→ticket)을 로깅하면 전 유권자 deanonymization. Phase 18 리뷰 한 줄(`:954`)만 존재, 비연결 인가(blind signature/anonymous credential) 요구사항 없음.
- **수정**: identity↔ticket 연관의 비로깅·비저장 원칙(Phase 13에 반영됨) + 비연결 인가 채택 여부의 명시적 결정(Phase 18에 위임). **운영자 대상 익명성의 현재 상한임을 문서로 인정할 것.**

### AR-M2 — 300초 티켓 TTL + 단일 릴레이 + 실시간 VoteCast = 타이밍/순서 deanonymization 채널

- **Evidence**: `submissionTickets.js:3` (`TICKET_EXPIRY_SECONDS = 300`), `VotingTally.sol:54,183`(표별 실시간 이벤트), `VotePage.js`가 `/proof` 응답 직후 시간을 기록하고 ticket TTL 안전 예산 안에서 랜덤 지터를 적용한 뒤 `/submit` 호출, Node/Rust 릴레이어는 hot wallet 직렬화 경로 사용.
- **문제**: 클라이언트 지터를 적용해도 /proof 발급 시각(운영자 보유 가능)과 온체인 제출 시각 사이의 시간 결합 + 표별 공개 이벤트는 완전히 사라지지 않는다. turnout이 낮거나 관찰자가 전역 타이밍을 보는 경우 익명집합이 작아질 수 있다.
- **결정(2026-06-12)**: v1은 프로토콜 변경 없이 저비용 완화 + 잔여 수용. **Phase 13에 반영됨** — TTL-safe 클라이언트 제출 지터, 릴레이어 큐(AR-M5)의 발급 순서 비보존 목표, /proof 발급 타임스탬프 비보존 원칙. **Phase 18에 반영됨** — staging에서 발급↔온체인 시간 상관 측정 + 최소 익명집합/turnout 임계 정의 + 비연결 인가 채택 여부 최종 결정. 글로벌 수동 관찰자에 대한 잔여 상관은 v1 수용.

### AR-M3 — Cloud SQL 권한 모델 부재: 현 RLS 자세 인벤토리도, 새 ROLE/GRANT/POLICY도 없음

- **Evidence**: 원 감사 시점에는 `server/supabaseClient.js:6`(서비스롤로 RLS 우회), `frontend/src/App.js:30`(anon 직접 읽기 — 문서화 안 된 RLS 전제), `rust-backend/migrations/*.sql`(GRANT/ROLE/POLICY 0건), `scripts/gcp/zkvote-staging-setup.sh`(만능 단일 `zkvote_app` 유저)가 문제였다. 현재는 `rust-backend/db/roles.sql`과 staging setup의 `zkvote_app`/`zkvote_migrator` secret 분리로 반영됨.
- **결정(2026-06-12)**: **Phase 3에 반영됨** — Cloud SQL에는 RLS를 도입하지 않는다(PostgREST 소멸 + 모든 접근이 백엔드 경유, 프론트 직접 읽기는 AR-H4의 `/api/me`로 제거). 대신 migration-owner(DDL) / 런타임 앱 role(테이블별 최소 DML) 2-role 분리 + 현 Supabase RLS 자세 인벤토리. 게이트: 런타임 role의 DDL 불가.

### AR-M4 — 단일 hot EOA = 릴레이어 + 배포자 + 모든 VotingTally의 회수 불가 owner

- **Evidence**: 원 감사 시점에는 `submitZk.js`/`finalizeVote.js`/`hardhat.config.js`가 동일 `PRIVATE_KEY`를 사용하고 `VotingTally` owner가 배포자로 고정되어 있었다. 현재는 `VotingTally` constructor가 explicit owner를 받고, `scripts/deployAll.js`/`scripts/deploy_votingtally.js`/Rust `deploy_election`이 `(verifier, electionId, numCandidates, owner)`를 전달하며, finalize는 `OWNER_PRIVATE_KEY`를 우선 사용한다.
- **문제**: 가장 인터넷 노출이 큰 서명 경로(익명 제출 릴레이)의 키가 유출되면 미구성 선거에 `configureElection(attacker_root,...)`을 선점할 수 있고 `require(!configured)`가 탈취를 영구 고정한다. 키 로테이션 불가, 가스 잔고 모니터링 미계획.
- **수정**: owner 키(cold/multisig)와 가스 전용 hot 릴레이어 키 분리, 명시적 owner constructor, Secret Manager owner-key mount, 가스 모니터링 계획. → **Phase 11에 반영됨.**

### AR-M5 — 릴레이어 nonce 직렬화 부재: 서로 다른 유권자의 동시 제출이 nonce 충돌

- **Evidence**: 원 감사 시점에는 `submitZk.js`의 lock이 ticket/nullifier 스코프라 상이한 유권자 간 relayer nonce 직렬화가 없었다. 현재 Node submit은 `submit:relayer-wallet` lock을 실제 tx consume/send/wait 구간에 추가했고, Rust submit은 `AppState.relay_lock`으로 동일 wallet send를 직렬화한다.
- **문제**: RPC 왕복 윈도 안의 동시 send가 같은 nonce를 받아 한쪽이 거부되고, **이미 소비된 티켓**은 복구되지 않는다 (audit M1과 별개의 손실 경로).
- **수정**: 지갑 단위 송신 직렬화(현재 v1은 단순성을 위해 `tx.wait()`까지 락 안에 둔다; staging queue 최적화는 후속 개선). → **Phase 13에 반영됨.**

### AR-M6 — wasm/zkey 브라우저 서빙 표면을 어느 phase도 소유하지 않음 + 클라이언트 무결성 검증 부재

- **Evidence**: 원 감사 시점에는 `VotePage.js`가 Node `/zkp-files` 정적 마운트에 직접 의존했고, 컷오버 후 Rust가 브라우저에 wasm/zkey를 제공하는 표면이 없었다. 현재 Node는 `/api/elections/:id/artifact-info`와 제한된 `/api/zkp-files/build_*`만 노출하고, Rust도 `/api/elections/:id/artifact-info` + 제한된 `/api/zkp-files/*artifact_path`를 제공한다. Rust route는 local artifact dir와 `ARTIFACT_STORE=gcs`를 모두 지원하고, GCS 모드에서는 service-account metadata token으로 Storage JSON API에서 artifact bytes를 가져온다. 프런트는 `fetchVerifiedArtifact()`로 wasm/zkey sha256을 검증한 뒤에만 증명을 생성한다.
- **문제**: 조작된 wasm/zkey를 브라우저가 그대로 실행하면 H2의 client-held secret 모델이 무효화된다(웹 전달 신뢰 상한). 또한 Rust cutover 시 artifact retrieval route가 빠지면 정상 유권자가 proof를 만들 수 없다.
- **수정**: manifest 기반 artifact-info + 제한된 local/GCS artifact serving + 클라이언트 해시 검증·불일치 시 증명 거부. → **Phase 10/15/16에 반영됨.**

### AR-M7 — 선거 라이프사이클이 on-chain one-shot: 잘못된 voteEndTime이 선거를 영구 brick (수동 검증 완료)

- **Evidence**: `VotingTally.sol:119`(configureElection `require(!configured)`; setVotingPeriod도 동일, 이후 변경 함수 없음 — 전문 확인), `finalizeVote.js:41,53-54`(req.body의 voteEndTime, 상한·재확인 없음), `setupAndDeploy.js:99-104`·`deployAll.js:59-62`(재배포 경로 차단)
- **문제**: 오타 한 번이면 수년짜리 투표 기간이 고정되고 완료 처리도 차단(`completeVote` 403). 연장/취소/대체 배포 runbook 전무.
- **결정(2026-06-12)**: 온체인 불변성 **유지**(투표 중 기간을 바꿀 수 있는 owner 권한 자체가 더 큰 거버넌스 리스크) + 보상 통제. **Phase 12에 반영됨** — finalize 시 최대 투표 기간 상한(기본 30일, 초과 시 명시적 확인 필드) 검증·게이트. **Phase 11에 반영됨** — "supersede election" runbook(DB superseded 마킹 + 명시적 관리자 플로우로만 ALREADY_DEPLOYED 가드 해제 후 대체 컨트랙트 배포)·게이트.

---

## Low (요약)

| ID | 내용 | Evidence 핵심 | 처리 |
| --- | --- | --- | --- |
| AR-L1 | `API_COMPATIBILITY.md`가 v1 취약 계약(3-signal, 평문 user_secret, salt 기반 register)을 Rust parity 기준으로 명시, 갱신 태스크 부재. Phase 9/13/18 게이트가 v1 재생산은 차단하므로 Low | `API_COMPATIBILITY.md:226,233,277,296` vs `submitValidation.js:9-10`, `proof.js:26`, `register.js:37` | **v2 재기준화 완료 (2026-06-12)** |
| AR-L2 | 플랜 "Current Baseline"·audit.md가 Phase 1 이후 stale (C1/H1 "미수정"을 현재 사실로 서술) → Phase 16 게이트("open Critical/High 없음") 판정 불가 | `PROJECT_PLAN.md:46-48`, `:1122-1126` | audit 클로저 매트릭스(rev5 또는 SECURITY_REVIEW.md) 필요 — Phase 18 |
| AR-L3 | 실시간 집계·표별 이벤트가 "results only through completed surface"(`:122`)와 모순. 공개 체인 특성상 **수용 또는 완화(커밋-공개/이벤트 제거)를 명시 결정**해야 | `VotingTally.sol:46,54,180` | **v1 수용 결정(2026-06-12)** — §4 Voter Flow 10 문구 정정(온체인 공개 속성 + 유권자 측 영수증 가능성 명시) + Phase 18 위협모델 기록 태스크 반영 |
| AR-L4 | Rust 인증은 JWKS-only인데 addAdmins parity는 Supabase **Auth Admin API**(service-role) 필요 — staging에 해당 시크릿 미계획 | `addAdmins.js:21,85-94` | Phase 5 결정 항목 |
| AR-L5 | 사용처 없는 SECRET_SALT가 staging 시크릿·문서에 잔존 (H2 이후 서버 코드 grep 0건) | 현재 setup script와 `.env.example`에서는 제거/legacy 표기 완료 | 제거/legacy 표기 |
| AR-L6 | v1(uint[3]) 배포 선거가 DB상 투표 가능해 보이나 모든 제출 실패 — 차단 가드/ELECTION_REQUIRES_REDEPLOY 부재 (IMPLEMENTATION_GOALS에만 서술) | `IMPLEMENTATION_GOALS.md:35,37` | Phase 3/10에서 ABI 버전 기록 권장 |
| AR-L7 | `ETHERSCAN_API_KEY` 어디에도 미문서화, verify 실패는 무해하게 삼켜짐 | `hardhat.config.js:14-15`, `.env.example`(부재) | .env.example 추가 권장 |
| AR-L8 | front-run(calldata 복사) 시 표는 정상 집계되나 릴레이어 tx revert → 유권자에게 500, 티켓 소비됨 (수동 검증: 후보 변조는 불가능 — 신호가 증명에 고정) | `VotingTally.sol:145-150,168,175` | Phase 13에 success-by-other-tx 처리 반영됨 |
| AR-L9 | Phase 7 게이트가 Phase 15에서야 생기는 API-base-URL 플래그에 의존 (8 phase 선행 참조) | `PROJECT_PLAN.md:480` vs `:808` | 플래그 태스크 전진 배치 권장 |
| AR-L10 | Phase 1 DoD가 M13 "concrete fix"를 요구하나 어떤 phase·Goal에도 M13 커버 태스크 없음 | `PROJECT_PLAN.md:245-247`(M13 외 출현 0) | **반영됨(2026-06-12)** — Phase 1에 M13 태스크 bullet 추가 + `IMPLEMENTATION_GOALS.md` Goal 3에 (d) M13 추가 |
| AR-L11 | Phase 3 게이트 "BigInt round-trip through the API"가 Phase 3 시점에 검증 불가(해당 API가 Phase 13에야 존재) | `PROJECT_PLAN.md:332-333` vs `:367-374` | sqlx 레벨 round-trip으로 재정의 권장 |
| AR-L12 | Phase 0 게이트("모든 라우트에 request/response/error 노트") 대비 API_COMPATIBILITY에 /setZkDeploy·/complete 응답, /proof 요청, 에러 코드 명세 누락 (수동 검증) | `PROJECT_PLAN.md:150-152` vs `API_COMPATIBILITY.md:187-204,312-320` | 핵심 3개 라우트는 v2 재기준화에서 갱신; 전 라우트 에러 명세 백필은 잔여 |
| AR-L13 | `.env.example`이 Node 부팅 필수 변수(SUPABASE_SERVICE_ROLE_KEY/KEY, PORT) 누락 + 서버는 루트 .env를 읽지도 않음(`server/.env`만 로드) | `PROJECT_PLAN.md:261`, `supabaseClient.js:3` | Phase 2에서 정리 권장 |

## 기각된 의심 (오탐 방지용 기록)

- **AR-X1 — "orphan uint[3] verifier(`Groth16Verifier_{3,4_10,6_10,10_10}.sol`)가 새 uint[4] 경계에 배포될 수 있다"**: 기각. `setupAndDeploy.js:36-43`의 `missingArtifacts()`가 build 디렉토리의 wasm/zkey/vkey 부재를 감지해 배포 전 `setUpZk.sh`를 강제 실행하고, 이것이 stale `.sol`을 uint[4]로 덮어쓴다(self-heal). 잔여 루트커즈(버전/해시 바인딩)는 audit **M5**가 이미 추적.

## 권고 우선순위

1. **Phase 1 진행 중 즉시**: AR-H2(용량 가드 — Node 백포트), AR-L10(✅ 반영 완료), AR-L1(✅ 완료)
2. **Rust 포팅 시작 전(Phase 4 이전)**: AR-H5(✅ 스펙 정정 완료), AR-H7(Poseidon 결정), AR-L9/L11(게이트 정정 — 잔여)
3. **staging 전**: AR-H1(beacon/MPC), AR-H6, AR-H8, AR-M4/M5/M6, AR-M3(✅ Phase 3 결정 반영)
4. **cutover 전**: AR-H3, AR-H4
5. **수용/완화 결정 — 2026-06-12 모두 결정 완료**: AR-M2(✅ 저비용 완화 + 글로벌 관찰자 잔여 수용, Phase 13/18), AR-L3(✅ v1 공개 집계·영수증 가능성 수용, §4/Phase 18), AR-M7(✅ 불변성 유지 + 기간 상한·supersede runbook, Phase 11/12). **단 AR-M1의 비연결 인가(blind signature) 채택 여부는 Phase 18 측정 결과를 보고 최종 결정**하는 항목으로 유지.

잔여 미반영(Low): AR-L2(audit 클로저 매트릭스 — Phase 18 산출물로 해소 예정), AR-L4~L7, AR-L9, AR-L11~L13 — 각 행의 처리 칸 참조.
