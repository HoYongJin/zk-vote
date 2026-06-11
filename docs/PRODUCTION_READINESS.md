# Production Readiness Plan (Phase 20)

> Production is provisioned SEPARATELY from staging — new resource names,
> new secrets, no in-place upgrades. Nothing here may run before staging
> (Phase 16) and cutover (Phase 19) have passed their gates.

## Infrastructure (separate from staging)

| 항목 | 스테이징 | 프로덕션 계획 |
|------|----------|---------------|
| 프로젝트/이름 | `zkvote-staging-*` in shared POC project | 전용 프로젝트, `zkvote-prod-*` |
| Cloud SQL | 최저 티어, 단일 존 | 상위 티어 + HA(regional), 자동 백업 + PITR |
| Redis | Memorystore basic(무영속) | Standard(HA) — 락/티켓은 휘발 허용이지만 fail-over 필요 |
| Cloud Run | min 0 / max 2 | min 1(콜드스타트 회피) / 부하 테스트 결과로 max 결정 |
| Secrets | `zkvote-staging-*` 비밀별 IAM | `zkvote-prod-*` 별도 생성(M9 패턴), OWNER 키는 런타임 비탑재(AR-M4) |
| 도메인/TLS | Cloud Run 기본 | 커스텀 도메인 + 관리형 TLS + CORS 화이트리스트 |

## Backup / Restore

- Cloud SQL: 자동 백업(일1회) + PITR 7일. **복구 리허설 게이트**: 백업에서
  새 인스턴스로 restore → `scripts/local/db-verify.sh`의 게이트 SQL 통과 +
  ETL 체크섬 함수로 원본 대조.
- Redis: 영속 데이터 없음(락/티켓/캐시). 장애 시 동작: 티켓 소실 → 유권자는
  `/proof` 재호출로 재발급(설계상 안전), 락 소실 → advisory lock(Postgres)
  경로는 무영향, Node 경로는 충돌 시 409.
- 아티팩트(GCS): 버전 보존 + lifecycle 정책(`infra/gcp/artifact-lifecycle.json`).
- 키: OWNER_PRIVATE_KEY는 콜드 보관 + 사용 절차 문서화; 릴레이어 키 로테이션
  절차(새 키 주입 → 가스 이전 → 구 키 폐기).

## Monitoring / Alerting

- Cloud Run: 5xx율, p95 지연, 인스턴스 포화.
- Cloud SQL/Redis: 연결 실패, 디스크/메모리.
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

## Gates (Phase 20)

- Restore 테스트 성공 (위 절차).
- 스테이징 부하 테스트가 목표 용량 충족.
- 프로덕션 시크릿이 스테이징과 완전 분리.
