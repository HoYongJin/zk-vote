# Production Readiness Plan (Phase 22)

> Production is provisioned SEPARATELY from staging — new project, new resource
> names, new secrets, no in-place upgrades. Nothing here may run before staging
> (Phase 18) and cutover (Phase 21) have passed their gates.

## Infrastructure (separate from staging)

| 항목 | 스테이징 | 프로덕션 계획 |
|------|----------|---------------|
| 프로젝트/이름 | 전용 프로젝트 `zkvote-staging`, 리소스 `zkvote-staging-*` | 전용 프로젝트 `zkvote-prod`, 리소스 `zkvote-prod-*` |
| Cloud SQL | 최저 티어, 단일 존 | 상위 티어 + HA(regional), 자동 백업 + PITR, **deletion-protection** |
| Redis | Memorystore basic(무영속) | Standard(HA) — 락/티켓은 휘발 허용이지만 fail-over 필요 |
| Cloud Run | min 0 / max 2 | min 1(콜드스타트 회피) / 부하 테스트 결과로 max 결정 |
| Secrets | `zkvote-staging-*` 비밀별 IAM | `zkvote-prod-*` 별도 생성(M9 패턴) |
| OWNER 키 | relayer와 분리된 별도 시크릿, 런타임 마운트 | 동일 — **별도 cold 키를 런타임 마운트(AR-M4)** |
| 도메인/TLS | Cloud Run 기본 | 커스텀 도메인 + 관리형 TLS + CORS 화이트리스트 |

> **OWNER 키는 런타임 마운트가 필수다 (AR-M4 정정).** `finalize`는
> `configureElection`를 호출하기 위해 `OWNER_PRIVATE_KEY`를 읽으며, 없으면
> **503으로 fail-closed**(`finalize.rs:219-223`) → 모든 선거의 finalize가 막힌다.
> AR-M4의 요지는 "owner 키를 *탑재하지 말라*"가 아니라 "owner 키 ≠ hot relayer 키"다:
> owner 키는 cold하게 생성·보관·로테이션하되 relayer와 **다른** 별도 시크릿으로 런타임에
> 마운트한다(relayer는 가스만 지불, configureElection 권한 없음). 프로덕션도 스테이징과
> 동일하게 `zkvote-prod-owner-private-key`를 마운트하고 relayer 키와 다름을 배포 가드가
> 검증한다(`deploy-staging-api.sh` L48-51 패턴).

## Production GCIP (Phase 22)

- 전용 프로젝트 `zkvote-prod`의 **별도 GCIP 테넌트** — 스테이징 GCIP와 분리(또는 스테이징
  GCIP 프로젝트 승격). **Google + email/password** provider, **email-verification 강제**.
- issuer `https://securetoken.google.com/<prod-project>`, audience `<prod-project-id>`.
  이 셋 — 백엔드 audience(`SUPABASE_JWT_AUDIENCE`), GCIP 프로젝트, **프론트
  `REACT_APP_FIREBASE_PROJECT_ID` / `.firebaserc`** — 은 모두 같은 prod 프로젝트 id여야
  한다. 어긋나면 프론트가 발급한 토큰을 백엔드가 100% 거부한다.
- 프로덕션 유저 임포트(또는 스테이징 GCIP 승격) 시 **`uid` = Supabase UUID 유지**
  (`sub`가 UUID로 남아 `admins.id`/`voters.user_id` FK가 resolve; 재등록 불필요).
- invariant #8: `email_verified`는 top-level 클레임을 읽고 RUST-AUTH-2가 미검증 이메일을
  거부 — 프로덕션 GCIP에서 실제 검증 흐름이 동작함을 재확인.

## Chain deploy guards (§0.5)

