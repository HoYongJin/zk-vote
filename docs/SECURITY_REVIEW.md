# zk-vote Security Review (canonical, Phase 18)

> **Status (2026-06-12)**: this document PROMOTES `audit.md` (rev5) to the
> canonical security-review artifact planned by PROJECT_PLAN Phases 1/18.
> Finding bodies and evidence live in `audit.md` (C1/H1–H5/M1–M13) and
> `docs/ARCHITECTURE_REVIEW.md` (AR-*); this file owns the closure state,
> trust boundaries, and the accepted-risk threat model.

## 1. Audit closure matrix

Authoritative table: **`audit.md` rev5 "Phase 1 클로저 매트릭스"** —
C1, H1–H5, M1–M13 are ALL CLOSED with code + test evidence (70 hardhat
tests; M6–M8 closed by Phase 3 with `scripts/local/db-verify.sh` gates).

Architecture-review items closed since rev5:

| ID | 상태 | 구현 | 증거 |
|----|------|------|------|
| AR-H1 | CLOSED (tooling) | `setUpZk.sh` BEACON_HEX 공개 beacon 마무리 + 상시 `snarkjs zkey verify` 게이트; `REQUIRE_BEACON=true`면 비-beacon zkey 배포 거부 | 실측 "ZKey Ok!", 409 `ZKEY_NOT_BEACON_FINALIZED`. 스테이징 선거는 공개 beacon 값(예: drand 라운드) 사용 절차 필요 |
| AR-H2 | CLOSED | Node `OVER_CAPACITY` + Rust 임계구역 내 용량 가드 | registerByAdmin/voters 게이트 테스트 |
| AR-H4 | CLOSED | `/api/me` (Node + Rust), 프론트 직접 Supabase 읽기 제거 | meRoute 테스트, App.js |
| AR-H5 | CLOSED | 티켓 = election+root만 (Node·Rust 동일), nullifier 비바인딩 | submissionTickets/vote.rs 테스트 |
| AR-H6 | CLOSED | Rust 등록 re-bind (같은 사용자, 마감 전) | Phase 9 게이트 |
| AR-H7 | CLOSED | light-poseidon(circom 파라미터) + 교차 언어 벡터 커밋 | 5 벡터 게이트 바이트 동일 |
| AR-H8 | CLOSED | CI npm ci/감사 잡, snarkjs/circomlibjs/circomlib/fixed-merkle-tree 정확 핀 | ci.yml, package.json |
| AR-M4 | CLOSED | VotingTally 명시적 `_owner`; 릴레이어 키 onlyOwner 무권한 | hardhat + alloy 게이트(릴레이어 configure revert) |
| AR-M5 | CLOSED (local) | Rust 릴레이 전송 직렬화(`relay_lock`) | vote.rs; 스테이징은 send/wait 분리 최적화 여지 |
| AR-M6 | CLOSED | `/artifact-info` + 브라우저 WebCrypto 해시 검증, 불일치 시 증명 거부 | artifactInfoRoute 테스트 + VotePage |
| AR-M7 | CLOSED | 온체인 불변 + supersede runbook + `superseded_at`(제출 거부) + finalize 30일 상한 | RUNBOOK_SUPERSEDE.md, Phase 12/13 게이트 |
| AR-H3 | OPEN → Phase 19 | 데이터 ETL/dual-write/롤백 — 컷오버 시점 작업 | 계획 수립됨(PROJECT_PLAN Phase 19) |
| AR-M1 | OPEN (by design) | 비연결 인가(blind signature) 채택 여부 — 스테이징 타이밍 측정 후 결정 | identity↔ticket 비로깅 원칙은 적용됨 |
| AR-M2 | PARTIAL | 티켓에 발급 타임스탬프 없음(Rust). 잔여: 클라이언트 제출 지터, 발급 순서 비보존 큐 — 스테이징 전 적용 + 측정 | v1 잔여 상관 수용(결정 2026-06-12) |

## 2. Trust boundaries

