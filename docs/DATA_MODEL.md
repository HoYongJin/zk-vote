# zk-vote Data Model and Migration Decisions (Phase 3)

> Decision record for `docs/PROJECT_PLAN.md` Phase 3. Implements audit
> M6/M7/M8 and architecture review AR-M3. Schema source of truth:
> `rust-backend/migrations/0001..0003`. Gates are executable:
> `bash scripts/local/db-verify.sh`.

## 1. Naming decision (audit M6)

**Cloud SQL uses lowercase snake_case tables only.** No quoted-PascalCase
tables and no PascalCase compatibility views are created.

Rationale: the PascalCase names exist only because the hosted Supabase data
plane is consumed through PostgREST. After cutover, PostgREST disappears,
every access path goes through the backend (AR-M3), and the frontend's last
direct table read (`Admins`) is replaced by `GET /api/me` (AR-H4, Phase 15).
Nothing that remains needs PascalCase identifiers.

Node↔Rust mapping (used by the one-time ETL in Phase 19):

| Hosted Supabase (Node)    | Cloud SQL (Rust)            | Notes |
| ------------------------- | --------------------------- | ----- |
| `Elections`               | `elections`                 | `registration/voting_*_time` carry over 1:1 |
| `Elections.merkle_root`   | `elections.merkle_root`     | decimal string (see §3) |
| `Voters`                  | `voters`                    | |
| `Voters.user_secret`      | `voters.user_secret_commitment` | post-H2 the legacy column holds `H(secret)`; the plaintext-named column does **not** exist in the target schema (dropped in `0003`) |
| `Admins`                  | `admins`                    | |
| `AdminInvitations`        | `admin_invitations`         | consumed-on-promotion semantics (H5) map to `accepted_by`/`accepted_at` or row deletion |
| (none — Redis tickets)    | `submission_tickets`        | new durable option for the Rust port; tickets bind election+root only, **never** a nullifier (AR-H5) |
| (none)                    | `vote_submissions`          | new; `UNIQUE (election_id, nullifier_hash)` |

Legacy-shape convergence: databases created before `0002` carried
`title`/`registration_start_at`/`voting_*_at`. `0003` backfills the canonical
columns, enforces their NOT NULLs and window CHECKs, and drops the legacy
columns, so old local volumes and fresh databases end at the same shape.

## 2. `circuit_id` nullability (audit M7)

`elections.circuit_id` is **nullable** (`0003`). Node-style election creation
(`POST /api/elections/set`) provides no circuit identity; it is backfilled
when artifacts are selected/generated (`/setZkDeploy` today, the Phase 10
artifact manifest after the Rust port). Gate: a Node-shaped insert without
`circuit_id` succeeds (`db-verify.sh`).

## 3. Field-element storage (audit M8)

Field elements (Merkle roots, secret commitments, nullifier hashes) are
stored as **`text` with `CHECK (value ~ '^[0-9]+$')`** (`0003`), not
`numeric(78,0)`.

Rationale: every API boundary treats these as decimal strings fed to
`BigInt`; `numeric` round-trips ambiguously through JSON serializers
(PostgREST/sqlx may emit numbers or notation the API contract does not
allow). `text` is byte-lossless and the CHECK preserves the integrity that
`numeric(78,0)` provided. The Rust domain types already model these as
strings (`MerkleRoot(String)`, `NullifierHash(String)`).

Gate: a 77-digit value round-trips byte-identically and `0x…` input is
rejected (`db-verify.sh`).

## 4. Privilege model (architecture review AR-M3)

Two login roles, **no RLS** (`rust-backend/db/roles.sql`, applied locally by
`scripts/local/db-roles.sh`):

| Role | Purpose | Privileges |
| ---- | ------- | ---------- |
| `zkvote_migrator` | migrations only | `CREATE` on schema `public`; future objects auto-grant DML to the app role via default privileges |
| `zkvote_app` | runtime API | per-table `SELECT/INSERT/UPDATE` (+`DELETE` only on `admin_invitations` for H5 consumption); **no** `CREATE` |

Gates: the runtime role cannot execute DDL but can perform granted DML
(`db-verify.sh`). Staging must connect the API as `zkvote_app` and run
migrations as `zkvote_migrator` (the single `zkvote_app`-does-everything user
in `scripts/gcp/zkvote-staging-setup.sh` predates this model and is updated
at Phase 16).

### Replaced hosted-Supabase RLS posture (inventory)

| Surface | Today (hosted Supabase) | After cutover |
| ------- | ----------------------- | ------------- |
| Backend table access | service-role key — bypasses RLS entirely | `zkvote_app` role through the Rust API |
| Frontend → `Admins` (role routing) | anon-key PostgREST read (`frontend/src/App.js`) — the only anon-readable surface in use | removed; `GET /api/me` (AR-H4, Phase 15) |
| Frontend → everything else | none (all via backend API) | unchanged |
| Supabase Auth (`auth.users`) | stays in Supabase | stays in Supabase (JWT/JWKS validated by the API) |

No other anon-readable surface exists, so dropping RLS in Cloud SQL loses
nothing — provided `/api/me` lands before the frontend switches data planes.

## 5. Canonical election state machine

Owned by `rust-backend/crates/domain` (`validate_transition`, unit-tested):

```text
draft -> artifacts_ready -> contract_deployed -> registration_open
      -> finalizing -> voting_active -> voting_ended -> completed
(any state) -> failed
```

The DB enforces membership via the `elections.state` CHECK; order is enforced
in the domain layer (and exercised by `cargo test --workspace`). The Node
backend predates the state column and infers lifecycle from
`contract_address`/`merkle_root`/timestamps — the ETL derives the closest
state per row at cutover (Phase 19).

## 6. Existing-data migration notes (feeds Phase 19)

- One-time ETL: hosted Supabase `Elections`/`Voters`/`Admins`/
  `AdminInvitations` → Cloud SQL snake_case tables, with row-count and
  checksum verification (AR-H3).
- `Voters.user_secret` values are **commitments** post-H2 and land in
  `voters.user_secret_commitment`; the ETL must abort if any value fails the
  `^[0-9]+$` check (would indicate a pre-H2 plaintext-era row).
- Elections deployed against the v1 `uint256[3]` boundary must be marked
  completed/superseded at migration time; v2 contracts are required for any
  live election (see `docs/API_COMPATIBILITY.md` v2 note).
- Redis state (tickets, locks, Merkle leaf cache) is intentionally NOT
  migrated: tickets are short-lived, locks are runtime-only, and the leaf
  cache rebuilds from Postgres.

## 7. Verification

```bash
bash scripts/local/migrate.sh    # idempotent; converges legacy local volumes
bash scripts/local/db-roles.sh   # applies the two-role model (idempotent)
bash scripts/local/db-verify.sh  # runs every Phase 3 gate, rolls back
```

All gates measured passing on 2026-06-12 (legacy-shaped local volume AND a
fresh database created from 0001→0003).