- **프로덕션 체인 = Sepolia (chainId `11155111`)** — §0.5에 고정. `hardhat.config.js`의
  `sepolia` 네트워크에 `chainId: 11155111` pin(#1)과 `deploy_election`의 `eth_chainId`
  배포 가드(#2)가 이미 적용됨(`crates/chain/src/lib.rs`).
- 배포 게이트: `CHAIN_ID` == 노드의 `eth_chainId` 일치(불일치 시 `deploy_election`이
  `ChainError::Config`로 배포 거부, 가스 소모 전).
- 알려진 추적 항목: `configure_election`/`submit_tally`는 `eth_chainId`를 재검증하지 않음
  (deploy만; 운영자 한정·테스트넷에서 미미 — `lib.rs`에 문서화). 메인넷/L2 이전 시 §0.5
  네 갭이 모두 재오픈되는 별도 스코프.

## Backup / Restore

- Cloud SQL: 자동 백업(일1회) + PITR 7일. **복구 리허설 게이트**: 백업에서
  새 인스턴스로 restore → `scripts/local/db-verify.sh`의 게이트 SQL 통과 +
  ETL의 export된 `checksum()` 함수로 원본 대조.
- Redis: 영속 데이터 없음(락/티켓/캐시). 장애 시 동작: 티켓 소실 → 유권자는
  `/proof` 재호출로 재발급(설계상 안전), 락 소실 → advisory lock(Postgres)
  경로는 무영향.
- 아티팩트(GCS): 버전 보존 + lifecycle 정책(`infra/gcp/artifact-lifecycle.json`);
  객체는 `scripts/gcp/seed-artifacts.sh`로 시드(빌드별 sha256 검증, invariant #7).
- 키: OWNER_PRIVATE_KEY는 cold 보관 + 사용 절차 문서화; 릴레이어 키 로테이션
  절차(새 키 주입 → 가스 이전 → 구 키 폐기).

## Monitoring / Alerting

- Cloud Run: 5xx율, p95 지연, 인스턴스 포화.
- Cloud SQL/Redis: 연결 실패, 디스크/메모리.
- **GCIP: 로그인 실패율 / 토큰 검증 실패(인증 경계 모니터링 — §22 필수 항목).**
- 릴레이어: 가스 잔고 임계(AR-M4 모니터링 항목), `CHAIN_UNAVAILABLE` 빈도,
  `finalization_jobs.status='failed'` 알림.
- 선거 무결성: `vote_submissions` 대비 온체인 `voteCounts` 합계 정기 대조 잡.

## Incident runbook (요약)

1. **finalize 부분 실패**: `finalization_jobs`에서 마지막 상태 확인 →
   `onchain_confirmed`+`db_synced` 아님 → finalize 재호출(멱등 복구 검증됨).
2. **아티팩트 드리프트**(`ARTIFACT_MISMATCH`): 제공 중단 → manifest 대조 →
   필요 시 supersede(RUNBOOK_SUPERSEDE.md).
3. **릴레이어 키 유출 의심**: 키 로테이션(컨트랙트 권한 없음 — AR-M4로
   blast radius는 가스뿐) → 새 키로 교체 후 잔고 이전.
4. **선거 설정 오류**: RUNBOOK_SUPERSEDE.md.

## Load / concurrency test plan

- 등록 폭주: 동시 등록 N=200 (advisory lock 직렬화 하에서 오류율/지연 측정).
- 제출 폭주: 동시 submit N=50 — relay 직렬화(AR-M5) 하에서 처리율, 티켓
  소실 0 확인.
- finalize 동시성: 동시 finalize 5회 → 정확히 1회 성공, 나머지 409.

## Gates (Phase 22)

- Restore 테스트 성공 (위 절차).
- 스테이징 부하 테스트가 목표 용량 충족.
- 프로덕션 시크릿이 스테이징과 완전 분리.
- 프로덕션 GCIP(Google + email/password)가 발급한 토큰을 prod API가 수락하고
  email-verification이 강제됨; 프론트/백엔드/GCIP 프로젝트 id 일치.
- 고정 체인의 `eth_chainId`가 배포 시 `CHAIN_ID`와 일치; §0.5 네 갭 닫힘.