| 경계 | 신뢰 가정 | 통제 |
|------|-----------|------|
| 브라우저 증명 생성 | 클라이언트만 평문 secret 보유 (H2) | secret은 localStorage 한정; wasm/zkey는 배포 해시 검증 후에만 사용(AR-M6); poseidon-lite ↔ circomlibjs 비트 동일 테스트 |
| `/proof` 발급 (인증) | 서버는 nullifier를 알 수 없음 | 티켓 = election+root만(AR-H5); 커밋먼트 기반 Merkle 경로 |
| Redis 티켓 | 단일 사용, 5분 TTL | validate-then-consume(GETDEL은 preflight 통과 후, M1) |
| 릴레이어 tx 제출 (익명) | 핫 키는 가스 지불만 | owner 분리(AR-M4): 유출돼도 configureElection 불가; 전송 직렬화(AR-M5) |
| 온체인 검증 | 컨트랙트가 최종 심판 | C1 election 바인딩 + H1 부울 제약 + nullifier 유일성; trusted setup은 beacon 검증 transcript(AR-H1) |
| 아티팩트 생성/보관 | 운영자 생성물 무결성 | M5 선거별 해시 바인딩 + `ARTIFACT_MISMATCH`; CI 스키마 게이트(nPublic=4) |
| DB (Postgres) | 스키마가 최후 방어선 | 고유 제약(이메일/user_id/nullifier), 2-role 권한(AR-M3), 내구적 등록 마감(H4/M3) |

## 3. Threat model — accepted v1 properties (AR-L3, 결정 2026-06-12)

1. **온체인 공개성**: 진행 중 집계(`voteCounts`)와 표별 후보 선택
   (calldata, `VoteCast`)은 체인 접근자 누구에게나 공개된다. 숨기려면
   commit-reveal/집계 프로토콜 재설계가 필요하며 v1 범위 밖.
2. **영수증 가능성**: secret 보유 유권자는 자신의 투표 내용을 제3자에게
   증명할 수 있다(매표 노출). v1 수용.
3. **글로벌 수동 관찰자의 타이밍 상관**(AR-M2 잔여): 저비용 완화 적용
   후에도 남는 상관은 v1 수용, 스테이징에서 측정(Phase 18 잔여 태스크).
4. **운영자 연결 상한 = 티켓**(AR-M1): 운영자가 (identity→ticket)을
   로깅하면 비식별화 가능. 비로깅 원칙으로 완화, 비연결 인가 채택은
   스테이징 측정 후 결정.

## 4. Key management

- 시크릿 커밋 금지: 저장소의 키는 (a) hardhat 공개 개발 키(테스트 전용,
  체인 로컬), (b) `crates/api/testdata`의 **test-only** RSA 키쌍뿐.
- `zkvote_dev_password`는 docker-compose 로컬 전용 기본값(문서화됨).
- 스테이징: Secret Manager 비밀별 IAM(M9), DB URL 즉시 기록(M10),
  OWNER_PRIVATE_KEY ≠ 릴레이어 키(AR-M4).

## 5. Verification gate status (Phase 18)

- 커밋된 파일에 릴레이어 키/DB 비밀번호 없음 — 위 4절 예외만 존재 ✅
- 아티팩트 버킷 IAM 버킷 스코프(M9) ✅ (스크립트 수준; 실배포는 Phase 16)
- submit 경로 replay/mismatch 테스트 ✅ (Node 70 + Rust E2E 게이트)
- C1/H1/H2 회귀 테스트 존재, 실패 버전 이해됨 ✅
- finalize 부분 실패 테스트 존재 ✅ (Node 4케이스 + Rust 게이트)

## 6. Remaining pre-production work

스테이징 의존(전부 PROJECT_PLAN에 귀속): Phase 16(Cloud Run 배포 — 비용
승인 필요), AR-M2 측정 + 클라이언트 지터, AR-M1 최종 결정, Phase 19
ETL/롤백 리허설(AR-H3), Phase 20 운영 준비. 로컬 범위 잔여 Low는 모두 해소됨(2026-06-12): AR-L9/L11 플랜 게이트 문구
정정, `/api/zkp-files` 마운트를 build_* 산출물 3종으로 축소(실측: 산출물
200 / 스크립트·소스·circuit_0000 404).
