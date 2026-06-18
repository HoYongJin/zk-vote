# Runbook: Node → Rust Cutover (Phase 19)

> Pre-conditions: Phase 16 staging is live and `docs/SECURITY_REVIEW.md`
> shows no open Critical/High. The cutover is route-by-route via the
> frontend's `REACT_APP_API_BASE_URL`; Node stays deployable for rollback
> until one full staging election lifecycle has passed on Rust.

## Cutover checklist

1. **Freeze**: announce a write-freeze window; stop accepting new elections
   on Node (`/elections/set` paused operationally). No dual-write is used —
   the freeze window is the chosen strategy (decision AR-H3): traffic is
   low and a short freeze is simpler and safer than dual-write conflict
   resolution.
2. **Schema + ETL**: run schema migrations with the
   `zkvote-staging-migrator-database-url` secret, then run
   `rust-backend/db/roles.sql` with an admin/owner connection so
   `zkvote_app` loses DDL privileges and receives only the runtime grants;
   then run `scripts/migration/etl-supabase-to-postgres.js` with
   `TARGET_DATABASE_URL` set to the runtime `zkvote-staging-database-url`
   secret.
   - The script ABORTS on any non-field-element `Voters.user_secret`
     (pre-H2 plaintext-era row) — investigate before proceeding.
   - Gate: it must print `ETL complete: all row counts and checksums match`.
     The checksum gate runs before `COMMIT`, so a non-empty/diverging target
     rolls back instead of leaving partially migrated rows behind.
   - v1 `uint256[3]`-era elections: mark completed or superseded
     (`docs/RUNBOOK_SUPERSEDE.md`) during the freeze — v2 contracts are
     required for live elections.
3. **Side-by-side**: run Node and Rust against the migrated data; compare
   the three read lists + `/api/me` for an admin and a voter account.
   - For Cloud Run staging, deploy with `CORS_ALLOWED_ORIGINS` set to the
     staging frontend origin and
     `OWNER_PRIVATE_KEY_SECRET=zkvote-staging-owner-private-key` so finalize
     can call `configureElection` with the explicit contract owner key. The
     owner key must differ from the hot relayer key in staging/production.
4. **Switch reads**: point the frontend at Rust (`REACT_APP_API_BASE_URL`).
   Verify lists + role routing.
5. **Switch writes by lifecycle**: set/addAdmins → voters/register →
   finalize → proof/submit LAST (privacy-critical path moves only after
   everything else has soaked).
6. **Soak**: one complete staging election lifecycle on Rust
   (create → deploy → allowlist → register → finalize → vote → complete).

## Rollback checklist

1. Repoint `REACT_APP_API_BASE_URL` at Node (frontend redeploy or env swap).
2. **Data rollback path** (AR-H3): rows written by Rust during the soak are
   reconciled back to hosted Supabase with the INVERSE of the ETL mapping
   (`voters.user_secret_commitment` → legacy `user_secret` column). Only
   tables Rust wrote during the soak need reconciliation; use the ETL's
   checksum functions to verify the restore.
3. Keep the Cloud SQL data intact (do not drop) — it re-syncs on the next
   cutover attempt; the ETL upsert is idempotent (verified).
4. Record the rollback cause in the incident log before re-attempting.

## Verification gates (PROJECT_PLAN Phase 19)

- Full staging lifecycle passes on Rust. (staging)
- Migrated row counts/checksums match: **measured locally** with the ETL
  self-test (mock source → local Postgres, including the
  polluted-target failure case and idempotent re-run).
- Rollback rehearsal restores Node without data loss. (staging)
