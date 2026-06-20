# Runbook: Node → Rust + Supabase → GCIP Cutover (Phase 21)

> Pre-conditions: Phase 18 staging is live (Cloud Run on GCIP auth) and
> `docs/SECURITY_REVIEW.md` shows no open Critical/High. The cutover is
> route-by-route via the frontend's `REACT_APP_API_BASE_URL`; the legacy Node
> image + the Supabase-auth frontend build + a Supabase data snapshot all stay
> deployable for rollback until one full staging election lifecycle has passed
> on Rust+GCIP.

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
     (pre-H2 plaintext-era row) or any null/empty `Voters.email` — investigate
     before proceeding.
   - Gate: it must print `ETL complete: all row counts and checksums match`.
     The checksum gate runs before `COMMIT`, so a non-empty/diverging target
     rolls back instead of leaving partially migrated rows behind.
   - v1 `uint256[3]`-era elections: mark completed or superseded
     (`docs/RUNBOOK_SUPERSEDE.md`) during the freeze — v2 contracts are
     required for live elections.
3. **Identity cross-check (Phase-20 gate)**: confirm the set of
   `voters.user_id` / `admins.id` now in Cloud SQL equals the set of GCIP uids
   provisioned in Phase 7 (accounting for the documented OAuth-only partition
   from `import-users-to-gcip.js` — those re-onboard via Google/password-reset,
   they are NOT a 1:1 row). No `user_id` may resolve to a non-existent GCIP
   identity. (This cross-check is operator-run — see the ETL note below; the ETL
   itself does not contact GCIP.)
4. **Cut auth over to GCIP**: the frontend already mints Firebase/GCIP ID tokens
   (Phase 16) and the backend already validates them (Phase 18:
   `SUPABASE_JWT_ISSUER=https://securetoken.google.com/<PROJECT_ID>`,
   `SUPABASE_JWT_AUDIENCE=<PROJECT_ID>`). Verify a GCIP-issued token is accepted
   and a Supabase-issued token is now rejected before moving any write traffic.
   Confirm imported users can sign in with `sub` = their old Supabase UUID.
5. **Side-by-side**: run Node and Rust against the migrated data; compare
   the three read lists + `/api/me` for an admin and a voter account.
   - For Cloud Run staging, deploy with `CORS_ALLOWED_ORIGINS` set to the
     staging frontend origin and
     `OWNER_PRIVATE_KEY_SECRET=zkvote-staging-owner-private-key` so finalize
     can call `configureElection` with the explicit contract owner key. The
     owner key must differ from the hot relayer key in staging/production.
6. **Switch reads**: point the frontend at Rust (`REACT_APP_API_BASE_URL`).
   Verify lists + role routing.
7. **Switch writes by lifecycle**: set/addAdmins → voters/register →
   finalize → proof/submit LAST (privacy-critical path moves only after
   everything else has soaked).
8. **Soak**: one complete staging election lifecycle on Rust
   (create → deploy → allowlist → register → finalize → vote → complete).

## Rollback checklist

> **Rollback is a THREE-artifact restore, not backend-only.** Since Phase 16 the
> live frontend mints GCIP tokens and `server/` + the Supabase SDK are gone from
> the tree. Repointing only the API base URL at a restored Node image is
> **auth-incompatible**: the restored Node expects Supabase JWTs while the live
> frontend still mints GCIP tokens, so every request 401s. Keep all three
> artifacts deployable until the soak (step 8) passes:
> `{ tagged pre-deletion Node image, tagged Supabase-auth frontend build, Supabase data snapshot }`.

1. **Frontend → Supabase-auth build**: redeploy the tagged pre-Phase-16 frontend
   build (Supabase Auth SDK) and restore its `REACT_APP_SUPABASE_*` config, so the
   client mints Supabase JWTs again.
2. **Backend → Node**: repoint `REACT_APP_API_BASE_URL` at the restored Node image
   and re-point the Supabase auth secrets it reads. (Backend and frontend must be
   reverted together — a half rollback leaves auth mismatched.)
3. **Auth sign-in check**: confirm a user can sign in against the restored Supabase
   stack and reach a read route end-to-end before declaring rollback complete.
4. **Data rollback path** (AR-H3): rows Rust wrote during the soak are reconciled
   back to hosted Supabase with the INVERSE of the ETL column mapping (Cloud SQL
   `voters.user_secret_commitment` → legacy Supabase `Voters.user_secret`,
   snake_case → PascalCase). This inverse is an **operator-run reconciliation
   script/SQL — there is no prebuilt inverse-ETL command**; only tables Rust wrote
   during the soak need it. Verify the restore with the ETL module's exported
   `checksum()` helper (`require('./etl-supabase-to-postgres').checksum`), which is
   the same order-independent content hash used on the forward path.
5. Keep the Cloud SQL data intact (do not drop) — it re-syncs on the next
   cutover attempt; the ETL upsert is idempotent (verified).
6. Record the rollback cause in the incident log before re-attempting.

## Verification gates (PROJECT_PLAN Phase 21)

- Full staging lifecycle passes on Rust+GCIP. (staging)
- A GCIP token is accepted and a Supabase token is rejected by the live backend.
- Migrated row counts/checksums match: **measured locally** with the ETL
  self-test (mock source → local Postgres, including the
  polluted-target failure case and idempotent re-run).
- `voters.user_id` / `admins.id` set == provisioned GCIP uid set (Phase-20 gate).
- Rollback rehearsal restores the **full three-artifact set** — Node image +
  Supabase-auth frontend + Supabase data — and a user can sign in against the
  restored Supabase stack. (staging)
